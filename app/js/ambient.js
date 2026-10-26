// Background sounds mixed under the book: nature loops, music stations that
// shuffle songs and crossfade between them, and your own files.
// Everything goes through Web Audio so each sound has its own volume
// (iPhones ignore the volume of plain <audio> elements).

import { db } from './db.js';
import { settings } from './settings.js';

const book = document.getElementById('audio');
const listeners = new Set();
let ctx = null;
let builtIns = null;
const loaded = new Map(); // id -> AudioBuffer
const playing = new Map(); // id -> { src, gain } for loops, or a Station
const FADE = 6; // seconds songs overlap when a station moves to the next one

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

/** A music station: plays its songs in random order, fading each into the next. */
class Station {
  constructor(item) {
    this.item = item;
    this.out = ctx.createGain();
    this.out.gain.value = 0;
    this.out.connect(ctx.destination);
    this.decks = [this.deck(), this.deck()];
    this.cur = 0;
    this.bag = [];
    this.last = -1;
    this.fading = false;
    this.paused = false;
  }

  deck() {
    const el = new Audio();
    el.preload = 'auto';
    el.playsInline = true;
    const gain = ctx.createGain();
    gain.gain.value = 0;
    ctx.createMediaElementSource(el).connect(gain).connect(this.out);
    const d = { el, gain, track: null };
    el.addEventListener('timeupdate', () => this.check(d));
    el.addEventListener('ended', () => { if (d === this.decks[this.cur]) this.next(0.5); });
    return d;
  }

  pick() {
    if (!this.bag.length) {
      this.bag = this.item.tracks.map((_, i) => i).sort(() => Math.random() - 0.5);
      if (this.bag[0] === this.last && this.bag.length > 1) this.bag.push(this.bag.shift());
    }
    this.last = this.bag.shift();
    return this.item.tracks[this.last];
  }

  async play(d, track, fadeIn, offset = 0) {
    d.track = track;
    d.el.src = track.file;
    if (offset) d.el.addEventListener('loadedmetadata', () => { d.el.currentTime = offset; }, { once: true });
    d.gain.gain.cancelScheduledValues(ctx.currentTime);
    d.gain.gain.setValueAtTime(0, ctx.currentTime);
    d.gain.gain.linearRampToValueAtTime(1, ctx.currentTime + fadeIn);
    if (!this.paused) await d.el.play().catch(() => {});
    emit();
  }

  start(volume) {
    this.setVolume(volume);
    const track = this.pick();
    // Start somewhere inside the first song so it doesn't always open the same way.
    this.play(this.decks[this.cur], track, 2, Math.random() * Math.max(0, (track.duration || 120) * 0.6));
  }

  check(d) {
    if (d !== this.decks[this.cur] || this.fading || !d.el.duration) return;
    if (d.el.duration - d.el.currentTime <= FADE) this.next(FADE);
  }

  next(fade) {
    this.fading = true;
    const old = this.decks[this.cur];
    this.cur = 1 - this.cur;
    old.gain.gain.cancelScheduledValues(ctx.currentTime);
    old.gain.gain.setValueAtTime(old.gain.gain.value, ctx.currentTime);
    old.gain.gain.linearRampToValueAtTime(0, ctx.currentTime + fade);
    setTimeout(() => { if (old !== this.decks[this.cur]) old.el.pause(); this.fading = false; }, fade * 1000 + 200);
    this.play(this.decks[this.cur], this.pick(), fade);
  }

  setVolume(v) { this.out.gain.setTargetAtTime(gainFor(v), ctx.currentTime, 0.08); }

  pause() {
    this.paused = true;
    this.decks.forEach((d) => d.el.pause());
  }

  resume() {
    if (!this.paused) return;
    this.paused = false;
    this.decks[this.cur].el.play().catch(() => {});
    if (this.fading) this.decks[1 - this.cur].el.play().catch(() => {});
  }

  stop() {
    this.out.gain.setTargetAtTime(0, ctx.currentTime, 0.3);
    setTimeout(() => { this.decks.forEach((d) => { d.el.pause(); d.el.removeAttribute('src'); }); this.out.disconnect(); }, 1500);
  }

  get nowPlaying() { return this.decks[this.cur].track; }
}

async function start(id) {
  if (playing.has(id)) return;
  const c = context();
  const station = (await ambient.builtIns()).find((s) => s.id === id && s.tracks);
  if (station) {
    const st = new Station(station);
    playing.set(id, st);
    st.start(active()[id]);
    return;
  }
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
  if (p instanceof Station) return p.stop();
  p.gain.gain.setTargetAtTime(0, ctx.currentTime, 0.25);
  setTimeout(() => { try { p.src.stop(); } catch {} }, 1200);
}

export const ambient = {
  onChange(fn) { listeners.add(fn); return () => listeners.delete(fn); },

  async builtIns() {
    if (!builtIns) {
      builtIns = await fetch('sounds/index.json').then((r) => r.json()).catch(() => []);
      // Forget sounds that were removed in an update (custom ones start with "c").
      const a = active();
      const gone = Object.keys(a).filter((id) => !id.startsWith('c') && !builtIns.some((s) => s.id === id));
      if (builtIns.length && gone.length) { gone.forEach((id) => delete a[id]); settings.set({ ambient: a }); emit(); }
    }
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
    if (p instanceof Station) p.setVolume(v);
    else if (p) p.gain.gain.setTargetAtTime(gainFor(v), ctx.currentTime, 0.08);
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
    for (const p of playing.values()) if (p instanceof Station) p.resume();
    for (const id of Object.keys(active())) {
      start(id).catch(() => {
        // A sound that no longer exists (e.g. renamed in an update): switch it off.
        if (!id.startsWith('c')) { const left = active(); delete left[id]; settings.set({ ambient: left }); emit(); }
      });
    }
  },

  pause() {
    for (const p of playing.values()) if (p instanceof Station) p.pause();
    if (ctx && ctx.state === 'running') ctx.suspend().catch(() => {});
  },

  /** The song a music station is playing right now, if any. */
  nowPlaying(id) {
    const p = playing.get(id);
    return p instanceof Station ? p.nowPlaying : null;
  },
};

// Follow the book: sounds pause and resume with it (unless turned off in the sheet).
book.addEventListener('play', () => ambient.resume());
book.addEventListener('pause', () => { if (settings.get('ambientFollow') !== false) ambient.pause(); });
