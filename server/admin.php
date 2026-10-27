<?php
/**
 * VoiceDen — admin dashboard data (admin.html).
 *
 * Only usernames listed in config 'admins' get past require_admin(); everyone
 * else sees a plain 403. GET admin returns the cheap live figures every call
 * (CPU counters, load, memory, network counters, top processes) and, with
 * full=1, the heavier ones too (disks, site folder sizes, MariaDB, VoiceDen).
 * Rates (CPU %, network speed) are differences between two calls, worked out
 * by the browser, so nothing here sleeps.
 */
declare(strict_types=1);

const SITE_ROOT  = '/var/www/vhosts/mithatck.com/httpdocs';
const SIZE_CACHE = __DIR__ . '/../data/admin-sizes.json';
const SIZE_TTL   = 600;
const TZ_OFFSET  = '+03:00';          // Istanbul, no DST since 2016

function is_admin(?array $u): bool {
    if (!$u) return false;
    $admins = array_map('strtolower', (array) cfg('admins', []));
    return in_array(strtolower((string) $u['username']), $admins, true);
}
function require_admin(): array {
    $u = require_user();
    if (!is_admin($u)) fail('forbidden', 403);
    return $u;
}

function read_kv(string $file): array {
    $out = [];
    foreach (@file($file, FILE_IGNORE_NEW_LINES) ?: [] as $line) {
        if (preg_match('/^([\w()]+):\s+(\d+)/', $line, $m)) $out[$m[1]] = (int) $m[2];
    }
    return $out;
}

function host_live(): array {
    $stat = @file('/proc/stat', FILE_IGNORE_NEW_LINES) ?: [];
    $cpu = ['total' => 0, 'idle' => 0];
    if ($stat && preg_match('/^cpu\s+(.*)$/', $stat[0], $m)) {
        $v = array_map('intval', preg_split('/\s+/', trim($m[1])));
        $cpu = ['total' => array_sum(array_slice($v, 0, 8)), 'idle' => ($v[3] ?? 0) + ($v[4] ?? 0)];
    }
    $mem = read_kv('/proc/meminfo');

    // the busiest real interface: not loopback, not a docker/bridge/veth
    $net = ['iface' => null, 'rx' => 0, 'tx' => 0];
    foreach (array_slice(@file('/proc/net/dev', FILE_IGNORE_NEW_LINES) ?: [], 2) as $line) {
        [$name, $rest] = array_map('trim', explode(':', $line, 2)) + ['', ''];
        if ($name === 'lo' || preg_match('/^(docker|br-|veth|virbr|tun|tap)/', $name)) continue;
        $f = preg_split('/\s+/', trim($rest));
        $rx = (int) ($f[0] ?? 0); $tx = (int) ($f[8] ?? 0);
        if ($rx + $tx > $net['rx'] + $net['tx']) $net = ['iface' => $name, 'rx' => $rx, 'tx' => $tx];
    }

    $top = [];
    $ps = (string) @shell_exec('ps -eo pid,user:16,pcpu,pmem,rss,etimes,comm --sort=-pcpu --no-headers 2>/dev/null | head -10');
    foreach (explode("\n", trim($ps)) as $line) {
        $p = preg_split('/\s+/', trim($line), 7);
        if (count($p) < 7) continue;
        $top[] = ['pid' => (int) $p[0], 'user' => $p[1], 'cpu' => (float) $p[2], 'mem' => (float) $p[3],
                  'rss' => (int) $p[4] * 1024, 'age' => (int) $p[5], 'cmd' => mb_substr($p[6], 0, 40)];
    }

    return [
        'ts'   => (int) round(microtime(true) * 1000),
        'load' => array_map(fn($x) => round($x, 2), sys_getloadavg() ?: [0, 0, 0]),
        'cpu'  => $cpu,
        'mem'  => [
            'total' => ($mem['MemTotal'] ?? 0) * 1024, 'avail' => ($mem['MemAvailable'] ?? 0) * 1024,
            'swapTotal' => ($mem['SwapTotal'] ?? 0) * 1024, 'swapFree' => ($mem['SwapFree'] ?? 0) * 1024,
        ],
        'net'   => $net,
        'procs' => ['count' => count(glob('/proc/[0-9]*', GLOB_ONLYDIR) ?: []), 'top' => $top],
    ];
}

