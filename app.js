// Wires the call, speech recognition, translation, subtitles and diagnostics together.
//
// Roles: no ?room -> home screen, "New call" makes you the host (URL becomes ?room=X&host=1).
//        ?room=X   -> guest. Optional overrides for testing: &speak=en-US  &ui=en|pt

import { CONFIG } from './config.js';
import { t, setLang, applyI18n } from './i18n.js';
import { Call } from './call.js';
import { createSTT } from './stt.js';
import { translate, translatorState, warmUpBuiltin, startOnDevice, onOnDeviceStatus } from './translate.js';
import { renderDiag } from './diag.js';
import { log, getLog, randomId, baseLang, env } from './util.js';

const $ = id => document.getElementById(id);
const ENV = env();
const params = new URLSearchParams(location.search);
let room = params.get('room');
const role = room && params.get('host') !== '1' ? 'guest' : 'host';
const otherRole = role === 'host' ? 'guest' : 'host';
const me = { ...CONFIG.roles[role] };
if (params.get('speak')) me.speechLang = params.get('speak');
let remote = { ...CONFIG.roles[otherRole] };   // replaced by the other side's 'hello'
setLang(params.get('ui') || me.ui);

let call = null, stt = null;
let micOn = true, camOn = true, mode = 'continuous', pttHeld = false;
let connected = false, remoteDiag = null, lastStats = {}, wakeLock = null, tickTimer = null, iceFailNoticed = false;

// ---------- Screens ----------

function show(id) {
  for (const s of ['home', 'call', 'ended']) $(s).hidden = s !== id;
}

function setStatus(text) {
  $('status').textContent = text || '';
  $('status').hidden = !text;
}

function showNotice(text, action) {
  $('noticeText').textContent = text;
  const btn = $('noticeAction');
  btn.hidden = !action;
  if (action) { btn.textContent = action.label; btn.onclick = () => { hideNotice(); action.run(); }; }
  $('notice').hidden = false;
}
const hideNotice = () => { $('notice').hidden = true; };

function initHome() {
  applyI18n();
  show('home');
  const warns = [];
  if (!window.isSecureContext) warns.push(t('noHttps'));
  if (!window.SpeechRecognition && !window.webkitSpeechRecognition) warns.push(ENV.iosNonSafari ? t('useSafari') : t('sttUnsupported'));
  if (typeof Peer === 'undefined') warns.push(t('noPeer'));
  $('homeWarn').hidden = !warns.length;
  $('homeWarn').textContent = warns.join(' ');

  // Only the host translates, so only the host downloads the on-device model (once, then cached).
  if (role === 'host') {
    onOnDeviceStatus(status => { $('homeTr').textContent = `Offline translator: ${status}`; });
    $('homeTr').hidden = false;
    startOnDevice();
  }

  if (role === 'guest') {
    $('btnNew').hidden = true;
    $('btnJoin').hidden = false;
    $('btnJoin').onclick = () => startCall();
  } else if (room) {
    $('btnJoin').hidden = false;
    $('btnJoin').textContent = t('rejoin');
    $('btnJoin').onclick = () => startCall();
  }
  $('btnNew').onclick = () => {
    room = randomId(12);   // ~59 bits: not guessable
    history.replaceState(null, '', `?room=${room}&host=1`);
    startCall();
  };
}

// ---------- Call lifecycle ----------

