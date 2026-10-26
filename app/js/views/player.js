// The listening screen: reader on top, timeline and controls at the bottom.

import { h, svg, sheet, toast, fmtTime, segmented } from '../ui.js';
import { icons } from '../icons.js';
import { library } from '../library.js';
import { settings } from '../settings.js';
import { db } from '../db.js';
import { voiceById } from '../voices.js';
import { createTextReader } from './text-reader.js';
import { createPdfReader } from './pdf-reader.js';
import { openVoicePicker } from './voice-picker.js';
import { sample } from './book-sheet.js';
import { ambient } from '../ambient.js';
import { point, rect, isLocked, setLocked } from '../rotation.js';
import { openAmbientSheet } from './ambient-sheet.js';

const audio = document.getElementById('audio');
let session = null; // what's loaded in the audio element: { id, url, manifest, book }

// iPhones don't load audio until it's played, and quietly ignore a jump made
// before then. So a jump made too early is remembered and applied once the
// audio is ready, and the rest of the app reads the time through now().
let pendingTime = null;
const now = () => (pendingTime != null ? pendingTime : audio.currentTime);
function setAudioTime(t) {
  if (audio.readyState >= 1) {
    try { audio.currentTime = t; pendingTime = null; return; } catch {}
  }
  pendingTime = t;
}
for (const ev of ['loadedmetadata', 'canplay', 'playing']) {
  audio.addEventListener(ev, () => {
    if (pendingTime == null || audio.readyState < 1) return;
    const t = pendingTime;
    pendingTime = null;
    try { audio.currentTime = t; } catch { pendingTime = t; }
  });
}

// Sleep timer survives leaving the player screen. It's checked on the audio's own
// time updates, which keep firing when the phone is locked (timers may not).
const sleep = { until: null, endOfChapter: false, chapterEnd: null, onFire: null };
audio.addEventListener('timeupdate', () => {
  const byClock = sleep.until && Date.now() >= sleep.until;
  const byChapter = sleep.endOfChapter && sleep.chapterEnd != null && now() >= sleep.chapterEnd;
  if (!byClock && !byChapter) return;
  audio.pause();
  sleep.until = null; sleep.endOfChapter = false; sleep.chapterEnd = null;
  sleep.onFire?.();
});

// Keep saving the listening position while playing, even after leaving the player.
setInterval(() => {
  if (session && !audio.paused) library.saveProgress(session.id, now(), session.duration);
}, 10000);
audio.addEventListener('pause', () => { if (session) library.saveProgress(session.id, now(), session.duration); });

