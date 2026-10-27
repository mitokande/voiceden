<?php
/**
 * VoiceDen — GIF search through KLIPY (Tenor's API closed on 2026-06-30).
 *
 * The browser only ever talks to api.php: the key stays here, repeated
 * searches come from gif_pages, and every GIF a search showed is remembered in
 * gif_items. Sending names a GIF by slug only; the server looks the media URL
 * up itself and downloads the mp4 into data/files like any upload, so a GIF in
 * the chat keeps working whatever happens to the provider.
 */
declare(strict_types=1);

const KLIPY_BASE      = 'https://api.klipy.com/api/v1';
const GIF_PAGE_TTL    = 900;               // trending changes; searches barely do
const GIF_SEARCH_TTL  = 21600;
const GIF_MAX_BYTES   = 8 * 1024 * 1024;   // an mp4 GIF is usually a few hundred KB

function klipy_base(): string { return rtrim((string) cfg('klipy_base', KLIPY_BASE), '/'); }
function gifs_enabled(): bool { return (string) cfg('klipy_key', '') !== ''; }

/** KLIPY wants a stable per-user id for ranking; it gets a hash, not ours */
function klipy_customer(int $uid): string {
    return substr(hash('sha256', 'voiceden|' . $uid . '|' . cfg('klipy_key', '')), 0, 32);
}

/** GET a URL with curl; [status, body] or null. Redirects are not followed. */
function http_fetch(string $url, int $timeout, int $maxBytes, string $method = 'GET', ?string $json = null): ?array {
    $ch = curl_init($url);
    $body = '';
    $tooBig = false;
    curl_setopt_array($ch, [
        CURLOPT_FOLLOWLOCATION => false,
        CURLOPT_PROTOCOLS      => CURLPROTO_HTTPS | CURLPROTO_HTTP,
        CURLOPT_CONNECTTIMEOUT => 4,
        CURLOPT_TIMEOUT        => $timeout,
        CURLOPT_USERAGENT      => 'VoiceDen/1.0 (+https://mithatck.com/voiceden)',
        CURLOPT_HTTPHEADER     => $json !== null ? ['Content-Type: application/json', 'Accept: application/json'] : ['Accept: */*'],
        CURLOPT_WRITEFUNCTION  => function ($ch, $chunk) use (&$body, &$tooBig, $maxBytes) {
            $body .= $chunk;
            if (strlen($body) > $maxBytes) { $tooBig = true; return 0; }
            return strlen($chunk);
        },
    ]);
    if ($method !== 'GET') curl_setopt($ch, CURLOPT_CUSTOMREQUEST, $method);
    if ($json !== null) curl_setopt($ch, CURLOPT_POSTFIELDS, $json);
    $ok = curl_exec($ch);
    $status = (int) curl_getinfo($ch, CURLINFO_RESPONSE_CODE);
    $loc = (string) curl_getinfo($ch, CURLINFO_REDIRECT_URL);
    curl_close($ch);
    if ($tooBig || ($ok === false && $status === 0)) return null;
    return [$status, $body, $loc];
}

function klipy_call(string $path, array $query = []): ?array {
    $url = klipy_base() . '/' . rawurlencode((string) cfg('klipy_key')) . '/' . $path;
    $query = array_filter($query, fn($v) => $v !== null && $v !== '');
    if ($query) $url .= '?' . http_build_query($query);
    $r = http_fetch($url, 8, 4 * 1024 * 1024);
    if (!$r || $r[0] !== 200) {
        error_log('[voiceden] klipy ' . $path . ' -> ' . ($r ? $r[0] : 'no response'));
        return null;
    }
    $j = json_decode($r[1], true);
    return is_array($j) ? $j : null;
}

/** one KLIPY item → what the picker needs, or null for ads and anything unplayable */
function gif_slim(array $it): ?array {
    if (($it['type'] ?? '') === 'ad' || empty($it['file']) || !is_array($it['file'])) return null;
    $f = $it['file'];
    $pick = function (array $sizes, string $fmt) use ($f): ?array {
        foreach ($sizes as $s) {
            $x = $f[$s][$fmt] ?? null;
            if (is_array($x) && !empty($x['url'])) return $x;
        }
        return null;
    };
    $thumb = $pick(['sm', 'xs', 'md'], 'webp') ?? $pick(['sm', 'xs', 'md'], 'gif');
    $send  = $pick(['md', 'sm', 'hd'], 'mp4') ?? $pick(['md', 'sm', 'hd'], 'gif');
    $slug  = (string) ($it['slug'] ?? $it['id'] ?? '');
    if (!$thumb || !$send || $slug === '' || strlen($slug) > 160) return null;
    return [
        'slug'  => $slug,
        'title' => mb_substr((string) ($it['title'] ?? ''), 0, 120),
        'thumb' => (string) $thumb['url'],
        'tw'    => (int) ($thumb['width'] ?? 0), 'th' => (int) ($thumb['height'] ?? 0),
        'url'   => (string) $send['url'],
        'w'     => (int) ($send['width'] ?? 0), 'h' => (int) ($send['height'] ?? 0),
    ];
}

