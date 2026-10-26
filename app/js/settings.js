// User settings, saved on this device.

const KEY = 'books.settings';

const defaults = {
  theme: 'auto',            // auto | light | paper | dark | black | dusk | forest
  highlight: 'word',        // off | sentence | word
  follow: true,             // keep the current sentence in view
  view: 'text',             // text | page  (page = original PDF)
  readerSize: 19,
  readerFont: 'serif',      // serif | sans
  speed: 1,
  skipBack: 15,
  skipForward: 30,
  defaultVoice: 'af_heart',
  ambient: {},             // background sound id -> volume 0..1
  ambientFollow: true,      // background sounds pause with the book
  pdfDark: null,            // original PDF pages inverted: null = follow the theme
  repo: '',
  token: '',
};

let current = { ...defaults, ...load() };
const listeners = new Set();

function load() {
  try { return JSON.parse(localStorage.getItem(KEY) || '{}'); } catch { return {}; }
}

export const settings = {
  get: (k) => current[k],
  all: () => ({ ...current }),
  set(patch) {
    current = { ...current, ...patch };
    try { localStorage.setItem(KEY, JSON.stringify(current)); } catch {}
    if ('theme' in patch) applyTheme();
    if ('readerSize' in patch) applyReaderSize();
    listeners.forEach((fn) => fn(patch));
  },
  onChange(fn) { listeners.add(fn); return () => listeners.delete(fn); },
};

export const THEMES = [
  ['auto', 'Auto', null, null],
  ['light', 'Light', '#f7f6f2', '#1d1c1a'],
  ['paper', 'Paper', '#f3ead8', '#3b2f22'],
  ['forest', 'Forest', '#e9efe6', '#1f2a1e'],
  ['dark', 'Dark', '#17181a', '#e9e7e2'],
  ['dusk', 'Dusk', '#1b1d2b', '#e7e6f2'],
  ['black', 'Black', '#000000', '#e6e4df'],
];

const darkQuery = matchMedia('(prefers-color-scheme: dark)');

export function applyTheme() {
  let t = current.theme;
  if (t === 'auto') t = darkQuery.matches ? 'dark' : 'light';
  document.documentElement.dataset.theme = t;
  const bg = getComputedStyle(document.documentElement).getPropertyValue('--bg').trim();
  document.querySelector('meta[name=theme-color]')?.setAttribute('content', bg);
}

export function applyReaderSize() {
  document.documentElement.style.setProperty('--reader-size', current.readerSize + 'px');
}

darkQuery.addEventListener?.('change', applyTheme);
