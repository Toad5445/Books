// The bookshelf (home screen).

import { h, svg, toast, hashHue, fmtDuration } from '../ui.js';
import { icons } from '../icons.js';
import { library } from '../library.js';
import { pc } from '../pc.js';
import { openAddSheet } from './add.js';
import { openSettings } from './settings.js';
import { openBookSheet } from './book-sheet.js';

let filter = 'all';
const coverUrls = new Map(); // sha -> object URL

export function renderShelf(root) {
  const page = h('div', { class: 'shelf-page' });
  root.replaceChildren(page);

  const draw = () => {
    const books = library.sorted();
    const top = h('header', { class: 'topbar' },
      h('h1', {}, 'Library'),
      h('button', { class: 'icon-btn', 'aria-label': 'Refresh', onclick: () => library.refresh() },
        svg(library.syncing ? icons.spinner.replace('<svg', '<svg style="animation:spin 1s linear infinite"') : icons.refresh)),
      h('button', { class: 'icon-btn', 'aria-label': 'Settings', onclick: openSettings }, svg(icons.settings)),
    );

    const parts = [top];

    if (!library.configured()) {
      parts.push(welcome());
      page.replaceChildren(...parts);
      return;
    }

    if (library.error) {
      parts.push(banner(icons.info, 'Can’t reach your library', library.error, false));
    }
    if (pc.available) parts.push(pcBanner(books));
    else {
      const waiting = books.filter((b) => b.status === 'queued');
      const converting = books.filter((b) => b.status === 'converting');
      if (converting.length) {
        const b = converting[0];
        parts.push(banner(icons.pc, `Converting “${b.title}”`, b.message || 'Your PC is working on it', true, b.progress));
      }
      if (waiting.length) {
        parts.push(banner(icons.clock,
          `${waiting.length} book${waiting.length > 1 ? 's' : ''} waiting for your PC`,
          'Open Books Converter on your PC and press Convert.', false));
      }
    }

    const counts = {
      all: books.length,
      queue: books.filter((b) => ['queued', 'converting', 'error'].includes(b.status)).length,
      ready: books.filter((b) => library.state(b).label === 'ready').length,
      downloaded: books.filter((b) => library.local.has(b.id)).length,
    };
    if (books.length) {
      parts.push(h('div', { class: 'chips' },
        ...[['all', 'All'], ['queue', 'Queue'], ['ready', 'To download'], ['downloaded', 'On this device']]
          .filter(([k]) => k === 'all' || counts[k])
          .map(([k, label]) => h('button', { class: 'chip' + (filter === k ? ' on' : ''), onclick: () => { filter = k; draw(); } },
            `${label}${k === 'all' ? '' : ' · ' + counts[k]}`))));
    }

    const shown = books.filter((b) =>
      filter === 'all' ? true
        : filter === 'queue' ? ['queued', 'converting', 'error'].includes(b.status)
          : filter === 'ready' ? library.state(b).label === 'ready'
            : library.local.has(b.id));

    if (!books.length && library.synced) {
      parts.push(h('div', { class: 'empty' },
        h('div', { class: 'art' }, svg(icons.book)),
        h('h2', {}, 'Your shelf is empty'),
        h('p', {}, 'Add a PDF or EPUB. Your PC turns it into an audiobook, and it shows up here to listen to.'),
        h('button', { class: 'btn primary', onclick: openAddSheet }, svg(icons.plus), 'Add a book')));
    } else if (!books.length) {
      parts.push(h('div', { class: 'empty' }, h('p', {}, library.syncing ? 'Loading your library…' : '')));
    }

    parts.push(h('div', { class: 'shelf' }, ...shown.map(card)));
    parts.push(h('button', { class: 'fab', 'aria-label': 'Add a book', onclick: openAddSheet }, svg(icons.plus)));
    page.replaceChildren(...parts);
  };

  draw();
  const off1 = library.onChange(draw);
  const off2 = pc.onChange(draw);
  return () => { off1(); off2(); };
}

