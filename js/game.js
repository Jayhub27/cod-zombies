// ZOMBIES — a Call of Duty Zombies fan remake. Top-down round-based survival.
// Everything client side: canvas 2D + synthesized WebAudio.

import {
  TAU, clamp, lerp, rand, randInt, choice, chance, dist, angleTo, normAng,
  segCircle, easeOut, easeInOut, circleRectResolve, pointInRect, rectDistPoint,
} from './utils.js';
import { audio } from './audio.js';
import { map, nav } from './map.js';
import {
  WEAPONS, statsOf, boxRoll, POINTS, KNIFE, GRENADE, ZOMB, POWERUPS, rollPowerup,
} from './weapons.js';

// ------------------------------------------------------------------ canvas
const canvas = document.getElementById('game');
const ctx = canvas.getContext('2d');
let W = 0, H = 0, DPR = 1;

const darkCanvas = document.createElement('canvas');
const darkCtx = darkCanvas.getContext('2d');
const worldCanvas = document.createElement('canvas');
worldCanvas.width = map.w; worldCanvas.height = map.h;
const wctx = worldCanvas.getContext('2d');
const decalCanvas = document.createElement('canvas');
decalCanvas.width = map.w; decalCanvas.height = map.h;
const dctx = decalCanvas.getContext('2d');

function resize() {
  DPR = Math.min(2, window.devicePixelRatio || 1);
  W = window.innerWidth;
  H = window.innerHeight;
  canvas.width = Math.floor(W * DPR);
  canvas.height = Math.floor(H * DPR);
  canvas.style.width = W + 'px';
  canvas.style.height = H + 'px';
  darkCanvas.width = canvas.width;
  darkCanvas.height = canvas.height;
}
window.addEventListener('resize', resize);
resize();

const FONT = 'Impact, "Arial Black", sans-serif';
const MONO = '"Consolas", "Menlo", monospace';
const BOX_NAMES = ['THOMPSON', 'MG42', 'TRENCH GUN', 'MP40', 'M14', 'RAY GUN', 'THUNDERGUN', 'PANZERFAUST', 'TEDDY BEAR'];

// ------------------------------------------------------------------ input
const keys = {};
const mouse = { x: 0, y: 0, down: false, fresh: false };

