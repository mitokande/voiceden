<?php
/**
 * VoiceDen — link preview resolver.
 *
 * GET og.php?url=<encoded url>  ->  {ok, url, host, title, description, image, site}
 *
 * Browsers cannot read another origin's <head>, so the chat asks this endpoint
 * instead. Because it fetches whatever URL it is handed, everything below is
 * built around not letting a pasted link reach anything on the local network.
 */

header('Content-Type: application/json; charset=utf-8');
header('X-Content-Type-Options: nosniff');
header('Referrer-Policy: no-referrer');

const UA          = 'Mozilla/5.0 (compatible; VoiceDenBot/1.0; +https://mithatck.com/voiceden)';
const MAX_BYTES   = 262144;   // only the <head> matters; stop well before a big page
const TIMEOUT     = 6;
const MAX_HOPS    = 3;
const CACHE_TTL   = 86400;
const CACHE_DIR   = __DIR__ . '/.og-cache';

function out(array $data, int $code = 200): never {
    http_response_code($code);
    echo json_encode($data, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE);
    exit;
}
function fail(string $why): never { out(['ok' => false, 'error' => $why]); }

/* ---------- SSRF guards ---------- */

/** Reject anything that is not a public, routable unicast address. */
function ip_is_public(string $ip): bool {
    return (bool) filter_var(
        $ip,
        FILTER_VALIDATE_IP,
        FILTER_FLAG_NO_PRIV_RANGE | FILTER_FLAG_NO_RES_RANGE
    );
}

/**
 * Validate a URL and resolve it to a single vetted IP.
 * Returns [normalised url, host, ip] or null.
 */
function vet_url(string $url): ?array {
    $p = parse_url($url);
    if (!$p || empty($p['host']) || empty($p['scheme'])) return null;

    $scheme = strtolower($p['scheme']);
    if ($scheme !== 'http' && $scheme !== 'https') return null;

    // No credentials in the URL, and only the default ports.
    if (isset($p['user']) || isset($p['pass'])) return null;
    $port = $p['port'] ?? ($scheme === 'https' ? 443 : 80);
    if ($port !== 80 && $port !== 443) return null;

    $host = strtolower($p['host']);
    $host = trim($host, '[]');                       // bare IPv6 literal

    // A literal IP must itself be public.
    if (filter_var($host, FILTER_VALIDATE_IP)) {
        return ip_is_public($host) ? [$url, $host, $host] : null;
    }

    // Otherwise resolve, and require every answer to be public so we cannot be
    // steered at the LAN by a host with one good and one bad record.
    $ips = [];
    foreach (['A', 'AAAA'] as $type) {
        $recs = @dns_get_record($host, $type === 'A' ? DNS_A : DNS_AAAA);
        foreach ($recs ?: [] as $r) {
            $ip = $r['ip'] ?? ($r['ipv6'] ?? null);
            if ($ip) $ips[] = $ip;
        }
    }
    if (!$ips) return null;
    foreach ($ips as $ip) if (!ip_is_public($ip)) return null;

    return [$url, $host, $ips[0]];
}

/* ---------- fetching ---------- */

/**
 * Fetch a page, following redirects by hand so each hop is re-vetted.
 * The resolved IP is pinned per hop, which closes the DNS-rebinding window
 * between our check and curl's own lookup.
 */