function welcome() {
  return h('div', { class: 'empty' },
    h('div', { class: 'art' }, svg(icons.book)),
    h('h2', {}, 'Welcome to Audiobooks'),
    h('p', {}, 'Connect your private library on GitHub to get started. It’s where your PC and phone swap books and audio.'),
    h('button', { class: 'btn primary', onclick: () => openSettings({ focus: 'library' }) }, svg(icons.key), 'Connect library'));
}

function banner(icon, title, text, ok, progress) {
  return h('div', { class: 'banner' },
    h('div', { class: 'ic' + (ok ? ' ok' : '') }, svg(icon)),
    h('div', { class: 'body' },
      h('b', {}, title),
      h('div', { class: 'muted' }, text),
      progress != null ? h('div', { class: 'bar' }, h('i', { style: { width: `${Math.round(progress * 100)}%` } })) : null));
}

function pcBanner(books) {
  const st = pc.status || {};
  const engine = st.engine || {};
  const running = (id) => ['running', 'waiting'].includes(st.jobs?.[id]?.state);
  const queued = books.filter((b) => ['queued', 'error'].includes(b.status) || (b.status === 'converting' && !running(b.id)));
  const current = st.current && st.jobs?.[st.current];
  let title, text;
  if (current) {
    const book = library.books.get(st.current);
    title = st.current === '__voices__' ? 'Recording voice samples' : `Converting “${book?.title || st.current}”`;
    text = current.message;
  } else if (engine.state === 'loading') {
    title = 'Starting the voice engine…'; text = 'Loading Kokoro. This takes a few seconds.';
  } else if (engine.state === 'error') {
    title = 'The voice engine didn’t start'; text = engine.message;
  } else {
    title = queued.length ? `${queued.length} book${queued.length > 1 ? 's' : ''} in the queue` : 'PC converter ready';
    text = engine.device === 'cuda' ? 'Using your NVIDIA graphics card.' : engine.device === 'cpu' ? 'No graphics card found, so conversion will be slow.' : 'Connected to this PC.';
  }
  return h('div', { class: 'banner' },
    h('div', { class: 'ic ok' }, svg(icons.pc)),
    h('div', { class: 'body' },
      h('b', {}, title),
      h('div', { class: 'muted' }, text || ''),
      current ? h('div', { class: 'bar' }, h('i', { style: { width: `${Math.round((current.progress || 0) * 100)}%` } })) : null),
    !current && queued.length
      ? h('button', { class: 'btn primary small', onclick: async () => {
        await pc.convert(queued.map((b) => b.id));
        toast(`Converting ${queued.length} book${queued.length > 1 ? 's' : ''}`);
      } }, queued.length > 1 ? 'Convert all' : 'Convert')
      : null);
}

