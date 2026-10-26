// Rotation lock. iPhones don't let web apps lock their orientation, so when the
// phone turns away from the locked orientation we rotate the whole app back.
// rect() and point() turn screen coordinates into the app's own (unrotated)
// coordinates, for code that measures positions on screen.

import { settings } from './settings.js';

let inverse = null; // maps screen coordinates back to app coordinates

const angleNow = () => {
  if (typeof window.orientation === 'number') return window.orientation; // iOS: 0, 90, -90, 180
  return -(screen.orientation?.angle || 0); // same direction as window.orientation
};

function norm(a) {
  a = ((a % 360) + 360) % 360;
  return a > 180 ? a - 360 : a;
}

export function apply() {
  const body = document.body;
  const root = document.documentElement;
  const lock = settings.get('rotationLock');
  const turn = lock == null ? 0 : norm(lock - angleNow());
  body.classList.toggle('rotated', turn !== 0);
  if (turn === 0) {
    body.style.cssText = '';
    root.style.removeProperty('--safe-top');
    root.style.removeProperty('--safe-bottom');
    inverse = null;
    return;
  }
  const w = window.innerWidth;
  const h = window.innerHeight;
  const sideways = Math.abs(turn) === 90;
  const bw = sideways ? h : w;
  const bh = sideways ? w : h;
  const move = turn === -90 ? `translate(0px, ${h}px)` : turn === 90 ? `translate(${w}px, 0px)` : `translate(${w}px, ${h}px)`;
  body.style.cssText = `position:fixed;left:0;top:0;width:${bw}px;height:${bh}px;overflow-y:auto;transform-origin:0 0;transform:${move} rotate(${turn}deg)`;
  // The notch moves to the side; keep the app's top/bottom padding clear of it.
  if (sideways) {
    root.style.setProperty('--safe-top', `env(safe-area-inset-${turn === -90 ? 'left' : 'right'}, 0px)`);
    root.style.setProperty('--safe-bottom', `env(safe-area-inset-${turn === -90 ? 'right' : 'left'}, 0px)`);
  }
  inverse = new DOMMatrix(getComputedStyle(body).transform).inverse();
}

/** Lock to the way the phone is held right now, or unlock. */
export function setLocked(on) {
  settings.set({ rotationLock: on ? angleNow() : null });
  apply();
}

export const isLocked = () => settings.get('rotationLock') != null;

export function point(x, y) {
  if (!inverse) return { x, y };
  const p = inverse.transformPoint(new DOMPoint(x, y));
  return { x: p.x, y: p.y };
}

export function rect(el) {
  const r = el.getBoundingClientRect();
  if (!inverse) return r;
  const a = point(r.left, r.top);
  const b = point(r.right, r.bottom);
  const left = Math.min(a.x, b.x);
  const top = Math.min(a.y, b.y);
  const right = Math.max(a.x, b.x);
  const bottom = Math.max(a.y, b.y);
  return { left, top, right, bottom, width: right - left, height: bottom - top };
}

window.addEventListener('orientationchange', () => setTimeout(apply, 250));
window.addEventListener('resize', () => apply());