function fetch_head(string $url): ?array {
    for ($hop = 0; $hop <= MAX_HOPS; $hop++) {
        $vet = vet_url($url);
        if (!$vet) return null;
        [$url, $host, $ip] = $vet;

        $port = str_starts_with(strtolower($url), 'https:') ? 443 : 80;

        $ch = curl_init($url);
        curl_setopt_array($ch, [
            CURLOPT_RETURNTRANSFER => true,
            CURLOPT_FOLLOWLOCATION => false,          // we follow manually
            CURLOPT_HEADER         => true,
            CURLOPT_TIMEOUT        => TIMEOUT,
            CURLOPT_CONNECTTIMEOUT => 4,
            CURLOPT_USERAGENT      => UA,
            CURLOPT_ENCODING       => '',
            CURLOPT_PROTOCOLS      => CURLPROTO_HTTP | CURLPROTO_HTTPS,
            CURLOPT_RESOLVE        => ["$host:$port:$ip"],
            CURLOPT_HTTPHEADER     => ['Accept: text/html,application/xhtml+xml'],
            // Stop reading once we have enough to cover <head>.
            CURLOPT_BUFFERSIZE     => 16384,
            CURLOPT_NOPROGRESS     => false,
            CURLOPT_PROGRESSFUNCTION => fn($r, $dlTotal, $dlNow) => $dlNow > MAX_BYTES ? 1 : 0,
        ]);
        $raw    = curl_exec($ch);
        $code   = curl_getinfo($ch, CURLINFO_RESPONSE_CODE);
        $hdrLen = curl_getinfo($ch, CURLINFO_HEADER_SIZE);
        $ctype  = (string) curl_getinfo($ch, CURLINFO_CONTENT_TYPE);
        $errno  = curl_errno($ch);
        curl_close($ch);

        // CURLE_ABORTED_BY_CALLBACK just means we hit our own size cap.
        if ($raw === false && $errno !== CURLE_ABORTED_BY_CALLBACK) return null;
        if ($raw === false) return null;

        $headers = substr($raw, 0, $hdrLen);
        $body    = substr($raw, $hdrLen);

        if ($code >= 300 && $code < 400) {
            if (!preg_match('/^location:\s*(.+)$/mi', $headers, $m)) return null;
            $next = trim($m[1]);
            // Resolve a relative Location against the current URL.
            if (!preg_match('#^https?://#i', $next)) {
                $base = parse_url($url);
                $next = $base['scheme'] . '://' . $base['host']
                      . (str_starts_with($next, '/') ? '' : '/') . ltrim($next, '/');
            }
            $url = $next;
            continue;
        }
        if ($code < 200 || $code >= 400) return null;

        return [$body, $url, strtolower(trim(explode(';', $ctype)[0]))];
    }
    return null;
}

/* ---------- parsing ---------- */

function meta_tags(string $html): array {
    $tags = [];
    // Look at <head> only; some pages carry junk og: strings in body text.
    if (preg_match('#<head\b[^>]*>(.*?)</head>#is', $html, $m)) $html = $m[1];

    if (preg_match_all('#<meta\b[^>]*>#i', $html, $ms)) {
        foreach ($ms[0] as $tag) {
            if (!preg_match('#\b(?:property|name)\s*=\s*["\']?([^"\'\s>]+)#i', $tag, $k)) continue;
            if (!preg_match('#\bcontent\s*=\s*(?:"([^"]*)"|\'([^\']*)\'|([^\s>]+))#i', $tag, $v)) continue;
            $key = strtolower($k[1]);
            $val = ($v[1] ?? '') !== '' ? $v[1]
                 : (($v[2] ?? '') !== '' ? $v[2] : ($v[3] ?? ''));
            if (!isset($tags[$key]) && $val !== '') $tags[$key] = $val;
        }
    }
    if (preg_match('#<title\b[^>]*>(.*?)</title>#is', $html, $t)) {
        $tags['__title'] = $t[1];
    }
    return $tags;
}

function clean(?string $s, int $len): string {
    if ($s === null) return '';
    $s = html_entity_decode($s, ENT_QUOTES | ENT_HTML5, 'UTF-8');
    $s = trim(preg_replace('/\s+/u', ' ', $s));
    return mb_substr($s, 0, $len);
}