window.addEventListener('keydown', (e) => {
  if (['Space', 'Tab', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(e.code)) e.preventDefault();
  keys[e.code] = true;
  audio.unlock();
  if (e.repeat) return;
  switch (e.code) {
    case 'Enter':
      if (game.state === 'title' || game.state === 'gameover') startGame();
      else if (game.state === 'paused') resumeGame();
      break;
    case 'Escape':
      if (game.state === 'playing') pauseGame();
      else if (game.state === 'paused') resumeGame();
      break;
    case 'KeyR': if (game.state === 'playing') startReload(); break;
    case 'KeyG': if (game.state === 'playing') throwGrenade(); break;
    case 'KeyV': if (game.state === 'playing') doKnife(); break;
    case 'KeyQ': if (game.state === 'playing') swapWeapon(); break;
    case 'Digit1': if (game.state === 'playing') swapWeapon(0); break;
    case 'Digit2': if (game.state === 'playing') swapWeapon(1); break;
    case 'KeyM': audio.toggleMute(); break;
  }
});
window.addEventListener('keyup', (e) => { keys[e.code] = false; });
window.addEventListener('mousemove', (e) => { mouse.x = e.clientX; mouse.y = e.clientY; });
window.addEventListener('mousedown', (e) => {
  audio.unlock();
  if (e.button === 0) { mouse.down = true; mouse.fresh = true; }
  if (e.button === 2 && game.state === 'playing') doKnife();
});
window.addEventListener('mouseup', (e) => {
  if (e.button === 0) { mouse.down = false; mouse.fresh = false; }
});
window.addEventListener('contextmenu', (e) => e.preventDefault());
window.addEventListener('wheel', () => { if (game.state === 'playing') swapWeapon(); }, { passive: true });
window.addEventListener('blur', () => { if (game.state === 'playing') pauseGame(); });
document.addEventListener('visibilitychange', () => {
  if (document.hidden && game.state === 'playing') pauseGame();
});

// ------------------------------------------------------------------ screens
const els = {
  title: document.getElementById('screen-title'),
  pause: document.getElementById('screen-pause'),
  over: document.getElementById('screen-over'),
  overTitle: document.getElementById('over-title'),
  overStats: document.getElementById('over-stats'),
  best: document.getElementById('best-label'),
};

function showScreen(which) {
  for (const k of ['title', 'pause', 'over']) els[k].classList.toggle('hidden', k !== which);
  if (!which) for (const k of ['title', 'pause', 'over']) els[k].classList.add('hidden');
  document.body.classList.toggle('playing', !which);
}
els.title.addEventListener('click', () => { audio.unlock(); if (game.state === 'title') startGame(); });
els.over.addEventListener('click', () => { if (game.state === 'gameover') startGame(); });
els.pause.addEventListener('click', () => { if (game.state === 'paused') resumeGame(); });

const bestRound = {
  get() { return parseInt(localStorage.getItem('zombies_best') || '0', 10) || 0; },
  set(v) {
    if (v > this.get()) localStorage.setItem('zombies_best', String(v));
    els.best.textContent = 'BEST ROUND: ' + this.get();
  },
};
bestRound.set(0);

// ------------------------------------------------------------------ state
const game = {
  state: 'title',       // title | playing | paused | gameover
  round: 0,
  phase: 'idle',        // idle | intro | active | inter
  phaseT: 0,
  toSpawn: 0,
  spawnedThisRound: 0,
  spawnTimer: 0,
  kills: 0,
  time: 0,
  shake: 0,
  flashWhite: 0,
  banners: [],
  hitmarks: [],
  lights: [],
  box: { state: 'idle', t: 0, cycleT: 0, cycleIdx: 0, result: null },
};

let player = makePlayer();
let zombies = [];
let bullets = [];
let grenades = [];
let parts = [];
let pickups = [];
const cam = { x: 0, y: 0, zoom: 1, drawX: 0, drawY: 0 };

function makePlayer() {
  return {
    x: 420, y: 300, r: 12, aim: 0,
    hp: 100, maxHp: 100,
    points: 500,
    weapons: [{ id: 'm1911', ammo: 8, reserve: 80, pap: false }, null],
    slot: 0,
    fireCd: 0, kick: 0, flash: 0,
    reload: null, swapT: 0,
    knifeCd: 0, knifeT: 0,
    grenades: 2,
    perks: { qr: false, jugg: false, speed: false, dt: false },
    power: { insta: 0, double: 0 },
    downed: false, downT: 0,
    regenT: 0, hurtT: 0,
    moving: false, sprinting: false,
    hold: { target: null, t: 0, tick: 0 },
    deny: null,
  };
}

function curWeapon() { return player.weapons[player.slot]; }

function screenToWorld(sx, sy) {
  return {
    x: (sx - W / 2) / cam.zoom + cam.x,
    y: (sy - H / 2) / cam.zoom + cam.y,
  };
}

function posVol(x, y) { return clamp(1 - dist(player.x, player.y, x, y) / 1300, 0.08, 1); }
function addPoints(n) { player.points += n * (player.power.double > 0 ? 2 : 1); }

function banner(text, sub = '', dur = 2.2, color = '#d8d2c4', size = 78) {
  game.banners.push({ text, sub, dur, t: 0, color, size });
  if (game.banners.length > 4) game.banners.shift();
}
function denyMsg(text) { player.deny = { t: 1.3, text }; audio.deny(); }
function hitmark(color) { game.hitmarks.push({ t: 0.14, max: 0.14, color }); }

// ------------------------------------------------------------------ game flow
function startGame() {
  // reset map
  for (const d of map.doors) d.open = false;
  for (const w of map.windows) { w.boards = 6; w.climbers = 0; }
  map.rebuildSolids();
  nav.build();
  nav.timer = 0;

  player = makePlayer();
  zombies = []; bullets = []; grenades = []; parts = []; pickups = [];
  game.round = 0; game.phase = 'idle'; game.phaseT = 0;
  game.toSpawn = 0; game.spawnedThisRound = 0; game.spawnTimer = 0;
  game.kills = 0; game.time = 0; game.shake = 0; game.flashWhite = 0;
  game.banners = []; game.hitmarks = []; game.lights = [];
  game.box = { state: 'idle', t: 0, cycleT: 0, cycleIdx: 0, result: null };

  dctx.clearRect(0, 0, map.w, map.h);
  cam.x = player.x; cam.y = player.y;

  game.state = 'playing';
  showScreen(null);
  audio.unlock();
  startRound(1);
}

function pauseGame() {
  game.state = 'paused';
  showScreen('pause');
}
function resumeGame() {
  game.state = 'playing';
  showScreen(null);
}

function playerDie() {
  game.state = 'gameover';
  audio.gameOver();
  bestRound.set(game.round);
  els.overTitle.textContent = 'YOU DIED';
  els.overStats.textContent =
    `SURVIVED TO ROUND ${game.round}\n${game.kills} KILLS · ${Math.floor(player.points)} POINTS\n`;
  showScreen('over');
}

function startRound(n) {
  game.round = n;
  game.toSpawn = ZOMB.count(n);
  game.spawnedThisRound = 0;
  game.phase = 'intro';
  game.phaseT = 2.6;
  game.spawnTimer = 0.4;
  banner('ROUND ' + n, '', 2.6, '#d8d2c4', 92);
  audio.roundStart();
}

// ------------------------------------------------------------------ zombies
function connectedRooms() {
  const start = map.roomAt(player.x, player.y).id;
  const seen = { [start]: true };
  const stack = [start];
  while (stack.length) {
    const r = stack.pop();
    for (const d of map.doors) {
      if (!d.open) continue;
      if (d.rooms[0] === r && !seen[d.rooms[1]]) { seen[d.rooms[1]] = true; stack.push(d.rooms[1]); }
      if (d.rooms[1] === r && !seen[d.rooms[0]]) { seen[d.rooms[0]] = true; stack.push(d.rooms[0]); }
    }
  }
  return Object.keys(seen);
}

function spawnZombie() {
  const rooms = connectedRooms();
  let cands = map.windows.filter((w) => rooms.includes(w.room) && w.climbers < 2);
  if (!cands.length) cands = map.windows.filter((w) => rooms.includes(w.room));
  if (!cands.length) cands = map.windows;
  const w = choice(cands);
  w.climbers++;
  const hp = ZOMB.hp(game.round);
  const spr = chance(ZOMB.sprChance(game.round));
  zombies.push({
    x: w.out.x, y: w.out.y, r: 14,
    hp: spr ? hp * 0.85 : hp, maxHp: hp,
    speed: ZOMB.speed(game.round) * rand(0.9, 1.1) * (spr ? 1.75 : 1),
    face: angleTo(w.out.x, w.out.y, w.in.x, w.in.y),
    state: 'climb', phase: 'eat', eat: 0.08, climbT: 0,
    atkCd: 0, windup: 0, flash: 0, stagger: 0, dieT: 0,
    sprinter: spr, win: w, inWindow: true,
    growlT: rand(0.5, 3), kbx: 0, kby: 0,
  });
  game.spawnedThisRound++;
}

function updateClimb(z, dt) {
  const w = z.win;
  if (!w) { z.state = 'walk'; return; }
  if (z.phase !== 'in') {
    z.eat -= dt;
    if (w.boards > 0) {
      if (z.eat <= 0) {
        w.boards--;
        z.eat = 0.34;
        audio.boardBreak();
        woodParticles(w);
      }
    } else {
      z.phase = 'in';
      z.climbT = 0;
      woodParticles(w, 10);
    }
  } else {
    z.climbT += dt;
    const t = clamp(z.climbT / 0.7, 0, 1);
    const e = easeInOut(t);
    z.x = lerp(w.out.x, w.in.x, e);
    z.y = lerp(w.out.y, w.in.y, e);
    if (t >= 1) {
      z.state = 'walk';
      if (z.inWindow) { z.inWindow = false; w.climbers = Math.max(0, w.climbers - 1); }
    }
  }
}

function updateZombies(dt) {
  for (let i = zombies.length - 1; i >= 0; i--) {
    const z = zombies[i];
    if (z.state === 'dead') {
      z.dieT += dt;
      if (z.dieT > 0.75) zombies.splice(i, 1);
      continue;
    }
    if (z.flash > 0) z.flash -= dt;
    if (z.stagger > 0) z.stagger -= dt;
    if (z.kbx || z.kby) {
      z.x += z.kbx * dt; z.y += z.kby * dt;
      const f = Math.exp(-7 * dt);
      z.kbx *= f; z.kby *= f;
      if (Math.abs(z.kbx) < 1) z.kbx = 0;
      if (Math.abs(z.kby) < 1) z.kby = 0;
    }
    if (z.state === 'climb') { updateClimb(z, dt); continue; }

    z.face = angleTo(z.x, z.y, player.x, player.y);
    z.growlT -= dt;
    if (z.growlT <= 0) {
      z.growlT = rand(2.5, 7);
      const vol = posVol(z.x, z.y) * 0.16;
      if (vol > 0.02) audio.growl(vol);
    }

    const d = dist(z.x, z.y, player.x, player.y);
    if (z.state === 'attack') {
      z.windup -= dt;
      z.x += Math.cos(z.face) * 70 * dt;
      z.y += Math.sin(z.face) * 70 * dt;
      if (z.windup <= 0) {
        if (d < z.r + player.r + 20 && !player.downed) hurtPlayer(ZOMB.damage(game.round));
        z.state = 'walk';
        z.atkCd = rand(0.85, 1.15);
      }
    } else {
      if (z.atkCd > 0) z.atkCd -= dt;
      let tx = player.x, ty = player.y;
      if (d > 110) {
        const step = nav.step(z.x, z.y);
        if (step) { tx = step.x; ty = step.y; }
      }
      let dx = tx - z.x, dy = ty - z.y;
      const dl = Math.hypot(dx, dy) || 1;
      dx /= dl; dy /= dl;

      // separation from other zombies
      let sx = 0, sy = 0;
      for (const o of zombies) {
        if (o === z || o.state === 'dead') continue;
        const ddx = z.x - o.x, ddy = z.y - o.y;
        const dd2 = ddx * ddx + ddy * ddy;
        const rr = z.r + o.r + 4;
        if (dd2 < rr * rr && dd2 > 0.01) {
          const dd = Math.sqrt(dd2);
          sx += (ddx / dd) * ((rr - dd) / rr);
          sy += (ddy / dd) * ((rr - dd) / rr);
        }
      }
      let vx = dx + sx * 1.7, vy = dy + sy * 1.7;
      const vl = Math.hypot(vx, vy) || 1;
      vx /= vl; vy /= vl;

      const spd = z.speed * (z.stagger > 0 ? 0 : 1) * (player.downed ? 0.55 : 1);
      z.x += vx * spd * dt;
      z.y += vy * spd * dt;
      for (const r of map.solidList) circleRectResolve(z, r);

      // don't walk into the player
      const pd = dist(z.x, z.y, player.x, player.y);
      const rr = z.r + player.r;
      if (pd < rr && pd > 0.01) {
        z.x += ((z.x - player.x) / pd) * (rr - pd);
        z.y += ((z.y - player.y) / pd) * (rr - pd);
      }

      if (d < z.r + player.r + 6 && z.atkCd <= 0 && !player.downed) {
        z.state = 'attack';
        z.windup = 0.32;
      }
    }
  }
}

function applyDamage(z, dmg, headshot, opts = {}) {
  if (z.state === 'dead') return false;
  const insta = player.power.insta > 0;
  z.hp -= dmg;
  z.flash = 0.09;
  if (insta || z.hp <= 0) {
    killZombie(z, headshot, opts);
    return true;
  }
  if (opts.hitPoints !== false) addPoints(POINTS.hit);
  audio.zombieHit(headshot, posVol(z.x, z.y));
  hitmark('#ffffff');
  bloodAt(z.x, z.y, z.face + Math.PI, headshot ? 12 : 7);
  if (z.state === 'walk' && chance(0.15)) z.stagger = 0.18;
  // knockback
  const kb = clamp(dmg * 0.05, 1, 10);
  z.kbx += Math.cos(z.face) * kb * -1;
  z.kby += Math.sin(z.face) * kb * -1;
  return false;
}

function killZombie(z, headshot, opts = {}) {
  if (z.state === 'dead') return;
  z.state = 'dead';
  z.dieT = 0;
  if (headshot) z.head = true;
  const pts = opts.noPoints ? 0 : (opts.points ?? (headshot ? POINTS.headshotKill : POINTS.kill));
  addPoints(pts);
  game.kills++;
  audio.zombieDie(posVol(z.x, z.y));
  hitmark('#ff4040');
  bloodAt(z.x, z.y, rand(0, TAU), headshot ? 26 : 16);
  decalPool(z.x, z.y, rand(16, 24));
  if (z.inWindow && z.win) { z.inWindow = false; z.win.climbers = Math.max(0, z.win.climbers - 1); }
  if (!opts.noDrop && pickups.length < 2 && chance(0.032)) spawnPickup(z.x, z.y);
}

// ------------------------------------------------------------------ player actions
function tryFire() {
  const w = curWeapon();
  if (!w || player.swapT > 0 || player.reload || player.knifeT > 0 || player.downed) return;
  const st = statsOf(w);
  if (player.fireCd > 0) return;
  if (!st.auto && !mouse.fresh) return;
  if (w.ammo <= 0) {
    if (mouse.fresh) { audio.dryFire(); startReload(); mouse.fresh = false; }
    return;
  }
  mouse.fresh = false;
  w.ammo--;
  const rpm = st.rpm * (player.perks.dt ? 1.33 : 1);
  player.fireCd = 60 / rpm;
  player.kick = 1;
  player.flash = 0.05;
  game.shake = Math.max(game.shake, st.cls === 'shotgun' ? 5 : st.cls === 'mg' ? 2.2 : 1.5);

  if (st.cls === 'thunder') { thunderBlast(st); return; }
  audio.shot(st.cls);

  const mx = player.x + Math.cos(player.aim) * 26;
  const my = player.y + Math.sin(player.aim) * 26;
  for (let i = 0; i < st.pellets; i++) {
    const spread = (st.spread * Math.PI) / 180;
    const a = player.aim + rand(-spread, spread);
    bullets.push({
      x: mx, y: my, vx: Math.cos(a) * st.speed, vy: Math.sin(a) * st.speed,
      dmg: st.dmg, cls: st.cls, pap: st.pap, life: 1.3, splash: st.splash,
      smokeT: 0,
    });
  }
  // shell casing
  parts.push({
    type: 'shell', x: mx, y: my,
    vx: Math.cos(player.aim - Math.PI / 2) * rand(40, 90) + rand(-20, 20),
    vy: Math.sin(player.aim - Math.PI / 2) * rand(40, 90) + rand(-20, 20),
    life: rand(0.5, 0.9), max: 0.9, size: 3, rot: rand(0, TAU), color: '#d8b64a',
  });
}

function thunderBlast(st) {
  audio.thunderShot();
  game.shake = Math.max(game.shake, 10);
  parts.push({ type: 'ring', x: player.x, y: player.y, r: 24, rMax: st.wedge.range, life: 0.35, max: 0.35, color: '#bfefff' });
  for (let i = 0; i < 14; i++) {
    const a = player.aim + rand(-st.wedge.halfAngle, st.wedge.halfAngle);
    parts.push({
      type: 'spark', x: player.x + Math.cos(a) * 30, y: player.y + Math.sin(a) * 30,
      vx: Math.cos(a) * rand(500, 900), vy: Math.sin(a) * rand(500, 900),
      life: rand(0.12, 0.25), max: 0.25, size: 2, color: '#dff6ff',
    });
  }
  for (const z of zombies) {
    if (z.state === 'dead') continue;
    const d = dist(player.x, player.y, z.x, z.y);
    if (d > st.wedge.range + z.r) continue;
    const da = Math.abs(normAng(angleTo(player.x, player.y, z.x, z.y) - player.aim));
    if (da > st.wedge.halfAngle) continue;
    const a = angleTo(player.x, player.y, z.x, z.y);
    z.kbx += Math.cos(a) * 320;
    z.kby += Math.sin(a) * 320;
    z.stagger = 0.6;
    applyDamage(z, st.dmg, false, {});
  }
}

function startReload() {
  const w = curWeapon();
  if (!w || player.reload || player.swapT > 0 || player.downed) return;
  const st = statsOf(w);
  if (w.ammo >= st.mag) return;
  if (w.reserve <= 0) { audio.deny(); return; }
  const time = st.reload * (player.perks.speed ? 0.55 : 1);
  player.reload = { t: time, total: time, mid: false };
  audio.reloadStart();
}

function updateReload(dt) {
  const r = player.reload;
  if (!r) return;
  r.t -= dt;
  if (!r.mid && r.t <= r.total * 0.45) { r.mid = true; audio.reloadMid(); }
  if (r.t <= 0) {
    const w = curWeapon();
    if (w) {
      const st = statsOf(w);
      const take = Math.min(st.mag - w.ammo, w.reserve);
      w.ammo += take;
      w.reserve -= take;
    }
    player.reload = null;
    audio.reloadEnd();
  }
}

function swapWeapon(forceIdx) {
  if (player.downed || player.swapT > 0 || player.reload) return;
  let idx = forceIdx;
  if (idx == null) idx = player.slot === 0 ? 1 : 0;
  if (!player.weapons[idx] || idx === player.slot) return;
  player.slot = idx;
  player.swapT = 0.45;
  audio.reloadMid();
}

function throwGrenade() {
  if (player.downed || player.swapT > 0) return;
  if (player.grenades <= 0) { audio.deny(); return; }
  player.grenades--;
  const a = player.aim + rand(-0.05, 0.05);
  grenades.push({
    x: player.x + Math.cos(player.aim) * 18,
    y: player.y + Math.sin(player.aim) * 18,
    vx: Math.cos(a) * GRENADE.speed,
    vy: Math.sin(a) * GRENADE.speed,
    fuse: GRENADE.fuse, rot: 0,
  });
  audio.knifeSwing();
}

function doKnife() {
  if (player.downed || player.knifeCd > 0 || player.reload || player.swapT > 0) return;
  player.knifeCd = KNIFE.cd;
  player.knifeT = 0.18;
  let hit = false;
  for (const z of zombies) {
    if (z.state === 'dead') continue;
    const d = dist(player.x, player.y, z.x, z.y);
    if (d > KNIFE.range + z.r) continue;
    const da = Math.abs(normAng(angleTo(player.x, player.y, z.x, z.y) - player.aim));
    if (da > 1.05) continue;
    hit = true;
    const a = angleTo(player.x, player.y, z.x, z.y);
    z.kbx += Math.cos(a) * 120;
    z.kby += Math.sin(a) * 120;
    if (player.power.insta > 0 || z.hp <= KNIFE.dmg) {
      killZombie(z, false, { points: POINTS.knifeKill });
    } else {
      applyDamage(z, KNIFE.dmg, false, {});
    }
    break;
  }
  audio[hit ? 'knifeHit' : 'knifeSwing']();
}

function hurtPlayer(dmg) {
  if (player.downed || game.state !== 'playing') return;
  player.hp -= dmg;
  player.regenT = 5;
  player.hurtT = 0.5;
  game.shake = Math.max(game.shake, 5);
  audio.playerHurt();
  if (player.hp <= 0) {
    if (player.perks.qr) {
      player.downed = true;
      player.downT = 3.2;
      player.hp = 0;
      banner('DOWNED', 'QUICK REVIVE IS KICKING IN…', 3.2, '#e0453e', 64);
      audio.growl(0.32);
    } else {
      playerDie();
    }
  }
}

function revivePlayer() {
  player.downed = false;
  player.perks.qr = false;
  player.hp = player.maxHp;
  banner('REVIVED', '', 1.6, '#4fd08a', 56);
  audio.perkBuy();
  for (const z of zombies) {
    if (z.state === 'dead') continue;
    const d = dist(z.x, z.y, player.x, player.y);
    if (d < 260) {
      const a = angleTo(player.x, player.y, z.x, z.y);
      z.kbx += Math.cos(a) * 380;
      z.kby += Math.sin(a) * 380;
      z.stagger = 1.0;
    }
  }
}

// ------------------------------------------------------------------ interact
function findInteract() {
  const px = player.x, py = player.y;
  let best = null;
  const consider = (type, ref, x, y, d, label, cost, hold) => {
    if (best && d >= best.dist) return;
    best = { type, ref, dist: d, label, cost, hold, x, y };
  };

  for (const d of map.doors) {
    if (d.open) continue;
    const dd = rectDistPoint(px, py, d.rect);
    if (dd < 74) consider('door', d, d.rect.x + d.rect.w / 2, d.rect.y + d.rect.h / 2, dd, 'OPEN DOOR', d.cost, 0);
  }
  for (const b of map.buys) {
    const dd = rectDistPoint(px, py, { x: b.x - 16, y: b.y - 16, w: 32, h: 32 });
    if (dd < 70) {
      const def = WEAPONS[b.id];
      const owned = player.weapons.find((w) => w && w.id === b.id);
      if (!owned) consider('buy', b, b.x, b.y, dd, 'BUY ' + def.name.toUpperCase(), def.cost, 0.9);
      else {
        const st = statsOf(owned);
        consider('buy', b, b.x, b.y, dd, `BUY AMMO (${owned.reserve}/${st.reserve})`, def.ammoCost, 0.9);
      }
    }
  }
  for (const p of map.perks) {
    if (player.perks[p.id]) continue;
    const dd = rectDistPoint(px, py, p.rect);
    if (dd < 76) consider('perk', p, p.x, p.y, dd, 'BUY ' + p.name.toUpperCase(), p.cost, 1.2);
  }
  {
    const b = map.box;
    const dd = rectDistPoint(px, py, b.rect);
    if (dd < 80 && game.box.state === 'idle') consider('box', b, b.x, b.y, dd, 'MYSTERY BOX', b.cost, 1.0);
  }
  {
    const p = map.pap;
    const dd = rectDistPoint(px, py, p.rect);
    if (dd < 84) {
      const w = curWeapon();
      consider('pap', p, p.x, p.y, dd,
        w && w.pap ? 'ALREADY UPGRADED' : 'PACK-A-PUNCH', p.cost, 2.2);
    }
  }
  for (const w of map.windows) {
    if (w.boards >= 6) continue;
    const dd = dist(px, py, w.x, w.y);
    if (dd < 76) consider('window', w, w.x, w.y, dd, 'REPAIR WINDOW', 0, 0.34);
  }
  return best;
}

function executeInteract(t) {
  switch (t.type) {
    case 'door': {
      if (player.points < t.cost) return denyMsg('NOT ENOUGH POINTS');
      player.points -= t.cost;
      t.ref.open = true;
      map.rebuildSolids();
      nav.build();
      nav.timer = 0;
      audio.doorOpen();
      game.shake = Math.max(game.shake, 4);
      parts.push({ type: 'ring', x: t.x, y: t.y, r: 10, rMax: 90, life: 0.4, max: 0.4, color: '#e8d8a0' });
      break;
    }
    case 'buy': {
      const def = WEAPONS[t.ref.id];
      const owned = player.weapons.find((w) => w && w.id === t.ref.id);
      if (owned) {
        const st = statsOf(owned);
        if (owned.reserve >= st.reserve) return denyMsg('AMMO FULL');
        if (player.points < t.cost) return denyMsg('NOT ENOUGH POINTS');
        player.points -= t.cost;
        owned.reserve = st.reserve;
        audio.buy();
        banner('AMMO', '', 0.9, '#cfcabc', 40);
      } else {
        if (player.points < t.cost) return denyMsg('NOT ENOUGH POINTS');
        player.points -= t.cost;
        grantWeapon(t.ref.id, true);
        audio.buy();
        banner('ACQUIRED ' + def.name.toUpperCase(), '', 1.2, '#e8d8a0', 44);
      }
      break;
    }
    case 'perk': {
      const p = t.ref;
      if (player.points < p.cost) return denyMsg('NOT ENOUGH POINTS');
      player.points -= p.cost;
      player.perks[p.id] = true;
      if (p.id === 'jugg') { player.maxHp = 250; player.hp = Math.min(250, player.hp + 150); }
      audio.perkBuy();
      banner(p.name.toUpperCase(), 'PERK ACQUIRED', 1.6, p.color, 46);
      break;
    }
    case 'box': {
      if (player.points < t.cost) return denyMsg('NOT ENOUGH POINTS');
      player.points -= t.cost;
      startBoxSpin();
      break;
    }
    case 'pap': {
      const w = curWeapon();
      if (!w || w.pap) return denyMsg('ALREADY UPGRADED');
      if (player.points < t.cost) return denyMsg('NOT ENOUGH POINTS');
      player.points -= t.cost;
      w.pap = true;
      audio.pap();
      banner('WEAPON UPGRADED', statsOf(w).name.toUpperCase(), 2.0, '#f5c542', 46);
      for (let i = 0; i < 20; i++) {
        parts.push({
          type: 'spark', x: t.x + rand(-30, 30), y: t.y + rand(-20, 20),
          vx: rand(-40, 40), vy: rand(-140, -40),
          life: rand(0.4, 0.9), max: 0.9, size: 2, color: '#f5e07a',
        });
      }
      break;
    }
    case 'window': {
      const w = t.ref;
      w.boards = Math.min(6, w.boards + 1);
      addPoints(POINTS.board);
      audio.boardRepair();
      break;
    }
  }
}

function updateInteract(dt) {
  const target = game.state === 'playing' ? findInteract() : null;
  const h = player.hold;
  // findInteract() builds a fresh object each frame: compare by identity of type+ref
  const changed = !(h.target && target && h.target.type === target.type && h.target.ref === target.ref);
  h.target = target;
  if (changed) { h.t = 0; h.tick = 0; }
  if (target && keys.KeyF && !player.downed) {
    if (target.hold <= 0) {
      executeInteract(target);
    } else {
      h.t += dt;
      h.tick -= dt;
      if (h.tick <= 0) { h.tick = 0.22; audio.interactTick(); }
      if (h.t >= target.hold) {
        h.t = 0;
        executeInteract(target);
      }
    }
  } else {
    h.t = 0;
  }
}

function grantWeapon(id, switchTo) {
  const def = WEAPONS[id];
  const inst = { id, ammo: def.mag, reserve: def.reserve, pap: false };
  if (!player.weapons[1]) {
    player.weapons[1] = inst;
    player.slot = 1;
  } else {
    player.weapons[player.slot] = inst;
  }
  player.reload = null;
  if (switchTo) player.swapT = 0.4;
}

function startBoxSpin() {
  const held = player.weapons.filter(Boolean).map((w) => w.id);
  const teddy = chance(0.02);
  game.box.state = 'spin';
  game.box.t = 2.2;
  game.box.cycleT = 0;
  game.box.cycleIdx = 0;
  game.box.result = teddy ? 'teddy' : boxRoll(held);
  audio.boxOpen();
}

function updateBox(dt) {
  const b = game.box;
  if (b.state !== 'spin') return;
  b.t -= dt;
  b.cycleT -= dt;
  if (b.cycleT <= 0) { b.cycleT = 0.11; b.cycleIdx++; }
  if (b.t <= 0) {
    b.state = 'idle';
    if (b.result === 'teddy') {
      player.points += map.box.cost;
      audio.teddy();
      banner('A TEDDY BEAR…', 'YOUR POINTS ARE BACK', 2.2, '#c9a86a', 52);
    } else {
      grantWeapon(b.result, true);
      audio.boxLand();
      banner('YOU GOT', WEAPONS[b.result].name.toUpperCase(), 2.2, '#e8d8a0', 56);
    }
  }
}

// ------------------------------------------------------------------ bullets / explosions
function bulletBlocked(x, y) {
  for (const r of map.solidList) {
    if (pointInRect(x, y, r)) {
      for (const w of map.windows) {
        if (pointInRect(x, y, w.rect, 1)) return false;
      }
      return true;
    }
  }
  return false;
}

function explodeBullet(b) {
  const kind = b.cls === 'ray' ? 'ray' : 'rocket';
  explode(b.x, b.y, b.splash.r, b.splash.dmg, kind, b.splash.self);
}

function explode(x, y, r, dmg, kind, selfDmg = 0) {
  audio.explode(kind);
  game.shake = Math.max(game.shake, kind === 'ray' ? 8 : 14);
  game.lights.push({ x, y, r: r * 1.7, t: 0.22, max: 0.22, a: 0.9 });
  parts.push({ type: 'ring', x, y, r: 12, rMax: r, life: 0.3, max: 0.3, color: kind === 'ray' ? '#8dff8a' : '#ffcf8a' });
  const nFire = kind === 'ray' ? 8 : 16;
  for (let i = 0; i < nFire; i++) {
    const a = rand(0, TAU), sp = rand(40, r * 3.2);
    parts.push({
      type: 'fire', x, y, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp,
      life: rand(0.2, 0.55), max: 0.55, size: rand(4, 10),
      color: kind === 'ray' ? '#7dff9a' : '#ff9a4a',
    });
  }
  for (let i = 0; i < 10; i++) {
    const a = rand(0, TAU), sp = rand(20, r);
    parts.push({
      type: 'smoke', x, y, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp,
      life: rand(0.5, 1.1), max: 1.1, size: rand(6, 14), color: '#8a8a90',
    });
  }
  for (let i = 0; i < 12; i++) {
    const a = rand(0, TAU), sp = rand(200, 500);
    parts.push({
      type: 'spark', x, y, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp,
      life: rand(0.1, 0.3), max: 0.3, size: 2, color: '#ffe9a8',
    });
  }
  decalScorch(x, y, r * 0.55);

  for (const z of zombies) {
    if (z.state === 'dead') continue;
    const d = dist(x, y, z.x, z.y);
    if (d < r + z.r) {
      const f = 1 - 0.65 * (d / (r + z.r));
      const a = angleTo(x, y, z.x, z.y);
      z.kbx += Math.cos(a) * 140 * f;
      z.kby += Math.sin(a) * 140 * f;
      applyDamage(z, dmg * f, false, { hitPoints: false });
    }
  }
  if (selfDmg && dist(x, y, player.x, player.y) < r + player.r) {
    const d = dist(x, y, player.x, player.y);
    hurtPlayer(selfDmg * (1 - 0.6 * d / (r + player.r)));
  }
}

function updateBullets(dt) {
  for (let i = bullets.length - 1; i >= 0; i--) {
    const b = bullets[i];
    b.life -= dt;
    if (b.life <= 0) { bullets.splice(i, 1); continue; }

    if (b.cls === 'rocket') {
      b.smokeT -= dt;
      if (b.smokeT <= 0) {
        b.smokeT = 0.02;
        parts.push({ type: 'smoke', x: b.x, y: b.y, vx: rand(-15, 15), vy: rand(-15, 15), life: 0.6, max: 0.6, size: rand(4, 8), color: '#9a9aa0' });
      }
    }

    const speed = Math.hypot(b.vx, b.vy);
    const steps = Math.max(1, Math.ceil((speed * dt) / 8));
    const sdt = dt / steps;
    let dead = false;
    for (let s = 0; s < steps && !dead; s++) {
      const nx = b.x + b.vx * sdt;
      const ny = b.y + b.vy * sdt;

      let hitZ = null, headshot = false;
      for (const z of zombies) {
        if (z.state === 'dead') continue;
        const hx = z.x + Math.cos(z.face) * 8;
        const hy = z.y + Math.sin(z.face) * 8;
        if (segCircle(b.x, b.y, nx, ny, hx, hy, 7)) { hitZ = z; headshot = true; break; }
        if (segCircle(b.x, b.y, nx, ny, z.x, z.y, z.r)) { hitZ = z; headshot = false; break; }
      }
      if (hitZ) {
        b.x = nx; b.y = ny;
        applyDamage(hitZ, b.dmg, headshot, {});
        if (b.splash) explodeBullet(b);
        else bloodAt(b.x, b.y, Math.atan2(b.vy, b.vx), headshot ? 10 : 6);
        dead = true;
        break;
      }
      if (bulletBlocked(nx, ny)) {
        b.x = nx; b.y = ny;
        if (b.splash) explodeBullet(b);
        else {
          for (let k = 0; k < 4; k++) {
            parts.push({
              type: 'spark', x: b.x, y: b.y,
              vx: rand(-160, 160), vy: rand(-160, 160),
              life: rand(0.06, 0.18), max: 0.18, size: 2, color: '#ffe9a8',
            });
          }
        }
        dead = true;
        break;
      }
      b.x = nx; b.y = ny;
    }
    if (dead) bullets.splice(i, 1);
  }
}

function updateGrenades(dt) {
  for (let i = grenades.length - 1; i >= 0; i--) {
    const g = grenades[i];
    g.fuse -= dt;
    g.rot += dt * 10 * Math.sign(g.vx || 1);
    const nx = g.x + g.vx * dt;
    if (bulletBlocked(nx, g.y)) { g.vx *= -0.5; } else { g.x = nx; }
    const ny = g.y + g.vy * dt;
    if (bulletBlocked(g.x, ny)) { g.vy *= -0.5; } else { g.y = ny; }
    const f = Math.exp(-1.6 * dt);
    g.vx *= f; g.vy *= f;
    if (g.fuse <= 0) {
      explode(g.x, g.y, GRENADE.r, GRENADE.dmg, 'grenade', GRENADE.self);
      grenades.splice(i, 1);
    }
  }
}

// ------------------------------------------------------------------ particles / decals
function bloodAt(x, y, angle, count) {
  for (let i = 0; i < count; i++) {
    const a = angle + rand(-0.9, 0.9);
    const sp = rand(60, 320);
    parts.push({
      type: 'blood', x, y,
      vx: Math.cos(a) * sp, vy: Math.sin(a) * sp,
      life: rand(0.25, 0.6), max: 0.6, size: rand(1.5, 4.5),
      color: chance(0.3) ? '#a81c1c' : '#7d1418',
    });
  }
}

function woodParticles(w, n = 4) {
  for (let i = 0; i < n; i++) {
    parts.push({
      type: 'wood', x: w.x + rand(-20, 20), y: w.y + rand(-10, 10),
      vx: rand(-80, 80), vy: rand(-90, 40),
      life: rand(0.3, 0.7), max: 0.7, size: rand(3, 6), rot: rand(0, TAU), color: '#8a6a3c',
    });
  }
}

function updateParticles(dt) {
  if (parts.length > 520) parts.splice(0, parts.length - 520);
  for (let i = parts.length - 1; i >= 0; i--) {
    const p = parts[i];
    p.life -= dt;
    if (p.life <= 0) {
      if (p.type === 'blood' && chance(0.3) && !solidAt(p.x, p.y)) {
        dctx.fillStyle = 'rgba(90,12,14,0.45)';
        dctx.beginPath();
        dctx.arc(p.x, p.y, rand(2, 5), 0, TAU);
        dctx.fill();
      }
      parts.splice(i, 1);
      continue;
    }
    if (p.type === 'ring') continue;
    p.x += p.vx * dt;
    p.y += p.vy * dt;
    const f = Math.exp(-(p.type === 'smoke' ? 2.2 : 6) * dt);
    p.vx *= f; p.vy *= f;
    if (p.type === 'smoke') p.size += 14 * dt;
  }
}

function solidAt(x, y) {
  for (const r of map.solidList) if (pointInRect(x, y, r)) return true;
  return false;
}

function decalPool(x, y, r) {
  dctx.fillStyle = 'rgba(70,8,10,0.5)';
  dctx.beginPath();
  dctx.ellipse(x, y, r, r * 0.7, rand(0, TAU), 0, TAU);
  dctx.fill();
  for (let i = 0; i < 5; i++) {
    dctx.beginPath();
    dctx.arc(x + rand(-r, r), y + rand(-r * 0.7, r * 0.7), rand(2, 5), 0, TAU);
    dctx.fill();
  }
}

function decalScorch(x, y, r) {
  const g = dctx.createRadialGradient(x, y, 0, x, y, r);
  g.addColorStop(0, 'rgba(10,8,6,0.65)');
  g.addColorStop(1, 'rgba(10,8,6,0)');
  dctx.fillStyle = g;
  dctx.beginPath();
  dctx.arc(x, y, r, 0, TAU);
  dctx.fill();
}

// ------------------------------------------------------------------ pickups
function spawnPickup(x, y) {
  const type = rollPowerup();
  pickups.push({ x, y, type, t: 0, life: 32 });
}

function applyPickup(p) {
  const def = POWERUPS[p.type];
  audio.powerup(p.type);
  banner(def.label, '', 1.8, def.color, 56);
  switch (p.type) {
    case 'maxammo':
      for (const w of player.weapons) {
        if (!w) continue;
        w.reserve = statsOf(w).reserve;
      }
      break;
    case 'instakill': player.power.insta = 30; break;
    case 'double': player.power.double = 30; break;
    case 'nuke': {
      game.flashWhite = 0.6;
      game.shake = Math.max(game.shake, 18);
      audio.explode('nuke');
      for (const z of zombies) killZombie(z, false, { noPoints: true, noDrop: true });
      addPoints(POINTS.nuke);
      break;
    }
    case 'carpenter': {
      for (const w of map.windows) w.boards = 6;
      addPoints(POINTS.carpenter);
      break;
    }
  }
}

function updatePickups(dt) {
  for (let i = pickups.length - 1; i >= 0; i--) {
    const p = pickups[i];
    p.t += dt;
    if (p.t > p.life) { pickups.splice(i, 1); continue; }
    if (dist(p.x, p.y, player.x, player.y) < player.r + 22 && !player.downed) {
      applyPickup(p);
      pickups.splice(i, 1);
    }
  }
}

// ------------------------------------------------------------------ round / camera
function updateRound(dt) {
  if (game.phase === 'intro') {
    game.phaseT -= dt;
    if (game.phaseT <= 0) { game.phase = 'active'; game.spawnTimer = 0.3; }
    return;
  }
  if (game.phase === 'active') {
    const alive = zombies.reduce((n, z) => n + (z.state !== 'dead' ? 1 : 0), 0);
    if (game.spawnedThisRound < game.toSpawn) {
      game.spawnTimer -= dt;
      if (game.spawnTimer <= 0 && alive < ZOMB.maxAlive(game.round)) {
        spawnZombie();
        game.spawnTimer = ZOMB.spawnInterval(game.round) * rand(0.7, 1.3);
      }
    } else if (zombies.length === 0) {
      game.phase = 'inter';
      game.phaseT = 6;
      player.grenades = Math.min(4, player.grenades + 1);
    }
    return;
  }
  if (game.phase === 'inter') {
    game.phaseT -= dt;
    if (game.phaseT <= 0) startRound(game.round + 1);
  }
}

function updateCamera(dt) {
  const targetX = player.x + Math.cos(player.aim) * 60;
  const targetY = player.y + Math.sin(player.aim) * 60;
  const k = 1 - Math.exp(-7 * dt);
  cam.x += (targetX - cam.x) * k;
  cam.y += (targetY - cam.y) * k;
  cam.zoom = clamp(Math.min(W / 1250, H / 750), 0.75, 1.7);
  const viewW = W / cam.zoom, viewH = H / cam.zoom;
  if (map.w <= viewW) cam.x = map.w / 2; else cam.x = clamp(cam.x, viewW / 2, map.w - viewW / 2);
  if (map.h <= viewH) cam.y = map.h / 2; else cam.y = clamp(cam.y, viewH / 2, map.h - viewH / 2);
  game.shake *= Math.exp(-6 * dt);
  if (game.shake < 0.05) game.shake = 0;
  cam.drawX = cam.x + rand(-1, 1) * game.shake;
  cam.drawY = cam.y + rand(-1, 1) * game.shake;
}

// ------------------------------------------------------------------ update
function update(dt) {
  game.time += dt;
  updatePlayer(dt);
  nav.update(player.x, player.y, dt);
  updateZombies(dt);
  updateBullets(dt);
  updateGrenades(dt);
  updateParticles(dt);
  updatePickups(dt);
  updateRound(dt);
  updateInteract(dt);
  updateBox(dt);
  updateCamera(dt);
  updateVisualTimers(dt);
}

function updatePlayer(dt) {
  const p = player;
  const wm = screenToWorld(mouse.x, mouse.y);
  p.aim = angleTo(p.x, p.y, wm.x, wm.y);

  let mx = (keys.KeyD ? 1 : 0) - (keys.KeyA ? 1 : 0);
  let my = (keys.KeyS ? 1 : 0) - (keys.KeyW ? 1 : 0);
  const moving = !!(mx || my) && !p.downed;
  if (mx || my) {
    const im = 1 / Math.hypot(mx, my);
    mx *= im; my *= im;
  }
  p.moving = moving;
  p.sprinting = !!(keys.ShiftLeft || keys.ShiftRight) && moving;
  const spd = p.sprinting ? 330 : 210;
  if (moving) {
    p.x += mx * spd * dt;
    p.y += my * spd * dt;
  }
  for (const r of map.solidList) circleRectResolve(p, r);
  p.x = clamp(p.x, 22, map.w - 22);
  p.y = clamp(p.y, 22, map.h - 22);

  if (p.fireCd > 0) p.fireCd -= dt;
  if (p.kick > 0) p.kick = Math.max(0, p.kick - dt * 6);
  if (p.flash > 0) p.flash -= dt;
  if (p.knifeT > 0) p.knifeT -= dt;
  if (p.knifeCd > 0) p.knifeCd -= dt;
  if (p.swapT > 0) p.swapT -= dt;
  if (p.power.insta > 0) p.power.insta -= dt;
  if (p.power.double > 0) p.power.double -= dt;
  if (p.hurtT > 0) p.hurtT -= dt;

  updateReload(dt);

  if (mouse.down && !p.downed) tryFire();

  if (!p.downed) {
    p.regenT -= dt;
    if (p.regenT <= 0 && p.hp < p.maxHp) {
      const rate = p.perks.qr ? 22 : 12;
      p.hp = Math.min(p.maxHp, p.hp + rate * dt);
    }
  }
  if (p.downed) {
    p.downT -= dt;
    if (p.downT <= 0) revivePlayer();
  }
}

function updateVisualTimers(dt) {
  for (let i = game.banners.length - 1; i >= 0; i--) {
    const b = game.banners[i];
    b.t += dt;
    if (b.t > b.dur) game.banners.splice(i, 1);
  }
  for (let i = game.hitmarks.length - 1; i >= 0; i--) {
    const h = game.hitmarks[i];
    h.t -= dt;
    if (h.t <= 0) game.hitmarks.splice(i, 1);
  }
  for (let i = game.lights.length - 1; i >= 0; i--) {
    const l = game.lights[i];
    l.t -= dt;
    if (l.t <= 0) game.lights.splice(i, 1);
  }
  if (player.deny) {
    player.deny.t -= dt;
    if (player.deny.t <= 0) player.deny = null;
  }
  if (game.flashWhite > 0) game.flashWhite -= dt;
}

// ------------------------------------------------------------------ static world render
function makeFloorPattern() {
  const c = document.createElement('canvas');
  c.width = c.height = 96;
  const g = c.getContext('2d');
  g.fillStyle = '#232422';
  g.fillRect(0, 0, 96, 96);
  for (let i = 0; i < 700; i++) {
    const v = randInt(20, 52);
    g.fillStyle = `rgba(${v},${v},${v - 2},${rand(0.15, 0.4)})`;
    g.fillRect(rand(0, 96), rand(0, 96), rand(1, 3), rand(1, 3));
  }
  for (let i = 0; i < 6; i++) {
    g.fillStyle = `rgba(10,10,10,${rand(0.1, 0.2)})`;
    g.beginPath();
    g.ellipse(rand(0, 96), rand(0, 96), rand(4, 14), rand(3, 8), rand(0, TAU), 0, TAU);
    g.fill();
  }
  g.strokeStyle = 'rgba(0,0,0,0.4)';
  g.strokeRect(0.5, 0.5, 96, 96);
  return wctx.createPattern(c, 'repeat');
}

function buildWorld() {
  wctx.clearRect(0, 0, map.w, map.h);
  wctx.fillStyle = makeFloorPattern();
  wctx.fillRect(0, 0, map.w, map.h);
  const tints = { a: 'rgba(80,92,110,0.12)', b: 'rgba(110,84,60,0.12)', c: 'rgba(60,100,80,0.12)', d: 'rgba(104,64,58,0.12)' };
  for (const r of map.rooms) {
    wctx.fillStyle = tints[r.id];
    wctx.fillRect(r.x, r.y, r.w, r.h);
  }
  // wall shadows + bodies
  wctx.save();
  wctx.shadowColor = 'rgba(0,0,0,0.85)';
  wctx.shadowBlur = 16;
  wctx.shadowOffsetY = 7;
  wctx.fillStyle = '#26272c';
  for (const r of map.walls) wctx.fillRect(r.x, r.y, r.w, r.h);
  wctx.restore();
  // wall highlights
  for (const r of map.walls) {
    wctx.fillStyle = 'rgba(255,255,255,0.07)';
    wctx.fillRect(r.x, r.y, r.w, 3);
    wctx.fillRect(r.x, r.y, 3, r.h);
    wctx.fillStyle = 'rgba(0,0,0,0.25)';
    wctx.fillRect(r.x, r.y + r.h - 3, r.w, 3);
  }
  // room labels
  wctx.textAlign = 'center';
  wctx.textBaseline = 'middle';
  for (const r of map.rooms) {
    wctx.save();
    wctx.translate(r.x + r.w / 2, r.y + r.h / 2);
    wctx.rotate(-0.04);
    wctx.font = `bold 54px ${FONT}`;
    wctx.fillStyle = 'rgba(255,255,255,0.05)';
    wctx.fillText(r.name, 0, 0);
    wctx.restore();
  }
  // crates
  for (const c of map.crates) {
    wctx.fillStyle = '#3d2f22';
    wctx.fillRect(c.x, c.y, c.w, c.h);
    wctx.strokeStyle = 'rgba(0,0,0,0.5)';
    wctx.lineWidth = 2;
    wctx.strokeRect(c.x + 1, c.y + 1, c.w - 2, c.h - 2);
    wctx.strokeStyle = 'rgba(255,255,255,0.06)';
    wctx.beginPath();
    wctx.moveTo(c.x + 4, c.y + 4);
    wctx.lineTo(c.x + c.w - 4, c.y + c.h - 4);
    wctx.moveTo(c.x + c.w - 4, c.y + 4);
    wctx.lineTo(c.x + 4, c.y + c.h - 4);
    wctx.stroke();
    wctx.fillStyle = 'rgba(255,255,255,0.08)';
    wctx.fillRect(c.x, c.y, c.w, 3);
  }
  // windows: punch dark openings into the wall visuals
  for (const w of map.windows) {
    const r = w.rect;
    wctx.fillStyle = '#08090d';
    wctx.fillRect(r.x, r.y, r.w, r.h);
    wctx.strokeStyle = 'rgba(180,180,190,0.14)';
    wctx.lineWidth = 2;
    wctx.strokeRect(r.x + 1, r.y + 1, r.w - 2, r.h - 2);
  }
  // perk machines
  for (const p of map.perks) drawPerkMachineStatic(p);
  drawBoxStatic();
  drawPapStatic();
  // wall buys
  for (const b of map.buys) drawBuyStatic(b);
}

function drawPerkMachineStatic(p) {
  const r = p.rect;
  wctx.save();
  wctx.fillStyle = '#191a1f';
  wctx.fillRect(r.x, r.y, r.w, r.h);
  wctx.fillStyle = p.color;
  wctx.globalAlpha = 0.28;
  wctx.fillRect(r.x + 5, r.y + 8, r.w - 10, r.h - 16);
  wctx.globalAlpha = 1;
  wctx.strokeStyle = p.color;
  wctx.globalAlpha = 0.75;
  wctx.lineWidth = 2;
  wctx.strokeRect(r.x + 1, r.y + 1, r.w - 2, r.h - 2);
  wctx.globalAlpha = 1;
  // bottle
  wctx.fillStyle = p.color;
  wctx.beginPath();
  wctx.roundRect(r.x + r.w / 2 - 4, r.y + 12, 8, r.h - 28, 3);
  wctx.fill();
  wctx.fillStyle = 'rgba(255,255,255,0.5)';
  wctx.fillRect(r.x + r.w / 2 - 4, r.y + 12, 2, r.h - 28);
  wctx.font = `bold 10px ${MONO}`;
  wctx.textAlign = 'center';
  wctx.fillStyle = 'rgba(255,255,255,0.5)';
  wctx.fillText(p.name.toUpperCase(), r.x + r.w / 2, r.y - 6);
  wctx.restore();
}

function drawBoxStatic() {
  const b = map.box.rect;
  wctx.save();
  wctx.fillStyle = '#4a3a24';
  wctx.fillRect(b.x, b.y, b.w, b.h);
  wctx.strokeStyle = 'rgba(0,0,0,0.55)';
  wctx.lineWidth = 3;
  wctx.strokeRect(b.x + 1.5, b.y + 1.5, b.w - 3, b.h - 3);
  wctx.strokeStyle = 'rgba(255,255,255,0.07)';
  wctx.lineWidth = 2;
  for (let x = b.x + 14; x < b.x + b.w - 6; x += 16) {
    wctx.beginPath();
    wctx.moveTo(x, b.y + 4);
    wctx.lineTo(x, b.y + b.h - 4);
    wctx.stroke();
  }
  wctx.fillStyle = 'rgba(255,255,255,0.09)';
  wctx.fillRect(b.x, b.y, b.w, 3);
  wctx.restore();
}

function drawPapStatic() {
  const p = map.pap.rect;
  wctx.save();
  wctx.fillStyle = '#1b1c22';
  wctx.fillRect(p.x, p.y, p.w, p.h);
  wctx.strokeStyle = 'rgba(60,255,140,0.5)';
  wctx.lineWidth = 2;
  wctx.strokeRect(p.x + 1, p.y + 1, p.w - 2, p.h - 2);
  for (const side of [-1, 1]) {
    const cx = p.x + p.w / 2 + side * (p.w / 2 - 16);
    wctx.fillStyle = '#0e2a1c';
    wctx.beginPath();
    wctx.arc(cx, p.y + p.h / 2, 9, 0, TAU);
    wctx.fill();
    wctx.strokeStyle = 'rgba(60,255,140,0.7)';
    wctx.lineWidth = 2;
    wctx.stroke();
  }
  wctx.fillStyle = '#0b0c10';
  wctx.fillRect(p.x + p.w / 2 - 11, p.y + 8, 22, p.h - 16);
  wctx.font = `bold 9px ${MONO}`;
  wctx.textAlign = 'center';
  wctx.fillStyle = 'rgba(120,255,180,0.8)';
  wctx.fillText('PACK-A-PUNCH', p.x + p.w / 2, p.y - 8);
  wctx.restore();
}

function drawGunGlyph(g, cls, len) {
  // simple top-down gun silhouette pointing +x
  g.beginPath();
  switch (cls) {
    case 'pistol':
      g.rect(-2, -3, len * 0.6, 6);
      g.rect(-6, -1.5, 6, 3);
      g.rect(-2, 3, 5, 7);
      break;
    case 'smg':
      g.rect(-len / 2, -3.5, len, 7);
      g.rect(-2, 3, 7, 9);
      g.rect(-len / 2 + 2, -6.5, len * 0.4, 3);
      break;
    case 'shotgun':
      g.rect(-len / 2, -3, len, 6);
      g.rect(-len / 2 - 4, -4, 8, 8);
      break;
    case 'mg':
      g.rect(-len / 2, -4, len, 8);
      g.rect(-len / 2 + 6, -8, 16, 4);
      g.rect(-2, 4, 8, 8);
      break;
    default: // rifle
      g.rect(-len / 2, -3, len, 6);
      g.rect(-2, 3, 6, 8);
      g.rect(-len / 2 + 2, -5, len * 0.5, 2);
      break;
  }
}

function drawBuyStatic(b) {
  const def = WEAPONS[b.id];
  wctx.save();
  wctx.translate(b.x, b.y);
  wctx.rotate(b.angle);
  // plate
  wctx.fillStyle = 'rgba(20,20,24,0.85)';
  wctx.fillRect(-34, -14, 68, 28);
  wctx.strokeStyle = 'rgba(232,214,162,0.5)';
  wctx.lineWidth = 2;
  wctx.strokeRect(-33, -13, 66, 26);
  // chalk gun
  wctx.strokeStyle = 'rgba(232,214,162,0.9)';
  wctx.fillStyle = 'rgba(232,214,162,0.16)';
  wctx.lineWidth = 2;
  const len = def.cls === 'smg' ? 40 : def.cls === 'mg' ? 44 : def.cls === 'shotgun' ? 46 : 42;
  drawGunGlyph(wctx, def.cls, len);
  wctx.fill();
  wctx.stroke();
  wctx.restore();
  // price
  wctx.save();
  wctx.font = `bold 17px ${FONT}`;
  wctx.textAlign = 'center';
  wctx.textBaseline = 'middle';
  wctx.fillStyle = '#f5c542';
  wctx.strokeStyle = 'rgba(0,0,0,0.85)';
  wctx.lineWidth = 3;
  const py = b.angle === Math.PI / 2 ? b.y + 42 : b.angle === -Math.PI / 2 ? b.y - 42 : b.y + 34;
  const pxx = b.angle === 0 ? b.x + 47 : b.x;
  wctx.strokeText(String(def.cost), pxx, py);
  wctx.fillText(String(def.cost), pxx, py);
  wctx.restore();
}

// ------------------------------------------------------------------ dynamic world render
function drawWindows() {
  for (const w of map.windows) {
    if (w.boards <= 0) continue;
    const r = w.rect;
    const horiz = w.dir === 'n' || w.dir === 's';
    ctx.save();
    for (let i = 0; i < w.boards; i++) {
      const t = (i + 0.5) / 6;
      ctx.fillStyle = i % 2 ? '#6b4c2a' : '#75532e';
      if (horiz) ctx.fillRect(r.x + 2, r.y + t * r.h - 4, r.w - 4, 8);
      else ctx.fillRect(r.x + t * r.w - 4, r.y + 2, 8, r.h - 4);
      ctx.fillStyle = 'rgba(255,255,255,0.12)';
      if (horiz) ctx.fillRect(r.x + 2, r.y + t * r.h - 4, r.w - 4, 2);
      else ctx.fillRect(r.x + t * r.w - 4, r.y + 2, 2, r.h - 4);
    }
    // nails
    ctx.fillStyle = 'rgba(20,15,10,0.8)';
    for (let i = 0; i < 3; i++) {
      if (horiz) ctx.fillRect(r.x + 8 + i * (r.w / 3), r.y + r.h / 2 - 2, 3, 4);
      else ctx.fillRect(r.x + r.w / 2 - 2, r.y + 8 + i * (r.h / 3), 4, 3);
    }
    ctx.restore();
  }
}

function drawDoors() {
  for (const d of map.doors) {
    const r = d.rect;
    const horiz = r.w > r.h;
    ctx.save();
    if (!d.open) {
      ctx.fillStyle = '#4f3d26';
      ctx.fillRect(r.x - 3, r.y - 3, r.w + 6, r.h + 6);
      ctx.strokeStyle = 'rgba(0,0,0,0.6)';
      ctx.lineWidth = 3;
      ctx.strokeRect(r.x - 3, r.y - 3, r.w + 6, r.h + 6);
      ctx.strokeStyle = 'rgba(255,255,255,0.1)';
      ctx.lineWidth = 2;
      if (horiz) {
        for (let x = r.x + 10; x < r.x + r.w - 6; x += 18) {
          ctx.beginPath(); ctx.moveTo(x, r.y - 1); ctx.lineTo(x, r.y + r.h + 1); ctx.stroke();
        }
        ctx.fillStyle = '#c9c9cf';
        ctx.fillRect(r.x + r.w / 2 - 8, r.y + r.h - 6, 16, 3);
      } else {
        for (let y = r.y + 10; y < r.y + r.h - 6; y += 18) {
          ctx.beginPath(); ctx.moveTo(r.x - 1, y); ctx.lineTo(r.x + r.w + 1, y); ctx.stroke();
        }
        ctx.fillStyle = '#c9c9cf';
        ctx.fillRect(r.x + r.w - 6, r.y + r.h / 2 - 8, 3, 16);
      }
    } else {
      // opening floor reveal + hinge marks
      ctx.fillStyle = 'rgba(255,255,255,0.04)';
      ctx.fillRect(r.x, r.y, r.w, r.h);
      ctx.fillStyle = 'rgba(0,0,0,0.35)';
      if (horiz) ctx.fillRect(r.x, r.y - 3, r.w, 3);
      else ctx.fillRect(r.x - 3, r.y, 3, r.h);
    }
    ctx.restore();
    if (!d.open) {
      text(String(d.cost), r.x + r.w / 2, r.y + r.h / 2 + 1, {
        font: `bold 15px ${FONT}`, fill: '#f5c542', align: 'center', baseline: 'middle',
      });
    }
  }
}

function drawBoxDynamic() {
  // the crate itself is static; the "?" (or spinning name) is drawn in renderGlows so it
  // stays visible through the darkness like a beacon.
}

function drawInteractHighlight() {
  const t = player.hold.target;
  if (!t || game.state !== 'playing') return;
  const pulse = 0.55 + Math.sin(game.time * 7) * 0.3;
  ctx.save();
  ctx.strokeStyle = `rgba(245,197,66,${pulse})`;
  ctx.lineWidth = 2.5;
  if (t.type === 'door' || t.type === 'buy') {
    const r = t.type === 'door' ? t.ref.rect : { x: t.ref.x - 34, y: t.ref.y - 14, w: 68, h: 28 };
    ctx.strokeRect(r.x - 4, r.y - 4, r.w + 8, r.h + 8);
  } else if (t.type === 'perk') {
    const r = t.ref.rect;
    ctx.strokeRect(r.x - 4, r.y - 4, r.w + 8, r.h + 8);
  } else if (t.type === 'box' || t.type === 'pap') {
    const r = t.ref.rect;
    ctx.strokeRect(r.x - 4, r.y - 4, r.w + 8, r.h + 8);
  } else if (t.type === 'window') {
    const r = t.ref.rect;
    ctx.strokeRect(r.x - 4, r.y - 4, r.w + 8, r.h + 8);
  }
  ctx.restore();
}

function drawZombies() {
  const zs = [...zombies].sort((a, b) => a.y - b.y);
  for (const z of zs) {
    ctx.save();
    const dying = z.state === 'dead';
    if (dying) {
      const t = clamp(z.dieT / 0.7, 0, 1);
      ctx.globalAlpha = 1 - t * 0.85;
      ctx.translate(z.x, z.y);
      ctx.rotate(t * 1.2);
      ctx.translate(-z.x, -z.y);
    }
    // shadow
    ctx.fillStyle = 'rgba(0,0,0,0.35)';
    ctx.beginPath();
    ctx.ellipse(z.x + 2, z.y + 5, z.r, z.r * 0.6, 0, 0, TAU);
    ctx.fill();
    const skin = z.sprinter ? '#8a675f' : '#7f8a67';
    const clothes = z.sprinter ? '#5a3a38' : '#41473c';
    ctx.translate(z.x, z.y);
    ctx.rotate(z.face);
    // arms
    const armSpread = z.state === 'attack' ? 2.1 : 1.1;
    ctx.fillStyle = skin;
    for (const s of [-1, 1]) {
      const ax = Math.cos(s * armSpread * 0.5) * 10;
      const ay = Math.sin(s * armSpread * 0.5) * 13;
      ctx.beginPath();
      ctx.arc(ax + 4, ay, 4.2, 0, TAU);
      ctx.fill();
    }
    // body
    ctx.fillStyle = clothes;
    ctx.beginPath();
    ctx.arc(0, 0, z.r, 0, TAU);
    ctx.fill();
    ctx.strokeStyle = 'rgba(0,0,0,0.5)';
    ctx.lineWidth = 2;
    ctx.stroke();
    // blood on body
    ctx.fillStyle = 'rgba(120,20,20,0.55)';
    ctx.beginPath();
    ctx.arc(-3, 4, 4, 0, TAU);
    ctx.arc(5, -5, 3, 0, TAU);
    ctx.fill();
    // head
    const hx = 8, hy = 0;
    ctx.fillStyle = skin;
    ctx.beginPath();
    ctx.arc(hx, hy, 7, 0, TAU);
    ctx.fill();
    ctx.strokeStyle = 'rgba(0,0,0,0.4)';
    ctx.lineWidth = 1.5;
    ctx.stroke();
    // jaw blood
    ctx.fillStyle = 'rgba(100,10,12,0.7)';
    ctx.beginPath();
    ctx.arc(hx + 3, 2, 2.4, 0, TAU);
    ctx.fill();
    // hit flash
    if (z.flash > 0) {
      ctx.fillStyle = `rgba(255,120,110,${clamp(z.flash * 8, 0, 0.8)})`;
      ctx.beginPath();
      ctx.arc(0, 0, z.r + 2, 0, TAU);
      ctx.arc(hx, hy, 8, 0, TAU);
      ctx.fill();
    }
    ctx.restore();
  }
}

function drawPlayer() {
  const p = player;
  ctx.save();
  // shadow
  ctx.fillStyle = 'rgba(0,0,0,0.4)';
  ctx.beginPath();
  ctx.ellipse(p.x + 2, p.y + 5, p.r, p.r * 0.6, 0, 0, TAU);
  ctx.fill();

  if (p.downed) {
    ctx.save();
    ctx.translate(p.x, p.y);
    ctx.rotate(Math.PI / 2.4);
    ctx.fillStyle = '#4a5240';
    ctx.beginPath(); ctx.arc(0, 0, p.r, 0, TAU); ctx.fill();
    ctx.fillStyle = '#8a7566';
    ctx.beginPath(); ctx.arc(6, 0, 6.5, 0, TAU); ctx.fill();
    ctx.restore();
    ctx.restore();
    return;
  }

  ctx.translate(p.x, p.y);
  // blood ring on floor when hurt
  if (p.hp < p.maxHp * 0.4) {
    ctx.fillStyle = 'rgba(120,10,10,0.25)';
    ctx.beginPath(); ctx.arc(0, 6, p.r + 4, 0, TAU); ctx.fill();
  }
  ctx.rotate(p.aim);
  // gun
  const w = curWeapon();
  const st = w ? statsOf(w) : null;
  const reloading = !!p.reload;
  const kick = p.kick * 3;
  const gunLen = st ? (st.cls === 'shotgun' ? 26 : st.cls === 'mg' ? 28 : st.cls === 'ray' || st.cls === 'thunder' ? 24 : 22) : 20;
  ctx.save();
  ctx.translate(-kick, 0);
  if (reloading) { ctx.rotate(0.5); ctx.translate(-4, 2); }
  if (p.swapT > 0) ctx.translate(-4, 0);
  ctx.fillStyle = '#26262b';
  ctx.fillRect(4, -2.5, gunLen, 5);
  ctx.fillStyle = st && st.pap ? '#8a6a1e' : '#3a3a41';
  ctx.fillRect(4, -2.5, gunLen, 2);
  ctx.fillStyle = '#191a1f';
  ctx.fillRect(2, -4, 6, 8);
  ctx.restore();
  // body
  ctx.fillStyle = '#4a5240';
  ctx.beginPath(); ctx.arc(0, 0, p.r, 0, TAU); ctx.fill();
  ctx.strokeStyle = 'rgba(0,0,0,0.55)';
  ctx.lineWidth = 2;
  ctx.stroke();
  // vest
  ctx.fillStyle = '#3c4436';
  ctx.beginPath(); ctx.arc(-2, 0, p.r - 4, 0, TAU); ctx.fill();
  // arms
  ctx.fillStyle = '#7d7568';
  ctx.beginPath(); ctx.arc(9, -7, 3.6, 0, TAU); ctx.arc(9, 7, 3.6, 0, TAU); ctx.fill();
  // head + helmet
  ctx.fillStyle = '#8a7566';
  ctx.beginPath(); ctx.arc(2, 0, 7, 0, TAU); ctx.fill();
  ctx.fillStyle = '#3a4034';
  ctx.beginPath(); ctx.arc(0.5, 0, 6.4, 0, TAU); ctx.fill();
  // muzzle flash
  if (p.flash > 0 && !reloading) {
    ctx.save();
    const fa = clamp(p.flash / 0.05, 0, 1);
    ctx.translate(gunLen + 6, 0);
    ctx.fillStyle = `rgba(255,220,120,${0.9 * fa})`;
    ctx.beginPath();
    ctx.moveTo(0, 0);
    for (let i = 0; i < 6; i++) {
      const a = (i / 6) * TAU + rand(-0.2, 0.2);
      const r = i % 2 === 0 ? 11 : 4;
      ctx.lineTo(Math.cos(a) * r, Math.sin(a) * r);
    }
    ctx.closePath();
    ctx.fill();
    ctx.fillStyle = `rgba(255,255,220,${0.9 * fa})`;
    ctx.beginPath(); ctx.arc(0, 0, 4, 0, TAU); ctx.fill();
    ctx.restore();
  }
  ctx.restore();

  // knife slash
  if (p.knifeT > 0) {
    ctx.save();
    ctx.translate(p.x, p.y);
    const t = 1 - p.knifeT / 0.18;
    ctx.strokeStyle = `rgba(255,255,255,${0.7 * (1 - t)})`;
    ctx.lineWidth = 4;
    ctx.beginPath();
    ctx.arc(0, 0, 30, p.aim - 0.9 + t * 1.4, p.aim - 0.2 + t * 1.4);
    ctx.stroke();
    ctx.restore();
  }
}

function drawBulletsAndExplosives() {
  for (const b of bullets) {
    if (b.splash && b.cls === 'rocket') {
      ctx.fillStyle = '#ffb45a';
      ctx.beginPath();
      ctx.arc(b.x, b.y, 5, 0, TAU);
      ctx.fill();
    } else if (b.splash) {
      ctx.save();
      const g = ctx.createRadialGradient(b.x, b.y, 0, b.x, b.y, 12);
      g.addColorStop(0, 'rgba(140,255,140,0.95)');
      g.addColorStop(1, 'rgba(60,200,80,0)');
      ctx.fillStyle = g;
      ctx.beginPath(); ctx.arc(b.x, b.y, 12, 0, TAU); ctx.fill();
      ctx.fillStyle = '#eaffea';
      ctx.beginPath(); ctx.arc(b.x, b.y, 3, 0, TAU); ctx.fill();
      ctx.restore();
    } else {
      ctx.strokeStyle = 'rgba(255,230,150,0.85)';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(b.x - b.vx * 0.025, b.y - b.vy * 0.025);
      ctx.lineTo(b.x, b.y);
      ctx.stroke();
    }
  }
  for (const g of grenades) {
    ctx.save();
    ctx.translate(g.x, g.y);
    ctx.rotate(g.rot);
    ctx.fillStyle = '#3c4a2e';
    ctx.beginPath(); ctx.arc(0, 0, 5, 0, TAU); ctx.fill();
    ctx.strokeStyle = 'rgba(0,0,0,0.5)';
    ctx.stroke();
    ctx.fillStyle = g.fuse < 0.5 && Math.sin(game.time * 40) > 0 ? '#ff4040' : '#666';
    ctx.fillRect(-1.5, -7, 3, 3);
    ctx.restore();
  }
}

function drawParticles() {
  for (const p of parts) {
    const a = clamp(p.life / p.max, 0, 1);
    ctx.save();
    switch (p.type) {
      case 'blood':
        ctx.fillStyle = p.color;
        ctx.globalAlpha = a;
        ctx.beginPath(); ctx.arc(p.x, p.y, p.size, 0, TAU); ctx.fill();
        break;
      case 'spark':
        ctx.strokeStyle = p.color;
        ctx.globalAlpha = a;
        ctx.lineWidth = p.size;
        ctx.beginPath();
        ctx.moveTo(p.x, p.y);
        ctx.lineTo(p.x - p.vx * 0.02, p.y - p.vy * 0.02);
        ctx.stroke();
        break;
      case 'smoke':
        ctx.fillStyle = p.color;
        ctx.globalAlpha = a * 0.4;
        ctx.beginPath(); ctx.arc(p.x, p.y, p.size, 0, TAU); ctx.fill();
        break;
      case 'fire':
        ctx.fillStyle = p.color;
        ctx.globalAlpha = a * 0.85;
        ctx.beginPath(); ctx.arc(p.x, p.y, p.size * (0.4 + a * 0.6), 0, TAU); ctx.fill();
        break;
      case 'shell':
        ctx.fillStyle = p.color;
        ctx.globalAlpha = a;
        ctx.translate(p.x, p.y);
        ctx.rotate(p.rot);
        ctx.fillRect(-2, -1, 4, 2);
        break;
      case 'wood':
        ctx.fillStyle = p.color;
        ctx.globalAlpha = a;
        ctx.translate(p.x, p.y);
        ctx.rotate(p.rot);
        ctx.fillRect(-p.size / 2, -1.5, p.size, 3);
        break;
      case 'ring': {
        const t = 1 - p.life / p.max;
        const r = lerp(p.r, p.rMax, easeOut(t));
        ctx.strokeStyle = p.color;
        ctx.globalAlpha = a * 0.8;
        ctx.lineWidth = 3 * (1 - t) + 1;
        ctx.beginPath(); ctx.arc(p.x, p.y, r, 0, TAU); ctx.stroke();
        break;
      }
    }
    ctx.restore();
  }
}

function drawPickupsWorld() {
  for (const p of pickups) {
    const def = POWERUPS[p.type];
    const bob = Math.sin(p.t * 3) * 3;
    ctx.save();
    const blink = p.t > p.life - 6 && Math.sin(p.t * 14) > 0;
    ctx.globalAlpha = blink ? 0.3 : 1;
    ctx.translate(p.x, p.y + bob);
    const g = ctx.createRadialGradient(0, 0, 0, 0, 0, 26);
    g.addColorStop(0, def.color + 'cc');
    g.addColorStop(1, def.color + '00');
    ctx.fillStyle = g;
    ctx.beginPath(); ctx.arc(0, 0, 26, 0, TAU); ctx.fill();
    ctx.fillStyle = 'rgba(10,10,12,0.85)';
    ctx.beginPath(); ctx.arc(0, 0, 13, 0, TAU); ctx.fill();
    ctx.strokeStyle = def.color;
    ctx.lineWidth = 2;
    ctx.beginPath(); ctx.arc(0, 0, 13, 0, TAU); ctx.stroke();
    ctx.font = `bold 15px ${FONT}`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = def.color;
    ctx.fillText(def.letter, 0, 1);
    ctx.restore();
  }
}

// ------------------------------------------------------------------ darkness + glows
function punch(ctx2, sx, sy, r, a) {
  const g = ctx2.createRadialGradient(sx, sy, 0, sx, sy, r);
  g.addColorStop(0, `rgba(0,0,0,${a})`);
  g.addColorStop(1, 'rgba(0,0,0,0)');
  ctx2.fillStyle = g;
  ctx2.beginPath();
  ctx2.arc(sx, sy, r, 0, TAU);
  ctx2.fill();
}

function w2s(wx, wy) {
  return {
    x: (wx - cam.drawX) * cam.zoom + W / 2,
    y: (wy - cam.drawY) * cam.zoom + H / 2,
  };
}

function renderDarkness() {
  const d = darkCtx;
  d.setTransform(DPR, 0, 0, DPR, 0, 0);
  d.clearRect(0, 0, W, H);
  d.fillStyle = 'rgba(3,4,8,0.84)';
  d.fillRect(0, 0, W, H);
  d.globalCompositeOperation = 'destination-out';

  const p = w2s(player.x, player.y);
  punch(d, p.x, p.y, 260 * cam.zoom, 0.9);

  // aim cone
  const reach = 430 * cam.zoom;
  d.save();
  d.beginPath();
  d.moveTo(p.x, p.y);
  d.arc(p.x, p.y, reach, player.aim - 0.5, player.aim + 0.5);
  d.closePath();
  d.clip();
  punch(d, p.x + Math.cos(player.aim) * 90 * cam.zoom, p.y + Math.sin(player.aim) * 90 * cam.zoom, reach, 0.85);
  d.restore();

  // muzzle flash light
  if (player.flash > 0) {
    const m = w2s(player.x + Math.cos(player.aim) * 30, player.y + Math.sin(player.aim) * 30);
    punch(d, m.x, m.y, 190 * cam.zoom, 0.7);
  }
  // machines / box / pap glow
  for (const pk of map.perks) {
    const s = w2s(pk.x, pk.y);
    punch(d, s.x, s.y, 90 * cam.zoom, 0.4);
  }
  const b = w2s(map.box.x, map.box.y);
  punch(d, b.x, b.y, 95 * cam.zoom, 0.42);
  const pp = w2s(map.pap.x, map.pap.y);
  punch(d, pp.x, pp.y, 105 * cam.zoom, 0.45);
  for (const pw of pickups) {
    const s = w2s(pw.x, pw.y);
    punch(d, s.x, s.y, 120 * cam.zoom, 0.55);
  }
  for (const l of game.lights) {
    const s = w2s(l.x, l.y);
    const a = (l.t / l.max) * l.a;
    punch(d, s.x, s.y, l.r * cam.zoom, a);
  }
  d.globalCompositeOperation = 'source-over';
  ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
  ctx.drawImage(darkCanvas, 0, 0, W, H);
}

function renderGlows() {
  // zombie eyes glow through the dark
  for (const z of zombies) {
    if (z.state === 'dead') continue;
    const hx = z.x + Math.cos(z.face) * 8;
    const hy = z.y + Math.sin(z.face) * 8;
    for (const s of [-1, 1]) {
      const ex = hx + Math.cos(z.face + s * 0.42) * 5;
      const ey = hy + Math.sin(z.face + s * 0.42) * 5;
      const p2 = w2s(ex, ey);
      if (p2.x < -20 || p2.x > W + 20 || p2.y < -20 || p2.y > H + 20) continue;
      const g = ctx.createRadialGradient(p2.x, p2.y, 0, p2.x, p2.y, 7);
      g.addColorStop(0, 'rgba(255,60,50,0.95)');
      g.addColorStop(1, 'rgba(255,40,30,0)');
      ctx.fillStyle = g;
      ctx.beginPath(); ctx.arc(p2.x, p2.y, 7, 0, TAU); ctx.fill();
    }
  }
  // powerup letters glow
  for (const pw of pickups) {
    const def = POWERUPS[pw.type];
    const p2 = w2s(pw.x, pw.y - 34 + Math.sin(pw.t * 3) * 3);
    if (p2.x < -40 || p2.x > W + 40 || p2.y < -40 || p2.y > H + 40) continue;
    ctx.save();
    ctx.font = `bold 22px ${FONT}`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.shadowColor = def.color;
    ctx.shadowBlur = 14;
    ctx.fillStyle = def.color;
    ctx.fillText(def.letter, p2.x, p2.y);
    ctx.restore();
  }
  // box question mark glow (or spinning weapon name)
  const bp = w2s(map.box.x, map.box.y - 34 + Math.sin(game.time * 2.4) * 3);
  ctx.save();
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.shadowColor = '#f5c542';
  ctx.shadowBlur = 16;
  if (game.box.state === 'spin') {
    ctx.font = `bold 22px ${FONT}`;
    ctx.fillStyle = '#fff2b0';
    ctx.fillText(BOX_NAMES[game.box.cycleIdx % BOX_NAMES.length], bp.x, bp.y);
  } else {
    ctx.font = `bold 34px ${FONT}`;
    const pulse = 0.75 + Math.sin(game.time * 5) * 0.25;
    ctx.fillStyle = `rgba(245,197,66,${pulse})`;
    ctx.fillText('?', bp.x, bp.y);
  }
  ctx.restore();
}

// ------------------------------------------------------------------ HUD
function text(str, x, y, { font = `bold 20px ${FONT}`, fill = '#fff', align = 'left', baseline = 'alphabetic', stroke = 'rgba(0,0,0,0.85)', strokeW = 4, alpha = 1, shadow = null, blur = 0 } = {}) {
  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.font = font;
  ctx.textAlign = align;
  ctx.textBaseline = baseline;
  if (shadow) { ctx.shadowColor = shadow; ctx.shadowBlur = blur || 12; }
  if (stroke) { ctx.strokeStyle = stroke; ctx.lineWidth = strokeW; ctx.strokeText(str, x, y); }
  ctx.fillStyle = fill;
  ctx.fillText(str, x, y);
  ctx.restore();
}

function perkIcon(id, x, y, owned) {
  const colors = { qr: '#4fd08a', jugg: '#e0453e', speed: '#f2d23c', dt: '#e07b31' };
  const c = colors[id];
  ctx.save();
  ctx.beginPath();
  ctx.arc(x, y, 14, 0, TAU);
  ctx.fillStyle = owned ? 'rgba(15,16,20,0.9)' : 'rgba(15,16,20,0.5)';
  ctx.fill();
  ctx.strokeStyle = owned ? c : 'rgba(120,120,130,0.35)';
  ctx.lineWidth = 2;
  ctx.stroke();
  ctx.strokeStyle = owned ? c : 'rgba(120,120,130,0.4)';
  ctx.fillStyle = owned ? c : 'rgba(120,120,130,0.4)';
  ctx.lineWidth = 2.2;
  switch (id) {
    case 'qr': // cross
      ctx.fillRect(x - 2, y - 7, 4, 14);
      ctx.fillRect(x - 7, y - 2, 14, 4);
      break;
    case 'jugg': // shield
      ctx.beginPath();
      ctx.moveTo(x, y - 7);
      ctx.lineTo(x + 7, y - 3);
      ctx.lineTo(x + 5, y + 6);
      ctx.lineTo(x, y + 8);
      ctx.lineTo(x - 5, y + 6);
      ctx.lineTo(x - 7, y - 3);
      ctx.closePath();
      ctx.stroke();
      break;
    case 'speed': // lightning
      ctx.beginPath();
      ctx.moveTo(x + 2, y - 8);
      ctx.lineTo(x - 5, y + 1);
      ctx.lineTo(x - 1, y + 1);
      ctx.lineTo(x - 2, y + 8);
      ctx.lineTo(x + 5, y - 1);
      ctx.lineTo(x + 1, y - 1);
      ctx.closePath();
      ctx.fill();
      break;
    case 'dt': // double chevron
      ctx.beginPath();
      ctx.moveTo(x - 6, y - 4); ctx.lineTo(x - 1, y); ctx.lineTo(x - 6, y + 4);
      ctx.moveTo(x + 1, y - 4); ctx.lineTo(x + 6, y); ctx.lineTo(x + 1, y + 4);
      ctx.stroke();
      break;
  }
  ctx.restore();
}

function drawHUD() {
  const p = player;

  // damage vignette
  const hurtLevel = clamp(1 - p.hp / p.maxHp, 0, 1);
  const pulse = 0.5 + Math.sin(game.time * 5) * 0.5;
  const vivid = Math.max(p.hurtT * 1.2, hurtLevel * 0.85 * pulse + 0.15 * hurtLevel);
  if (vivid > 0.02) {
    const g = ctx.createRadialGradient(W / 2, H / 2, Math.min(W, H) * 0.25, W / 2, H / 2, Math.max(W, H) * 0.72);
    g.addColorStop(0, 'rgba(120,0,0,0)');
    g.addColorStop(1, `rgba(140,0,0,${clamp(vivid, 0, 0.75)})`);
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, W, H);
  }
  if (game.flashWhite > 0) {
    ctx.fillStyle = `rgba(255,255,255,${clamp(game.flashWhite, 0, 0.8)})`;
    ctx.fillRect(0, 0, W, H);
  }

  // points
  text(String(Math.floor(p.points)), 30, H - 26, { font: `bold 44px ${FONT}`, fill: '#f5c542', shadow: '#a8781e', blur: 16 });

  // perks row
  const perkIds = ['qr', 'jugg', 'speed', 'dt'];
  perkIds.forEach((id, i) => perkIcon(id, 44 + i * 38, H - 104, p.perks[id]));

  // grenades
  ctx.save();
  ctx.translate(40, H - 152);
  ctx.fillStyle = 'rgba(15,16,20,0.8)';
  ctx.beginPath(); ctx.arc(0, 0, 11, 0, TAU); ctx.fill();
  ctx.strokeStyle = '#6a7a4a';
  ctx.lineWidth = 2;
  ctx.stroke();
  ctx.fillStyle = '#8a9a5a';
  ctx.beginPath(); ctx.arc(0, 0, 5, 0, TAU); ctx.fill();
  ctx.restore();
  text('×' + p.grenades, 56, H - 146, { font: `bold 18px ${FONT}`, fill: '#cfcabc' });

  // crosshair
  const spread = 7 + p.kick * 15 + (p.moving ? 2 : 0) + (p.sprinting ? 9 : 0);
  const cx = mouse.x, cy = mouse.y;
  ctx.save();
  ctx.strokeStyle = 'rgba(255,255,255,0.85)';
  ctx.lineWidth = 2;
  const L = 9;
  ctx.beginPath();
  ctx.moveTo(cx, cy - spread - L); ctx.lineTo(cx, cy - spread);
  ctx.moveTo(cx, cy + spread); ctx.lineTo(cx, cy + spread + L);
  ctx.moveTo(cx - spread - L, cy); ctx.lineTo(cx - spread, cy);
  ctx.moveTo(cx + spread, cy); ctx.lineTo(cx + spread + L, cy);
  ctx.stroke();
  ctx.fillStyle = 'rgba(255,255,255,0.9)';
  ctx.fillRect(cx - 1, cy - 1, 2, 2);
  // reload ring
  if (p.reload) {
    const t = 1 - p.reload.t / p.reload.total;
    ctx.strokeStyle = 'rgba(245,197,66,0.9)';
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.arc(cx, cy, 20, -Math.PI / 2, -Math.PI / 2 + t * TAU);
    ctx.stroke();
  }
  ctx.restore();

  // hit markers
  for (const h of game.hitmarks) {
    const a = h.t / h.max;
    ctx.save();
    ctx.strokeStyle = h.color;
    ctx.globalAlpha = a;
    ctx.lineWidth = 2.5;
    const r1 = 7, r2 = 13;
    ctx.beginPath();
    for (const [sx, sy] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) {
      ctx.moveTo(cx + sx * r1, cy + sy * r1);
      ctx.lineTo(cx + sx * r2, cy + sy * r2);
    }
    ctx.stroke();
    ctx.restore();
  }

  // right column: ammo + round
  const w = curWeapon();
  if (w) {
    const st = statsOf(w);
    text(st.name.toUpperCase(), W - 30, H - 88, { font: `bold 20px ${MONO}`, fill: w.pap ? '#f5c542' : '#cfcabc', align: 'right' });
    const low = w.ammo <= st.mag * 0.25;
    const ammoStr = String(w.ammo);
    text(ammoStr, W - 30, H - 30, { font: `bold 48px ${FONT}`, fill: low ? '#e0453e' : '#fff', align: 'right' });
    ctx.save();
    ctx.font = `bold 48px ${FONT}`;
    const ammoW = ctx.measureText(ammoStr).width;
    ctx.restore();
    text('/ ' + w.reserve, W - 30 - ammoW - 14, H - 34, { font: `bold 26px ${FONT}`, fill: '#8f948c', align: 'right' });
  }
  const alive = zombies.reduce((n, z) => n + (z.state !== 'dead' ? 1 : 0), 0);
  const left = alive + Math.max(0, game.toSpawn - game.spawnedThisRound);
  text('ZOMBIES LEFT: ' + left, W - 30, H - 116, { font: `bold 14px ${MONO}`, fill: '#8b8f96', align: 'right' });
  text('ROUND ' + Math.max(1, game.round), W - 30, H - 148, { font: `bold 34px ${FONT}`, fill: '#d8d2c4', align: 'right', shadow: '#7a1a10', blur: 18 });

  // powerup timers
  let pux = W / 2 - 100;
  for (const [id, t] of [['instakill', p.power.insta], ['double', p.power.double]]) {
    if (t <= 0) continue;
    const def = POWERUPS[id];
    text(def.letter + ' ' + def.label, pux, 34, { font: `bold 16px ${FONT}`, fill: def.color, align: 'left' });
    ctx.fillStyle = 'rgba(255,255,255,0.2)';
    ctx.fillRect(pux, 42, 130, 4);
    ctx.fillStyle = def.color;
    ctx.fillRect(pux, 42, 130 * (t / def.dur), 4);
    pux += 170;
  }

  // banners
  for (const b of game.banners) {
    const a = clamp(Math.min(b.t / 0.15, (b.dur - b.t) / 0.5), 0, 1);
    const scale = 1 + (1 - clamp(b.t / 0.2, 0, 1)) * 0.25;
    ctx.save();
    ctx.translate(W / 2, H * 0.3);
    ctx.scale(scale, scale);
    ctx.globalAlpha = a;
    ctx.font = `bold ${b.size}px ${FONT}`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.strokeStyle = 'rgba(0,0,0,0.9)';
    ctx.lineWidth = 8;
    ctx.strokeText(b.text, 0, 0);
    ctx.shadowColor = b.color;
    ctx.shadowBlur = 26;
    ctx.fillStyle = b.color;
    ctx.fillText(b.text, 0, 0);
    if (b.sub) {
      ctx.shadowBlur = 12;
      ctx.font = `bold 20px ${MONO}`;
      ctx.fillStyle = '#d8d2c4';
      ctx.strokeText(b.sub, 0, b.size * 0.75);
      ctx.fillText(b.sub, 0, b.size * 0.75);
    }
    ctx.restore();
  }

  // interact prompt
  const tgt = p.hold.target;
  if (tgt && !p.downed) {
    const affordable = !tgt.cost || p.points >= tgt.cost;
    const y = H - 190;
    ctx.save();
    ctx.translate(W / 2, y);
    const pulseA = affordable ? 0.85 + Math.sin(game.time * 6) * 0.15 : 1;
    ctx.globalAlpha = pulseA;
    ctx.beginPath();
    ctx.arc(-110, 0, 17, 0, TAU);
    ctx.fillStyle = 'rgba(15,16,20,0.85)';
    ctx.fill();
    ctx.strokeStyle = affordable ? 'rgba(245,197,66,0.9)' : 'rgba(200,60,50,0.9)';
    ctx.lineWidth = 2;
    ctx.stroke();
    ctx.font = `bold 18px ${FONT}`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = affordable ? '#f5c542' : '#c83c32';
    ctx.fillText('F', -110, 1);
    const label = tgt.label + (tgt.cost ? '  ·  ' + tgt.cost : '');
    text(label, -84, 1, {
      font: `bold 21px ${FONT}`,
      fill: affordable ? '#fff' : '#c83c32',
      baseline: 'middle',
    });
    if (tgt.hold > 0 && p.hold.t > 0) {
      ctx.beginPath();
      ctx.arc(-110, 0, 24, -Math.PI / 2, -Math.PI / 2 + (p.hold.t / tgt.hold) * TAU);
      ctx.strokeStyle = '#f5c542';
      ctx.lineWidth = 4;
      ctx.stroke();
    }
    ctx.restore();
  }
  if (p.deny) {
    text(p.deny.text, W / 2, H - 240, {
      font: `bold 24px ${FONT}`, fill: '#e0453e', align: 'center',
      alpha: clamp(p.deny.t / 0.4, 0, 1),
    });
  }

  // downed overlay
  if (p.downed) {
    ctx.fillStyle = 'rgba(90,0,0,0.35)';
    ctx.fillRect(0, 0, W, H);
    text('DOWNED', W / 2, H * 0.42, { font: `bold 72px ${FONT}`, fill: '#e0453e', align: 'center', baseline: 'middle' });
    text('REVIVING IN ' + Math.ceil(p.downT) + '…', W / 2, H * 0.5, { font: `bold 22px ${MONO}`, fill: '#d8d2c4', align: 'center', baseline: 'middle' });
  }

  if (audio.muted) {
    text('MUTED (M)', 30, 34, { font: `bold 13px ${MONO}`, fill: '#8b8f96' });
  }
}

