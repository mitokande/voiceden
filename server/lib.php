<?php
/**
 * VoiceDen — shared helpers for api.php: database, JSON in/out, sessions,
 * permission checks and the row → wire-format mappers.
 */
declare(strict_types=1);

date_default_timezone_set('UTC');

const SESSION_COOKIE = 'vd_sid';
const SESSION_DAYS   = 90;
const ONLINE_SECS    = 90;     // last_seen newer than this = online
const VOICE_STALE    = 25;     // a voice state without a heartbeat for this long is gone
const MAX_BODY       = 2000;   // characters per message
const MAX_FILES      = 10;     // per message
const MAX_FILE_SIZE  = 25 * 1024 * 1024;
const FILES_DIR      = __DIR__ . '/../data/files';
const IMG_DIR        = __DIR__ . '/../data/avatars';
const IMG_SIDE       = 256;
const TINT_COUNT     = 8;

/* ---------- output ---------- */

function out(array $data, int $code = 200): never {
    http_response_code($code);
    header('Content-Type: application/json; charset=utf-8');
    header('Cache-Control: no-store');
    echo json_encode($data, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE);
    exit;
}
function fail(string $error, int $code = 400, array $extra = []): never {
    out(['error' => $error] + $extra, $code);
}

/* ---------- database ---------- */

function cfg(string $key, mixed $default = null): mixed {
    static $c = null;
    $c ??= require __DIR__ . '/config.php';
    return $c[$key] ?? $default;
}

function db(): PDO {
    static $pdo = null;
    if ($pdo) return $pdo;
    $c = cfg('db');
    $pdo = new PDO(
        "mysql:host={$c['host']};dbname={$c['name']};charset=utf8mb4",
        $c['user'], $c['pass'],
        [
            PDO::ATTR_ERRMODE            => PDO::ERRMODE_EXCEPTION,
            PDO::ATTR_DEFAULT_FETCH_MODE => PDO::FETCH_ASSOC,
            PDO::ATTR_EMULATE_PREPARES   => false,
            // rowCount() = rows matched, not rows changed: a heartbeat that writes
            // the same values must still count as "my voice state exists"
            PDO::MYSQL_ATTR_FOUND_ROWS   => true,
        ]
    );
    $pdo->exec("SET time_zone = '+00:00'");
    return $pdo;
}
function q(string $sql, array $args = []): PDOStatement {
    $st = db()->prepare($sql);
    $st->execute($args);
    return $st;
}
function q1(string $sql, array $args = []): ?array {
    $r = q($sql, $args)->fetch();
    return $r === false ? null : $r;
}
function qv(string $sql, array $args = []): mixed {
    $v = q($sql, $args)->fetchColumn();
    return $v === false ? null : $v;
}
/** "?,?,?" for an IN (...) list; callers guarantee a non-empty array */
function marks(array $a): string { return implode(',', array_fill(0, count($a), '?')); }

/* ---------- input ---------- */

function body(): array {
    static $b = null;
    if ($b !== null) return $b;
    if (!empty($_POST)) return $b = $_POST;          // multipart (message with files)
    $raw = file_get_contents('php://input') ?: '';
    $j = json_decode($raw, true);
    return $b = is_array($j) ? $j : [];
}
function int_in(array $b, string $k): int {
    $v = $b[$k] ?? null;
    return is_numeric($v) ? (int) $v : 0;
}
/** trim, drop control characters, collapse runs of spaces */
function clean_line(mixed $s, int $max): string {
    $s = is_string($s) ? $s : '';
    $s = preg_replace('/[\x00-\x1F\x7F\x{200B}\x{200E}\x{200F}\x{202A}-\x{202E}\x{2066}-\x{2069}]/u', '', $s) ?? '';
    $s = trim(preg_replace('/\s+/u', ' ', $s) ?? '');
    return mb_substr($s, 0, $max);
}
/** message text: newlines survive, other control characters do not */
function clean_body(mixed $s): string {
    $s = is_string($s) ? $s : '';
    $s = str_replace("\r\n", "\n", $s);
    $s = preg_replace('/[\x00-\x09\x0B-\x1F\x7F\x{202A}-\x{202E}\x{2066}-\x{2069}]/u', '', $s) ?? '';
    $s = preg_replace("/\n{4,}/", "\n\n\n", $s) ?? '';
    return trim($s);
}
function client_ip(): string { return substr((string) ($_SERVER['REMOTE_ADDR'] ?? ''), 0, 45); }

