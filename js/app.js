/* VoiceDen — the app: accounts, dens (servers), channels, persistent messages.
 *
 * State lives in S and is filled by api.php: `boot` draws everything once, then
 * `poll` every ~2 s brings changed messages, voice seats, presence and typing.
 * A changed server rev in a poll means "something structural moved" (a channel,
 * a member, a name) and triggers a fresh boot rather than a dozen event types.
 * Voice is js/voice.js; this file only tells it where to go.
 */
(() => {
  'use strict';
  const VD = window.VD;
  const $ = id => document.getElementById(id);

  // ---------- helpers ----------
  // escapes quotes too, so it is safe inside attributes as well as text
  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  const initials = n => String(n || '').trim().split(/\s+/).slice(0, 2)
    .map(w => Array.from(w)[0] || '').join('').toLocaleUpperCase('tr') || '?';
  const icon = id => `<svg class="i"><use href="#i-${id}"/></svg>`;
  const fmtSize = b => b < 1024 ? b + ' B' : b < 1048576 ? (b / 1024).toFixed(1) + ' KB' : (b / 1048576).toFixed(1) + ' MB';
  function pref(key, fallback) {
    try { const v = localStorage.getItem(key); return v === null ? fallback : v; } catch (e) { return fallback; }
  }
  function setPref(key, val) { try { localStorage.setItem(key, val); } catch (e) {} }
  const touch = window.matchMedia('(pointer:coarse)').matches;
  const narrow = () => window.matchMedia('(max-width:760px)').matches;

  // a person's colour is theirs (chosen in settings), so card, avatar and name agree
  const TINTS = [
    { bg: '#2a5f5a', fg: '#bff3ec' }, { bg: '#3b3a48', fg: '#d9d6ef' },
    { bg: '#5a3f2a', fg: '#f3d9bf' }, { bg: '#2f4a63', fg: '#cfe2f5' },
    { bg: '#5a2f3f', fg: '#f5cfdc' }, { bg: '#3a5a2f', fg: '#d9f2cc' },
    { bg: '#4a2f5a', fg: '#e6cff5' }, { bg: '#55502a', fg: '#f1ecbf' },
  ];
  const tintOf = uid => { const u = S.users.get(uid); return TINTS[u ? (u.tint % TINTS.length) : 1]; };
  const svTint = sid => TINTS[(sid * 5 + 3) % TINTS.length];
  const nameOf = uid => { const u = S.users.get(uid); return u ? u.name : 'Biri'; };
  const avHtml = (uid, cls = '', pres) => {
    const t = tintOf(uid);
    return `<span class="av ${cls}" style="--av-bg:${t.bg};--av-fg:${t.fg}">${esc(initials(nameOf(uid)))}` +
      (pres === undefined ? '' : `<span class="pres${pres ? ' on' : ''}"></span>`) + '</span>';
  };

  const MONTHS = ['Ocak', 'Şubat', 'Mart', 'Nisan', 'Mayıs', 'Haziran', 'Temmuz', 'Ağustos', 'Eylül', 'Ekim', 'Kasım', 'Aralık'];
  const p2 = n => String(n).padStart(2, '0');
  const hhmm = ts => { const d = new Date(ts); return p2(d.getHours()) + ':' + p2(d.getMinutes()); };
  const dayKey = ts => { const d = new Date(ts); return d.getFullYear() * 10000 + d.getMonth() * 100 + d.getDate(); };
  function dayLabel(ts) {
    const now = new Date(), d = new Date(ts);
    const today = dayKey(now.getTime()), yest = dayKey(now.getTime() - 86400000);
    if (dayKey(ts) === today) return 'Bugün';
    if (dayKey(ts) === yest) return 'Dün';
    return d.getDate() + ' ' + MONTHS[d.getMonth()] + (d.getFullYear() !== now.getFullYear() ? ' ' + d.getFullYear() : '');
  }
  function whenLabel(ts) {
    const k = dayKey(ts), now = Date.now();
    if (k === dayKey(now)) return 'Bugün ' + hhmm(ts);
    if (k === dayKey(now - 86400000)) return 'Dün ' + hhmm(ts);
    const d = new Date(ts);
    return p2(d.getDate()) + '.' + p2(d.getMonth() + 1) + '.' + d.getFullYear() + ' ' + hhmm(ts);
  }

  // ---------- api ----------
  const ERR = {
    bad_login: 'Kullanıcı adı ya da şifre yanlış.',
    username_taken: 'Bu kullanıcı adı alınmış — başka bir tane dene.',
    bad_username: 'Kullanıcı adı 3–24 karakter olmalı: küçük harf, rakam, _ ve nokta.',
    weak_password: 'Şifre en az 8 karakter olmalı.',
    long_password: 'Şifre çok uzun.',
    slow_down: 'Biraz hızlı gittin — birkaç saniye bekleyip tekrar dene.',
    network: 'Sunucuya ulaşılamadı. Bağlantını kontrol et.',
    file_too_big: 'Dosya çok büyük (tek mesajda en fazla 25 MB).',
    too_many_files: 'Bir mesaja en fazla 10 dosya eklenebilir.',
    too_long: 'Mesaj çok uzun (en fazla 2000 karakter).',
    empty: 'Boş mesaj gönderilemez.',
    no_invite: 'Bu davet geçersiz ya da yenilenmiş.',
    owner_cannot_leave: 'Denin sahibi ayrılamaz — istersen deni silebilirsin.',
    last_channel: 'Denin son kanalı silinemez.',
    forbidden: 'Bunun için yetkin yok.',
    not_member: 'Bu denin üyesi değilsin.',
    bad_name: 'Bir ad yaz.',
    bad_password: 'Mevcut şifre yanlış.',
    too_many: 'Sınıra ulaştın.',
    upload_failed: 'Dosya yüklenemedi.',
    gifs_off: 'GIF araması henüz ayarlanmadı.',
    gifs_down: 'GIF servisine şu an ulaşılamıyor.',
    no_gif: 'Bu GIF artık bulunamadı.',
    gif_fetch: 'GIF indirilemedi — biraz sonra tekrar dene.',
    server: 'Sunucuda bir hata oldu. Biraz sonra tekrar dene.',
  };
  const apiErr = (code, status) => Object.assign(new Error(code), { code, status: status || 0 });
  const errText = e => ERR[e && e.code] || 'Bir şeyler ters gitti (' + ((e && e.code) || 'hata') + ').';

  async function api(a, data, opt) {
    const get = opt && opt.get;
    let url = 'api.php?a=' + a;
    const init = { credentials: 'same-origin', headers: {} };
    if (get) {
      if (data) url += '&' + new URLSearchParams(data);
    } else {
      init.method = 'POST';
      init.headers['X-VoiceDen'] = '1';
      init.headers['Content-Type'] = 'application/json';
      init.body = JSON.stringify(data || {});
    }
    let res;
    try { res = await fetch(url, init); } catch (e) { throw apiErr('network'); }
    let j = null;
    try { j = await res.json(); } catch (e) {}
    if (res.status === 401 && a !== 'login' && S.me) signedOut();
    if (!res.ok || !j || j.error) throw apiErr((j && j.error) || (res.status === 413 ? 'file_too_big' : 'http_' + res.status), res.status);
    return j;
  }
  // XHR, not fetch: fetch has no upload progress
  function upload(fd, onProgress) {
    return new Promise((resolve, reject) => {
      const x = new XMLHttpRequest();
      x.open('POST', 'api.php?a=send');
      x.setRequestHeader('X-VoiceDen', '1');
      x.upload.onprogress = e => { if (e.lengthComputable) onProgress(e.loaded / e.total); };
      x.onload = () => {
        let j = null;
        try { j = JSON.parse(x.responseText); } catch (e) {}
        if (x.status >= 200 && x.status < 300 && j && !j.error) resolve(j);
        else reject(apiErr((j && j.error) || (x.status === 413 ? 'file_too_big' : 'http_' + x.status), x.status));
      };
      x.onerror = () => reject(apiErr('network'));
      x.send(fd);
    });
  }

  // ---------- state ----------
  const S = {
    me: null,
    servers: new Map(), order: [],
    users: new Map(),
    chans: new Map(),          // id -> channel (+ sid)
    online: new Set(),
    voice: [],                 // voice seats in all my dens
    cursor: 0,
    stores: new Map(),         // channel id -> loaded messages
    sid: 0, cid: 0,
    typing: [],
    speaking: new Set(),       // uids talking in my voice channel
    typingPing: false,
  };
  const isMgr = s => s && (s.role === 'owner' || s.role === 'admin');
  function store(cid) {
    let st = S.stores.get(cid);
    if (!st) {
      st = { msgs: [], byId: new Map(), loaded: false, loading: false, more: true, pending: [], gone: new Set(), newFrom: null };
      S.stores.set(cid, st);
    }
    return st;
  }

  // ---------- dom ----------
  const app = $('app'), authEl = $('auth'), bootEl = $('boot');
  const railList = $('railList'), chanList = $('chanList'), memberPanel = $('memberPanel');
  const messagesEl = $('messages'), chatInput = $('chatInput'), stagedEl = $('staged'), typingEl = $('typing');
  const welcomeEl = $('welcome'), vJoin = $('vJoin'), chatPanel = $('chatPanel');

  // ---------- toasts / modals ----------
  function toast(text, ok) {
    const t = document.createElement('div');
    t.className = 'toast' + (ok ? ' ok' : '');
    t.textContent = text;
    $('toasts').appendChild(t);
    setTimeout(() => t.remove(), 3800);
  }

  const modalBack = $('modalBack'), modalEl = $('modal');
  let modalOnClose = null;
  function openModal(html, opts) {
    closeModal();
    modalEl.className = 'modal' + (opts && opts.wide ? ' wide' : '');
    modalEl.innerHTML = html;
    modalBack.hidden = false;
    modalOnClose = (opts && opts.onClose) || null;
    const f = modalEl.querySelector('[autofocus]');
    if (f && !touch) setTimeout(() => f.focus(), 30);
    return modalEl;
  }
  function closeModal() {
    if (modalBack.hidden) return;
    VD.voice.closePanel();               // the audio panel may be borrowed by settings
    modalBack.hidden = true;
    modalEl.innerHTML = '';
    const fn = modalOnClose;
    modalOnClose = null;
    if (fn) fn();
  }
  modalBack.addEventListener('mousedown', e => { if (e.target === modalBack) closeModal(); });
  modalEl.addEventListener('click', e => { if (e.target.closest('[data-close]')) closeModal(); });

  function confirmBox(title, text, okText, danger) {
    return new Promise(resolve => {
      let answered = false;
      const m = openModal(`<h3>${esc(title)}</h3><div class="sub">${esc(text)}</div>
        <div class="acts"><button class="btn" data-no>Vazgeç</button>
        <button class="btn ${danger ? 'danger' : 'primary'}" data-yes autofocus>${esc(okText)}</button></div>`,
        { onClose: () => { if (!answered) resolve(false); } });
      m.querySelector('[data-no]').onclick = () => closeModal();
      m.querySelector('[data-yes]').onclick = () => { answered = true; resolve(true); closeModal(); };
    });
  }

  // ---------- invites ----------
  const inviteUrl = sid => {
    const s = S.servers.get(sid);
    return s ? location.origin + location.pathname + '?i=' + s.invite : '';
  };
  const prettyUrl = u => u.replace(/^https?:\/\//, '');
  function copyText(text) {
    if (navigator.clipboard && window.isSecureContext) return navigator.clipboard.writeText(text);
    return new Promise((res, rej) => {
      const ta = document.createElement('textarea');
      ta.value = text; ta.style.position = 'fixed'; ta.style.opacity = '0';
      document.body.appendChild(ta); ta.select();
      try { document.execCommand('copy') ? res() : rej(); } catch (e) { rej(e); }
      ta.remove();
    });
  }
  function copyInvite(sid, node) {
    const url = inviteUrl(sid);
    if (!url) return;
    copyText(url).then(() => {
      if (node) {
        const was = node.textContent;
        node.textContent = 'kopyalandı!';
        setTimeout(() => { node.textContent = was; }, 1200);
      } else toast('Davet bağlantısı kopyalandı', true);
    }).catch(() => toast(url));
  }
  const parseInvite = v => {
    v = String(v || '').trim();
    const m = v.match(/[?&]i=([a-z0-9]+)/i);
    return (m ? m[1] : v.replace(/^.*\//, '')).toLowerCase().replace(/[^a-z0-9]/g, '');
  };

  // ============================================================ AUTH
  let authMode = 'login';
  let pendingInvite = '';
  try {
    const q = new URLSearchParams(location.search);
    if (q.get('i')) pendingInvite = parseInvite(q.get('i'));
  } catch (e) {}

  function setAuthMode(mode) {
    authMode = mode;
    $('authTabs').querySelectorAll('button').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.mode === mode)));
    $('fName').hidden = mode !== 'register';
    $('authBtn').textContent = mode === 'register' ? 'Hesap aç' : 'Giriş yap';
    $('aPass').autocomplete = mode === 'register' ? 'new-password' : 'current-password';
    $('authErr').textContent = '';
  }
  $('authTabs').addEventListener('click', e => {
    const b = e.target.closest('button[data-mode]');
    if (b) { setAuthMode(b.dataset.mode); (authMode === 'register' ? $('aName') : $('aUser')).focus(); }
  });
  $('aUser').addEventListener('input', () => {
    const v = $('aUser').value, low = v.toLocaleLowerCase('tr').replace(/\s/g, '');
    if (v !== low) $('aUser').value = low;
  });

  async function showAuth() {
    bootEl.hidden = true;
    app.hidden = true;
    authEl.hidden = false;
    setAuthMode(pendingInvite ? 'register' : 'login');
    if (pendingInvite) {
      try {
        const r = await api('invite', { code: pendingInvite }, { get: true });
        const t = svTint(r.server.id);
        const ic = $('aiIcon');
        ic.textContent = initials(r.server.name);
        ic.style.cssText = `--av-bg:${t.bg};--av-fg:${t.fg}`;
        $('aiName').textContent = r.server.name;
        $('aiMeta').textContent = r.server.members + ' üye · ' + r.server.online + ' çevrimiçi — katılmak için giriş yap ya da hesap aç';
        $('authInvite').hidden = false;
      } catch (e) {
        pendingInvite = '';
        $('authErr').textContent = ERR.no_invite;
      }
    }
    (authMode === 'register' ? $('aName') : $('aUser')).focus();
  }

  $('authForm').addEventListener('submit', async e => {
    e.preventDefault();
    const btn = $('authBtn'), err = $('authErr');
    const username = $('aUser').value.trim().toLowerCase();
    const password = $('aPass').value;
    err.textContent = '';
    if (!/^[a-z0-9_.]{3,24}$/.test(username)) { err.textContent = ERR.bad_username; $('aUser').focus(); return; }
    if (authMode === 'register' && password.length < 8) { err.textContent = ERR.weak_password; $('aPass').focus(); return; }
    if (!password) { $('aPass').focus(); return; }
    btn.disabled = true;
    btn.textContent = authMode === 'register' ? 'Hesap açılıyor…' : 'Giriş yapılıyor…';
    try {
      const body = { username, password };
      if (authMode === 'register') body.name = $('aName').value.trim();
      await api(authMode, body);
      $('aPass').value = '';
      authEl.dataset.fresh = '1';           // an invite they signed in for is accepted without asking again
      authEl.hidden = true;
      await startApp();
    } catch (ex) {
      err.textContent = errText(ex);
    } finally {
      btn.disabled = false;
      btn.textContent = authMode === 'register' ? 'Hesap aç' : 'Giriş yap';
    }
  });

  function signedOut() {
    // the session died under us (logged out elsewhere, password changed)
    VD.voice.leave();
    location.href = location.pathname;
  }

  // ============================================================ BOOT
  async function startApp() {
    bootEl.hidden = false;
    let b;
    try { b = await api('boot', null, { get: true }); }
    catch (e) {
      if (e.status === 401) { showAuth(); return; }
      bootEl.innerHTML = `<div style="text-align:center;display:flex;flex-direction:column;gap:14px;align-items:center;padding:24px">
        <div>${esc(errText(e))}</div><button class="btn" onclick="location.reload()">Tekrar dene</button></div>`;
      return;
    }
    S.cursor = b.cursor;
    applyBoot(b);
    bootEl.hidden = true;
    authEl.hidden = true;
    app.hidden = false;
    initVoice();

    let target = null;
    if (pendingInvite) target = await handleInvite();
    if (!target) {
      const h = location.hash.match(/^#\/(\d+)(?:\/(\d+))?/);
      if (h && S.servers.has(+h[1])) target = { sid: +h[1], cid: +h[2] || 0 };
    }
    if (!target) {
      const last = +pref('vd-last-sid', '0');
      target = { sid: S.servers.has(last) ? last : (S.order[0] || 0), cid: 0 };
    }
    go(target.sid, target.cid);
    poll();
  }

  function applyBoot(b) {
    S.me = b.me;
    // merged, not replaced: someone who left still has messages on screen
    for (const u of b.users) S.users.set(u.id, u);
    const oldChans = S.chans;
    S.servers = new Map();
    S.order = [];
    S.chans = new Map();
    for (const s of b.servers) {
      S.servers.set(s.id, s);
      S.order.push(s.id);
      for (const c of s.channels) {
        c.sid = s.id;
        // a poll may already know of newer messages / reads than this snapshot
        const old = oldChans.get(c.id);
        if (old) { c.last = Math.max(c.last, old.last); c.read = Math.max(c.read, old.read); }
        S.chans.set(c.id, c);
      }
    }
    S.voice = b.voice;
    S.online = new Set(b.online);
    for (const cid of [...S.stores.keys()]) if (!S.chans.has(cid)) S.stores.delete(cid);
  }

  let rebooting = null;
  function reboot() {
    if (rebooting) return rebooting;
    rebooting = api('boot', null, { get: true }).then(b => {
      const before = [...S.users.values()].map(u => u.id + ':' + u.name + ':' + u.tint).join('|');
      applyBoot(b);
      // a newcomer's messages may already be on screen under a placeholder name
      const after = [...S.users.values()].map(u => u.id + ':' + u.name + ':' + u.tint).join('|');
      if (before !== after && S.cid && store(S.cid).loaded) {
        const stick = atBottom(), top = messagesEl.scrollTop;
        renderChannel();
        if (stick) scrollBottom(); else messagesEl.scrollTop = top;
        VD.voice.render();
      }
      if (!S.servers.has(S.sid)) go(S.order[0] || 0, 0);
      else if (!S.chans.has(S.cid)) go(S.sid, 0);
      const vch = VD.voice.channel;
      if (vch && !S.chans.has(vch)) VD.voice.leave('Bu ses kanalı artık yok.');
      scheduleUi();
    }).catch(() => {}).finally(() => { rebooting = null; });
    return rebooting;
  }

  /** logged in with ?i=: go there, or ask before joining */
  async function handleInvite() {
    const code = pendingInvite;
    pendingInvite = '';
    try { history.replaceState(null, '', location.pathname + location.hash); } catch (e) {}
    let info;
    try { info = await api('invite', { code }, { get: true }); }
    catch (e) { toast(ERR.no_invite); return null; }
    if (info.member) return { sid: info.server.id, cid: 0 };
    // straight from sign-up with an invite in hand: they already said yes
    if (!S.order.length || authEl.dataset.fresh) {
      return acceptInvite(code);
    }
    const yes = await confirmBox(info.server.name + ' denine davet edildin',
      info.server.members + ' üye · ' + info.server.online + ' çevrimiçi', 'Katıl', false);
    return yes ? acceptInvite(code) : null;
  }
  async function acceptInvite(code) {
    try {
      const r = await api('invite_accept', { code });
      await reboot();
      return { sid: r.id, cid: 0 };
    } catch (e) { toast(errText(e)); return null; }
  }

  // ============================================================ NAVIGATION
  const drafts = new Map();
  function go(sid, cid) {
    const s = S.servers.get(sid);
    if (S.cid) drafts.set(S.cid, chatInput.value);
    if (!s) {
      S.sid = 0; S.cid = 0;
      try { history.replaceState(null, '', location.pathname); } catch (e) {}
      scheduleUi();
      renderMainNow();
      return;
    }
    if (!cid || !S.chans.has(cid) || S.chans.get(cid).sid !== sid) {
      const remembered = +pref('vd-last-ch-' + sid, '0');
      const c = S.chans.get(remembered);
      cid = c && c.sid === sid ? remembered : (s.channels.find(x => x.kind === 'text') || s.channels[0] || {}).id || 0;
    }
    const changed = cid !== S.cid;
    S.sid = sid; S.cid = cid;
    setPref('vd-last-sid', String(sid));
    if (cid) setPref('vd-last-ch-' + sid, String(cid));
    try { history.replaceState(null, '', location.pathname + '#/' + sid + (cid ? '/' + cid : '')); } catch (e) {}
    setNav(false);
    if (changed) {
      S.typing = [];
      chatInput.value = drafts.get(cid) || '';
      autosize();
      clearStaged();
      closeGifs();
      const c = S.chans.get(cid);
      if (c && c.kind === 'voice') app.classList.toggle('chat-off', narrow() ? true : pref('vd-vchat', '1') === '0');
    }
    renderMainNow();
    scheduleUi();
    if (changed && cid) openChannel(cid);
    if (changed) requestPoll();
  }

  function joinVoice(c) {
    VD.voice.join({ id: c.id, sid: c.sid });
  }

  // ============================================================ RENDER
  let uiQueued = false;
  function scheduleUi() {
    if (uiQueued) return;
    uiQueued = true;
    requestAnimationFrame(() => { uiQueued = false; renderUi(); });
  }
  function renderUi() {
    if (!S.me) return;
    renderRail(); renderSide(); renderMe(); renderHeader(); renderMainNow(); renderMembers(); renderTyping(); renderTitle();
  }

  const unreadIn = c => c.last > c.read;
  const serverUnread = s => s.channels.some(c => unreadIn(c) && !(c.id === S.cid && !document.hidden));

  let railKey = '';
  function renderRail() {
    let html = '';
    for (const sid of S.order) {
      const s = S.servers.get(sid), t = svTint(sid);
      const live = VD.voice.server === sid;
      html += `<div class="rail-item${sid === S.sid ? ' active' : ''}${serverUnread(s) ? ' unread' : ''}">
        <button class="sv" data-sid="${sid}" title="${esc(s.name)}" style="--av-bg:${t.bg};--av-fg:${t.fg}">${esc(initials(s.name))}</button>
        ${live ? '<span class="vdot" title="Bu dende sestesin"></span>' : ''}</div>`;
    }
    if (html !== railKey) { railList.innerHTML = html; railKey = html; }
  }
  railList.addEventListener('click', e => {
    const b = e.target.closest('[data-sid]');
    if (b) go(+b.dataset.sid, 0);
  });

  let sideKey = '';
  function renderSide() {
    const s = S.servers.get(S.sid);
    $('srvName').textContent = s ? s.name : 'VoiceDen';
    $('sideHead').disabled = !s;
    let html = '';
    if (!s) {
      html = '<div class="note" style="padding:12px 8px">Henüz bir denin yok. Soldaki + ile bir tane kur ya da bir davetle katıl.</div>';
    } else {
      const mgr = isMgr(s);
      const cat = (title, kind) => `<div class="cat"><span>${title}</span>${mgr ? `<button data-add="${kind}" title="Kanal ekle" aria-label="Kanal ekle">+</button>` : ''}</div>`;
      const row = c => {
        const cls = 'ch' + (c.id === S.cid ? ' active' : '') + (c.kind === 'text' && unreadIn(c) && c.id !== S.cid ? ' unread' : '') +
          (c.kind === 'voice' && VD.voice.channel === c.id ? ' live' : '');
        return `<button class="${cls}" data-ch="${c.id}"><span class="ico">${c.kind === 'text' ? '#' : icon('vol')}</span>` +
          `<span class="nm">${esc(c.name)}</span>` +
          (mgr ? `<span class="edit" data-edit="${c.id}" role="button" title="Kanalı düzenle">${icon('gear')}</span>` : '') + '</button>';
      };
      html += cat('Metin kanalları', 'text');
      s.channels.filter(c => c.kind === 'text').forEach(c => { html += row(c); });
      html += cat('Ses kanalları', 'voice');
      s.channels.filter(c => c.kind === 'voice').forEach(c => {
        html += row(c);
        const seats = S.voice.filter(v => v.ch === c.id);
        if (seats.length) {
          html += '<div class="vusers">' + seats.map(v => {
            const me = v.uid === S.me.id && VD.voice.channel === c.id;
            const mu = me ? VD.voice.muted : v.mu, df = me ? VD.voice.deafened : v.df;
            const sp = VD.voice.channel === c.id && S.speaking.has(v.uid);
            return `<div class="vu-row${me ? ' me' : ''}${sp ? ' speaking' : ''}" data-vuid="${v.uid}" data-vch="${c.id}">` +
              avHtml(v.uid, 'sm') + `<span class="nm">${esc(nameOf(v.uid))}</span>` +
              `<span class="st">${df ? icon('head-off') : (mu ? icon('mic-off') : '')}</span>` +
              (v.sh ? '<span class="live">CANLI</span>' : '') + '</div>';
          }).join('') + '</div>';
        }
      });
    }
    if (html !== sideKey) { chanList.innerHTML = html; sideKey = html; }
  }
  chanList.addEventListener('click', e => {
    const ed = e.target.closest('[data-edit]');
    if (ed) { e.stopPropagation(); openChannelSettings(+ed.dataset.edit); return; }
    const add = e.target.closest('[data-add]');
    if (add) { openCreateChannel(add.dataset.add); return; }
    const b = e.target.closest('[data-ch]');
    if (!b) return;
    const c = S.chans.get(+b.dataset.ch);
    if (!c) return;
    go(c.sid, c.id);
    if (c.kind === 'voice' && VD.voice.channel !== c.id && !VD.voice.joining) joinVoice(c);
  });

  function renderMe() {
    const t = tintOf(S.me.id);
    const av = $('meAv');
    av.style.cssText = `--av-bg:${t.bg};--av-fg:${t.fg}`;
    av.innerHTML = esc(initials(S.me.name)) + '<span class="pres on"></span>';
    $('meName').textContent = S.me.name;
    $('meUser').textContent = '@' + S.me.username;
    const mute = $('meMute'), deaf = $('meDeaf');
    mute.classList.toggle('on', VD.voice.muted);
    mute.title = VD.voice.muted ? 'Mikrofonu aç' : 'Mikrofonu kapat';
    deaf.classList.toggle('on', VD.voice.deafened);
    deaf.title = VD.voice.deafened ? 'Sesi aç' : 'Sesi kes';

    const vch = VD.voice.channel, joining = VD.voice.joining;
    $('vPanel').hidden = !vch && !joining;
    if (vch || joining) {
      const c = S.chans.get(vch), s = c && S.servers.get(c.sid);
      const st = $('vpState');
      st.textContent = joining ? 'BAĞLANIYOR…' : 'SES BAĞLI';
      st.classList.toggle('wait', joining);
      $('vpWhere').textContent = c ? c.name + ' / ' + (s ? s.name : '') : '';
      $('vpShare').hidden = !vch || !VD.voice.canShare;
      $('vpShare').classList.toggle('lit', VD.voice.sharing);
    }
    // phones: a strip under the header leads back to the call
    const c = S.chans.get(vch);
    const showBar = !!(vch && c && S.cid !== vch);
    $('vBar').hidden = !showBar;
    if (showBar) $('vBarTxt').textContent = c.name + ' — sestesin · dön';
  }

  function renderHeader() {
    const c = S.chans.get(S.cid);
    const ico = $('mhIco'), name = $('mhName');
    if (!c) {
      ico.textContent = '';
      name.textContent = S.servers.size ? '' : 'Hoş geldin';
    } else if (c.kind === 'text') {
      ico.textContent = '#';
      name.textContent = c.name;
    } else {
      ico.innerHTML = icon('vol');
      name.textContent = c.name;
    }
    const here = c && c.kind === 'voice' && VD.voice.channel === c.id;
    $('mhMeta').hidden = !here;
    if (here) $('vCount').textContent = VD.voice.count + ' kişi';
    $('inviteBtn').hidden = !S.servers.get(S.sid);
    $('membersBtn').hidden = !c || c.kind === 'voice';
    $('membersBtn').setAttribute('aria-pressed', String(app.classList.contains('show-members')));
    $('chatBtn').hidden = !c || c.kind !== 'voice';
    $('chatBtn').setAttribute('aria-pressed', String(!app.classList.contains('chat-off')));
  }

  let vjoinKey = '';
  function renderMainNow() {
    const s = S.servers.get(S.sid);
    const c = S.chans.get(S.cid);
    const voice = !!c && c.kind === 'voice';
    const here = voice && VD.voice.channel === c.id;
    app.classList.toggle('view-voice', voice);
    app.classList.toggle('connected', here);
    welcomeEl.hidden = !!s;
    chatPanel.hidden = !c;
    if (!s && !welcomeEl.firstChild) renderWelcome();
    if (voice && !here) {
      const seats = S.voice.filter(v => v.ch === c.id);
      const html = `<div class="faces">${seats.length ? seats.map(v => avHtml(v.uid)).join('') : '<span class="empty">+</span>'}</div>
        <div><h2>${esc(c.name)}</h2><p>${seats.length ? seats.length + ' kişi burada sohbet ediyor' : 'Şu an kimse yok — ilk sen gir.'}</p></div>
        <button class="btn primary" data-join ${VD.voice.joining ? 'disabled' : ''}>${VD.voice.joining ? 'Bağlanılıyor…' : (VD.voice.channel ? 'Bu kanala geç' : 'Kanala katıl')}</button>`;
      if (html !== vjoinKey) { vJoin.innerHTML = html; vjoinKey = html; }
      vJoin.hidden = false;
    } else {
      vJoin.hidden = true;
    }
  }
  vJoin.addEventListener('click', e => {
    if (!e.target.closest('[data-join]')) return;
    const c = S.chans.get(S.cid);
    if (c && c.kind === 'voice') joinVoice(c);
  });

  let membersKey = '';
  function renderMembers() {
    const s = S.servers.get(S.sid);
    if (!s) { memberPanel.innerHTML = ''; membersKey = ''; return; }
    const weight = r => (r === 'owner' ? 0 : r === 'admin' ? 1 : 2);
    const sorted = s.members.slice().sort((a, b) => weight(a.role) - weight(b.role) || nameOf(a.id).localeCompare(nameOf(b.id), 'tr'));
    const on = sorted.filter(m => S.online.has(m.id) || m.id === S.me.id), off = sorted.filter(m => !(S.online.has(m.id) || m.id === S.me.id));
    const row = (m, online) => `<div class="mrow${online ? '' : ' off'}" style="--who:${tintOf(m.id).fg}">${avHtml(m.id, '', online)}
      <span class="nm">${esc(nameOf(m.id))}</span>${m.role !== 'member' ? `<span class="role ${m.role}">${m.role === 'owner' ? 'SAHİP' : 'YÖNETİCİ'}</span>` : ''}</div>`;
    let html = `<div class="cat">Çevrimiçi — ${on.length}</div>` + on.map(m => row(m, true)).join('');
    if (off.length) html += `<div class="cat">Çevrimdışı — ${off.length}</div>` + off.map(m => row(m, false)).join('');
    if (html !== membersKey) { memberPanel.innerHTML = html; membersKey = html; }
  }

  function renderTyping() {
    const names = S.typing.filter(uid => uid !== S.me.id).map(nameOf);
    if (!names.length) { typingEl.innerHTML = ''; return; }
    const who = names.length === 1 ? `<b>${esc(names[0])}</b> yazıyor` :
      names.length === 2 ? `<b>${esc(names[0])}</b> ve <b>${esc(names[1])}</b> yazıyor` : 'Birkaç kişi yazıyor';
    typingEl.innerHTML = '<span class="dots"><i></i><i></i><i></i></span><span>' + who + '…</span>';
  }

  function renderTitle() {
    let n = 0;
    for (const c of S.chans.values()) if (c.kind === 'text' && unreadIn(c) && !(c.id === S.cid && !document.hidden)) n++;
    document.title = (n ? '(' + n + ') ' : '') + (S.chans.get(S.cid) ? (S.chans.get(S.cid).kind === 'text' ? '#' : '') + S.chans.get(S.cid).name + ' · ' : '') + 'VoiceDen';
  }

  function renderWelcome() {
    welcomeEl.innerHTML = `<div class="hero"><h1>İlk denini kur.</h1>
      <p>Bir den, arkadaşlarınla paylaştığın alan: metin kanalları, ses kanalları ve kaybolmayan mesajlar.</p></div>` + cardsHtml();
    wireCards(welcomeEl);
  }

  // ============================================================ MESSAGES
  const URL_RE = /\bhttps?:\/\/[^\s<>"']+/gi;
  // trailing punctuation is the sentence's, but a closing bracket that balances
  // one inside the URL stays — wikipedia.org/wiki/Mercury_(planet) survives
  function trimUrl(u) {
    u = u.replace(/[.,;:!?'"]+$/, '');
    while (/[)\]}]$/.test(u)) {
      const close = u.slice(-1), open = { ')': '(', ']': '[', '}': '{' }[close];
      if (u.split(close).length - 1 <= u.split(open).length - 1) break;
      u = u.slice(0, -1);
    }
    return u.replace(/[.,;:!?'"]+$/, '');
  }
  function linkify(text) {
    let out = '', last = 0, m;
    URL_RE.lastIndex = 0;
    while ((m = URL_RE.exec(text)) !== null) {
      const raw = trimUrl(m[0]);
      out += esc(text.slice(last, m.index));
      out += `<a href="${esc(raw)}" target="_blank" rel="noopener noreferrer nofollow">${esc(raw)}</a>`;
      last = m.index + raw.length;
    }
    return out + esc(text.slice(last));
  }
  function firstLink(text) {
    URL_RE.lastIndex = 0;
    const m = URL_RE.exec(text);
    if (!m) return null;
    const u = trimUrl(m[0]);
    try { return /^https?:$/.test(new URL(u).protocol) ? u : null; } catch (e) { return null; }
  }
  // og.php resolves the preview; each viewer asks for itself, nothing is stored with the message
  const previewCache = new Map();
  let previewsInFlight = 0;
  function fetchPreview(url) {
    if (previewCache.has(url)) return previewCache.get(url);
    if (previewsInFlight > 4) return Promise.resolve(null);
    previewsInFlight++;
    const req = fetch('og.php?url=' + encodeURIComponent(url), { cache: 'force-cache' })
      .then(r => (r.ok ? r.json() : null)).then(d => (d && d.ok ? d : null)).catch(() => null)
      .finally(() => { previewsInFlight--; });
    previewCache.set(url, req);
    return req;
  }
  function addPreview(cnt, text) {
    const link = firstLink(text);
    if (!link) return;
    const card = document.createElement('a');
    card.className = 'link-preview loading';
    card.innerHTML = '<div class="lp-spin"></div><span>bağlantı okunuyor…</span>';
    cnt.appendChild(card);
    fetchPreview(link).then(d => {
      if (!d) { card.remove(); return; }
      const stick = atBottom();
      card.className = 'link-preview' + (d.kind === 'image' ? ' is-image' : '');
      card.href = d.url || link;
      card.target = '_blank';
      card.rel = 'noopener noreferrer nofollow';
      const img = d.image ? `<img class="lp-thumb" src="${esc(d.image)}" alt="" loading="lazy" referrerpolicy="no-referrer" onerror="this.remove()">` : '';
      card.innerHTML = d.kind === 'image' ? img : img + `<div class="lp-text">
        ${d.title ? `<div class="lp-title">${esc(d.title)}</div>` : ''}
        ${d.description ? `<div class="lp-desc">${esc(d.description)}</div>` : ''}
        <div class="lp-host">${esc(d.site || d.host || '')}</div></div>`;
      if (stick) scrollBottom();
    });
  }

  const fileUrl = (a, dl) => 'api.php?a=file&id=' + a.id + (dl ? '&dl=1' : '');
  // media whose size changes after it loads would leave the bottom of the list
  // out of view; if the reader was at the bottom, keep them there
  function followSize(el, evt) {
    el.addEventListener(evt, () => { if (el.dataset.stick === '1') scrollBottom(); }, { once: true });
  }
  // GIFs only play while on screen: a long history of them would otherwise all run at once
  const calm = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const gifObs = 'IntersectionObserver' in window ? new IntersectionObserver(entries => {
    for (const e of entries) {
      if (e.isIntersecting) e.target.play().catch(() => {});
      else e.target.pause();
    }
  }, { root: messagesEl }) : null;

  function attachHtmlEls(atts) {
    const wrap = document.createElement('div');
    wrap.className = 'attach';
    for (const a of atts) {
      const kind = a.mime.split('/')[0];
      if (a.gif && kind === 'video') {
        // a GIF is an mp4 that behaves like a picture: silent, looping, no controls
        const v = document.createElement('video');
        v.className = 'at-gif';
        v.muted = true; v.loop = true; v.playsInline = true; v.preload = 'metadata';
        v.setAttribute('aria-label', a.name);
        v.title = a.name.replace(/\.\w+$/, '');
        if (a.w && a.h) {
          const w = Math.min(a.w, 360, Math.round(300 * a.w / a.h));
          v.style.width = w + 'px';
          v.style.aspectRatio = a.w + ' / ' + a.h;
        }
        v.src = fileUrl(a);
        if (calm) v.controls = true;
        else if (gifObs) gifObs.observe(v);
        else v.autoplay = true;
        wrap.appendChild(v);
      } else if (kind === 'image') {
        const img = document.createElement('img');
        img.className = 'at-image';
        img.alt = a.name; img.title = a.name + ' · ' + fmtSize(a.size);
        img.loading = 'lazy';
        if (a.w && a.h) {
          // reserve the box before the bytes arrive, so the list does not jump
          const w = Math.min(a.w, 420, Math.round(340 * a.w / a.h));
          img.style.width = w + 'px';
          img.style.aspectRatio = a.w + ' / ' + a.h;
        } else followSize(img, 'load');
        img.src = fileUrl(a);
        img.addEventListener('click', () => openLightbox(img.src, a.name));
        wrap.appendChild(img);
      } else if (kind === 'video') {
        const v = document.createElement('video');
        v.className = 'at-video'; v.src = fileUrl(a); v.controls = true; v.preload = 'metadata'; v.playsInline = true;
        followSize(v, 'loadedmetadata');
        wrap.appendChild(v);
      } else if (kind === 'audio') {
        const au = document.createElement('audio');
        au.className = 'at-audio'; au.src = fileUrl(a); au.controls = true; au.preload = 'metadata';
        wrap.appendChild(au);
      } else {
        const l = document.createElement('a');
        l.className = 'at-file';
        l.href = fileUrl(a, true);
        l.download = a.name;
        l.innerHTML = `<span class="at-icon">📄</span><span class="at-meta"><span class="at-name">${esc(a.name)}</span>
          <span class="at-size">${esc(fmtSize(a.size))} · indir</span></span>`;
        wrap.appendChild(l);
      }
    }
    return wrap;
  }

  function msgEl(m, prev, newFrom) {
    const wrap = document.createElement('div');
    wrap.className = 'mw';
    wrap.dataset.id = m.id;
    const newDay = !prev || dayKey(prev.ts) !== dayKey(m.ts);
    const head = newDay || prev.uid !== m.uid || m.ts - prev.ts > 7 * 60000 || !!prev.pending;
    let html = newDay ? `<div class="day">${esc(dayLabel(m.ts))}</div>` : '';
    if (newFrom != null && m.id > newFrom && (!prev || prev.id <= newFrom) && m.uid !== S.me.id) html += '<div class="new-line">YENİ</div>';
    const mine = m.uid === S.me.id, s = S.servers.get(m.sid);
    const canDel = mine || isMgr(s);
    html += `<div class="m${head ? ' head' : ''}">
      <div class="gut">${head ? avHtml(m.uid, 'lg') : `<span class="tm">${hhmm(m.ts)}</span>`}</div>
      <div class="cnt">${head ? `<div class="meta"><span class="who" style="--who:${tintOf(m.uid).fg}">${esc(nameOf(m.uid))}</span><span class="when">${esc(whenLabel(m.ts))}</span></div>` : ''}
      ${m.body ? `<div class="body">${linkify(m.body)}${m.ets ? '<span class="edited">(düzenlendi)</span>' : ''}</div>` : ''}</div>
      ${canDel ? `<div class="m-acts">${mine ? `<button data-act="edit" title="Düzenle" aria-label="Düzenle">${icon('edit')}</button>` : ''}
        <button class="warn" data-act="del" title="Sil (Shift: sormadan)" aria-label="Sil">${icon('trash')}</button></div>` : ''}
    </div>`;
    wrap.innerHTML = html;
    const cnt = wrap.querySelector('.cnt');
    if (m.att && m.att.length) cnt.appendChild(attachHtmlEls(m.att));
    if (m.body) addPreview(cnt, m.body);
    return wrap;
  }

  function pendingEl(p, prev) {
    const wrap = document.createElement('div');
    wrap.className = 'mw pending';
    wrap.dataset.nonce = p.nonce;
    const head = !prev || prev.uid !== p.uid || p.ts - prev.ts > 7 * 60000 || dayKey(prev.ts) !== dayKey(p.ts);
    wrap.innerHTML = `<div class="m${head ? ' head' : ''} pending${p.failed ? ' failed' : ''}">
      <div class="gut">${head ? avHtml(p.uid, 'lg') : `<span class="tm">${hhmm(p.ts)}</span>`}</div>
      <div class="cnt">${head ? `<div class="meta"><span class="who" style="--who:${tintOf(p.uid).fg}">${esc(nameOf(p.uid))}</span><span class="when">gönderiliyor…</span></div>` : ''}
        ${p.body ? `<div class="body">${linkify(p.body)}</div>` : ''}
        ${p.files.length ? `<div class="attach">${p.files.map(f => `<div class="at-file"><span class="at-icon">📤</span><span class="at-meta"><span class="at-name">${esc(f.name)}</span><span class="at-size">${esc(fmtSize(f.size))}</span></span></div>`).join('')}
          ${p.failed ? '' : '<span class="at-bar"><i></i></span>'}</div>` : ''}
        ${p.gif ? `<div class="attach"><img class="at-gif" alt="" src="${esc(p.gif.thumb)}" style="width:${Math.min(p.gif.w || 240, 360, Math.round(300 * (p.gif.w || 4) / (p.gif.h || 3)))}px;aspect-ratio:${p.gif.w || 4} / ${p.gif.h || 3}"></div>` : ''}
        ${p.failed ? `<div class="fail">${esc(p.failed)}<button data-retry>tekrar dene</button><button data-drop>vazgeç</button></div>` : ''}
      </div></div>`;
    return wrap;
  }

  function topEl(st, c) {
    const div = document.createElement('div');
    if (st.more) {
      div.className = 'msgs-more';
      div.innerHTML = '<div class="spin"></div>';
    } else {
      div.className = 'msgs-top';
      div.innerHTML = c.kind === 'voice'
        ? `<div class="big">${icon('vol')}</div><h2>${esc(c.name)}</h2><p>Ses kanalının yazı tarafı. Burada yazılanlar kalır — sesten çıksan da.</p>`
        : `<div class="big">#</div><h2>#${esc(c.name)} kanalına hoş geldin</h2><p>Kanalın başlangıcı burası.</p>`;
    }
    return div;
  }

  function renderChannel() {
    const c = S.chans.get(S.cid);
    messagesEl.innerHTML = '';
    if (!c) return;
    const st = store(c.id);
    if (!st.loaded) {
      messagesEl.innerHTML = st.error
        ? `<div class="msgs-more"><button class="btn small" data-reload>Mesajlar yüklenemedi — tekrar dene</button></div>`
        : '<div class="msgs-more"><div class="spin"></div></div>';
      return;
    }
    const frag = document.createDocumentFragment();
    frag.appendChild(topEl(st, c));
    let prev = null;
    for (const m of st.msgs) { frag.appendChild(msgEl(m, prev, st.newFrom)); prev = m; }
    for (const p of st.pending) { frag.appendChild(pendingEl(p, prev)); prev = p; }
    messagesEl.appendChild(frag);
  }

  async function openChannel(cid) {
    const c = S.chans.get(cid);
    if (!c) return;
    const st = store(cid);
    st.newFrom = c.read < c.last ? c.read : null;
    renderChannel();
    if (!st.loaded) {
      if (!st.loading) await loadLatest(cid);
      if (S.cid !== cid) return;
      renderChannel();
    }
    const line = messagesEl.querySelector('.new-line');
    scrollBottom();
    if (line && line.offsetTop < messagesEl.scrollTop) messagesEl.scrollTop = Math.max(0, line.offsetTop - 60);
    markRead();
    if (!touch && !narrow()) chatInput.focus();
  }

  async function loadLatest(cid) {
    const st = store(cid);
    st.loading = true;
    st.error = false;
    try {
      const r = await api('messages', { ch: cid, limit: 50 }, { get: true });
      addUsers(r.users);
      // anything a poll delivered while this was in flight is merged, newest rev wins
      for (const m of r.msgs) {
        const have = st.byId.get(m.id);
        if (st.gone.has(m.id) || (have && have.rev >= m.rev)) continue;
        st.byId.set(m.id, m);
      }
      st.msgs = [...st.byId.values()].filter(m => !m.del).sort((a, b) => a.id - b.id);
      st.more = r.more;
      st.loaded = true;
    } catch (e) {
      st.error = true;
    } finally {
      st.loading = false;
    }
  }

  async function loadOlder() {
    const cid = S.cid, st = store(cid);
    if (!st.loaded || !st.more || st.loading) return;
    st.loading = true;
    try {
      const r = await api('messages', { ch: cid, before: st.msgs.length ? st.msgs[0].id : 0, limit: 50 }, { get: true });
      addUsers(r.users);
      const older = r.msgs.filter(m => !st.byId.has(m.id) && !st.gone.has(m.id));
      older.forEach(m => st.byId.set(m.id, m));
      st.msgs = older.concat(st.msgs);
      st.more = r.more;
      if (S.cid === cid) {
        const h = messagesEl.scrollHeight, top = messagesEl.scrollTop;
        renderChannel();
        messagesEl.scrollTop = top + (messagesEl.scrollHeight - h);
      }
    } catch (e) {} finally { st.loading = false; }
  }

  const atBottom = () => messagesEl.scrollTop + messagesEl.clientHeight >= messagesEl.scrollHeight - 80;
  function scrollBottom() { messagesEl.scrollTop = messagesEl.scrollHeight; }
  messagesEl.addEventListener('scroll', () => {
    if (messagesEl.scrollTop < 300) loadOlder();
    if (atBottom()) markRead();
    const stick = atBottom() ? '1' : '0';
    messagesEl.querySelectorAll('img.at-image:not([style]), video.at-video').forEach(el => { el.dataset.stick = stick; });
  }, { passive: true });

  function addUsers(list) {
    for (const u of list || []) if (!S.users.has(u.id)) S.users.set(u.id, u);
  }

  // one message arrived from the server (poll or our own send): file it
  function ingest(m) {
    const c = S.chans.get(m.ch);
    if (!c) return;
    if (m.ch === S.cid && S.typing.includes(m.uid)) { S.typing = S.typing.filter(u => u !== m.uid); renderTyping(); }
    if (!m.del) {
      if (m.id > c.last) c.last = m.id;
      if (m.uid === S.me.id && m.id > c.read) c.read = m.id;
    }
    const st = S.stores.get(m.ch);
    if (!st || !(st.loaded || st.loading)) return;
    const have = st.byId.get(m.id);
    if (have && have.rev >= m.rev) return;
    if (st.gone.has(m.id)) return;
    if (!st.loaded) { st.byId.set(m.id, m); return; }      // merged when the fetch lands
    const shown = S.cid === m.ch;
    if (m.del) {
      st.gone.add(m.id);
      if (!have) return;
      const i = st.msgs.findIndex(x => x.id === m.id);
      st.msgs.splice(i, 1);
      st.byId.delete(m.id);
      if (shown) {
        const node = messagesEl.querySelector(`.mw[data-id="${m.id}"]`);
        if (node) node.remove();
        rerenderMsg(st.msgs[i]);              // the next one may now head its group
      }
      return;
    }
    st.byId.set(m.id, m);
    if (have) {
      const i = st.msgs.findIndex(x => x.id === m.id);
      st.msgs[i] = m;
      if (shown) rerenderMsg(m);
      return;
    }
    const lastId = st.msgs.length ? st.msgs[st.msgs.length - 1].id : 0;
    if (m.id < lastId) {                      // late arrival in the middle: rare, redraw
      st.msgs.push(m);
      st.msgs.sort((a, b) => a.id - b.id);
      if (shown) { const top = messagesEl.scrollTop; renderChannel(); messagesEl.scrollTop = top; }
      return;
    }
    const prev = st.msgs[st.msgs.length - 1] || null;
    st.msgs.push(m);
    if (!shown) return;
    const stick = atBottom() || m.uid === S.me.id;
    const node = msgEl(m, prev, null);
    const firstPending = messagesEl.querySelector('.mw.pending');
    messagesEl.insertBefore(node, firstPending);
    if (firstPending) rerenderPending(st.pending[0]);
    if (stick) {
      node.querySelectorAll('img.at-image:not([style]), video.at-video').forEach(el => { el.dataset.stick = '1'; });
      scrollBottom();
    }
    markRead();
  }
  function rerenderMsg(m) {
    if (!m) return;
    const st = store(m.ch);
    const node = messagesEl.querySelector(`.mw[data-id="${m.id}"]`);
    if (!node) return;
    const i = st.msgs.indexOf(m);
    node.replaceWith(msgEl(m, i > 0 ? st.msgs[i - 1] : null, null));
  }

  let readTimer = 0;
  function markRead() {
    const c = S.chans.get(S.cid);
    if (!c || document.hidden || !messagesEl.offsetParent || !atBottom()) return;
    if (c.last <= c.read) return;
    c.read = c.last;
    scheduleUi();
    clearTimeout(readTimer);
    const cid = c.id, id = c.read;
    readTimer = setTimeout(() => api('read', { ch: cid, id }).catch(() => {}), 700);
  }

  // message hover actions
  messagesEl.addEventListener('click', async e => {
    if (e.target.closest('[data-reload]')) { const cid = S.cid; await loadLatest(cid); if (S.cid === cid) openChannel(cid); return; }
    const pend = e.target.closest('.mw.pending');
    if (pend) {
      const st = store(S.cid);
      const p = st.pending.find(x => String(x.nonce) === pend.dataset.nonce);
      if (!p) return;
      if (e.target.closest('[data-retry]')) { p.failed = null; rerenderPending(p); doSend(p); }
      if (e.target.closest('[data-drop]')) removePending(p);
      return;
    }
    const btn = e.target.closest('[data-act]');
    if (!btn) return;
    const id = +btn.closest('.mw').dataset.id;
    const m = store(S.cid).byId.get(id);
    if (!m) return;
    if (btn.dataset.act === 'edit') startEdit(m);
    if (btn.dataset.act === 'del') {
      if (!e.shiftKey && !(await confirmBox('Mesaj silinsin mi?', 'Bu geri alınamaz' + (m.att.length ? ' — ekli dosyalar da silinir.' : '.'), 'Sil', true))) return;
      try {
        await api('delete', { id });
        ingest(Object.assign({}, m, { del: true, rev: m.rev + 0.5 }));
      } catch (ex) { toast(errText(ex)); }
    }
  });

  function startEdit(m) {
    const node = messagesEl.querySelector(`.mw[data-id="${m.id}"]`);
    if (!node) return;
    const cnt = node.querySelector('.cnt');
    const body = cnt.querySelector('.body');
    if (cnt.querySelector('.m-edit')) return;
    const box = document.createElement('div');
    box.className = 'm-edit';
    box.innerHTML = `<textarea rows="1" maxlength="2000"></textarea>
      <div class="note">Esc ile <b>vazgeç</b> · Enter ile <b>kaydet</b></div>`;
    const ta = box.querySelector('textarea');
    ta.value = m.body;
    if (body) body.replaceWith(box); else cnt.insertBefore(box, cnt.querySelector('.attach'));
    const size = () => { ta.style.height = 'auto'; ta.style.height = Math.min(ta.scrollHeight, 240) + 'px'; };
    size();
    ta.focus();
    ta.setSelectionRange(ta.value.length, ta.value.length);
    ta.addEventListener('input', size);
    const cancel = () => rerenderMsg(store(m.ch).byId.get(m.id) || m);
    ta.addEventListener('keydown', async ev => {
      if (ev.key === 'Escape') { ev.stopPropagation(); cancel(); chatInput.focus(); return; }
      if (ev.key === 'Enter' && !ev.shiftKey && !ev.isComposing) {
        ev.preventDefault();
        const text = ta.value.trim();
        if (text === m.body.trim()) { cancel(); return; }
        if (!text && !m.att.length) { cancel(); return; }
        ta.disabled = true;
        try { const r = await api('edit', { id: m.id, body: text }); ingest(r.msg); }
        catch (ex) { toast(errText(ex)); cancel(); }
        chatInput.focus();
      }
    });
  }

  // ============================================================ COMPOSER
  let staged = [];
  let nonceSeq = 0;
  const MAX_TOTAL = 25 * 1024 * 1024;

  function autosize() {
    chatInput.style.height = 'auto';
    chatInput.style.height = Math.min(chatInput.scrollHeight, 200) + 'px';
  }
  function clearStaged() {
    staged.forEach(f => { if (f.url) URL.revokeObjectURL(f.url); });
    staged = [];
    renderStaged();
  }
  function renderStaged() {
    stagedEl.innerHTML = staged.map((f, i) =>
      `<div class="chip" title="${esc(f.file.name)} · ${esc(fmtSize(f.file.size))}">` +
      (f.url ? `<img src="${esc(f.url)}" alt="">` : `<span class="ci">📄</span><span class="cn">${esc(f.file.name)}</span>`) +
      `<button class="x" data-i="${i}" aria-label="Çıkar">×</button></div>`).join('');
  }
  stagedEl.addEventListener('click', e => {
    const x = e.target.closest('[data-i]');
    if (!x) return;
    const f = staged.splice(+x.dataset.i, 1)[0];
    if (f && f.url) URL.revokeObjectURL(f.url);
    renderStaged();
  });
  function stageFiles(list) {
    if (!S.cid) return;
    for (const file of [...list]) {
      if (staged.length >= 10) { toast(ERR.too_many_files); break; }
      if (!file.size) continue;
      const total = staged.reduce((n, f) => n + f.file.size, 0) + file.size;
      if (file.size > MAX_TOTAL || total > MAX_TOTAL) { toast(file.name + ': ' + ERR.file_too_big); continue; }
      const url = /^image\/(png|jpe?g|gif|webp|avif|bmp)$/i.test(file.type) ? URL.createObjectURL(file) : '';
      staged.push({ file, url });
    }
    renderStaged();
    chatInput.focus();
  }

  function send() {
    const c = S.chans.get(S.cid);
    if (!c) return;
    const text = chatInput.value.replace(/\s+$/, '').replace(/^\s*\n/, '');
    const files = staged.map(f => f.file);
    if (!text.trim() && !files.length) return;
    if (text.length > 2000) { toast(ERR.too_long); return; }
    chatInput.value = '';
    autosize();
    staged.forEach(f => { if (f.url) URL.revokeObjectURL(f.url); });
    staged = [];
    renderStaged();
    drafts.delete(c.id);
    const st = store(c.id);
    const p = { nonce: ++nonceSeq, ch: c.id, uid: S.me.id, body: text.trim() ? text : '', ts: Date.now(), files: files.map(f => ({ name: f.name, size: f.size })), fileObjs: files, pending: true };
    st.pending.push(p);
    if (S.cid === c.id) {
      const prev = st.pending.length > 1 ? st.pending[st.pending.length - 2] : st.msgs[st.msgs.length - 1];
      messagesEl.appendChild(pendingEl(p, prev || null));
      scrollBottom();
    }
    doSend(p);
  }
  async function doSend(p) {
    try {
      let r;
      if (p.fileObjs.length) {
        const fd = new FormData();
        fd.append('ch', p.ch);
        fd.append('body', p.body);
        p.fileObjs.forEach(f => fd.append('files[]', f, f.name));
        r = await upload(fd, frac => {
          const bar = messagesEl.querySelector(`.mw.pending[data-nonce="${p.nonce}"] .at-bar i`);
          if (bar) bar.style.width = Math.round(frac * 100) + '%';
        });
      } else if (p.gif) {
        r = await api('send', { ch: p.ch, body: '', gif: p.gif.slug });
      } else {
        r = await api('send', { ch: p.ch, body: p.body });
      }
      removePending(p);
      ingest(r.msg);
      VD.voice.nudge();                       // people on the call fetch it now
    } catch (e) {
      p.failed = errText(e);
      rerenderPending(p);
    }
  }
  function removePending(p) {
    const st = store(p.ch);
    const i = st.pending.indexOf(p);
    if (i >= 0) st.pending.splice(i, 1);
    if (S.cid === p.ch) {
      const node = messagesEl.querySelector(`.mw.pending[data-nonce="${p.nonce}"]`);
      if (node) node.remove();
      if (st.pending[i]) rerenderPending(st.pending[i]);
    }
  }
  function rerenderPending(p) {
    if (!p || S.cid !== p.ch) return;
    const st = store(p.ch);
    const node = messagesEl.querySelector(`.mw.pending[data-nonce="${p.nonce}"]`);
    if (!node) return;
    const i = st.pending.indexOf(p);
    node.replaceWith(pendingEl(p, i > 0 ? st.pending[i - 1] : st.msgs[st.msgs.length - 1] || null));
  }

  let lastTypingPing = 0;
  chatInput.addEventListener('input', () => {
    autosize();
    if (chatInput.value.trim() && Date.now() - lastTypingPing > 4000) {
      lastTypingPing = Date.now();
      S.typingPing = true;
      requestPoll();
    }
  });
  chatInput.addEventListener('keydown', e => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing && !touch) { e.preventDefault(); send(); return; }
    // ↑ in an empty box edits your last message, as in most chat apps
    if (e.key === 'ArrowUp' && !chatInput.value) {
      const st = store(S.cid);
      const mine = [...st.msgs].reverse().find(m => m.uid === S.me.id);
      if (mine && mine.body) { e.preventDefault(); startEdit(mine); }
    }
  });
  $('sendBtn').addEventListener('click', () => { send(); if (touch) chatInput.focus(); });
  $('attachBtn').addEventListener('click', () => $('fileInput').click());
  $('fileInput').addEventListener('change', () => {
    const fi = $('fileInput');
    if (fi.files.length) stageFiles(fi.files);
    fi.value = '';
  });
  chatInput.addEventListener('paste', e => {
    const files = [...(e.clipboardData ? e.clipboardData.files : [])];
    if (files.length) { e.preventDefault(); stageFiles(files); }
  });
  let dragDepth = 0;
  const hasFiles = e => [...(e.dataTransfer ? e.dataTransfer.types : [])].includes('Files');
  chatPanel.addEventListener('dragenter', e => { if (!hasFiles(e)) return; e.preventDefault(); dragDepth++; $('dropZone').classList.add('on'); });
  chatPanel.addEventListener('dragover', e => { if (hasFiles(e)) e.preventDefault(); });
  chatPanel.addEventListener('dragleave', () => { if (--dragDepth <= 0) { dragDepth = 0; $('dropZone').classList.remove('on'); } });
  chatPanel.addEventListener('drop', e => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    dragDepth = 0;
    $('dropZone').classList.remove('on');
    stageFiles(e.dataTransfer.files);
  });

  // ---------- GIF picker (KLIPY through api.php?a=gifs) ----------
  const gifPick = $('gifPick'), gifBtn = $('gifBtn'), gifQ = $('gifQ'), gifBody = $('gifBody');
  const gifCols = $('gifCols'), gifNote = $('gifNote');
  const G = { q: null, page: 0, more: true, loading: false, seq: 0, heights: [0, 0], timer: 0 };

  function openGifs() {
    if (!S.cid) return;
    gifPick.hidden = false;
    gifBtn.classList.add('open');
    gifBtn.setAttribute('aria-expanded', 'true');
    if (G.q === null || G.failed) loadGifs(gifQ.value.trim(), false);
    if (!touch) gifQ.focus();
  }
  function closeGifs() {
    if (gifPick.hidden) return;
    gifPick.hidden = true;
    gifBtn.classList.remove('open');
    gifBtn.setAttribute('aria-expanded', 'false');
  }
  async function loadGifs(q, next) {
    if (!next) {
      G.q = q; G.page = 0; G.more = true; G.loading = false; G.failed = false;
      G.heights = [0, 0];
      gifCols.innerHTML = '<div class="gp-col"></div><div class="gp-col"></div>';
      gifBody.scrollTop = 0;
    }
    if (G.loading || !G.more) return;
    const seq = ++G.seq;
    G.loading = true;
    gifNote.innerHTML = '<div class="lp-spin" style="margin:0 auto"></div>';
    try {
      const r = await api('gifs', { q: G.q, page: G.page + 1 }, { get: true });
      if (seq !== G.seq) return;
      G.page++;
      G.more = r.more && r.gifs.length > 0;
      const cols = gifCols.children;
      for (const g of r.gifs) {
        // masonry by hand: each tile goes to the shorter column
        const i = G.heights[0] <= G.heights[1] ? 0 : 1;
        const ratio = g.w && g.h ? g.h / g.w : 1;
        G.heights[i] += ratio;
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'gp-item';
        b.title = g.title || 'GIF';
        b.innerHTML = `<img alt="${esc(g.title || 'GIF')}" loading="lazy" referrerpolicy="no-referrer" src="${esc(g.thumb)}" style="aspect-ratio:${g.w || 1} / ${g.h || 1}">`;
        b.addEventListener('click', () => sendGif(g));
        cols[i].appendChild(b);
      }
      gifNote.textContent = G.page === 1 && !r.gifs.length ? 'Bununla ilgili GIF bulunamadı.' : '';
    } catch (e) {
      if (seq !== G.seq) return;
      G.more = false;
      G.failed = true;
      gifNote.textContent = e.code === 'gifs_off' ? 'GIF araması henüz ayarlanmadı (KLIPY anahtarı bekleniyor).'
        : e.code === 'gifs_down' ? 'GIF servisine şu an ulaşılamıyor.' : errText(e);
    } finally {
      if (seq === G.seq) G.loading = false;
    }
  }
  function sendGif(g) {
    const c = S.chans.get(S.cid);
    if (!c) return;
    closeGifs();
    const st = store(c.id);
    const p = { nonce: ++nonceSeq, ch: c.id, uid: S.me.id, body: '', ts: Date.now(), files: [], fileObjs: [], gif: g, pending: true };
    st.pending.push(p);
    const prev = st.pending.length > 1 ? st.pending[st.pending.length - 2] : st.msgs[st.msgs.length - 1];
    messagesEl.appendChild(pendingEl(p, prev || null));
    scrollBottom();
    doSend(p);
    if (!touch) chatInput.focus();
  }
  gifBtn.addEventListener('click', e => { e.stopPropagation(); if (gifPick.hidden) openGifs(); else closeGifs(); });
  gifQ.addEventListener('input', () => {
    clearTimeout(G.timer);
    G.timer = setTimeout(() => loadGifs(gifQ.value.trim(), false), 380);
  });
  gifQ.addEventListener('keydown', e => {
    if (e.key === 'Enter') { e.preventDefault(); clearTimeout(G.timer); loadGifs(gifQ.value.trim(), false); }
  });
  gifBody.addEventListener('scroll', () => {
    if (gifBody.scrollTop + gifBody.clientHeight > gifBody.scrollHeight - 240) loadGifs(G.q, true);
  }, { passive: true });
  document.addEventListener('click', e => {
    if (!gifPick.hidden && !gifPick.contains(e.target) && e.target !== gifBtn) closeGifs();
  });

  function openLightbox(url, alt) {
    const box = $('lightbox'), img = box.querySelector('img');
    img.src = url; img.alt = alt || '';
    box.classList.add('on');
  }
  $('lightbox').addEventListener('click', () => $('lightbox').classList.remove('on'));

  // ============================================================ POLLING
  let pollTimer = 0, polling = false, pollAgain = false, failCount = 0;
  function requestPoll() {
    if (!S.me) return;
    if (polling) { pollAgain = true; return; }
    clearTimeout(pollTimer);
    pollTimer = setTimeout(poll, 60);
  }
  function pollInterval() {
    if (failCount) return Math.min(30000, 2000 * 2 ** Math.min(failCount, 4));
    const inVoice = !!VD.voice.channel;
    if (document.hidden) return inVoice ? 3000 : 15000;
    return inVoice ? 1500 : 2000;
  }
  async function poll() {
    clearTimeout(pollTimer);
    if (polling || !S.me) return;
    polling = true;
    const body = { since: S.cursor, ch: S.cid || 0, typing: S.typingPing ? 1 : 0, voice: VD.voice.beat() };
    S.typingPing = false;
    let more = false;
    try {
      const r = await api('poll', body);
      failCount = 0;
      more = r.more;
      applyPoll(r);
    } catch (e) {
      failCount++;
    }
    polling = false;
    const again = pollAgain || more;
    pollAgain = false;
    pollTimer = setTimeout(poll, again ? 150 : pollInterval());
  }
  function applyPoll(r) {
    if (r.voice_status === 'moved') VD.voice.leave('Ses bağlantın başka bir sekmeye ya da cihaza geçti.');
    else if (r.voice_status === 'gone') VD.voice.reclaim();
    addUsers(r.users);
    for (const m of r.msgs) ingest(m);
    S.cursor = Math.max(S.cursor, r.cursor);
    S.voice = r.voice;
    S.online = new Set(r.online);
    S.typing = r.typing;
    VD.voice.applyStates(r.voice);
    // a different rev, a den gone or a den added: refetch the structure
    const revs = r.revs || {};
    let stale = Object.keys(revs).length !== S.servers.size;
    for (const [sid, rev] of Object.entries(revs)) {
      const s = S.servers.get(+sid);
      if (!s || s.rev !== rev) stale = true;
    }
    if (stale) reboot();
    scheduleUi();
  }
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) { requestPoll(); markRead(); scheduleUi(); }
  });
  window.addEventListener('focus', () => markRead());

  // ============================================================ VOICE HOOKS
  let voiceReady = false;
  function initVoice() {
    if (voiceReady) return;
    voiceReady = true;
    VD.voice.init({
      api, toast, requestPoll, esc, initials,
      userName: uid => (S.users.get(uid) || {}).name,
      tintOf: uid => tintOf(uid),
      meId: () => S.me.id,
      prettyInvite: sid => prettyUrl(inviteUrl(sid)),
      copyInvite,
      onSpeaking: (uid, sp) => {
        if (sp) S.speaking.add(uid); else S.speaking.delete(uid);
        const vch = VD.voice.channel;
        chanList.querySelectorAll(`.vu-row[data-vuid="${uid}"][data-vch="${vch}"]`).forEach(r => r.classList.toggle('speaking', sp));
      },
      onState: () => scheduleUi(),
    });
  }
  $('meMute').addEventListener('click', () => VD.voice.toggleMute());
  $('meDeaf').addEventListener('click', () => VD.voice.toggleDeafen());
  $('vpLeave').addEventListener('click', () => VD.voice.leave());
  $('vpShare').addEventListener('click', () => VD.voice.toggleShare());
  $('vpWhere').addEventListener('click', () => { const c = S.chans.get(VD.voice.channel); if (c) go(c.sid, c.id); });
  $('vBar').addEventListener('click', () => { const c = S.chans.get(VD.voice.channel); if (c) go(c.sid, c.id); });

  // ============================================================ HEADER / PANELS
  $('inviteBtn').addEventListener('click', () => copyInvite(S.sid));
  $('membersBtn').addEventListener('click', () => {
    if (narrow()) { app.classList.toggle('members-open'); return; }
    app.classList.toggle('show-members');
    setPref('vd-members', app.classList.contains('show-members') ? '1' : '0');
    scheduleUi();
  });
  if (pref('vd-members', '1') === '1') app.classList.add('show-members');
  function setChatOpen(open) {
    app.classList.toggle('chat-off', !open);
    if (!narrow()) setPref('vd-vchat', open ? '1' : '0');
    if (open) { scrollBottom(); markRead(); }
    scheduleUi();
  }
  $('chatBtn').addEventListener('click', () => setChatOpen(app.classList.contains('chat-off')));
  $('chatClose').addEventListener('click', () => setChatOpen(false));
  $('sheetGrab').addEventListener('click', () => setChatOpen(app.classList.contains('chat-off')));
  chatInput.addEventListener('focus', () => { if (narrow() && app.classList.contains('view-voice') && app.classList.contains('chat-off')) setChatOpen(true); });

  function setNav(open) { app.classList.toggle('nav-open', open); if (!open) app.classList.remove('members-open'); }
  $('menuBtn').addEventListener('click', () => setNav(!app.classList.contains('nav-open')));
  $('scrim').addEventListener('click', () => setNav(false));

  // server menu
  let menuEl = null;
  function closeMenu() { if (menuEl) { menuEl.remove(); menuEl = null; } }
  $('sideHead').addEventListener('click', e => {
    e.stopPropagation();
    if (menuEl) { closeMenu(); return; }
    const s = S.servers.get(S.sid);
    if (!s) return;
    const mgr = isMgr(s);
    menuEl = document.createElement('div');
    menuEl.className = 'menu';
    menuEl.style.cssText = 'top:60px;left:10px;right:10px';
    menuEl.innerHTML =
      `<button class="teal" data-m="invite">Arkadaşını davet et ${icon('link')}</button>` +
      (mgr ? `<button data-m="text">Metin kanalı ekle <span>#</span></button><button data-m="voice">Ses kanalı ekle ${icon('vol')}</button>` +
             `<button data-m="settings">Den ayarları ${icon('gear')}</button>` : '') +
      `<button data-m="new">Başka bir den kur / katıl ${icon('plus')}</button>` +
      (s.role !== 'owner' ? `<hr><button class="warn" data-m="leave">Denden ayrıl ${icon('out')}</button>` : '');
    $('side').appendChild(menuEl);
    menuEl.addEventListener('click', async ev => {
      const b = ev.target.closest('[data-m]');
      if (!b) return;
      closeMenu();
      const a = b.dataset.m;
      if (a === 'invite') openInvite(s.id);
      if (a === 'text' || a === 'voice') openCreateChannel(a);
      if (a === 'settings') openServerSettings(s.id);
      if (a === 'new') openAddServer();
      if (a === 'leave') {
        if (!(await confirmBox(s.name + ' denden ayrılsın mı?', 'Tekrar katılmak için yeni bir davet gerekir.', 'Ayrıl', true))) return;
        try {
          if (VD.voice.server === s.id) VD.voice.leave();
          await api('server_leave', { id: s.id });
          await reboot();
          go(S.order[0] || 0, 0);
        } catch (ex) { toast(errText(ex)); }
      }
    });
  });
  document.addEventListener('click', e => { if (menuEl && !menuEl.contains(e.target)) closeMenu(); });
  $('railAdd').addEventListener('click', () => openAddServer());
  $('meWho').addEventListener('click', () => openSettings('acc'));
  $('meGear').addEventListener('click', () => openSettings(VD.voice.channel ? 'audio' : 'acc'));

  document.addEventListener('keydown', e => {
    if (e.key !== 'Escape') return;
    if (!gifPick.hidden) { closeGifs(); chatInput.focus(); return; }
    if ($('lightbox').classList.contains('on')) { $('lightbox').classList.remove('on'); return; }
    if (!modalBack.hidden) { closeModal(); return; }
    if (menuEl) { closeMenu(); return; }
    if (app.classList.contains('nav-open') || app.classList.contains('members-open')) { setNav(false); return; }
    if (document.activeElement === chatInput) chatInput.blur();
  });

  // ============================================================ MODALS
  function cardsHtml() {
    return `<div class="cards">
      <form class="lcard" data-form="create" novalidate><div class="k">Yeni den</div>
        <div class="field"><label>Den adı</label><div class="in"><input name="name" maxlength="48" placeholder="ör. Cuma akşamcıları" autocomplete="off"></div></div>
        <button class="btn primary" type="submit">Den kur</button><div class="err"></div>
        <div class="note">İçinde bir metin ve bir ses kanalıyla gelir. Sahibi sensin.</div></form>
      <form class="lcard" data-form="join" novalidate><div class="k">Davetle katıl</div>
        <div class="field"><label>Davet bağlantısı ya da kodu</label><div class="in"><input name="code" maxlength="200" placeholder="ör. k3m9x2pqra" autocomplete="off" autocapitalize="none" spellcheck="false"></div></div>
        <button class="btn" type="submit">Katıl</button><div class="err"></div>
        <div class="note">Arkadaşının gönderdiği bağlantıyı olduğu gibi yapıştırabilirsin.</div></form>
    </div>`;
  }
  function wireCards(root) {
    const create = root.querySelector('[data-form=create]'), join = root.querySelector('[data-form=join]');
    create.addEventListener('submit', async e => {
      e.preventDefault();
      const name = create.name.value.trim(), err = create.querySelector('.err'), btn = create.querySelector('button');
      err.textContent = '';
      if (!name) { err.textContent = ERR.bad_name; create.name.focus(); return; }
      btn.disabled = true;
      try {
        const r = await api('server_create', { name });
        await reboot();
        closeModal();
        welcomeEl.innerHTML = '';
        go(r.id, 0);
        setTimeout(() => openInvite(r.id, true), 250);
      } catch (ex) { err.textContent = errText(ex); }
      btn.disabled = false;
    });
    join.addEventListener('submit', async e => {
      e.preventDefault();
      const code = parseInvite(join.code.value), err = join.querySelector('.err'), btn = join.querySelector('button');
      err.textContent = '';
      if (!code) { err.textContent = 'Bir davet bağlantısı ya da kodu yapıştır.'; join.code.focus(); return; }
      btn.disabled = true;
      try {
        const r = await api('invite_accept', { code });
        await reboot();
        closeModal();
        welcomeEl.innerHTML = '';
        go(r.id, 0);
      } catch (ex) { err.textContent = errText(ex); }
      btn.disabled = false;
    });
  }
  function openAddServer() {
    const m = openModal(`<h3>Bir den ekle</h3><div class="sub">Kendi denini kur ya da bir arkadaşının denine katıl.</div>${cardsHtml()}
      <div class="acts"><button class="btn" data-close>Kapat</button></div>`, { wide: true });
    wireCards(m);
    setTimeout(() => { if (!touch) m.querySelector('input').focus(); }, 30);
  }

  function openInvite(sid, fresh) {
    const s = S.servers.get(sid);
    if (!s) return;
    const url = inviteUrl(sid);
    const m = openModal(`<h3>${fresh ? 'Denin hazır — arkadaşlarını çağır' : 'Arkadaşlarını ' + esc(s.name) + ' denine çağır'}</h3>
      <div class="sub">Bu bağlantıyla gelen herkes hesap açıp doğrudan dene katılır.</div>
      <div class="copyrow"><div class="in"><input readonly value="${esc(url)}"></div><button class="btn primary small" data-copy>Kopyala</button></div>
      <div class="note">Davet kodu: <b>${esc(s.invite)}</b>${isMgr(s) ? ' · Den ayarlarından yenileyebilirsin.' : ''}</div>
      <div class="acts"><button class="btn" data-close>Tamam</button></div>`);
    const inp = m.querySelector('input');
    inp.addEventListener('focus', () => inp.select());
    m.querySelector('[data-copy]').addEventListener('click', ev => {
      copyText(url).then(() => { ev.target.textContent = 'Kopyalandı!'; setTimeout(() => { ev.target.textContent = 'Kopyala'; }, 1400); })
        .catch(() => inp.select());
    });
  }

  function openCreateChannel(kind) {
    const s = S.servers.get(S.sid);
    if (!isMgr(s)) return;
    let k = kind === 'voice' ? 'voice' : 'text';
    const m = openModal(`<h3>Kanal ekle</h3><div class="sub">${esc(s.name)} denine</div>
      <div class="kind-pick">
        <button type="button" data-k="text"><span class="ico">#</span><span><b>Metin</b><small>Mesajlar, resimler, dosyalar, bağlantılar</small></span></button>
        <button type="button" data-k="voice"><span class="ico">${icon('vol')}</span><span><b>Ses</b><small>Sesli sohbet, ekran paylaşımı ve yanında yazışma</small></span></button>
      </div>
      <div class="field"><label>Kanal adı</label><div class="in"><span class="pre" data-pre>#</span><input id="ncName" maxlength="48" autocomplete="off" placeholder="yeni-kanal" autofocus></div></div>
      <div class="err" id="ncErr"></div>
      <div class="acts"><button class="btn" data-close>Vazgeç</button><button class="btn primary" id="ncOk">Kanal oluştur</button></div>`);
    const sync = () => {
      m.querySelectorAll('[data-k]').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.k === k)));
      m.querySelector('[data-pre]').hidden = k !== 'text';
      m.querySelector('#ncName').placeholder = k === 'text' ? 'yeni-kanal' : 'Oyun gecesi';
    };
    sync();
    m.querySelector('.kind-pick').addEventListener('click', e => { const b = e.target.closest('[data-k]'); if (b) { k = b.dataset.k; sync(); } });
    const submit = async () => {
      const name = m.querySelector('#ncName').value.trim();
      if (!name) { m.querySelector('#ncErr').textContent = ERR.bad_name; return; }
      m.querySelector('#ncOk').disabled = true;
      try {
        const r = await api('channel_create', { sid: s.id, name, kind: k });
        await reboot();
        closeModal();
        go(s.id, r.id);
      } catch (ex) { m.querySelector('#ncErr').textContent = errText(ex); m.querySelector('#ncOk').disabled = false; }
    };
    m.querySelector('#ncOk').addEventListener('click', submit);
    m.querySelector('#ncName').addEventListener('keydown', e => { if (e.key === 'Enter') submit(); });
  }

  function openChannelSettings(cid) {
    const c = S.chans.get(cid), s = c && S.servers.get(c.sid);
    if (!c || !isMgr(s)) return;
    const m = openModal(`<h3>Kanal ayarları</h3><div class="sub">${c.kind === 'text' ? '#' : ''}${esc(c.name)} · ${c.kind === 'text' ? 'metin' : 'ses'} kanalı</div>
      <div class="field"><label>Kanal adı</label><div class="in"><input id="ceName" maxlength="48" value="${esc(c.name)}" autofocus></div></div>
      <div class="err" id="ceErr"></div>
      <div class="acts" style="justify-content:space-between"><button class="btn danger small" id="ceDel">Kanalı sil</button>
        <span style="display:flex;gap:10px"><button class="btn" data-close>Vazgeç</button><button class="btn primary" id="ceOk">Kaydet</button></span></div>`);
    const save = async () => {
      const name = m.querySelector('#ceName').value.trim();
      if (!name) { m.querySelector('#ceErr').textContent = ERR.bad_name; return; }
      try { await api('channel_update', { id: cid, name }); await reboot(); closeModal(); }
      catch (ex) { m.querySelector('#ceErr').textContent = errText(ex); }
    };
    m.querySelector('#ceOk').addEventListener('click', save);
    m.querySelector('#ceName').addEventListener('keydown', e => { if (e.key === 'Enter') save(); });
    m.querySelector('#ceDel').addEventListener('click', async () => {
      if (!(await confirmBox((c.kind === 'text' ? '#' : '') + c.name + ' silinsin mi?', 'Kanaldaki bütün mesajlar ve dosyalar da silinir. Geri alınamaz.', 'Kanalı sil', true))) return;
      try {
        if (VD.voice.channel === cid) VD.voice.leave();
        await api('channel_delete', { id: cid });
        await reboot();
      } catch (ex) { toast(errText(ex)); }
    });
  }

  function openServerSettings(sid) {
    const s = S.servers.get(sid);
    if (!isMgr(s)) return;
    const owner = s.role === 'owner';
    const weight = r => (r === 'owner' ? 0 : r === 'admin' ? 1 : 2);
    const mem = s.members.slice().sort((a, b) => weight(a.role) - weight(b.role) || nameOf(a.id).localeCompare(nameOf(b.id), 'tr'));
    const rows = mem.map(x => {
      const u = S.users.get(x.id) || {};
      const acts = [];
      if (x.id !== S.me.id && x.role !== 'owner') {
        if (owner) acts.push(`<button class="btn small" data-role="${x.id}" data-to="${x.role === 'admin' ? 'member' : 'admin'}">${x.role === 'admin' ? 'Yöneticiliği al' : 'Yönetici yap'}</button>`);
        if (owner || x.role === 'member') acts.push(`<button class="btn small danger" data-kick="${x.id}">Çıkar</button>`);
      }
      return `<div class="mrow" style="--who:${tintOf(x.id).fg}">${avHtml(x.id)}<span class="nm">${esc(u.name || '')} <span class="note">@${esc(u.username || '')}</span></span>
        ${x.role !== 'member' ? `<span class="role ${x.role}">${x.role === 'owner' ? 'SAHİP' : 'YÖNETİCİ'}</span>` : ''}${acts.join('')}</div>`;
    }).join('');
    const m = openModal(`<h3>Den ayarları</h3>
      <div class="settings-sec"><div class="field"><label>Den adı</label>
        <div class="copyrow"><div class="in"><input id="ssName" maxlength="48" value="${esc(s.name)}"></div><button class="btn small primary" id="ssSave">Kaydet</button></div></div>
        <div class="err" id="ssErr"></div></div>
      <div class="settings-sec"><div class="field"><label>Davet bağlantısı</label>
        <div class="copyrow"><div class="in"><input readonly id="ssUrl" value="${esc(inviteUrl(sid))}"></div><button class="btn small" id="ssCopy">Kopyala</button></div></div>
        <div class="note">Bağlantıyı bilen herkes katılabilir. <button class="linkish" id="ssReset">Yenile</button> — eski bağlantı çalışmaz olur.</div></div>
      <div class="settings-sec"><div class="k">Üyeler — ${mem.length}</div><div class="mem-admin">${rows}</div></div>
      ${owner ? `<div class="settings-sec"><div><button class="btn danger small" id="ssDel">Deni sil</button></div>
        <div class="note">Bütün kanallar, mesajlar ve dosyalar kalıcı olarak silinir.</div></div>` : ''}
      <div class="acts"><button class="btn" data-close>Kapat</button></div>`, { wide: true });
    const refresh = async () => { await reboot(); if (S.servers.get(sid)) openServerSettings(sid); else closeModal(); };
    m.querySelector('#ssSave').addEventListener('click', async () => {
      try { await api('server_update', { id: sid, name: m.querySelector('#ssName').value.trim() }); await refresh(); toast('Kaydedildi', true); }
      catch (ex) { m.querySelector('#ssErr').textContent = errText(ex); }
    });
    m.querySelector('#ssCopy').addEventListener('click', () => copyInvite(sid));
    m.querySelector('#ssReset').addEventListener('click', async () => {
      if (!(await confirmBox('Davet bağlantısı yenilensin mi?', 'Eski bağlantıyla artık kimse katılamaz.', 'Yenile', false))) { openServerSettings(sid); return; }
      try { await api('invite_reset', { id: sid }); await refresh(); toast('Yeni davet bağlantısı hazır', true); }
      catch (ex) { toast(errText(ex)); }
    });
    m.querySelector('.mem-admin').addEventListener('click', async e => {
      const kick = e.target.closest('[data-kick]'), role = e.target.closest('[data-role]');
      if (kick) {
        const uid = +kick.dataset.kick;
        if (!(await confirmBox(nameOf(uid) + ' denden çıkarılsın mı?', 'Yeni bir davetle tekrar katılabilir.', 'Çıkar', true))) { openServerSettings(sid); return; }
        try { await api('member_kick', { sid, uid }); } catch (ex) { toast(errText(ex)); }
        refresh();
      }
      if (role) {
        try { await api('member_role', { sid, uid: +role.dataset.role, role: role.dataset.to }); } catch (ex) { toast(errText(ex)); }
        refresh();
      }
    });
    const del = m.querySelector('#ssDel');
    if (del) del.addEventListener('click', async () => {
      if (!(await confirmBox(s.name + ' silinsin mi?', 'Bütün kanallar, mesajlar ve dosyalar herkes için silinir. Geri alınamaz.', 'Deni sil', true))) { openServerSettings(sid); return; }
      try {
        if (VD.voice.server === sid) VD.voice.leave();
        await api('server_delete', { id: sid });
        await reboot();
        go(S.order[0] || 0, 0);
      } catch (ex) { toast(errText(ex)); }
    });
  }

  function openSettings(tab) {
    let tint = S.me.tint;
    const m = openModal(`<h3>Ayarlar</h3>
      <div class="seg tabs" id="stTabs"><button data-tab="acc">Hesap</button><button data-tab="audio">Ses</button></div>
      <div id="tabAcc">
        <div class="settings-sec">
          <div class="field"><label>Görünen ad</label><div class="in"><input id="usName" maxlength="32" value="${esc(S.me.name)}"></div></div>
          <div class="field"><label>Renk</label><div class="tint-pick" id="usTint">${TINTS.map((t, i) =>
            `<button type="button" data-t="${i}" style="--av-bg:${t.bg};--av-fg:${t.fg}" aria-label="Renk ${i + 1}">${esc(initials(S.me.name))}</button>`).join('')}</div></div>
          <div style="display:flex;align-items:center;gap:12px"><button class="btn primary small" id="usSave">Kaydet</button><span class="note">Giriş adın: @${esc(S.me.username)}</span></div>
          <div class="err" id="usErr"></div>
        </div>
        <div class="settings-sec">
          <div class="k">Şifre değiştir</div>
          <div class="field"><label>Mevcut şifre</label><div class="in"><input type="password" id="pwOld" autocomplete="current-password"></div></div>
          <div class="field"><label>Yeni şifre</label><div class="in"><input type="password" id="pwNew" autocomplete="new-password" placeholder="en az 8 karakter"></div></div>
          <div><button class="btn small" id="pwSave">Şifreyi değiştir</button></div>
          <div class="note">Diğer cihazlardaki oturumların kapanır.</div>
          <div class="err" id="pwErr"></div>
        </div>
        <div class="settings-sec"><div><button class="btn danger small" id="usOut">${icon('out')} Çıkış yap</button></div></div>
      </div>
      <div id="tabAudio" hidden></div>
      <div class="acts"><button class="btn" data-close>Kapat</button></div>`);
    const setTab = t => {
      m.querySelectorAll('#stTabs button').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.tab === t)));
      m.querySelector('#tabAcc').hidden = t !== 'acc';
      m.querySelector('#tabAudio').hidden = t !== 'audio';
      if (t === 'audio') VD.voice.mountPanel(m.querySelector('#tabAudio'));
      else VD.voice.closePanel();
    };
    const syncTint = () => m.querySelectorAll('#usTint button').forEach(b => b.setAttribute('aria-pressed', String(+b.dataset.t === tint)));
    syncTint();
    m.querySelector('#stTabs').addEventListener('click', e => { const b = e.target.closest('[data-tab]'); if (b) setTab(b.dataset.tab); });
    m.querySelector('#usTint').addEventListener('click', e => { const b = e.target.closest('[data-t]'); if (b) { tint = +b.dataset.t; syncTint(); } });
    m.querySelector('#usSave').addEventListener('click', async () => {
      try {
        const r = await api('profile', { name: m.querySelector('#usName').value.trim(), tint });
        S.me = r.me;
        S.users.set(r.me.id, r.me);
        await reboot();
        if (S.cid) { renderChannel(); scrollBottom(); }
        toast('Profil kaydedildi', true);
      } catch (ex) { m.querySelector('#usErr').textContent = errText(ex); }
    });
    m.querySelector('#pwSave').addEventListener('click', async () => {
      const err = m.querySelector('#pwErr');
      err.textContent = '';
      try {
        await api('password', { old: m.querySelector('#pwOld').value, new: m.querySelector('#pwNew').value });
        m.querySelector('#pwOld').value = m.querySelector('#pwNew').value = '';
        toast('Şifren değişti', true);
      } catch (ex) { err.textContent = errText(ex); }
    });
    m.querySelector('#usOut').addEventListener('click', async () => {
      VD.voice.leave();
      try { await api('logout', {}); } catch (e) {}
      location.href = location.pathname;
    });
    setTab(tab === 'audio' ? 'audio' : 'acc');
  }

  // ============================================================ GO
  startApp();
})();
