// Small DOM helpers shared by every view.

import { point } from './rotation.js';

export function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'html') el.innerHTML = v;
    else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
    else if (k.startsWith('on')) el.addEventListener(k.slice(2).toLowerCase(), v);
    else if (v === true) el.setAttribute(k, '');
    else el.setAttribute(k, v);
  }
  for (const c of children.flat()) {
    if (c == null || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}

export function svg(markup) {
  const t = document.createElement('template');
  t.innerHTML = markup.trim();
  return t.content.firstChild;
}

export function toast(message, { bad = false, ms = 3200 } = {}) {
  const el = h('div', { class: 'toast' + (bad ? ' bad' : '') }, message);
  document.getElementById('toasts').append(el);
  requestAnimationFrame(() => requestAnimationFrame(() => el.classList.add('show')));
  setTimeout(() => { el.classList.remove('show'); setTimeout(() => el.remove(), 400); }, ms);
}

/** Bottom sheet. Returns { el, close }. */
export function sheet(build, { onClose } = {}) {
  const host = document.getElementById('sheets');
  const backdrop = h('div', { class: 'sheet-backdrop' });
  const panel = h('div', { class: 'sheet', role: 'dialog', 'aria-modal': 'true' }, h('div', { class: 'grab' }));
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    panel.classList.remove('open');
    backdrop.classList.remove('open');
    setTimeout(() => { panel.remove(); backdrop.remove(); }, 280);
    onClose?.();
  };
  backdrop.addEventListener('click', close);
  host.append(backdrop, panel);
  const api = { el: panel, close };
  const content = build(api);
  if (content) panel.append(...[content].flat().filter((c) => c != null && c !== false));
  requestAnimationFrame(() => requestAnimationFrame(() => { panel.classList.add('open'); backdrop.classList.add('open'); }));

  // Swipe down on the grab handle area to close.
  let startY = null;
  const touchY = (t) => point(t.clientX, t.clientY).y;
  panel.addEventListener('touchstart', (e) => { if (panel.scrollTop <= 0) startY = touchY(e.touches[0]); }, { passive: true });
  panel.addEventListener('touchmove', (e) => {
    if (startY == null) return;
    const dy = touchY(e.touches[0]) - startY;
    if (dy > 0 && panel.scrollTop <= 0) panel.style.transform = `translateY(${dy}px)`;
  }, { passive: true });
  panel.addEventListener('touchend', (e) => {
    if (startY == null) return;
    const dy = touchY(e.changedTouches[0]) - startY;
    panel.style.transform = '';
    startY = null;
    if (dy > 110) close();
  });
  return api;
}

export function confirmSheet({ title, message, confirm = 'OK', danger = false }) {
  return new Promise((resolve) => {
    let answered = false;
    const s = sheet(({ close }) => [
      h('h2', {}, title),
      message ? h('p', { class: 'lead' }, message) : null,
      h('div', { class: 'actions' },
        h('button', { class: 'btn', onclick: () => { answered = true; resolve(false); close(); } }, 'Cancel'),
        h('button', { class: 'btn primary' + (danger ? ' danger' : ''), style: danger ? { background: 'var(--bad)', color: '#fff' } : null, onclick: () => { answered = true; resolve(true); close(); } }, confirm),
      ),
    ], { onClose: () => { if (!answered) resolve(false); } });
    return s;
  });
}

export function fmtTime(sec) {
  if (!isFinite(sec) || sec < 0) sec = 0;
  sec = Math.floor(sec);
  const h_ = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
  return h_ ? `${h_}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}` : `${m}:${String(s).padStart(2, '0')}`;
}

export function fmtDuration(sec) {
  const m = Math.round(sec / 60);
  if (m < 1) return '< 1 min';
  if (m < 60) return `${m} min`;
  const hrs = Math.floor(m / 60), rest = m % 60;
  return rest ? `${hrs} h ${rest} min` : `${hrs} h`;
}

export function fmtBytes(n) {
  if (n < 1024 * 1024) return `${Math.max(1, Math.round(n / 1024))} KB`;
  if (n < 1024 ** 3) return `${(n / 1024 / 1024).toFixed(n < 10 * 1024 * 1024 ? 1 : 0)} MB`;
  return `${(n / 1024 ** 3).toFixed(1)} GB`;
}

export function hashHue(str) {
  let x = 0;
  for (const c of str || '') x = (x * 31 + c.charCodeAt(0)) >>> 0;
  return x % 360;
}

export function switchEl(checked, onchange) {
  const input = h('input', { type: 'checkbox', onchange: (e) => onchange(e.target.checked) });
  input.checked = !!checked;
  return h('label', { class: 'switch' }, input, h('i'));
}

export function segmented(options, value, onchange) {
  const wrap = h('div', { class: 'seg' });
  const render = (v) => {
    wrap.replaceChildren(...options.map(([val, label]) =>
      h('button', { class: val === v ? 'on' : '', onclick: () => { render(val); onchange(val); } }, label)));
  };
  render(value);
  return wrap;
}
