// The bunker map: rooms, walls, doors, windows, buy stations — plus a BFS navigation field.
import { rand, choice, clamp, pointInRect } from './utils.js';

const W = 1680, H = 1240, T = 26; // world size + wall thickness

export const map = {
  w: W, h: H, wallT: T,

  rooms: [
    { id: 'a', name: 'START',     x: 26,  y: 26,  w: 789, h: 570 },
    { id: 'b', name: 'ARMORY',    x: 841, y: 26,  w: 813, h: 570 },
    { id: 'c', name: 'LAB',       x: 26,  y: 622, w: 789, h: 592 },
    { id: 'd', name: 'COURTYARD', x: 841, y: 622, w: 813, h: 592 },
  ],

  walls: [
    // outer shell
    { x: 0, y: 0, w: W, h: T },
    { x: 0, y: H - T, w: W, h: T },
    { x: 0, y: 0, w: T, h: H },
    { x: W - T, y: 0, w: T, h: H },
    // middle vertical wall (between top rooms + bottom rooms)
    { x: 815, y: 26,  w: T, h: 210 },   // 26..236
    { x: 815, y: 316, w: T, h: 280 },   // 316..596
    { x: 815, y: 622, w: T, h: 210 },   // 622..832
    { x: 815, y: 912, w: T, h: 302 },   // 912..1214
    // middle horizontal wall (between left rooms + right rooms)
    { x: 26,  y: 596, w: 280, h: T },   // 26..306
    { x: 386, y: 596, w: 429, h: T },   // 386..815
    { x: 841, y: 596, w: 260, h: T },   // 841..1101
    { x: 1181, y: 596, w: 473, h: T },  // 1181..1654
  ],

  // standalone obstacles (also solid)
  crates: [
    { x: 430,  y: 440,  w: 64, h: 64, room: 'a' },
    { x: 1210, y: 330,  w: 70, h: 70, room: 'b' },
    { x: 520,  y: 720,  w: 70, h: 70, room: 'c' },
    { x: 1010, y: 716,  w: 70, h: 70, room: 'd' },
    { x: 1450, y: 1020, w: 88, h: 70, room: 'd' },
  ],

  doors: [
    { id: 'd1', rect: { x: 815, y: 236, w: T, h: 80 },  cost: 750,  rooms: ['a', 'b'], open: false },
    { id: 'd2', rect: { x: 306, y: 596, w: 80, h: T },  cost: 1000, rooms: ['a', 'c'], open: false },
    { id: 'd3', rect: { x: 1101, y: 596, w: 80, h: T }, cost: 1250, rooms: ['b', 'd'], open: false },
    { id: 'd4', rect: { x: 815, y: 832, w: T, h: 80 },  cost: 1750, rooms: ['c', 'd'], open: false },
  ],

  windows: [
    { x: 270,  y: 13,   dir: 'n', room: 'a' },
    { x: 610,  y: 13,   dir: 'n', room: 'a' },
    { x: 13,   y: 300,  dir: 'w', room: 'a' },
    { x: 1030, y: 13,   dir: 'n', room: 'b' },
    { x: 1440, y: 13,   dir: 'n', room: 'b' },
    { x: 1667, y: 300,  dir: 'e', room: 'b' },
    { x: 13,   y: 930,  dir: 'w', room: 'c' },
    { x: 270,  y: 1227, dir: 's', room: 'c' },
    { x: 610,  y: 1227, dir: 's', room: 'c' },
    { x: 1667, y: 930,  dir: 'e', room: 'd' },
    { x: 1030, y: 1227, dir: 's', room: 'd' },
    { x: 1450, y: 1227, dir: 's', room: 'd' },
  ],

  buys: [
    { kind: 'weapon', id: 'm1911', x: 62,   y: 330,  angle: 0,             room: 'a' },
    { kind: 'weapon', id: 'mp40',  x: 1040, y: 62,   angle: Math.PI / 2,   room: 'b' },
    { kind: 'weapon', id: 'trench', x: 62,  y: 780,  angle: 0,             room: 'c' },
    { kind: 'weapon', id: 'm14',   x: 1330, y: 1186, angle: -Math.PI / 2,  room: 'd' },
  ],

  perks: [
    { id: 'qr',    name: 'Quick Revive', cost: 500,  color: '#4fd08a', x: 105,  y: 540 },
    { id: 'jugg',  name: 'Juggernog',    cost: 2500, color: '#e0453e', x: 1580, y: 530 },
    { id: 'speed', name: 'Speed Cola',   cost: 3000, color: '#f2d23c', x: 130,  y: 1150 },
    { id: 'dt',    name: 'Double Tap',   cost: 2000, color: '#e07b31', x: 1575, y: 1150 },
  ],

  box: { x: 1180, y: 880, cost: 950 },
  pap: { x: 600, y: 1080, cost: 4000 },

  solidList: [],

  init() {
    for (const w of this.windows) {
      const r = this.windowRect(w);
      const n = { n: [0, -1], s: [0, 1], e: [1, 0], w: [-1, 0] }[w.dir];
      w.rect = r;
      w.nx = n[0]; w.ny = n[1];
      w.out = { x: w.x + n[0] * 58, y: w.y + n[1] * 58 };
      w.in = { x: w.x - n[0] * 62, y: w.y - n[1] * 62 };
      w.boards = 6;
      w.climbers = 0;
    }
    for (const p of this.perks) {
      p.rect = { x: p.x - 26, y: p.y - 24, w: 52, h: 48 };
    }
    this.box.rect = { x: this.box.x - 34, y: this.box.y - 24, w: 68, h: 48 };
    this.pap.rect = { x: this.pap.x - 44, y: this.pap.y - 32, w: 88, h: 64 };
    this.rebuildSolids();
  },

  windowRect(w) {
    if (w.dir === 'n' || w.dir === 's') return { x: w.x - 32, y: w.y - 13, w: 64, h: 26 };
    return { x: w.x - 13, y: w.y - 32, w: 26, h: 64 };
  },

  rebuildSolids() {
    const list = [];
    for (const r of this.walls) list.push({ ...r, kind: 'wall' });
    for (const r of this.crates) list.push({ ...r, kind: 'crate' });
    for (const p of this.perks) list.push({ ...p.rect, kind: 'perk' });
    list.push({ ...this.box.rect, kind: 'box' });
    list.push({ ...this.pap.rect, kind: 'pap' });
    for (const d of this.doors) if (!d.open) list.push({ ...d.rect, kind: 'door' });
    this.solidList = list;
  },

  roomAt(x, y) {
    for (const r of this.rooms) if (pointInRect(x, y, r)) return r;
    // nearest room by center distance (doorways etc.)
    let best = this.rooms[0], bd = 1e9;
    for (const r of this.rooms) {
      const d = Math.hypot(x - (r.x + r.w / 2), y - (r.y + r.h / 2));
      if (d < bd) { bd = d; best = r; }
    }
    return best;
  },
};

