// WebRTC video call + data channel via PeerJS (global `Peer` from the CDN script).
// Host: registers peer ID <prefix><room> and waits. Guest: connects data + media to that ID.
//
// Events: 'status' (waiting|connecting|hostAway|reclaiming|signalError|error),
//         'remoteStream' (MediaStream), 'mediaClosed', 'dc' (open|closed), 'data' (msg)

import { CONFIG } from './config.js';
import { Emitter, log } from './util.js';

const AUDIO = { echoCancellation: true, noiseSuppression: true, autoGainControl: true };
const VIDEO = { facingMode: 'user', width: { ideal: 640 }, height: { ideal: 480 }, frameRate: { ideal: 24, max: 30 } };

// Test mode (?fake=1): a moving canvas + quiet tone instead of camera/mic, for devices without them.
// With &fakeAudio=a.mp3,b.mp3 (same-site paths) those clips are played as the "mic", in a loop with pauses.
function fakeStream(audioUrls = []) {
  const canvas = Object.assign(document.createElement('canvas'), { width: 320, height: 240 });
  const g = canvas.getContext('2d');
  let n = 0;
  setInterval(() => {
    g.fillStyle = `hsl(${(n += 3) % 360} 50% 30%)`;
    g.fillRect(0, 0, 320, 240);
    g.fillStyle = '#fff';
    g.font = '28px sans-serif';
    g.fillText(`fake ${new Date().toLocaleTimeString()}`, 20, 130);
  }, 100);
  const ac = new AudioContext();
  const dest = ac.createMediaStreamDestination();
  if (audioUrls.length) {
    playClips(ac, dest, audioUrls).catch(e => log('call', `fake audio failed: ${e.message}`));
  } else {
    const osc = ac.createOscillator();
    const gain = ac.createGain();
    gain.gain.value = 0.02;
    osc.connect(gain).connect(dest);
    osc.start();
  }
  return new MediaStream([...canvas.captureStream(15).getVideoTracks(), ...dest.stream.getAudioTracks()]);
}

async function playClips(ac, dest, urls) {
  const buffers = await Promise.all(urls.map(u => fetch(u).then(r => r.arrayBuffer()).then(b => ac.decodeAudioData(b))));
  let at = ac.currentTime + 1;
  for (let round = 0; round < 20; round++) {
    for (const buffer of buffers) {
      const src = ac.createBufferSource();
      src.buffer = buffer;
      src.connect(dest);
      src.start(at);
      at += buffer.duration + 2.5;
    }
  }
}

export class Call extends Emitter {
  constructor(role, room) {
    super();
    this.role = role;
    this.hostId = CONFIG.peerPrefix + room;
    this.peer = null;
    this.conn = null;
    this.mc = null;
    this.localStream = null;
    this.ended = false;
    this.retries = 0;
    this.peerState = 'idle';
    this.dc = 'none';
  }

  get audioTrack() { return this.localStream?.getAudioTracks()[0] || null; }
  get videoTrack() { return this.localStream?.getVideoTracks()[0] || null; }

  async getMedia(fake = false, fakeAudio = []) {
    if (fake) return (this.localStream = fakeStream(fakeAudio));
    try {
      this.localStream = await navigator.mediaDevices.getUserMedia({ audio: AUDIO, video: VIDEO });
    } catch (e) {
      if (e.name !== 'NotFoundError' && e.name !== 'OverconstrainedError') throw e;
      log('call', `no camera (${e.name}), trying audio only`);
      this.localStream = await navigator.mediaDevices.getUserMedia({ audio: AUDIO });
    }
    return this.localStream;
  }

  open() {
    if (typeof Peer === 'undefined') { log('call', 'PeerJS failed to load'); this.emit('status', 'error'); return; }
    const opts = {
      ...CONFIG.peerServer,
      config: { iceServers: CONFIG.iceServers, iceTransportPolicy: CONFIG.iceTransportPolicy },
      debug: 1,
    };
    const peer = this.peer = this.role === 'host' ? new Peer(this.hostId, opts) : new Peer(opts);
    this.peerState = 'connecting';

    peer.on('open', id => {
      this.retries = 0;
      this.peerState = 'open';
      log('call', `signalling open as ${id}`);
      if (this.role === 'host') this.emit('status', 'waiting');
      else if (this.dc !== 'open') this.dial();
    });
    // 1-on-1 only: while a guest is connected, refuse anyone else who has the link.
    // A guest whose connection dropped can rejoin, because the old link no longer counts as live.
    peer.on('connection', conn => {
      if (this.isLive()) { log('call', 'refused extra data connection (call in progress)'); conn.on('open', () => conn.close()); return; }
      log('call', 'incoming data connection');
      this.attachConn(conn);
    });
    peer.on('call', mc => {
      if (this.isLive()) { log('call', 'refused extra media call (call in progress)'); mc.close(); return; }
      log('call', 'incoming media call');
      mc.answer(this.localStream);
      this.attachMedia(mc);
    });
    peer.on('disconnected', () => {
      this.peerState = 'disconnected';
      if (this.ended || peer.destroyed) return;
      log('call', 'signalling lost, reconnecting');
      setTimeout(() => { if (!peer.destroyed && peer.disconnected) peer.reconnect(); }, 1500);
    });
    peer.on('error', err => this.onPeerError(err));
  }

  isLive() {
    const ice = this.mc?.peerConnection?.iceConnectionState;
    return this.dc === 'open' && (ice === 'connected' || ice === 'completed');
  }

