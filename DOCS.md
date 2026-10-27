# VoiceDen

Account-based voice + text chat for small friend groups, Discord-shaped:
**den** (server) → **text channels** and **voice channels**, persistent messages
and files, invite links. Served at https://mithatck.com/voiceden/.

The old account-free single-file room still lives at `classic.html`; any
`?r=<room>` link to `index.html` is redirected there.

## Files

| Path | What |
|---|---|
| `index.html` | markup only (auth screen, app shell, voice stage, dock, audio panel, SVG icon sprite) |
| `app.css` | all styles; same tokens as the classic room (warm near-black, teal, Space Grotesk + JetBrains Mono) |
| `js/app.js` | the app: auth, boot/poll, navigation, sidebar, messages, composer, modals |
| `js/voice.js` | voice engine (`VD.voice`): mesh, audio graph, gate, RNNoise, PTT, screen share, audio panel |
| `js/gate-worklet.js` | voice gate as an AudioWorklet (keeps gating in a background tab) |
| `rnnoise-worklet.js` | RNNoise denoiser worklet (~1.9 MB, loaded only when "Gelişmiş" is picked) |
| `api.php` | JSON API, `api.php?a=<action>` |
| `server/lib.php` | DB, sessions, permissions, wire formats |
| `server/gifs.php` | GIF search through KLIPY (`gifs` endpoint, `store_gif` for sending) |
| `server/schema.sql` | idempotent schema (re-runnable) |
| `server/config.php` | DB credentials and `klipy_key` — **gitignored**; copy `config.example.php` |
| `data/files/` | uploaded attachments, random names, no extensions — **gitignored**, `.htaccess`-denied |
| `og.php` | link-preview resolver (unchanged from classic; SSRF-hardened) |
| `.htaccess` | raises PHP upload limits to 26M/27M (LiteSpeed honours `php_value`; `.user.ini` did not work) |

Cache-busting: bump the `?v=` on the three includes in `index.html` after editing CSS/JS.

## Data model (MariaDB 10.6, db/user `voiceden`)

`users` · `sessions` (sha256 of a random cookie token, 90-day sliding) ·
`servers` (has `invite_code` and a `rev`) · `members` (role owner/admin/member) ·
`channels` (kind text/voice, denormalised `last_msg_id`) · `messages` ·
`attachments` · `channel_reads` (unread state) · `voice_states` (one row per
account = one live voice connection) · `typing` · `throttle`.

Two sequences: `msg_rev` (every message insert/edit/delete takes the next value)
and `voice_seq` (join order in voice).

## Realtime = polling

The PHP-FPM/LSAPI pool is ~10 workers, so nothing holds a request open (no
long-poll, no SSE, no websockets — same constraint as StreamPiano).

- `GET boot` returns the whole structure: dens, channels (with `last`/`read`),
  members, users, voice seats, online ids, and the current message cursor.
- `POST poll` every 1.5 s (in voice) / 2 s (visible) / 15 s (hidden, not in voice).
  In: `{since, ch, typing, voice}`. Out: messages with `rev > since - 20`
  (the overlap catches a rev committed out of order; the client skips anything
  it already has at that rev), the server revs, voice seats, online ids,
  typists in `ch`, authors of the returned messages.
- **A changed server `rev` means "refetch boot".** Profile edits, joins, kicks,
  channel create/rename/delete and invite resets all just bump the rev.
- Sending a message also broadcasts a P2P `nudge` to everyone in my voice
  channel, so people on the call fetch it immediately (~100 ms instead of ~2 s).

## Voice

