// Background sounds mixed under the book: built-in loops plus your own files.
// Uses Web Audio so each sound loops gaplessly and has its own volume
// (iPhones ignore the volume of plain <audio> elements).

import { db } from './db.js';
import { settings } from './settings.js';

const book = document.getElementById('audio');
const listeners = new Set();
let ctx = null;
let builtIns = null;
const loaded = new Map(); // id -> AudioBuffer
const playing = new Map(); // id -> { src, gain }

const active = () => ({ ...(settings.get('ambient') || {}) }); // id -> volume 0..1
const emit = () => listeners.forEach((fn) => fn());
const gainFor = (v) => v * v * 0.9; // feels more even than linear

function context() {
  if (!ctx) {
    // Keep playing with the screen locked and the ring switch on silent.
    try { if (navigator.audioSession) navigator.audioSession.type = 'playback'; } catch {}
    ctx = new (window.AudioContext || window.webkitAudioContext)();
  }
  if (ctx.state !== 'running') ctx.resume().catch(() => {});
  return ctx;
}

async function load(id) {
  if (loaded.has(id)) return loaded.get(id);
  let data;
  const item = (await ambient.builtIns()).find((s) => s.id === id);
  if (item) data = await (await fetch(item.file)).arrayBuffer();
  else {
    const custom = await db.get(`sound:${id}`);
    if (!custom) throw new Error('That sound is no longer on this device.');
    data = await custom.blob.arrayBuffer();
  }
  const buffer = await context().decodeAudioData(data);
  loaded.set(id, buffer);
  return buffer;
}

async function start(id) {
  if (playing.has(id)) return;
  const c = context();
  const buffer = await load(id);
  if (playing.has(id) || !(id in active())) return;
  const src = c.createBufferSource();
  src.buffer = buffer;
  src.loop = true;
  const item = builtIns?.find((s) => s.id === id);
  if (item?.loop && buffer.duration > item.loop) src.loopEnd = item.loop; // skip encoder padding
  const gain = c.createGain();
  gain.gain.value = 0;
  gain.gain.setTargetAtTime(gainFor(active()[id]), c.currentTime, 0.4);
  src.connect(gain).connect(c.destination);
  src.start(0, Math.random() * Math.min(buffer.duration, item?.loop || buffer.duration) * 0.9);
  playing.set(id, { src, gain });
}

function stop(id) {
  const p = playing.get(id);
  if (!p) return;
  playing.delete(id);
  p.gain.gain.setTargetAtTime(0, ctx.currentTime, 0.25);
  setTimeout(() => { try { p.src.stop(); } catch {} }, 1200);
}

export const ambient = {
  onChange(fn) { listeners.add(fn); return () => listeners.delete(fn); },

  async builtIns() {
    builtIns ??= await fetch('sounds/index.json').then((r) => r.json()).catch(() => []);
    return builtIns;
  },

  async customs() {
    const out = [];
    for (const key of await db.keys('sound:')) {
      const s = await db.get(key);
      if (s) out.push({ id: key.slice(6), name: s.name, kind: 'custom' });
    }
    return out;
  },

  isOn: (id) => id in active(),
  volume: (id) => active()[id] ?? 0.5,
  anyOn: () => Object.keys(active()).length > 0,

  /** Turn a sound on or off. Turning one on plays it straight away so you can hear it. */
  async toggle(id, on) {
    const a = active();
    if (on) a[id] = a[id] ?? 0.5; else delete a[id];
    settings.set({ ambient: a });
    emit();
    if (on) {
      context();
      await start(id);
    } else stop(id);
  },

  setVolume(id, v) {
    const a = active();
    if (!(id in a)) return;
    a[id] = v;
    settings.set({ ambient: a });
    const p = playing.get(id);
    if (p) p.gain.gain.setTargetAtTime(gainFor(v), ctx.currentTime, 0.08);
  },

  async addCustom(file) {
    const id = 'c' + Date.now().toString(36);
    await db.set(`sound:${id}`, { name: file.name.replace(/\.[^.]+$/, ''), blob: file });
    emit();
    return id;
  },

  async removeCustom(id) {
    await this.toggle(id, false);
    loaded.delete(id);
    await db.del(`sound:${id}`);
    emit();
  },

  /** Start everything that's switched on (called when the book starts playing). */
  resume() {
    if (!this.anyOn()) return;
    context();
    for (const id of Object.keys(active())) start(id).catch(() => {});
  },

  pause() {
    if (ctx && ctx.state === 'running') ctx.suspend().catch(() => {});
  },
};

// Follow the book: sounds pause and resume with it (unless turned off in the sheet).
book.addEventListener('play', () => ambient.resume());
book.addEventListener('pause', () => { if (settings.get('ambientFollow') !== false) ambient.pause(); });
