// Weapon definitions, Pack-a-Punch math, round scaling, power-ups.

export const WEAPONS = {
  m1911: {
    name: 'M1911', cls: 'pistol', dmg: 50, rpm: 320, mag: 8, reserve: 80, reload: 1.6,
    auto: false, pellets: 1, spread: 2.0, speed: 1500, cost: 500, ammoCost: 250, weight: 0.55,
  },
  m14: {
    name: 'M14', cls: 'rifle', dmg: 110, rpm: 270, mag: 8, reserve: 64, reload: 1.8,
    auto: false, pellets: 1, spread: 1.2, speed: 1700, cost: 1200, ammoCost: 600, weight: 0.85,
  },
  mp40: {
    name: 'MP40', cls: 'smg', dmg: 45, rpm: 800, mag: 32, reserve: 192, reload: 2.2,
    auto: true, pellets: 1, spread: 3.6, speed: 1550, cost: 1000, ammoCost: 500, weight: 0.9,
  },
  thompson: {
    name: 'Thompson', cls: 'smg', dmg: 50, rpm: 750, mag: 30, reserve: 210, reload: 2.4,
    auto: true, pellets: 1, spread: 4.0, speed: 1550, weight: 1.0,
  },
  mg42: {
    name: 'MG42', cls: 'mg', dmg: 60, rpm: 1000, mag: 75, reserve: 300, reload: 4.2,
    auto: true, pellets: 1, spread: 5.0, speed: 1600, weight: 0.95,
  },
  trench: {
    name: 'Trench Gun', cls: 'shotgun', dmg: 45, rpm: 75, mag: 6, reserve: 48, reload: 3.0,
    auto: false, pellets: 6, spread: 11, speed: 1400, cost: 1500, ammoCost: 750, weight: 0.8,
  },
  raygun: {
    name: 'Ray Gun', cls: 'ray', dmg: 200, splash: { r: 95, dmg: 180, self: 25 },
    rpm: 180, mag: 20, reserve: 160, reload: 3.0,
    auto: true, pellets: 1, spread: 1.2, speed: 750, weight: 0.11,
  },
  thundergun: {
    name: 'Thundergun', cls: 'thunder', dmg: 900, rpm: 55, mag: 2, reserve: 12, reload: 2.6,
    auto: false, pellets: 1, spread: 0, speed: 0,
    wedge: { range: 300, halfAngle: 0.5 }, weight: 0.09,
  },
  panzerfaust: {
    name: 'Panzerfaust', cls: 'rocket', dmg: 120, splash: { r: 190, dmg: 600, self: 60 },
    rpm: 45, mag: 1, reserve: 6, reload: 3.4,
    auto: false, pellets: 1, spread: 1, speed: 520, weight: 0.4,
  },
};

export const BOX_POOL = ['thompson', 'mg42', 'trench', 'mp40', 'm14', 'raygun', 'thundergun', 'panzerfaust'];

const PAP_NAMES = {
  m1911: 'Mustang & Sally',
  m14: 'Eagle Eye',
  mp40: 'The Afterburner',
  thompson: 'Gibbs-O-Matic',
  mg42: 'Barracuda',
  trench: 'Gut Shot',
  raygun: "Porter's X2 Ray Gun",
  thundergun: 'Zeus Cannon',
  panzerfaust: 'Panzerführer',
};

export function boxRoll(heldIds) {
  const pool = BOX_POOL.filter((id) => !heldIds.includes(id));
  const use = pool.length ? pool : BOX_POOL;
  let total = 0;
  for (const id of use) total += WEAPONS[id].weight;
  let roll = Math.random() * total;
  for (const id of use) {
    roll -= WEAPONS[id].weight;
    if (roll <= 0) return id;
  }
  return use[use.length - 1];
}

// Effective stats for a runtime weapon instance { id, ammo, reserve, pap }
export function statsOf(inst) {
  const base = WEAPONS[inst.id];
  if (!inst.pap) return base;
  return {
    ...base,
    name: PAP_NAMES[inst.id] || base.name + ' X',
    dmg: base.dmg * 2.5,
    mag: Math.ceil(base.mag * 1.5),
    reserve: base.reserve * 2,
    spread: base.spread * 0.55,
    splash: base.splash
      ? { ...base.splash, dmg: base.splash.dmg * 2.2, r: base.splash.r * 1.25 }
      : undefined,
    wedge: base.wedge ? { ...base.wedge, range: base.wedge.range * 1.15 } : undefined,
    pap: true,
  };
}

export const POINTS = { hit: 10, kill: 50, headshotKill: 100, knifeKill: 130, board: 10, nuke: 400, carpenter: 200 };

export const KNIFE = { dmg: 150, cd: 0.65, range: 66, points: 130 };

export const GRENADE = { r: 155, dmg: 600, self: 70, fuse: 1.5, speed: 430 };

export const ZOMB = {
  count: (r) => Math.round(6 * Math.pow(1.16, r - 1)),
  hp: (r) => (r <= 9 ? 100 + (r - 1) * 60 : Math.round(580 * Math.pow(1.1, r - 9))),
  speed: (r) => 42 + Math.min(r - 1, 14) * 4.2,
  sprChance: (r) => Math.min(0.4, Math.max(0, (r - 6) * 0.045)),
  damage: (r) => Math.min(45, 15 + r * 1.5),
  spawnInterval: (r) => Math.max(0.35, 1.1 - r * 0.05),
  maxAlive: (r) => Math.min(26, 5 + r),
};

export const POWERUPS = {
  maxammo:   { label: 'MAX AMMO',      color: '#4fc3f7', letter: '∞',  dur: 0,  weight: 22 },
  instakill: { label: 'INSTA-KILL',    color: '#ef5350', letter: '☠',  dur: 30, weight: 20 },
  double:    { label: 'DOUBLE POINTS', color: '#ffd54f', letter: '×2', dur: 30, weight: 20 },
  nuke:      { label: 'NUKE',          color: '#66bb6a', letter: '☢',  dur: 0,  weight: 19 },
  carpenter: { label: 'CARPENTER',     color: '#ff9800', letter: 'H',  dur: 0,  weight: 19 },
};

export function rollPowerup() {
  const ids = Object.keys(POWERUPS);
  let total = 0;
  for (const id of ids) total += POWERUPS[id].weight;
  let roll = Math.random() * total;
  for (const id of ids) {
    roll -= POWERUPS[id].weight;
    if (roll <= 0) return id;
  }
  return 'maxammo';
}