export async function renderPlayer(root, id) {
  const book = library.books.get(id);
  root.replaceChildren(h('div', { class: 'reader-loading' }, 'Opening…'));
  const [manifest, blob] = await Promise.all([db.get(`manifest:${id}`), db.get(`audio:${id}`)]);
  if (!book || !manifest || !blob) {
    root.replaceChildren(h('div', { class: 'empty' },
      h('h2', {}, 'Not downloaded'), h('p', {}, 'Download this book from your shelf first.'),
      h('button', { class: 'btn primary', onclick: () => (location.hash = '#/') }, 'Back to shelf')));
    return () => {};
  }

  const segs = manifest.segs;
  const starts = segs.map((s) => s.a);
  const duration = manifest.duration || segs.at(-1)?.b || 0;
  const chapters = manifest.chapters || [];
  const pages = manifest.pages || [];
  const isPdf = manifest.kind === 'pdf';

  // Load (or keep) this book in the audio element.
  if (session?.id !== id || session.audioVersion !== library.local.get(id)?.audioVersion) {
    if (session?.url) URL.revokeObjectURL(session.url);
    audio.pause();
    const version = library.local.get(id)?.audioVersion;
    // Through the service worker the audio behaves like a normal web file that
    // the iPhone can jump around in; a blob URL is the fallback (e.g. on the PC).
    const url = navigator.serviceWorker?.controller ? null : URL.createObjectURL(blob);
    pendingTime = null;
    audio.src = url || `audio/${encodeURIComponent(id)}.m4a?v=${version}`;
    session = { id, url, duration, audioVersion: version };
    const saved = await library.progress(id);
    const startAt = saved && saved.time < duration - 2 ? saved.time : 0;
    await new Promise((res) => {
      if (audio.readyState >= 1) return res();
      audio.addEventListener('loadedmetadata', res, { once: true });
      setTimeout(res, 3000);
    });
    setAudioTime(startAt);
  }
  audio.playbackRate = settings.get('speed');
  audio.preservesPitch = true;

  const segAt = (t) => {
    let lo = 0, hi = starts.length - 1, ans = 0;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (starts[mid] <= t + 0.01) { ans = mid; lo = mid + 1; } else hi = mid - 1;
    }
    return ans;
  };
  const chapterAt = (i) => {
    let c = null;
    for (const ch of chapters) { if (ch.seg <= i) c = ch; else break; }
    return c;
  };
  const pageLabel = (p) => pages[p]?.label ?? String(p + 1);

  // ------------------------------------------------------------ layout

  let view = isPdf ? settings.get('view') : 'text';
  const readerBox = h('div', { class: 'reader' });
  const isDarkTheme = () => ['dark', 'black', 'dusk'].includes(document.documentElement.dataset.theme);
  const pdfDark = () => settings.get('pdfDark') ?? isDarkTheme();
  const darkBtn = h('button', { class: 'page-dark-btn', 'aria-label': 'Dark pages', hidden: true,
    onclick: () => { settings.set({ pdfDark: !pdfDark() }); toast(pdfDark() ? 'Dark pages on' : 'Dark pages off'); } }, svg(icons.contrast));
  const followPill = h('button', { class: 'follow-pill', hidden: true, onclick: () => { userScrolledAt = 0; followPill.hidden = true; reader?.scrollTo(current); } },
    svg(icons.target), 'Back to where you are');
  const viewToggle = isPdf
    ? segmented([['text', 'Text'], ['page', 'Page']], view, (v) => { view = v; settings.set({ view: v }); mountReader(); })
    : null;
  if (viewToggle) viewToggle.style.width = '128px';

  const top = h('header', { class: 'topbar' },
    h('button', { class: 'icon-btn', 'aria-label': 'Back', onclick: () => (location.hash = '#/') }, svg(icons.back)),
    h('div', { class: 'title' }, h('div', { class: 'ellipsis' }, book.title), h('div', { class: 'sub ellipsis' }, book.author || voiceById(book.voice).name)),
    viewToggle,
    h('button', { class: 'icon-btn', 'aria-label': 'More', onclick: openMenu }, svg(icons.more)));

  const whereBtn = h('button', { class: 'ellipsis', onclick: openGoTo });
  const soundsBtn = h('button', { class: 'muted', 'aria-label': 'Background sounds', style: { display: 'flex' }, onclick: openAmbientSheet });
  const drawSounds = () => {
    soundsBtn.replaceChildren(svg(icons.waves.replace('<svg', '<svg width="17" height="17"')));
    soundsBtn.style.color = ambient.anyOn() ? 'var(--accent)' : '';
  };
  const offAmbient = ambient.onChange(drawSounds);
  const sleepBtn = h('button', { class: 'muted', style: { fontWeight: 600, display: 'flex', gap: '4px', alignItems: 'center' }, onclick: openSleep });
  const scrub = h('div', { class: 'scrub' });
  const track = h('div', { class: 'track' }, h('div', { class: 'fill' }));
  const ticks = h('div', { class: 'ticks' });
  const knob = h('div', { class: 'knob' });
  const bubble = h('div', { class: 'bubble', hidden: true });
  scrub.append(track, ticks, knob, bubble);
  for (const ch of chapters) {
    const t = segs[ch.seg]?.a;
    if (t > 0 && duration) ticks.append(h('i', { style: { left: `${(t / duration) * 100}%` } }));
  }
  const tNow = h('span', {}, '0:00');
  const tLeft = h('span', {}, '');

  const playBtn = h('button', { class: 'play', 'aria-label': 'Play', onclick: togglePlay });
  const speedBtn = h('button', { class: 'side', onclick: openSpeed });
  const backBtn = h('button', { class: 'skip', 'aria-label': 'Skip back', onclick: () => skip(-settings.get('skipBack')) }, svg(icons.rewind), h('span', {}, settings.get('skipBack')));
  const fwdBtn = h('button', { class: 'skip', 'aria-label': 'Skip forward', onclick: () => skip(settings.get('skipForward')) }, svg(icons.forward), h('span', {}, settings.get('skipForward')));
  const chapBtn = h('button', { class: 'side', 'aria-label': 'Chapters and pages', onclick: openChapters }, svg(icons.list));

  const controls = h('div', { class: 'controls' },
    h('div', { class: 'where' }, whereBtn, h('div', { style: { display: 'flex', gap: '14px', alignItems: 'center', flex: 'none' } }, soundsBtn, sleepBtn)),
    scrub,
    h('div', { class: 'times' }, tNow, tLeft),
    h('div', { class: 'transport' }, speedBtn, backBtn, playBtn, fwdBtn, chapBtn));

  const page = h('div', { class: 'player-page' }, top, h('div', { class: 'reader-wrap' }, readerBox, followPill, darkBtn), controls);
  root.replaceChildren(page);

  // Focus mode: the controls fade away while you read and come back with a tap.
  // Scrolling doesn't bring them back (a scroll never produces a click).
  let hideTimer = 0;
  // How much of the reader the controls cover right now. Normally none (they sit
  // above and below it); in focus mode they float over it, or only the iPhone's
  // own status bar and home bar do when they've faded away.
  const insets = () => {
    if (!settings.get('focusMode')) return { top: 8, bottom: 8 };
    if (page.classList.contains('ui-hidden')) {
      return {
        top: Math.max(8, parseFloat(getComputedStyle(top).paddingTop) || 8),
        bottom: Math.max(16, (parseFloat(getComputedStyle(controls).paddingBottom) || 12) - 12 + 16),
      };
    }
    return { top: top.offsetHeight + 8, bottom: controls.offsetHeight + 8 };
  };
  const setUiHidden = (hidden) => page.classList.toggle('ui-hidden', hidden);
  const scheduleHide = () => {
    clearTimeout(hideTimer);
    if (settings.get('focusMode')) hideTimer = setTimeout(() => setUiHidden(true), 3500);
  };
  const applyFocus = () => {
    const on = !!settings.get('focusMode');
    page.classList.toggle('focus', on);
    if (!on) { clearTimeout(hideTimer); setUiHidden(false); } else scheduleHide();
  };
  readerBox.addEventListener('click', (e) => {
    if (!settings.get('focusMode')) return;
    if (page.classList.contains('ui-hidden')) {
      e.stopPropagation(); // this tap only brings the controls back
      setUiHidden(false);
      scheduleHide();
    } else {
      clearTimeout(hideTimer);
      setUiHidden(true);
    }
  }, true);
  for (const el of [top, controls]) el.addEventListener('pointerdown', scheduleHide);

  // ------------------------------------------------------------ reader

  let reader = null;
  let current = segAt(now());
  let userScrolledAt = 0;
  let programmaticScroll = 0;

  async function mountReader() {
    reader?.destroy();
    reader = null;
    darkBtn.hidden = true;
    readerBox.replaceChildren(h('div', { class: 'reader-loading' }, 'Loading…'));
    const onSeek = (i) => { seek(segs[i].a); if (audio.paused) play(); toast(`Playing from here`); };
    try {
      if (view === 'page') {
        const src = await library.source(id, (got, total) => {
          readerBox.firstChild && (readerBox.firstChild.textContent = `Downloading the original PDF… ${total ? Math.round((got / total) * 100) : ''}%`);
        });
        reader = await createPdfReader(readerBox, manifest, src, { onSeek, insets });
      } else {
        reader = createTextReader(readerBox, manifest, { onSeek, font: settings.get('readerFont'), insets });
      }
    } catch (e) {
      readerBox.replaceChildren(h('div', { class: 'reader-loading' }, `Couldn’t show the ${view === 'page' ? 'original pages' : 'text'}: ${e.message}`));
      return;
    }
    reader.setMode(settings.get('highlight'));
    reader.setDark(pdfDark());
    darkBtn.hidden = view !== 'page';
    reader.setActive(current);
    reader.setTime(now());
    programmaticScroll = Date.now();
    requestAnimationFrame(() => reader?.scrollTo(current, false));
  }

  // Only a real drag that actually moves the text counts as "I'm scrolling myself";
  // a tap or a finger resting on the screen doesn't pause following.
  let touchStartTop = null;
  readerBox.addEventListener('touchstart', () => { touchStartTop = readerBox.scrollTop; }, { passive: true });
  readerBox.addEventListener('touchend', () => { touchStartTop = null; }, { passive: true });
  readerBox.addEventListener('scroll', () => {
    if (touchStartTop != null && Math.abs(readerBox.scrollTop - touchStartTop) > 12) userScrolledAt = Date.now();
  }, { passive: true });
  readerBox.addEventListener('wheel', () => { if (Date.now() - programmaticScroll > 700) userScrolledAt = Date.now(); }, { passive: true });

  // ------------------------------------------------------------ playback

  function play() { audio.play().catch((e) => toast('Couldn’t start playback: ' + e.message, { bad: true })); }
  function togglePlay() { audio.paused ? play() : audio.pause(); }
  function seek(t) {
    setAudioTime(Math.max(0, Math.min(duration - 0.05, t)));
    userScrolledAt = 0;
    tick(true);
  }
  function skip(d) { seek(now() + d); }

  let dragging = null;
  function tick(force = false) {
    const t = dragging != null ? dragging : now();
    const i = segAt(now());
    if (i !== current || force) {
      current = i;
      reader?.setActive(i);
    }
    reader?.setTime(now());
    // Follow along: as soon as the line being read moves into the lower part of
    // the screen (or above it), scroll it back up to about a third of the way down.
    if (settings.get('follow') && reader) {
      const userRecently = Date.now() - userScrolledAt < 6000;
      if (!userRecently && (force || Date.now() - programmaticScroll > 700) && reader.offscreen()) {
        programmaticScroll = Date.now();
        reader.scrollTo(current);
        // iPhones sometimes stop a smooth scroll short; check, then finish the move.
        const settle = programmaticScroll;
        const target = current;
        setTimeout(() => {
          if (programmaticScroll !== settle || Date.now() - userScrolledAt < 6000 || !reader) return;
          programmaticScroll = Date.now();
          reader.scrollTo(target, false);
        }, 650);
      }
      followPill.hidden = !userRecently || !reader.offscreen(true);
    }
    const frac = duration ? t / duration : 0;
    track.firstChild.style.width = `${frac * 100}%`;
    knob.style.left = `${frac * 100}%`;
    tNow.textContent = fmtTime(t);
    tLeft.textContent = '-' + fmtTime((duration - t) / (audio.playbackRate || 1));
    const si = dragging != null ? segAt(dragging) : current;
    const ch = chapterAt(si);
    const where = `Page ${pageLabel(segs[si]?.p ?? 0)} of ${pages.length || '?'}${ch ? ' · ' + ch.title : ''}`;
    if (whereBtn.textContent !== where) whereBtn.textContent = where;
  }

  let raf = 0;
  const loop = () => { tick(); raf = requestAnimationFrame(loop); };
  const onPlay = () => { drawPlay(); cancelAnimationFrame(raf); loop(); };
  const onPause = () => { drawPlay(); cancelAnimationFrame(raf); tick(); saveProgress(); };
  const drawPlay = () => {
    playBtn.replaceChildren(svg(audio.paused ? icons.play : icons.pause));
    playBtn.setAttribute('aria-label', audio.paused ? 'Play' : 'Pause');
  };
  const onTime = () => { if (audio.paused) tick(); };
  audio.addEventListener('play', onPlay);
  audio.addEventListener('pause', onPause);
  audio.addEventListener('seeked', onTime);
  audio.addEventListener('ended', onPause);

  // Scrubbing: drag along the timeline to see the page and chapter you'd land on.
  const posFromEvent = (e) => {
    const box = rect(scrub);
    return Math.max(0, Math.min(1, (point(e.clientX, e.clientY).x - box.left) / box.width)) * duration;
  };
  const showBubble = (t, x) => {
    const i = segAt(t);
    const ch = chapterAt(i);
    bubble.hidden = false;
    bubble.replaceChildren(`Page ${pageLabel(segs[i]?.p ?? 0)} · ${fmtTime(t)}`, ch ? h('small', {}, ch.title) : '');
    const box = rect(scrub);
    const half = bubble.offsetWidth / 2;
    bubble.style.left = `${Math.max(half, Math.min(box.width - half, x))}px`;
  };
  scrub.addEventListener('pointerdown', (e) => {
    scrub.setPointerCapture(e.pointerId);
    scrub.classList.add('drag');
    dragging = posFromEvent(e);
    showBubble(dragging, point(e.clientX, e.clientY).x - rect(scrub).left);
    tick();
  });
  scrub.addEventListener('pointermove', (e) => {
    if (dragging == null) return;
    dragging = posFromEvent(e);
    showBubble(dragging, point(e.clientX, e.clientY).x - rect(scrub).left);
    tick();
  });
  const endDrag = () => {
    if (dragging == null) return;
    const t = dragging;
    dragging = null;
    scrub.classList.remove('drag');
    bubble.hidden = true;
    seek(t);
  };
  scrub.addEventListener('pointerup', endDrag);
  scrub.addEventListener('pointercancel', endDrag);

  // ------------------------------------------------------------ progress, lock screen

  let lastSave = 0;
  function saveProgress() {
    lastSave = Date.now();
    library.saveProgress(id, now(), duration);
  }
  const saver = setInterval(() => { if (!audio.paused && Date.now() - lastSave > 5000) saveProgress(); }, 5000);
  const onHide = () => { if (document.visibilityState === 'hidden') saveProgress(); };
  document.addEventListener('visibilitychange', onHide);

  setupMediaSession(book, id, { skip, seek, play, duration });

  // ------------------------------------------------------------ sheets

  function drawSpeed() {
    const r = settings.get('speed');
    speedBtn.textContent = `${Number(r.toFixed(2))}×`;
  }
  function openSpeed() {
    sheet(() => {
      const value = h('div', { class: 'speed-value' });
      const slider = h('input', { type: 'range', class: 'slider', min: 0.5, max: 3, step: 0.05, value: settings.get('speed') });
      const apply = (r) => {
        r = Math.round(r * 100) / 100;
        settings.set({ speed: r });
        audio.playbackRate = r;
        value.textContent = `${r}×`;
        slider.value = r;
        drawSpeed();
      };
      slider.addEventListener('input', () => apply(+slider.value));
      apply(settings.get('speed'));
      return [
        h('h2', {}, 'Speed'),
        value, slider,
        h('div', { class: 'preset-row' }, ...[0.8, 1, 1.2, 1.5, 1.75, 2, 2.5].map((r) => h('button', { class: 'chip', onclick: () => apply(r) }, `${r}×`))),
        h('p', { class: 'small muted', style: { textAlign: 'center' } }, 'Changes instantly. The voice keeps its natural pitch.'),
      ];
    });
  }

  function openChapters() {
    sheet(({ close }) => {
      const list = h('div', { class: 'list' });
      if (chapters.length) {
        const cur = chapterAt(current);
        for (const ch of chapters) {
          const s = segs[ch.seg];
          list.append(h('button', { class: 'list-row chapter-row' + (cur === ch ? ' on' : ''), onclick: () => { seek(s.a); close(); } },
            h('span', { class: 'grow ellipsis' }, ch.title), h('span', { class: 'muted small' }, `p. ${pageLabel(s.p)} · ${fmtTime(s.a)}`)));
        }
      }
      setTimeout(() => list.querySelector('.on')?.scrollIntoView({ block: 'center' }), 300);
      return [
        h('h2', {}, 'Chapters'),
        chapters.length ? list : h('p', { class: 'lead' }, 'This book has no chapter list. Use “Go to page” instead.'),
        h('div', { class: 'actions' }, h('button', { class: 'btn', onclick: () => { close(); openGoTo(); } }, 'Go to page…')),
      ];
    });
  }

  function openGoTo() {
    sheet(({ close }) => {
      const input = h('input', { inputmode: 'numeric', placeholder: `1 – ${pages.length}`, value: pageLabel(segs[current]?.p ?? 0) });
      const go = () => {
        const v = input.value.trim();
        let p = pages.findIndex((pg) => String(pg.label) === v);
        if (p < 0) p = Math.max(0, Math.min(pages.length - 1, parseInt(v, 10) - 1));
        const i = segs.findIndex((s) => s.p >= p);
        if (i >= 0) { seek(segs[i].a); close(); } else toast('No text on that page');
      };
      input.addEventListener('keydown', (e) => e.key === 'Enter' && go());
      setTimeout(() => input.select(), 300);
      return [
        h('h2', {}, 'Go to page'),
        h('p', { class: 'lead' }, isPdf ? 'Jumps the audio to where that page starts.' : 'EPUBs have no printed pages, so pages here are even slices of about 300 words.'),
        h('label', { class: 'field' }, input),
        h('div', { class: 'actions' }, h('button', { class: 'btn', onclick: close }, 'Cancel'), h('button', { class: 'btn primary', onclick: go }, 'Go')),
      ];
    });
  }

  function clearSleep() {
    sleep.until = null; sleep.endOfChapter = false; sleep.chapterEnd = null;
    drawSleep();
  }
  sleep.onFire = () => { drawSleep(); toast('Sleep timer: paused'); };
  function drawSleep() {
    const left = sleep.until ? Math.max(0, sleep.until - Date.now()) : 0;
    sleepBtn.replaceChildren(svg(icons.moon.replace('<svg', '<svg width="15" height="15"')),
      sleep.endOfChapter ? 'End of chapter' : sleep.until ? fmtTime(left / 1000) : '');
    sleepBtn.style.color = sleep.until || sleep.endOfChapter ? 'var(--accent)' : '';
  }
  const sleepTicker = setInterval(drawSleep, 1000);
  function openSleep() {
    sheet(({ close }) => {
      const set = (min) => {
        clearSleep();
        if (min === 'chapter') {
          const idx = chapters.findIndex((c) => c.seg > current);
          sleep.endOfChapter = true;
          sleep.chapterEnd = idx >= 0 ? segs[chapters[idx].seg].a - 0.05 : duration;
        } else if (min) {
          sleep.until = Date.now() + min * 60000;
        }
        drawSleep();
        close();
      };
      return [
        h('h2', {}, 'Sleep timer'),
        h('p', { class: 'lead' }, 'Playback pauses on its own, even with the screen locked.'),
        h('div', { class: 'list' },
          ...[[10, '10 minutes'], [20, '20 minutes'], [30, '30 minutes'], [45, '45 minutes'], [60, '1 hour']]
            .map(([m, l]) => h('button', { class: 'list-row', onclick: () => set(m) }, svg(icons.clock), h('span', { class: 'grow' }, l))),
          chapters.length ? h('button', { class: 'list-row', onclick: () => set('chapter') }, svg(icons.book), h('span', { class: 'grow' }, 'End of this chapter')) : null,
          sleep.until || sleep.endOfChapter ? h('button', { class: 'list-row danger', onclick: () => set(0) }, svg(icons.close), h('span', { class: 'grow' }, 'Turn off')) : null),
      ];
    });
  }

  function openMenu() {
    const latest = library.books.get(id) || book;
    const local = library.local.get(id);
    const stale = latest.audio && local && local.audioVersion < latest.audio.version;
    sheet(({ close }) => {
      const row = (icon, label, sub, fn) => h('button', { class: 'list-row', onclick: () => { close(); fn(); } },
        svg(icon), h('span', { class: 'grow' }, h('div', {}, label), sub ? h('div', { class: 'sub' }, sub) : null));
      return [
        h('h2', {}, book.title),
        h('p', { class: 'lead' }, `Voice: ${voiceById(latest.voice).name}`),
        stale ? h('div', { class: 'note' }, h('b', {}, 'New audio is ready. '), 'Download it to hear the latest version.') : null,
        latest.revoice && latest.status !== 'ready' ? h('div', { class: 'note' }, `Re-voice with ${voiceById(latest.revoice.voice).name} is ${latest.status === 'converting' ? 'converting on your PC' : 'waiting for your PC'}.`) : null,
        h('div', { class: 'list' },
          stale ? row(icons.download, 'Download new audio', null, async () => {
            try {
              saveProgress();
              await library.download(id);
              toast('Updated');
              session = null;
              location.hash = '#/'; setTimeout(() => (location.hash = `#/book/${encodeURIComponent(id)}`), 50);
            } catch (e) { toast(e.message, { bad: true }); }
          }) : null,
          row(icons.voice, 'Change voice from here', `From page ${pageLabel(segs[current].p)} to the end`, async () => {
            const t = segs[current].a;
            const v = await openVoicePicker({ current: latest.voice, sampleText: await sample(id, t), title: 'Change voice from here',
              lead: 'Your PC re-records from this point on. Everything before stays the same. Keep listening meanwhile.', confirmLabel: 'Switch to' });
            if (!v) return;
            try { await library.revoice(id, v, t); toast('Queued for your PC'); } catch (e) { toast(e.message, { bad: true }); }
          }),
          row(icons.list, 'Chapters', null, openChapters),
          row(icons.page, 'Go to page', null, openGoTo),
          view === 'page' ? row(icons.contrast, pdfDark() ? 'Light pages' : 'Dark pages', 'Invert the original pages', () => settings.set({ pdfDark: !pdfDark() })) : null,
          row(icons.moon, 'Sleep timer', null, openSleep),
          row(icons.eye, settings.get('focusMode') ? 'Turn off focus mode' : 'Focus mode', 'Controls fade away while you read. Tap to bring them back.', () => settings.set({ focusMode: !settings.get('focusMode') })),
          row(icons.lock, isLocked() ? 'Unlock rotation' : 'Lock rotation', isLocked() ? 'The app turns with your phone again' : 'Keep the app the way it is now when you turn your phone', () => setLocked(!isLocked())),
          row(icons.waves, 'Background sounds', 'Rain, fire, lofi and more', openAmbientSheet),
          row(icons.settings, 'Display and highlighting', null, openDisplay)),
      ];
    });
  }

  function openDisplay() {
    import('./settings.js').then((m) => m.openSettings());
  }

  const offSettings = settings.onChange((patch) => {
    if ('focusMode' in patch) applyFocus();
    if ('highlight' in patch) reader?.setMode(patch.highlight);
    if ('pdfDark' in patch || 'theme' in patch) reader?.setDark(pdfDark());
    if ('readerFont' in patch) reader?.setFont(patch.readerFont);
    if ('skipBack' in patch) backBtn.querySelector('span').textContent = patch.skipBack;
    if ('skipForward' in patch) fwdBtn.querySelector('span').textContent = patch.skipForward;
  });

  drawSpeed();
  drawSleep();
  drawSounds();
  ambient.builtIns().then(drawSounds);
  applyFocus();
  drawPlay();
  await mountReader();
  tick(true);
  if (!audio.paused) onPlay();

  return () => {
    cancelAnimationFrame(raf);
    clearInterval(saver);
    clearInterval(sleepTicker);
    audio.removeEventListener('play', onPlay);
    audio.removeEventListener('pause', onPause);
    audio.removeEventListener('seeked', onTime);
    audio.removeEventListener('ended', onPause);
    document.removeEventListener('visibilitychange', onHide);
    offSettings();
    offAmbient();
    clearTimeout(hideTimer);
    saveProgress();
    reader?.destroy();
  };
}