function abs_url(string $maybe, string $base): string {
    if ($maybe === '' || preg_match('#^https?://#i', $maybe)) return $maybe;
    $b = parse_url($base);
    if (!$b || empty($b['host'])) return '';
    if (str_starts_with($maybe, '//'))  return ($b['scheme'] ?? 'https') . ':' . $maybe;
    if (str_starts_with($maybe, '/'))   return $b['scheme'] . '://' . $b['host'] . $maybe;
    $dir = isset($b['path']) ? preg_replace('#/[^/]*$#', '/', $b['path']) : '/';
    return $b['scheme'] . '://' . $b['host'] . $dir . $maybe;
}

/* ---------- cache ---------- */

function cache_path(string $url): string {
    return CACHE_DIR . '/' . sha1($url) . '.json';
}
function cache_get(string $url): ?array {
    $f = cache_path($url);
    if (!is_file($f) || (time() - filemtime($f)) > CACHE_TTL) return null;
    $d = json_decode((string) @file_get_contents($f), true);
    return is_array($d) ? $d : null;
}
function cache_put(string $url, array $data): void {
    if (!is_dir(CACHE_DIR)) @mkdir(CACHE_DIR, 0775, true);
    if (!is_dir(CACHE_DIR)) return;
    // Occasionally sweep so the cache cannot grow without bound.
    if (random_int(1, 50) === 1) {
        foreach (glob(CACHE_DIR . '/*.json') ?: [] as $old) {
            if ((time() - filemtime($old)) > CACHE_TTL * 7) @unlink($old);
        }
    }
    @file_put_contents(cache_path($url), json_encode($data), LOCK_EX);
}

/* ---------- main ---------- */

$url = (string) ($_GET['url'] ?? '');
if ($url === '' || strlen($url) > 2048) fail('bad-url');
if (!vet_url($url))                     fail('blocked');

if ($hit = cache_get($url)) { header('X-Cache: hit'); out($hit); }

if (!function_exists('curl_init')) fail('no-curl');

$got = fetch_head($url);
if (!$got) { $miss = ['ok' => false, 'error' => 'unreachable']; cache_put($url, $miss); out($miss); }
[$html, $finalUrl, $ctype] = $got;

$host = preg_replace('#^www\.#', '', (string) parse_url($finalUrl, PHP_URL_HOST));

// A link straight to an image previews as that image.
if (str_starts_with($ctype, 'image/') && str_starts_with(strtolower($finalUrl), 'https://')) {
    $res = ['ok' => true, 'url' => $finalUrl, 'host' => $host, 'title' => '',
            'description' => '', 'image' => $finalUrl, 'site' => '', 'kind' => 'image'];
    cache_put($url, $res);
    out($res);
}
if ($ctype !== '' && !preg_match('#text/html|application/xhtml#i', $ctype)) {
    $miss = ['ok' => false, 'error' => 'not-a-page'];
    cache_put($url, $miss);
    out($miss);
}

$t     = meta_tags($html);
$title = clean($t['og:title'] ?? $t['twitter:title'] ?? $t['__title'] ?? '', 140);
$desc  = clean($t['og:description'] ?? $t['twitter:description'] ?? $t['description'] ?? '', 220);
$img   = clean($t['og:image:secure_url'] ?? $t['og:image'] ?? $t['twitter:image'] ?? '', 1000);
$site  = clean($t['og:site_name'] ?? '', 60);
$img   = abs_url($img, $finalUrl);

// Only hand back an image the browser can actually load over https, and one
// that passes the same host checks as the page itself.
if ($img !== '' && (!str_starts_with(strtolower($img), 'https://') || !vet_url($img))) $img = '';

if ($title === '' && $desc === '' && $img === '') {
    $miss = ['ok' => false, 'error' => 'no-metadata'];
    cache_put($url, $miss);
    out($miss);
}

$res = [
    'ok'          => true,
    'url'         => $finalUrl,
    'host'        => $host,
    'title'       => $title,
    'description' => $desc,
    'image'       => $img,
    'site'        => $site,
];
cache_put($url, $res);
out($res);
