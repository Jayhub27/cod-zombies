// ZOMBIES 3D — first-person round-based zombie survival, built on three.js.
// Reuses the map / navigation / weapon / audio data modules from the 2D build.
// World units: 100 units = 1 metre. Map coords (x, mapY) live on the ground plane,
// where mapY is the three.js Z axis.

import * as THREE from './vendor/three.module.js';
import { EffectComposer } from './vendor/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from './vendor/jsm/postprocessing/RenderPass.js';
import { ShaderPass } from './vendor/jsm/postprocessing/ShaderPass.js';
import { UnrealBloomPass } from './vendor/jsm/postprocessing/UnrealBloomPass.js';
import { OutputPass } from './vendor/jsm/postprocessing/OutputPass.js';
import { SSAOPass } from './vendor/jsm/postprocessing/SSAOPass.js';
import { FXAAShader } from './vendor/jsm/shaders/FXAAShader.js';
import { RoomEnvironment } from './vendor/jsm/environments/RoomEnvironment.js';
import {
  TAU, clamp, lerp, rand, randInt, choice, chance, dist, angleTo, normAng,
  circleRectResolve, pointInRect, rectDistPoint,
} from '../js/utils.js';
import { audio } from '../js/audio.js';
import { map, nav } from '../js/map.js';
import {
  WEAPONS, statsOf, boxRoll, POINTS, KNIFE, GRENADE, ZOMB, POWERUPS, rollPowerup,
} from '../js/weapons.js';

// ------------------------------------------------------------------ DOM / HUD canvas
const canvas = document.getElementById('game');
const hud = document.getElementById('hud');
const hctx = hud.getContext('2d');
const els = {
  title: document.getElementById('screen-title'),
  pause: document.getElementById('screen-pause'),
  over: document.getElementById('screen-over'),
  overTitle: document.getElementById('over-title'),
  overStats: document.getElementById('over-stats'),
  best: document.getElementById('best-label'),
  hint: document.getElementById('play-hint'),
  pauseStats: document.getElementById('pause-stats'),
  pressStart: document.getElementById('press-start'),
  sens: document.getElementById('opt-sens'),
  fov: document.getElementById('opt-fov'),
  shake: document.getElementById('opt-shake'),
  valSens: document.getElementById('val-sens'),
  valFov: document.getElementById('val-fov'),
  valShake: document.getElementById('val-shake'),
};

// ------------------------------------------------------------------ settings + UI helpers
const settings = Object.assign({ sens: 1, fov: 75, shake: 1 }, JSON.parse(localStorage.getItem('zombies3d_settings') || '{}'));
function saveSettings() {
  try { localStorage.setItem('zombies3d_settings', JSON.stringify(settings)); } catch (e) {}
}
function applySettingsUI() {
  els.sens.value = settings.sens;
  els.fov.value = settings.fov;
  els.shake.value = settings.shake;
  els.valSens.textContent = Number(settings.sens).toFixed(2) + '×';
  els.valFov.textContent = Math.round(settings.fov) + '°';
  els.valShake.textContent = Math.round(settings.shake * 100) + '%';
}
for (const [key, el] of [['sens', els.sens], ['fov', els.fov], ['shake', els.shake]]) {
  el.addEventListener('input', () => {
    settings[key] = parseFloat(el.value);
    applySettingsUI();
    saveSettings();
  });
}
applySettingsUI();

function showHint(html) {
  els.hint.innerHTML = html;
  els.hint.classList.remove('hidden');
}
function hideHint() {
  els.hint.classList.add('hidden');
}

let W = 0, H = 0, DPR = 1;
function resize() {
  DPR = Math.min(2, window.devicePixelRatio || 1);
  W = window.innerWidth;
  H = window.innerHeight;
  renderer.setPixelRatio(DPR);
  renderer.setSize(W, H, false);
  camera.aspect = W / H;
  camera.updateProjectionMatrix();
  hud.width = Math.floor(W * DPR);
  hud.height = Math.floor(H * DPR);
  hud.style.width = W + 'px';
  hud.style.height = H + 'px';
  if (typeof composer !== 'undefined' && composer) {
    applyQuality();
  }
}

// ------------------------------------------------------------------ renderer / scene
// post-processing chain (declared early because resize() may run before boot)
var composer = null;
var ssaoPass = null;
var bloomPass = null;
var fxaaPass = null;
var gradePass = null;

let renderer;
try {
  renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
  if (!renderer.getContext()) throw new Error('no WebGL context');
} catch (e) {
  const showErr = window.__showBootError || (() => {});
  showErr('⚠ WebGL could not start: ' + (e && e.message) + ' — enable hardware acceleration or try another browser. The 2D build at / works everywhere.');
  throw e;
}
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFShadowMap;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.25;

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x04050a);
scene.fog = new THREE.FogExp2(0x04050a, 0.0011);

const camera = new THREE.PerspectiveCamera(75, 1, 1, 6000);
camera.rotation.order = 'YXZ';
scene.add(camera);

const WALL_H = 300;        // 3 m ceiling
const EYE_H = 168;         // eye height
const FONT = 'Impact, "Arial Black", sans-serif';
const MONO = '"Consolas", "Menlo", monospace';
const BOX_NAMES = ['THOMPSON', 'MG42', 'TRENCH GUN', 'MP40', 'M14', 'RAY GUN', 'THUNDERGUN', 'PANZERFAUST', 'TEDDY BEAR'];

resize();
window.addEventListener('resize', resize);

// ------------------------------------------------------------------ procedural textures
function makeCanvas(w, h) {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  return c;
}
function toTex(c, repeat) {
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 4;
  if (repeat) {
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.repeat.set(repeat[0], repeat[1]);
  }
  return t;
}

// derive a tangent-space normal map from a greyscale-ish canvas (sobel on luminance)
function normalFromCanvas(c, strength = 2.2) {
  const w = c.width, h = c.height;
  const img = c.getContext('2d').getImageData(0, 0, w, h).data;
  const lum = (x, y) => {
    const i = (((y + h) % h) * w + ((x + w) % w)) * 4;
    return (img[i] * 0.299 + img[i + 1] * 0.587 + img[i + 2] * 0.114) / 255;
  };
  const outC = makeCanvas(w, h);
  const cg = outC.getContext('2d');
  const out = cg.createImageData(w, h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const dx = (lum(x - 1, y) - lum(x + 1, y)) * strength;
      const dy = (lum(x, y - 1) - lum(x, y + 1)) * strength;
      const len = Math.hypot(dx, dy, 1);
      const i = (y * w + x) * 4;
      out.data[i] = ((dx / len) * 0.5 + 0.5) * 255;
      out.data[i + 1] = ((dy / len) * 0.5 + 0.5) * 255;
      out.data[i + 2] = ((1 / len) * 0.5 + 0.5) * 255;
      out.data[i + 3] = 255;
    }
  }
  cg.putImageData(out, 0, 0);
  const t = new THREE.CanvasTexture(outC);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.anisotropy = 4;
  return t;
}

// procedural cloth weave (used for zombie shirts)
function makeClothTex(base) {
  const c = makeCanvas(128, 128);
  const g = c.getContext('2d');
  g.fillStyle = base;
  g.fillRect(0, 0, 128, 128);
  for (let i = 0; i < 64; i++) {
    g.fillStyle = `rgba(0,0,0,${rand(0.05, 0.13)})`;
    g.fillRect(0, i * 2, 128, 1);
    g.fillStyle = `rgba(255,255,255,${rand(0.01, 0.04)})`;
    g.fillRect(i * 2, 0, 1, 128);
  }
  for (let i = 0; i < 26; i++) {
    g.fillStyle = `rgba(30,16,8,${rand(0.06, 0.2)})`;
    g.beginPath();
    g.ellipse(rand(0, 128), rand(0, 128), rand(3, 14), rand(2, 9), rand(0, TAU), 0, TAU);
    g.fill();
  }
  return c;
}

const floorTex = (() => {
  const c = makeCanvas(map.w, map.h);
  const g = c.getContext('2d');
  g.fillStyle = '#2c2e2b';
  g.fillRect(0, 0, map.w, map.h);
  const cell = 84;
  for (let y = 0; y < map.h; y += cell) {
    for (let x = 0; x < map.w; x += cell) {
      const v = randInt(40, 54);
      g.fillStyle = `rgb(${v},${v},${v - 2})`;
      g.fillRect(x + 1, y + 1, cell - 2, cell - 2);
    }
  }
  for (let i = 0; i < 9000; i++) {
    const v = randInt(26, 80);
    g.fillStyle = `rgba(${v},${v},${v},${rand(0.1, 0.35)})`;
    g.fillRect(rand(0, map.w), rand(0, map.h), rand(1, 4), rand(1, 4));
  }
  for (let i = 0; i < 60; i++) {
    g.fillStyle = `rgba(8,8,8,${rand(0.08, 0.2)})`;
    g.beginPath();
    g.ellipse(rand(0, map.w), rand(0, map.h), rand(14, 70), rand(10, 45), rand(0, TAU), 0, TAU);
    g.fill();
  }
  const tints = { a: 'rgba(80,92,110,0.13)', b: 'rgba(110,84,60,0.13)', c: 'rgba(60,100,80,0.13)', d: 'rgba(104,64,58,0.13)' };
  for (const r of map.rooms) {
    g.fillStyle = tints[r.id];
    g.fillRect(r.x, r.y, r.w, r.h);
  }
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  for (const r of map.rooms) {
    g.save();
    g.translate(r.x + r.w / 2, r.y + r.h / 2);
    g.rotate(-0.05);
    g.font = `bold 60px ${FONT}`;
    g.fillStyle = 'rgba(255,255,255,0.05)';
    g.fillText(r.name, 0, 0);
    g.restore();
  }
  return toTex(c);
})();

const concreteTex = (() => {
  const c = makeCanvas(256, 256);
  const g = c.getContext('2d');
  g.fillStyle = '#54565d';
  g.fillRect(0, 0, 256, 256);
  for (let i = 0; i < 1400; i++) {
    const v = randInt(58, 96);
    g.fillStyle = `rgba(${v},${v},${v + 4},${rand(0.08, 0.26)})`;
    g.fillRect(rand(0, 256), rand(0, 256), rand(1, 5), rand(1, 5));
  }
  for (let i = 0; i < 40; i++) {
    g.fillStyle = `rgba(34,34,40,${rand(0.12, 0.32)})`;
    g.fillRect(rand(0, 256), rand(0, 256), rand(2, 20), rand(1, 4));
  }
  g.strokeStyle = 'rgba(30,30,34,0.5)';
  g.lineWidth = 3;
  g.strokeRect(0, 0, 256, 128);
  g.strokeRect(0, 128, 256, 128);
  return toTex(c, [1, 1]);
})();

const woodTex = (() => {
  const c = makeCanvas(128, 128);
  const g = c.getContext('2d');
  g.fillStyle = '#5c4426';
  g.fillRect(0, 0, 128, 128);
  for (let y = 0; y < 128; y += 16) {
    g.fillStyle = `rgba(${randInt(50, 95)},${randInt(35, 65)},${randInt(15, 35)},0.55)`;
    g.fillRect(0, y, 128, 14);
    g.fillStyle = 'rgba(20,12,6,0.5)';
    g.fillRect(0, y + 14, 128, 2);
  }
  for (let i = 0; i < 90; i++) {
    g.fillStyle = `rgba(30,20,10,${rand(0.08, 0.3)})`;
    g.fillRect(rand(0, 128), rand(0, 128), rand(2, 12), 1);
  }
  return toTex(c, [1, 1]);
})();

const roundTex = (() => {
  // soft radial blob, used for particles (tinted per material)
  const c = makeCanvas(64, 64);
  const g = c.getContext('2d');
  const gr = g.createRadialGradient(32, 32, 0, 32, 32, 32);
  gr.addColorStop(0, 'rgba(255,255,255,1)');
  gr.addColorStop(0.4, 'rgba(255,255,255,0.7)');
  gr.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = gr;
  g.fillRect(0, 0, 64, 64);
  return toTex(c);
})();

const ringTex = (() => {
  const c = makeCanvas(128, 128);
  const g = c.getContext('2d');
  g.strokeStyle = 'rgba(255,255,255,0.9)';
  g.lineWidth = 4;
  g.beginPath();
  g.arc(64, 64, 54, 0, TAU);
  g.stroke();
  g.strokeStyle = 'rgba(255,255,255,0.25)';
  g.lineWidth = 9;
  g.beginPath();
  g.arc(64, 64, 48, 0, TAU);
  g.stroke();
  return toTex(c);
})();

const bloodSplatTex = (() => {
  const c = makeCanvas(128, 128);
  const g = c.getContext('2d');
  g.fillStyle = 'rgba(90,8,10,0.85)';
  g.beginPath();
  g.ellipse(64, 64, 34, 27, rand(0, TAU), 0, TAU);
  g.fill();
  for (let i = 0; i < 16; i++) {
    g.fillStyle = `rgba(${randInt(60, 110)},${randInt(4, 12)},${randInt(6, 14)},${rand(0.5, 0.85)})`;
    g.beginPath();
    g.arc(64 + rand(-52, 52), 64 + rand(-52, 52), rand(2, 9), 0, TAU);
    g.fill();
  }
  return toTex(c);
})();

const bulletHoleTex = (() => {
  const c = makeCanvas(32, 32);
  const g = c.getContext('2d');
  const gr = g.createRadialGradient(16, 16, 0, 16, 16, 15);
  gr.addColorStop(0, 'rgba(6,6,8,0.95)');
  gr.addColorStop(0.5, 'rgba(20,18,16,0.6)');
  gr.addColorStop(1, 'rgba(20,18,16,0)');
  g.fillStyle = gr;
  g.fillRect(0, 0, 32, 32);
  return toTex(c);
})();

function textTexture(text, { font = `bold 64px ${FONT}`, color = '#f5c542', bg = 'rgba(0,0,0,0)', stroke = 'rgba(0,0,0,0.9)', w = 512, h = 128, strokeW = 8 } = {}) {
  const c = makeCanvas(w, h);
  const g = c.getContext('2d');
  if (bg !== 'rgba(0,0,0,0)') {
    g.fillStyle = bg;
    g.fillRect(0, 0, w, h);
  }
  g.font = font;
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  if (stroke) {
    g.strokeStyle = stroke;
    g.lineWidth = strokeW;
    g.strokeText(text, w / 2, h / 2 + 2);
  }
  g.fillStyle = color;
  g.fillText(text, w / 2, h / 2 + 2);
  return toTex(c);
}

// ------------------------------------------------------------------ static world
const worldColliders = [];   // meshes bullets can hit

const wallMat = new THREE.MeshStandardMaterial({
  map: concreteTex,
  normalMap: normalFromCanvas(concreteTex.image, 1.8),
  normalScale: new THREE.Vector2(0.45, 0.45),
  roughnessMap: concreteTex,
  roughness: 2.0,
  metalness: 0.02,
  envMapIntensity: 0.22,
});
const crateMat = new THREE.MeshStandardMaterial({
  map: woodTex,
  normalMap: normalFromCanvas(woodTex.image, 2.4),
  normalScale: new THREE.Vector2(0.6, 0.6),
  roughnessMap: woodTex,
  roughness: 1.9,
  color: 0xb08f68,
  envMapIntensity: 0.25,
});
const ceilMat = new THREE.MeshStandardMaterial({ color: 0x232630, roughness: 1, envMapIntensity: 0.2 });

function addBox(w, h, d, x, y, z, mat, { collide = true, receive = true, cast = true } = {}) {
  const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat);
  m.position.set(x, y, z);
  m.castShadow = cast;
  m.receiveShadow = receive;
  scene.add(m);
  if (collide) worldColliders.push(m);
  return m;
}