/** GET gifs?q=&page= — trending when q is empty */
function api_gifs(): void {
    $u = require_user();
    if (!gifs_enabled()) fail('gifs_off', 503);
    $q = clean_line($_GET['q'] ?? '', 80);
    $page = max(1, min(20, (int) ($_GET['page'] ?? 1)));
    $locale = (string) cfg('klipy_locale', 'tr_TR');
    $key = sha1(mb_strtolower($q) . '|' . $page . '|' . $locale, true);
    $ttl = $q === '' ? GIF_PAGE_TTL : GIF_SEARCH_TTL;

    $hit = q1('SELECT data FROM gif_pages WHERE k = ? AND at > NOW() - INTERVAL ? SECOND', [$key, $ttl]);
    if ($hit) out(json_decode($hit['data'], true) ?: ['gifs' => [], 'more' => false]);

    // only cache misses count against the per-user brake
    $tk = 'gifs:' . $u['id'];
    if (!throttle_ok($tk, 40, 60)) fail('slow_down', 429);
    throttle_hit($tk);

    $r = klipy_call($q === '' ? 'gifs/trending' : 'gifs/search', [
        'q' => $q === '' ? null : $q, 'page' => $page, 'per_page' => 24,
        'customer_id' => klipy_customer((int) $u['id']), 'locale' => $locale, 'rating' => 'pg-13',
    ]);
    if (!$r) fail('gifs_down', 502);
    $data = $r['data'] ?? [];
    $gifs = [];
    foreach (($data['data'] ?? []) as $it) {
        if (is_array($it) && ($g = gif_slim($it))) $gifs[] = $g;
    }
    // the client only gets what it shows; the URL that gets downloaded stays here
    $res = [
        'gifs' => array_map(fn($g) => ['slug' => $g['slug'], 'title' => $g['title'], 'thumb' => $g['thumb'], 'w' => $g['tw'], 'h' => $g['th']], $gifs),
        'more' => (bool) ($data['has_next'] ?? false),
    ];
    q('REPLACE INTO gif_pages (k, data, at) VALUES (?, ?, NOW())', [$key, json_encode($res, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE)]);
    foreach ($gifs as $g) {
        q('REPLACE INTO gif_items (slug, data, at) VALUES (?, ?, NOW())', [$g['slug'], json_encode($g, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE)]);
    }
    if (random_int(1, 30) === 1) {
        q('DELETE FROM gif_pages WHERE at < NOW() - INTERVAL 1 DAY');
        q('DELETE FROM gif_items WHERE at < NOW() - INTERVAL 7 DAY');
    }
    out($res);
}

/** media may only come from KLIPY's own hosts (or the configured API host) */
function gif_url_ok(string $url): bool {
    $p = parse_url($url);
    if (!$p || empty($p['host']) || isset($p['user']) || isset($p['pass'])) return false;
    $host = strtolower($p['host']);
    $base = parse_url(klipy_base());
    $baseHost = strtolower((string) ($base['host'] ?? ''));
    if ($host === $baseHost) return in_array($p['scheme'] ?? '', ['http', 'https'], true);
    return ($p['scheme'] ?? '') === 'https' && ($host === 'klipy.com' || str_ends_with($host, '.klipy.com'));
}

/**
 * Download the GIF named by slug into data/files.
 * Returns a row shaped like a stored upload (path, name, size, mime, w, h, gif).
 */
function store_gif(string $slug, array $u): array {
    if (!gifs_enabled()) fail('gifs_off', 503);
    if ($slug === '' || strlen($slug) > 160) fail('no_gif', 404);
    $row = q1('SELECT data FROM gif_items WHERE slug = ?', [$slug]);
    $g = $row ? json_decode($row['data'], true) : null;
    if (!$g) {
        $r = klipy_call('gifs/' . rawurlencode($slug));
        $it = $r['data'] ?? null;
        $g = is_array($it) ? gif_slim(isset($it['file']) ? $it : ($it['data'] ?? [])) : null;
        if (!$g) fail('no_gif', 404);
    }

    // follow at most three redirects by hand, re-checking the host each hop
    $url = $g['url'];
    $got = null;
    for ($hop = 0; $hop < 4; $hop++) {
        if (!gif_url_ok($url)) fail('no_gif', 404);
        $got = http_fetch($url, 12, GIF_MAX_BYTES);
        if (!$got) fail('gif_fetch', 502);
        if ($got[0] >= 300 && $got[0] < 400 && $got[2] !== '') { $url = $got[2]; continue; }
        break;
    }
    if (!$got || $got[0] !== 200 || $got[1] === '') fail('gif_fetch', 502);

    $rand = bin2hex(random_bytes(16));
    $rel = substr($rand, 0, 2) . '/' . $rand;
    $dir = FILES_DIR . '/' . substr($rand, 0, 2);
    if (!is_dir($dir) && !mkdir($dir, 0770, true) && !is_dir($dir)) fail('upload_failed', 500);
    if (file_put_contents(FILES_DIR . '/' . $rel, $got[1]) === false) fail('upload_failed', 500);
    $mime = media_mime((string) (new finfo(FILEINFO_MIME_TYPE))->file(FILES_DIR . '/' . $rel));
    if (!preg_match('#^(video/mp4|video/webm|image/gif|image/webp)$#', $mime)) {
        delete_files([$rel]);
        fail('gif_fetch', 502);
    }

    // tell KLIPY it was shared (feeds their ranking); never worth a failed send
    $share = klipy_base() . '/' . rawurlencode((string) cfg('klipy_key')) . '/gifs/' . rawurlencode($slug) . '/share';
    http_fetch($share, 2, 65536, 'POST', json_encode(['customer_id' => klipy_customer((int) $u['id'])]));

    $title = trim($g['title'] ?? '') ?: 'gif';
    $ext = str_contains($mime, 'mp4') ? '.mp4' : (str_contains($mime, 'webm') ? '.webm' : (str_contains($mime, 'webp') ? '.webp' : '.gif'));
    return [
        'path' => $rel, 'name' => safe_filename(mb_substr($title, 0, 80) . $ext), 'size' => strlen($got[1]), 'mime' => $mime,
        'w' => ($g['w'] ?? 0) ?: null, 'h' => ($g['h'] ?? 0) ?: null, 'gif' => 1,
    ];
}