/* ---------- throttling ---------- */

/** true while `key` has had fewer than $max hits in the last $window seconds */
function throttle_ok(string $key, int $max, int $window): bool {
    $n = (int) qv('SELECT COUNT(*) FROM throttle WHERE k = ? AND at > NOW() - INTERVAL ? SECOND', [$key, $window]);
    return $n < $max;
}
function throttle_hit(string $key): void {
    q('INSERT INTO throttle (k) VALUES (?)', [$key]);
    if (random_int(1, 50) === 1) q('DELETE FROM throttle WHERE at < NOW() - INTERVAL 1 DAY');
}

/* ---------- sessions ---------- */

function cookie_path(): string {
    $d = rtrim(str_replace('\\', '/', dirname($_SERVER['SCRIPT_NAME'] ?? '/')), '/');
    return $d . '/';
}
function set_session_cookie(string $value, int $expires): void {
    setcookie(SESSION_COOKIE, $value, [
        'expires'  => $expires,
        'path'     => cookie_path(),
        'secure'   => true,
        'httponly' => true,
        'samesite' => 'Lax',
    ]);
}
function start_session(int $uid): void {
    $token = bin2hex(random_bytes(32));
    $exp = time() + SESSION_DAYS * 86400;
    q('INSERT INTO sessions (token_hash, user_id, expires_at, ua) VALUES (?, ?, FROM_UNIXTIME(?), ?)',
      [hash('sha256', $token, true), $uid, $exp, mb_substr((string) ($_SERVER['HTTP_USER_AGENT'] ?? ''), 0, 200)]);
    set_session_cookie($token, $exp);
}
function end_session(): void {
    $t = $_COOKIE[SESSION_COOKIE] ?? '';
    if (is_string($t) && $t !== '') q('DELETE FROM sessions WHERE token_hash = ?', [hash('sha256', $t, true)]);
    set_session_cookie('', time() - 3600);
}
function current_user(): ?array {
    static $u = false;
    if ($u !== false) return $u;
    $t = $_COOKIE[SESSION_COOKIE] ?? '';
    if (!is_string($t) || !preg_match('/^[a-f0-9]{64}$/', $t)) return $u = null;
    $h = hash('sha256', $t, true);
    $row = q1('SELECT u.*, s.last_used, UNIX_TIMESTAMP(s.last_used) AS used_ts FROM sessions s
               JOIN users u ON u.id = s.user_id WHERE s.token_hash = ? AND s.expires_at > NOW()', [$h]);
    if (!$row) return $u = null;
    // sliding expiry, written at most once a day
    if (time() - (int) $row['used_ts'] > 86400) {
        $exp = time() + SESSION_DAYS * 86400;
        q('UPDATE sessions SET last_used = NOW(), expires_at = FROM_UNIXTIME(?) WHERE token_hash = ?', [$exp, $h]);
        set_session_cookie($t, $exp);
    }
    return $u = $row;
}
function require_user(): array {
    $u = current_user();
    if (!$u) fail('auth', 401);
    return $u;
}
/** presence: one write per 30 s at most */
function touch_seen(array $u): void {
    if (!$u['last_seen'] || time() - strtotime($u['last_seen'] . ' UTC') > 30) {
        q('UPDATE users SET last_seen = NOW() WHERE id = ?', [$u['id']]);
    }
}

/* ---------- permissions ---------- */

function role_in(int $sid, int $uid): ?string {
    $r = qv('SELECT role FROM members WHERE server_id = ? AND user_id = ?', [$sid, $uid]);
    return $r === null ? null : (string) $r;
}
function require_member(int $sid, array $u): string {
    $r = role_in($sid, (int) $u['id']);
    if ($r === null) fail('not_member', 403);
    return $r;
}
function require_manager(int $sid, array $u): string {
    $r = require_member($sid, $u);
    if ($r !== 'owner' && $r !== 'admin') fail('forbidden', 403);
    return $r;
}
/** the channel row, after checking the caller belongs to its server */
function channel_for(int $cid, array $u): array {
    $c = q1('SELECT * FROM channels WHERE id = ?', [$cid]);
    if (!$c) fail('no_channel', 404);
    $c['role'] = require_member((int) $c['server_id'], $u);
    return $c;
}
function my_server_ids(int $uid): array {
    return array_map('intval', q('SELECT server_id FROM members WHERE user_id = ?', [$uid])->fetchAll(PDO::FETCH_COLUMN));
}
function bump_server(int $sid): void { q('UPDATE servers SET rev = rev + 1 WHERE id = ?', [$sid]); }

/* ---------- wire formats ---------- */

function pub_user(array $u): array {
    return ['id' => (int) $u['id'], 'username' => $u['username'], 'name' => $u['display_name'], 'tint' => (int) $u['tint'],
            'av' => $u['avatar'] ?? null];
}

const MSG_COLS = 'm.id, m.channel_id, m.server_id, m.user_id, m.body, m.deleted, m.rev,
    ROUND(UNIX_TIMESTAMP(m.created_at) * 1000) AS ts, ROUND(UNIX_TIMESTAMP(m.edited_at) * 1000) AS ets';

/** rows from MSG_COLS → wire messages, with their attachments folded in */
function pack_messages(array $rows): array {
    if (!$rows) return [];
    $ids = array_map(fn($r) => (int) $r['id'], $rows);
    $att = [];
    foreach (q('SELECT id, message_id, name, mime, size, width, height, gif FROM attachments
                WHERE message_id IN (' . marks($ids) . ') ORDER BY id', $ids) as $a) {
        $att[(int) $a['message_id']][] = [
            'id' => (int) $a['id'], 'name' => $a['name'], 'mime' => $a['mime'], 'size' => (int) $a['size'],
            'w' => $a['width'] === null ? null : (int) $a['width'], 'h' => $a['height'] === null ? null : (int) $a['height'],
            'gif' => (bool) $a['gif'],
        ];
    }
    $mn = [];
    foreach (q('SELECT message_id, user_id FROM mentions WHERE message_id IN (' . marks($ids) . ')', $ids) as $x) {
        $mn[(int) $x['message_id']][] = (int) $x['user_id'];
    }
    return array_map(fn($r) => [
        'id'  => (int) $r['id'],
        'ch'  => (int) $r['channel_id'],
        'sid' => (int) $r['server_id'],
        'uid' => (int) $r['user_id'],
        'body'=> $r['deleted'] ? '' : $r['body'],
        'ts'  => (int) $r['ts'],
        'ets' => $r['ets'] === null ? null : (int) $r['ets'],
        'del' => (bool) $r['deleted'],
        'rev' => (int) $r['rev'],
        'att' => $r['deleted'] ? [] : ($att[(int) $r['id']] ?? []),
        'mn'  => $r['deleted'] ? [] : ($mn[(int) $r['id']] ?? []),      // who it @mentions
    ], $rows);
}

/** authors of these rows, so a name survives its owner leaving the den */
function authors_of(array $rows): array {
    $ids = array_values(array_unique(array_map(fn($r) => (int) $r['user_id'], $rows)));
    if (!$ids) return [];
    return array_map('pub_user', q('SELECT * FROM users WHERE id IN (' . marks($ids) . ')', $ids)->fetchAll());
}

function voice_states_for(array $sids): array {
    if (!$sids) return [];
    $rows = q('SELECT user_id, seq, channel_id, server_id, peer_id, muted, deafened, sharing FROM voice_states
               WHERE server_id IN (' . marks($sids) . ') AND updated_at > NOW() - INTERVAL ' . VOICE_STALE . ' SECOND
               ORDER BY seq', $sids)->fetchAll();
    return array_map(fn($v) => [
        'uid' => (int) $v['user_id'], 'seq' => (int) $v['seq'], 'ch' => (int) $v['channel_id'],
        'sid' => (int) $v['server_id'], 'peer' => $v['peer_id'],
        'mu' => (bool) $v['muted'], 'df' => (bool) $v['deafened'], 'sh' => (bool) $v['sharing'],
    ], $rows);
}

function online_ids(array $sids): array {
    if (!$sids) return [];
    return array_map('intval', q('SELECT DISTINCT u.id FROM members m JOIN users u ON u.id = m.user_id
        WHERE m.server_id IN (' . marks($sids) . ') AND u.last_seen > NOW() - INTERVAL ' . ONLINE_SECS . ' SECOND',
        $sids)->fetchAll(PDO::FETCH_COLUMN));
}

/* ---------- files ---------- */

/** Only media is ever shown inline; SVG can carry script, so it is not media here. */
function media_mime(string $m): string {
    $m = strtolower(trim(explode(';', $m)[0]));
    if ($m === 'image/svg+xml') return 'application/octet-stream';
    return preg_match('#^(image|audio|video)/[a-z0-9.+-]+$#', $m) ? $m : 'application/octet-stream';
}
function safe_filename(string $n): string {
    $n = preg_replace('/[\\\\\/\x00-\x1F\x7F"]/u', '_', $n) ?? 'file';
    $n = ltrim($n, '.');
    return mb_substr($n, -100) ?: 'file';
}
/** the uploaded `image` field, checked; returns its temp path */
function uploaded_image(): string {
    $f = $_FILES['image'] ?? null;
    if (!$f || is_array($f['tmp_name'])) fail('bad_image');
    if ((int) $f['error'] !== UPLOAD_ERR_OK) fail(upload_error((int) $f['error']));
    if ((int) $f['size'] > 8 * 1024 * 1024) fail('file_too_big');
    if (!is_uploaded_file($f['tmp_name'])) fail('upload_failed');
    return $f['tmp_name'];
}

/**
 * Any picture in, a 256×256 WebP out (centre square). Re-encoding is the point:
 * it drops metadata and whatever a crafted file carried besides pixels.
 * Returns the random key the picture is served under.
 */
function store_square_image(string $tmp): string {
    $info = @getimagesize($tmp);
    $ok = [IMAGETYPE_JPEG, IMAGETYPE_PNG, IMAGETYPE_GIF, IMAGETYPE_WEBP, IMAGETYPE_BMP, IMAGETYPE_AVIF];
    if (!$info || !in_array($info[2], $ok, true)) fail('bad_image');
    if ($info[0] < 1 || $info[1] < 1 || $info[0] * $info[1] > 40000000) fail('bad_image');   // decompression bombs
    $src = @imagecreatefromstring((string) file_get_contents($tmp));
    if (!$src) fail('bad_image');
    $w = imagesx($src); $h = imagesy($src); $side = min($w, $h);
    $dst = imagecreatetruecolor(IMG_SIDE, IMG_SIDE);
    imagealphablending($dst, false);
    imagesavealpha($dst, true);
    imagefill($dst, 0, 0, imagecolorallocatealpha($dst, 0, 0, 0, 127));
    imagecopyresampled($dst, $src, 0, 0, intdiv($w - $side, 2), intdiv($h - $side, 2), IMG_SIDE, IMG_SIDE, $side, $side);
    $key = bin2hex(random_bytes(16));
    if (!is_dir(IMG_DIR) && !mkdir(IMG_DIR, 0770, true) && !is_dir(IMG_DIR)) fail('upload_failed', 500);
    $ok = imagewebp($dst, IMG_DIR . '/' . $key . '.webp', 86);
    imagedestroy($src);
    imagedestroy($dst);
    if (!$ok) fail('upload_failed', 500);
    return $key;
}
function delete_image(?string $key): void {
    if ($key && preg_match('/^[a-f0-9]{32}$/', $key)) @unlink(IMG_DIR . '/' . $key . '.webp');
}

function delete_files(array $paths): void {
    foreach ($paths as $p) {
        if (is_string($p) && preg_match('#^[a-f0-9]{2}/[a-f0-9]{32}$#', $p)) @unlink(FILES_DIR . '/' . $p);
    }
}
