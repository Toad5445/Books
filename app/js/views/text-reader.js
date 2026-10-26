// Shows the book's extracted text, page by page, with sentence/word highlighting.

import { rect } from '../rotation.js';

const esc = (s) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

export function createTextReader(container, manifest, { onSeek, font }) {
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

  const spanFor = (i) => root.querySelector(`.s[data-i="${i}"]`);
  let active = -1;
  let activeEl = null;
  let wordEls = null;
  let activeWord = -1;
  let mode = 'word';

  root.addEventListener('click', (e) => {
    const el = e.target.closest('.s');
    if (el) onSeek(Number(el.dataset.i));
  });

  function clear() {
    if (activeEl) {
      activeEl.classList.remove('hl');
      if (wordEls) activeEl.textContent = segs[active].x;
    }
    activeEl = null;
    wordEls = null;
    activeWord = -1;
  }

  return {
    setMode(m) { mode = m; const a = active; clear(); active = -1; if (a >= 0) this.setActive(a); },
    setDark() {},
    setFont(f) { root.classList.toggle('sans', f === 'sans'); },
    setActive(i) {
      if (i === active) return;
      clear();
      active = i;
      if (i < 0 || mode === 'off') return;
      activeEl = spanFor(i);
      if (!activeEl) return;
      activeEl.classList.add('hl');
      const s = segs[i];
      if (mode === 'word' && s.w?.length) {
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
        wordEls[k]?.classList.add('hl');
        activeWord = k;
      }
    },
    /** Element to keep in view for segment i. */
    target(i) { return spanFor(i); },
    scrollTo(i, smooth = true) {
      const el = spanFor(i);
      if (!el) return;
      const box = rect(el);
      const cbox = rect(container);
      const y = container.scrollTop + box.top - cbox.top - container.clientHeight * 0.35;
      container.scrollTo({ top: Math.max(0, y), behavior: smooth ? 'smooth' : 'auto' });
    },
    isVisible(i) {
      const el = spanFor(i);
      if (!el) return true;
      const box = rect(el);
      const cbox = rect(container);
      return box.bottom > cbox.top + 40 && box.top < cbox.bottom - 40;
    },
    destroy() {},
  };
}