// floor + outside apron + ceiling
{
  const floor = new THREE.Mesh(
    new THREE.PlaneGeometry(map.w, map.h),
    new THREE.MeshStandardMaterial({
      map: floorTex,
      normalMap: normalFromCanvas(floorTex.image, 1.6),
      normalScale: new THREE.Vector2(0.4, 0.4),
      roughnessMap: floorTex,
      roughness: 2.0,
      metalness: 0.03,
      envMapIntensity: 0.2,
    }),
  );
  floor.rotation.x = -Math.PI / 2;
  floor.position.set(map.w / 2, 0, map.h / 2);
  floor.receiveShadow = true;
  scene.add(floor);
  worldColliders.push(floor);

  const apron = new THREE.Mesh(new THREE.PlaneGeometry(map.w + 700, map.h + 700), new THREE.MeshStandardMaterial({ color: 0x101114, roughness: 1 }));
  apron.rotation.x = -Math.PI / 2;
  apron.position.set(map.w / 2, -2, map.h / 2);
  scene.add(apron);

  const ceil = new THREE.Mesh(new THREE.PlaneGeometry(map.w, map.h), ceilMat);
  ceil.rotation.x = Math.PI / 2;
  ceil.position.set(map.w / 2, WALL_H, map.h / 2);
  ceil.receiveShadow = true;
  scene.add(ceil);
}

// ceiling light strips (emissive only, no real lights, for depth cues)
  for (const r of map.rooms) {
  for (let i = 0; i < 2; i++) {
    const strip = new THREE.Mesh(
      new THREE.BoxGeometry(180, 6, 26),
      new THREE.MeshBasicMaterial({ color: 0x3f4450 }),
    );
    strip.position.set(r.x + r.w * (0.3 + i * 0.4), WALL_H - 4, r.y + r.h * (0.25 + 0.5 * ((i + r.id.length) % 2)));
    scene.add(strip);
  }
}

// walls, with real window openings on the outer shell
function wallsWithHoles(rect) {
  const holes = [];
  for (const w of map.windows) {
    if (rect.x < w.rect.x + w.rect.w && rect.x + rect.w > w.rect.x &&
        rect.y < w.rect.y + w.rect.h && rect.y + rect.h > w.rect.y) {
      if (rect.w >= rect.h) holes.push({ from: w.rect.x, to: w.rect.x + w.rect.w });
      else holes.push({ from: w.rect.y, to: w.rect.y + w.rect.h });
    }
  }
  holes.sort((a, b) => a.from - b.from);
  if (!holes.length) {
    addBox(rect.w, WALL_H, rect.h, rect.x + rect.w / 2, WALL_H / 2, rect.y + rect.h / 2, wallMat);
    return;
  }
  const SILL = 70, HEAD = 240;
  const alongX = rect.w >= rect.h;
  let cur = alongX ? rect.x : rect.y;
  const end = alongX ? rect.x + rect.w : rect.y + rect.h;
  const seg = (from, to, y0, y1) => {
    if (to - from <= 0.5) return;
    if (alongX) addBox(to - from, y1 - y0, rect.h, from + (to - from) / 2, (y0 + y1) / 2, rect.y + rect.h / 2, wallMat);
    else addBox(rect.w, y1 - y0, to - from, rect.x + rect.w / 2, (y0 + y1) / 2, from + (to - from) / 2, wallMat);
  };
  for (const hle of holes) {
    seg(cur, hle.from, 0, WALL_H);
    seg(hle.from, hle.to, 0, SILL);
    seg(hle.from, hle.to, HEAD, WALL_H);
    // sill ledge sticking into the room
    if (alongX) addBox(hle.to - hle.from + 10, 14, rect.h + 12, (hle.from + hle.to) / 2, SILL + 7, rect.y + rect.h / 2, wallMat, { collide: false });
    else addBox(rect.w + 12, 14, hle.to - hle.from + 10, rect.x + rect.w / 2, SILL + 7, (hle.from + hle.to) / 2, wallMat, { collide: false });
    cur = hle.to;
  }
  seg(cur, end, 0, WALL_H);
}
for (const r of map.walls) wallsWithHoles(r);

// crates
for (const c of map.crates) {
  addBox(c.w, 90, c.h, c.x + c.w / 2, 45, c.y + c.h / 2, crateMat);
  const lid = new THREE.Mesh(new THREE.BoxGeometry(c.w + 6, 10, c.h + 6), new THREE.MeshStandardMaterial({ map: woodTex, color: 0x8a7048, roughness: 0.9 }));
  lid.position.set(c.x + c.w / 2, 94, c.y + c.h / 2);
  lid.castShadow = true;
  scene.add(lid);
}

// ------------------------------------------------------------------ doors
const doorGroups = [];
for (const d of map.doors) {
  const r = d.rect;
  const alongX = r.w > r.h;
  const pivot = new THREE.Group();
  const slab = new THREE.Mesh(
    alongX ? new THREE.BoxGeometry(r.w, WALL_H - 6, 12) : new THREE.BoxGeometry(12, WALL_H - 6, r.h),
    new THREE.MeshStandardMaterial({ map: woodTex, color: 0xa8895c, roughness: 0.85 }),
  );
  slab.castShadow = true;
  slab.receiveShadow = true;
  if (alongX) {
    slab.position.set(r.w / 2, (WALL_H - 6) / 2, 0);
    pivot.position.set(r.x, 0, r.y + r.h / 2);
  } else {
    slab.position.set(0, (WALL_H - 6) / 2, r.h / 2);
    pivot.position.set(r.x + r.w / 2, 0, r.y);
  }
  // metal brace
  const brace = new THREE.Mesh(
    alongX ? new THREE.BoxGeometry(r.w - 10, 12, 15) : new THREE.BoxGeometry(15, 12, r.h - 10),
    new THREE.MeshStandardMaterial({ color: 0x55575e, metalness: 0.7, roughness: 0.5 }),
  );
  brace.position.copy(slab.position);
  brace.position.y += 40;
  pivot.add(slab, brace);
  scene.add(pivot);
  worldColliders.push(slab);
  doorGroups.push({ door: d, pivot, slab, opening: false, openT: 0 });
}

// ------------------------------------------------------------------ windows (boards)
for (const w of map.windows) {
  const boards = new THREE.Group();
  const boardMat = new THREE.MeshStandardMaterial({ map: woodTex, color: 0xc7a26a, roughness: 0.9 });
  const alongX = w.dir === 'n' || w.dir === 's';
  for (let i = 0; i < 6; i++) {
    const b = new THREE.Mesh(
      alongX ? new THREE.BoxGeometry(70, 15, 10) : new THREE.BoxGeometry(10, 15, 70),
      boardMat,
    );
    b.castShadow = true;
    const t = 100 + i * 21;
    if (alongX) b.position.set(w.x, t, w.y + rand(-1, 1));
    else b.position.set(w.x + rand(-1, 1), t, w.y);
    b.rotation.z = rand(-0.04, 0.04);
    boards.add(b);
  }
  scene.add(boards);
  w._boardsGroup = boards;
  w._shown = 6;
}

// ------------------------------------------------------------------ machines, box, pap, wall buys
const glowLights = [];
for (const p of map.perks) {
  const r = p.rect;
  const body = addBox(r.w, 96, r.h, r.x + r.w / 2, 48, r.y + r.h / 2, new THREE.MeshStandardMaterial({ color: 0x1d1f26, roughness: 0.55, metalness: 0.35, emissive: 0x0a0b10, emissiveIntensity: 1 }));
  const panel = new THREE.Mesh(
    new THREE.BoxGeometry(r.w - 8, 40, r.h - 8),
    new THREE.MeshStandardMaterial({ color: p.color, emissive: p.color, emissiveIntensity: 0.95, roughness: 0.5 }),
  );
  panel.position.set(r.x + r.w / 2, 58, r.y + r.h / 2);
  panel.position.z += (p.y < map.h / 2 ? 1 : -1) * 0;
  scene.add(panel);
  const bottle = new THREE.Mesh(
    new THREE.CylinderGeometry(6, 6, 26, 10),
    new THREE.MeshStandardMaterial({ color: p.color, emissive: p.color, emissiveIntensity: 1.7, transparent: true, opacity: 0.95 }),
  );
  bottle.position.set(r.x + r.w / 2, 108, r.y + r.h / 2);
  scene.add(bottle);
  const light = new THREE.PointLight(p.color, 42, 680, 1.6);
  light.position.set(r.x + r.w / 2, 120, r.y + r.h / 2);
  scene.add(light);
  glowLights.push(light);
  p._panel = panel;
  const label = new THREE.Sprite(new THREE.SpriteMaterial({
    map: textTexture(p.name.toUpperCase(), { font: `bold 46px ${FONT}`, color: p.color, w: 640, h: 96 }),
    transparent: true, depthWrite: false, fog: false,
  }));
  label.scale.set(170, 26, 1);
  label.position.set(r.x + r.w / 2, 148, r.y + r.h / 2);
  scene.add(label);
}

// mystery box
{
  const b = map.box;
  const crate = addBox(b.rect.w, 52, b.rect.h, b.x, 26, b.y, crateMat);
  const lid = new THREE.Mesh(new THREE.BoxGeometry(b.rect.w + 6, 12, b.rect.h + 6), new THREE.MeshStandardMaterial({ map: woodTex, color: 0x8a7048 }));
  lid.position.set(b.x, 58, b.y);
  lid.castShadow = true;
  scene.add(lid);
  b._lid = lid;
  const light = new THREE.PointLight(0xf5c542, 34, 560, 1.6);
  light.position.set(b.x, 110, b.y);
  scene.add(light);
  glowLights.push(light);
  const sprite = new THREE.Sprite(new THREE.SpriteMaterial({
    map: textTexture('?', { font: `bold 140px ${FONT}`, color: '#f5c542', w: 256, h: 256 }),
    transparent: true, depthWrite: false, fog: false,
  }));
  sprite.scale.set(70, 70, 1);
  sprite.position.set(b.x, 130, b.y);
  scene.add(sprite);
  b._sprite = sprite;
}

// pack-a-punch
{
  const p = map.pap;
  const body = addBox(p.rect.w, 110, p.rect.h, p.x, 55, p.y, new THREE.MeshStandardMaterial({ color: 0x14161a, roughness: 0.5, metalness: 0.6 }));
  for (const side of [-1, 1]) {
    const coil = new THREE.Mesh(
      new THREE.CylinderGeometry(10, 10, 60, 12),
      new THREE.MeshStandardMaterial({ color: 0x3aff9a, emissive: 0x3aff9a, emissiveIntensity: 1.4, transparent: true, opacity: 0.85 }),
    );
    coil.position.set(p.x + side * 30, 70, p.y);
    scene.add(coil);
  }
  const light = new THREE.PointLight(0x3aff9a, 40, 700, 1.6);
  light.position.set(p.x, 110, p.y);
  scene.add(light);
  glowLights.push(light);
  const label = new THREE.Sprite(new THREE.SpriteMaterial({
    map: textTexture('PACK-A-PUNCH', { font: `bold 44px ${FONT}`, color: '#7dffb0', w: 640, h: 96 }),
    transparent: true, depthWrite: false, fog: false,
  }));
  label.scale.set(180, 27, 1);
  label.position.set(p.x, 150, p.y);
  scene.add(label);
  p._body = body;
}

// wall buys: chalk gun sign + price baked onto a plate on the wall
function gunGlyphPath(g, cls, len) {
  g.beginPath();
  switch (cls) {
    case 'pistol':
      g.rect(-len * 0.3, -4, len * 0.6, 8);
      g.rect(-len * 0.3 - 4, -2, 6, 4);
      g.rect(-2, 4, 9, 14);
      break;
    case 'smg':
      g.rect(-len / 2, -5, len, 10);
      g.rect(-2, 5, 11, 17);
      g.rect(-len / 2 + 4, -10, len * 0.4, 5);
      break;
    case 'shotgun':
      g.rect(-len / 2, -4, len, 8);
      g.rect(-len / 2 - 6, -7, 12, 14);
      break;
    case 'mg':
      g.rect(-len / 2, -6, len, 12);
      g.rect(-len / 2 + 8, -13, 26, 7);
      g.rect(-2, 6, 13, 15);
      break;
    default:
      g.rect(-len / 2, -4, len, 8);
      g.rect(-2, 4, 9, 15);
      g.rect(-len / 2 + 4, -8, len * 0.5, 4);
      break;
  }
}

for (const b of map.buys) {
  const def = WEAPONS[b.id];
  // find the wall face behind the sign by marching along -normal
  const n = [Math.cos(b.angle), Math.sin(b.angle)];
  let fx = b.x, fy = b.y;
  for (let i = 0; i < 130; i += 2) {
    const px = b.x - n[0] * i, py = b.y - n[1] * i;
    if (map.walls.some((r) => pointInRect(px, py, r))) break;
    fx = px; fy = py;
  }
  const c = makeCanvas(360, 160);
  const g = c.getContext('2d');
  g.fillStyle = 'rgba(16,16,20,0.92)';
  g.fillRect(0, 0, 360, 160);
  g.strokeStyle = 'rgba(232,214,162,0.7)';
  g.lineWidth = 6;
  g.strokeRect(6, 6, 348, 148);
  g.save();
  g.translate(180, 76);
  g.strokeStyle = 'rgba(232,214,162,0.95)';
  g.fillStyle = 'rgba(232,214,162,0.16)';
  g.lineWidth = 7;
  gunGlyphPath(g, def.cls, 180);
  g.fill();
  g.stroke();
  g.restore();
  g.font = `bold 44px ${FONT}`;
  g.textAlign = 'center';
  g.strokeStyle = 'rgba(0,0,0,0.9)';
  g.lineWidth = 6;
  g.strokeText(String(def.cost), 180, 146);
  g.fillStyle = '#f5c542';
  g.fillText(String(def.cost), 180, 146);
  const sign = new THREE.Mesh(
    new THREE.PlaneGeometry(130, 58),
    new THREE.MeshStandardMaterial({ map: toTex(c), roughness: 0.75, emissive: 0x3a3220, emissiveIntensity: 0.85 }),
  );
  sign.position.set(fx + n[0] * 2, 128, fy + n[1] * 2);
  sign.rotation.y = Math.PI / 2 - b.angle;
  scene.add(sign);
  b._sign = sign;
}

// ------------------------------------------------------------------ lighting
// image-based lighting: PBR materials get grounded ambient light + real reflections
{
  const pmrem = new THREE.PMREMGenerator(renderer);
  scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
  scene.environmentIntensity = 0.16;
  pmrem.dispose();
}
scene.add(new THREE.HemisphereLight(0x46506a, 0x14151a, 0.55));
scene.add(new THREE.AmbientLight(0x3a4256, 0.22));

const flashlight = new THREE.SpotLight(0xfff0d0, 1300, 2800, 0.6, 0.6, 1.1);
flashlight.position.set(0, 0, 0);
flashlight.castShadow = true;
flashlight.shadow.mapSize.set(2048, 2048);
flashlight.shadow.camera.near = 4;
flashlight.shadow.camera.far = 2600;
flashlight.shadow.bias = -0.0008;
flashlight.shadow.normalBias = 2.2;
flashlight.target.position.set(0, -6, -140);
camera.add(flashlight);
camera.add(flashlight.target);

const muzzleLight = new THREE.PointLight(0xffc878, 0, 420, 1.7);
camera.add(muzzleLight);
muzzleLight.position.set(20, -18, -60);

const flashLight = new THREE.PointLight(0xffa050, 0, 1400, 1.4);
flashLight.position.set(0, 120, 0);
scene.add(flashLight);

// volumetric flashlight beam (fake fog cone) — apex at the lens, fading out with distance
const beamTex = (() => {
  const c = makeCanvas(64, 256);
  const g = c.getContext('2d');
  const grad = g.createLinearGradient(0, 0, 0, 256);
  grad.addColorStop(0, 'rgba(255,244,214,0.0)');
  grad.addColorStop(0.25, 'rgba(255,242,208,0.35)');
  grad.addColorStop(0.62, 'rgba(255,238,200,0.2)');
  grad.addColorStop(1, 'rgba(255,238,200,0)');
  g.fillStyle = grad;
  g.fillRect(0, 0, 64, 256);
  return toTex(c);
})();
const beam = new THREE.Mesh(
  new THREE.ConeGeometry(640, 1560, 30, 1, true),
  new THREE.MeshBasicMaterial({
    map: beamTex, transparent: true, opacity: 0.055, blending: THREE.AdditiveBlending,
    depthWrite: false, side: THREE.DoubleSide, fog: false,
  }),
);
beam.rotation.x = Math.PI / 2;
beam.position.set(0, -4, -780);
camera.add(beam);

