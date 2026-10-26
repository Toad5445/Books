// Two-finger pinch on an element, in the app's own coordinates (rotation-aware).
// move(scale, start) is called while pinching, end(scale, start) when a finger lifts.

import { point } from './rotation.js';

export function onPinch(el, { start, move, end }) {
  let first = null;
  let scale = 1;
  const info = (touches) => {
    const a = point(touches[0].clientX, touches[0].clientY);
    const b = point(touches[1].clientX, touches[1].clientY);
    return { d: Math.hypot(a.x - b.x, a.y - b.y) || 1, x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
  };
  el.addEventListener('touchstart', (e) => {
    if (e.touches.length !== 2) return;
    e.preventDefault();
    first = info(e.touches);
    scale = 1;
    start?.(first);
  }, { passive: false });
  el.addEventListener('touchmove', (e) => {
    if (!first || e.touches.length !== 2) return;
    e.preventDefault();
    scale = info(e.touches).d / first.d;
    move?.(scale, first);
  }, { passive: false });
  const finish = (e) => {
    if (!first || e.touches.length >= 2) return;
    const f = first;
    first = null;
    end?.(scale, f);
  };
  el.addEventListener('touchend', finish);
  el.addEventListener('touchcancel', finish);
}

/** Press and hold (or double-click with a mouse). fn(event-like {target, clientX, clientY}).
 *  Moving the finger (scrolling) cancels it, so it never fires while you scroll. */
export function onLongPress(el, fn, ms = 500) {
  let timer = 0;
  let start = null;
  let fired = false;
  el.addEventListener('touchstart', (e) => {
    if (e.touches.length !== 1) { clearTimeout(timer); return; }
    const t = e.touches[0];
    start = { x: t.clientX, y: t.clientY };
    fired = false;
    const target = e.target;
    clearTimeout(timer);
    timer = setTimeout(() => { fired = true; fn({ target, clientX: start.x, clientY: start.y }); }, ms);
  }, { passive: true });
  el.addEventListener('touchmove', (e) => {
    const t = e.touches[0];
    if (start && Math.hypot(t.clientX - start.x, t.clientY - start.y) > 10) clearTimeout(timer);
  }, { passive: true });
  el.addEventListener('touchend', (e) => {
    clearTimeout(timer);
    if (fired) e.preventDefault(); // no click after a long press
  });
  el.addEventListener('touchcancel', () => clearTimeout(timer));
  el.addEventListener('dblclick', (e) => fn(e));
  el.addEventListener('contextmenu', (e) => e.preventDefault());
}
