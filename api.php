<?php
/**
 * VoiceDen API.  api.php?a=<action>
 *
 * Reads are GET, writes are POST with a JSON body (or multipart for a message
 * with files). Every POST must carry `X-VoiceDen: 1`: a cross-site form or
 * fetch cannot add a custom header without a CORS preflight we never answer,
 * so the session cookie alone can never be ridden into a write.
 *
 * Realtime is polling (`poll`), not sockets: the PHP pool here is ten workers,
 * so nothing is allowed to hold a request open.
 */
declare(strict_types=1);
require __DIR__ . '/server/lib.php';
require __DIR__ . '/server/gifs.php';
require __DIR__ . '/server/admin.php';

header('X-Content-Type-Options: nosniff');
header('Referrer-Policy: same-origin');

set_exception_handler(function (Throwable $e) {
    error_log('[voiceden] ' . $e->getMessage() . ' @ ' . $e->getFile() . ':' . $e->getLine());
    if (!headers_sent()) out(['error' => 'server'], 500);
});

const ROUTES = [
    'GET'  => ['boot', 'messages', 'file', 'invite', 'gifs', 'img', 'admin'],
    'POST' => ['register', 'login', 'logout', 'profile', 'password', 'poll',
               'server_create', 'server_update', 'server_delete', 'server_leave', 'invite_reset', 'invite_accept',
               'channel_create', 'channel_update', 'channel_delete', 'member_kick', 'member_role',
               'send', 'edit', 'delete', 'read', 'voice_join', 'voice_leave', 'avatar', 'server_icon'],
];
// sendBeacon (tab closing) cannot set headers; leaving voice is the one write
// that may arrive without it — the worst a forged one does is drop a presence row
const HEADERLESS = ['voice_leave'];

$a = (string) ($_GET['a'] ?? '');
$method = $_SERVER['REQUEST_METHOD'] ?? 'GET';
if (!in_array($a, ROUTES[$method] ?? [], true)) fail('not_found', 404);
if ($method === 'POST' && !in_array($a, HEADERLESS, true) && ($_SERVER['HTTP_X_VOICEDEN'] ?? '') !== '1') fail('csrf', 403);
('api_' . $a)();

/* ======================================================== accounts */

function check_password(string $p): void {
    if (mb_strlen($p) < 8)   fail('weak_password');
    if (strlen($p) > 200)    fail('long_password');
}

function api_register(): void {
    $b = body();
    $username = strtolower(trim((string) ($b['username'] ?? '')));
    $name = clean_line($b['name'] ?? '', 32);
    $pass = (string) ($b['password'] ?? '');
    if (!preg_match('/^[a-z0-9_.]{3,24}$/', $username)) fail('bad_username');
    if ($name === '') $name = $username;
    check_password($pass);
    $ip = 'reg:' . client_ip();
    if (!throttle_ok($ip, 20, 3600)) fail('slow_down', 429);
    if (qv('SELECT 1 FROM users WHERE username = ?', [$username])) fail('username_taken', 409);
    throttle_hit($ip);
    q('INSERT INTO users (username, display_name, pass_hash, tint, last_seen) VALUES (?, ?, ?, ?, NOW())',
      [$username, $name, password_hash($pass, PASSWORD_DEFAULT), random_int(0, TINT_COUNT - 1)]);
    $uid = (int) db()->lastInsertId();
    start_session($uid);
    out(['me' => pub_user(q1('SELECT * FROM users WHERE id = ?', [$uid]))]);
}

function api_login(): void {
    $b = body();
    $username = strtolower(trim((string) ($b['username'] ?? '')));
    $pass = (string) ($b['password'] ?? '');
    $kip = 'login:' . client_ip();
    $kus = 'login-u:' . substr($username, 0, 24);
    if (!throttle_ok($kip, 12, 900) || !throttle_ok($kus, 8, 900)) fail('slow_down', 429);
    $u = q1('SELECT * FROM users WHERE username = ?', [$username]);
    if (!$u || !password_verify($pass, $u['pass_hash'])) {
        throttle_hit($kip); throttle_hit($kus);
        fail('bad_login', 401);
    }
    if (password_needs_rehash($u['pass_hash'], PASSWORD_DEFAULT)) {
        q('UPDATE users SET pass_hash = ? WHERE id = ?', [password_hash($pass, PASSWORD_DEFAULT), $u['id']]);
    }
    start_session((int) $u['id']);
    out(['me' => pub_user($u)]);
}

