// Small shared helpers: event emitter, ring-buffer log, ids, environment detection.

export class Emitter {
  constructor() { this.handlers = {}; }
  on(event, fn) { (this.handlers[event] ??= []).push(fn); return this; }
  emit(event, ...args) { (this.handlers[event] || []).forEach(fn => fn(...args)); }
}

const logLines = [];
export function log(src, msg) {
  const line = `${new Date().toISOString().slice(11, 19)} [${src}] ${msg}`;
  logLines.push(line);
  if (logLines.length > 100) logLines.shift();
  console.log(line);
}
export const getLog = () => logLines.slice();

const ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789';
export function randomId(n = 8) {
  const bytes = crypto.getRandomValues(new Uint8Array(n));
  return Array.from(bytes, b => ALPHABET[b % ALPHABET.length]).join('');
}

export const baseLang = tag => (tag || '').split('-')[0].toLowerCase();

export function env() {
  const ua = navigator.userAgent;
  const ios = /iPhone|iPad|iPod/.test(ua) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  let browser;
  if (ios) {
    browser = /CriOS/.test(ua) ? 'iOS Chrome' : /FxiOS/.test(ua) ? 'iOS Firefox' : /EdgiOS/.test(ua) ? 'iOS Edge' : 'iOS Safari';
  } else if (/Android/.test(ua)) {
    browser = /Chrome/.test(ua) ? 'Android Chrome' : 'Android browser';
  } else {
    browser = /Edg\//.test(ua) ? 'Desktop Edge' : /Chrome/.test(ua) ? 'Desktop Chrome' : /Safari/.test(ua) ? 'Desktop Safari' : /Firefox/.test(ua) ? 'Desktop Firefox' : 'Desktop';
  }
  return { ios, browser, iosNonSafari: ios && browser !== 'iOS Safari' };
}