map.init();

// ---------------------------------------------------------------- navigation
const DX = [1, -1, 0, 0, 1, 1, -1, -1];
const DY = [0, 0, 1, -1, 1, -1, 1, -1];

export const nav = {
  cs: 20,
  cols: 0,
  rows: 0,
  walk: null,
  dist: null,
  timer: 0,

  build() {
    const cs = this.cs;
    this.cols = Math.ceil(map.w / cs);
    this.rows = Math.ceil(map.h / cs);
    const n = this.cols * this.rows;
    this.walk = new Uint8Array(n).fill(1);
    this.dist = new Int32Array(n).fill(-1);
    const blocks = map.solidList;
    for (let cy = 0; cy < this.rows; cy++) {
      for (let cx = 0; cx < this.cols; cx++) {
        const x0 = cx * cs - 5, y0 = cy * cs - 5, x1 = cx * cs + cs + 5, y1 = cy * cs + cs + 5;
        for (const r of blocks) {
          if (x1 > r.x && x0 < r.x + r.w && y1 > r.y && y0 < r.y + r.h) {
            this.walk[cy * this.cols + cx] = 0;
            break;
          }
        }
      }
    }
  },

  idx(cx, cy) { return cy * this.cols + cx; },

  cellOf(x, y) {
    return [
      clamp(Math.floor(x / this.cs), 0, this.cols - 1),
      clamp(Math.floor(y / this.cs), 0, this.rows - 1),
    ];
  },

  isWalkable(x, y) {
    const [cx, cy] = this.cellOf(x, y);
    return this.walk[this.idx(cx, cy)] === 1;
  },

  nearestWalkable(cx, cy) {
    if (cx >= 0 && cy >= 0 && cx < this.cols && cy < this.rows && this.walk[this.idx(cx, cy)]) return [cx, cy];
    for (let rad = 1; rad < 12; rad++) {
      for (let dy = -rad; dy <= rad; dy++) {
        for (let dx = -rad; dx <= rad; dx++) {
          if (Math.max(Math.abs(dx), Math.abs(dy)) !== rad) continue;
          const nx = cx + dx, ny = cy + dy;
          if (nx < 0 || ny < 0 || nx >= this.cols || ny >= this.rows) continue;
          if (this.walk[this.idx(nx, ny)]) return [nx, ny];
        }
      }
    }
    return [cx, cy];
  },

  // rebuild the BFS distance field toward (px,py), throttled
  update(px, py, dt) {
    this.timer -= dt;
    if (this.timer > 0) return;
    this.timer = 0.22;
    let [cx, cy] = this.cellOf(px, py);
    [cx, cy] = this.nearestWalkable(cx, cy);
    const n = this.cols * this.rows;
    this.dist.fill(-1);
    const q = new Int32Array(n);
    let qh = 0, qt = 0;
    const si = this.idx(cx, cy);
    this.dist[si] = 0;
    q[qt++] = si;
    while (qh < qt) {
      const ci = q[qh++];
      const d = this.dist[ci];
      const x = ci % this.cols, y = (ci / this.cols) | 0;
      for (let k = 0; k < 8; k++) {
        const nx = x + DX[k], ny = y + DY[k];
        if (nx < 0 || ny < 0 || nx >= this.cols || ny >= this.rows) continue;
        const ni = this.idx(nx, ny);
        if (!this.walk[ni] || this.dist[ni] >= 0) continue;
        if (k >= 4 && (!this.walk[this.idx(x + DX[k], y)] || !this.walk[this.idx(x, y + DY[k])])) continue;
        this.dist[ni] = d + 1;
        q[qt++] = ni;
      }
    }
  },

  // next waypoint toward the player, one nav cell ahead; null when standing on the target
  step(x, y) {
    let [cx, cy] = this.cellOf(x, y);
    if (!this.walk[this.idx(cx, cy)] || this.dist[this.idx(cx, cy)] < 0) {
      [cx, cy] = this.nearestWalkable(cx, cy);
    }
    let best = null;
    let bd = this.dist[this.idx(cx, cy)];
    if (bd <= 0) return null;
    for (let k = 0; k < 8; k++) {
      const nx = cx + DX[k], ny = cy + DY[k];
      if (nx < 0 || ny < 0 || nx >= this.cols || ny >= this.rows) continue;
      if (!this.walk[this.idx(nx, ny)]) continue;
      const di = this.dist[this.idx(nx, ny)];
      if (di >= 0 && (best === null || di < bd)) { bd = di; best = [nx, ny]; }
    }
    if (!best) return null;
    return { x: best[0] * this.cs + this.cs / 2, y: best[1] * this.cs + this.cs / 2 };
  },

  randomPoint(roomIds) {
    for (let i = 0; i < 200; i++) {
      const id = choice(roomIds);
      const r = map.rooms.find((q) => q.id === id);
      if (!r) continue;
      const x = rand(r.x + 40, r.x + r.w - 40);
      const y = rand(r.y + 40, r.y + r.h - 40);
      const [cx, cy] = this.cellOf(x, y);
      if (this.walk[this.idx(cx, cy)] && this.dist[this.idx(cx, cy)] >= 0) return { x, y };
    }
    return null;
  },
};

nav.build();
