<?php
/**
 * VoiceDen — notifications: @mentions and Web Push.
 *
 * Web Push without a library: VAPID (RFC 8292) is an ES256 JWT signed with
 * the key in config, and the payload is encrypted with aes128gcm (RFC 8291 /
 * RFC 8188) using openssl ECDH + hash_hkdf. The push service only ever sees
 * ciphertext. Pushes go out after the sender already has their response
 * (litespeed_finish_request), so a slow push service never slows a message.
 */
declare(strict_types=1);

const PUSH_ACTIVE_SECS = 8;   // looking at the channel this recently = no push
const P256_SPKI_PREFIX = '3059301306072a8648ce3d020106082a8648ce3d030107034200';

function b64u(string $s): string { return rtrim(strtr(base64_encode($s), '+/', '-_'), '='); }
function b64u_dec(string $s): string { return (string) base64_decode(strtr($s, '-_', '+/') . str_repeat('=', (4 - strlen($s) % 4) % 4)); }

/** push services we will POST to; anything else is someone pointing us at a URL */
function push_host_ok(string $endpoint): bool {
    $p = parse_url($endpoint);
    if (!$p || ($p['scheme'] ?? '') !== 'https' || empty($p['host']) || isset($p['user'])) {
        $test = (string) cfg('push_test_host', '');      // local mock during tests only
        return $test !== '' && $p && ($p['host'] ?? '') === $test;
    }
    $h = strtolower($p['host']);
    // Chrome now hands out https://jmtNN.google.com/fcm/send/… alongside the older fcm.googleapis.com
    if (preg_match('/^[a-z0-9-]+\.google\.com$/', $h) && str_starts_with((string) ($p['path'] ?? ''), '/fcm/')) return true;
    foreach (['fcm.googleapis.com', 'android.googleapis.com', 'push.services.mozilla.com', 'push.apple.com', 'notify.windows.com'] as $ok) {
        if ($h === $ok || str_ends_with($h, '.' . $ok)) return true;
    }
    return false;
}

/** DER ECDSA signature → the raw 64-byte r||s a JWT wants */
function der_to_raw(string $der): string {
    $pos = 2;
    if (ord($der[1]) & 0x80) $pos += ord($der[1]) & 0x7f;
    $out = '';
    for ($i = 0; $i < 2; $i++) {
        $len = ord($der[$pos + 1]);
        $int = substr($der, $pos + 2, $len);
        $out .= str_pad(ltrim($int, "\0"), 32, "\0", STR_PAD_LEFT);
        $pos += 2 + $len;
    }
    return $out;
}

function vapid_header(string $endpoint): string {
    static $cache = [];
    $p = parse_url($endpoint);
    $aud = $p['scheme'] . '://' . $p['host'] . (isset($p['port']) ? ':' . $p['port'] : '');
    if (isset($cache[$aud])) return $cache[$aud];
    $head = b64u(json_encode(['typ' => 'JWT', 'alg' => 'ES256']));
    $claims = b64u(json_encode(['aud' => $aud, 'exp' => time() + 12 * 3600, 'sub' => (string) cfg('vapid_subject')]));
    openssl_sign("$head.$claims", $sig, (string) cfg('vapid_private'), OPENSSL_ALGO_SHA256);
    $jwt = "$head.$claims." . b64u(der_to_raw($sig));
    return $cache[$aud] = 'vapid t=' . $jwt . ', k=' . cfg('vapid_public');
}

/** aes128gcm body for one subscription (RFC 8291), or null if its keys are unusable */
function push_encrypt(string $payload, string $uaPublicB64, string $authB64): ?string {
    $uaPublic = b64u_dec($uaPublicB64);
    $auth = b64u_dec($authB64);
    if (strlen($uaPublic) !== 65 || $uaPublic[0] !== "\x04" || strlen($auth) < 16) return null;
    $uaKey = openssl_pkey_get_public("-----BEGIN PUBLIC KEY-----\n"
        . chunk_split(base64_encode(hex2bin(P256_SPKI_PREFIX) . $uaPublic), 64, "\n") . "-----END PUBLIC KEY-----\n");
    $eph = openssl_pkey_new(['curve_name' => 'prime256v1', 'private_key_type' => OPENSSL_KEYTYPE_EC]);
    if (!$uaKey || !$eph) return null;
    $d = openssl_pkey_get_details($eph)['ec'];
    $asPublic = "\x04" . str_pad($d['x'], 32, "\0", STR_PAD_LEFT) . str_pad($d['y'], 32, "\0", STR_PAD_LEFT);
    $ecdh = openssl_pkey_derive($uaKey, $eph, 32);
    if ($ecdh === false) return null;
    $ecdh = str_pad($ecdh, 32, "\0", STR_PAD_LEFT);

    $ikm = hash_hkdf('sha256', $ecdh, 32, "WebPush: info\0" . $uaPublic . $asPublic, $auth);
    $salt = random_bytes(16);
    $cek = hash_hkdf('sha256', $ikm, 16, "Content-Encoding: aes128gcm\0", $salt);
    $nonce = hash_hkdf('sha256', $ikm, 12, "Content-Encoding: nonce\0", $salt);
    $tag = '';
    $ct = openssl_encrypt($payload . "\x02", 'aes-128-gcm', $cek, OPENSSL_RAW_DATA, $nonce, $tag);
    if ($ct === false) return null;
    return $salt . pack('N', 4096) . chr(65) . $asPublic . $ct . $tag;
}