async function startCall() {
  show('call');
  applyI18n();
  setStatus(t('starting'));
  if (role === 'host') warmUpBuiltin(me.readLang, remote.readLang);   // needs the tap's user gesture

  call = new Call(role, room);
  call.on('status', onCallStatus);
  call.on('remoteStream', onRemoteStream);
  call.on('mediaClosed', onRemoteGone);
  call.on('dc', state => {
    if (state === 'open') {
      call.send({ type: 'hello', role, speechLang: me.speechLang, readLang: me.readLang, ui: me.ui, browser: ENV.browser, stt: !!stt?.isSupported });
      sendDiag();
    } else onRemoteGone();
  });
  call.on('data', onData);

  try {
    const fakeAudio = (params.get('fakeAudio') || '').split(',').filter(u => u && !/^[a-z][a-z0-9+.-]*:|^\/\//i.test(u));   // same-site only
    await call.getMedia(params.get('fake') === '1', fakeAudio);
  } catch (e) {
    log('app', `getUserMedia failed: ${e.name} ${e.message}`);
    setStatus('');
    showNotice(`${t(e.name === 'NotFoundError' ? 'noDevice' : 'mediaDenied')} (${e.name})`, { label: '↻', run: () => location.reload() });
    return;
  }
  $('localVideo').srcObject = call.localStream;
  watchTrack(call.audioTrack);

  setupSTT();
  // Phones give the mic to one user at a time, so continuous subtitles can't run during a call
  // (confirmed on a Pixel). Start them in hold-to-talk; computers stay continuous.
  // Switchable in Info -> "Mode".
  if (stt?.isSupported && (ENV.ios || /Android/.test(ENV.browser))) setMode('ptt');
  call.open();
  if (role === 'host') showShare();
  requestWakeLock();
  clearInterval(tickTimer);
  tickTimer = setInterval(tick, 2000);
}

function onCallStatus(s) {
  log('app', `call status: ${s}`);
  if (s === 'waiting') { if (!connected) setStatus(t('waiting')); return; }
  if (connected && (s === 'connecting' || s === 'reclaiming')) return;
  setStatus(t({ connecting: 'connecting', hostAway: 'hostAway', reclaiming: 'reconnecting', signalError: 'signalError' }[s] || 'error'));
}

function onRemoteStream(stream) {
  const v = $('remoteVideo');
  v.srcObject = stream;
  v.play().then(() => { $('btnUnmute').hidden = true; }).catch(() => { $('btnUnmute').hidden = false; });
  markConnected();
}

function markConnected() {
  connected = true;
  iceFailNoticed = false;
  setStatus('');
  $('shareCard').hidden = true;
  $('btnReconnect').hidden = true;
}

function onRemoteGone() {
  if (!connected || call?.ended) return;
  connected = false;
  remoteDiag = null;
  setLive('them', '');
  if (role === 'host') {
    setStatus(t('waiting'));
    showShare();
  } else {
    setStatus(t('lost'));
    $('btnReconnect').hidden = false;
  }
}

function endCall(byRemote = false) {
  if (call?.ended) return;
  stt?.stop();
  call?.end();
  clearInterval(tickTimer);
  wakeLock?.release().catch(() => {});
  show('ended');
  $('endedTitle').textContent = t('ended');
  $('endedText').textContent = byRemote ? t('otherEnded') : '';
  $('btnAgain').textContent = role === 'host' ? t('newCall') : t('rejoin');
  $('btnAgain').onclick = () => { location.href = role === 'host' ? location.pathname : location.href; };
}

// ---------- Share link ----------

function shareUrl() {
  return `${location.origin}${location.pathname}?room=${room}`;
}

function showShare() {
  $('shareLink').textContent = shareUrl();
  $('shareCard').hidden = false;
  $('btnShare').hidden = !navigator.share;
}

$('btnShare').onclick = () => {
  navigator.share({ title: 'CallSubs', text: 'Video call with subtitles / Chamada de vídeo com legendas', url: shareUrl() })
    .catch(e => log('app', `share: ${e.name}`));
};
$('btnCopy').onclick = async () => {
  try { await navigator.clipboard.writeText(shareUrl()); $('btnCopy').textContent = t('copied'); }
  catch { prompt('Copy:', shareUrl()); }
  setTimeout(() => { $('btnCopy').textContent = t('copy'); }, 1500);
};

// ---------- Speech recognition ----------

let curId = null, interimTimer = null, queuedInterim = null;

function setupSTT() {
  stt = createSTT('webspeech', { lang: me.speechLang, ...CONFIG.stt });
  if (!stt.isSupported) {
    showNotice(ENV.iosNonSafari ? t('useSafari') : t('sttUnsupported'),
      ENV.iosNonSafari ? { label: t('copy'), run: () => navigator.clipboard?.writeText(location.href) } : null);
    return;
  }
  // Phones: start with the classic own-mic recognition (the documented mobile path). Computers: feed
  // the call's mic track in (verified in desktop Chrome). The health check below swaps if one fails.
  if (ENV.ios || /Android/.test(ENV.browser)) stt.opts.passTrack = false;
  stt.on('interim', text => {
    setLive('me', text);
    if (!text) return;
    heardAt = Date.now();
    curId ??= randomId();
    sendInterim({ type: 'interim', speaker: role, lang: me.speechLang, original: text, id: curId, ts: Date.now() });
  });
  stt.on('final', text => { heardAt = Date.now(); onOwnFinal(text); });
  stt.on('state', updateSubStatus);
  stt.on('error', ({ code }) => {
    updateSubStatus();
    if (code === 'not-allowed') showNotice(t('sttBlocked'), { label: t('enableSubs'), run: () => { stt.restart(); startListening(); } });
    else if (code === 'service-not-allowed') showNotice(ENV.ios ? t('iosDictation') : t('sttBlocked'), { label: t('enableSubs'), run: startListening });
  });
  startListening();
}

// ---------- Subtitle health: plain-language status + automatic fallback ----------
//
// If the call mic hears you talking but recognition produces no text, the phone is probably not
// letting both use the microphone at once. Step 1: swap how recognition gets the mic
// (own mic <-> call track). Step 2: offer "hold to talk", which frees the mic completely.

let heardAt = 0, voicedSecs = 0, fallbackStep = 0;

function checkSubtitleHealth() {
  if (!stt?.isSupported || !micOn || mode === 'ptt' || !connected) { voicedSecs = 0; return; }
  const talking = lastStats.outLevel != null && lastStats.outLevel > 0.02;
  const heardRecently = Date.now() - heardAt < 4000;
  voicedSecs = talking && !heardRecently ? voicedSecs + 2 : heardRecently ? 0 : Math.max(0, voicedSecs - 1);
  const failing = stt.failStreak >= 3;
  if (voicedSecs < 8 && !failing) return;
  voicedSecs = 0;
  if (fallbackStep === 0) {
    fallbackStep = 1;
    stt.opts.passTrack = !stt.opts.passTrack;
    stt.trackDisabled = false;
    $('dTrack').textContent = `Track input: ${stt.opts.passTrack ? 'on' : 'off'}`;
    log('app', `no subtitles while talking -> trying ${stt.opts.passTrack ? 'call track' : 'own mic'} input`);
    stt.stop();
    setTimeout(startListening, 400);
  } else if (fallbackStep === 1) {
    fallbackStep = 2;
    log('app', 'still no subtitles -> offering hold-to-talk');
    setMode('ptt');
    showNotice(t('pttOffer'));
  }
}

function updateSubStatus() {
  const el = $('subStatus');
  let text;
  if (!stt?.isSupported) text = t('ssUnsupported');
  else if (mode === 'ptt') text = pttHeld ? t('ssPttListening') : t('ssPtt');
  else if (!micOn) text = t('ssMicOff');
  else if (stt.lastError && stt.failStreak > 0) text = `${t('ssProblem')} (${stt.lastError.split(' @')[0]})`;
  else if (stt.state === 'listening') text = Date.now() - heardAt < 5000 ? t('ssHearing') : t('ssListening');
  else text = t('ssStarting');
  if (connected && remoteDiag) {
    const r = remoteDiag;
    const ok = r.listening === 'yes' || /push-to-talk|ptt/.test(r.sttMode || '');
    text += ` · ${t('ssOther')}: ${r.sttSupported?.startsWith('NO') ? t('ssOtherNo') : ok ? '✓' : `⚠ ${r.sttLastError && r.sttLastError !== '-' ? r.sttLastError.split(' @')[0] : t('ssOtherIdle')}`}`;
  }
  el.textContent = text;
  el.hidden = false;
}

function startListening() {
  if (!stt?.isSupported || !micOn || mode === 'ptt') return;
  stt.start(call.audioTrack);
}

// Interim text is sent at most every 200 ms; only the newest is kept.
function sendInterim(msg) {
  queuedInterim = msg;
  if (interimTimer) return;
  interimTimer = setTimeout(() => {
    interimTimer = null;
    if (queuedInterim) call.send(queuedInterim);
    queuedInterim = null;
  }, 200);
}

function onOwnFinal(text) {
  const id = curId || randomId();
  curId = null;
  queuedInterim = null;
  setLive('me', '');
  call.send({ type: 'final', speaker: role, lang: me.speechLang, original: text, id, ts: Date.now() });
  const needs = role === 'host' && baseLang(me.speechLang) !== baseLang(remote.readLang);
  addLine(id, 'me', text, needs ? '…' : null);
  if (needs) hostTranslate(id, text, me.speechLang, remote.readLang);
}

// All translation happens on the host. Result goes to the local line and to the other side.
function hostTranslate(id, text, from, to) {
  translate(text, from, to)
    .then(tr => { applyTranslation(id, tr); call.send({ type: 'translation', id, translated: tr, lang: to }); })
    .catch(() => { applyTranslation(id, null); call.send({ type: 'translation', id, failed: true }); });
}

// ---------- Incoming messages ----------

function onData(msg) {
  if (!msg || typeof msg !== 'object') return;
  switch (msg.type) {
    case 'hello':
      remote = { ...remote, ...msg };
      remote.readLang ??= CONFIG.roles[otherRole].readLang;
      log('app', `hello from ${msg.role}: ${msg.browser}, speaks ${msg.speechLang}, reads ${remote.readLang}, stt=${msg.stt}`);
      markConnected();
      break;
    case 'interim':
      setLive('them', msg.original);
      break;
    case 'final': {
      setLive('them', '');
      const needs = baseLang(msg.lang) !== baseLang(me.readLang);
      addLine(msg.id, 'them', needs ? '…' : msg.original, needs ? msg.original : null);
      if (needs && role === 'host') hostTranslate(msg.id, msg.original, msg.lang, me.readLang);
      break;
    }
    case 'translation':
      applyTranslation(msg.id, msg.failed ? null : msg.translated);
      break;
    case 'diag':
      remoteDiag = msg.data;
      break;
    case 'bye':
      endCall(true);
      break;
  }
}

// ---------- Subtitles ----------

const lines = new Map();   // id -> { who, el, main, sub, original }

function addLine(id, who, mainText, subText) {
  if (lines.has(id)) return;
  const el = document.createElement('div');
  el.className = `line ${who}`;
  const main = document.createElement('div');
  main.className = 'main';
  main.textContent = mainText;
  main.classList.toggle('pending', mainText === '…');
  const sub = document.createElement('div');
  sub.className = 'sub';
  sub.textContent = subText || '';
  sub.hidden = !subText;
  el.append(main, sub);
  $('lines').append(el);
  // For 'them' lines the original sits in sub until the translation arrives; for 'me' it is main.
  lines.set(id, { who, el, main, sub, original: who === 'them' ? (subText ?? mainText) : mainText });
  while (lines.size > CONFIG.subtitleLines) {
    const [oldId, old] = lines.entries().next().value;
    old.el.remove();
    lines.delete(oldId);
  }
}

// Remote line: translation becomes the big text, original stays small below.
// Own line: translation goes small below (handy for learning the other language).
function applyTranslation(id, translated) {
  const l = lines.get(id);
  if (!l) return;
  if (l.who === 'them') {
    l.main.classList.remove('pending');
    l.main.textContent = translated ?? l.original;
    l.sub.textContent = translated ? l.original : t('trFailed');
    l.sub.hidden = false;
  } else {
    l.sub.textContent = translated ?? t('trFailed');
    l.sub.hidden = false;
  }
}

const liveTimers = {};
function setLive(who, text) {
  const el = $(who === 'me' ? 'liveMe' : 'liveThem');
  el.textContent = text || '';
  el.hidden = !text;
  clearTimeout(liveTimers[who]);
  if (text) liveTimers[who] = setTimeout(() => { el.hidden = true; }, 6000);
}

// ---------- Controls ----------

$('btnMic').onclick = () => {
  micOn = !micOn;
  if (call?.audioTrack) call.audioTrack.enabled = micOn;
  $('btnMic').classList.toggle('off', !micOn);
  if (micOn) startListening(); else stt?.stop();
};

$('btnCam').onclick = () => {
  camOn = !camOn;
  if (call?.videoTrack) call.videoTrack.enabled = camOn;
  $('btnCam').classList.toggle('off', !camOn);
};

$('btnEnd').onclick = () => endCall(false);
$('btnUnmute').onclick = () => { $('remoteVideo').play().then(() => { $('btnUnmute').hidden = true; }).catch(() => {}); };
$('btnReconnect').onclick = () => { $('btnReconnect').hidden = true; setStatus(t('connecting')); call?.dial(); };

// Push-to-talk: while held, the call fully releases the mic so recognition has it to itself
// (the other person doesn't hear you during that time); on release the call takes it back.
const ptt = $('btnPtt');
const pttDown = e => {
  e.preventDefault();
  if (pttHeld || !stt?.isSupported) return;
  try { ptt.setPointerCapture(e.pointerId); } catch {}
  pttHeld = true;
  ptt.classList.add('active');
  call?.releaseMic();
  stt.start(null);
  updateSubStatus();
};
const pttUp = async () => {
  if (!pttHeld) return;
  pttHeld = false;
  ptt.classList.remove('active');
  stt.stop();
  updateSubStatus();
  try {
    const track = await call.reacquireMic();
    track.enabled = micOn;
    watchTrack(track);
  } catch (e) {
    log('app', `could not take the mic back: ${e.name} ${e.message}`);
  }
};
ptt.addEventListener('pointerdown', pttDown);
ptt.addEventListener('pointerup', pttUp);
ptt.addEventListener('pointercancel', pttUp);
ptt.addEventListener('contextmenu', e => e.preventDefault());

function setMode(m) {
  mode = m;
  $('dMode').textContent = `Mode: ${m === 'ptt' ? 'push-to-talk' : 'continuous'}`;
  $('btnPtt').hidden = m !== 'ptt';
  $('call').classList.toggle('ptt-mode', m === 'ptt');
  stt?.stop();
  if (m === 'continuous') { fallbackStep = 0; startListening(); }
  log('app', `mode: ${m}`);
  updateSubStatus();
}

// ---------- Diagnostics ----------

$('btnDiag').onclick = () => { $('diag').hidden = !$('diag').hidden; if (!$('diag').hidden) drawDiag(); };
$('diagClose').onclick = () => { $('diag').hidden = true; };
$('dRestart').onclick = () => { log('app', 'manual recognition restart'); if (stt?.want) stt.restart(); else startListening(); };
$('dMode').onclick = () => setMode(mode === 'ptt' ? 'continuous' : 'ptt');
$('dTrack').onclick = () => {
  if (!stt?.isSupported) return;
  stt.opts.passTrack = !stt.opts.passTrack;
  stt.trackDisabled = false;
  $('dTrack').textContent = `Track input: ${stt.opts.passTrack ? 'on' : 'off'}`;
  stt.restart();
};
$('dFixMic').onclick = async () => {
  try {
    const track = await call.reacquireMic();
    watchTrack(track);
    stt?.setTrack(track);
  } catch (e) {
    log('app', `fix mic failed: ${e.name} ${e.message}`);
  }
  drawDiag();
};
$('dCopy').onclick = async () => {
  const report = JSON.stringify({ at: new Date().toISOString(), local: localDiag(), remote: remoteDiag, log: getLog() }, null, 2);
  try { await navigator.clipboard.writeText(report); $('dCopy').textContent = 'Copied!'; }
  catch { prompt('Copy report:', report); }
  setTimeout(() => { $('dCopy').textContent = 'Copy report'; }, 1500);
};

function watchTrack(track) {
  if (!track) return;
  track.onmute = () => log('mic', 'call mic track MUTED by the system');
  track.onunmute = () => log('mic', 'call mic track unmuted');
  track.onended = () => log('mic', 'call mic track ENDED');
}

const fmtLevel = v => (v == null ? '–' : v.toFixed(3));

function localDiag() {
  const i = stt?.info() || {};
  const tr = call?.audioTrack;
  return {
    browser: ENV.browser,
    speechLang: `${me.speechLang} (subtitles in ${me.readLang})`,
    sttSupported: stt?.isSupported ? `yes (${i.impl})` : 'NO',
    sttMode: mode,
    sttInput: i.input,
    sttState: i.state,
    listening: i.state === 'listening' ? 'yes' : 'no',
    sttRestarts: i.restarts,
    sttFinals: i.finals,
    sttLastError: i.lastError || '-',
    sttLastText: i.lastText || '-',
    micTrack: tr ? `${tr.readyState}${tr.enabled ? '' : ' (disabled)'}${tr.muted ? ' MUTED by system' : ''}` : 'none',
    micLevelOut: fmtLevel(lastStats.outLevel),
    audioLevelIn: fmtLevel(lastStats.inLevel),
    signalling: call?.peerState,
    dataChannel: call?.dc,
    ice: lastStats.ice,
    route: lastStats.route,
    rttMs: lastStats.rtt ?? '–',
    translation: role === 'host' ? `${translatorState.provider} (built-in: ${translatorState.builtin})` : 'done by host',
    onDevice: role === 'host' ? translatorState.onDevice : 'host only',
    trLastError: role === 'host' ? (translatorState.lastError || '-') : '-',
    wakeLock: wakeLock ? 'yes' : 'no',
  };
}

function sendDiag() { call?.send({ type: 'diag', data: localDiag() }); }
function drawDiag() { renderDiag($('diag'), localDiag(), remoteDiag, getLog()); }

async function tick() {
  if (!call || call.ended) return;
  lastStats = await call.stats();
  if (lastStats.ice === 'failed' && !iceFailNoticed) { iceFailNoticed = true; showNotice(t('iceFailed')); }
  checkSubtitleHealth();
  updateSubStatus();
  sendDiag();
  if (!$('diag').hidden) drawDiag();
}

// ---------- Screen wake lock / background ----------

async function requestWakeLock() {
  try {
    wakeLock = await navigator.wakeLock?.request('screen');
    wakeLock?.addEventListener('release', () => { wakeLock = null; });
  } catch (e) {
    log('app', `wake lock: ${e.name}`);
  }
}

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState !== 'visible' || !call || call.ended) return;
  requestWakeLock();
  stt?.kick();
});

// Console handle for debugging, e.g. callsubs.stt.emit('final', 'Olá, tudo bem?')
window.callsubs = { get call() { return call; }, get stt() { return stt; } };

initHome();
