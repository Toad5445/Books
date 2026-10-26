// Shows the book's extracted text, page by page, with sentence/word highlighting.

import { rect } from '../rotation.js';
import { onPinch, onLongPress } from '../pinch.js';
import { settings } from '../settings.js';

const esc = (s) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

// insets(): how much of the top and bottom of the screen the controls cover right now.
export function createTextReader(container, manifest, { onSeek, font, insets = () => ({ top: 8, bottom: 8 }) }) {
  const segs = manifest.segs;
  const pages = manifest.pages || [];
  const root = document.createElement('div');
  root.className = 'text-reader' + (font === 'sans' ? ' sans' : '');

  // Build the whole book as HTML in one go (fast even for long books);
  // `content-visibility` keeps off-screen pages cheap.
  const html = [];
  let page = -1;
  let open = false;
  for (let i = 0; i < segs.length; i++) {
    const s = segs[i];
    if (s.p !== page) {
      if (open) html.push('</p>');
      if (page !== -1) html.push('</div>');
      page = s.p;
      const label = pages[page]?.label ?? page + 1;
      html.push(`<div class="page" data-p="${page}"><div class="pnum">PAGE ${esc(String(label))}</div>`);
      open = false;
    }
    if (s.ps || !open) {
      if (open) html.push('</p>');
      html.push(s.h ? '<p class="h">' : '<p>');
      open = true;
    }
    html.push(`<span class="s" data-i="${i}">${esc(s.x)}</span> `);
  }
  if (open) html.push('</p>');
  if (page !== -1) html.push('</div>');
  root.innerHTML = html.join('');
  container.replaceChildren(root);

  // Pinch to change the text size, then bring the current sentence back into view.
  let startSize = 19;
  onPinch(container, {
    start() { startSize = settings.get('readerSize'); },
    move(scale) {
      const size = Math.max(14, Math.min(34, Math.round(startSize * scale)));
      if (size !== settings.get('readerSize')) settings.set({ readerSize: size });
    },
    end() { if (active >= 0) api.scrollTo(active, false); },
  });

  const spanFor = (i) => root.querySelector(`.s[data-i="${i}"]`);
  let active = -1;
  let activeEl = null;
  let wordEls = null;
  let activeWord = -1;
  let mode = 'word';

  // Press and hold a sentence to play from there (a plain tap doesn't move the audio).
  onLongPress(root, (e) => {
    const el = e.target.closest?.('.s');
    if (el) onSeek(Number(el.dataset.i));
  });

  const visibleArea = () => {
    const cbox = rect(container);
    const ins = insets();
    return { top: cbox.top + ins.top, bottom: cbox.bottom - ins.bottom };
  };
  const focusEl = () => (wordEls && wordEls[Math.max(activeWord, 0)]) || activeEl || (active >= 0 ? spanFor(active) : null);

  function clear() {
    if (activeEl) {
      activeEl.classList.remove('hl');
      if (wordEls) activeEl.textContent = segs[active].x;
    }
    activeEl = null;
    wordEls = null;
    activeWord = -1;
  }

  const api = {
    setMode(m) { mode = m; const a = active; clear(); active = -1; if (a >= 0) this.setActive(a); },
    setDark() {},
    setFont(f) { root.classList.toggle('sans', f === 'sans'); },
    setActive(i) {
      if (i === active) return;
      clear();
      active = i;
      if (i < 0) return;
      activeEl = spanFor(i);
      if (!activeEl) return;
      if (mode !== 'off') activeEl.classList.add('hl');
      const s = segs[i];
      // Words get their own spans even without word highlighting, so scrolling
      // can follow the exact line being read inside long sentences.
      if (s.w?.length) {
        const parts = [];
        let pos = 0;
        s.w.forEach(([cs, ce], k) => {
          if (cs > pos) parts.push(esc(s.x.slice(pos, cs)));
          parts.push(`<span class="w" data-k="${k}">${esc(s.x.slice(cs, ce))}</span>`);
          pos = ce;
        });
        parts.push(esc(s.x.slice(pos)));
        activeEl.innerHTML = parts.join('');
        wordEls = activeEl.querySelectorAll('.w');
      }
    },
    setTime(t) {
      if (!wordEls || active < 0) return;
      const w = segs[active].w;
      let k = -1;
      for (let j = 0; j < w.length; j++) { if (w[j][2] <= t + 0.03) k = j; else break; }
      if (k !== activeWord) {
        wordEls[activeWord]?.classList.remove('hl');
        if (mode === 'word') wordEls[k]?.classList.add('hl');
        activeWord = k;
      }
    },
    /** True when the line being read has drifted out of the comfortable reading zone
     *  (upper ~70% of the screen), or with strict=true, right off the screen. */
    offscreen(strict = false) {
      const el = focusEl();
      if (!el) return false;
      const box = rect(el);
      const { top, bottom } = visibleArea();
      if (strict) return box.bottom < top || box.top > bottom;
      return box.top < top - 2 || box.bottom > top + (bottom - top) * 0.8;
    },
    /** Element to keep in view for segment i. */
    target(i) { return spanFor(i); },
    /** Scroll so the sentence being read starts at the top of the visible area
     *  (or, deep inside a very long sentence, the line being read). */
    scrollTo(i, smooth = true) {
      const sentence = spanFor(i);
      if (!sentence) return;
      const { top, bottom } = visibleArea();
      let anchor = rect(sentence).top;
      if (i === active) {
        const line = rect(focusEl());
        if (line.bottom - anchor > (bottom - top) * 0.9) anchor = line.top; // sentence taller than the screen
      }
      const y = container.scrollTop + anchor - top;
      container.scrollTo({ top: Math.max(0, y), behavior: smooth ? 'smooth' : 'auto' });
    },
    destroy() {},
  };
  return api;
}
