// All tunable settings in one place. Edit, commit, push — no build step.
export const CONFIG = {
  // Prefix for IDs on the public PeerJS signalling server (keeps our rooms distinct from others).
  peerPrefix: 'callsubs-v1-',

  // PeerJS signalling server. Empty = free public cloud server (0.peerjs.com).
  // Self-hosted example: { host: 'my-peer.example.com', port: 443, path: '/', secure: true }
  peerServer: {},

  // STUN finds a direct route; TURN relays media when no direct route exists
  // (common on mobile data). Credentials here are visible in page source.
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun.cloudflare.com:3478' },
    // ExpressTURN free tier (1 TB/month): sign up at https://www.expressturn.com,
    // then copy the server, username and password from your dashboard:
    // { urls: 'turn:YOUR_SERVER.expressturn.com:3478', username: 'USER', credential: 'PASS' },
    // { urls: 'turn:YOUR_SERVER.expressturn.com:3478?transport=tcp', username: 'USER', credential: 'PASS' },
  ],

  // 'all' = normal. 'relay' = force everything through TURN (to prove TURN works).
  iceTransportPolicy: 'all',

  // MyMemory (fallback translator). An email raises the free limit from ~5k to ~50k chars/day.
  // It is sent as a URL parameter and visible in page source.
  myMemoryEmail: '',

  // Host = whoever taps "New call". Guest = whoever opens the shared link.
  roles: {
    host:  { speechLang: 'en-US', ui: 'en' },
    guest: { speechLang: 'pt-BR', ui: 'pt' },
  },

  stt: {
    continuous: true,
    restartDelayMs: 300,     // delay before auto-restart; doubles on repeated failures
    maxRestartDelayMs: 5000,
    stallMs: 2500,           // interim text unchanged this long -> force a final (iOS sometimes never finalises)
    passTrack: true,         // pass the call's mic track to recognition.start(track) where supported
  },

  subtitleLines: 5,
};