function host_full(): array {
    $os = '';
    foreach (@file('/etc/os-release', FILE_IGNORE_NEW_LINES) ?: [] as $l) {
        if (str_starts_with($l, 'PRETTY_NAME=')) $os = trim(substr($l, 12), '"');
    }
    preg_match('/model name\s*:\s*(.+)/', (string) @file_get_contents('/proc/cpuinfo'), $model);
    $disks = [];
    foreach (@file('/proc/mounts', FILE_IGNORE_NEW_LINES) ?: [] as $l) {
        [$dev, $mnt, $fs] = explode(' ', $l) + ['', '', ''];
        if (!in_array($fs, ['ext4', 'xfs', 'btrfs', 'zfs'], true) || isset($disks[$dev])) continue;
        $total = @disk_total_space($mnt); $free = @disk_free_space($mnt);
        if ($total) $disks[$dev] = ['mount' => $mnt, 'dev' => $dev, 'fs' => $fs, 'total' => (int) $total, 'free' => (int) $free];
    }
    $up = (float) explode(' ', (string) @file_get_contents('/proc/uptime'))[0];
    return [
        'host'   => gethostname(),
        'os'     => $os,
        'kernel' => php_uname('r'),
        'cpu'    => trim($model[1] ?? ''),
        'cores'  => substr_count((string) @file_get_contents('/proc/cpuinfo'), "\nprocessor") + 1,
        'uptime' => (int) $up,
        'php'    => PHP_VERSION . ' (' . PHP_SAPI . ')',
        'disks'  => array_values($disks),
        'sites'  => site_sizes(),
    ];
}

/** sizes of the top-level folders in httpdocs; du is cheap here but still cached */
function site_sizes(): array {
    $c = @json_decode((string) @file_get_contents(SIZE_CACHE), true);
    if (is_array($c) && time() - ($c['at'] ?? 0) < SIZE_TTL) return $c;
    $out = (string) @shell_exec('timeout 30 du -s --block-size=1 ' . escapeshellarg(SITE_ROOT) . '/* ' . escapeshellarg(SITE_ROOT) . '/.[!.]* 2>/dev/null');
    $rows = [];
    foreach (explode("\n", trim($out)) as $line) {
        if (!preg_match('/^(\d+)\s+(.+)$/', $line, $m)) continue;
        $rows[] = ['name' => basename($m[2]), 'bytes' => (int) $m[1], 'dir' => is_dir($m[2])];
    }
    usort($rows, fn($a, $b) => $b['bytes'] <=> $a['bytes']);
    $c = ['at' => time(), 'total' => array_sum(array_column($rows, 'bytes')), 'items' => $rows];
    @file_put_contents(SIZE_CACHE, json_encode($c));
    return $c;
}

function dir_bytes(string $dir): array {
    $n = 0; $b = 0;
    if (!is_dir($dir)) return ['files' => 0, 'bytes' => 0];
    $it = new RecursiveIteratorIterator(new RecursiveDirectoryIterator($dir, FilesystemIterator::SKIP_DOTS));
    foreach ($it as $f) { if ($f->isFile()) { $n++; $b += $f->getSize(); } }
    return ['files' => $n, 'bytes' => $b];
}

