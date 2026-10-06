// On-device translation (Mozilla Bergamot — the engine behind Firefox Translations).
// Runs in a Web Worker so translating never blocks the call UI.
// Messages in:  {type:'init'} | {type:'translate', id, pair, text}
// Messages out: {type:'progress', loaded, total} | {type:'ready', ms} | {type:'error', message}
//               {type:'result', id, text} | {type:'result', id, error}

const ENGINE_DIR = 'vendor/bergamot/';
const CACHE_NAME = 'callsubs-models-v1';   // bump when model files change
const PAIRS = {
  enpt: { model: 'models/enpt/model.enpt.intgemm.alphas.bin.gz', lex: 'models/enpt/lex.50.50.enpt.s2t.bin.gz', vocab: 'models/enpt/vocab.enpt.spm.gz' },
  pten: { model: 'models/pten/model.pten.intgemm.alphas.bin.gz', lex: 'models/pten/lex.50.50.pten.s2t.bin.gz', vocab: 'models/pten/vocab.pten.spm.gz' },
};
const ALIGN = { model: 256, lex: 64, vocab: 64 };

// Spacing matters: Marian parses this as YAML.
const MODEL_CONFIG = `beam-size: 1
normalize: 1.0
word-penalty: 0
max-length-break: 128
mini-batch-words: 1024
workspace: 128
max-length-factor: 2.0
skip-cost: true
cpu-threads: 0
quiet: true
quiet-translation: true
gemm-precision: int8shiftAlphaAll
`;

let service = null;
const models = {};
let initPromise = null;

const runtimeReady = new Promise(resolve => {
  self.Module = {
    locateFile: path => ENGINE_DIR + path,
    onRuntimeInitialized: resolve,
  };
});

self.onmessage = async ({ data }) => {
  if (data.type === 'init') {
    initPromise ??= init().catch(e => { initPromise = null; postMessage({ type: 'error', message: e.message }); throw e; });
    return;
  }
  if (data.type === 'translate') {
    try {
      await initPromise;
      postMessage({ type: 'result', id: data.id, text: translate(data.pair, data.text) });
    } catch (e) {
      postMessage({ type: 'result', id: data.id, error: e?.message || String(e) });
    }
  }
};

async function init() {
  const t0 = Date.now();
  importScripts(ENGINE_DIR + 'bergamot-translator-worker.js');
  await runtimeReady;
  service = new Module.BlockingService({ cacheSize: 0 });
  await dropOldCaches();

  const files = Object.entries(PAIRS).flatMap(([pair, f]) => Object.entries(f).map(([kind, url]) => ({ pair, kind, url })));
  const sizes = await Promise.all(files.map(f => contentLength(f.url)));
  const total = sizes.reduce((a, b) => a + b, 0);
  const done = new Array(files.length).fill(0);
  const report = () => postMessage({ type: 'progress', loaded: done.reduce((a, b) => a + b, 0), total });

  const buffers = await Promise.all(files.map((f, i) =>
    fetchGzip(f.url, n => { done[i] = n; report(); }).then(buf => ({ ...f, buf }))));

  for (const pair of Object.keys(PAIRS)) {
    const get = kind => aligned(buffers.find(b => b.pair === pair && b.kind === kind).buf, ALIGN[kind]);
    const vocabs = new Module.AlignedMemoryList();
    vocabs.push_back(get('vocab'));
    models[pair] = new Module.TranslationModel(MODEL_CONFIG, get('model'), get('lex'), vocabs, null);
  }
  postMessage({ type: 'ready', ms: Date.now() - t0 });
}

function translate(pair, text) {
  const model = models[pair];
  if (!model) throw new Error(`no model for ${pair}`);
  const input = new Module.VectorString();
  const options = new Module.VectorResponseOptions();
  let responses;
  try {
    input.push_back(text);
    options.push_back({ qualityScores: false, alignment: false, html: false });
    responses = service.translate(model, input, options);
    return responses.get(0).getTranslatedText();
  } finally {
    input.delete();
    options.delete();
    responses?.delete();
  }
}

function aligned(buffer, alignment) {
  const bytes = new Int8Array(buffer);
  const mem = new Module.AlignedMemory(bytes.byteLength, alignment);
  mem.getByteArrayView().set(bytes);
  return mem;
}

async function contentLength(url) {
  const cache = await caches.open(CACHE_NAME);
  const hit = await cache.match(url);
  if (hit) return Number(hit.headers.get('content-length')) || 0;
  const res = await fetch(url, { method: 'HEAD' });
  return Number(res.headers.get('content-length')) || 0;
}

// Download once, keep in Cache Storage (survives reloads and app restarts), then gunzip.
async function fetchGzip(url, onBytes) {
  const cache = await caches.open(CACHE_NAME);
  let res = await cache.match(url);
  if (!res) {
    const net = await fetch(url);
    if (!net.ok) throw new Error(`download ${url}: HTTP ${net.status}`);
    const chunks = [];
    let n = 0;
    const reader = net.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      onBytes(n += value.byteLength);
    }
    const blob = new Blob(chunks);
    await cache.put(url, new Response(blob, { headers: { 'content-length': String(blob.size) } }));
    res = new Response(blob);
  } else {
    onBytes(Number(res.headers.get('content-length')) || 0);
  }
  const blob = await res.blob();
  const magic = new Uint8Array(await blob.slice(0, 2).arrayBuffer());
  if (magic[0] !== 0x1f || magic[1] !== 0x8b) return blob.arrayBuffer();   // server already decompressed it
  return new Response(blob.stream().pipeThrough(new DecompressionStream('gzip'))).arrayBuffer();
}

async function dropOldCaches() {
  for (const name of await caches.keys()) {
    if (name.startsWith('callsubs-models-') && name !== CACHE_NAME) await caches.delete(name);
  }
}
