/* VoiceDen — voice engine.
 *
 * A voice channel is a full WebRTC mesh over PeerJS: every pair of people
 * holds one data connection (state, screen-share signals) and one audio call.
 * Who is in the channel comes from the server (api voice_join / poll), not from
 * a peer claiming the room ID — so there is no host to lose and no room to split.
 *
 * Dialing rule: of any pair, the one that joined later (higher seq) dials. Both
 * sides read the same seq from the server, so a pair never calls itself twice,
 * and a dropped link is re-dialed by the same side the next time the roster
 * shows the pair apart.
 *
 * The app talks to this file through VD.voice and hands it hooks (VD.voice.init).
 */
(() => {
  'use strict';
  const VD = window.VD = window.VD || {};

  const SPEAK_THRESHOLD = 0.028;   // RMS
  const SPEAK_HOLD_MS = 260;
  const GATE_HOLD_MS = 320;
  const VU_FULL = 0.16;
  const REDIAL_MS = 6000;
  const UNVERIFIED_MS = 10000;     // an inbound peer the roster never confirms is dropped

  let H = null;                    // hooks from the app

  // ---------- session ----------
  let peer = null;
  let vc = null;                   // { ch, sid, seq, at } while connected
  let joining = false;
  let localStream = null;
  let screenStream = null;
  let sharerId = null;             // peer id on stage (=== peer.id when it's me)
  let roster = [];                 // server voice states for my channel
  const members = new Map();       // peerId -> { uid, verified, firstSeen, conn, call, audioEl, analyser, speaking, muted, deaf, holdUntil, screenCall, screenOutCall }
  const dialAt = new Map();        // peerId -> last time I dialed it
  let startedAt = 0, timerHandle = 0, loopOn = false;

  // ---------- prefs ----------
  function pref(key, fallback) {
    try { const v = localStorage.getItem(key); return v === null ? fallback : v; } catch (e) { return fallback; }
  }
  function setPref(key, val) { try { localStorage.setItem(key, val); } catch (e) {} }

  let muted    = pref('vd-muted', '0') === '1';
  let deafened = pref('vd-deaf', '0') === '1';
  let deafMutedMe = false;         // deafening muted the mic too; undeafen gives it back
  let ptt      = pref('vd-ptt', '0') === '1';
  let pttHeld  = false;
  let nsMode   = pref('vd-ns-mode', 'browser');
  if (['off', 'browser', 'model'].indexOf(nsMode) < 0) nsMode = 'browser';
  let gateOn   = pref('vd-gate', '0') === '1';
  let gateThr  = Math.max(0.002, Math.min(0.16, parseFloat(pref('vd-gate-thr', '0.029')) || 0.029));
  let micId    = pref('vd-mic', '');
  let outId    = pref('vd-out', '');
  if (ptt) muted = true;

  // ---------- audio graph ----------
  // raw mic → source → [rnnoise] → micTap (analyser) → gate → destination = sendStream.
  // Peers are called with sendStream, whose track never changes: switching mics
  // only re-points the source, so nothing is renegotiated.
  let audioCtx = null;
  let gateSrc = null, gateNode = null, gateIsWorklet = false, gateDest = null, sendStream = null;
  let micTap = null, localAnalyser = null;
  let localSpeaking = false, localHoldUntil = 0, gateHoldUntil = 0;
  let denoiseNode = null, workletLoad = null, denoiseFailed = false;
  let gateLoad = null;

  const canSetSink = 'setSinkId' in HTMLMediaElement.prototype;
  const canShareScreen = !!(navigator.mediaDevices && navigator.mediaDevices.getDisplayMedia);

  function ensureCtx() {
    if (audioCtx) return audioCtx;
    const AC = window.AudioContext || window.webkitAudioContext;
    // RNNoise is trained on 48 kHz and has no resampler — ask for it up front
    try { audioCtx = new AC({ sampleRate: 48000, latencyHint: 'interactive' }); }
    catch (e) { audioCtx = new AC(); }
    return audioCtx;
  }

  // the gate worklet keeps gating while the tab is in the background; without
  // AudioWorklet support a GainNode driven from the UI loop stands in
  function loadGate() {
    ensureCtx();
    if (gateLoad) return gateLoad;
    gateLoad = (window.AudioWorkletNode && audioCtx.audioWorklet)
      ? audioCtx.audioWorklet.addModule('js/gate-worklet.js').then(() => true, () => false)
      : Promise.resolve(false);
    return gateLoad;
  }

  async function ensureDenoiser() {
    if (denoiseNode || denoiseFailed) return denoiseNode;
    ensureCtx();
    if (!(window.AudioWorkletNode && audioCtx.audioWorklet)) { denoiseFailed = 'unsupported'; return null; }
    if (audioCtx.sampleRate !== 48000) { denoiseFailed = 'rate'; return null; }
    try {
      if (!workletLoad) workletLoad = audioCtx.audioWorklet.addModule('rnnoise-worklet.js');
      syncNsUi();
      await workletLoad;
      denoiseNode = new AudioWorkletNode(audioCtx, 'rnnoise', {
        numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1],
        channelCount: 1, channelCountMode: 'explicit', channelInterpretation: 'speakers'
      });
      denoiseNode.port.onmessage = e => {
        const d = e.data || {};
        if (d.error) { denoiseFailed = 'load'; syncNsUi(); }
        if (d.ready) syncNsUi();
      };
      denoiseNode.onprocessorerror = () => { denoiseFailed = 'load'; syncNsUi(); };
    } catch (e) {
      workletLoad = null;
      denoiseFailed = 'load';
      return null;
    }
    return denoiseNode;
  }

  async function wireGate(stream) {
    ensureCtx();
    if (!gateNode) {
      const worklet = await loadGate();
      gateDest = audioCtx.createMediaStreamDestination();
      micTap = audioCtx.createAnalyser();
      micTap.fftSize = 512;
      if (worklet) {
        try {
          gateNode = new AudioWorkletNode(audioCtx, 'vd-gate', {
            numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1],
            channelCount: 1, channelCountMode: 'explicit'
          });
          gateIsWorklet = true;
        } catch (e) { gateNode = null; }
      }
      if (!gateNode) { gateNode = audioCtx.createGain(); gateIsWorklet = false; }
      micTap.connect(gateNode);
      gateNode.connect(gateDest);
      sendStream = gateDest.stream;
      syncGateNode();
    }
    if (gateSrc) { try { gateSrc.disconnect(); } catch (e) {} }
    gateSrc = audioCtx.createMediaStreamSource(stream);
    localAnalyser = micTap;     // after the denoiser: meters show what the others hear
    rewireChain();
    if (!gateIsWorklet) gateNode.gain.setValueAtTime(gateOn ? 0 : 1, audioCtx.currentTime);
    gateHoldUntil = 0;
    if (audioCtx.state === 'suspended') audioCtx.resume().catch(() => {});
    return sendStream;
  }
  function syncGateNode() {
    if (gateNode && gateIsWorklet) gateNode.port.postMessage({ on: gateOn, thr: gateThr });
  }

  // once created the denoiser stays in the chain and is switched by its bypass
  // flag — re-patching a live graph clicks, a flag does not
  function rewireChain() {
    if (!gateSrc || !micTap) return;
    try { gateSrc.disconnect(); } catch (e) {}
    if (denoiseNode) { try { denoiseNode.disconnect(); } catch (e) {} }
    if (denoiseNode && !denoiseFailed) { gateSrc.connect(denoiseNode); denoiseNode.connect(micTap); }
    else gateSrc.connect(micTap);
    if (denoiseNode) denoiseNode.port.postMessage({ bypass: nsMode !== 'model' });
  }
  function setGateOpen(open) {      // fallback gate only
    if (!gateNode || gateIsWorklet) return;
    gateNode.gain.setTargetAtTime(open ? 1 : 0, audioCtx.currentTime, open ? 0.004 : 0.02);
  }
  function makeAnalyser(stream) {
    const src = audioCtx.createMediaStreamSource(stream);
    const an = audioCtx.createAnalyser();
    an.fftSize = 512;
    src.connect(an);
    return an;
  }
  function rms(an) {
    const buf = new Uint8Array(an.fftSize);
    an.getByteTimeDomainData(buf);
    let sum = 0;
    for (let i = 0; i < buf.length; i++) { const v = (buf[i] - 128) / 128; sum += v * v; }
    return Math.sqrt(sum / buf.length);
  }

  function blip(freq, dur = 0.09, gainV = 0.06) {
    if (!audioCtx || deafened) return;
    try {
      const o = audioCtx.createOscillator(), g = audioCtx.createGain();
      o.frequency.value = freq; o.type = 'sine';
      g.gain.setValueAtTime(gainV, audioCtx.currentTime);
      g.gain.exponentialRampToValueAtTime(0.0001, audioCtx.currentTime + dur);
      o.connect(g).connect(audioCtx.destination);
      o.start(); o.stop(audioCtx.currentTime + dur);
    } catch (e) {}
  }

  // ---------- dom (stage + dock + audio panel live in index.html) ----------
  const $ = id => document.getElementById(id);
  let D = {};
  function grabDom() {
    D = {
      memberList: $('memberList'), stage: $('stage'), stageVideo: $('stageVideo'), stageLabel: $('stageLabel'),
      stagewrap: $('stagewrap'), timer: $('vTimer'),
      muteBtn: $('muteBtn'), deafenBtn: $('deafenBtn'), audioBtn: $('audioBtn'), shareBtn: $('shareBtn'), leaveBtn: $('leaveBtn'),
      vu: Array.from(document.querySelectorAll('#vu i')),
      audioPanel: $('audioPanel'), micSel: $('micSel'), outSel: $('outSel'), outRow: $('outRow'), micLvl: $('micLvl'),
      micTest: $('micTest'), nsSeg: $('nsSeg'), nsNote: $('nsNote'), pttToggle: $('pttToggle'), pttNote: $('pttNote'),
      gateToggle: $('gateToggle'), gateRow: $('gateRow'), gateWrap: $('gateWrap'), gateLvl: $('gateLvl'), gateThr: $('gateThr'),
    };
    D.nsButtons = Array.from(D.nsSeg.querySelectorAll('button'));
  }
  const label = btn => btn.querySelector('.label');

  // ---------- members ----------
  function getMember(id) {
    let m = members.get(id);
    if (!m) {
      m = { uid: null, verified: false, firstSeen: Date.now(), speaking: false, muted: false, deaf: false, holdUntil: 0 };
      const v = roster.find(r => r.peer === id);
      if (v) { m.uid = v.uid; m.verified = true; m.muted = v.mu; m.deaf = v.df; }
      members.set(id, m);
    }
    return m;
  }

  function removeMember(id, silent) {
    const m = members.get(id);
    if (!m) return;
    members.delete(id);
    if (m.audioEl) { m.audioEl.srcObject = null; m.audioEl.remove(); }
    try { m.conn && m.conn.close(); } catch (e) {}
    try { m.call && m.call.close(); } catch (e) {}
    try { m.screenCall && m.screenCall.close(); } catch (e) {}
    try { m.screenOutCall && m.screenOutCall.close(); } catch (e) {}
    if (sharerId === id) { sharerId = null; hideStage(); }
    if (!silent && m.verified) blip(330);
    if (m.uid != null) H.onSpeaking(m.uid, false);
    render();
  }

  function broadcast(obj) {
    const raw = JSON.stringify(obj);
    for (const m of members.values()) {
      if (m.conn && m.conn.open) { try { m.conn.send(raw); } catch (e) {} }
    }
  }

  function handleData(fromId, raw) {
    if (typeof raw !== 'string') return;
    let msg;
    try { msg = JSON.parse(raw); } catch (e) { return; }
    if (!msg || typeof msg !== 'object') return;
    const m = members.get(fromId);
    if (!m) return;
    switch (msg.type) {
      case 'hello':
        m.muted = !!msg.muted; m.deaf = !!msg.deaf;
        if (msg.sharing && !screenStream) sharerId = fromId;
        if (screenStream && !m.screenOutCall) callScreen(fromId);   // a late joiner gets the stage too
        updateShareBtn();
        render();
        break;
      case 'state':
        m.muted = !!msg.muted; m.deaf = !!msg.deaf;
        render();
        H.onState();
        break;
      case 'nudge':                       // someone posted: fetch it now, not at the next tick
        H.requestPoll();
        break;
      case 'screen-start':
        // both hit share at once: the lower peer id keeps the stage
        if (screenStream) {
          if (peer.id < fromId) break;
          stopScreenShare(true);
          H.toast(who(m) + ' ekranı devraldı');
        }
        sharerId = fromId;
        updateShareBtn();
        blip(660, 0.1);
        H.requestPoll();
        break;
      case 'screen-stop':
        if (sharerId === fromId) { sharerId = null; hideStage(); updateShareBtn(); H.requestPoll(); }
        break;
    }
  }
  const who = m => (m && m.uid != null && H.userName(m.uid)) || 'Birisi';

  function attachConn(conn) {
    const id = conn.peer;
    const m = getMember(id);
    // a re-dial replaces the old link; the old one's close must not drop the person
    if (m.conn && m.conn !== conn) { const old = m.conn; m.conn = null; try { old.close(); } catch (e) {} }
    m.conn = conn;
    conn.on('open', () => {
      if (m.conn !== conn) return;
      conn.send(JSON.stringify({ type: 'hello', muted, deaf: deafened, sharing: !!screenStream }));
    });
    conn.on('data', d => { if (members.get(id) === m && m.conn === conn) handleData(id, d); });
    const drop = () => { if (members.get(id) === m && m.conn === conn) removeMember(id); };
    conn.on('close', drop);
    conn.on('error', drop);
  }

  function attachCall(call) {
    const id = call.peer;
    const m = getMember(id);
    if (m.call && m.call !== call) { const old = m.call; m.call = null; try { old.close(); } catch (e) {} }
    m.call = call;
    call.on('stream', remote => {
      if (members.get(id) !== m || m.call !== call) return;
      let el = m.audioEl;
      if (!el) {
        el = document.createElement('audio');
        el.autoplay = true;
        document.body.appendChild(el);
        m.audioEl = el;
        if (outId && canSetSink) el.setSinkId(outId).catch(() => {});
      }
      el.srcObject = remote;
      el.muted = deafened;
      el.play().catch(() => {});
      try { m.analyser = makeAnalyser(remote); } catch (e) {}
    });
    call.on('close', () => { if (members.get(id) === m && m.call === call) removeMember(id); });
    call.on('error', () => {});
  }

  function dial(pid, uid) {
    const m = getMember(pid);
    m.uid = uid; m.verified = true;
    attachConn(peer.connect(pid, { reliable: true }));
    attachCall(peer.call(pid, sendStream));
    render();
  }

  // the server's roster for my channel: confirm who is who, drop who left,
  // dial the earlier joiners I have no link to
  function applyStates(all) {
    if (!vc || !peer) return;
    const list = (all || []).filter(v => v.ch === vc.ch);
    roster = list;
    const mine = list.find(v => v.peer === peer.id);
    if (mine) vc.seq = mine.seq;
    const byPeer = new Map(list.map(v => [v.peer, v]));
    const now = Date.now();
    for (const [pid, m] of [...members]) {
      const v = byPeer.get(pid);
      if (v) {
        m.uid = v.uid; m.verified = true;
        if (!(m.conn && m.conn.open)) { m.muted = v.mu; m.deaf = v.df; }
      } else if (m.verified || now - m.firstSeen > UNVERIFIED_MS) {
        removeMember(pid);
      }
    }
    for (const v of list) {
      if (v.peer === peer.id || !(v.seq < vc.seq)) continue;   // later joiners dial me
      const m = members.get(v.peer);
      if (m && (m.conn || m.call)) continue;
      if (now - (dialAt.get(v.peer) || 0) < REDIAL_MS) continue;
      dialAt.set(v.peer, now);
      dial(v.peer, v.uid);
    }
    render();
  }

  function openPeer() {
    return new Promise((resolve, reject) => {
      if (typeof Peer === 'undefined') { reject(new Error('peerjs')); return; }
      const p = new Peer();
      let done = false;
      const t = setTimeout(() => { if (!done) { done = true; try { p.destroy(); } catch (e) {} reject(new Error('timeout')); } }, 12000);
      p.on('open', () => { if (done) return; done = true; clearTimeout(t); resolve(p); });
      p.on('error', err => {
        if (done) return;
        done = true; clearTimeout(t);
        try { p.destroy(); } catch (e) {}
        reject(err);
      });
    });
  }

  function wirePeer(p) {
    p.on('connection', conn => {
      if (p !== peer) { try { conn.close(); } catch (e) {} return; }
      const m = getMember(conn.peer);
      attachConn(conn);
      if (!m.verified) H.requestPoll();     // not on my roster yet: ask the server who this is
      render();
    });
    p.on('call', call => {
      if (p !== peer) { try { call.close(); } catch (e) {} return; }
      if (call.metadata && call.metadata.kind === 'screen') { attachScreenCall(call); return; }
      call.answer(sendStream);
      attachCall(call);
    });
    p.on('error', err => {
      // a peer that vanished between roster and dial; the roster will settle it
      if (err && err.type === 'peer-unavailable') return;
    });
    p.on('disconnected', () => { if (p === peer && vc) { try { p.reconnect(); } catch (e) {} } });
  }

  // ---------- join / leave ----------
  const MIC_ERRORS = {
    NotAllowedError: 'Mikrofon erişimi engellendi. Adres çubuğundaki kilit/mikrofon simgesinden izin ver, sonra tekrar dene.',
    NotFoundError: 'Bu cihazda mikrofon bulunamadı.',
    NotReadableError: 'Mikrofonun meşgul — başka bir uygulama kullanıyor olabilir. Kapatıp tekrar dene.',
    OverconstrainedError: 'Mikrofonun istenen ayarları desteklemiyor.',
    SecurityError: 'Bu sayfa için mikrofon tarayıcı ayarlarıyla kapatılmış.'
  };
  const micError = e => MIC_ERRORS[e && e.name] || ('Mikrofona erişilemedi (' + (e && e.name || 'hata') + ').');

  function micConstraints() {
    // with the model on, the browser's own suppressor stands down — two denoisers
    // in series chew holes in speech
    const a = { echoCancellation: true, noiseSuppression: nsMode === 'browser', autoGainControl: true };
    if (micId) a.deviceId = { ideal: micId };
    return { audio: a };
  }

  async function join(ch) {
    if (joining || (vc && vc.ch === ch.id)) return;
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      H.toast(window.isSecureContext ? 'Bu tarayıcı mikrofon desteklemiyor.' : 'Mikrofon için sayfayı https:// ile aç.');
      return;
    }
    joining = true;
    H.onState();
    const switching = !!vc;
    if (switching) teardown(true);
    try {
      stopCheck();
      if (!localStream) {
        try { localStream = await navigator.mediaDevices.getUserMedia(micConstraints()); }
        catch (e) { throw new Error(micError(e)); }
      }
      ensureCtx();
      await wireGate(localStream);
      // a saved "Gelişmiş" choice is honoured on join, not only when clicked
      if (nsMode === 'model') {
        await ensureDenoiser();
        if (denoiseFailed) { nsMode = 'browser'; setPref('vd-ns-mode', 'browser'); }
        rewireChain();
      }
      applyTrackEnabled();
      let p;
      try { p = await openPeer(); }
      catch (e) { throw new Error('Ses sunucusuna (PeerJS) ulaşılamadı. Bağlantını kontrol edip tekrar dene.'); }
      peer = p;
      wirePeer(p);
      const r = await H.api('voice_join', { ch: ch.id, peer: p.id, mu: muted, df: deafened });
      vc = { ch: ch.id, sid: ch.sid, seq: r.seq, at: Date.now() };
      startTimer();
      if (!loopOn) { loopOn = true; requestAnimationFrame(speakingLoop); }
      applyStates(r.voice);
      updateShareBtn();
      syncDock();
      blip(880, 0.12);
    } catch (e) {
      teardown(false);
      H.toast(e && e.message && !/^[a-z-]+$/.test(e.message) ? e.message : 'Ses kanalına bağlanılamadı.');
    } finally {
      joining = false;
      H.onState();
      H.requestPoll();
    }
  }

  // after a long freeze the server may have expired my seat: take it again,
  // keeping the same peer and every link already open
  async function reclaim() {
    if (!vc || !peer) return;
    try {
      const r = await H.api('voice_join', { ch: vc.ch, peer: peer.id, mu: muted, df: deafened });
      if (vc) { vc.seq = r.seq; applyStates(r.voice); }
    } catch (e) {}
  }

  function teardown(keepMic) {
    if (screenStream) stopScreenShare(true);
    const pid = peer && peer.id;
    for (const id of [...members.keys()]) removeMember(id, true);
    dialAt.clear();
    try { peer && peer.destroy(); } catch (e) {}
    peer = null;
    vc = null;
    roster = [];
    sharerId = null;
    hideStage();
    stopTimer();
    if (localSpeaking) { localSpeaking = false; H.onSpeaking(H.meId(), false); }
    if (!keepMic) {
      if (gateSrc) { try { gateSrc.disconnect(); } catch (e) {} gateSrc = null; }
      if (localStream) { localStream.getTracks().forEach(t => { try { t.stop(); } catch (e) {} }); localStream = null; }
    }
    if (pid) H.api('voice_leave', { peer: pid }).catch(() => {});
    render();
  }

  function leave(note) {
    if (!vc && !joining) return;
    teardown(false);
    blip(440, 0.1);
    if (note) H.toast(note);
    H.onState();
    H.requestPoll();
  }

  // ---------- speaking / meters ----------
  function speakingLoop() {
    if (!vc) { loopOn = false; resetVu(); return; }
    const t = performance.now();
    if (localAnalyser) {
      const level = muted ? 0 : rms(localAnalyser);
      let gateOpen = true;
      if (gateOn) {
        if (level > gateThr) gateHoldUntil = t + GATE_HOLD_MS;
        gateOpen = t < gateHoldUntil;
        setGateOpen(gateOpen);
      }
      if (level > SPEAK_THRESHOLD && gateOpen) localHoldUntil = t + SPEAK_HOLD_MS;
      const sp = t < localHoldUntil;
      if (sp !== localSpeaking) {
        localSpeaking = sp;
        setTileSpeaking('self', sp);
        H.onSpeaking(H.meId(), sp);
      }
      const frac = Math.min(1, level / VU_FULL);
      const lit = Math.round(frac * D.vu.length);
      D.vu.forEach((b, i) => {
        const on = i < lit;
        b.classList.toggle('hot', on);
        b.style.transform = 'scaleY(' + (on ? 0.35 + (i + 1) / D.vu.length * 0.65 : 0.3) + ')';
      });
      if (!D.audioPanel.hidden) paintPanelMeters(frac, gateOpen && level > 0);
    }
    for (const [id, m] of members) {
      if (!m.analyser) continue;
      const level = rms(m.analyser);
      if (level > SPEAK_THRESHOLD) m.holdUntil = t + SPEAK_HOLD_MS;
      const sp = t < (m.holdUntil || 0);
      if (sp !== m.speaking) {
        m.speaking = sp;
        setTileSpeaking(id, sp);
        if (m.uid != null) H.onSpeaking(m.uid, sp);
      }
    }
    requestAnimationFrame(speakingLoop);
  }
  function resetVu() {
    D.vu.forEach(b => { b.classList.remove('hot'); b.style.transform = ''; });
  }
  function paintPanelMeters(frac, open) {
    D.micLvl.style.width = Math.round(frac * 100) + '%';
    if (gateOn) {
      D.gateLvl.style.width = Math.round(frac * 100) + '%';
      D.gateWrap.classList.toggle('open', open);
    }
  }

  // ---------- stage grid ----------
  const statusText = (speaking, isMuted, isDeaf) => speaking ? 'konuşuyor' : (isDeaf ? 'sesi kapalı' : (isMuted ? 'sessiz' : 'dinliyor'));

  function render() {
    if (!D.memberList) return;
    if (!vc) { D.memberList.innerHTML = ''; return; }
    D.memberList.innerHTML = '';
    D.memberList.appendChild(tile('self', H.meId(), localSpeaking, muted, deafened));
    const order = [...members].sort((a, b) => seqOf(a[0]) - seqOf(b[0]));
    for (const [id, m] of order) D.memberList.appendChild(tile(id, m.uid, m.speaking, m.muted, m.deaf));
    const n = members.size + 1;
    D.memberList.className = n > 4 ? 'n-many' : '';
    if (n < 4) {
      // the empty seat fills out the last row: on desktop the grid is plain 2-up,
      // on phones the first card spans the row, so the odd one out differs
      const t = inviteTile();
      if ((n + 1) % 2) t.classList.add('span-d');
      if (n % 2) t.classList.add('span-m');
      D.memberList.appendChild(t);
    }
    const first = D.memberList.firstElementChild;
    if (first) first.classList.add('lead');
    H.onState();
  }
  const seqOf = pid => { const v = roster.find(r => r.peer === pid); return v ? v.seq : 1e15; };

  function tile(id, uid, speaking, isMuted, isDeaf) {
    const div = document.createElement('div');
    const self = id === 'self';
    div.className = 'member' + (speaking ? ' speaking' : '') + (isMuted || isDeaf ? ' is-muted' : '');
    div.dataset.mid = id;
    const name = uid != null ? (H.userName(uid) || '…') : '…';
    const t = H.tintOf(uid);
    div.style.setProperty('--av-bg', t.bg);
    div.style.setProperty('--av-fg', t.fg);
    div.innerHTML = `
      <div class="badge-speak">KONUŞUYOR</div>
      <div class="badge-mute">${isDeaf ? 'SESİ KAPALI' : 'SESSİZ'}</div>
      <div class="avatar">${uid != null ? H.avatarHtml(uid) : H.esc(H.initials(name))}</div>
      <div class="m-bars"><i></i><i></i><i></i><i></i><i></i></div>
      <div class="member-info">
        <div class="member-name">${H.esc(name)}${self ? ' <span class="you">(sen)</span>' : ''}</div>
        <div class="member-status">${statusText(speaking, isMuted, isDeaf)}</div>
      </div>`;
    return div;
  }
  function inviteTile() {
    const el = document.createElement('button');
    el.type = 'button';
    el.className = 'invite';
    el.title = 'Davet bağlantısını kopyala';
    el.innerHTML = `<div class="plus">+</div><div class="cap">Bir arkadaşını çağır</div>
      <div class="lnk">${H.esc(H.prettyInvite(vc ? vc.sid : 0))}</div>`;
    el.addEventListener('click', () => H.copyInvite(vc ? vc.sid : 0, el.querySelector('.lnk')));
    return el;
  }
  function setTileSpeaking(id, sp) {
    const row = D.memberList.querySelector(`[data-mid="${CSS.escape(id)}"]`);
    if (!row) return;
    row.classList.toggle('speaking', sp);
    const st = row.querySelector('.member-status');
    if (st) {
      const m = id === 'self' ? { muted, deaf: deafened } : members.get(id) || {};
      st.textContent = statusText(sp, m.muted, m.deaf);
    }
  }

  function startTimer() {
    startedAt = Date.now();
    const p = n => String(n).padStart(2, '0');
    const tick = () => {
      const s = Math.max(0, Math.floor((Date.now() - startedAt) / 1000));
      if (D.timer) D.timer.textContent = p(Math.floor(s / 3600)) + ':' + p(Math.floor(s / 60) % 60) + ':' + p(s % 60);
    };
    tick();
    clearInterval(timerHandle);
    timerHandle = setInterval(tick, 1000);
  }
  function stopTimer() { clearInterval(timerHandle); timerHandle = 0; if (D.timer) D.timer.textContent = '00:00:00'; }

  // ---------- screen share ----------
  function setShareLabel(text) { label(D.shareBtn).textContent = text; }
  function updateShareBtn() {
    if (!canShareScreen) {
      D.shareBtn.disabled = true;
      D.shareBtn.title = 'Bu tarayıcı ekran paylaşamıyor.';
      setShareLabel('Paylaş');
      return;
    }
    const mine = !!screenStream;
    D.shareBtn.classList.toggle('on', mine);
    if (mine) {
      D.shareBtn.disabled = false;
      D.shareBtn.title = 'Ekran paylaşımını durdur';
      setShareLabel('Durdur');
    } else if (sharerId) {
      const w = who(members.get(sharerId));
      D.shareBtn.disabled = true;
      D.shareBtn.title = w + ' paylaşıyor';
      setShareLabel(w + ' paylaşıyor');
    } else {
      D.shareBtn.disabled = !vc;
      D.shareBtn.title = 'Ekranını paylaş';
      setShareLabel('Paylaş');
    }
  }

  // the player's mute is the viewer's, except for our own capture and while deafened
  let stageMine = false, stageUserMuted = false;
  function syncStageMute() { D.stageVideo.muted = stageMine || deafened || stageUserMuted; }

  function showStage(id, stream) {
    const mine = id === (peer && peer.id);
    stageMine = mine;
    D.stageVideo.srcObject = stream;
    syncStageMute();
    D.stageLabel.textContent = mine ? 'Senin ekranın' : who(members.get(id)) + ' — ekran';
    D.stage.hidden = false;
    D.stagewrap.classList.add('staging');
    if (outId && canSetSink) D.stageVideo.setSinkId(outId).catch(() => {});
    D.stageVideo.play().catch(() => {});
    H.onState();
  }
  function hideStage() {
    if (!D.stage) return;
    const fs = document.fullscreenElement || document.webkitFullscreenElement;
    if (fs && D.stage.contains(fs)) {
      const exit = document.exitFullscreen || document.webkitExitFullscreen;
      if (exit) { try { exit.call(document); } catch (e) {} }
    }
    if (D.stageVideo.webkitDisplayingFullscreen) { try { D.stageVideo.webkitExitFullscreen(); } catch (e) {} }
    D.stage.hidden = true;
    D.stagewrap.classList.remove('staging');
    try { D.stageVideo.pause(); } catch (e) {}
    D.stageVideo.srcObject = null;
    D.stageLabel.textContent = '';
    stageMine = false;
    stageUserMuted = false;
  }

  function callScreen(id) {
    if (!screenStream || !peer) return;
    const m = members.get(id);
    if (!m) return;
    try {
      const c = peer.call(id, screenStream, { metadata: { kind: 'screen' } });
      m.screenOutCall = c;
      c.on('error', () => {});
    } catch (e) {}
  }
  function attachScreenCall(call) {
    const id = call.peer;
    const m = getMember(id);
    try { m.screenCall && m.screenCall.close(); } catch (e) {}
    m.screenCall = call;
    call.answer();                      // receive only
    call.on('stream', remote => {
      if (m.screenCall !== call) return;
      sharerId = id;
      showStage(id, remote);
      updateShareBtn();
    });
    call.on('close', () => {            // NOT removeMember — they are still in the channel
      if (m.screenCall !== call) return;
      m.screenCall = null;
      if (sharerId === id) { sharerId = null; hideStage(); updateShareBtn(); }
    });
    call.on('error', () => {});
  }

  async function startScreenShare() {
    if (!canShareScreen || screenStream || sharerId || !peer || !vc) return;
    let stream;
    try {
      stream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true });
    } catch (e) {
      if (e.name !== 'NotAllowedError' && e.name !== 'AbortError') H.toast('Ekran paylaşımı başlatılamadı (' + e.name + ').');
      return;
    }
    if (!vc || !peer || sharerId) {             // someone took the stage while the picker was open
      stream.getTracks().forEach(t => { try { t.stop(); } catch (e) {} });
      updateShareBtn();
      return;
    }
    screenStream = stream;
    sharerId = peer.id;
    const vid = stream.getVideoTracks()[0];
    if (vid) vid.addEventListener('ended', () => stopScreenShare());   // the browser's own stop bar
    broadcast({ type: 'screen-start' });
    for (const id of members.keys()) callScreen(id);
    showStage(peer.id, stream);
    updateShareBtn();
    blip(880, 0.1);
    H.requestPoll();
  }
  function stopScreenShare(quiet) {
    if (!screenStream) return;
    for (const m of members.values()) {
      try { m.screenOutCall && m.screenOutCall.close(); } catch (e) {}
      m.screenOutCall = null;
    }
    screenStream.getTracks().forEach(t => { try { t.stop(); } catch (e) {} });
    screenStream = null;
    if (sharerId === (peer && peer.id)) sharerId = null;
    broadcast({ type: 'screen-stop' });
    hideStage();
    updateShareBtn();
    if (!quiet) H.requestPoll();
  }

  // ---------- mic state ----------
  // everything that silences the mic funnels through here, so push-to-talk, the
  // mute button and deafen never disagree about what the channel was told
  function setMuted(next, announce = true) {
    if (next === muted) { syncDock(); return; }
    muted = next;
    applyTrackEnabled();
    if (announce) broadcast({ type: 'state', muted, deaf: deafened });
    syncDock();
    render();
  }
  function applyTrackEnabled() {
    if (localStream) localStream.getAudioTracks().forEach(t => { t.enabled = !muted; });
  }
  function toggleMute() {
    if (ptt) { setPtt(false); return; }           // tapping the mic is the way out of PTT
    if (deafened) { setDeafened(false); if (deafMutedMe) return; }
    setMuted(!muted);
    setPref('vd-muted', muted ? '1' : '0');
  }
  function setDeafened(next) {
    if (next === deafened) return;
    deafened = next;
    setPref('vd-deaf', deafened ? '1' : '0');
    for (const m of members.values()) if (m.audioEl) m.audioEl.muted = deafened;
    syncStageMute();
    if (deafened && !muted) { deafMutedMe = true; setMuted(true, false); }
    else if (!deafened && deafMutedMe) { deafMutedMe = false; if (ptt) applyPtt(); else setMuted(false, false); }
    broadcast({ type: 'state', muted, deaf: deafened });
    syncDock();
    render();
  }
  function syncDock() {
    if (!D.muteBtn) return;
    D.muteBtn.classList.toggle('on', muted);
    label(D.muteBtn).textContent = !muted ? 'Mikrofon açık' : (ptt && !deafened ? 'Bas-konuş' : 'Mikrofon kapalı');
    D.deafenBtn.classList.toggle('on', deafened);
    label(D.deafenBtn).textContent = deafened ? 'Sesi aç' : 'Sesi kes';
    H.onState();
  }

  // ---------- push to talk ----------
  function setPtt(on) {
    ptt = on;
    setPref('vd-ptt', on ? '1' : '0');
    D.pttToggle.setAttribute('aria-pressed', String(on));
    D.pttNote.hidden = !on;
    pttHeld = false;
    if (on) applyPtt(); else if (!deafened) setMuted(false);
    syncDock();
  }
  function applyPtt() { if (ptt) setMuted(!pttHeld || deafened); syncDock(); }
  const pttKey = e => e.code === 'Space' || e.key === ' ';
  const typing = () => {
    const a = document.activeElement;
    return a && (a.tagName === 'INPUT' || a.tagName === 'TEXTAREA' || a.tagName === 'SELECT' || a.isContentEditable);
  };

  // ---------- audio panel ----------
  const NS_NOTE = {
    off:     'Ham mikrofon. Ne duyuyorsan o gidiyor.',
    browser: 'Tarayıcının kendi filtresi. Sabit uğultu ve fan sesinde iyi, bedava.',
    model:   'RNNoise sinir ağı. Klavye, fan ve oda uğultusunu konuşmadan ayırır.'
  };
  const NS_FAIL = {
    unsupported: 'Bu tarayıcı AudioWorklet desteklemiyor. Tarayıcı filtresi kullanılıyor.',
    rate:        'Ses donanımı 48 kHz vermiyor, model çalışamaz. Tarayıcı filtresi kullanılıyor.',
    load:        'Model yüklenemedi. Tarayıcı filtresi kullanılıyor.'
  };
  function syncNsUi() {
    if (!D.nsButtons) return;
    D.nsButtons.forEach(b => b.setAttribute('aria-pressed', String(b.dataset.ns === nsMode)));
    const modelBtn = D.nsButtons.find(b => b.dataset.ns === 'model');
    modelBtn.disabled = !!denoiseFailed;
    if (denoiseFailed) { D.nsNote.textContent = NS_FAIL[denoiseFailed]; D.nsNote.classList.add('warn'); return; }
    D.nsNote.classList.remove('warn');
    if (nsMode === 'model' && !denoiseNode && workletLoad) D.nsNote.textContent = 'Model indiriliyor (ilk seferde ~1,9 MB)…';
    else D.nsNote.textContent = NS_NOTE[nsMode];
  }
  async function setNsMode(mode) {
    if (mode === nsMode) return;
    nsMode = mode;
    setPref('vd-ns-mode', mode);
    syncNsUi();
    // applyConstraints keeps the live track — nobody drops out
    const st = localStream || checkStream;
    if (st) {
      for (const t of st.getAudioTracks()) {
        try { await t.applyConstraints({ noiseSuppression: mode === 'browser' }); } catch (e) {}
      }
    }
    if (mode === 'model') {
      await ensureDenoiser();
      if (denoiseFailed) { nsMode = 'browser'; setPref('vd-ns-mode', 'browser'); }
    }
    rewireChain();
    syncNsUi();
  }
  function syncGateUi() {
    D.gateToggle.setAttribute('aria-pressed', String(gateOn));
    D.gateRow.hidden = !gateOn;
    D.gateThr.value = Math.round(gateThr / VU_FULL * 100);
    if (!gateOn) { D.gateWrap.classList.remove('open'); D.gateLvl.style.width = '0%'; }
  }
  function toggleGate() {
    gateOn = !gateOn;
    setPref('vd-gate', gateOn ? '1' : '0');
    syncGateUi();
    syncGateNode();
    if (!gateOn) setGateOpen(true); else gateHoldUntil = 0;
  }

  // devices
  function fillSelect(sel, devices, current, fallbackLabel) {
    sel.innerHTML = '';
    devices.forEach((d, i) => {
      const o = document.createElement('option');
      o.value = d.deviceId;
      o.textContent = d.label || (fallbackLabel + ' ' + (i + 1));
      sel.appendChild(o);
    });
    if (current && devices.some(d => d.deviceId === current)) sel.value = current;
  }
  async function refreshDevices() {
    if (!navigator.mediaDevices || !navigator.mediaDevices.enumerateDevices) return;
    let list;
    try { list = await navigator.mediaDevices.enumerateDevices(); } catch (e) { return; }
    const ins = list.filter(d => d.kind === 'audioinput');
    const outs = list.filter(d => d.kind === 'audiooutput');
    fillSelect(D.micSel, ins, micId || currentMicId(), 'Mikrofon');
    const showOut = canSetSink && outs.length > 0;     // setSinkId is Chromium-only
    D.outRow.hidden = !showOut;
    if (showOut) fillSelect(D.outSel, outs, outId, 'Çıkış');
  }
  function currentMicId() {
    const s = localStream || checkStream;
    const t = s && s.getAudioTracks()[0];
    return t && t.getSettings ? (t.getSettings().deviceId || '') : '';
  }
  async function switchMic(id) {
    micId = id;
    setPref('vd-mic', id);
    if (!localStream) { if (checkStream) { stopCheck(); startCheck(); } return; }
    let fresh;
    try { fresh = await navigator.mediaDevices.getUserMedia(micConstraints()); }
    catch (e) { H.toast('Mikrofon değiştirilemedi: ' + micError(e)); return; }
    const old = localStream;
    localStream = fresh;
    await wireGate(localStream);
    if (old) old.getTracks().forEach(t => { try { t.stop(); } catch (e) {} });
    applyTrackEnabled();
  }
  async function switchOutput(id) {
    outId = id;
    setPref('vd-out', id);
    if (!canSetSink) return;
    for (const m of members.values()) if (m.audioEl) { try { await m.audioEl.setSinkId(id); } catch (e) {} }
    try { await D.stageVideo.setSinkId(id); } catch (e) {}
  }

  // mic test while not in a channel: the panel's level bar earns its keep
  let checkStream = null, checkRaf = 0;
  async function startCheck() {
    if (vc || checkStream) return;
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) return;
    D.micTest.textContent = 'izin isteniyor…';
    try { checkStream = await navigator.mediaDevices.getUserMedia(micConstraints()); }
    catch (e) { D.micTest.textContent = 'Mikrofonu dene'; H.toast(micError(e)); return; }
    if (vc || D.audioPanel.hidden) { stopCheck(); return; }
    D.micTest.textContent = 'Testi durdur';
    await wireGate(checkStream);
    if (nsMode === 'model') { await ensureDenoiser(); rewireChain(); syncNsUi(); }
    refreshDevices();
    const loop = () => {
      if (!checkStream) return;
      const level = rms(micTap), t = performance.now();
      let open = true;
      if (gateOn) { if (level > gateThr) gateHoldUntil = t + GATE_HOLD_MS; open = t < gateHoldUntil; }
      paintPanelMeters(Math.min(1, level / VU_FULL), open && level > 0);
      checkRaf = requestAnimationFrame(loop);
    };
    loop();
  }
  function stopCheck() {
    if (checkRaf) cancelAnimationFrame(checkRaf);
    checkRaf = 0;
    if (checkStream) {
      checkStream.getTracks().forEach(t => { try { t.stop(); } catch (e) {} });
      checkStream = null;
      if (!localStream && gateSrc) { try { gateSrc.disconnect(); } catch (e) {} gateSrc = null; }
    }
    if (D.micTest) D.micTest.textContent = 'Mikrofonu dene';
    if (D.micLvl && !vc) D.micLvl.style.width = '0%';
  }

  // the panel is one element: a popover over the dock, or a tab in the settings modal
  let panelHome = null;
  function mountPanel(parent) {
    if (!panelHome) panelHome = D.audioPanel.parentNode;
    (parent || panelHome).appendChild(D.audioPanel);
    D.audioPanel.classList.toggle('inline', !!parent);
    D.audioPanel.hidden = false;
    D.micTest.hidden = !!vc;
    refreshDevices();
  }
  function closePanel() {
    if (!D.audioPanel || D.audioPanel.hidden) return;
    D.audioPanel.hidden = true;
    D.audioBtn.classList.remove('open');
    stopCheck();
    if (panelHome && D.audioPanel.parentNode !== panelHome) panelHome.appendChild(D.audioPanel);
    D.audioPanel.classList.remove('inline');
  }

  // ---------- wiring ----------
  function init(hooks) {
    H = hooks;
    grabDom();
    D.muteBtn.addEventListener('click', toggleMute);
    D.deafenBtn.addEventListener('click', () => setDeafened(!deafened));
    D.shareBtn.addEventListener('click', () => { if (screenStream) stopScreenShare(); else startScreenShare(); });
    D.leaveBtn.addEventListener('click', () => leave());
    D.audioBtn.addEventListener('click', e => {
      e.stopPropagation();
      if (!D.audioPanel.hidden) { closePanel(); return; }
      mountPanel(null);
      D.audioBtn.classList.add('open');
    });
    document.addEventListener('click', e => {
      if (D.audioPanel.hidden || D.audioPanel.classList.contains('inline')) return;
      if (!D.audioPanel.contains(e.target) && e.target !== D.audioBtn) closePanel();
    });
    D.micTest.addEventListener('click', () => { if (checkStream) stopCheck(); else startCheck(); });
    D.nsSeg.addEventListener('click', e => {
      const b = e.target.closest('button[data-ns]');
      if (b && !b.disabled) setNsMode(b.dataset.ns);
    });
    D.gateToggle.addEventListener('click', toggleGate);
    D.gateThr.addEventListener('input', () => {
      gateThr = (parseInt(D.gateThr.value, 10) / 100) * VU_FULL;
      setPref('vd-gate-thr', gateThr.toFixed(4));
      syncGateNode();
    });
    D.pttToggle.addEventListener('click', () => setPtt(!ptt));
    D.micSel.addEventListener('change', () => switchMic(D.micSel.value));
    D.outSel.addEventListener('change', () => switchOutput(D.outSel.value));
    if (navigator.mediaDevices && 'ondevicechange' in navigator.mediaDevices) {
      navigator.mediaDevices.addEventListener('devicechange', refreshDevices);
    }
    D.stageVideo.addEventListener('volumechange', () => {
      if (stageMine || deafened) { if (!D.stageVideo.muted) D.stageVideo.muted = true; return; }
      stageUserMuted = D.stageVideo.muted;
    });

    window.addEventListener('keydown', e => {
      if (!ptt || !vc || !pttKey(e) || typing() || e.repeat || deafened) return;
      e.preventDefault();
      pttHeld = true;
      setMuted(false);
    });
    window.addEventListener('keyup', e => {
      if (!ptt || !pttKey(e) || typing()) return;
      pttHeld = false;
      if (vc) setMuted(true);
    });
    window.addEventListener('blur', () => { if (ptt && pttHeld) { pttHeld = false; setMuted(true); } });
    // the seat is given back even when the tab is simply closed
    window.addEventListener('pagehide', () => {
      if (peer && vc) {
        try { navigator.sendBeacon('api.php?a=voice_leave', JSON.stringify({ peer: peer.id })); } catch (e) {}
        try { peer.destroy(); } catch (e) {}
      }
    });

    D.pttToggle.setAttribute('aria-pressed', String(ptt));
    D.pttNote.hidden = !ptt;
    syncNsUi();
    syncGateUi();
    syncDock();
    updateShareBtn();
  }

  VD.voice = {
    init, join, leave, reclaim, applyStates, render, mountPanel, closePanel, blip,
    toggleMute, toggleDeafen: () => setDeafened(!deafened), toggleShare: () => (screenStream ? stopScreenShare() : startScreenShare()),
    nudge: () => broadcast({ type: 'nudge' }),
    beat: () => (vc && peer ? { peer: peer.id, mu: muted, df: deafened, sh: !!screenStream } : null),
    get channel() { return vc ? vc.ch : 0; },
    get server() { return vc ? vc.sid : 0; },
    get joining() { return joining; },
    get muted() { return muted; },
    get deafened() { return deafened; },
    get sharing() { return !!screenStream; },
    get count() { return vc ? members.size + 1 : 0; },
    get gateKind() { return gateNode ? (gateIsWorklet ? 'worklet' : 'gain') : 'none'; },   // diagnostics
    canShare: canShareScreen,
  };
})();
