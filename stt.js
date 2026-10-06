// Speech-to-text behind a small pluggable interface.
//
// Every engine exposes:
//   isSupported, start(track?), stop(), restart(), setTrack(track), kick(), info()
// and emits:
//   'interim' (text), 'final' (text), 'state' (idle|starting|listening|stopping), 'error' ({code, message})
//
// Phase 2: add a CloudSTT class with the same shape (streaming the mic track to a
// serverless proxy) and return it from createSTT('cloud', ...).

import { Emitter, log } from './util.js';

const BENIGN = new Set(['no-speech', 'aborted']);
const FATAL = new Set(['not-allowed', 'service-not-allowed', 'language-not-supported']);

export function createSTT(kind, opts) {
  switch (kind) {
    case 'webspeech': return new WebSpeechSTT(opts);
    default: throw new Error(`Unknown STT engine: ${kind}`);
  }
}

export class WebSpeechSTT extends Emitter {
  constructor(opts) {
    super();
    this.opts = { ...opts };
    const Impl = window.SpeechRecognition || window.webkitSpeechRecognition;
    this.impl = window.SpeechRecognition ? 'SpeechRecognition' : Impl ? 'webkitSpeechRecognition' : 'none';
    this.isSupported = !!Impl;
    this.state = 'idle';
    this.want = false;
    this.track = null;
    this.input = '-';
    this.restarts = 0;
    this.finals = 0;
    this.failStreak = 0;
    this.trackFails = 0;
    this.trackDisabled = false;
    this.lastError = '';
    this.lastText = '';
    this.resetSession();
    if (!Impl) return;

    // One instance for the whole call, restarted on 'end'. On iOS a fresh instance
    // per start can re-trigger the permission prompt and the start chime.
    const r = this.rec = new Impl();
    r.lang = opts.lang;
    r.continuous = opts.continuous;
    r.interimResults = true;
    r.maxAlternatives = 1;
    r.onstart = () => { clearTimeout(this.startTimer); this.setState('listening'); };
    r.onaudiostart = () => log('stt', 'audio capture started');
    r.onresult = e => this.onResult(e);
    r.onerror = e => this.onError(e);
    r.onend = () => this.onEnd();
  }

  resetSession() { this.done = new Set(); this.prevFinal = ''; this.pending = ''; }

  setState(s) {
    if (this.state === s) return;
    this.state = s;
    log('stt', `state: ${s}`);
    this.emit('state', s);
  }

  start(track = null) {
    if (!this.isSupported) return;
    this.want = true;
    this.track = track;
    if (this.state === 'idle') this.launch();
  }

  stop() {
    this.want = false;
    clearTimeout(this.restartTimer);
    if (this.state !== 'idle') {
      this.setState('stopping');
      try { this.rec.stop(); } catch {}
    }
  }

  // Abort the current session; the 'end' handler restarts it if still wanted.
  restart() {
    clearTimeout(this.restartTimer);
    this.failStreak = 0;
    if (this.state === 'idle') { if (this.want) this.launch(); }
    else { try { this.rec.abort(); } catch {} }
  }

  setTrack(track) {
    this.track = track;
    this.trackDisabled = false;
    this.trackFails = 0;
    if (this.want) this.restart();
  }

  // Resume after the page was hidden (iOS ends recognition in the background).
  kick() {
    if (this.want && this.state === 'idle') { clearTimeout(this.restartTimer); this.launch(); }
  }