function api_logout(): void {
    $u = current_user();
    if ($u) q('DELETE FROM voice_states WHERE user_id = ?', [$u['id']]);
    end_session();
    out(['ok' => true]);
}

function api_profile(): void {
    $u = require_user();
    $b = body();
    $name = clean_line($b['name'] ?? $u['display_name'], 32);
    if ($name === '') fail('bad_name');
    $tint = isset($b['tint']) ? max(0, min(TINT_COUNT - 1, int_in($b, 'tint'))) : (int) $u['tint'];
    q('UPDATE users SET display_name = ?, tint = ? WHERE id = ?', [$name, $tint, $u['id']]);
    // everyone who can see this person refetches their server once
    q('UPDATE servers s JOIN members m ON m.server_id = s.id SET s.rev = s.rev + 1 WHERE m.user_id = ?', [$u['id']]);
    out(['me' => pub_user(q1('SELECT * FROM users WHERE id = ?', [$u['id']]))]);
}

/** POST multipart image=… sets the profile photo; JSON {clear: 1} removes it */
function api_avatar(): void {
    $u = require_user();
    $tk = 'img:' . $u['id'];
    if (!throttle_ok($tk, 30, 3600)) fail('slow_down', 429);
    throttle_hit($tk);
    $key = empty(body()['clear']) ? store_square_image(uploaded_image()) : null;
    q('UPDATE users SET avatar = ? WHERE id = ?', [$key, $u['id']]);
    q('UPDATE servers s JOIN members m ON m.server_id = s.id SET s.rev = s.rev + 1 WHERE m.user_id = ?', [$u['id']]);
    delete_image($u['avatar']);
    out(['me' => pub_user(q1('SELECT * FROM users WHERE id = ?', [$u['id']]))]);
}

function api_password(): void {
    $u = require_user();
    $b = body();
    if (!password_verify((string) ($b['old'] ?? ''), $u['pass_hash'])) fail('bad_password', 403);
    $new = (string) ($b['new'] ?? '');
    check_password($new);
    q('UPDATE users SET pass_hash = ? WHERE id = ?', [password_hash($new, PASSWORD_DEFAULT), $u['id']]);
    // every other device is signed out; this one gets a fresh session
    q('DELETE FROM sessions WHERE user_id = ?', [$u['id']]);
    start_session((int) $u['id']);
    out(['ok' => true]);
}

/* ======================================================== state */

