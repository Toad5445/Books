// Shows the original PDF pages and highlights the sentence being read.

import { loadPdfJs } from '../bookinfo.js';

const MAX_CANVASES = 8; // iOS limits total canvas memory, so far-away pages are released

export async function createPdfReader(container, manifest, sourceBlob, { onSeek }) {
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

  // Which segments sit on each page, for tap-to-seek.
  const byPage = new Map();
  segs.forEach((s, i) => (s.r || []).forEach((r) => {
    if (!byPage.has(r[0])) byPage.set(r[0], []);
    byPage.get(r[0]).push(i);
  }));

  const rendered = new Map(); // page -> canvas
  const rendering = new Set();
  const visible = new Set();

  async function render(p) {
    if (rendered.has(p) || rendering.has(p)) return;
    rendering.add(p);
    try {
      const page = await pdf.getPage(p + 1);
      const wrap = wrappers[p];
      const base = page.getViewport({ scale: 1 });
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const scale = (wrap.clientWidth * dpr) / base.width;
      const viewport = page.getViewport({ scale });
      const canvas = document.createElement('canvas');
      canvas.width = Math.floor(viewport.width);
      canvas.height = Math.floor(viewport.height);
      await page.render({ canvasContext: canvas.getContext('2d'), viewport }).promise;
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

  const io = new IntersectionObserver((entries) => {
    for (const e of entries) {
      const p = Number(e.target.dataset.p);
      if (e.isIntersecting) { visible.add(p); render(p); } else visible.delete(p);
    }
  }, { root: container, rootMargin: '120% 0px' });
  wrappers.forEach((w) => io.observe(w));

  root.addEventListener('click', (e) => {
    const wrap = e.target.closest('.pdf-page');
    if (!wrap) return;
    const p = Number(wrap.dataset.p);
    const box = wrap.getBoundingClientRect();
    const x = (e.clientX - box.left) / box.width;
    const y = (e.clientY - box.top) / box.height;
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

  function anchor(i) {
    const s = segs[i];
    if (!s) return null;
    const r = s.r?.[0];
    const wrap = wrappers[r ? r[0] : s.p];
    if (!wrap) return null;
    return { wrap, y: r ? (r[2] + r[4]) / 2 : 0.1 };
  }

  return {
    setMode(m) { mode = m; draw(); },
    setDark(on) { root.classList.toggle('dark', on); },
    setFont() {},
    setActive(i) { if (i !== active) { active = i; draw(); } },
    setTime() {},
    scrollTo(i, smooth = true) {
      const a = anchor(i);
      if (!a) return;
      const top = a.wrap.offsetTop + a.wrap.offsetHeight * a.y - container.clientHeight * 0.4;
      container.scrollTo({ top: Math.max(0, top), behavior: smooth ? 'smooth' : 'auto' });
    },
    isVisible(i) {
      const a = anchor(i);
      if (!a) return true;
      const y = a.wrap.offsetTop + a.wrap.offsetHeight * a.y - container.scrollTop;
      return y > 40 && y < container.clientHeight - 40;
    },
    destroy() {
      io.disconnect();
      for (const c of rendered.values()) { c.width = c.height = 0; }
      rendered.clear();
      pdf.destroy();
    },
  };
}