// dust motes floating in the air (Points cloud, wrapped around the player)
const DUST_COUNT = 150;
const dustGeo = new THREE.BufferGeometry();
const dustPos = new Float32Array(DUST_COUNT * 3);
const dustVel = new Float32Array(DUST_COUNT * 3);
for (let i = 0; i < DUST_COUNT; i++) {
  dustPos[i * 3] = rand(-520, 520);
  dustPos[i * 3 + 1] = rand(14, 280);
  dustPos[i * 3 + 2] = rand(-520, 520);
  dustVel[i * 3] = rand(-7, 7);
  dustVel[i * 3 + 1] = rand(-3, 3);
  dustVel[i * 3 + 2] = rand(-7, 7);
}
dustGeo.setAttribute('position', new THREE.BufferAttribute(dustPos, 3));
const dust = new THREE.Points(dustGeo, new THREE.PointsMaterial({
  color: 0xfff2d6, size: 2.8, map: roundTex, transparent: true, opacity: 0.22,
  blending: THREE.AdditiveBlending, depthWrite: false, sizeAttenuation: true, fog: false,
}));
scene.add(dust);

// ------------------------------------------------------------------ zombie factory
const ZG = {
  torso: new THREE.CapsuleGeometry(15.5, 30, 6, 16),
  pelvis: new THREE.CapsuleGeometry(12.5, 12, 4, 12),
  head: new THREE.CapsuleGeometry(10.5, 6, 6, 16),
  neck: new THREE.CylinderGeometry(5.5, 6.5, 10, 12),
  upperArm: new THREE.CapsuleGeometry(6.4, 20, 4, 12),
  foreArm: new THREE.CapsuleGeometry(5.6, 19, 4, 12),
  thigh: new THREE.CapsuleGeometry(8.2, 20, 5, 12),
  shin: new THREE.CapsuleGeometry(6.6, 20, 5, 12),
  hand: new THREE.SphereGeometry(6, 10, 8),
  foot: new THREE.BoxGeometry(11, 6, 20),
  socket: new THREE.SphereGeometry(3.6, 10, 8),
  eye: new THREE.SphereGeometry(2.4, 10, 8),
  mouth: new THREE.BoxGeometry(13, 4, 5),
};
const shirtPalette = [0x33382f, 0x3b332e, 0x2f333a, 0x373039, 0x31362d];
const clothCache = {};
function clothFor(color) {
  if (!clothCache[color]) clothCache[color] = toTex(makeClothTex('#' + color.toString(16).padStart(6, '0')), [2, 2]);
  return clothCache[color];
}
const pantsMatBase = new THREE.MeshStandardMaterial({ color: 0x24252a, roughness: 0.92, envMapIntensity: 0.25 });
const eyeMat = new THREE.MeshBasicMaterial({ color: 0xff2a22, fog: false });
const rotMat = new THREE.MeshStandardMaterial({ color: 0x2a1410, roughness: 0.85 });

function makeZombieMesh(z) {
  const group = new THREE.Group();
  const pivot = new THREE.Group();
  group.add(pivot);

  const shirtColor = z.sprinter ? 0x4a302e : choice(shirtPalette);
  const shirt = new THREE.MeshStandardMaterial({ map: clothFor(shirtColor), roughness: 0.9, envMapIntensity: 0.28 });
  const skin = new THREE.MeshStandardMaterial({ color: z.sprinter ? 0x7a5a50 : 0x6c7452, roughness: 0.78, envMapIntensity: 0.3 });
  const pants = pantsMatBase.clone();
  z.mats = [shirt, skin, pants];
  z.matsBaseColor = z.mats.map((m) => m.color.clone());

  const mk = (geo, mat, x, y, zz) => {
    const m = new THREE.Mesh(geo, mat);
    m.position.set(x, y, zz);
    m.castShadow = true;
    pivot.add(m);
    return m;
  };

  const pelvis = mk(ZG.pelvis, pants, 0, 84, 0);
  const torso = mk(ZG.torso, shirt, 0, 128, 0);
  const neck = mk(ZG.neck, skin, 0, 160, 0);
  const head = mk(ZG.head, skin, 0, 176, 0);

  // face: sunken sockets with glowing irises + dark mouth
  for (const s of [-1, 1]) {
    const sock = new THREE.Mesh(ZG.socket, rotMat);
    sock.position.set(s * 4.8, 179, 8.6);
    pivot.add(sock);
    const eye = new THREE.Mesh(ZG.eye, eyeMat);
    eye.position.set(s * 4.8, 179, 9.9);
    pivot.add(eye);
  }
  const mouth = new THREE.Mesh(ZG.mouth, rotMat);
  mouth.position.set(0, 168.5, 10.4);
  pivot.add(mouth);

  const armPivot = [], elbowPivot = [];
  for (const s of [-1, 1]) {
    const shoulder = new THREE.Group();
    shoulder.position.set(s * 17.5, 150, 2);
    const upper = new THREE.Mesh(ZG.upperArm, shirt);
    upper.position.y = -16.5;
    upper.castShadow = true;
    shoulder.add(upper);
    const elbow = new THREE.Group();
    elbow.position.y = -33;
    const fore = new THREE.Mesh(ZG.foreArm, skin);
    fore.position.y = -15;
    fore.castShadow = true;
    elbow.add(fore);
    const hand = new THREE.Mesh(ZG.hand, skin);
    hand.position.y = -31;
    hand.castShadow = true;
    elbow.add(hand);
    shoulder.add(elbow);
    shoulder.rotation.x = -1.25;
    elbow.rotation.x = -0.45;
    pivot.add(shoulder);
    armPivot.push(shoulder);
    elbowPivot.push(elbow);
  }

  const legPivot = [], kneePivot = [];
  for (const s of [-1, 1]) {
    const hip = new THREE.Group();
    hip.position.set(s * 9.5, 76, 0);
    const thigh = new THREE.Mesh(ZG.thigh, pants);
    thigh.position.y = -18;
    thigh.castShadow = true;
    hip.add(thigh);
    const knee = new THREE.Group();
    knee.position.y = -36;
    const shin = new THREE.Mesh(ZG.shin, pants);
    shin.position.y = -16.5;
    shin.castShadow = true;
    knee.add(shin);
    const foot = new THREE.Mesh(ZG.foot, pants);
    foot.position.set(0, -33, 4);
    foot.castShadow = true;
    knee.add(foot);
    hip.add(knee);
    pivot.add(hip);
    legPivot.push(hip);
    kneePivot.push(knee);
  }

  group.scale.setScalar(0.93); // ≈ 1.75 m tall
  group.position.set(z.x, 0, z.y);
  scene.add(group);

  z.mesh = group;
  z.pivot = pivot;
  z.headMesh = head;
  z.torsoMesh = torso;
  z.armPivot = armPivot;
  z.elbowPivot = elbowPivot;
  z.legPivot = legPivot;
  z.kneePivot = kneePivot;

  head.userData = { zombie: z, part: 'head' };
  z.hitMeshes = [head];
  pivot.traverse((o) => {
    if (!o.isMesh) return;
    if (o.material === rotMat || o.material === eyeMat) return; // sockets/eyes: don't count as hits
    if (!o.userData.zombie) o.userData = { zombie: z, part: 'body' };
    z.hitMeshes.push(o);
  });
  return group;
}

// ------------------------------------------------------------------ FX pools
const decals = [];       // { mesh, life }
const decalPool = [];
let decalIdx = 0;
for (let i = 0; i < 110; i++) {
  const m = new THREE.Mesh(
    new THREE.PlaneGeometry(46, 46),
    new THREE.MeshBasicMaterial({ map: bloodSplatTex, transparent: true, depthWrite: false }),
  );
  m.visible = false;
  m.rotation.x = -Math.PI / 2;
  scene.add(m);
  decalPool.push(m);
}
function spawnFloorDecal(x, y, scale, tex, opacity) {
  const m = decalPool[decalIdx++ % decalPool.length];
  m.visible = true;
  m.position.set(x, 0.6 + (decalIdx % 7) * 0.05, y);
  m.scale.setScalar(scale / 46);
  m.rotation.z = rand(0, TAU);
  if (m.material.map !== tex) {
    m.material.map = tex;
    m.material.needsUpdate = true;
  }
  if (m.material.opacity !== opacity) m.material.opacity = opacity;
  decals.push(m);
  while (decals.length > 110) decals.shift();
}

const holePool = [];
let holeIdx = 0;
for (let i = 0; i < 90; i++) {
  const m = new THREE.Mesh(
    new THREE.PlaneGeometry(11, 11),
    new THREE.MeshBasicMaterial({ map: bulletHoleTex, transparent: true, depthWrite: false }),
  );
  m.visible = false;
  scene.add(m);
  holePool.push(m);
}
const _v3a = new THREE.Vector3();
function spawnHole(point, normal) {
  const m = holePool[holeIdx++ % holePool.length];
  m.visible = true;
  m.position.copy(point).addScaledVector(normal, 0.7);
  m.lookAt(_v3a.copy(point).add(normal));
  m.rotation.z = rand(0, TAU);
}

// sprite particle pool
const parts = [];
const partPool = [];
let partIdx = 0;
for (let i = 0; i < 260; i++) {
  const mat = new THREE.SpriteMaterial({ map: roundTex, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, fog: false });
  const s = new THREE.Sprite(mat);
  s.visible = false;
  scene.add(s);
  partPool.push(s);
}
function spawnPart(x, y, h, vx, vy, vh, life, size, color, blending = THREE.AdditiveBlending) {
  const s = partPool[partIdx++ % partPool.length];
  s.visible = true;
  s.position.set(x, h, y);
  s.scale.setScalar(size);
  s.material.color.setHex(color);
  s.material.opacity = 1;
  s.material.blending = blending;
  parts.push({ s, x, y, h, vx, vy, vh, life, max: life, size, grow: 12 });
  while (parts.length > 260) parts.shift();
}

// floor rings
const rings = [];
const ringPool = [];
let ringIdx = 0;
for (let i = 0; i < 8; i++) {
  const m = new THREE.Mesh(
    new THREE.PlaneGeometry(1, 1),
    new THREE.MeshBasicMaterial({ map: ringTex, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, fog: false, side: THREE.DoubleSide }),
  );
  m.rotation.x = -Math.PI / 2;
  m.visible = false;
  scene.add(m);
  ringPool.push(m);
}
function spawnRing(x, y, rMax, color, life = 0.35) {
  const m = ringPool[ringIdx++ % ringPool.length];
  m.visible = true;
  m.position.set(x, 3, y);
  m.material.color.setHex(color);
  rings.push({ m, t: 0, life, rMax });
}

// tracers
const tracers = [];
const tracerPool = [];
let tracerIdx = 0;
for (let i = 0; i < 20; i++) {
  const geo = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3()]);
  const line = new THREE.Line(geo, new THREE.LineBasicMaterial({ color: 0xffe9a8, transparent: true, opacity: 0.9, blending: THREE.AdditiveBlending, fog: false }));
  line.visible = false;
  scene.add(line);
  tracerPool.push(line);
}
function spawnTracer(from, to, color) {
  const l = tracerPool[tracerIdx++ % tracerPool.length];
  l.visible = true;
  l.material.color.setHex(color);
  const pos = l.geometry.attributes.position;
  pos.setXYZ(0, from.x, from.y, from.z);
  pos.setXYZ(1, to.x, to.y, to.z);
  pos.needsUpdate = true;
  tracers.push({ l, life: 0.07, max: 0.07 });
}

// explosive projectiles
let projectiles = [];

// flashlight flicker helpers
let flickerT = 0;

// ------------------------------------------------------------------ HUD helpers
function text(str, x, y, { font = `bold 20px ${FONT}`, fill = '#fff', align = 'left', baseline = 'alphabetic', stroke = 'rgba(0,0,0,0.85)', strokeW = 4, alpha = 1, shadow = null, blur = 0 } = {}) {
  hctx.save();
  hctx.globalAlpha = alpha;
  hctx.font = font;
  hctx.textAlign = align;
  hctx.textBaseline = baseline;
  if (shadow) { hctx.shadowColor = shadow; hctx.shadowBlur = blur || 12; }
  if (stroke) { hctx.strokeStyle = stroke; hctx.lineWidth = strokeW; hctx.strokeText(str, x, y); }
  hctx.fillStyle = fill;
  hctx.fillText(str, x, y);
  hctx.restore();
}

// ------------------------------------------------------------------ state
const game = {
  state: 'title',        // title | playing | paused | gameover
  round: 0,
  phase: 'idle',
  phaseT: 0,
  toSpawn: 0,
  spawnedThisRound: 0,
  spawnTimer: 0,
  kills: 0,
  time: 0,
  trauma: 0,
  traumaT: 0,
  flashWhite: 0,
  banners: [],
  hitmarks: [],
  box: { state: 'idle', t: 0, cycleT: 0, cycleIdx: 0, result: null },
};

function makePlayer() {
  return {
    x: 420, y: 300, r: 24,
    yaw: -Math.PI / 2 + 0.15, pitch: -0.03,
    recoilPitch: 0, recoilYaw: 0, bloom: 0, ads: false, adsT: 0,
    stepT: 0, stepAlt: false, heartT: 0, dmgDirs: [],
    hp: 100, maxHp: 100,
    points: 500,
    weapons: [{ id: 'm1911', ammo: 8, reserve: 80, pap: false }, null],
    slot: 0,
    fireCd: 0, flash: 0,
    reload: null, swapT: 0,
    knifeCd: 0, knifeT: 0,
    grenades: 2,
    perks: { qr: false, jugg: false, speed: false, dt: false },
    power: { insta: 0, double: 0 },
    downed: false, downT: 0,
    regenT: 0, hurtT: 0,
    moving: false, sprinting: false,
    bobT: 0,
    aimAngle: 0,
    hold: { target: null, t: 0, tick: 0 },
    deny: null,
  };
}

let player = makePlayer();
let zombies = [];
let grenades = [];
let pickups = [];

// hit-stop: real-time countdown so it always recovers even at low time scale
let hitStop = 0;
let hitStopScale = 1;
function addHitStop(t, scale) {
  hitStop = Math.max(hitStop, t);
  hitStopScale = scale;
}

function curWeapon() { return player.weapons[player.slot]; }
function posVol(x, y) { return clamp(1 - dist(player.x, player.y, x, y) / 1300, 0.08, 1); }
function addPoints(n) { player.points += n * (player.power.double > 0 ? 2 : 1); }
function banner(t, sub = '', dur = 2.2, color = '#d8d2c4', size = 78) {
  game.banners.push({ text: t, sub, dur, t: 0, color, size });
  if (game.banners.length > 4) game.banners.shift();
}
function denyMsg(t) { player.deny = { t: 1.3, text: t }; audio.deny(); }
// game-feel: decaying trauma drives all camera shake (trauma² so small hits barely move)
function addTrauma(a) { game.trauma = clamp(game.trauma + a * settings.shake, 0, 1); }
function hitmark(color) { game.hitmarks.push({ t: 0.14, max: 0.14, color }); }
function yawFromAngle(a) { return Math.PI / 2 - a; }

// ------------------------------------------------------------------ world FX helpers
function bloodBurst(x, y, h, n = 8) {
  for (let i = 0; i < n; i++) {
    const a = rand(0, TAU);
    spawnPart(x, y, h, Math.cos(a) * rand(40, 160), Math.sin(a) * rand(40, 160), rand(20, 120), rand(0.25, 0.55), rand(3, 8), chance(0.3) ? 0xa81c1c : 0x7d1418, THREE.NormalBlending);
  }
}

function woodBurst(w) {
  for (let i = 0; i < 8; i++) {
    const a = rand(0, TAU);
    spawnPart(w.x, w.y, rand(90, 200), Math.cos(a) * rand(30, 120), Math.sin(a) * rand(30, 120), rand(-40, 160), rand(0.3, 0.65), rand(3, 6), 0x8a6a3c, THREE.NormalBlending);
  }
}

