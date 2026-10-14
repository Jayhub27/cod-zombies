// Small math / geometry helpers shared by the game.

export const TAU = Math.PI * 2;

export const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
export const lerp = (a, b, t) => a + (b - a) * t;

export const rand = (a = 1, b) => (b === undefined ? Math.random() * a : a + Math.random() * (b - a));
export const randInt = (a, b) => Math.floor(rand(a, b + 1));
export const choice = (arr) => arr[Math.floor(Math.random() * arr.length)];
export const chance = (p) => Math.random() < p;

export const dist = (x1, y1, x2, y2) => Math.hypot(x2 - x1, y2 - y1);
export const dist2 = (x1, y1, x2, y2) => {
  const dx = x2 - x1, dy = y2 - y1;
  return dx * dx + dy * dy;
};

export const angleTo = (x1, y1, x2, y2) => Math.atan2(y2 - y1, x2 - x1);

export function normAng(a) {
  while (a > Math.PI) a -= TAU;
  while (a < -Math.PI) a += TAU;
  return a;
}

// Distance from point (cx,cy) to segment (x1,y1)-(x2,y2) <= r ?
export function segCircle(x1, y1, x2, y2, cx, cy, r) {
  const dx = x2 - x1, dy = y2 - y1;
  const l2 = dx * dx + dy * dy;
  let t = l2 > 0 ? ((cx - x1) * dx + (cy - y1) * dy) / l2 : 0;
  t = clamp(t, 0, 1);
  const px = x1 + dx * t, py = y1 + dy * t;
  const ddx = cx - px, ddy = cy - py;
  return ddx * ddx + ddy * ddy <= r * r;
}

export const easeOut = (t) => 1 - Math.pow(1 - t, 3);
export const easeInOut = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);

// Push a circle entity {x,y,r} out of rect {x,y,w,h}. Returns true when it collided.
export function circleRectResolve(e, r) {
  const nx = clamp(e.x, r.x, r.x + r.w);
  const ny = clamp(e.y, r.y, r.y + r.h);
  const dx = e.x - nx, dy = e.y - ny;
  const d2 = dx * dx + dy * dy;
  if (d2 >= e.r * e.r) return false;
  if (d2 > 1e-6) {
    const d = Math.sqrt(d2);
    const push = e.r - d;
    e.x += (dx / d) * push;
    e.y += (dy / d) * push;
  } else {
    // center is inside the rect: exit through the nearest edge
    const l = e.x - r.x, ri = r.x + r.w - e.x, t = e.y - r.y, bo = r.y + r.h - e.y;
    const m = Math.min(l, ri, t, bo);
    if (m === l) e.x = r.x - e.r;
    else if (m === ri) e.x = r.x + r.w + e.r;
    else if (m === t) e.y = r.y - e.r;
    else e.y = r.y + r.h + e.r;
  }
  return true;
}

export const pointInRect = (x, y, r, pad = 0) =>
  x >= r.x - pad && x <= r.x + r.w + pad && y >= r.y - pad && y <= r.y + r.h + pad;

export function rectDistPoint(x, y, r) {
  const nx = clamp(x, r.x, r.x + r.w);
  const ny = clamp(y, r.y, r.y + r.h);
  return Math.hypot(x - nx, y - ny);
}
