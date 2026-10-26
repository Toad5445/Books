import { h, svg } from './ui.js';
import { icons } from './icons.js';
import { applyTheme, applyReaderSize, settings } from './settings.js';
import { library } from './library.js';
import { pc } from './pc.js';
import { renderShelf } from './views/shelf.js';
import { renderPlayer, nowPlaying } from './views/player.js';

const app = document.getElementById('app');
const audio = document.getElementById('audio');
let cleanup = null;
let routeSeq = 0;

async function route() {
  const seq = ++routeSeq;
  cleanup?.();
  cleanup = null;
  const m = location.hash.match(/^#\/book\/(.+)$/);
  window.scrollTo(0, 0);
  const off = m ? await renderPlayer(app, decodeURIComponent(m[1])) : renderShelf(app);
  if (seq !== routeSeq) { off?.(); return; }
  cleanup = off;
  drawMiniPlayer();
}

// A small "now playing" bar on the shelf while a book keeps playing.
const mini = h('button', {
  class: 'banner', hidden: true,
  style: { position: 'fixed', left: '12px', right: '86px', bottom: 'calc(env(safe-area-inset-bottom, 0px) + 22px)', margin: 0, zIndex: 19, textAlign: 'left' },
  onclick: () => { const b = nowPlaying(); if (b) location.hash = `#/book/${encodeURIComponent(b.id)}`; },
});
document.body.append(mini);
function drawMiniPlayer() {
  const book = nowPlaying();
  const onShelf = !location.hash.startsWith('#/book/');
  mini.hidden = !(book && onShelf);
  if (mini.hidden) return;
  mini.replaceChildren(
    h('div', { class: 'ic ok' }, svg(icons.voice)),
    h('div', { class: 'body' }, h('b', { class: 'ellipsis' }, book.title), h('div', { class: 'muted' }, 'Playing · tap to open')),
    h('span', { class: 'icon-btn', role: 'button', 'aria-label': 'Pause', onclick: (e) => { e.stopPropagation(); audio.pause(); } }, svg(icons.pause)));
}
audio.addEventListener('play', drawMiniPlayer);
audio.addEventListener('pause', drawMiniPlayer);

async function start() {
  applyTheme();
  applyReaderSize();
  await library.init();
  await library.loadProgressCache();

  // Opened on the PC from the converter: share the library connection with it.
  if (await pc.detect()) {
    try {
      const cfg = await pc.config();
      if (cfg.repo && cfg.token && !library.configured()) settings.set({ repo: cfg.repo, token: cfg.token });
      else if (!cfg.token && library.configured()) await pc.saveConfig(settings.get('repo'), settings.get('token'));
    } catch {}
    pc.startPolling(() => library.refresh());
  }

  window.addEventListener('hashchange', route);
  await route();
  library.refresh();

  // Keep the shelf fresh: often while something is converting, rarely otherwise.
  let last = Date.now();
  setInterval(() => {
    if (document.visibilityState !== 'visible') return;
    const busy = [...library.books.values()].some((b) => b.status === 'queued' || b.status === 'converting');
    if (Date.now() - last > (busy ? 30000 : 180000)) { last = Date.now(); library.refresh(); }
  }, 5000);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && Date.now() - last > 10000) { last = Date.now(); library.refresh(); }
  });

  if ('serviceWorker' in navigator && !['localhost', '127.0.0.1'].includes(location.hostname)) {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }
}

start();