async function setupMediaSession(book, id, { skip, seek, play, duration }) {
  if (!('mediaSession' in navigator)) return;
  const artwork = [];
  try {
    const cover = await library.cover(id);
    if (cover) artwork.push({ src: URL.createObjectURL(cover), sizes: '512x512', type: 'image/jpeg' });
  } catch {}
  if (!artwork.length) artwork.push({ src: new URL('icons/icon-512.png', location.href).href, sizes: '512x512', type: 'image/png' });
  navigator.mediaSession.metadata = new MediaMetadata({ title: book.title, artist: book.author || voiceById(book.voice).name, album: 'Books', artwork });
  const ms = navigator.mediaSession;
  const set = (action, fn) => { try { ms.setActionHandler(action, fn); } catch {} };
  set('play', () => play());
  set('pause', () => audio.pause());
  set('seekbackward', (d) => skip(-(d.seekOffset || settings.get('skipBack'))));
  set('seekforward', (d) => skip(d.seekOffset || settings.get('skipForward')));
  set('seekto', (d) => seek(d.seekTime));
  set('previoustrack', null);
  set('nexttrack', null);
  const pos = () => {
    try { ms.setPositionState({ duration, playbackRate: audio.playbackRate || 1, position: Math.min(now(), duration) }); } catch {}
  };
  audio.onratechange = pos;
  audio.onseeked = pos;
  audio.onplay = pos;
}

/** Leaving the app or the player shouldn't stop the book. */
export function nowPlaying() {
  if (!session || audio.paused) return null;
  return library.books.get(session.id) || null;
}