/**
 * Send one payload to many subscriptions at once (curl_multi).
 * Subscriptions the push service says are gone (404/410) are deleted.
 */
function push_send(array $subs, array $payload, string $topic = '', string $urgency = 'normal'): array {
    if (!$subs || (string) cfg('vapid_private', '') === '') return [];
    $json = json_encode($payload, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE);
    $mh = curl_multi_init();
    $handles = [];
    foreach ($subs as $s) {
        if (!push_host_ok($s['endpoint'])) continue;
        $body = push_encrypt($json, $s['p256dh'], $s['auth']);
        if ($body === null) continue;
        $headers = [
            'Content-Type: application/octet-stream',
            'Content-Encoding: aes128gcm',
            'TTL: 86400',
            'Urgency: ' . $urgency,
            'Authorization: ' . vapid_header($s['endpoint']),
        ];
        // a newer push with the same topic replaces one still waiting on the device
        if ($topic !== '') $headers[] = 'Topic: ' . substr(preg_replace('/[^A-Za-z0-9_-]/', '', $topic), 0, 32);
        $ch = curl_init($s['endpoint']);
        curl_setopt_array($ch, [
            CURLOPT_POST => true, CURLOPT_POSTFIELDS => $body, CURLOPT_HTTPHEADER => $headers,
            CURLOPT_RETURNTRANSFER => true, CURLOPT_TIMEOUT => 8, CURLOPT_CONNECTTIMEOUT => 4,
            CURLOPT_FOLLOWLOCATION => false, CURLOPT_PROTOCOLS => CURLPROTO_HTTPS | CURLPROTO_HTTP,
        ]);
        curl_multi_add_handle($mh, $ch);
        $handles[] = [$ch, $s];
    }
    do {
        $st = curl_multi_exec($mh, $running);
        if ($running) curl_multi_select($mh, 1.0);
    } while ($running && $st === CURLM_OK);
    $result = [];
    foreach ($handles as [$ch, $s]) {
        $code = (int) curl_getinfo($ch, CURLINFO_RESPONSE_CODE);
        if ($code === 404 || $code === 410) q('DELETE FROM push_subs WHERE id = ?', [$s['id']]);
        elseif ($code >= 200 && $code < 300) q('UPDATE push_subs SET last_ok = NOW() WHERE id = ?', [$s['id']]);
        else error_log('[voiceden] push ' . $code . ' ' . parse_url($s['endpoint'], PHP_URL_HOST) . ' ' . substr((string) curl_multi_getcontent($ch), 0, 200));
        $result[] = $code;
        curl_multi_remove_handle($mh, $ch);
        curl_close($ch);
    }
    curl_multi_close($mh);
    return $result;
}

/** answer the client now, keep running to do the slow part */
function respond_then(array $data, callable $after): never {
    ignore_user_abort(true);
    @set_time_limit(40);
    http_response_code(200);
    header('Content-Type: application/json; charset=utf-8');
    header('Cache-Control: no-store');
    $body = json_encode($data, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE);
    header('Content-Length: ' . strlen($body));
    echo $body;
    if (function_exists('litespeed_finish_request')) litespeed_finish_request();
    elseif (function_exists('fastcgi_finish_request')) fastcgi_finish_request();
    else flush();
    try { $after(); } catch (Throwable $e) { error_log('[voiceden] after-response: ' . $e->getMessage()); }
    exit;
}

/* ---------------------------------------------------------------- mentions */

/**
 * Who a message names: @username of a member, or @herkes/@everyone/@here for
 * everyone in the den. Returns user ids (never the author).
 */