function explode(x, y, h, r, dmg, kind, selfDmg = 0) {
  audio.explode(kind);
  addTrauma(kind === 'ray' ? 0.45 : 0.85);
  flashLight.position.set(x, h + 40, y);
  flashLight.color.setHex(kind === 'ray' ? 0x66ff88 : 0xffa050);
  flashLight.intensity = kind === 'ray' ? 45 : 80;
  spawnRing(x, y, r, kind === 'ray' ? 0x8dff8a : 0xffcf8a, 0.32);
  const n = kind === 'ray' ? 8 : 16;
  for (let i = 0; i < n; i++) {
    const a = rand(0, TAU);
    spawnPart(x, y, h, Math.cos(a) * rand(40, r * 3), Math.sin(a) * rand(40, r * 3), rand(0, 240), rand(0.25, 0.6), rand(6, 16), kind === 'ray' ? 0x7dff9a : 0xff9a4a);
  }
  for (let i = 0; i < 10; i++) {
    const a = rand(0, TAU);
    spawnPart(x, y, h, Math.cos(a) * rand(10, r), Math.sin(a) * rand(10, r), rand(0, 120), rand(0.5, 1.1), rand(8, 20), 0x8a8a90, THREE.NormalBlending);
  }
  spawnFloorDecal(x, y, r * 1.1, bloodSplatTex, 0.35);
  for (const z of zombies) {
    if (z.state === 'dead') continue;
    const d = dist(x, y, z.x, z.y);
    if (d < r + 14) {
      const f = 1 - 0.65 * (d / (r + 14));
      const a = angleTo(x, y, z.x, z.y);
      z.kbx += Math.cos(a) * 140 * f;
      z.kby += Math.sin(a) * 140 * f;
      applyDamage(z, dmg * f, false, { hitPoints: false });
    }
  }
  if (selfDmg && dist(x, y, player.x, player.y) < r + 20) {
    const d = dist(x, y, player.x, player.y);
    hurtPlayer(selfDmg * (1 - 0.6 * d / (r + 20)), x, y);
  }
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
  const z = {
    x: w.out.x, y: w.out.y, h: 0, r: 16,
    hp: spr ? hp * 0.85 : hp, maxHp: hp,
    speed: ZOMB.speed(game.round) * rand(0.9, 1.1) * (spr ? 1.7 : 1),
    face: angleTo(w.out.x, w.out.y, w.in.x, w.in.y),
    state: 'climb', phase: 'eat', eat: 0.08, climbT: 0, climbTotal: 0,
    atkCd: 0, windup: 0, flash: 0, stagger: 0, dieT: 0, fall: 0, flinch: 0,
    flank: rand(0, TAU), flankT: 0, lx: 0, ly: 0, checkT: 0, detour: 0, detourSide: 1,
    sprinter: spr, win: w, inWindow: true,
    growlT: rand(0.5, 3), kbx: 0, kby: 0, walkPhase: rand(0, TAU),
  };
  makeZombieMesh(z);
  zombies.push(z);
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
        woodBurst(w);
      }
    } else {
      z.phase = 'in';
      z.climbT = 0;
      woodBurst(w);
    }
  } else {
    z.climbT += dt;
    const t = clamp(z.climbT / 0.9, 0, 1);
    const e = t * t * (3 - 2 * t);
    z.x = lerp(w.out.x, w.in.x, e);
    z.y = lerp(w.out.y, w.in.y, e);
    z.h = Math.sin(t * Math.PI) * 74;
    z.face = angleTo(w.out.x, w.out.y, w.in.x, w.in.y);
    if (t >= 1) {
      z.state = 'walk';
      z.h = 0;
      if (z.inWindow) { z.inWindow = false; w.climbers = Math.max(0, w.climbers - 1); }
    }
  }
}

function applyDamage(z, dmg, headshot, opts = {}) {
  if (z.state === 'dead') return false;
  const insta = player.power.insta > 0;
  z.hp -= dmg;
  z.flash = 0.09;
  z.flinch = Math.max(z.flinch, 0.16);
  if (insta || z.hp <= 0) {
    killZombie(z, headshot, opts);
    return true;
  }
  if (opts.hitPoints !== false) addPoints(POINTS.hit);
  audio.zombieHit(headshot, posVol(z.x, z.y));
  hitmark('#ffffff');
  bloodBurst(z.x, z.y, 120, headshot ? 12 : 7);
  if (z.state === 'walk' && chance(0.15)) z.stagger = 0.18;
  const kb = clamp(dmg * 0.05, 1, 10);
  const a = angleTo(player.x, player.y, z.x, z.y);
  z.kbx += Math.cos(a) * kb;
  z.kby += Math.sin(a) * kb;
  return false;
}

function killZombie(z, headshot, opts = {}) {
  if (z.state === 'dead') return;
  z.state = 'dead';
  z.dieT = 0;
  // hit-stop sells the kill: one brief freeze, shorter/softer on body kills
  addHitStop(headshot ? 0.075 : 0.05, headshot ? 0.1 : 0.22);
  const pts = opts.noPoints ? 0 : (opts.points ?? (headshot ? POINTS.headshotKill : POINTS.kill));
  addPoints(pts);
  game.kills++;
  audio.zombieDie(posVol(z.x, z.y));
  hitmark('#ff4040');
  bloodBurst(z.x, z.y, 120, headshot ? 22 : 14);
  spawnFloorDecal(z.x, z.y, rand(44, 66), bloodSplatTex, 0.85);
  if (z.inWindow && z.win) { z.inWindow = false; z.win.climbers = Math.max(0, z.win.climbers - 1); }
  if (!opts.noDrop && pickups.length < 2 && chance(0.032)) spawnPickup(z.x, z.y);
}

function updateZombies(dt) {
  for (let i = zombies.length - 1; i >= 0; i--) {
    const z = zombies[i];
    if (z.state === 'dead') {
      z.dieT += dt;
      const t = clamp(z.dieT / 0.7, 0, 1);
      z.fall += (t * 1.5 - z.fall) * Math.min(1, dt * 10);
      z.pivot.rotation.x = z.fall;
      z.mesh.position.y = -t * 8;
      const fade = clamp(1 - (z.dieT - 0.5) / 0.7, 0, 1);
      for (const m of z.mats) {
        m.transparent = true;
        m.opacity = fade;
      }
      z.mesh.visible = fade > 0.02;
      if (z.dieT > 1.25) {
        scene.remove(z.mesh);
        zombies.splice(i, 1);
      }
      continue;
    }
    if (z.flash > 0) {
      z.flash -= dt;
      const on = z.flash > 0;
      for (let k = 0; k < z.mats.length; k++) {
        z.mats[k].color.copy(z.matsBaseColor[k]);
        if (on) z.mats[k].color.lerp(new THREE.Color(0xff6a60), 0.55);
      }
      if (!on) for (let k = 0; k < z.mats.length; k++) z.mats[k].color.copy(z.matsBaseColor[k]);
    }
    if (z.stagger > 0) z.stagger -= dt;
    if (z.kbx || z.kby) {
      z.x += z.kbx * dt;
      z.y += z.kby * dt;
      const f = Math.exp(-7 * dt);
      z.kbx *= f; z.kby *= f;
      if (Math.abs(z.kbx) < 1) z.kbx = 0;
      if (Math.abs(z.kby) < 1) z.kby = 0;
    }
    if (z.state === 'climb') {
      updateClimb(z, dt);
      z.mesh.position.set(z.x, z.h, z.y);
      z.mesh.rotation.y = yawFromAngle(z.face);
      // climb pose: arms up
      z.armPivot[0].rotation.x = -2.4 + Math.sin(game.time * 8) * 0.2;
      z.armPivot[1].rotation.x = -2.4 - Math.sin(game.time * 8) * 0.2;
      z.elbowPivot[0].rotation.x = -1.1;
      z.elbowPivot[1].rotation.x = -1.1;
      z.legPivot[0].rotation.x = Math.sin(game.time * 9) * 0.4;
      z.legPivot[1].rotation.x = -Math.sin(game.time * 9) * 0.4;
      z.kneePivot[0].rotation.x = 0.7;
      z.kneePivot[1].rotation.x = 0.7;
      continue;
    }

    z.face = angleTo(z.x, z.y, player.x, player.y);
    z.growlT -= dt;
    if (z.growlT <= 0) {
      z.growlT = rand(2.5, 7);
      const vol = posVol(z.x, z.y) * 0.16;
      if (vol > 0.02) audio.growl(vol);
    }

    const d = dist(z.x, z.y, player.x, player.y);
    let moving = 0;
    if (z.state === 'attack') {
      z.windup -= dt;
      z.x += Math.cos(z.face) * 70 * dt;
      z.y += Math.sin(z.face) * 70 * dt;
      z.armPivot[0].rotation.x = -2.2;
      z.armPivot[1].rotation.x = -2.2;
      z.elbowPivot[0].rotation.x = -0.25;
      z.elbowPivot[1].rotation.x = -0.25;
      z.kneePivot[0].rotation.x = 0.35;
      z.kneePivot[1].rotation.x = 0.35;
      if (z.windup <= 0) {
        if (d < z.r + player.r + 24 && !player.downed) hurtPlayer(ZOMB.damage(game.round), z.x, z.y);
        z.state = 'walk';
        z.atkCd = rand(0.85, 1.15);
      }
    } else {
      if (z.atkCd > 0) z.atkCd -= dt;

      // surround behaviour: pick the least crowded approach sector every so often
      z.flankT -= dt;
      if (d < 460 && z.flankT <= 0) {
        z.flankT = rand(0.45, 0.9);
        const sectors = [0, 0, 0, 0, 0, 0, 0, 0];
        for (const o of zombies) {
          if (o === z || o.state === 'dead') continue;
          if (dist(o.x, o.y, player.x, player.y) > 420) continue;
          const a = normAng(angleTo(player.x, player.y, o.x, o.y));
          sectors[(Math.floor(((a + Math.PI) / TAU) * 8) % 8 + 8) % 8]++;
        }
        const hereRaw = Math.floor(((normAng(angleTo(player.x, player.y, z.x, z.y)) + Math.PI) / TAU) * 8) % 8;
        const hereSector = (hereRaw + 8) % 8;
        let bestS = hereSector, bestW = 1e9;
        for (let si = 0; si < 8; si++) {
          const ring = Math.min((si - hereSector + 8) % 8, (hereSector - si + 8) % 8);
          const w = sectors[si] + ring * 0.16;
          if (w < bestW) { bestW = w; bestS = si; }
        }
        z.flank = (bestS / 8) * TAU - Math.PI + rand(-0.18, 0.18);
      }

      let tx = player.x, ty = player.y;
      if (d > 460) {
        const step = nav.step(z.x, z.y);
        if (step) { tx = step.x; ty = step.y; }
      } else if (d > 130) {
        const ring = (player.r + z.r + 10) * 2;
        const fx2 = player.x + Math.cos(z.flank) * ring;
        const fy2 = player.y + Math.sin(z.flank) * ring;
        if (nav.isWalkable(fx2, fy2)) { tx = fx2; ty = fy2; }
        else {
          const step = nav.step(z.x, z.y);
          if (step) { tx = step.x; ty = step.y; }
        }
      }

      // stuck detection: sidestep for a moment instead of grinding into a wall
      z.checkT -= dt;
      if (z.checkT <= 0) {
        z.checkT = 0.6;
        const moved = Math.hypot(z.x - z.lx, z.y - z.ly);
        if (d > 90 && moved < 8) { z.detour = rand(0.45, 0.85); z.detourSide = chance(0.5) ? 1 : -1; }
        z.lx = z.x;
        z.ly = z.y;
      }
      if (z.detour > 0) {
        z.detour -= dt;
        const a = angleTo(z.x, z.y, player.x, player.y) + z.detourSide * 1.15;
        tx = z.x + Math.cos(a) * 90;
        ty = z.y + Math.sin(a) * 90;
      }

      let dx = tx - z.x, dy = ty - z.y;
      const dl = Math.hypot(dx, dy) || 1;
      dx /= dl; dy /= dl;

      let sx = 0, sy = 0;
      for (const o of zombies) {
        if (o === z || o.state === 'dead') continue;
        const ddx = z.x - o.x, ddy = z.y - o.y;
        const dd2 = ddx * ddx + ddy * ddy;
        const rr = z.r + o.r + 6;
        if (dd2 < rr * rr && dd2 > 0.01) {
          const dd = Math.sqrt(dd2);
          sx += (ddx / dd) * ((rr - dd) / rr);
          sy += (ddy / dd) * ((rr - dd) / rr);
        }
      }
      let vx = dx + sx * 1.7, vy = dy + sy * 1.7;
      const vl = Math.hypot(vx, vy) || 1;
      vx /= vl; vy /= vl;

      // arrive steering: ramp speed down right next to the player instead of shoving
      const arrive = clamp((d - (z.r + player.r)) / 90, 0.35, 1);
      const spd = z.speed * arrive * (z.stagger > 0 ? 0 : 1) * (player.downed ? 0.55 : 1);
      z.x += vx * spd * dt;
      z.y += vy * spd * dt;
      moving = spd;
      for (const r of map.solidList) circleRectResolve(z, r);

      const pd = dist(z.x, z.y, player.x, player.y);
      const rr = z.r + player.r;
      if (pd < rr && pd > 0.01) {
        z.x += ((z.x - player.x) / pd) * (rr - pd);
        z.y += ((z.y - player.y) / pd) * (rr - pd);
      }

      if (d < z.r + player.r + 8 && z.atkCd <= 0 && !player.downed) {
        z.state = 'attack';
        z.windup = 0.32;
      }
      // walk animation: hips/knees + shoulders/elbows, with a head sway
      z.walkPhase += spd * dt * 0.05;
      const sw = Math.sin(z.walkPhase) * 0.55;
      z.legPivot[0].rotation.x = sw;
      z.legPivot[1].rotation.x = -sw;
      z.kneePivot[0].rotation.x = Math.max(0, -sw) * 1.15;
      z.kneePivot[1].rotation.x = Math.max(0, sw) * 1.15;
      z.armPivot[0].rotation.x = -1.25 + Math.sin(z.walkPhase + 1) * 0.18;
      z.armPivot[1].rotation.x = -1.25 + Math.sin(z.walkPhase + 2.2) * 0.18;
      z.elbowPivot[0].rotation.x = -0.5 + Math.sin(z.walkPhase + 1) * 0.14;
      z.elbowPivot[1].rotation.x = -0.5 + Math.sin(z.walkPhase + 2.2) * 0.14;
      z.pivot.position.y = Math.abs(Math.sin(z.walkPhase)) * 3;
      z.headMesh.rotation.z = Math.sin(z.walkPhase * 0.7) * 0.07;
      if (z.flinch > 0) {
        z.flinch -= dt;
        const f = Math.max(0, z.flinch / 0.16);
        z.pivot.rotation.z = Math.sin(f * 26) * 0.16 * f;
        z.pivot.position.x = Math.sin(f * 34) * 2.2 * f;
        z.pivot.scale.setScalar(1 + 0.07 * f);
      } else {
        z.pivot.rotation.z = Math.sin(z.walkPhase * 0.5) * 0.05;
        z.pivot.position.x = 0;
        z.pivot.scale.setScalar(1);
      }
    }
    z.mesh.position.set(z.x, Math.max(0, z.h), z.y);
    z.mesh.rotation.y = yawFromAngle(z.face);
  }
}

// ------------------------------------------------------------------ shooting
const raycaster = new THREE.Raycaster();
const _camDir = new THREE.Vector3();
const _camPos = new THREE.Vector3();
const _tmpV = new THREE.Vector3();

function zombieMeshes() {
  const list = [];
  for (const z of zombies) {
    if (z.state === 'dead') continue;
    for (const m of z.hitMeshes) list.push(m);
  }
  return list;
}