  launch() {
    this.resetSession();
    this.setState('starting');
    clearTimeout(this.startTimer);
    this.startTimer = setTimeout(() => {
      if (this.state === 'starting') { log('stt', 'start timed out, aborting'); try { this.rec.abort(); } catch {} }
    }, 6000);
    // Chromium is adding start(MediaStreamTrack): recognise from the call's own mic track
    // instead of opening a second mic session. Browsers without it ignore the argument.
    const useTrack = this.opts.passTrack && !this.trackDisabled && this.track?.readyState === 'live';
    try {
      if (useTrack) { this.rec.start(this.track); this.input = 'call track (start(track))'; }
      else { this.rec.start(); this.input = 'own mic (start())'; }
    } catch (err) {
      if (err.name === 'InvalidStateError') { log('stt', 'start: already running'); this.setState('listening'); return; }
      if (useTrack) {
        log('stt', `start(track) threw ${err.name}; falling back to start()`);
        this.trackDisabled = true;
        try { this.rec.start(); this.input = 'own mic (start())'; return; } catch (e2) { err = e2; }
      }
      clearTimeout(this.startTimer);
      this.lastError = `${err.name || 'start-failed'}`;
      this.failStreak++;
      log('stt', `start failed: ${err.name} ${err.message}`);
      this.emit('error', { code: err.name || 'start-failed', message: err.message });
      this.setState('idle');
      this.scheduleRestart();
    }
  }

  onResult(e) {
    this.failStreak = 0;
    this.trackFails = 0;
    let interim = '';
    for (let i = e.resultIndex; i < e.results.length; i++) {
      const res = e.results[i];
      const text = res[0]?.transcript || '';
      if (res.isFinal) {
        if (!this.done.has(i)) { this.done.add(i); this.emitFinal(text); }
      } else {
        interim += text;
      }
    }
    interim = this.dedupe(interim);
    if (interim === this.pending) return;
    this.pending = interim;
    this.emit('interim', interim);
    clearTimeout(this.stallTimer);
    if (interim && this.opts.stallMs) {
      this.stallTimer = setTimeout(() => {
        log('stt', 'interim stalled, stopping to force a final');
        try { this.rec.stop(); } catch {}
      }, this.opts.stallMs);
    }
  }

  // Android Chrome in continuous mode can repeat earlier final text at the start of later results.
  dedupe(text) {
    text = text.trim();
    const p = this.prevFinal;
    if (p && text.length > p.length && text.startsWith(p)) return text.slice(p.length).trim();
    return text;
  }

  emitFinal(raw) {
    const text = this.dedupe(raw);
    this.prevFinal = raw.trim();
    this.pending = '';
    clearTimeout(this.stallTimer);
    if (!text) return;
    this.finals++;
    this.lastText = text;
    this.emit('final', text);
  }

  onError(e) {
    const code = e.error || 'unknown';
    log('stt', `error: ${code}${e.message ? ' – ' + e.message : ''}`);
    if (BENIGN.has(code)) return;
    this.lastError = `${code} @ ${new Date().toLocaleTimeString()}`;
    if (FATAL.has(code)) {
      this.want = false;
    } else {
      this.failStreak++;
      if (code === 'audio-capture' && this.input.startsWith('call track') && ++this.trackFails >= 2) {
        this.trackDisabled = true;
        log('stt', 'track input keeps failing, switching to own mic');
      }
    }
    this.emit('error', { code, message: e.message || '' });
  }

  onEnd() {
    clearTimeout(this.startTimer);
    clearTimeout(this.stallTimer);
    // Flush text that never got a final (iOS does this when it stops on its own).
    if (this.pending) {
      const text = this.pending;
      this.pending = '';
      this.finals++;
      this.lastText = text;
      this.emit('final', text);
    }
    this.setState('idle');
    if (this.want) this.scheduleRestart();
  }

  scheduleRestart() {
    clearTimeout(this.restartTimer);
    if (!this.want || document.hidden) return;
    const delay = Math.min(this.opts.maxRestartDelayMs, this.opts.restartDelayMs * 2 ** this.failStreak);
    this.restartTimer = setTimeout(() => {
      if (this.want && this.state === 'idle' && !document.hidden) { this.restarts++; this.launch(); }
    }, delay);
  }

  info() {
    return {
      impl: this.impl, state: this.state, input: this.input, restarts: this.restarts,
      finals: this.finals, lastError: this.lastError, lastText: this.lastText, failStreak: this.failStreak,
    };
  }
}
