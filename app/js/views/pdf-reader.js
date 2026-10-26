// Shows the original PDF pages and highlights the sentence being read.

import { loadPdfJs } from '../bookinfo.js';
import { point, rect } from '../rotation.js';
import { onPinch, onLongPress } from '../pinch.js';

const MAX_CANVASES = 8; // iOS limits total canvas memory, so far-away pages are released
const MAX_PIXELS = 10e6; // per page canvas, also to stay inside iOS limits
const MAX_ZOOM = 4;

export async function createPdfReader(container, manifest, sourceBlob, { onSeek, insets = () => ({ top: 8, bottom: 8 }) }) {
  const lib = await loadPdfJs();
  const pdf = await lib.getDocument({ data: new Uint8Array(await sourceBlob.arrayBuffer()) }).promise;
  const segs = manifest.segs;
  const pagesMeta = manifest.pages || [];

  const root = document.createElement('div');
  root.className = 'pdf-reader';
  const wrappers = [];
  for (let p = 0; p < pdf.numPages; p++) {
    const m = pagesMeta[p] || pagesMeta[0] || { w: 612, h: 792 };
    const wrap = document.createElement('div');
    wrap.className = 'pdf-page';
    wrap.dataset.p = p;
    wrap.style.aspectRatio = `${m.w || 612} / ${m.h || 792}`;
    wrap.innerHTML = `<div class="overlay"></div><span class="plabel">${pagesMeta[p]?.label ?? p + 1}</span>`;
    root.append(wrap);
    wrappers.push(wrap);
  }
  container.replaceChildren(root);

  // Zoom: pages are laid out at zoom x the screen width; pinching zooms around your fingers.
  let zoom = 1;
  const baseWidth = () => Math.min(container.clientWidth - 20, 900);
  function layout() {
    const w = Math.round(baseWidth() * zoom);
    for (const wrap of wrappers) wrap.style.width = `${w}px`;
    root.classList.toggle('zoomed', zoom > 1.01);
    container.classList.toggle('pan-x', zoom > 1.01); // sideways scrolling only while zoomed in
  }
  layout();

  // Which segments sit on each page, for tap-to-seek.
  const byPage = new Map();
  segs.forEach((s, i) => (s.r || []).forEach((r) => {
    if (!byPage.has(r[0])) byPage.set(r[0], []);
    byPage.get(r[0]).push(i);
  }));

  const rendered = new Map(); // page -> canvas
  const rendering = new Set();
  const visible = new Set();

  async function render(p, fresh = false) {
    if ((rendered.has(p) && !fresh) || rendering.has(p)) return;
    rendering.add(p);
    try {
      const page = await pdf.getPage(p + 1);
      const wrap = wrappers[p];
      const base = page.getViewport({ scale: 1 });
      let scale = (wrap.clientWidth * Math.min(window.devicePixelRatio || 1, 2)) / base.width;
      const pixels = base.width * base.height * scale * scale;
      if (pixels > MAX_PIXELS) scale *= Math.sqrt(MAX_PIXELS / pixels);
      const viewport = page.getViewport({ scale });
      const canvas = document.createElement('canvas');
      canvas.width = Math.floor(viewport.width);
      canvas.height = Math.floor(viewport.height);
      await page.render({ canvasContext: canvas.getContext('2d'), viewport }).promise;
      const old = rendered.get(p);
      if (old) { old.width = old.height = 0; old.remove(); }
      wrap.prepend(canvas);
      rendered.set(p, canvas);
      evict();
    } catch (e) {
      console.warn('Page render failed', p, e);
    } finally {
      rendering.delete(p);
    }
  }

  function evict() {
    if (rendered.size <= MAX_CANVASES) return;
    const centre = [...visible][0] ?? 0;
    const far = [...rendered.keys()].filter((p) => !visible.has(p)).sort((a, b) => Math.abs(b - centre) - Math.abs(a - centre));
    while (rendered.size > MAX_CANVASES && far.length) {
      const p = far.shift();
      const c = rendered.get(p);
      c.width = c.height = 0;
      c.remove();
      rendered.delete(p);
    }
  }

  function setZoom(next, cx, cy) {
    next = Math.max(1, Math.min(MAX_ZOOM, next));
    if (next < 1.05) next = 1;
    if (Math.abs(next - zoom) < 0.01) return;
    const ratio = next / zoom;
    const px = container.scrollLeft + cx;
    const py = container.scrollTop + cy;
    zoom = next;
    layout();
    container.scrollLeft = px * ratio - cx;
    container.scrollTop = py * ratio - cy;
    // Re-draw what's on screen sharply at the new size; the rest redraws when scrolled to.
    for (const p of [...rendered.keys()]) {
      if (visible.has(p)) render(p, true);
      else { const c = rendered.get(p); c.width = c.height = 0; c.remove(); rendered.delete(p); }
    }
  }

  onPinch(container, {
    move(scale, start) {
      const box = rect(container);
      root.style.transformOrigin = `${container.scrollLeft + start.x - box.left}px ${container.scrollTop + start.y - box.top}px`;
      root.style.transform = `scale(${Math.max(1 / zoom, Math.min(MAX_ZOOM / zoom, scale))})`;
    },
    end(scale, start) {
      root.style.transform = '';
      const box = rect(container);
      setZoom(zoom * scale, start.x - box.left, start.y - box.top);
    },
  });

  const onResize = () => { layout(); for (const p of visible) render(p, true); };
  window.addEventListener('resize', onResize);

  const io = new IntersectionObserver((entries) => {
    for (const e of entries) {
      const p = Number(e.target.dataset.p);
      if (e.isIntersecting) { visible.add(p); render(p); } else visible.delete(p);
    }
  }, { root: container, rootMargin: '120% 0px' });
  wrappers.forEach((w) => io.observe(w));

  // Press and hold a sentence on the page to play from there.
  onLongPress(root, (e) => {
    const wrap = e.target.closest?.('.pdf-page');
    if (!wrap) return;
    const p = Number(wrap.dataset.p);
    const box = rect(wrap);
    const at = point(e.clientX, e.clientY);
    const x = (at.x - box.left) / box.width;
    const y = (at.y - box.top) / box.height;
    let best = null;
    let bestDist = 0.03;
    for (const i of byPage.get(p) || []) {
      for (const r of segs[i].r) {
        if (r[0] !== p) continue;
        const dx = Math.max(r[1] - x, 0, x - r[3]);
        const dy = Math.max(r[2] - y, 0, y - r[4]);
        const d = Math.hypot(dx, dy);
        if (d < bestDist) { bestDist = d; best = i; }
      }
    }
    if (best != null) onSeek(best);
  });

  let active = -1;
  let line = 0; // which line of the active sentence is being read (estimated from time)
  let mode = 'sentence';
  let marks = [];

  const draw = () => {
    marks.forEach((m) => m.remove());
    marks = [];
    if (active < 0 || mode === 'off') return;
    for (const r of segs[active]?.r || []) {
      const wrap = wrappers[r[0]];
      if (!wrap) continue;
      const m = document.createElement('i');
      const pad = 0.003;
      Object.assign(m.style, {
        left: `${(r[1] - pad) * 100}%`, top: `${(r[2] - pad) * 100}%`,
        width: `${(r[3] - r[1] + 2 * pad) * 100}%`, height: `${(r[4] - r[2] + 2 * pad) * 100}%`,
      });
      wrap.querySelector('.overlay').append(m);
      marks.push(m);
    }
  };

  function anchor(i, k = 0) {
    const s = segs[i];
    if (!s) return null;
    const r = s.r?.[Math.min(k, (s.r?.length || 1) - 1)];
    const wrap = wrappers[r ? r[0] : s.p];
    if (!wrap) return null;
    return { wrap, y: r ? (r[2] + r[4]) / 2 : 0.1 };
  }

  return {
    setMode(m) { mode = m; draw(); },
    setDark(on) { root.classList.toggle('dark', on); },
    setFont() {},
    setActive(i) { if (i !== active) { active = i; line = 0; draw(); } },
    setTime(t) {
      // Spread the sentence's time over its lines by their length.
      const s = segs[active];
      if (!s?.r?.length) return;
      const widths = s.r.map((r) => Math.max(0.001, r[3] - r[1]));
      const total = widths.reduce((a, b) => a + b, 0);
      let at = Math.max(0, Math.min(1, (t - s.a) / Math.max(0.01, s.b - s.a))) * total;
      let k = 0;
      while (k < widths.length - 1 && at > widths[k]) { at -= widths[k]; k++; }
      line = k;
    },
    offscreen(strict = false) {
      const a = anchor(active, line);
      if (!a) return false;
      const y = a.wrap.offsetTop + a.wrap.offsetHeight * a.y - container.scrollTop;
      const ins = insets();
      const top = ins.top;
      const bottom = container.clientHeight - ins.bottom;
      if (strict) return y < top || y > bottom;
      return y < top || y > top + (bottom - top) * 0.8;
    },
    /** Scroll so the sentence being read starts at the top of the visible area
     *  (or, deep inside a very long sentence, the line being read). */
    scrollTo(i, smooth = true) {
      const ins = insets();
      const room = container.clientHeight - ins.top - ins.bottom;
      const lineTop = (j, k) => {
        const s = segs[j];
        const r = s?.r?.[Math.min(k, (s?.r?.length || 1) - 1)];
        const wrap = wrappers[r ? r[0] : s?.p];
        return wrap ? wrap.offsetTop + wrap.offsetHeight * (r ? r[2] : 0.05) : null;
      };
      let k = 0;
      let y = lineTop(i, 0);
      if (y == null) return;
      if (i === active && line > 0) {
        const cur = lineTop(i, line);
        if (cur - y > room * 0.85) { y = cur; k = line; }
      }
      const top = y - ins.top - 6;
      const r = segs[i]?.r?.[Math.min(k, (segs[i]?.r?.length || 1) - 1)];
      const a = anchor(i, k);
      const x = r ? (r[1] + r[3]) / 2 : 0.5;
      const left = zoom > 1.01 ? a.wrap.offsetLeft + a.wrap.offsetWidth * x - container.clientWidth / 2 : container.scrollLeft;
      container.scrollTo({ top: Math.max(0, top), left: Math.max(0, left), behavior: smooth ? 'smooth' : 'auto' });
    },
    destroy() {
      io.disconnect();
      window.removeEventListener('resize', onResize);
      container.classList.remove('pan-x');
      for (const c of rendered.values()) { c.width = c.height = 0; }
      rendered.clear();
      pdf.destroy();
    },
  };
}
