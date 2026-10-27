/* VoiceDen — admin dashboard (admin.html).
 *
 * Polls api.php?a=admin every 3 s for live figures and adds &full=1 every 30 s
 * for the rest. CPU % and network speed are differences between two polls, so
 * the history behind each sparkline is built up here, in the open tab.
 * Charts are hand-drawn SVG: one hue (the accent), hairline grid, a hover
 * tooltip on every mark, and a table view under each column chart.
 */
(() => {
  'use strict';
  const $ = id => document.getElementById(id);
  const SVG = 'http://www.w3.org/2000/svg';
  const LIVE_MS = 3000, FULL_MS = 30000, HIST = 60;

  // same theme choice as the app (set in its settings); "system" follows the OS live
  const sysLight = window.matchMedia('(prefers-color-scheme: light)');
  function applyTheme() {
    let t = 'system';
    try { t = localStorage.getItem('vd-theme') || 'system'; } catch (e) {}
    document.documentElement.dataset.theme = t === 'light' || (t === 'system' && sysLight.matches) ? 'light' : 'dark';
  }
  sysLight.addEventListener('change', applyTheme);
  window.addEventListener('storage', e => { if (e.key === 'vd-theme') applyTheme(); });

  // ---------- formatting (Turkish: decimal comma, % before the number) ----------
  const nf0 = new Intl.NumberFormat('tr-TR', { maximumFractionDigits: 0 });
  const nf1 = new Intl.NumberFormat('tr-TR', { maximumFractionDigits: 1 });
  const nfc = new Intl.NumberFormat('tr-TR', { notation: 'compact', maximumFractionDigits: 1 });
  const num = n => (n >= 10000 ? nfc.format(n) : nf0.format(n));
  const pct = v => '%' + nf0.format(Math.round(v));
  function bytes(b) {
    if (b == null) return '—';
    const u = ['B', 'KB', 'MB', 'GB', 'TB'];
    let v = b, i = 0;
    while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
    return (i === 0 || v >= 100 ? nf0.format(v) : nf1.format(v)) + ' ' + u[i];
  }
  const rate = bps => bytes(bps) + '/sn';
  function dur(s) {
    const d = Math.floor(s / 86400), h = Math.floor(s % 86400 / 3600), m = Math.floor(s % 3600 / 60);
    return d ? `${nf0.format(d)} gün ${h} sa` : h ? `${h} sa ${m} dk` : `${m} dk`;
  }
  const shortAge = s => (s >= 86400 ? Math.floor(s / 86400) + ' g' : s >= 3600 ? Math.floor(s / 3600) + ' sa' : Math.max(1, Math.floor(s / 60)) + ' dk');
  function ago(ms) {
    if (!ms) return '—';
    const s = (Date.now() - ms) / 1000;
    if (s < 90) return 'şimdi';
    return shortAge(s) + ' önce';
  }
  const MONTHS = ['Oca', 'Şub', 'Mar', 'Nis', 'May', 'Haz', 'Tem', 'Ağu', 'Eyl', 'Eki', 'Kas', 'Ara'];
  const DAYS = ['Paz', 'Pzt', 'Sal', 'Çar', 'Per', 'Cum', 'Cmt'];
  const dayLabel = iso => { const d = new Date(iso + 'T12:00:00'); return d.getDate() + ' ' + MONTHS[d.getMonth()] + ' ' + DAYS[d.getDay()]; };
  const dateShort = ms => { const d = new Date(ms); return d.getDate() + ' ' + MONTHS[d.getMonth()] + ' ' + d.getFullYear(); };

  // DOM built with textContent wherever a value came from the server
  function h(tag, attrs, ...kids) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v == null || v === false) continue;
      if (k === 'class') el.className = v; else el.setAttribute(k, v === true ? '' : v);
    }
    for (const k of kids.flat()) if (k != null && k !== false) el.append(k instanceof Node ? k : String(k));
    return el;
  }
  function s(tag, attrs) {
    const el = document.createElementNS(SVG, tag);
    for (const [k, v] of Object.entries(attrs || {})) el.setAttribute(k, v);
    return el;
  }

  // ---------- tooltip ----------
  const tip = $('tip');
  function showTip(x, y, value, label) {
    tip.replaceChildren(h('b', null, value), h('span', null, label));
    tip.hidden = false;
    const w = tip.offsetWidth, ht = tip.offsetHeight;
    tip.style.left = Math.max(8, Math.min(x + 14, innerWidth - w - 8)) + 'px';
    tip.style.top = (y - ht - 12 < 8 ? y + 18 : y - ht - 12) + 'px';
  }
  const hideTip = () => { tip.hidden = true; };

  // ---------- sparkline: de-emphasis line, accent end dot, crosshair on hover ----------
  function sparkline(svg, values, times, fmt) {
    svg.replaceChildren();
    svg._data = { values, times, fmt };
    const W = svg.clientWidth || 200, H = 38;
    svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
    if (values.length < 2) return;
    const max = Math.max(...values) * 1.15 || 1;
    const x = i => (i / (values.length - 1)) * (W - 6) + 1;
    const y = v => H - 3 - (v / max) * (H - 8);
    const pts = values.map((v, i) => `${x(i).toFixed(1)},${y(v).toFixed(1)}`);
    svg.append(
      s('path', { d: `M${pts[0]} L${pts.join(' L')} L${x(values.length - 1)},${H} L${x(0)},${H}Z`, fill: 'var(--text-dim)', 'fill-opacity': '.1' }),
      s('polyline', { points: pts.join(' '), fill: 'none', stroke: 'var(--text-dim)', 'stroke-width': '2', 'stroke-linejoin': 'round', 'stroke-linecap': 'round' }),
      s('circle', { cx: x(values.length - 1), cy: y(values[values.length - 1]), r: 4, fill: 'var(--teal)', stroke: 'var(--panel)', 'stroke-width': 2 }),
    );
    const cross = s('line', { y1: 0, y2: H, stroke: 'var(--line-hard)', 'stroke-width': 1, visibility: 'hidden' });
    const dot = s('circle', { r: 4, fill: 'var(--text)', stroke: 'var(--panel)', 'stroke-width': 2, visibility: 'hidden' });
    svg.append(cross, dot);
    svg._hover = (cx, cy, clientX, clientY) => {
      const i = Math.max(0, Math.min(values.length - 1, Math.round((cx - 1) / (W - 6) * (values.length - 1))));
      cross.setAttribute('x1', x(i)); cross.setAttribute('x2', x(i)); cross.setAttribute('visibility', 'visible');
      dot.setAttribute('cx', x(i)); dot.setAttribute('cy', y(values[i])); dot.setAttribute('visibility', 'visible');
      const when = times ? (typeof times[i] === 'string' ? dayLabel(times[i]) : Math.round((Date.now() - times[i]) / 1000) + ' sn önce') : '';
      showTip(clientX, clientY, fmt(values[i]), when);
    };
    svg._leave = () => { cross.setAttribute('visibility', 'hidden'); dot.setAttribute('visibility', 'hidden'); hideTip(); };
  }
  function hoverable(svg) {
    svg.addEventListener('pointermove', e => {
      if (!svg._hover) return;
      const r = svg.getBoundingClientRect();
      svg._hover((e.clientX - r.left) * (svg.viewBox.baseVal.width / r.width), e.clientY - r.top, e.clientX, e.clientY);
    });
    svg.addEventListener('pointerleave', () => svg._leave && svg._leave());
  }

  // ---------- stat tile ----------
  function tile(parent, label) {
    const value = h('div', { class: 't-value' }), sub = h('div', { class: 't-sub' });
    const spark = s('svg', { class: 'spark', role: 'img' });
    hoverable(spark);
    const el = h('div', { class: 'tile' }, h('div', { class: 't-label' }, label), value, sub);
    el.append(spark);
    parent.append(el);
    return {
      set(v, small, subText) {
        value.replaceChildren(v);
        if (small) value.append(h('small', null, small));
        sub.textContent = subText || '';
        sub.title = subText || '';
      },
      spark(values, times, fmt, aria) { spark.setAttribute('aria-label', aria || ''); sparkline(spark, values, times, fmt); },
      noSpark() { spark.remove(); },
      el,
    };
  }

  // ---------- meter ----------
  function meter(name, used, total, note, warnAt = 75, critAt = 90) {
    const p = total ? used / total * 100 : 0;
    const sev = p >= critAt ? 'crit' : p >= warnAt ? 'warn' : '';
    const fill = h('i');
    fill.style.width = Math.min(100, p).toFixed(1) + '%';
    return h('div', { class: 'meter-row' },
      h('div', { class: 'meter-top' },
        h('span', { class: 'm-name' }, name),
        note ? h('span', { class: 'm-note' }, note) : null,
        sev ? h('span', { class: 'sev ' + sev }, sev === 'crit' ? 'KRİTİK' : 'YÜKSEK') : null,
        h('span', { class: 'm-val' }, `${pct(p)} · ${bytes(used)} / ${bytes(total)}`)),
      h('div', { class: 'bar ' + sev, role: 'meter', 'aria-valuenow': Math.round(p), 'aria-valuemin': 0, 'aria-valuemax': 100, 'aria-label': name }, fill));
  }

  // ---------- horizontal magnitude bars ----------
  function hbars(parent, items, fmt) {
    const max = Math.max(...items.map(i => i.value), 1);
    parent.replaceChildren(h('div', { class: 'hbars' }, items.map(it => {
      const bar = h('span', { class: 'hb-bar' });
      bar.style.width = `calc((100% - 90px) * ${(it.value / max).toFixed(4)})`;
      const row = h('div', { class: 'hb' + (it.other ? ' other' : ''), tabindex: 0 },
        h('span', { class: 'hb-name' + (it.dim ? ' file' : ''), title: it.label }, it.label),
        h('span', { class: 'hb-track' }, bar, h('span', { class: 'hb-val' }, fmt(it.value))));
      const show = e => {
        const r = row.getBoundingClientRect();
        showTip(e && e.clientX != null ? e.clientX : r.left + 120, e && e.clientY != null ? e.clientY : r.top, fmt(it.value), it.label + (it.note ? ' · ' + it.note : ''));
      };
      row.addEventListener('pointermove', show);
      row.addEventListener('pointerleave', hideTip);
      row.addEventListener('focus', () => show(null));
      row.addEventListener('blur', hideTip);
      return row;
    })));
  }

  // ---------- column chart (one series, per-bar tooltip, table view) ----------
  function columns(parent, data, unit) {
    parent._redraw = () => columns(parent, data, unit);
    const wrap = h('div', { class: 'cols' });
    const svg = s('svg', { role: 'img', 'aria-label': unit + ', son ' + data.length + ' gün' });
    wrap.append(svg);
    parent.replaceChildren(wrap);
    const W = wrap.clientWidth || 400, H = 180, L = 30, B = 22, T = 16;
    svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
    const maxV = Math.max(...data.map(d => d.n), 0);
    const step = maxV <= 4 ? 1 : Math.pow(10, Math.floor(Math.log10(maxV))) * (maxV / Math.pow(10, Math.floor(Math.log10(maxV))) > 5 ? 2 : 1);
    const top = Math.max(step, Math.ceil(maxV / step) * step) || 1;
    const y = v => H - B - (v / top) * (H - B - T);
    const axis = s('g', { class: 'axis' });
    const ticks = top / step > 4 ? [0, top / 2, top] : Array.from({ length: top / step + 1 }, (_, i) => i * step);
    for (const t of ticks) {
      axis.append(s('line', { x1: L, x2: W, y1: y(t), y2: y(t), stroke: 'var(--grid)', 'stroke-width': 1 }));
      const tx = s('text', { x: L - 6, y: y(t) + 3, 'text-anchor': 'end' });
      tx.textContent = num(t);
      axis.append(tx);
    }
    svg.append(axis);
    const band = (W - L) / data.length, bw = Math.min(24, band * 0.62);
    const maxI = data.reduce((m, d, i) => (d.n > data[m].n ? i : m), 0);
    const every = band < 26 ? 2 : 1;
    data.forEach((d, i) => {
      const cx = L + band * i + band / 2, x0 = cx - bw / 2;
      const g = s('g', { class: 'c', tabindex: 0, 'aria-label': `${dayLabel(d.d)}: ${d.n} ${unit}` });
      if (d.n > 0) {
        const hgt = H - B - y(d.n), r = Math.min(4, hgt);
        // 4px rounded data end, square at the baseline
        g.append(s('path', { class: 'col', d: `M${x0},${H - B} V${y(d.n) + r} Q${x0},${y(d.n)} ${x0 + r},${y(d.n)} H${x0 + bw - r} Q${x0 + bw},${y(d.n)} ${x0 + bw},${y(d.n) + r} V${H - B} Z`, fill: 'var(--teal)' }));
      } else {
        g.append(s('rect', { class: 'col zero', x: x0, y: H - B - 1, width: bw, height: 1 }));
      }
      if (d.n > 0 && (i === maxI || i === data.length - 1)) {
        const lb = s('text', { class: 'lbl', x: cx, y: y(d.n) - 5, 'text-anchor': 'middle' });
        lb.textContent = num(d.n);
        g.append(lb);
      }
      if (i % every === (data.length - 1) % every) {
        const xl = s('text', { x: cx, y: H - 6, 'text-anchor': 'middle', class: 'axis-x' });
        xl.textContent = new Date(d.d + 'T12:00:00').getDate();
        xl.setAttribute('font-family', 'JetBrains Mono, monospace');
        xl.setAttribute('font-size', '10');
        xl.setAttribute('fill', 'var(--text-faint)');
        g.append(xl);
      }
      const hit = s('rect', { class: 'hit', x: L + band * i, y: T - 8, width: band, height: H - B - T + 8 });
      g.append(hit);
      const show = e => {
        const r = g.getBoundingClientRect();
        showTip(e ? e.clientX : r.left + r.width / 2, e ? e.clientY : r.top, num(d.n) + ' ' + unit, dayLabel(d.d));
      };
      g.addEventListener('pointermove', show);
      g.addEventListener('pointerleave', hideTip);
      g.addEventListener('focus', () => show(null));
      g.addEventListener('blur', hideTip);
      svg.append(g);
    });
    const table = h('table', { class: 'tbl' },
      h('thead', null, h('tr', null, h('th', null, 'Gün'), h('th', { class: 'num' }, unit))),
      h('tbody', null, data.slice().reverse().map(d => h('tr', null, h('td', null, dayLabel(d.d)), h('td', { class: 'num' }, num(d.n))))));
    parent.append(h('details', { class: 'tview' }, h('summary', null, 'Tablo olarak göster'), table));
  }

  function table(el, head, rows) {
    el.replaceChildren(
      h('thead', null, h('tr', null, head.map(c => h('th', { class: c.num ? 'num' : null }, c.t)))),
      h('tbody', null, rows));
  }

  // ---------- data ----------
  const hist = { cpu: [], rx: [], tx: [], mem: [], t: [] };
  let prev = null, lastFull = 0, cores = 1;
  const T = {};

  function buildTiles() {
    const ht = $('hostTiles'), vt = $('vdTiles');
    T.cpu = tile(ht, 'İşlemci');
    T.load = tile(ht, 'Yük ortalaması');
    T.mem = tile(ht, 'Bellek');
    T.rx = tile(ht, 'Gelen trafik');
    T.tx = tile(ht, 'Giden trafik');
    T.load.noSpark();
    T.users = tile(vt, 'Kullanıcılar');
    T.online = tile(vt, 'Şu an çevrimiçi');
    T.dens = tile(vt, 'Denler');
    T.msgs = tile(vt, 'Mesajlar');
    T.voice = tile(vt, 'Şu an seste');
    T.store = tile(vt, 'Depolama');
    for (const k of ['online', 'dens', 'voice', 'store']) T[k].noSpark();
  }

  function applyLive(l) {
    if (prev && l.ts > prev.ts) {
      const dt = (l.ts - prev.ts) / 1000;
      const dTot = l.cpu.total - prev.cpu.total, dIdle = l.cpu.idle - prev.cpu.idle;
      const push = (k, v) => { hist[k].push(v); if (hist[k].length > HIST) hist[k].shift(); };
      if (dTot > 0) push('cpu', Math.max(0, Math.min(100, 100 * (1 - dIdle / dTot))));
      push('rx', Math.max(0, (l.net.rx - prev.net.rx) / dt));
      push('tx', Math.max(0, (l.net.tx - prev.net.tx) / dt));
      push('mem', l.mem.total ? (l.mem.total - l.mem.avail) / l.mem.total * 100 : 0);
      push('t', l.ts);
    }
    prev = l;
    const last = a => (a.length ? a[a.length - 1] : null);
    const c = last(hist.cpu);
    T.cpu.set(c == null ? '…' : pct(c), null, `${cores} çekirdek · ${num(l.procs.count)} işlem`);
    T.cpu.spark(hist.cpu, hist.t, v => pct(v), 'İşlemci kullanımı, son ' + hist.cpu.length + ' ölçüm');
    T.load.set(nf1.format(l.load[0]), null, `5 dk ${nf1.format(l.load[1])} · 15 dk ${nf1.format(l.load[2])} · ${cores} çekirdeğe göre ${pct(l.load[0] / cores * 100)}`);
    const used = l.mem.total - l.mem.avail;
    T.mem.set(bytes(used), '/ ' + bytes(l.mem.total), `${pct(used / l.mem.total * 100)} dolu · takas ${bytes(l.mem.swapTotal - l.mem.swapFree)}`);
    T.mem.spark(hist.mem, hist.t, v => pct(v), 'Bellek doluluğu');
    const rx = last(hist.rx), tx = last(hist.tx);
    T.rx.set(rx == null ? '…' : rate(rx), null, `${l.net.iface || '—'} · toplam ${bytes(l.net.rx)}`);
    T.rx.spark(hist.rx, hist.t, rate, 'Gelen ağ trafiği');
    T.tx.set(tx == null ? '…' : rate(tx), null, `${l.net.iface || '—'} · toplam ${bytes(l.net.tx)}`);
    T.tx.spark(hist.tx, hist.t, rate, 'Giden ağ trafiği');

    $('procCount').textContent = `toplam ${num(l.procs.count)} işlem · %CPU, işlemin ömrü boyunca ortalama`;
    table($('procs'), [{ t: 'PID', num: 1 }, { t: 'Kullanıcı' }, { t: 'CPU', num: 1 }, { t: 'Bellek', num: 1 }, { t: 'Süre', num: 1 }, { t: 'Komut' }, { t: '' }],
      l.procs.top.map(p => {
        // a process pinned near 100 % for over a day is almost always stuck
        const stuck = p.cpu >= 90 && p.age > 86400;
        return h('tr', { class: stuck ? 'hot' : null },
          h('td', { class: 'num' }, p.pid), h('td', { class: 'dim' }, p.user), h('td', { class: 'num' }, pct(p.cpu)),
          h('td', { class: 'num' }, bytes(p.rss)), h('td', { class: 'num' }, shortAge(p.age)), h('td', { class: 'mono cmd', title: p.cmd }, p.cmd),
          h('td', null, stuck ? h('span', { class: 'sev warn' }, 'TAKILI OLABİLİR') : null));
      }));
  }

  function renderFull(d) {
    const ho = d.host, db = d.db, v = d.vd;
    cores = ho.cores || 1;
    $('hostLine').textContent = [ho.host, ho.os, 'çekirdek ' + ho.kernel, ho.cpu, cores + ' çekirdek', 'açık ' + dur(ho.uptime), 'PHP ' + ho.php].filter(Boolean).join(' · ');

    $('disks').replaceChildren(...ho.disks.map(k => meter(k.mount, k.total - k.free, k.total, k.dev + ' · ' + k.fs)));

    const kv = [['Sürüm', db.version.replace(/-MariaDB.*/, '')], ['Açık kalma', dur(db.uptime)], ['Bağlantı (şimdi)', num(db.threads)],
      ['En yüksek bağlantı', num(db.maxUsed)], ['Sorgu (toplam)', num(db.queries)], ['Yavaş sorgu', num(db.slow)], ['Veritabanı sayısı', num(db.schemas)]];
    $('db').replaceChildren(...kv.flatMap(([k, val]) => [h('dt', null, k), h('dd', null, val)]));

    // big folders individually, the long tail folded into "Diğer"
    const items = ho.sites.items, topN = items.slice(0, 12), rest = items.slice(12);
    const rows = topN.map(i => ({ label: i.name + (i.dir ? '' : ''), value: i.bytes, dim: !i.dir, note: i.dir ? 'klasör' : 'dosya' }));
    if (rest.length) rows.push({ label: `Diğer (${rest.length})`, value: rest.reduce((n, i) => n + i.bytes, 0), other: true, note: rest.length + ' öğe' });
    hbars($('sites'), rows, bytes);
    $('sitesSub').textContent = `toplam ${bytes(ho.sites.total)} · ${ago(ho.sites.at * 1000)} ölçüldü`;

    $('vdLine').textContent = `veritabanı ${bytes(v.disk.db)} · ${num(v.sessions)} açık oturum · KLIPY önbelleğinde ${num(v.gifCache)} GIF`;
    const pdU = v.perDay.users, pdM = v.perDay.msgs;
    T.users.set(num(v.users), null, `bu hafta +${num(v.users7)} yeni`);
    T.users.spark(pdU.map(x => x.n), pdU.map(x => x.d), n => num(n) + ' yeni hesap', 'Günlük yeni hesaplar');
    T.online.set(num(v.online), null, `son 24 saatte ${num(v.active1)} · 7 günde ${num(v.active7)} aktif`);
    T.dens.set(num(v.denCount), null, `${num(v.text)} metin · ${num(v.voiceCh)} ses kanalı`);
    T.msgs.set(num(v.msgs), null, `son 24 saatte +${num(v.msgs1)}`);
    T.msgs.spark(pdM.map(x => x.n), pdM.map(x => x.d), n => num(n) + ' mesaj', 'Günlük mesajlar');
    T.voice.set(num(v.voice.length), null, v.voice.length ? [...new Set(v.voice.map(x => x.den))].length + ' dende' : 'kimse yok');
    const stored = v.disk.files.bytes + v.disk.avatars.bytes;
    T.store.set(bytes(stored), null, `${num(v.disk.files.files)} dosya · ${num(v.disk.avatars.files)} fotoğraf`);

    columns($('chMsgs'), pdM, 'mesaj');
    columns($('chUsers'), pdU, 'hesap');

    $('voiceSub').textContent = v.voice.length ? v.voice.length + ' kişi' : '';
    $('voiceNow').replaceChildren(...(v.voice.length ? v.voice.map(x => h('div', { class: 'vrow' },
      h('b', null, x.user), h('span', { class: 'h-sub' }, '@' + x.username),
      h('span', { class: 'flags' }, [x.muted && 'sessiz', x.deaf && 'sesi kapalı', x.sharing && 'ekran paylaşıyor'].filter(Boolean).join(' · ')),
      h('span', { class: 'where' }, x.den + ' › ' + x.channel))) : [h('div', { class: 'empty' }, 'Şu an hiçbir ses kanalında kimse yok.')]));

    hbars($('storage'), [
      { label: 'Dosya ekleri', value: v.attBytes, note: num(v.atts) + ' dosya' },
      { label: 'GIF’ler', value: v.gifBytes, note: num(v.gifs) + ' GIF' },
      { label: 'Fotoğraflar', value: v.disk.avatars.bytes, note: num(v.photos) + ' profil / den' },
      { label: 'Veritabanı', value: v.disk.db, note: 'MariaDB tabloları' },
    ], bytes);

    table($('densT'), [{ t: 'Den' }, { t: 'Sahip' }, { t: 'Üye', num: 1 }, { t: 'Kanal', num: 1 }, { t: 'Mesaj', num: 1 }, { t: 'Son 7 gün', num: 1 }, { t: 'Kuruldu', num: 1 }],
      v.dens.length ? v.dens.map(x => h('tr', null, h('td', null, x.name), h('td', { class: 'dim' }, '@' + x.owner), h('td', { class: 'num' }, num(x.members)),
        h('td', { class: 'num' }, num(x.channels)), h('td', { class: 'num' }, num(x.msgs)), h('td', { class: 'num' }, num(x.msgs7)), h('td', { class: 'num' }, dateShort(x.created))))
        : [h('tr', null, h('td', { colspan: 7, class: 'dim' }, 'Henüz den yok.'))]);

    table($('recentT'), [{ t: 'Ad' }, { t: 'Kullanıcı adı' }, { t: 'Kayıt', num: 1 }, { t: 'Son görülme', num: 1 }, { t: 'Den', num: 1 }],
      v.recent.map(x => h('tr', null, h('td', null, x.name), h('td', { class: 'dim' }, '@' + x.username), h('td', { class: 'num' }, dateShort(x.created)),
        h('td', { class: 'num' }, ago(x.seen)), h('td', { class: 'num' }, num(x.dens)))));
  }

  // ---------- loop ----------
  function setLive(ok) {
    $('live').classList.toggle('stale', !ok);
    $('liveTxt').textContent = ok ? 'canlı · ' + LIVE_MS / 1000 + ' sn' : 'bağlantı yok — yeniden deneniyor';
  }
  async function get(full) {
    const r = await fetch('api.php?a=admin' + (full ? '&full=1' : ''), { credentials: 'same-origin', cache: 'no-store' });
    if (r.status === 401) { location.href = './'; throw new Error('auth'); }
    if (r.status === 403) { $('boot').hidden = true; $('deny').hidden = false; throw new Error('deny'); }
    if (!r.ok) throw new Error('http ' + r.status);
    return r.json();
  }
  let timer = 0;
  async function tick() {
    clearTimeout(timer);
    const full = Date.now() - lastFull > FULL_MS;
    try {
      const d = await get(full);
      if (full) {
        if (!T.cpu) { buildTiles(); $('boot').hidden = true; $('adm').hidden = false; }
        lastFull = Date.now();
        renderFull(d);
      }
      applyLive(d.live);
      setLive(true);
    } catch (e) {
      if (e.message === 'deny' || e.message === 'auth') return;
      if (T.cpu) setLive(false);
    }
    timer = setTimeout(tick, document.hidden ? 15000 : LIVE_MS);
  }
  document.addEventListener('visibilitychange', () => { if (!document.hidden) tick(); });
  let rz = 0;
  window.addEventListener('resize', () => {
    clearTimeout(rz);
    rz = setTimeout(() => {
      for (const id of ['chMsgs', 'chUsers']) if ($(id)._redraw) $(id)._redraw();
      document.querySelectorAll('svg.spark').forEach(sv => { if (sv._data) sparkline(sv, sv._data.values, sv._data.times, sv._data.fmt); });
    }, 150);
  });
  tick();
})();
