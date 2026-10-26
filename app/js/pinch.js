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