function castShot(spreadRad) {
  camera.updateMatrixWorld(true);
  camera.getWorldDirection(_camDir);
  _camPos.copy(camera.position);
  const dir = _camDir.clone();
  if (spreadRad) {
    dir.x += rand(-spreadRad, spreadRad);
    dir.y += rand(-spreadRad, spreadRad);
    dir.z += rand(-spreadRad, spreadRad);
    dir.normalize();
  }
  raycaster.set(_camPos, dir);
  raycaster.far = 3200;
  const zHits = raycaster.intersectObjects(zombieMeshes(), false);
  const wHits = raycaster.intersectObjects(worldColliders, false);
  const zHit = zHits[0];
  const wHit = wHits[0];
  if (zHit && (!wHit || zHit.distance <= wHit.distance)) {
    const z = zHit.object.userData.zombie;
    const part = zHit.object.userData.part;
    return { kind: 'zombie', zombie: z, headshot: part === 'head', point: zHit.point, dist: zHit.distance };
  }
  if (wHit) {
    const n = wHit.face ? wHit.face.normal.clone().transformDirection(wHit.object.matrixWorld) : new THREE.Vector3(0, 1, 0);
    return { kind: 'world', point: wHit.point, normal: n, dist: wHit.distance };
  }
  return { kind: 'none', point: _camPos.clone().addScaledVector(dir, 1500), dist: 1500 };
}

function muzzleWorld() {
  if (!viewmodel || !viewmodel.muzzle) return camera.position.clone();
  viewmodel.group.updateMatrixWorld(true);
  return viewmodel.muzzle.getWorldPosition(new THREE.Vector3());
}

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

  // spread bloom: the first shot is accurate, sustained fire opens up and recovers fast
  const bloomNow = player.bloom;
  player.bloom = clamp(player.bloom + clamp(600 / st.rpm, 0.05, 0.26) * (st.cls === 'mg' ? 1.2 : 1), 0, 1);
  player.flash = 0.05;
  const kickUp = st.cls === 'shotgun' ? 0.032 : st.cls === 'mg' ? 0.014 : 0.017;
  player.recoilPitch = Math.min(0.09, player.recoilPitch + kickUp * (1 - 0.45 * player.adsT));
  player.recoilYaw = clamp(player.recoilYaw + rand(-1, 1) * kickUp * 0.6, -0.05, 0.05);
  addTrauma(st.cls === 'shotgun' ? 0.34 : st.cls === 'mg' ? 0.13 : 0.1);
  muzzleLight.intensity = st.cls === 'shotgun' ? 26 : 15;
  if (viewmodel) viewmodel.kick = 1;

  if (st.cls === 'thunder') { thunderBlast(st); return; }
  if (st.cls === 'ray' || st.cls === 'rocket') {
    audio.shot(st.cls);
    const muzzle = muzzleWorld();
    camera.getWorldDirection(_camDir);
    const dir = _camDir.clone();
    const spread = ((st.spread * Math.PI) / 180) * (0.3 + bloomNow * 1.9) * (1 - 0.7 * player.adsT);
    dir.x += rand(-spread, spread);
    dir.y += rand(-spread, spread);
    dir.z += rand(-spread, spread);
    dir.normalize();
    const mesh = new THREE.Mesh(
      new THREE.SphereGeometry(st.cls === 'ray' ? 7 : 5, 12, 10),
      new THREE.MeshStandardMaterial({
        color: st.cls === 'ray' ? 0x8dff8a : 0x2e2e33,
        emissive: st.cls === 'ray' ? 0x55ff66 : 0x000000,
        emissiveIntensity: 2,
      }),
    );
    if (st.cls === 'ray') mesh.add(new THREE.PointLight(0x66ff88, 20, 460, 1.6));
    scene.add(mesh);
    projectiles.push({
      x: muzzle.x, y: muzzle.z, h: muzzle.y,
      vx: dir.x * st.speed, vy: dir.z * st.speed, vh: dir.y * st.speed,
      life: 4, mesh, splash: st.splash, kind: st.cls, direct: st.dmg, trailT: 0,
    });
    return;
  }
  audio.shot(st.cls);
  const muzzle = muzzleWorld();
  const spread = ((st.spread * Math.PI) / 180) * (0.3 + bloomNow * 1.9) * (1 - 0.7 * player.adsT);
  for (let i = 0; i < st.pellets; i++) {
    const hit = castShot(spread);
    if (hit.kind === 'zombie') {
      const falloff = 1 - 0.45 * clamp((hit.dist - 1300) / 1500, 0, 1);
      const dmg = st.dmg * falloff * (hit.headshot ? 2 : 1);
      applyDamage(hit.zombie, dmg, hit.headshot, {});
      bloodBurst(hit.point.x, hit.point.z, clamp(hit.point.y, 60, 220), hit.headshot ? 9 : 6);
    } else if (hit.kind === 'world') {
      spawnHole(hit.point, hit.normal);
      for (let k = 0; k < 3; k++) {
        spawnPart(hit.point.x, hit.point.z, hit.point.y, rand(-90, 90), rand(-90, 90), rand(-60, 120), rand(0.08, 0.2), 2.5, 0xffe9a8);
      }
    }
    spawnTracer(muzzle, hit.point, 0xffe9a8);
  }
}

