// Voice previews: instant samples recorded by the PC, or generated on the phone.

import { library } from './library.js';

let worker;
let seq = 0;
const pending = new Map();
const cache = new Map(); // voice|text -> blob

// One shared element, "unlocked" on the first tap so iOS lets it play later
// even after waiting for a preview to be generated.
const player = new Audio();
player.playsInline = true;
const SILENCE = 'data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEAIlYAAESsAAACABAAZGF0YQAAAAA=';
let unlocked = false;
export function unlockAudio() {
  if (unlocked) return;
  unlocked = true;
  player.src = SILENCE;
  player.play().catch(() => {});
}

let playingKey = null;
const listeners = new Set();
export const onPreviewChange = (fn) => { listeners.add(fn); return () => listeners.delete(fn); };
const emit = () => listeners.forEach((fn) => fn(playingKey));
player.addEventListener('ended', () => { playingKey = null; emit(); });

export function stopPreview() {
  player.pause();
  playingKey = null;
  emit();
}

export function previewPlaying() { return playingKey; }

async function play(blob, key) {
  if (player.src.startsWith('blob:')) URL.revokeObjectURL(player.src);
  document.getElementById('audio')?.pause(); // don't talk over the book
  player.src = URL.createObjectURL(blob);
  playingKey = key;
  emit();
  await player.play();
}

/** Play the PC-recorded sample for a voice, or make one on the phone. */
export async function playSample(voice, onStatus) {
  unlockAudio();
  const key = `sample:${voice}`;
  if (playingKey === key) return stopPreview();
  stopPreview();
  let blob = null;
  try { blob = await library.voiceSample(voice); } catch {}
  if (!blob) blob = await generate(voice, 'Hello! This is how I would sound reading your book aloud.', onStatus);
  await play(blob, key);
}

/** Read the given text in a voice, generated on the phone. */
export async function playText(voice, text, onStatus) {
  unlockAudio();
  const key = `text:${voice}`;
  if (playingKey === key) return stopPreview();
  stopPreview();
  const blob = await generate(voice, text, onStatus);
  await play(blob, key);
}

function generate(voice, text, onStatus = () => {}) {
  const ck = voice + '|' + text;
  if (cache.has(ck)) return Promise.resolve(cache.get(ck));
  worker ??= new Worker(new URL('./preview-worker.js', import.meta.url), { type: 'module' });
  worker.onmessage = ({ data }) => {
    const p = pending.get(data.id);
    if (!p) return;
    if (data.status === 'done') { pending.delete(data.id); cache.set(p.ck, data.blob); p.resolve(data.blob); }
    else if (data.status === 'error') { pending.delete(data.id); p.reject(new Error(data.message)); }
    else p.onStatus(data);
  };
  worker.onerror = (e) => {
    for (const p of pending.values()) p.reject(new Error('The on-phone voice engine failed to load.'));
    pending.clear();
    worker = null;
  };
  return new Promise((resolve, reject) => {
    const id = ++seq;
    pending.set(id, { resolve, reject, onStatus, ck });
    worker.postMessage({ id, text, voice });
  });
}