function card(book) {
  const st = library.state(book);
  const job = pc.available ? pc.job(book.id) : null;
  const progress = library.progressCache.get(book.id);
  const listened = progress && book.audio?.duration ? Math.min(1, progress.time / book.audio.duration) : 0;

  const cover = h('div', { class: 'cover' });
  const coverEntry = library.tree[`books/${book.id}/cover.jpg`];
  if (coverEntry) {
    const url = coverUrls.get(coverEntry.sha);
    if (url) cover.append(h('img', { src: url, alt: '' }));
    else {
      cover.append(generated(book));
      library.cover(book.id).then((blob) => {
        if (!blob) return;
        const u = URL.createObjectURL(blob);
        coverUrls.set(coverEntry.sha, u);
        cover.replaceChildren(h('img', { src: u, alt: '' }), ...extras());
      }).catch(() => {});
    }
  } else cover.append(generated(book));
  const extras = () => [
    h('span', { class: 'kind' }, (book.format || 'pdf').toUpperCase()),
    listened > 0.005 ? h('div', { class: 'listened' }, h('i', { style: { width: `${listened * 100}%` } })) : null,
  ].filter(Boolean);
  cover.append(...extras());

  const badges = [];
  const pcJobRunning = job && ['running', 'waiting'].includes(job.state);
  // On the PC, "converting" with nothing running here means the converter was closed mid-way.
  const interrupted = pc.available && !pcJobRunning && st.label === 'converting';
  switch (interrupted ? 'interrupted' : st.label) {
    case 'interrupted': badges.push(badge('bad', 'Interrupted')); break;
    case 'uploading': badges.push(badge('work', `Uploading ${Math.round(st.uploading * 100)}%`, true)); break;
    case 'downloading': badges.push(badge('work', `Downloading ${Math.round(st.downloading * 100)}%`, true)); break;
    case 'converting': badges.push(badge('work', `Converting ${Math.round((pcJobRunning ? job.progress : book.progress || 0) * 100)}%`, true)); break;
    case 'queued': badges.push(badge('queue', pcJobRunning ? 'Up next' : 'In queue')); break;
    case 'revoice': badges.push(badge('queue', 'Re-voice queued')); break;
    case 'error': badges.push(badge('bad', 'Problem')); break;
    case 'ready': badges.push(badge('ready', 'Tap to download')); break;
    case 'update': badges.push(badge('ready', 'New audio ready')); break;
    default:
      if (book.audio?.duration) badges.push(h('span', { class: 'badge' }, listened > 0.995 ? 'Finished' : listened > 0 ? `${fmtDuration(book.audio.duration * (1 - listened))} left` : fmtDuration(book.audio.duration)));
  }
  if (pc.available && !pcJobRunning && (interrupted || ['queued', 'revoice', 'error'].includes(st.label))) {
    badges.push(h('button', { class: 'btn primary small', style: { height: '26px', padding: '0 10px', fontSize: '12.5px' },
      onclick: async (e) => { e.stopPropagation(); await pc.convert([book.id]); toast(`Converting “${book.title}”`); } }, 'Convert'));
  }
  if (pc.available && pcJobRunning) {
    badges.push(h('button', { class: 'btn small', style: { height: '26px', padding: '0 10px', fontSize: '12.5px' },
      onclick: async (e) => { e.stopPropagation(); await pc.cancel(book.id); } }, 'Stop'));
  }

  const onTap = async () => {
    if (st.playable && st.label !== 'update') return (location.hash = `#/book/${encodeURIComponent(book.id)}`);
    if (st.label === 'ready' || st.label === 'update') {
      try { await library.download(book.id); toast(`“${book.title}” is ready to play`); } catch (e) { toast(e.message, { bad: true }); }
      return;
    }
    if (st.playable) return (location.hash = `#/book/${encodeURIComponent(book.id)}`);
    openBookSheet(book.id);
  };

  let pressTimer;
  return h('div', { class: 'card', role: 'button', tabindex: 0,
    onclick: onTap,
    oncontextmenu: (e) => { e.preventDefault(); openBookSheet(book.id); },
    ontouchstart: () => { pressTimer = setTimeout(() => { pressTimer = 'fired'; openBookSheet(book.id); }, 550); },
    ontouchend: (e) => { if (pressTimer === 'fired') e.preventDefault(); clearTimeout(pressTimer); },
    ontouchmove: () => clearTimeout(pressTimer) },
  cover,
  h('div', { class: 'meta' },
    h('div', { class: 'name' }, book.title || 'Untitled'),
    book.author ? h('div', { class: 'author ellipsis' }, book.author) : null,
    h('div', { class: 'row' }, ...badges,
      h('button', { class: 'icon-btn', style: { width: '28px', height: '28px', marginLeft: 'auto' }, 'aria-label': 'Options',
        onclick: (e) => { e.stopPropagation(); openBookSheet(book.id); } }, svg(icons.more)))));
}

function badge(kind, text, pulse) {
  return h('span', { class: `badge ${kind}` }, h('span', { class: 'dot' + (pulse ? ' pulse' : '') }), text);
}

export function generated(book) {
  const hue = hashHue(book.title || book.id);
  return h('div', { class: 'gen', style: { background: `linear-gradient(160deg, hsl(${hue} 38% 42%), hsl(${(hue + 40) % 360} 42% 26%))` } },
    h('div', { class: 't' }, book.title || 'Untitled'),
    h('div', { class: 'a' }, book.author || ''));
}