  onPeerError(err) {
    log('call', `peer error: ${err.type} ${err.message || ''}`);
    this.lastError = err.type;
    if (this.ended) return;
    if (err.type === 'unavailable-id' && this.retries < 6) {
      // Host reloaded: the signalling server holds the old ID for a few seconds.
      this.retries++;
      this.peer.destroy();
      this.emit('status', 'reclaiming');
      setTimeout(() => this.open(), 3000);
      return;
    }
    if (err.type === 'peer-unavailable') {
      this.emit('status', 'hostAway');
      clearTimeout(this.dialTimer);
      this.dialTimer = setTimeout(() => this.dial(), 4000);
      return;
    }
    if (['network', 'server-error', 'socket-error', 'socket-closed', 'disconnected'].includes(err.type)) {
      this.emit('status', 'signalError');
      return;
    }
    this.emit('status', 'error');
  }

  dial() {
    if (this.ended || !this.peer || this.peer.destroyed) return;
    if (this.peer.disconnected) { this.peer.reconnect(); return; }   // 'open' will dial again
    log('call', `dialling ${this.hostId}`);
    this.emit('status', 'connecting');
    this.attachConn(this.peer.connect(this.hostId, { reliable: true, serialization: 'json' }));
    this.attachMedia(this.peer.call(this.hostId, this.localStream));
  }

  attachConn(conn) {
    if (this.conn && this.conn !== conn) { try { this.conn.close(); } catch {} }
    this.conn = conn;
    this.dc = 'connecting';
    conn.on('open', () => { if (conn !== this.conn) return; this.dc = 'open'; log('call', 'data channel open'); this.emit('dc', 'open'); });
    conn.on('data', msg => { if (conn === this.conn) this.emit('data', msg); });
    conn.on('close', () => { if (conn !== this.conn) return; this.dc = 'closed'; log('call', 'data channel closed'); this.emit('dc', 'closed'); });
    conn.on('error', e => log('call', `data channel error: ${e.type || e.message || e}`));
  }

  attachMedia(mc) {
    if (this.mc && this.mc !== mc) { try { this.mc.close(); } catch {} }
    this.mc = mc;
    mc.on('stream', stream => { if (mc !== this.mc) return; log('call', 'remote stream received'); this.emit('remoteStream', stream); });
    mc.on('close', () => { if (mc === this.mc) { log('call', 'media call closed'); this.emit('mediaClosed'); } });
    mc.on('error', e => log('call', `media error: ${e.type || e.message || e}`));
  }

  send(msg) {
    if (!this.conn?.open) return false;
    try { this.conn.send(msg); return true; } catch (e) { log('call', `send failed: ${e.message}`); return false; }
  }

  // Known Safari workaround: stop the mic track, ask for a fresh one, swap it into the live call.
  async reacquireMic() {
    const old = this.audioTrack;
    const enabled = old ? old.enabled : true;
    if (old) { old.stop(); this.localStream.removeTrack(old); }
    const fresh = (await navigator.mediaDevices.getUserMedia({ audio: AUDIO })).getAudioTracks()[0];
    fresh.enabled = enabled;
    this.localStream.addTrack(fresh);
    const sender = this.audioSender();
    if (sender) await sender.replaceTrack(fresh);
    log('call', `mic re-acquired${sender ? ' and swapped into the call' : ''}`);
    return fresh;
  }

  // Phones (Android especially) give the microphone to one user at a time. Muting the call's
  // track still holds the mic, so "hold to talk" fully releases it, and reacquireMic() takes it back.
  releaseMic() {
    const old = this.audioTrack;
    if (!old) return;
    old.stop();
    this.localStream.removeTrack(old);
    this.audioSender()?.replaceTrack(null).catch(() => {});
    log('call', 'mic released for speech recognition');
  }

  audioSender() {
    const pc = this.mc?.peerConnection;
    return pc?.getTransceivers().find(t => t.sender.track?.kind === 'audio' || t.receiver.track?.kind === 'audio')?.sender || null;
  }

  async stats() {
    const pc = this.mc?.peerConnection;
    if (!pc) return { ice: 'none' };
    const out = { ice: pc.iceConnectionState, route: '-', rtt: null, outLevel: null, inLevel: null };
    try {
      const report = await pc.getStats();
      const byId = new Map();
      let pairId = null;
      report.forEach(s => {
        byId.set(s.id, s);
        if (s.type === 'transport' && s.selectedCandidatePairId) pairId = s.selectedCandidatePairId;
      });
      let pair = pairId ? byId.get(pairId) : null;
      if (!pair) report.forEach(s => { if (!pair && s.type === 'candidate-pair' && s.state === 'succeeded' && (s.nominated || s.selected)) pair = s; });
      if (pair) {
        const lc = byId.get(pair.localCandidateId), rc = byId.get(pair.remoteCandidateId);
        const relay = lc?.candidateType === 'relay' || rc?.candidateType === 'relay';
        out.route = relay ? 'TURN relay' : lc?.candidateType === 'host' ? 'direct (same network)' : 'direct (internet)';
        if (lc?.protocol) out.route += ` / ${lc.protocol}`;
        if (pair.currentRoundTripTime != null) out.rtt = Math.round(pair.currentRoundTripTime * 1000);
      }
      report.forEach(s => {
        if (s.type === 'media-source' && s.kind === 'audio' && s.audioLevel != null) out.outLevel = s.audioLevel;
        if (s.type === 'inbound-rtp' && s.kind === 'audio' && s.audioLevel != null) out.inLevel = s.audioLevel;
      });
    } catch (e) {
      log('call', `stats failed: ${e.message}`);
    }
    return out;
  }

  end() {
    this.ended = true;
    clearTimeout(this.dialTimer);
    this.send({ type: 'bye' });
    setTimeout(() => {
      try { this.conn?.close(); } catch {}
      try { this.mc?.close(); } catch {}
      try { this.peer?.destroy(); } catch {}
    }, 200);
    this.localStream?.getTracks().forEach(t => t.stop());
  }
}
