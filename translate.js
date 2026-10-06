// Translation behind one function: translate(text, fromTag, toTag) -> Promise<string>.
// Provider order: Chrome built-in Translator API (desktop Chrome only today) -> MyMemory.
// To swap providers later, change only this file.

import { CONFIG } from './config.js';
import { log, baseLang } from './util.js';

export const translatorState = { provider: 'none yet', builtin: 'unchecked', lastError: '', chars: 0 };

const cache = new Map();
const builtins = new Map();   // "en>pt" -> Translator instance, or 'unavailable'

export async function translate(text, from, to) {
  text = (text || '').trim();
  if (!text || baseLang(from) === baseLang(to)) return text;
  const key = `${from}|${to}|${text}`;
  if (cache.has(key)) return cache.get(key);

  let out = null;
  try {
    out = await viaBuiltin(text, from, to);
    if (out != null) translatorState.provider = 'Chrome built-in';
  } catch (e) {
    log('tr', `built-in failed: ${e.message}; using MyMemory from now on`);
    builtins.set(`${baseLang(from)}>${baseLang(to)}`, 'unavailable');
  }
  if (out == null) {
    try {
      out = await viaMyMemory(text, from, to);
      translatorState.provider = 'MyMemory';
    } catch (e) {
      translatorState.lastError = `${e.message} @ ${new Date().toLocaleTimeString()}`;
      log('tr', `MyMemory failed: ${e.message}`);
      throw e;
    }
  }
  translatorState.chars += text.length;
  cache.set(key, out);
  return out;
}

// Call inside a user gesture: lets the built-in translator download its model if needed.
export function warmUpBuiltin(a, b) {
  if (!('Translator' in self)) { translatorState.builtin = 'not in this browser'; return; }
  for (const [from, to] of [[a, b], [b, a]]) {
    Translator.create({ sourceLanguage: baseLang(from), targetLanguage: baseLang(to) })
      .then(t => { builtins.set(`${baseLang(from)}>${baseLang(to)}`, t); log('tr', `built-in ready ${from}->${to}`); })
      .catch(e => log('tr', `built-in warm-up ${from}->${to}: ${e.message}`));
  }
}

// The built-in API can hang (seen in embedded Chromium), so every call is time-boxed.
function withTimeout(promise, ms, what) {
  return Promise.race([promise, new Promise((_, reject) => setTimeout(() => reject(new Error(`${what} timed out`)), ms))]);
}

async function viaBuiltin(text, from, to) {
  if (!('Translator' in self)) { translatorState.builtin = 'not in this browser'; return null; }
  const key = `${baseLang(from)}>${baseLang(to)}`;
  let t = builtins.get(key);
  if (t === 'unavailable') return null;
  if (!t) {
    const opts = { sourceLanguage: baseLang(from), targetLanguage: baseLang(to) };
    let availability;
    try {
      availability = await withTimeout(Translator.availability(opts), 2000, 'availability');
    } catch (e) {
      // Don't ask again for this pair this session; MyMemory takes over.
      translatorState.builtin = 'not responding';
      builtins.set(key, 'unavailable');
      throw e;
    }
    translatorState.builtin = availability;
    if (availability === 'unavailable') { builtins.set(key, 'unavailable'); return null; }
    if (availability !== 'available') return null;   // downloadable/downloading: use fallback for now
    t = await withTimeout(Translator.create(opts), 5000, 'create');
    builtins.set(key, t);
  }
  translatorState.builtin = 'available';
  return await withTimeout(t.translate(text), 5000, 'translate');
}

async function viaMyMemory(text, from, to) {
  const parts = [];
  for (const chunk of chunkText(text, 450)) parts.push(await myMemoryOnce(chunk, from, to));
  return parts.join(' ');
}

async function myMemoryOnce(q, from, to) {
  const url = new URL('https://api.mymemory.translated.net/get');
  url.searchParams.set('q', q);
  url.searchParams.set('langpair', `${from}|${to}`);
  if (CONFIG.myMemoryEmail) url.searchParams.set('de', CONFIG.myMemoryEmail);
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 8000);
  try {
    const res = await fetch(url, { signal: ctrl.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    const out = data?.responseData?.translatedText || '';
    if (Number(data?.responseStatus) !== 200 || /MYMEMORY WARNING/i.test(out)) {
      throw new Error(`MyMemory: ${data?.responseDetails || out || data?.responseStatus}`);
    }
    return decodeEntities(out);
  } catch (e) {
    if (e.name === 'AbortError') throw new Error('MyMemory timeout');
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

function chunkText(text, max) {
  if (text.length <= max) return [text];
  const out = [];
  let cur = '';
  for (const s of text.split(/(?<=[.!?])\s+/)) {
    if ((cur + ' ' + s).trim().length > max && cur) { out.push(cur); cur = s; }
    else cur = (cur + ' ' + s).trim();
    while (cur.length > max) { out.push(cur.slice(0, max)); cur = cur.slice(max); }
  }
  if (cur) out.push(cur);
  return out;
}

function decodeEntities(s) {
  const el = document.createElement('textarea');
  el.innerHTML = s;
  return el.value;
}