Full WebRTC mesh over PeerJS 1.5.2 (cloud broker 0.peerjs.com, default ICE incl.
PeerJS's free TURN). Unlike the classic room, **the roster comes from the
server**: `voice_join {ch, peer}` claims a seat and returns everyone there.

- **Dialing rule:** of any pair, the later joiner (higher `seq`) dials. Both
  sides read the same seqs, so a pair never double-calls, and a dropped link is
  re-dialed by the same side on the next roster (`REDIAL_MS` 6 s). This replaced
  the host/beacon migration, so the classic room's split/ghost-host bugs are gone.
- An inbound peer that is not on my roster triggers an immediate poll and is
  dropped after 10 s if the server never vouches for it. Names always come from
  the server roster, never from what a peer claims.
- One voice connection per account: joining from a second tab moves the seat;
  the first tab's heartbeat gets `voice_status: 'moved'` and disconnects.
  `'gone'` (seat expired after a long freeze) re-claims silently.
- Heartbeat = the poll's `voice` field. Seats with no heartbeat for 25 s are
  ignored, and rows older than 2 min are swept. `pagehide` sends a
  `sendBeacon` to `voice_leave` (the one POST allowed without the CSRF header).
- Audio graph is the classic one: mic → source → [RNNoise] → analyser → **gate** →
  MediaStreamDestination (`sendStream`, never renegotiated). The gate is now an
  AudioWorklet (`vd-gate`), so it keeps working when the tab is in the
  background (classic bug 1). Without AudioWorklet it falls back to a GainNode
  driven from the rAF loop. `VD.voice.gateKind` says which one is live.
- A saved "Gelişmiş" (RNNoise) choice is now applied on join (classic bug 2).
- Deafen also mutes the mic (Discord behaviour); undeafen gives the mic back
  only if deafen took it.
- Screen share: separate PeerJS call tagged `metadata.kind: 'screen'`; sharing
  is also reported to the server so the sidebar shows a CANLI badge.

## GIFs (KLIPY)

Tenor's API shut down on 2026-06-30, so GIF search uses KLIPY
(`https://api.klipy.com/api/v1/{key}/gifs/trending|search`). The key goes in
`server/config.php` as `klipy_key` (free test keys at partner.klipy.com, 100
calls/min). With an empty key the GIF button opens and says search is not set up yet.

- The browser only calls `api.php?a=gifs&q=&page=`. Pages are cached in
  `gif_pages` (trending 15 min, searches 6 h) and only misses count toward the
  per-user brake (40/min). KLIPY gets a hashed `customer_id`, never our user id.
- Every GIF a search shows is remembered in `gif_items` with the URL to
  download. Sending posts only `{gif: slug}`; the server takes the URL from
  that table (or KLIPY's item endpoint), so the client never names what the
  server downloads. Media must be https on `klipy.com` / `*.klipy.com` (or the
  configured API host), redirects are followed by hand with the host
  re-checked, 8 MB cap, and the bytes must sniff as mp4/webm/gif/webp.
- The mp4 is stored in `data/files` as an attachment with `gif = 1`, then a
  share is registered with KLIPY (best effort). Chat renders it as a silent
  looping `<video>` that only plays while on screen (IntersectionObserver);
  with reduced motion it gets controls instead. Old GIFs therefore keep working
  if KLIPY ever goes the way of Tenor.
- Ad items in KLIPY results (`type: "ad"`) are dropped. Thumbnails in the
  picker load straight from KLIPY's CDN; attribution is the "KLIPY'de ara"
  placeholder and a "Powered by KLIPY" footer.
- Testing without a real key: set `'klipy_key' => 'TESTKEY'` and
  `'klipy_base' => 'http://127.0.0.1:8787/api/v1'` and run a small mock that
  serves `gifs/trending`, `gifs/search` and the media files (the media host may
  equal the API host). Remove both lines afterwards.

## Security notes

- Every POST needs `X-VoiceDen: 1` (CSRF), cookie is HttpOnly/Secure/SameSite=Lax, path `/voiceden/`.
- Passwords: `password_hash` (bcrypt), min 8 chars. Login throttle 12/IP and
  8/username per 15 min; register 20/IP per hour; messages 10 per 10 s per user.
- Uploads: ≤10 files, ≤25 MB per message. MIME is sniffed server-side; only
  image/audio/video is ever served inline (SVG counts as not-media), everything
  else is `application/octet-stream` + `attachment`. File responses carry
  `nosniff` and a `sandbox` CSP. Range requests are supported (Safari video).
- All client templates go through `esc()`, which escapes quotes too.

## Testing

Playwright E2E against the live site (two browser contexts = two people):
`/tmp/pw/node_modules/playwright`, `executablePath:
/root/.cache/ms-playwright/chromium-1243/chrome-linux64/chrome`, flags
`--use-fake-ui-for-media-stream --use-fake-device-for-media-stream
--disable-features=WebRtcHideLocalIpsWithMdns`; add
`--auto-select-desktop-capture-source="Entire screen"` to test screen share.
Use `zz_`-prefixed usernames and delete them afterwards (servers first — the
owner FK has no cascade — then users, then their files under `data/files/`).
Test sign-ups count against the register throttle (20 per IP per hour): if a run hits `slow_down`, `DELETE FROM throttle`.

## Roadmap (not built yet)

0. ~~GIF search~~ — done (KLIPY), waiting for the user's API key.
1. **DMs + friends** — a "home" entry on the rail; DM = a server-less channel with two members.
2. **@mentions + notifications** — mention parsing, red badge counts, desktop
   notifications / sound when the tab is hidden.
3. **Replies and reactions** on messages.
4. **Avatars** (image upload, resized server-side) and a short status line.
5. **Channel order / categories** (drag to reorder), finer roles (who may create channels, kick, delete messages).
6. **Per-person volume** in voice, and a **TURN server** of our own (coturn on 443) for strict NATs.
7. **Search** in a den's messages (MariaDB FULLTEXT).
8. Storage quota per den and a cleanup job for orphaned files.
