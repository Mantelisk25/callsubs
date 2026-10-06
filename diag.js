// Diagnostics panel: this device vs the other device (the other side's values arrive over
// the data channel every 2 s), plus the recent event log.

const ROWS = [
  ['browser', 'Browser'],
  ['speechLang', 'Speech language'],
  ['sttSupported', 'Speech recognition supported'],
  ['sttMode', 'Mode'],
  ['sttInput', 'Recognition input'],
  ['sttState', 'Recognition state'],
  ['listening', 'Listening now'],
  ['sttRestarts', 'Auto-restarts'],
  ['sttFinals', 'Final results'],
  ['sttLastError', 'Last recognition error'],
  ['sttLastText', 'Last recognised text'],
  ['micTrack', 'Call mic track'],
  ['micLevelOut', 'Mic level sent (0–1)'],
  ['audioLevelIn', 'Audio level received (0–1)'],
  ['signalling', 'Signalling server'],
  ['dataChannel', 'Data channel'],
  ['ice', 'Media connection (ICE)'],
  ['route', 'Route'],
  ['rttMs', 'Round trip (ms)'],
  ['translation', 'Translation provider'],
  ['onDevice', 'On-device translator'],
  ['trLastError', 'Last translation error'],
  ['wakeLock', 'Screen kept awake'],
];

function badness(key, v) {
  const s = String(v ?? '');
  if (key === 'sttSupported' && s.startsWith('NO')) return 'bad';
  if (key === 'listening' && s === 'no') return 'warn';
  if (/LastError$/.test(key) && s && s !== '-') return 'bad';
  if (key === 'micTrack' && /ended|MUTED|none/.test(s)) return 'bad';
  if (key === 'dataChannel' && s !== 'open') return 'bad';
  if (key === 'ice' && /failed|disconnected/.test(s)) return 'bad';
  if (key === 'route' && s.startsWith('TURN')) return 'warn';
  if (key === 'signalling' && s !== 'open') return 'warn';
  if (key === 'onDevice') return s.startsWith('ready') ? 'good' : /error|not supported/.test(s) ? 'bad' : '';
  if (s === 'yes' || s === 'open' || s === 'connected' || s === 'completed' || s === 'listening') return 'good';
  return '';
}

const esc = s => String(s ?? '–').replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));

export function renderDiag(el, local, remote, logLines) {
  const cell = (key, v) => `<td class="${badness(key, v)}">${esc(v)}</td>`;
  const rows = ROWS.map(([k, label]) =>
    `<tr><th>${label}</th>${cell(k, local?.[k])}${cell(k, remote?.[k])}</tr>`).join('');
  el.querySelector('.diag-table').innerHTML =
    `<tr><th></th><th>This device</th><th>Other device${remote ? '' : ' (no data)'}</th></tr>${rows}`;
  el.querySelector('.diag-log').textContent = logLines.slice(-30).join('\n');
}