/** Everything the client needs to draw the app: servers, channels, people, voice. */
function api_boot(): void {
    $u = require_user();
    touch_seen($u);
    $uid = (int) $u['id'];
    $servers = q('SELECT s.id, s.name, s.owner_id, s.invite_code, s.icon, s.rev, m.role FROM members m
                  JOIN servers s ON s.id = m.server_id WHERE m.user_id = ? ORDER BY m.joined_at, s.id', [$uid])->fetchAll();
    $sids = array_map(fn($s) => (int) $s['id'], $servers);
    $byId = [];
    foreach ($servers as $s) {
        $byId[(int) $s['id']] = [
            'id' => (int) $s['id'], 'name' => $s['name'], 'owner' => (int) $s['owner_id'],
            'invite' => $s['invite_code'], 'icon' => $s['icon'], 'rev' => (int) $s['rev'], 'role' => $s['role'],
            'channels' => [], 'members' => [],
        ];
    }
    $users = [];
    if ($sids) {
        foreach (q('SELECT c.id, c.server_id, c.name, c.kind, c.position, c.last_msg_id, COALESCE(r.last_read_id, 0) AS read_id
                    FROM channels c LEFT JOIN channel_reads r ON r.channel_id = c.id AND r.user_id = ?
                    WHERE c.server_id IN (' . marks($sids) . ') ORDER BY c.position, c.id', array_merge([$uid], $sids)) as $c) {
            $byId[(int) $c['server_id']]['channels'][] = [
                'id' => (int) $c['id'], 'name' => $c['name'], 'kind' => $c['kind'],
                'last' => (int) $c['last_msg_id'], 'read' => (int) $c['read_id'],
            ];
        }
        foreach (q('SELECT m.server_id, m.role, u.* FROM members m JOIN users u ON u.id = m.user_id
                    WHERE m.server_id IN (' . marks($sids) . ') ORDER BY m.joined_at', $sids) as $m) {
            $byId[(int) $m['server_id']]['members'][] = ['id' => (int) $m['id'], 'role' => $m['role']];
            $users[(int) $m['id']] = pub_user($m);
        }
    }
    $users[$uid] = pub_user($u);
    out([
        'me'      => pub_user($u),
        'admin'   => is_admin($u),
        'servers' => array_values($byId),
        'users'   => array_values($users),
        'voice'   => voice_states_for($sids),
        'online'  => online_ids($sids),
        'cursor'  => (int) qv('SELECT COALESCE(MAX(rev), 0) FROM messages'),
    ]);
}

/**
 * The heartbeat. In: {since, ch, typing, voice:{peer,mu,df,sh}|null}
 * Out: messages changed since `since` in any of my servers, server revs (a
 * changed rev means "refetch boot"), voice states, who is online, who types in `ch`.
 */
function api_poll(): void {
    $u = require_user();
    touch_seen($u);
    $uid = (int) $u['id'];
    $b = body();
    $sids = my_server_ids($uid);
    $res = [];

    // voice heartbeat: only my own row with my own peer id counts as alive
    if (!empty($b['voice']) && is_array($b['voice'])) {
        $v = $b['voice'];
        $peer = (string) ($v['peer'] ?? '');
        $n = q('UPDATE voice_states SET muted = ?, deafened = ?, sharing = ?, updated_at = NOW() WHERE user_id = ? AND peer_id = ?',
               [!empty($v['mu']) ? 1 : 0, !empty($v['df']) ? 1 : 0, !empty($v['sh']) ? 1 : 0, $uid, $peer])->rowCount();
        // 'moved' = this account joined voice somewhere else; 'gone' = the row expired
        $res['voice_status'] = $n ? 'ok' : (qv('SELECT 1 FROM voice_states WHERE user_id = ?', [$uid]) ? 'moved' : 'gone');
    }
    if (random_int(1, 20) === 1) {
        q('DELETE FROM voice_states WHERE updated_at < NOW() - INTERVAL 120 SECOND');
        q('DELETE FROM typing WHERE until_at < NOW() - INTERVAL 1 MINUTE');
    }

    $ch = int_in($b, 'ch');
    $chServer = $ch ? (int) qv('SELECT server_id FROM channels WHERE id = ?', [$ch]) : 0;
    if ($chServer && !in_array($chServer, $sids, true)) $ch = 0;
    if ($ch && !empty($b['typing'])) {
        q('INSERT INTO typing (channel_id, user_id, until_at) VALUES (?, ?, NOW(3) + INTERVAL 6 SECOND)
           ON DUPLICATE KEY UPDATE until_at = VALUES(until_at)', [$ch, $uid]);
    }

    $since = max(0, int_in($b, 'since'));
    $msgs = [];
    $cursor = $since;
    $more = false;
    if ($sids) {
        // a small overlap catches a rev that was taken before, but committed after,
        // a higher one; the client skips anything it already has at that rev
        $rows = q('SELECT ' . MSG_COLS . ' FROM messages m WHERE m.rev > ? AND m.server_id IN (' . marks($sids) . ')
                   ORDER BY m.rev LIMIT 301', array_merge([max(0, $since - 20)], $sids))->fetchAll();
        if (count($rows) > 300) { $more = true; array_pop($rows); }
        foreach ($rows as $r) $cursor = max($cursor, (int) $r['rev']);
        $msgs = pack_messages($rows);
        $res['users'] = authors_of($rows);
        $res['revs'] = (object) array_map('intval', array_column(
            q('SELECT id, rev FROM servers WHERE id IN (' . marks($sids) . ')', $sids)->fetchAll(), 'rev', 'id'));
    } else {
        $res['revs'] = (object) [];
    }

    $res += [
        'cursor' => $cursor,
        'more'   => $more,
        'msgs'   => $msgs,
        'voice'  => voice_states_for($sids),
        'online' => online_ids($sids),
        'typing' => $ch ? array_map('intval', q('SELECT user_id FROM typing WHERE channel_id = ? AND user_id <> ? AND until_at > NOW(3)',
                                                [$ch, $uid])->fetchAll(PDO::FETCH_COLUMN)) : [],
    ];
    out($res);
}

/* ======================================================== servers */

function new_invite_code(): string {
    $abc = 'abcdefghjkmnpqrstuvwxyz23456789';    // no 0/o/1/l/i: it gets read aloud
    do {
        $c = '';
        for ($i = 0; $i < 10; $i++) $c .= $abc[random_int(0, strlen($abc) - 1)];
    } while (qv('SELECT 1 FROM servers WHERE invite_code = ?', [$c]));
    return $c;
}

function api_server_create(): void {
    $u = require_user();
    $name = clean_line(body()['name'] ?? '', 48);
    if ($name === '') fail('bad_name');
    if ((int) qv('SELECT COUNT(*) FROM servers WHERE owner_id = ?', [$u['id']]) >= 20) fail('too_many');
    db()->beginTransaction();
    q('INSERT INTO servers (name, owner_id, invite_code) VALUES (?, ?, ?)', [$name, $u['id'], new_invite_code()]);
    $sid = (int) db()->lastInsertId();
    q("INSERT INTO members (server_id, user_id, role) VALUES (?, ?, 'owner')", [$sid, $u['id']]);
    q("INSERT INTO channels (server_id, name, kind, position) VALUES (?, 'genel', 'text', 0), (?, 'Sohbet', 'voice', 0)", [$sid, $sid]);
    db()->commit();
    out(['id' => $sid]);
}

function api_server_update(): void {
    $u = require_user();
    $b = body();
    $sid = int_in($b, 'id');
    require_manager($sid, $u);
    $name = clean_line($b['name'] ?? '', 48);
    if ($name === '') fail('bad_name');
    q('UPDATE servers SET name = ?, rev = rev + 1 WHERE id = ?', [$name, $sid]);
    out(['ok' => true]);
}

function api_server_delete(): void {
    $u = require_user();
    $sid = int_in(body(), 'id');
    if (require_member($sid, $u) !== 'owner') fail('forbidden', 403);
    $paths = q('SELECT a.path FROM attachments a JOIN messages m ON m.id = a.message_id WHERE m.server_id = ?', [$sid])
        ->fetchAll(PDO::FETCH_COLUMN);
    $icon = qv('SELECT icon FROM servers WHERE id = ?', [$sid]);
    q('DELETE FROM voice_states WHERE server_id = ?', [$sid]);
    q('DELETE FROM servers WHERE id = ?', [$sid]);     // cascades to members, channels, messages
    delete_files($paths);
    delete_image($icon);
    out(['ok' => true]);
}

function api_server_leave(): void {
    $u = require_user();
    $sid = int_in(body(), 'id');
    if (require_member($sid, $u) === 'owner') fail('owner_cannot_leave');
    q('DELETE FROM members WHERE server_id = ? AND user_id = ?', [$sid, $u['id']]);
    q('DELETE FROM voice_states WHERE server_id = ? AND user_id = ?', [$sid, $u['id']]);
    bump_server($sid);
    out(['ok' => true]);
}

/** POST multipart id=…&image=… sets a den's icon; JSON {id, clear: 1} removes it */
function api_server_icon(): void {
    $u = require_user();
    $sid = int_in(body(), 'id');
    require_manager($sid, $u);
    $tk = 'img:' . $u['id'];
    if (!throttle_ok($tk, 30, 3600)) fail('slow_down', 429);
    throttle_hit($tk);
    $old = qv('SELECT icon FROM servers WHERE id = ?', [$sid]);
    $key = empty(body()['clear']) ? store_square_image(uploaded_image()) : null;
    q('UPDATE servers SET icon = ?, rev = rev + 1 WHERE id = ?', [$key, $sid]);
    delete_image($old);
    out(['icon' => $key]);
}

/**
 * GET img&k=<key> — profile photos and den icons. The 128-bit random key is the
 * capability (as on Discord's CDN), which lets the sign-in screen show an
 * invite's icon before anyone is logged in.
 */
function api_img(): void {
    $k = (string) ($_GET['k'] ?? '');
    $path = IMG_DIR . '/' . $k . '.webp';
    if (!preg_match('/^[a-f0-9]{32}$/', $k) || !is_file($path)) { http_response_code(404); exit; }
    header('Content-Type: image/webp');
    header('Cache-Control: public, max-age=31536000, immutable');   // a new picture gets a new key
    header('Content-Security-Policy: default-src \'none\'; sandbox');
    header('Content-Length: ' . filesize($path));
    readfile($path);
    exit;
}

function api_invite_reset(): void {
    $u = require_user();
    $sid = int_in(body(), 'id');
    require_manager($sid, $u);
    q('UPDATE servers SET invite_code = ?, rev = rev + 1 WHERE id = ?', [new_invite_code(), $sid]);
    out(['invite' => qv('SELECT invite_code FROM servers WHERE id = ?', [$sid])]);
}

/** Public: what an invite leads to, so the sign-in screen can say so. */
function api_invite(): void {
    $code = strtolower(preg_replace('/[^a-z0-9]/i', '', (string) ($_GET['code'] ?? '')) ?? '');
    $s = $code ? q1('SELECT id, name, icon FROM servers WHERE invite_code = ?', [$code]) : null;
    if (!$s) fail('no_invite', 404);
    $sid = (int) $s['id'];
    $u = current_user();
    out([
        'server' => [
            'id' => $sid, 'name' => $s['name'], 'icon' => $s['icon'],
            'members' => (int) qv('SELECT COUNT(*) FROM members WHERE server_id = ?', [$sid]),
            'online'  => count(online_ids([$sid])),
        ],
        'member' => $u ? role_in($sid, (int) $u['id']) !== null : false,
    ]);
}

function api_invite_accept(): void {
    $u = require_user();
    $code = strtolower(preg_replace('/[^a-z0-9]/i', '', (string) (body()['code'] ?? '')) ?? '');
    $sid = $code ? (int) qv('SELECT id FROM servers WHERE invite_code = ?', [$code]) : 0;
    if (!$sid) fail('no_invite', 404);
    if (role_in($sid, (int) $u['id']) === null) {
        if ((int) qv('SELECT COUNT(*) FROM members WHERE user_id = ?', [$u['id']]) >= 100) fail('too_many');
        q("INSERT INTO members (server_id, user_id, role) VALUES (?, ?, 'member')", [$sid, $u['id']]);
        bump_server($sid);
    }
    out(['id' => $sid]);
}

/* ======================================================== channels */

/** text channels read like Discord's: lower case, dashes for spaces; voice keeps its spelling */
function channel_name(mixed $raw, string $kind): string {
    $n = clean_line($raw, 48);
    if ($kind === 'text') {
        $n = mb_strtolower(str_replace(['I', 'İ'], ['ı', 'i'], $n));
        $n = trim(preg_replace('/[\s\-]+/u', '-', $n) ?? '', '-');
        $n = preg_replace('/[#<>@`]/u', '', $n) ?? '';
    }
    return $n;
}

function api_channel_create(): void {
    $u = require_user();
    $b = body();
    $sid = int_in($b, 'sid');
    require_manager($sid, $u);
    $kind = ($b['kind'] ?? '') === 'voice' ? 'voice' : 'text';
    $name = channel_name($b['name'] ?? '', $kind);
    if ($name === '') fail('bad_name');
    if ((int) qv('SELECT COUNT(*) FROM channels WHERE server_id = ?', [$sid]) >= 50) fail('too_many');
    $pos = (int) qv('SELECT COALESCE(MAX(position), 0) + 1 FROM channels WHERE server_id = ? AND kind = ?', [$sid, $kind]);
    q('INSERT INTO channels (server_id, name, kind, position) VALUES (?, ?, ?, ?)', [$sid, $name, $kind, $pos]);
    $id = (int) db()->lastInsertId();
    bump_server($sid);
    out(['id' => $id]);
}

function api_channel_update(): void {
    $u = require_user();
    $b = body();
    $c = channel_for(int_in($b, 'id'), $u);
    if ($c['role'] === 'member') fail('forbidden', 403);
    $name = channel_name($b['name'] ?? '', $c['kind']);
    if ($name === '') fail('bad_name');
    q('UPDATE channels SET name = ? WHERE id = ?', [$name, $c['id']]);
    bump_server((int) $c['server_id']);
    out(['ok' => true]);
}

function api_channel_delete(): void {
    $u = require_user();
    $c = channel_for(int_in(body(), 'id'), $u);
    if ($c['role'] === 'member') fail('forbidden', 403);
    if ((int) qv('SELECT COUNT(*) FROM channels WHERE server_id = ?', [$c['server_id']]) <= 1) fail('last_channel');
    $paths = q('SELECT a.path FROM attachments a JOIN messages m ON m.id = a.message_id WHERE m.channel_id = ?', [$c['id']])
        ->fetchAll(PDO::FETCH_COLUMN);
    q('DELETE FROM channels WHERE id = ?', [$c['id']]);
    delete_files($paths);
    bump_server((int) $c['server_id']);
    out(['ok' => true]);
}

/* ======================================================== members */

function api_member_kick(): void {
    $u = require_user();
    $b = body();
    $sid = int_in($b, 'sid');
    $target = int_in($b, 'uid');
    $mine = require_manager($sid, $u);
    $theirs = role_in($sid, $target);
    if ($theirs === null) fail('not_member', 404);
    // owners can remove anyone but themselves; admins only plain members
    if ($theirs === 'owner' || ($mine === 'admin' && $theirs !== 'member')) fail('forbidden', 403);
    q('DELETE FROM members WHERE server_id = ? AND user_id = ?', [$sid, $target]);
    q('DELETE FROM voice_states WHERE server_id = ? AND user_id = ?', [$sid, $target]);
    bump_server($sid);
    out(['ok' => true]);
}

function api_member_role(): void {
    $u = require_user();
    $b = body();
    $sid = int_in($b, 'sid');
    $target = int_in($b, 'uid');
    if (require_member($sid, $u) !== 'owner') fail('forbidden', 403);
    $role = ($b['role'] ?? '') === 'admin' ? 'admin' : 'member';
    $theirs = role_in($sid, $target);
    if ($theirs === null) fail('not_member', 404);
    if ($theirs === 'owner') fail('forbidden', 403);
    q('UPDATE members SET role = ? WHERE server_id = ? AND user_id = ?', [$role, $sid, $target]);
    bump_server($sid);
    out(['ok' => true]);
}

/* ======================================================== messages */

function api_messages(): void {
    $u = require_user();
    $c = channel_for((int) ($_GET['ch'] ?? 0), $u);
    $before = (int) ($_GET['before'] ?? 0);
    $limit = max(1, min(100, (int) ($_GET['limit'] ?? 50)));
    $args = [$c['id']];
    $sql = 'SELECT ' . MSG_COLS . ' FROM messages m WHERE m.channel_id = ? AND m.deleted = 0';
    if ($before > 0) { $sql .= ' AND m.id < ?'; $args[] = $before; }
    $rows = q($sql . ' ORDER BY m.id DESC LIMIT ' . ($limit + 1), $args)->fetchAll();
    $more = count($rows) > $limit;
    if ($more) array_pop($rows);
    out(['msgs' => pack_messages(array_reverse($rows)), 'more' => $more, 'users' => authors_of($rows)]);
}

function upload_error(int $code): string {
    return match ($code) {
        UPLOAD_ERR_INI_SIZE, UPLOAD_ERR_FORM_SIZE => 'file_too_big',
        UPLOAD_ERR_PARTIAL => 'upload_partial',
        default => 'upload_failed',
    };
}

/** the uploaded files as [tmp, name, size] rows, validated but not yet moved */
function incoming_files(): array {
    if (empty($_FILES['files'])) return [];
    $f = $_FILES['files'];
    $list = [];
    foreach ((array) $f['tmp_name'] as $i => $tmp) {
        $err = (int) ((array) $f['error'])[$i];
        if ($err === UPLOAD_ERR_NO_FILE) continue;
        if ($err !== UPLOAD_ERR_OK) fail(upload_error($err));
        $size = (int) ((array) $f['size'])[$i];
        if ($size <= 0) continue;
        if ($size > MAX_FILE_SIZE) fail('file_too_big');
        if (!is_uploaded_file($tmp)) fail('upload_failed');
        $list[] = ['tmp' => $tmp, 'name' => safe_filename((string) ((array) $f['name'])[$i]), 'size' => $size];
    }
    if (count($list) > MAX_FILES) fail('too_many_files');
    return $list;
}

function api_send(): void {
    $u = require_user();
    // a body over post_max_size arrives empty: say so instead of "empty message"
    if (empty($_POST) && empty($_FILES) && (int) ($_SERVER['CONTENT_LENGTH'] ?? 0) > 1024 * 1024) fail('file_too_big', 413);
    $b = body();
    $c = channel_for(int_in($b, 'ch'), $u);
    $text = clean_body($b['body'] ?? '');
    if (mb_strlen($text) > MAX_BODY) fail('too_long');
    $files = incoming_files();
    $gif = substr(trim((string) ($b['gif'] ?? '')), 0, 160);   // a KLIPY slug from the picker
    if ($gif !== '' && $files) fail('too_many_files');
    if ($text === '' && !$files && $gif === '') fail('empty');
    if ((int) qv('SELECT COUNT(*) FROM messages WHERE user_id = ? AND created_at > NOW(3) - INTERVAL 10 SECOND', [$u['id']]) >= 10) {
        fail('slow_down', 429);
    }

    // move the files first, so a failure leaves no half-written message behind
    $stored = [];
    $finfo = new finfo(FILEINFO_MIME_TYPE);
    foreach ($files as $f) {
        $rand = bin2hex(random_bytes(16));
        $rel = substr($rand, 0, 2) . '/' . $rand;
        $dir = FILES_DIR . '/' . substr($rand, 0, 2);
        if (!is_dir($dir) && !mkdir($dir, 0770, true) && !is_dir($dir)) fail('upload_failed', 500);
        if (!move_uploaded_file($f['tmp'], FILES_DIR . '/' . $rel)) { delete_files(array_column($stored, 'path')); fail('upload_failed', 500); }
        $mime = media_mime((string) $finfo->file(FILES_DIR . '/' . $rel));
        $w = $h = null;
        if (str_starts_with($mime, 'image/')) {
            $dim = @getimagesize(FILES_DIR . '/' . $rel);
            if ($dim) { $w = min(65535, (int) $dim[0]); $h = min(65535, (int) $dim[1]); }
        }
        $stored[] = ['path' => $rel, 'name' => $f['name'], 'size' => $f['size'], 'mime' => $mime, 'w' => $w, 'h' => $h, 'gif' => 0];
    }
    if ($gif !== '') $stored[] = store_gif($gif, $u);

    try {
        db()->beginTransaction();
        q('INSERT INTO messages (channel_id, server_id, user_id, body, rev) VALUES (?, ?, ?, ?, NEXT VALUE FOR msg_rev)',
          [$c['id'], $c['server_id'], $u['id'], $text]);
        $mid = (int) db()->lastInsertId();
        foreach ($stored as $s) {
            q('INSERT INTO attachments (message_id, name, mime, size, width, height, path, gif) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
              [$mid, $s['name'], $s['mime'], $s['size'], $s['w'], $s['h'], $s['path'], $s['gif']]);
        }
        q('UPDATE channels SET last_msg_id = GREATEST(last_msg_id, ?) WHERE id = ?', [$mid, $c['id']]);
        q('INSERT INTO channel_reads (user_id, channel_id, last_read_id) VALUES (?, ?, ?)
           ON DUPLICATE KEY UPDATE last_read_id = GREATEST(last_read_id, VALUES(last_read_id))', [$u['id'], $c['id'], $mid]);
        q('DELETE FROM typing WHERE channel_id = ? AND user_id = ?', [$c['id'], $u['id']]);
        db()->commit();
    } catch (Throwable $e) {
        if (db()->inTransaction()) db()->rollBack();
        delete_files(array_column($stored, 'path'));
        throw $e;
    }
    $row = q1('SELECT ' . MSG_COLS . ' FROM messages m WHERE m.id = ?', [$mid]);
    out(['msg' => pack_messages([$row])[0]]);
}

function own_message(int $id, array $u, bool $managersToo): array {
    $m = q1('SELECT * FROM messages WHERE id = ? AND deleted = 0', [$id]);
    if (!$m) fail('no_message', 404);
    $role = require_member((int) $m['server_id'], $u);
    $mine = (int) $m['user_id'] === (int) $u['id'];
    if (!$mine && !($managersToo && ($role === 'owner' || $role === 'admin'))) fail('forbidden', 403);
    return $m;
}

function api_edit(): void {
    $u = require_user();
    $b = body();
    $m = own_message(int_in($b, 'id'), $u, false);
    $text = clean_body($b['body'] ?? '');
    if (mb_strlen($text) > MAX_BODY) fail('too_long');
    if ($text === '' && !qv('SELECT 1 FROM attachments WHERE message_id = ?', [$m['id']])) fail('empty');
    q('UPDATE messages SET body = ?, edited_at = NOW(3), rev = NEXT VALUE FOR msg_rev WHERE id = ?', [$text, $m['id']]);
    out(['msg' => pack_messages([q1('SELECT ' . MSG_COLS . ' FROM messages m WHERE m.id = ?', [$m['id']])])[0]]);
}

function api_delete(): void {
    $u = require_user();
    $m = own_message(int_in(body(), 'id'), $u, true);
    $paths = q('SELECT path FROM attachments WHERE message_id = ?', [$m['id']])->fetchAll(PDO::FETCH_COLUMN);
    // the row stays as a tombstone so pollers learn about the delete
    q("UPDATE messages SET deleted = 1, body = '', rev = NEXT VALUE FOR msg_rev WHERE id = ?", [$m['id']]);
    q('DELETE FROM attachments WHERE message_id = ?', [$m['id']]);
    delete_files($paths);
    out(['ok' => true]);
}

function api_read(): void {
    $u = require_user();
    $b = body();
    $c = channel_for(int_in($b, 'ch'), $u);
    $id = min(int_in($b, 'id'), (int) $c['last_msg_id']);
    q('INSERT INTO channel_reads (user_id, channel_id, last_read_id) VALUES (?, ?, ?)
       ON DUPLICATE KEY UPDATE last_read_id = GREATEST(last_read_id, VALUES(last_read_id))', [$u['id'], $c['id'], max(0, $id)]);
    out(['ok' => true]);
}

/* ======================================================== files */

/** Streams an attachment to a member of its server, with byte ranges (Safari will not play video without them). */
function api_file(): void {
    $u = current_user();
    if (!$u) { http_response_code(401); exit; }
    $a = q1('SELECT a.*, m.server_id FROM attachments a JOIN messages m ON m.id = a.message_id
             WHERE a.id = ? AND m.deleted = 0', [(int) ($_GET['id'] ?? 0)]);
    if (!$a || role_in((int) $a['server_id'], (int) $u['id']) === null) { http_response_code(404); exit; }
    $path = FILES_DIR . '/' . $a['path'];
    if (!is_file($path)) { http_response_code(404); exit; }

    $size = filesize($path);
    $mime = media_mime($a['mime']);
    $inline = $mime !== 'application/octet-stream' && empty($_GET['dl']);
    $etag = '"vd' . $a['id'] . '-' . $size . '"';
    header('Content-Type: ' . $mime);
    header('Content-Security-Policy: default-src \'none\'; media-src \'self\'; img-src \'self\'; style-src \'unsafe-inline\'; sandbox');
    header('Cache-Control: private, max-age=31536000, immutable');
    header('ETag: ' . $etag);
    header('Accept-Ranges: bytes');
    header('Content-Disposition: ' . ($inline ? 'inline' : 'attachment') . "; filename*=UTF-8''" . rawurlencode($a['name']));
    if (($_SERVER['HTTP_IF_NONE_MATCH'] ?? '') === $etag) { http_response_code(304); exit; }

    $start = 0; $end = $size - 1;
    if (preg_match('/^bytes=(\d*)-(\d*)$/', (string) ($_SERVER['HTTP_RANGE'] ?? ''), $m)) {
        if ($m[1] === '' && $m[2] !== '') { $start = max(0, $size - (int) $m[2]); }
        else { $start = (int) $m[1]; if ($m[2] !== '') $end = min($end, (int) $m[2]); }
        if ($start > $end || $start >= $size) {
            http_response_code(416);
            header("Content-Range: bytes */$size");
            exit;
        }
        http_response_code(206);
        header("Content-Range: bytes $start-$end/$size");
    }
    header('Content-Length: ' . ($end - $start + 1));
    if ($_SERVER['REQUEST_METHOD'] === 'HEAD') exit;
    while (ob_get_level()) ob_end_clean();
    $fh = fopen($path, 'rb');
    fseek($fh, $start);
    $left = $end - $start + 1;
    while ($left > 0 && !feof($fh) && !connection_aborted()) {
        $chunk = fread($fh, (int) min(262144, $left));
        if ($chunk === false) break;
        echo $chunk;
        flush();
        $left -= strlen($chunk);
    }
    fclose($fh);
    exit;
}

/* ======================================================== voice */

/** Joining a voice channel: claim a seat, get the people already there. */
function api_voice_join(): void {
    $u = require_user();
    $b = body();
    $c = channel_for(int_in($b, 'ch'), $u);
    if ($c['kind'] !== 'voice') fail('not_voice');
    $peer = (string) ($b['peer'] ?? '');
    if (!preg_match('/^[A-Za-z0-9_-]{6,64}$/', $peer)) fail('bad_peer');
    q('INSERT INTO voice_states (user_id, seq, channel_id, server_id, peer_id, muted, deafened, sharing, updated_at)
       VALUES (?, NEXT VALUE FOR voice_seq, ?, ?, ?, ?, ?, 0, NOW())
       ON DUPLICATE KEY UPDATE seq = VALUES(seq), channel_id = VALUES(channel_id), server_id = VALUES(server_id),
         peer_id = VALUES(peer_id), muted = VALUES(muted), deafened = VALUES(deafened), sharing = 0, updated_at = NOW()',
      [$u['id'], $c['id'], $c['server_id'], $peer, !empty($b['mu']) ? 1 : 0, !empty($b['df']) ? 1 : 0]);
    $all = voice_states_for([(int) $c['server_id']]);
    $mine = array_values(array_filter($all, fn($v) => $v['uid'] === (int) $u['id']));
    out(['seq' => $mine ? $mine[0]['seq'] : 0, 'voice' => $all]);
}

function api_voice_leave(): void {
    $u = current_user();
    if (!$u) out(['ok' => true]);
    $peer = (string) (body()['peer'] ?? '');
    q('DELETE FROM voice_states WHERE user_id = ? AND peer_id = ?', [$u['id'], $peer]);
    out(['ok' => true]);
}