// ------------------------------------------------------------------ render
function render() {
  ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
  ctx.fillStyle = '#050508';
  ctx.fillRect(0, 0, W, H);

  ctx.save();
  ctx.translate(W / 2, H / 2);
  ctx.scale(cam.zoom, cam.zoom);
  ctx.translate(-cam.drawX, -cam.drawY);

  ctx.drawImage(worldCanvas, 0, 0);
  ctx.drawImage(decalCanvas, 0, 0);
  drawWindows();
  drawDoors();
  drawBoxDynamic();
  drawInteractHighlight();
  drawPickupsWorld();
  drawParticles();
  drawZombies();
  drawPlayer();
  drawBulletsAndExplosives();

  ctx.restore();

  renderDarkness();
  renderGlows();
  if (game.state === 'playing' || game.state === 'paused') drawHUD();
}

// ------------------------------------------------------------------ main loop
let last = performance.now();
function frame(t) {
  requestAnimationFrame(frame);
  const dt = Math.min(0.05, (t - last) / 1000);
  last = t;
  if (game.state === 'playing') {
    update(dt);
  } else {
    game.time += dt * 0.4;
    updateVisualTimers(dt);
    updateCameraIdle(dt);
  }
  render();
}

function updateCameraIdle(dt) {
  if (game.state === 'title') {
    cam.zoom = clamp(Math.min(W / 1250, H / 750), 0.75, 1.7);
    const viewW = W / cam.zoom, viewH = H / cam.zoom;
    if (map.w <= viewW) cam.x = map.w / 2; else cam.x = clamp(cam.x, viewW / 2, map.w - viewW / 2);
    if (map.h <= viewH) cam.y = map.h / 2; else cam.y = clamp(cam.y, viewH / 2, map.h - viewH / 2);
    cam.drawX = cam.x;
    cam.drawY = cam.y;
  }
}

buildWorld();
cam.x = player.x;
cam.y = player.y;
showScreen('title');
requestAnimationFrame(frame);

// dev handle (safe: read/write game state from the browser console for debugging)
window.__zombiesDebug = {
  game, map, nav,
  get player() { return player; },
  get zombies() { return zombies; },
  get pickups() { return pickups; },
  startRound, spawnZombie, spawnPickup, explode, addPoints, hurtPlayer, grantWeapon,
};