/** last 14 local days as [{d: 'YYYY-MM-DD', n}] with the empty days filled in */
function per_day(string $table, string $col, string $where = '1'): array {
    $rows = q("SELECT DATE(CONVERT_TZ($col, '+00:00', '" . TZ_OFFSET . "')) AS d, COUNT(*) AS n FROM $table
               WHERE $where AND $col > NOW() - INTERVAL 15 DAY GROUP BY d")->fetchAll(PDO::FETCH_KEY_PAIR);
    $out = [];
    $tz = new DateTimeZone('Europe/Istanbul');
    for ($i = 13; $i >= 0; $i--) {
        $d = (new DateTime("-$i day", $tz))->format('Y-m-d');
        $out[] = ['d' => $d, 'n' => (int) ($rows[$d] ?? 0)];
    }
    return $out;
}

function voiceden_stats(): array {
    $one = fn(string $sql) => (int) qv($sql);
    $files = dir_bytes(FILES_DIR);
    $avatars = dir_bytes(IMG_DIR);
    $dbBytes = (int) qv("SELECT COALESCE(SUM(data_length + index_length), 0) FROM information_schema.TABLES WHERE table_schema = DATABASE()");

    $voice = array_map(fn($v) => [
        'user' => $v['display_name'], 'username' => $v['username'], 'den' => $v['den'], 'channel' => $v['channel'],
        'muted' => (bool) $v['muted'], 'deaf' => (bool) $v['deafened'], 'sharing' => (bool) $v['sharing'],
    ], q("SELECT u.display_name, u.username, s.name AS den, c.name AS channel, v.muted, v.deafened, v.sharing
          FROM voice_states v JOIN users u ON u.id = v.user_id JOIN servers s ON s.id = v.server_id JOIN channels c ON c.id = v.channel_id
          WHERE v.updated_at > NOW() - INTERVAL " . VOICE_STALE . " SECOND ORDER BY s.name, c.name, v.seq")->fetchAll());

    $dens = q("SELECT s.id, s.name, o.username AS owner,
                 (SELECT COUNT(*) FROM members m WHERE m.server_id = s.id) AS members,
                 (SELECT COUNT(*) FROM channels c WHERE c.server_id = s.id) AS channels,
                 (SELECT COUNT(*) FROM messages x WHERE x.server_id = s.id AND x.deleted = 0) AS msgs,
                 (SELECT COUNT(*) FROM messages x WHERE x.server_id = s.id AND x.deleted = 0 AND x.created_at > NOW() - INTERVAL 7 DAY) AS msgs7,
                 UNIX_TIMESTAMP(s.created_at) * 1000 AS created
               FROM servers s JOIN users o ON o.id = s.owner_id ORDER BY msgs7 DESC, msgs DESC LIMIT 20")->fetchAll();

    $recent = q("SELECT display_name, username, UNIX_TIMESTAMP(created_at) * 1000 AS created, UNIX_TIMESTAMP(last_seen) * 1000 AS seen,
                   (SELECT COUNT(*) FROM members m WHERE m.user_id = u.id) AS dens
                 FROM users u ORDER BY id DESC LIMIT 10")->fetchAll();

    return [
        'users'    => $one('SELECT COUNT(*) FROM users'),
        'users7'   => $one('SELECT COUNT(*) FROM users WHERE created_at > NOW() - INTERVAL 7 DAY'),
        'online'   => $one('SELECT COUNT(*) FROM users WHERE last_seen > NOW() - INTERVAL ' . ONLINE_SECS . ' SECOND'),
        'active1'  => $one('SELECT COUNT(*) FROM users WHERE last_seen > NOW() - INTERVAL 1 DAY'),
        'active7'  => $one('SELECT COUNT(*) FROM users WHERE last_seen > NOW() - INTERVAL 7 DAY'),
        'sessions' => $one('SELECT COUNT(*) FROM sessions WHERE expires_at > NOW()'),
        'denCount' => $one('SELECT COUNT(*) FROM servers'),
        'text'     => $one("SELECT COUNT(*) FROM channels WHERE kind = 'text'"),
        'voiceCh'  => $one("SELECT COUNT(*) FROM channels WHERE kind = 'voice'"),
        'msgs'     => $one('SELECT COUNT(*) FROM messages WHERE deleted = 0'),
        'msgs1'    => $one('SELECT COUNT(*) FROM messages WHERE deleted = 0 AND created_at > NOW() - INTERVAL 1 DAY'),
        'atts'     => $one('SELECT COUNT(*) FROM attachments WHERE gif = 0'),
        'gifs'     => $one('SELECT COUNT(*) FROM attachments WHERE gif = 1'),
        'attBytes' => $one('SELECT COALESCE(SUM(size), 0) FROM attachments WHERE gif = 0'),
        'gifBytes' => $one('SELECT COALESCE(SUM(size), 0) FROM attachments WHERE gif = 1'),
        'photos'   => $one('SELECT (SELECT COUNT(*) FROM users WHERE avatar IS NOT NULL) + (SELECT COUNT(*) FROM servers WHERE icon IS NOT NULL)'),
        'disk'     => ['files' => $files, 'avatars' => $avatars, 'db' => $dbBytes],
        'gifCache' => $one('SELECT COUNT(*) FROM gif_items'),
        'perDay'   => ['msgs' => per_day('messages', 'created_at', 'deleted = 0'), 'users' => per_day('users', 'created_at')],
        'voice'    => $voice,
        'dens'     => array_map(fn($d) => [
            'name' => $d['name'], 'owner' => $d['owner'], 'members' => (int) $d['members'], 'channels' => (int) $d['channels'],
            'msgs' => (int) $d['msgs'], 'msgs7' => (int) $d['msgs7'], 'created' => (int) $d['created'],
        ], $dens),
        'recent'   => array_map(fn($r) => [
            'name' => $r['display_name'], 'username' => $r['username'], 'created' => (int) $r['created'],
            'seen' => $r['seen'] === null ? null : (int) $r['seen'], 'dens' => (int) $r['dens'],
        ], $recent),
    ];
}

function db_stats(): array {
    $st = q("SHOW GLOBAL STATUS WHERE Variable_name IN ('Uptime','Threads_connected','Questions','Slow_queries','Max_used_connections')")
        ->fetchAll(PDO::FETCH_KEY_PAIR);
    return [
        'version' => (string) qv('SELECT VERSION()'),
        'uptime'  => (int) ($st['Uptime'] ?? 0),
        'threads' => (int) ($st['Threads_connected'] ?? 0),
        'maxUsed' => (int) ($st['Max_used_connections'] ?? 0),
        'queries' => (int) ($st['Questions'] ?? 0),
        'slow'    => (int) ($st['Slow_queries'] ?? 0),
        'schemas' => (int) qv('SELECT COUNT(*) FROM information_schema.SCHEMATA'),
    ];
}

/** GET admin[&full=1] */
function api_admin(): void {
    require_admin();
    $res = ['live' => host_live()];
    if (!empty($_GET['full'])) {
        $res['host'] = host_full();
        $res['db'] = db_stats();
        $res['vd'] = voiceden_stats();
    }
    out($res);
}