function thunderBlast(st) {
  audio.thunderShot();
  addTrauma(0.6);
  camera.getWorldDirection(_camDir);
  const a0 = Math.atan2(_camDir.z, _camDir.x);
  flashLight.position.set(player.x + Math.cos(a0) * 120, 140, player.y + Math.sin(a0) * 120);
  flashLight.color.setHex(0xbfefff);
  flashLight.intensity = 80;
  spawnRing(player.x, player.y, st.wedge.range, 0xbfefff, 0.35);
  for (let i = 0; i < 16; i++) {
    const a = a0 + rand(-st.wedge.halfAngle, st.wedge.halfAngle);
    spawnPart(player.x, player.y, rand(60, 160), Math.cos(a) * rand(300, 700), Math.sin(a) * rand(300, 700), rand(-40, 80), rand(0.12, 0.3), 3, 0xdff6ff);
  }
  if (viewmodel) viewmodel.kick = 1.4;
  for (const z of zombies) {
    if (z.state === 'dead') continue;
    const d = dist(player.x, player.y, z.x, z.y);
    if (d > st.wedge.range + z.r) continue;
    const da = Math.abs(normAng(angleTo(player.x, player.y, z.x, z.y) - a0));
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
  if (player.downed || player.swapT > 0 || player.grenades <= 0) {
    if (player.grenades <= 0) audio.deny();
    return;
  }
  player.grenades--;
  camera.getWorldDirection(_camDir);
  grenades.push({
    x: player.x + _camDir.x * 14,
    y: player.y + _camDir.z * 14,
    h: EYE_H - 30,
    vx: _camDir.x * GRENADE.speed,
    vy: _camDir.z * GRENADE.speed,
    vh: _camDir.y * GRENADE.speed + 150,
    fuse: GRENADE.fuse,
    mesh: (() => {
      const g = new THREE.Mesh(
        new THREE.SphereGeometry(6, 10, 8),
        new THREE.MeshStandardMaterial({ color: 0x3c4a2e, roughness: 0.8 }),
      );
      g.castShadow = true;
      scene.add(g);
      return g;
    })(),
    trailT: 0,
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
    const da = Math.abs(normAng(angleTo(player.x, player.y, z.x, z.y) - player.aimAngle));
    if (da > 1.05) continue;
    hit = true;
    const a = angleTo(player.x, player.y, z.x, z.y);
    z.kbx += Math.cos(a) * 120;
    z.kby += Math.sin(a) * 120;
    if (player.power.insta > 0 || z.hp <= KNIFE.dmg) killZombie(z, false, { points: POINTS.knifeKill });
    else applyDamage(z, KNIFE.dmg, false, {});
    break;
  }
  audio[hit ? 'knifeHit' : 'knifeSwing']();
}

function hurtPlayer(dmg, srcX, srcY) {
  if (player.downed || game.state !== 'playing') return;
  player.hp -= dmg;
  player.regenT = 5;
  player.hurtT = 0.5;
  addTrauma(0.4);
  audio.playerHurt();
  if (srcX !== undefined && srcY !== undefined) {
    player.dmgDirs.push({ a: angleTo(player.x, player.y, srcX, srcY), t: 1.5 });
    if (player.dmgDirs.length > 4) player.dmgDirs.shift();
  }
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

// ------------------------------------------------------------------ projectiles / grenades
function updateProjectiles(dt) {
  for (let i = projectiles.length - 1; i >= 0; i--) {
    const p = projectiles[i];
    p.life -= dt;
    const speed = Math.hypot(p.vx, p.vy, p.vh);
    const steps = Math.max(1, Math.ceil((speed * dt) / 9));
    const sdt = dt / steps;
    let done = false;
    for (let s = 0; s < steps && !done; s++) {
      const nx = p.x + p.vx * sdt;
      const ny = p.y + p.vy * sdt;
      const nh = p.h + p.vh * sdt;
      let blocked = false;
      if (pointInRect(nx, ny, { x: 0, y: 0, w: map.w, h: map.h })) {
        for (const r of map.solidList) {
          if (pointInRect(nx, ny, r)) { blocked = true; break; }
        }
      } else blocked = true;
      let hitZ = null;
      if (!blocked) {
        for (const z of zombies) {
          if (z.state === 'dead') continue;
          if (dist(nx, ny, z.x, z.y) < z.r + 12) { hitZ = z; break; }
        }
      }
      p.x = nx; p.y = ny; p.h = nh;
      if (blocked || hitZ) {
        explode(p.x, p.y, p.h, p.splash.r, p.splash.dmg, p.kind === 'ray' ? 'ray' : 'rocket', p.splash.self || 0);
        if (hitZ) applyDamage(hitZ, p.direct || 0, false, { hitPoints: false });
        scene.remove(p.mesh);
        projectiles.splice(i, 1);
        done = true;
      }
    }
    if (done) continue;
    if (p.life <= 0) {
      explode(p.x, p.y, p.h, p.splash.r, p.splash.dmg, p.kind === 'ray' ? 'ray' : 'rocket', p.splash.self || 0);
      scene.remove(p.mesh);
      projectiles.splice(i, 1);
      continue;
    }
    p.mesh.position.set(p.x, p.h, p.y);
    if (p.kind === 'rocket') {
      p.trailT -= dt;
      if (p.trailT <= 0) {
        p.trailT = 0.03;
        spawnPart(p.x, p.y, p.h, rand(-20, 20), rand(-20, 20), rand(-10, 10), 0.5, rand(4, 8), 0x9a9aa0, THREE.NormalBlending);
      }
    }
  }
}

function updateGrenades(dt) {
  for (let i = grenades.length - 1; i >= 0; i--) {
    const g = grenades[i];
    g.fuse -= dt;
    const speed = Math.hypot(g.vx, g.vy, g.vh) || 1;
    const steps = Math.max(1, Math.ceil((speed * dt) / 8));
    const sdt = dt / steps;
    for (let s = 0; s < steps; s++) {
      g.vh -= 900 * sdt;
      const nx = g.x + g.vx * sdt;
      const ny = g.y + g.vy * sdt;
      let blockedX = false, blockedY = false;
      if (pointInRect(nx, g.y, { x: 0, y: 0, w: map.w, h: map.h })) {
        for (const r of map.solidList) if (pointInRect(nx, g.y, r)) { blockedX = true; break; }
      } else blockedX = true;
      if (pointInRect(g.x, ny, { x: 0, y: 0, w: map.w, h: map.h })) {
        for (const r of map.solidList) if (pointInRect(g.x, ny, r)) { blockedY = true; break; }
      } else blockedY = true;
      if (blockedX) g.vx *= -0.5; else g.x = nx;
      if (blockedY) g.vy *= -0.5; else g.y = ny;
      g.h += g.vh * sdt;
      if (g.h < 6) { g.h = 6; g.vh = -g.vh * 0.35; }
      const f = Math.exp(-1.4 * sdt);
      g.vx *= f; g.vy *= f;
    }
    g.trailT -= dt;
    if (g.trailT <= 0) {
      g.trailT = 0.05;
      spawnPart(g.x, g.y, g.h, 0, 0, rand(-10, 10), 0.3, 3, g.fuse < 0.5 && Math.sin(game.time * 40) > 0 ? 0xff4040 : 0x666666, THREE.NormalBlending);
    }
    g.mesh.position.set(g.x, g.h, g.y);
    if (g.fuse <= 0) {
      explode(g.x, g.y, g.h, GRENADE.r, GRENADE.dmg, 'grenade', GRENADE.self);
      scene.remove(g.mesh);
      grenades.splice(i, 1);
    }
  }
}

// ------------------------------------------------------------------ pickups
function spawnPickup(x, y) {
  const type = rollPowerup();
  const def = POWERUPS[type];
  const sprite = new THREE.Sprite(new THREE.SpriteMaterial({
    map: textTexture(def.letter, { font: `bold 120px ${FONT}`, color: def.color, w: 256, h: 256 }),
    transparent: true, depthWrite: false, fog: false,
  }));
  sprite.scale.set(46, 46, 1);
  sprite.position.set(x, 70, y);
  scene.add(sprite);
  const light = new THREE.PointLight(def.color, 20, 400, 1.7);
  light.position.set(x, 90, y);
  scene.add(light);
  pickups.push({ x, y, type, t: 0, life: 32, sprite, light });
}

function applyPickup(p) {
  const def = POWERUPS[p.type];
  audio.powerup(p.type);
  banner(def.label, '', 1.8, def.color, 56);
  switch (p.type) {
    case 'maxammo':
      for (const w of player.weapons) if (w) w.reserve = statsOf(w).reserve;
      break;
    case 'instakill': player.power.insta = 30; break;
    case 'double': player.power.double = 30; break;
    case 'nuke': {
      game.flashWhite = 0.6;
      addTrauma(1);
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
    if (p.t > p.life) {
      scene.remove(p.sprite);
      scene.remove(p.light);
      pickups.splice(i, 1);
      continue;
    }
    p.sprite.position.y = 70 + Math.sin(p.t * 3) * 8;
    p.sprite.material.opacity = (p.t > p.life - 6 && Math.sin(p.t * 14) > 0) ? 0.25 : 1;
    if (dist(p.x, p.y, player.x, player.y) < player.r + 24 && !player.downed) {
      applyPickup(p);
      scene.remove(p.sprite);
      scene.remove(p.light);
      pickups.splice(i, 1);
    }
  }
}

// ------------------------------------------------------------------ interact / economy
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
    if (dd < 80) consider('door', d, d.rect.x + d.rect.w / 2, d.rect.y + d.rect.h / 2, dd, 'OPEN DOOR', d.cost, 0);
  }
  for (const b of map.buys) {
    const dd = rectDistPoint(px, py, { x: b.x - 16, y: b.y - 16, w: 32, h: 32 });
    if (dd < 76) {
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
    if (dd < 82) consider('perk', p, p.x, p.y, dd, 'BUY ' + p.name.toUpperCase(), p.cost, 1.2);
  }
  {
    const b = map.box;
    const dd = rectDistPoint(px, py, b.rect);
    if (dd < 86 && game.box.state === 'idle') consider('box', b, b.x, b.y, dd, 'MYSTERY BOX', b.cost, 1.0);
  }
  {
    const p = map.pap;
    const dd = rectDistPoint(px, py, p.rect);
    if (dd < 90) {
      const w = curWeapon();
      consider('pap', p, p.x, p.y, dd, w && w.pap ? 'ALREADY UPGRADED' : 'PACK-A-PUNCH', p.cost, 2.2);
    }
  }
  for (const w of map.windows) {
    if (w.boards >= 6) continue;
    const dd = dist(px, py, w.x, w.y);
    if (dd < 82) consider('window', w, w.x, w.y, dd, 'REPAIR WINDOW', 0, 0.34);
  }
  return best;
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
  rebuildViewmodel();
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
      const dg = doorGroups.find((g) => g.door === t.ref);
      if (dg) dg.opening = true;
      audio.doorOpen();
      addTrauma(0.25);
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
      rebuildViewmodel();
      audio.pap();
      banner('WEAPON UPGRADED', statsOf(w).name.toUpperCase(), 2.0, '#f5c542', 46);
      for (let i = 0; i < 20; i++) {
        spawnPart(t.x + rand(-30, 30), t.y + rand(-30, 30), rand(60, 200), rand(-40, 40), rand(-40, 40), rand(40, 160), rand(0.4, 0.9), 3, 0xf5e07a);
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
  const changed = !(h.target && target && h.target.type === target.type && h.target.ref === target.ref);
  h.target = target;
  if (changed) { h.t = 0; h.tick = 0; }
  if (target && keys.KeyF && !player.downed) {
    if (target.hold <= 0) executeInteract(target);
    else {
      h.t += dt;
      h.tick -= dt;
      if (h.tick <= 0) { h.tick = 0.22; audio.interactTick(); }
      if (h.t >= target.hold) { h.t = 0; executeInteract(target); }
    }
  } else {
    h.t = 0;
  }
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
  const box = map.box;
  if (b.state !== 'spin') return;
  b.t -= dt;
  b.cycleT -= dt;
  if (b.cycleT <= 0) {
    b.cycleT = 0.11;
    b.cycleIdx++;
    const name = BOX_NAMES[b.cycleIdx % BOX_NAMES.length];
    if (box._sprite.material.map) box._sprite.material.map.dispose();
    box._sprite.material.map = textTexture(name, { font: `bold 54px ${FONT}`, color: '#f5e07a', w: 1024, h: 128 });
    box._sprite.material.needsUpdate = true;
    box._sprite.scale.set(210, 26, 1);
  }
  if (b.t <= 0) {
    b.state = 'idle';
    if (box._sprite.material.map) box._sprite.material.map.dispose();
    box._sprite.material.map = textTexture('?', { font: `bold 140px ${FONT}`, color: '#f5c542', w: 256, h: 256 });
    box._sprite.material.needsUpdate = true;
    box._sprite.scale.set(70, 70, 1);
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

// ------------------------------------------------------------------ viewmodel
let viewmodel = null;

function buildGunGroup(cls, pap) {
  const group = new THREE.Group();
  const dark = new THREE.MeshStandardMaterial({ color: pap ? 0x8a6a1e : 0x212127, roughness: 0.55, metalness: 0.35, envMapIntensity: 0.18 });
  const mid = new THREE.MeshStandardMaterial({ color: pap ? 0xaa8630 : 0x2f2f36, roughness: 0.62, metalness: 0.3, envMapIntensity: 0.18 });
  const glowMat = new THREE.MeshStandardMaterial({ color: 0x8dff8a, emissive: 0x3fbf50, emissiveIntensity: 1.6, roughness: 0.4 });
  const g = new THREE.Group();
  const box = (w, h, d, x, y, z, mat = dark) => {
    const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat);
    m.position.set(x, y, z);
    g.add(m);
    return m;
  };
  let muzzleZ = -34;
  switch (cls) {
    case 'pistol':
      box(7, 9, 22, 0, 1, -12);
      box(6, 14, 9, 0, -9, -4);
      box(4, 4, 8, 0, 1, -26);
      muzzleZ = -31;
      break;
    case 'smg':
      box(8, 9, 30, 0, 1, -18);
      box(6, 16, 8, 0, -10, -12);
      box(5, 5, 12, 0, 1, -38);
      box(6, 6, 10, 0, 0, 2);
      box(3, 3, 16, 0, 6, -20, mid);      // top rail
      box(2, 4, 2, 0, 8, -34, mid);       // front sight
      muzzleZ = -45;
      break;
    case 'rifle':
      box(7, 8, 38, 0, 1, -22);
      box(5, 12, 8, 0, -8, -16);
      box(5, 6, 26, 0, 3, -20);
      box(4, 4, 12, 0, 1, -46);
      box(3, 3, 20, 0, 8, -24, mid);
      box(2, 4, 2, 0, 10, -38, mid);
      muzzleZ = -53;
      break;
    case 'shotgun':
      box(9, 8, 40, 0, 1, -24);
      box(6, 6, 30, 0, 6, -26);
      box(8, 10, 12, 0, -6, -12);
      muzzleZ = -46;
      break;
    case 'mg':
      box(9, 10, 44, 0, 1, -24);
      box(14, 14, 14, 0, -10, -14);
      box(5, 5, 16, 0, 1, -50);
      box(6, 7, 12, 0, -2, 6);
      box(3, 3, 24, 0, 7, -28, mid);
      muzzleZ = -58;
      break;
    case 'ray':
      box(8, 9, 26, 0, 1, -16);
      box(6, 14, 9, 0, -10, -8);
      {
        const orb = new THREE.Mesh(new THREE.SphereGeometry(6, 12, 10), glowMat);
        orb.position.set(0, 2, -32);
        g.add(orb);
        const light = new THREE.PointLight(0x66ff88, 10, 300, 2);
        light.position.copy(orb.position);
        g.add(light);
      }
      muzzleZ = -39;
      break;
    case 'thunder':
      {
        const barrel = new THREE.Mesh(new THREE.CylinderGeometry(9, 12, 40, 12), mid);
        barrel.rotation.x = Math.PI / 2;
        barrel.position.set(0, 1, -22);
        g.add(barrel);
        const mouth = new THREE.Mesh(new THREE.CylinderGeometry(15, 9, 14, 12), dark);
        mouth.rotation.x = Math.PI / 2;
        mouth.position.set(0, 1, -46);
        g.add(mouth);
        box(8, 10, 14, 0, -8, -8);
      }
      muzzleZ = -53;
      break;
    case 'rocket':
      {
        const tube = new THREE.Mesh(new THREE.CylinderGeometry(9, 9, 52, 12), mid);
        tube.rotation.x = Math.PI / 2;
        tube.position.set(0, 1, -28);
        g.add(tube);
        const tip = new THREE.Mesh(new THREE.ConeGeometry(7, 14, 12), dark);
        tip.rotation.x = -Math.PI / 2;
        tip.position.set(0, 1, -58);
        g.add(tip);
        box(6, 12, 10, 0, -9, -12);
      }
      muzzleZ = -64;
      break;
  }
  group.add(g);
  const muzzle = new THREE.Object3D();
  muzzle.position.set(0, 1, muzzleZ - 2);
  group.add(muzzle);
  group.userData.muzzle = muzzle;
  return group;
}

const VM_CLASSES_UNUSED = null;

function rebuildViewmodel() {
  const w = curWeapon();
  if (!w) return;
  const st = statsOf(w);
  const key = w.id + (w.pap ? ':pap' : '');
  if (viewmodel && viewmodel.key === key) return;
  if (viewmodel) {
    camera.remove(viewmodel.group);
    viewmodel.group.traverse((o) => {
      if (o.geometry) o.geometry.dispose();
      if (o.material && o.material.dispose) o.material.dispose();
    });
    viewmodel = null;
  }
  const group = buildGunGroup(st.cls, !!w.pap);
  const base = new THREE.Vector3(26, -22, -30);
  group.position.copy(base);
  camera.add(group);
  viewmodel = {
    key,
    group,
    muzzle: group.userData.muzzle,
    base,
    kick: 0,
    cls: st.cls,
  };
}

function updateViewmodel(dt) {
  if (!viewmodel) return;
  const vm = viewmodel;
  vm.kick = Math.max(0, vm.kick - dt * 7);
  const p = player;
  const reloading = !!p.reload;
  const reloadT = reloading ? 1 - player.reload.t / player.reload.total : 0;
  const swapT = clamp(player.swapT / 0.45, 0, 1);
  const ads = p.adsT;
  const bob = p.moving ? Math.sin(p.bobT) * 1.6 * (1 - ads) : 0;
  const bobY = p.moving ? Math.abs(Math.sin(p.bobT * 2)) * 1.4 * (1 - ads) : 0;
  const g = vm.group;
  // hip position -> centred aim-down-sights position
  const baseX = lerp(vm.base.x, 0, ads);
  const baseY = lerp(vm.base.y, -16, ads);
  const baseZ = lerp(vm.base.z, -40, ads);
  g.position.set(
    baseX + bob,
    baseY - bobY - swapT * 26 - (reloading ? Math.sin(Math.PI * reloadT) * 10 : 0),
    baseZ + vm.kick * 5 * (1 - 0.5 * ads),
  );
  g.rotation.set(
    -0.04 + vm.kick * 0.13 * (1 - 0.5 * ads) + (reloading ? -Math.sin(Math.PI * reloadT) * 0.7 : 0) + (vm.cls === 'pistol' ? 0 : -0.02) - 0.03 * ads,
    -0.08 * (1 - ads),
    swapT * 0.5,
  );
  // knife anim: viewmodel swings out
  if (player.knifeT > 0) {
    const t = 1 - player.knifeT / 0.18;
    g.rotation.z = 0.5 - t * 1.4;
    g.position.x = vm.base.x - 14 + t * 26;
  }
}

// ------------------------------------------------------------------ input
const keys = {};
const mouse = { down: false, fresh: false };
let locked = false;
let wasLocked = false;
let lastLockTry = 0;
let suppressShot = false;   // the click that starts/resumes the game shouldn't also fire

function addLook(dx, dy) {
  const sens = 0.0021 * settings.sens;
  player.yaw -= dx * sens;
  player.pitch = clamp(player.pitch - dy * sens, -1.45, 1.45);
}

function tryLock(force = false) {
  const now = performance.now();
  if (!force && now - lastLockTry < 900) return;
  lastLockTry = now;
  try {
    const p = canvas.requestPointerLock();
    if (p && p.catch) p.catch(() => {});
  } catch (e) { /* pointer lock unavailable — drag-look + arrow keys still work */ }
}

const HINT_CAPTURE = '🖱 CLICK TO CAPTURE THE MOUSE <span>— or drag / arrow keys to look</span>';
const HINT_BLOCKED = 'MOUSE CAPTURE BLOCKED <span>— drag to look, or use arrow keys · click still shoots</span>';

document.addEventListener('pointerlockchange', () => {
  locked = document.pointerLockElement === canvas;
  document.body.classList.toggle('locked', locked);
  if (locked) {
    wasLocked = true;
    hideHint();
  } else if (game.state === 'playing') {
    if (wasLocked) pauseGame();
    else showHint(HINT_CAPTURE);
  }
});
document.addEventListener('pointerlockerror', () => {
  if (game.state === 'playing') showHint(HINT_BLOCKED);
});

window.addEventListener('mousemove', (e) => {
  if (game.state !== 'playing') return;
  if (locked) addLook(e.movementX || 0, e.movementY || 0);
  else if (mouse.down) addLook(e.movementX || 0, e.movementY || 0); // drag-look fallback
});

// any pointerdown can start / resume / capture — robust across overlays and webviews
window.addEventListener('pointerdown', (e) => {
  audio.unlock();
  if (game.state === 'title' || game.state === 'gameover') {
    suppressShot = true;
    startGame();
    return;
  }
  if (game.state === 'paused') {
    if (!e.target.closest || !e.target.closest('.settings')) {
      suppressShot = true;
      resumeGame();
    }
    return;
  }
  if (game.state === 'playing' && !locked) tryLock();
});

window.addEventListener('mousedown', (e) => {
  audio.unlock();
  if (game.state !== 'playing') return;
  if (e.button === 0) {
    if (suppressShot) { suppressShot = false; return; }
    mouse.down = true;
    mouse.fresh = true;
    tryFire(); // instant shot — clicks are never dropped between frames
  }
  if (e.button === 2) player.ads = true;   // aim down sights
});
window.addEventListener('mouseup', (e) => {
  if (e.button === 0) { mouse.down = false; mouse.fresh = false; }
  if (e.button === 2) player.ads = false;
});
window.addEventListener('contextmenu', (e) => e.preventDefault());
window.addEventListener('wheel', () => { if (game.state === 'playing') swapWeapon(); }, { passive: true });

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
    case 'F2': nextQuality(); break;
  }
});
window.addEventListener('keyup', (e) => { keys[e.code] = false; });
window.addEventListener('blur', () => { if (game.state === 'playing') pauseGame(); });
document.addEventListener('visibilitychange', () => {
  if (document.hidden && game.state === 'playing') pauseGame();
});

// screens
function showScreen(which) {
  for (const k of ['title', 'pause', 'over']) els[k].classList.toggle('hidden', k !== which);
  document.body.classList.toggle('playing', !which);
}
els.title.addEventListener('click', () => { audio.unlock(); if (game.state === 'title') startGame(); });
els.over.addEventListener('click', () => { if (game.state === 'gameover') startGame(); });
els.pause.addEventListener('click', (e) => {
  if (game.state === 'paused' && (!e.target.closest || !e.target.closest('.settings'))) resumeGame();
});

const bestRound = {
  get() { return parseInt(localStorage.getItem('zombies_best3d') || '0', 10) || 0; },
  set(v) {
    if (v > this.get()) localStorage.setItem('zombies_best3d', String(v));
    els.best.textContent = 'BEST ROUND: ' + this.get();
  },
};
bestRound.set(0);

// ------------------------------------------------------------------ game flow
function startGame() {
  for (const d of map.doors) d.open = false;
  for (const w of map.windows) { w.boards = 6; w.climbers = 0; }
  map.rebuildSolids();
  nav.build();
  nav.timer = 0;
  for (const dg of doorGroups) {
    dg.opening = false;
    dg.openT = 0;
    dg.pivot.rotation.y = 0;
  }
  for (const z of zombies) scene.remove(z.mesh);
  for (const g of grenades) scene.remove(g.mesh);
  for (const p of projectiles) scene.remove(p.mesh);
  for (const p of pickups) { scene.remove(p.sprite); scene.remove(p.light); }
  zombies = []; grenades = []; projectiles = []; pickups = [];
  for (const m of decalPool) m.visible = false;
  for (const m of holePool) m.visible = false;
  for (const s of partPool) s.visible = false;
  for (const m of ringPool) m.visible = false;
  for (const l of tracerPool) l.visible = false;
  parts.length = 0; rings.length = 0; tracers.length = 0;

  player = makePlayer();
  game.round = 0; game.phase = 'idle'; game.phaseT = 0;
  game.toSpawn = 0; game.spawnedThisRound = 0; game.spawnTimer = 0;
  game.kills = 0; game.time = 0; game.trauma = 0; game.traumaT = 0; game.flashWhite = 0;
  hitStop = 0;
  game.banners = []; game.hitmarks = [];
  game.box = { state: 'idle', t: 0, cycleT: 0, cycleIdx: 0, result: null };
  if (map.box._sprite.material.map) map.box._sprite.material.map.dispose();
  map.box._sprite.material.map = textTexture('?', { font: `bold 140px ${FONT}`, color: '#f5c542', w: 256, h: 256 });
  map.box._sprite.material.needsUpdate = true;
  map.box._sprite.scale.set(70, 70, 1);

  rebuildViewmodel();
  game.state = 'playing';
  showScreen(null);
  audio.unlock();
  if (!locked) showHint(HINT_CAPTURE);
  tryLock(true);
  startRound(1);
}

function pauseGame() {
  if (game.state !== 'playing') return;
  player.ads = false;
  if (document.pointerLockElement === canvas) document.exitPointerLock();
  game.state = 'paused';
  hideHint();
  const alive = zombies.reduce((n, z) => n + (z.state !== 'dead' ? 1 : 0), 0);
  els.pauseStats.textContent =
    `ROUND ${Math.max(1, game.round)} · ${game.kills} KILLS · ${Math.floor(player.points)} POINTS\n${alive} ZOMBIES ON THE MAP`;
  showScreen('pause');
}
function resumeGame() {
  if (game.state !== 'paused') return;
  game.state = 'playing';
  showScreen(null);
  if (!locked) showHint(HINT_CAPTURE);
  tryLock(true);
}
function playerDie() {
  game.state = 'gameover';
  audio.gameOver();
  bestRound.set(game.round);
  if (document.pointerLockElement === canvas) document.exitPointerLock();
  els.overTitle.textContent = 'YOU DIED';
  els.overStats.textContent = `SURVIVED TO ROUND ${game.round}\n${game.kills} KILLS · ${Math.floor(player.points)} POINTS\n`;
  showScreen('over');
}

function startRound(n) {
  game.round = n;
  game.toSpawn = ZOMB.count(n);
  game.spawnedThisRound = 0;
  game.phase = 'intro';
  game.phaseT = 2.6;
  game.spawnTimer = 0.4;
  if (n === 1) banner('ROUND 1', 'SURVIVE · HOLD F TO BUY · REPAIR WINDOWS', 5, '#d8d2c4', 92);
  else banner('ROUND ' + n, '', 2.6, '#d8d2c4', 92);
  audio.roundStart();
}

// ------------------------------------------------------------------ update
function update(dt) {
  game.time += dt;
  updatePlayer(dt);
  nav.update(player.x, player.y, dt);
  updateZombies(dt);
  updateGrenades(dt);
  updateProjectiles(dt);
  updateParts(dt);
  updatePickups(dt);
  updateRound(dt);
  updateInteract(dt);
  updateBox(dt);
  updateDoors(dt);
  updateWindows();
  updateCamera(dt);
  updateViewmodel(dt);
  updateVisualTimers(dt);
}

function updatePlayer(dt) {
  const p = player;
  // movement relative to yaw
  const fx = -Math.sin(p.yaw), fz = -Math.cos(p.yaw);
  const rx = Math.cos(p.yaw), rz = -Math.sin(p.yaw);
  let mx = (keys.KeyD ? 1 : 0) - (keys.KeyA ? 1 : 0);
  let my = (keys.KeyW ? 1 : 0) - (keys.KeyS ? 1 : 0);
  const moving = !!(mx || my) && !p.downed;
  if (mx || my) {
    const im = 1 / Math.hypot(mx, my);
    mx *= im; my *= im;
  }
  p.moving = moving;
  p.sprinting = !!(keys.ShiftLeft || keys.ShiftRight) && moving && my > 0 && p.adsT < 0.4;
  // aim down sights: slower movement, tighter shots
  p.adsT += ((p.ads && !p.downed && !p.reload ? 1 : 0) - p.adsT) * (1 - Math.exp(-11 * dt));
  const spd = (p.sprinting ? 330 : 210) * (1 - 0.45 * p.adsT);
  if (moving) {
    p.x += (rx * mx + fx * my) * spd * dt;
    p.y += (rz * mx + fz * my) * spd * dt;
    p.bobT += dt * (p.sprinting ? 11 : 8);
  }
  for (const r of map.solidList) circleRectResolve(p, r);
  p.x = clamp(p.x, 26, map.w - 26);
  p.y = clamp(p.y, 26, map.h - 26);

  // aim angle in map space (for melee / interact / thunder)
  camera.getWorldDirection(_camDir);
  p.aimAngle = Math.atan2(_camDir.z, _camDir.x);

  // arrow keys: keyboard look fallback (works even where mouse capture is blocked)
  const lookSpd = 2.1 * (keys.ShiftLeft ? 1.6 : 1);
  if (keys.ArrowLeft) p.yaw += lookSpd * dt;
  if (keys.ArrowRight) p.yaw -= lookSpd * dt;
  if (keys.ArrowUp) p.pitch = clamp(p.pitch + 1.5 * dt, -1.45, 1.45);
  if (keys.ArrowDown) p.pitch = clamp(p.pitch - 1.5 * dt, -1.45, 1.45);

  if (p.fireCd > 0) p.fireCd -= dt;
  if (p.flash > 0) p.flash -= dt;
  if (p.knifeT > 0) p.knifeT -= dt;
  if (p.knifeCd > 0) p.knifeCd -= dt;
  if (p.swapT > 0) p.swapT -= dt;
  if (p.power.insta > 0) p.power.insta -= dt;
  if (p.power.double > 0) p.power.double -= dt;
  if (p.hurtT > 0) p.hurtT -= dt;
  p.recoilPitch = Math.max(0, p.recoilPitch - dt * 0.35);
  p.recoilYaw *= Math.exp(-6 * dt);
  p.bloom *= Math.exp(-2.8 * dt);

  // footsteps
  p.stepT -= dt;
  if (moving && p.stepT <= 0) {
    p.stepT = p.sprinting ? 0.3 : 0.45;
    p.stepAlt = !p.stepAlt;
    audio.footstep(p.sprinting ? 0.55 : 0.38, p.stepAlt);
  }
  // low-health heartbeat
  if (!p.downed && p.hp < p.maxHp * 0.35) {
    p.heartT -= dt;
    if (p.heartT <= 0) {
      p.heartT = 0.85;
      audio.heartbeat(clamp(1 - p.hp / (p.maxHp * 0.35), 0.3, 1) * 0.6);
    }
  }

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

function updateDoors(dt) {
  for (const dg of doorGroups) {
    if (!dg.opening) continue;
    dg.openT += dt;
    const t = clamp(dg.openT / 0.55, 0, 1);
    const e = t * t * (3 - 2 * t);
    dg.pivot.rotation.y = -e * 1.75;
  }
}

function updateWindows() {
  for (const w of map.windows) {
    if (w._shown === w.boards) continue;
    w._shown = w.boards;
    w._boardsGroup.children.forEach((b, i) => { b.visible = i < w.boards; });
  }
}

function updateParts(dt) {
  // dust motes drift and wrap around the player
  {
    const pos = dust.geometry.attributes.position;
    const arr = pos.array;
    for (let i = 0; i < DUST_COUNT; i++) {
      const i3 = i * 3;
      arr[i3] += dustVel[i3] * dt;
      arr[i3 + 1] += dustVel[i3 + 1] * dt;
      arr[i3 + 2] += dustVel[i3 + 2] * dt;
      if (arr[i3] - player.x > 560) arr[i3] -= 1120;
      else if (player.x - arr[i3] > 560) arr[i3] += 1120;
      if (arr[i3 + 1] < 8) arr[i3 + 1] = 280;
      else if (arr[i3 + 1] > 290) arr[i3 + 1] = 10;
      if (arr[i3 + 2] - player.y > 560) arr[i3 + 2] -= 1120;
      else if (player.y - arr[i3 + 2] > 560) arr[i3 + 2] += 1120;
    }
    pos.needsUpdate = true;
    dust.material.opacity = 0.16 + (flashlight.intensity / 1400) * 0.12;
  }
  for (let i = parts.length - 1; i >= 0; i--) {
    const p = parts[i];
    p.life -= dt;
    if (p.life <= 0) {
      p.s.visible = false;
      parts.splice(i, 1);
      continue;
    }
    p.x += p.vx * dt;
    p.y += p.vy * dt;
    p.h += p.vh * dt;
    p.vh -= 260 * dt;
    if (p.h < 4) { p.h = 4; p.vh = Math.abs(p.vh) * 0.3; }
    const f = Math.exp(-3 * dt);
    p.vx *= f; p.vy *= f;
    const lifeK = p.life / p.max;
    p.s.position.set(p.x, p.h, p.y);
    p.s.scale.setScalar(p.size * (1 + (1 - lifeK) * 1.2));
    p.s.material.opacity = clamp(lifeK * 1.4, 0, 1);
  }
  for (let i = rings.length - 1; i >= 0; i--) {
    const r = rings[i];
    r.t += dt;
    const k = r.t / r.life;
    if (k >= 1) {
      r.m.visible = false;
      rings.splice(i, 1);
      continue;
    }
    const radius = r.rMax * (1 - Math.pow(1 - k, 2.2));
    r.m.scale.set(radius * 2, radius * 2, 1);
    r.m.material.opacity = 0.55 * (1 - k);
  }
  for (let i = tracers.length - 1; i >= 0; i--) {
    const t = tracers[i];
    t.life -= dt;
    if (t.life <= 0) {
      t.l.visible = false;
      tracers.splice(i, 1);
      continue;
    }
    t.l.material.opacity = t.life / t.max;
  }
  if (flashLight.intensity > 0) {
    flashLight.intensity = Math.max(0, flashLight.intensity - dt * 420);
  }
  if (muzzleLight.intensity > 0) {
    muzzleLight.intensity = Math.max(0, muzzleLight.intensity - dt * 700);
  }
}

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
  const p = player;
  const eye = p.downed ? 46 : EYE_H;
  const bobY = p.moving ? Math.abs(Math.sin(p.bobT * 2)) * 2.4 : 0;
  const sway = p.moving ? Math.sin(p.bobT) * 1.2 : 0;

  // trauma-driven shake: trauma² scaled by smooth sin noise (never raw per-frame rand)
  game.trauma = Math.max(0, game.trauma - 1.5 * dt);
  game.traumaT += dt * 27;
  const sh = game.trauma * game.trauma;
  const offX = Math.sin(game.traumaT * 1.7) * sh * 3.2;
  const offY = Math.sin(game.traumaT * 2.3) * sh * 1.9;
  const roll = (p.downed ? 0.85 : 0) + Math.sin(game.traumaT * 1.1) * sh * 0.022;
  camera.position.set(p.x + sway + offX * 0.4, eye + bobY + offY, p.y);
  camera.rotation.set(
    clamp(p.pitch + p.recoilPitch, -1.5, 1.5) + offY * 0.004,
    p.yaw + p.recoilYaw,
    roll,
  );

  // FOV: sprint kick + ADS zoom + hurt punch, exponentially smoothed (frame-rate independent)
  const fovTarget = settings.fov * (1 - 0.3 * p.adsT) + (p.sprinting ? 7 : 0) + p.hurtT * 6 + (p.downed ? -6 : 0);
  const newFov = camera.fov + (fovTarget - camera.fov) * (1 - Math.exp(-8 * dt));
  if (Math.abs(newFov - camera.fov) > 0.005) {
    camera.fov = newFov;
    camera.updateProjectionMatrix();
  }

  // flashlight flicker
  flickerT -= dt;
  if (flickerT <= 0) {
    flickerT = rand(0.04, 0.4);
    flashlight.intensity = (chance(0.08) ? rand(500, 900) : rand(1200, 1450));
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
  for (let i = player.dmgDirs.length - 1; i >= 0; i--) {
    const d = player.dmgDirs[i];
    d.t -= dt;
    if (d.t <= 0) player.dmgDirs.splice(i, 1);
  }
  if (player.deny) {
    player.deny.t -= dt;
    if (player.deny.t <= 0) player.deny = null;
  }
  if (game.flashWhite > 0) game.flashWhite -= dt;
}

// ------------------------------------------------------------------ HUD render
function perkIcon(id, x, y, owned) {
  const colors = { qr: '#4fd08a', jugg: '#e0453e', speed: '#f2d23c', dt: '#e07b31' };
  const c = colors[id];
  hctx.save();
  hctx.beginPath();
  hctx.arc(x, y, 14, 0, TAU);
  hctx.fillStyle = owned ? 'rgba(15,16,20,0.9)' : 'rgba(15,16,20,0.5)';
  hctx.fill();
  hctx.strokeStyle = owned ? c : 'rgba(120,120,130,0.35)';
  hctx.lineWidth = 2;
  hctx.stroke();
  hctx.strokeStyle = owned ? c : 'rgba(120,120,130,0.4)';
  hctx.fillStyle = owned ? c : 'rgba(120,120,130,0.4)';
  hctx.lineWidth = 2.2;
  switch (id) {
    case 'qr':
      hctx.fillRect(x - 2, y - 7, 4, 14);
      hctx.fillRect(x - 7, y - 2, 14, 4);
      break;
    case 'jugg':
      hctx.beginPath();
      hctx.moveTo(x, y - 7);
      hctx.lineTo(x + 7, y - 3);
      hctx.lineTo(x + 5, y + 6);
      hctx.lineTo(x, y + 8);
      hctx.lineTo(x - 5, y + 6);
      hctx.lineTo(x - 7, y - 3);
      hctx.closePath();
      hctx.stroke();
      break;
    case 'speed':
      hctx.beginPath();
      hctx.moveTo(x + 2, y - 8);
      hctx.lineTo(x - 5, y + 1);
      hctx.lineTo(x - 1, y + 1);
      hctx.lineTo(x - 2, y + 8);
      hctx.lineTo(x + 5, y - 1);
      hctx.lineTo(x + 1, y - 1);
      hctx.closePath();
      hctx.fill();
      break;
    case 'dt':
      hctx.beginPath();
      hctx.moveTo(x - 6, y - 4); hctx.lineTo(x - 1, y); hctx.lineTo(x - 6, y + 4);
      hctx.moveTo(x + 1, y - 4); hctx.lineTo(x + 6, y); hctx.lineTo(x + 1, y + 4);
      hctx.stroke();
      break;
  }
  hctx.restore();
}

function drawHUD() {
  const p = player;
  hctx.setTransform(DPR, 0, 0, DPR, 0, 0);
  hctx.clearRect(0, 0, W, H);
  const cx = W / 2, cy = H / 2;
  const U = clamp(Math.min(W / 1600, H / 900), 0.85, 2); // scale HUD text with the screen

  // damage vignette
  const hurtLevel = clamp(1 - p.hp / p.maxHp, 0, 1);
  const pulse = 0.5 + Math.sin(game.time * 5) * 0.5;
  const vivid = Math.max(p.hurtT * 1.2, hurtLevel * 0.85 * pulse + 0.15 * hurtLevel);
  if (vivid > 0.02) {
    const g = hctx.createRadialGradient(cx, cy, Math.min(W, H) * 0.25, cx, cy, Math.max(W, H) * 0.72);
    g.addColorStop(0, 'rgba(120,0,0,0)');
    g.addColorStop(1, `rgba(140,0,0,${clamp(vivid, 0, 0.75)})`);
    hctx.fillStyle = g;
    hctx.fillRect(0, 0, W, H);
  }
  if (game.flashWhite > 0) {
    hctx.fillStyle = `rgba(255,255,255,${clamp(game.flashWhite, 0, 0.8)})`;
    hctx.fillRect(0, 0, W, H);
  }

  // points / perks / grenades
  text(String(Math.floor(p.points)), 30 * U, H - 26 * U, { font: `bold ${44 * U}px ${FONT}`, fill: '#f5c542', shadow: '#a8781e', blur: 16 });
  const perkIds = ['qr', 'jugg', 'speed', 'dt'];
  perkIds.forEach((id, i) => perkIcon(id, 44 + i * 38, H - 104, p.perks[id]));
  hctx.save();
  hctx.translate(40, H - 152);
  hctx.fillStyle = 'rgba(15,16,20,0.8)';
  hctx.beginPath(); hctx.arc(0, 0, 11, 0, TAU); hctx.fill();
  hctx.strokeStyle = '#6a7a4a';
  hctx.lineWidth = 2;
  hctx.stroke();
  hctx.fillStyle = '#8a9a5a';
  hctx.beginPath(); hctx.arc(0, 0, 5, 0, TAU); hctx.fill();
  hctx.restore();
  text('×' + p.grenades, 56, H - 146, { font: `bold 18px ${FONT}`, fill: '#cfcabc' });

  // damage direction indicators (game-feel: know where the hit came from)
  {
    const fwdX = Math.cos(p.aimAngle), fwdZ = Math.sin(p.aimAngle);
    const rightX = Math.cos(p.yaw), rightZ = -Math.sin(p.yaw);
    const R = Math.min(W, H) * 0.3;
    for (const d of p.dmgDirs) {
      const dxw = Math.cos(d.a), dzw = Math.sin(d.a);
      const sx2 = dxw * rightX + dzw * rightZ;
      const fwd = dxw * fwdX + dzw * fwdZ;
      const ang = -Math.PI / 2 + Math.atan2(sx2, fwd);
      const a = clamp(d.t / 1.5, 0, 1) * 0.8;
      hctx.save();
      hctx.globalAlpha = a;
      hctx.strokeStyle = '#e0453e';
      hctx.lineWidth = 22 * U;
      hctx.beginPath();
      hctx.arc(cx, cy, R, ang - 0.34, ang + 0.34);
      hctx.stroke();
      hctx.strokeStyle = 'rgba(255,160,150,0.6)';
      hctx.lineWidth = 4;
      hctx.beginPath();
      hctx.arc(cx, cy, R + 16 * U, ang - 0.3, ang + 0.3);
      hctx.stroke();
      hctx.restore();
    }
  }

  // crosshair (spread follows bloom: first shot tight, sustained fire opens up)
  const spread = (6 + p.bloom * 26 + p.recoilPitch * 220 + (p.moving ? 3 : 0) + (p.sprinting ? 10 : 0)) * (1 - 0.6 * p.adsT);
  const crossAlpha = 1 - clamp((p.adsT - 0.5) / 0.3, 0, 1);
  hctx.save();
  hctx.strokeStyle = `rgba(255,255,255,${0.85 * crossAlpha})`;
  hctx.lineWidth = 2;
  const L = 9;
  hctx.beginPath();
  hctx.moveTo(cx, cy - spread - L); hctx.lineTo(cx, cy - spread);
  hctx.moveTo(cx, cy + spread); hctx.lineTo(cx, cy + spread + L);
  hctx.moveTo(cx - spread - L, cy); hctx.lineTo(cx - spread, cy);
  hctx.moveTo(cx + spread, cy); hctx.lineTo(cx + spread + L, cy);
  hctx.stroke();
  // centre dot stays visible in ADS
  hctx.fillStyle = `rgba(255,255,255,${0.9 * (0.4 + 0.6 * crossAlpha)})`;
  hctx.beginPath();
  hctx.arc(cx, cy, Math.max(1.2, 2.2 - p.adsT * 1.2), 0, TAU);
  hctx.fill();
  if (p.reload) {
    const t = 1 - p.reload.t / p.reload.total;
    hctx.strokeStyle = 'rgba(245,197,66,0.9)';
    hctx.lineWidth = 3;
    hctx.beginPath();
    hctx.arc(cx, cy, 22, -Math.PI / 2, -Math.PI / 2 + t * TAU);
    hctx.stroke();
  }
  hctx.restore();

  // empty-mag / low-ammo prompt (teaches the reload verb)
  const cw = curWeapon();
  if (cw && cw.ammo === 0 && !p.reload && game.state === 'playing') {
    const a = 0.55 + Math.sin(game.time * 7) * 0.45;
    text('PRESS R — RELOAD', cx, cy + 64, {
      font: `bold ${18 * U}px ${FONT}`, fill: '#e0453e', align: 'center', alpha: a,
    });
  }

  // hit markers
  for (const h of game.hitmarks) {
    const a = h.t / h.max;
    hctx.save();
    hctx.strokeStyle = h.color;
    hctx.globalAlpha = a;
    hctx.lineWidth = 2.5;
    const r1 = 7, r2 = 13;
    hctx.beginPath();
    for (const [sx, sy] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) {
      hctx.moveTo(cx + sx * r1, cy + sy * r1);
      hctx.lineTo(cx + sx * r2, cy + sy * r2);
    }
    hctx.stroke();
    hctx.restore();
  }

  // ammo + round
  const w = curWeapon();
  if (w) {
    const st = statsOf(w);
    const other = player.weapons[p.slot === 0 ? 1 : 0];
    text(st.name.toUpperCase() + (other ? '  ·  ' + WEAPONS[other.id].name.toUpperCase() : ''), W - 30 * U, H - 88 * U, { font: `bold ${20 * U}px ${MONO}`, fill: w.pap ? '#f5c542' : '#cfcabc', align: 'right' });
    const low = w.ammo <= st.mag * 0.25;
    const ammoStr = String(w.ammo);
    text(ammoStr, W - 30 * U, H - 30 * U, { font: `bold ${48 * U}px ${FONT}`, fill: low ? '#e0453e' : '#fff', align: 'right' });
    hctx.save();
    hctx.font = `bold ${48 * U}px ${FONT}`;
    const ammoW = hctx.measureText(ammoStr).width;
    hctx.restore();
    text('/ ' + w.reserve, W - 30 * U - ammoW - 14, H - 34 * U, { font: `bold ${26 * U}px ${FONT}`, fill: '#8f948c', align: 'right' });
  }
  const alive = zombies.reduce((n, z) => n + (z.state !== 'dead' ? 1 : 0), 0);
  const left = alive + Math.max(0, game.toSpawn - game.spawnedThisRound);
  text('ZOMBIES LEFT: ' + left, W - 30 * U, H - 116 * U, { font: `bold ${14 * U}px ${MONO}`, fill: '#8b8f96', align: 'right' });
  text('ROUND ' + Math.max(1, game.round), W - 30 * U, H - 148 * U, { font: `bold ${34 * U}px ${FONT}`, fill: '#d8d2c4', align: 'right', shadow: '#7a1a10', blur: 18 });

  // powerup timers
  let pux = W / 2 - 100;
  for (const [id, t] of [['instakill', p.power.insta], ['double', p.power.double]]) {
    if (t <= 0) continue;
    const def = POWERUPS[id];
    text(def.letter + ' ' + def.label, pux, 34, { font: `bold 16px ${FONT}`, fill: def.color });
    hctx.fillStyle = 'rgba(255,255,255,0.2)';
    hctx.fillRect(pux, 42, 130, 4);
    hctx.fillStyle = def.color;
    hctx.fillRect(pux, 42, 130 * (t / def.dur), 4);
    pux += 170;
  }

  // banners
  for (const b of game.banners) {
    const a = clamp(Math.min(b.t / 0.15, (b.dur - b.t) / 0.5), 0, 1);
    const scale = 1 + (1 - clamp(b.t / 0.2, 0, 1)) * 0.25;
    hctx.save();
    hctx.translate(cx, H * 0.28);
    hctx.scale(scale, scale);
    hctx.globalAlpha = a;
    hctx.font = `bold ${b.size * U}px ${FONT}`;
    hctx.textAlign = 'center';
    hctx.textBaseline = 'middle';
    hctx.strokeStyle = 'rgba(0,0,0,0.9)';
    hctx.lineWidth = 8;
    hctx.strokeText(b.text, 0, 0);
    hctx.shadowColor = b.color;
    hctx.shadowBlur = 26;
    hctx.fillStyle = b.color;
    hctx.fillText(b.text, 0, 0);
    if (b.sub) {
      hctx.shadowBlur = 12;
      hctx.font = `bold ${20 * U}px ${MONO}`;
      hctx.fillStyle = '#d8d2c4';
      hctx.strokeText(b.sub, 0, b.size * 0.75);
      hctx.fillText(b.sub, 0, b.size * 0.75);
    }
    hctx.restore();
  }

  // interact prompt
  const tgt = p.hold.target;
  if (tgt && !p.downed && game.state === 'playing') {
    const affordable = !tgt.cost || p.points >= tgt.cost;
    const y = H - 170;
    hctx.save();
    hctx.translate(cx, y);
    const pulseA = affordable ? 0.85 + Math.sin(game.time * 6) * 0.15 : 1;
    hctx.globalAlpha = pulseA;
    hctx.beginPath();
    hctx.arc(-110, 0, 17, 0, TAU);
    hctx.fillStyle = 'rgba(15,16,20,0.85)';
    hctx.fill();
    hctx.strokeStyle = affordable ? 'rgba(245,197,66,0.9)' : 'rgba(200,60,50,0.9)';
    hctx.lineWidth = 2;
    hctx.stroke();
    hctx.font = `bold 18px ${FONT}`;
    hctx.textAlign = 'center';
    hctx.textBaseline = 'middle';
    hctx.fillStyle = affordable ? '#f5c542' : '#c83c32';
    hctx.fillText('F', -110, 1);
    const label = tgt.label + (tgt.cost ? '  ·  ' + tgt.cost : '');
    text(label, -84, 1, { font: `bold 21px ${FONT}`, fill: affordable ? '#fff' : '#c83c32', baseline: 'middle' });
    if (tgt.hold > 0 && p.hold.t > 0) {
      hctx.beginPath();
      hctx.arc(-110, 0, 24, -Math.PI / 2, -Math.PI / 2 + (p.hold.t / tgt.hold) * TAU);
      hctx.strokeStyle = '#f5c542';
      hctx.lineWidth = 4;
      hctx.stroke();
    }
    hctx.restore();
  }
  if (p.deny) {
    text(p.deny.text, cx, H - 240, { font: `bold 24px ${FONT}`, fill: '#e0453e', align: 'center', alpha: clamp(p.deny.t / 0.4, 0, 1) });
  }

  // downed overlay
  if (p.downed) {
    hctx.fillStyle = 'rgba(90,0,0,0.35)';
    hctx.fillRect(0, 0, W, H);
    text('DOWNED', cx, H * 0.42, { font: `bold 72px ${FONT}`, fill: '#e0453e', align: 'center', baseline: 'middle' });
    text('REVIVING IN ' + Math.ceil(p.downT) + '…', cx, H * 0.5, { font: `bold 22px ${MONO}`, fill: '#d8d2c4', align: 'center', baseline: 'middle' });
  }

  if (audio.muted) text('MUTED (M)', 30, 34, { font: `bold 13px ${MONO}`, fill: '#8b8f96' });
}

// ------------------------------------------------------------------ main loop
let last = performance.now();

// quality: F2 cycles high → medium → low; auto-downgrade when frames are slow
let lowQuality = false;
let qualityLevel = 'high';
let qualityAcc = 0;
let qualityFrames = 0;
let autoQStep = 0;
const GRADE_SHADER = {
  uniforms: {
    tDiffuse: { value: null },
    uTime: { value: 0 },
    uGrain: { value: 0.05 },
    uVignette: { value: 0.5 },
    uCA: { value: 0.0016 },
    uLift: { value: new THREE.Vector3(0.006, 0.007, 0.012) },
  },
  vertexShader: 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
  fragmentShader: `
    uniform sampler2D tDiffuse; uniform float uTime; uniform float uGrain; uniform float uVignette;
    uniform float uCA; uniform vec3 uLift; varying vec2 vUv;
    void main() {
      vec2 d = vUv - 0.5;
      float r2 = dot(d, d);
      vec2 off = d * uCA * (0.35 + r2 * 2.6);
      vec3 col;
      col.r = texture2D(tDiffuse, vUv + off).r;
      col.g = texture2D(tDiffuse, vUv).g;
      col.b = texture2D(tDiffuse, vUv - off).b;
      float n = fract(sin(dot(vUv * vec2(913.7, 527.3) + uTime * 0.63, vec2(12.9898, 78.233))) * 43758.5453);
      col += (n - 0.5) * uGrain;
      col *= 1.0 - smoothstep(0.22, 0.82, r2 * 1.4) * uVignette;
      col += uLift;
      gl_FragColor = vec4(col, 1.0);
    }`,
};

function initComposer() {
  composer = new EffectComposer(renderer);
  composer.setPixelRatio(Math.min(DPR, 1.5));
  composer.setSize(W, H);
  composer.addPass(new RenderPass(scene, camera));
  ssaoPass = new SSAOPass(scene, camera, W, H);
  ssaoPass.kernelRadius = 60;
  ssaoPass.minDistance = 6;
  ssaoPass.maxDistance = 320;
  composer.addPass(ssaoPass);
  bloomPass = new UnrealBloomPass(new THREE.Vector2(W, H), 0.5, 0.6, 0.82);
  composer.addPass(bloomPass);
  composer.addPass(new OutputPass());
  fxaaPass = new ShaderPass(FXAAShader);
  fxaaPass.material.uniforms['resolution'].value.set(1 / (W * DPR), 1 / (H * DPR));
  composer.addPass(fxaaPass);
  gradePass = new ShaderPass(GRADE_SHADER);
  composer.addPass(gradePass);
  applyQuality();
}

function applyQuality() {
  const lvl = qualityLevel;
  lowQuality = lvl === 'low' || lvl === 'turbo';
  const turbo = lvl === 'turbo';
  renderer.setPixelRatio(turbo ? 0.5 : lowQuality ? 1 : Math.min(DPR, lvl === 'high' ? 2 : 1.5));
  renderer.setSize(W, H, false);
  const useShadows = lvl === 'high';
  renderer.shadowMap.enabled = useShadows;
  flashlight.castShadow = useShadows;
  if (flashlight.shadow.mapSize.x !== (lvl === 'high' ? 2048 : 1024)) {
    flashlight.shadow.mapSize.set(lvl === 'high' ? 2048 : 1024, lvl === 'high' ? 2048 : 1024);
    if (flashlight.shadow.map) {
      flashlight.shadow.map.dispose();
      flashlight.shadow.map = null;
    }
  }
  if (composer) {
    composer.setPixelRatio(turbo ? 0.5 : Math.min(DPR, lvl === 'high' ? 2 : 1.5));
    composer.setSize(W, H);
    if (ssaoPass) ssaoPass.enabled = lvl === 'high';
    if (bloomPass) bloomPass.strength = lvl === 'high' ? 0.5 : 0.34;
    if (fxaaPass) fxaaPass.material.uniforms['resolution'].value.set(1 / (W * DPR), 1 / (H * DPR));
  }
  if (beam) beam.visible = lvl !== 'low' && lvl !== 'turbo';
  dust.visible = lvl !== 'turbo';
  scene.traverse((o) => { if (o.material) o.material.needsUpdate = true; });
}

function setQuality(mode, manual = false) {
  qualityLevel = mode;
  if (!composer && mode !== 'low' && mode !== 'turbo') initComposer();
  else applyQuality();
  if (manual) {
    banner('QUALITY: ' + mode.toUpperCase(),
      mode === 'high' ? 'ssao + bloom + shadows' : mode === 'medium' ? 'bloom, no shadows' : 'fast mode', 1.6, '#8b8f96', 38);
  }
}
function nextQuality() {
  const order = ['high', 'medium', 'low'];
  const i = (order.indexOf(qualityLevel) + 1) % order.length;
  setQuality(order[i], true);
}
function autoQuality(rawDt) {
  if (autoQStep >= 2) return;
  qualityAcc += rawDt;
  qualityFrames++;
  if (qualityAcc >= 3) {
    const avg = qualityAcc / qualityFrames;
    qualityAcc = 0;
    qualityFrames = 0;
    if (avg > 0.032 && game.state === 'playing') {
      autoQStep++;
      const next = qualityLevel === 'high' ? 'medium' : 'low';
      setQuality(next, false);
      banner('PERFORMANCE MODE', 'quality: ' + next + ' — press F2 to change', 2.6, '#8b8f96', 38);
    }
  }
}

function frame(t) {
  requestAnimationFrame(frame);
  const rawDt = Math.min(0.1, (t - last) / 1000);
  last = t;
  let dt = rawDt;
  if (hitStop > 0) {
    hitStop -= rawDt;   // real-time countdown: recovers even at scale ~0
    dt *= hitStopScale;
  }
  autoQuality(rawDt);
  if (game.state === 'playing') {
    update(dt);
  } else {
    game.time += dt * 0.4;
    updateVisualTimers(dt);
    if (game.state === 'title') {
      // slow idle pan behind the menu
      player.yaw += Math.sin(game.time * 0.25) * dt * 0.05;
      updateCamera(dt);
    }
  }
  // keep zombie eye material visibility in sync (they're always on)
  if (composer) {
    if (gradePass) gradePass.uniforms.uTime.value = game.time;
    composer.render();
  } else {
    renderer.render(scene, camera);
  }
  if (game.state === 'playing' || game.state === 'paused') drawHUD();
  else hctx.setTransform(DPR, 0, 0, DPR, 0, 0), hctx.clearRect(0, 0, W, H);
}

// ------------------------------------------------------------------ boot
rebuildViewmodel();
camera.position.set(player.x, EYE_H, player.y);
camera.rotation.set(player.pitch, player.yaw, 0);
showScreen('title');
// post-processing chain (falls back to direct rendering if anything goes wrong)
try {
  initComposer();
} catch (e) {
  composer = null;
  qualityLevel = 'medium';
  applyQuality();
  console.warn('post-processing unavailable, direct render:', e);
}
window.__zombiesBooted = true;
requestAnimationFrame(frame);

// dev handle (safe: read/write game state from the browser console for debugging)
window.__zombiesDebug = {
  game, map, nav,
  get player() { return player; },
  get zombies() { return zombies; },
  get pickups() { return pickups; },
  startRound, spawnZombie, spawnPickup, explode, addPoints, hurtPlayer, grantWeapon,
  look(yaw, pitch) { player.yaw = yaw; if (pitch !== undefined) player.pitch = pitch; },
  teleport(x, y) { player.x = x; player.y = y; },
  perf(low) { setQuality(low ? 'turbo' : 'high'); },
  quality: setQuality,
};