function mentioned_ids(string $body, int $sid, int $authorId): array {
    if (!str_contains($body, '@')) return [];
    // code is not a mention
    $plain = preg_replace(['/```[\s\S]*?```/', '/`[^`\n]+`/'], '', $body) ?? $body;
    if (!preg_match_all('/(?<![\p{L}\p{N}_.@])@([a-z0-9_.]{2,24})/iu', $plain, $m)) return [];
    $names = array_unique(array_map(fn($n) => rtrim(strtolower($n), '.'), $m[1]));
    if (array_intersect($names, ['herkes', 'everyone', 'here', 'burada'])) {
        $ids = q('SELECT user_id FROM members WHERE server_id = ? AND user_id <> ?', [$sid, $authorId])->fetchAll(PDO::FETCH_COLUMN);
    } else {
        $ids = q('SELECT u.id FROM users u JOIN members mb ON mb.user_id = u.id AND mb.server_id = ?
                  WHERE u.username IN (' . marks($names) . ') AND u.id <> ?', array_merge([$sid], $names, [$authorId]))->fetchAll(PDO::FETCH_COLUMN);
    }
    return array_map('intval', $ids);
}

function store_mentions(int $mid, int $cid, array $uids): void {
    q('DELETE FROM mentions WHERE message_id = ?', [$mid]);
    foreach ($uids as $uid) q('INSERT IGNORE INTO mentions (user_id, message_id, channel_id) VALUES (?, ?, ?)', [$uid, $mid, $cid]);
}

/* ---------------------------------------------------------------- notifying */

/** markup off, whitespace folded, cut short: what a notification line can show */
function notif_text(string $body): string {
    $t = preg_replace([
        '/```[\s\S]*?```/', '/\|\|[^\n]+?\|\|/', '/^&gt; ?|^> ?/m', '/\*\*|__|~~|`/',
        // a single mark only where it opens or closes, so @user_name keeps its underscores
        '/(?<![\p{L}\p{N}])[*_~](?=[\p{L}\p{N}])|(?<=[\p{L}\p{N}])[*_~](?![\p{L}\p{N}])/u',
    ], ['[kod]', '[spoiler]', '', '', ''], $body) ?? $body;
    $t = trim(preg_replace('/\s+/u', ' ', $t) ?? $t);
    return mb_strlen($t) > 140 ? mb_substr($t, 0, 139) . '…' : $t;
}

/**
 * Push a new message to everyone who should hear about it: den members (not
 * the author) whose level allows it, not muted, not looking at the channel.
 */
function notify_message(int $mid): void {
    $m = q1('SELECT m.*, c.name AS ch_name, c.kind, s.name AS den, s.icon, u.display_name, u.avatar
             FROM messages m JOIN channels c ON c.id = m.channel_id JOIN servers s ON s.id = m.server_id
             JOIN users u ON u.id = m.user_id WHERE m.id = ?', [$mid]);
    if (!$m || $m['deleted']) return;
    $mentioned = array_map('intval', q('SELECT user_id FROM mentions WHERE message_id = ?', [$mid])->fetchAll(PDO::FETCH_COLUMN));
    $rows = q("SELECT mb.user_id, mb.notify, u.push_preview FROM members mb JOIN users u ON u.id = mb.user_id
               WHERE mb.server_id = ? AND mb.user_id <> ? AND mb.notify <> 'none'
                 AND NOT (u.active_ch <=> ? AND u.active_at > NOW() - INTERVAL " . PUSH_ACTIVE_SECS . " SECOND)",
              [$m['server_id'], $m['user_id'], $m['channel_id']])->fetchAll();
    $targets = [];
    foreach ($rows as $r) {
        $uid = (int) $r['user_id'];
        $isMention = in_array($uid, $mentioned, true);
        if ($r['notify'] === 'mentions' && !$isMention) continue;
        $targets[$uid] = ['mention' => $isMention, 'preview' => (bool) $r['push_preview']];
    }
    if (!$targets) return;

    $atts = q('SELECT gif, mime FROM attachments WHERE message_id = ?', [$mid])->fetchAll();
    $text = notif_text($m['body']);
    if ($text === '') {
        $text = $atts && $atts[0]['gif'] ? 'GIF gönderdi' : (count($atts) > 1 ? count($atts) . ' dosya gönderdi' : '📎 dosya gönderdi');
    }
    $where = ($m['kind'] === 'text' ? '#' : '🔊 ') . $m['ch_name'];
    $base = [
        'ch'   => (int) $m['channel_id'],
        'sid'  => (int) $m['server_id'],
        'mid'  => $mid,
        'url'  => './#/' . $m['server_id'] . '/' . $m['channel_id'],
        'icon' => $m['avatar'] ? 'api.php?a=img&k=' . $m['avatar'] : ($m['icon'] ? 'api.php?a=img&k=' . $m['icon'] : 'icons/icon-192.png'),
    ];
    $subs = q('SELECT id, user_id, endpoint, p256dh, auth FROM push_subs WHERE user_id IN (' . marks(array_keys($targets)) . ')',
              array_keys($targets))->fetchAll();
    $byUser = [];
    foreach ($subs as $s) $byUser[(int) $s['user_id']][] = $s;
    foreach ($byUser as $uid => $list) {
        $t = $targets[$uid];
        $payload = $base + [
            'title' => $m['display_name'] . ' · ' . $where,
            'body'  => $t['preview'] ? $text : 'Yeni mesaj',
            'den'   => $m['den'],
            'm'     => $t['mention'],
        ];
        if (!$t['preview']) $payload['icon'] = 'icons/icon-192.png';
        push_send($list, $payload, 'ch' . $m['channel_id'], $t['mention'] ? 'high' : 'normal');
    }
}

/* ---------------------------------------------------------------- endpoints */

function api_push_key(): void {
    require_user();
    out(['key' => (string) cfg('vapid_public', '')]);
}

/** POST {endpoint, keys:{p256dh, auth}} — this browser wants pushes */
function api_push_subscribe(): void {
    $u = require_user();
    $b = body();
    $ep = (string) ($b['endpoint'] ?? '');
    $p256 = (string) ($b['keys']['p256dh'] ?? '');
    $auth = (string) ($b['keys']['auth'] ?? '');
    if (strlen($ep) > 700 || !push_host_ok($ep)) fail('bad_endpoint');
    if (!preg_match('/^[A-Za-z0-9_-]{80,100}$/', $p256) || !preg_match('/^[A-Za-z0-9_-]{16,32}$/', $auth)) fail('bad_keys');
    if ((int) qv('SELECT COUNT(*) FROM push_subs WHERE user_id = ?', [$u['id']]) >= 20) {
        q('DELETE FROM push_subs WHERE user_id = ? ORDER BY COALESCE(last_ok, created_at) LIMIT 1', [$u['id']]);
    }
    // an endpoint belongs to one browser; whoever is signed in there now owns it
    q('INSERT INTO push_subs (user_id, endpoint, ep_hash, p256dh, auth, ua) VALUES (?, ?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE user_id = VALUES(user_id), p256dh = VALUES(p256dh), auth = VALUES(auth), ua = VALUES(ua)',
      [$u['id'], $ep, sha1($ep, true), $p256, $auth, mb_substr((string) ($_SERVER['HTTP_USER_AGENT'] ?? ''), 0, 200)]);
    out(['ok' => true]);
}

function api_push_unsubscribe(): void {
    $u = require_user();
    $ep = (string) (body()['endpoint'] ?? '');
    q('DELETE FROM push_subs WHERE ep_hash = ? AND user_id = ?', [sha1($ep, true), $u['id']]);
    out(['ok' => true]);
}

/** POST {endpoint?} — a test push to this device (or all of mine) */
function api_push_test(): void {
    $u = require_user();
    $tk = 'ptest:' . $u['id'];
    if (!throttle_ok($tk, 6, 300)) fail('slow_down', 429);
    throttle_hit($tk);
    $ep = (string) (body()['endpoint'] ?? '');
    $subs = $ep !== ''
        ? q('SELECT id, user_id, endpoint, p256dh, auth FROM push_subs WHERE ep_hash = ? AND user_id = ?', [sha1($ep, true), $u['id']])->fetchAll()
        : q('SELECT id, user_id, endpoint, p256dh, auth FROM push_subs WHERE user_id = ?', [$u['id']])->fetchAll();
    if (!$subs) fail('no_subscription', 404);
    $codes = push_send($subs, ['title' => 'VoiceDen', 'body' => 'Bildirimler bu cihazda çalışıyor.', 'url' => './', 'icon' => 'icons/icon-192.png', 'test' => true], 'test', 'high');
    out(['sent' => count($codes), 'codes' => $codes]);
}

/** POST {sid, level: all|mentions|none} */
function api_notify_level(): void {
    $u = require_user();
    $b = body();
    $sid = int_in($b, 'sid');
    require_member($sid, $u);
    $level = in_array($b['level'] ?? '', ['all', 'mentions', 'none'], true) ? $b['level'] : 'all';
    q('UPDATE members SET notify = ? WHERE server_id = ? AND user_id = ?', [$level, $sid, $u['id']]);
    out(['ok' => true, 'level' => $level]);
}

/** POST {preview: 0|1} */
function api_notify_prefs(): void {
    $u = require_user();
    q('UPDATE users SET push_preview = ? WHERE id = ?', [empty(body()['preview']) ? 0 : 1, $u['id']]);
    out(['ok' => true]);
}
