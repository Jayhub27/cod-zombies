// Tiny synthesized SFX engine — no audio assets, everything is generated with WebAudio.
import { rand, clamp } from './utils.js';

class AudioEngine {
  constructor() {
    this.ctx = null;
    this.master = null;
    this.noiseBuf = null;
    this.muted = false;
  }

  unlock() {
    try {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return;
      if (!this.ctx) {
        this.ctx = new AC();
        const comp = this.ctx.createDynamicsCompressor();
        comp.threshold.value = -14;
        comp.knee.value = 24;
        comp.ratio.value = 6;
        this.master = this.ctx.createGain();
        this.master.gain.value = 0.55;
        this.master.connect(comp);
        comp.connect(this.ctx.destination);
        // room reverb: dark noise impulse so gunshots echo inside the bunker
        try {
          const conv = this.ctx.createConvolver();
          conv.buffer = this._makeIR(2.4, 3.4);
          const wet = this.ctx.createGain();
          wet.gain.value = 0.24;
          this.master.connect(wet);
          wet.connect(conv);
          conv.connect(comp);
        } catch (e) { /* convolution is optional */ }
        this.noiseBuf = this._makeNoise();
        this._startAmbience();
      }
      if (this.ctx.state === 'suspended') this.ctx.resume();
    } catch (e) { /* audio is best-effort */ }
  }

  toggleMute() {
    this.muted = !this.muted;
    if (this.master) this.master.gain.value = this.muted ? 0 : 0.55;
    return this.muted;
  }

  get t() { return this.ctx ? this.ctx.currentTime : 0; }

  _makeNoise() {
    const len = Math.floor(this.ctx.sampleRate * 2);
    const buf = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
    const d = buf.getChannelData(0);
    let last = 0;
    for (let i = 0; i < len; i++) {
      // brown-ish noise, less harsh
      const white = Math.random() * 2 - 1;
      last = (last + 0.02 * white) / 1.02;
      d[i] = white * 0.5 + last * 3.5;
    }
    return buf;
  }

  // dark noise impulse response for the room reverb (procedural, no assets)
  _makeIR(dur, decay) {
    const rate = this.ctx.sampleRate;
    const len = Math.max(1, Math.floor(rate * dur));
    const buf = this.ctx.createBuffer(2, len, rate);
    for (let ch = 0; ch < 2; ch++) {
      const d = buf.getChannelData(ch);
      let last = 0;
      for (let i = 0; i < len; i++) {
        const t = i / len;
        const env = Math.pow(1 - t, decay);
        last += 0.34 * (Math.random() * 2 - 1 - last); // one-pole lowpass = dark tail
        d[i] = last * env * 1.7;
      }
    }
    return buf;
  }

  _noiseSrc() {
    const s = this.ctx.createBufferSource();
    s.buffer = this.noiseBuf;
    s.loop = true;
    return s;
  }

  // osc -> [filter] -> gain(env) -> master
  _tone({ type = 'square', f0 = 440, f1, dur = 0.1, peak = 0.3, attack = 0.004,
          lp, bp, q = 1, when = 0, detune = 0 }) {
    const c = this.ctx;
    if (!c || this.muted) return;
    const t0 = c.currentTime + when;
    const o = c.createOscillator();
    o.type = type;
    o.frequency.setValueAtTime(Math.max(1, f0), t0);
    if (f1 !== undefined && f1 !== f0) {
      o.frequency.exponentialRampToValueAtTime(Math.max(1, f1), t0 + dur);
    }
    if (detune) o.detune.value = detune;
    let node = o;
    if (lp) { const f = c.createBiquadFilter(); f.type = 'lowpass'; f.frequency.value = lp; node.connect(f); node = f; }
    if (bp) { const f = c.createBiquadFilter(); f.type = 'bandpass'; f.frequency.value = bp; f.Q.value = q; node.connect(f); node = f; }
    const g = c.createGain();
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.linearRampToValueAtTime(peak, t0 + attack);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + attack + dur);
    node.connect(g);
    g.connect(this.master);
    o.start(t0);
    o.stop(t0 + dur + attack + 0.05);
  }

  // noise burst -> [filter sweeps] -> gain(env) -> master
  _burst({ dur = 0.15, peak = 0.5, attack = 0.003, lp, lpEnd, bp, bpEnd, q = 1, when = 0 }) {
    const c = this.ctx;
    if (!c || this.muted) return;
    const t0 = c.currentTime + when;
    const s = this._noiseSrc();
    let node = s;
    if (lp) {
      const f = c.createBiquadFilter();
      f.type = 'lowpass';
      f.frequency.setValueAtTime(lp, t0);
      if (lpEnd) f.frequency.exponentialRampToValueAtTime(Math.max(20, lpEnd), t0 + dur);
      node.connect(f); node = f;
    }
    if (bp) {
      const f = c.createBiquadFilter();
      f.type = 'bandpass';
      f.frequency.setValueAtTime(bp, t0);
      if (bpEnd) f.frequency.exponentialRampToValueAtTime(Math.max(20, bpEnd), t0 + dur);
      f.Q.value = q;
      node.connect(f); node = f;
    }
    const g = c.createGain();
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.linearRampToValueAtTime(peak, t0 + attack);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + attack + dur);
    node.connect(g);
    g.connect(this.master);
    s.start(t0);
    s.stop(t0 + dur + attack + 0.05);
  }

  // ------------------------------------------------ ambience
  _startAmbience() {
    const c = this.ctx;
    const s = this._noiseSrc();
    const lp = c.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 220;
    const g = c.createGain();
    g.gain.value = 0.05;
    s.connect(lp); lp.connect(g); g.connect(this.master);
    s.start();
    const lfo = c.createOscillator();
    lfo.frequency.value = 0.07;
    const lg = c.createGain();
    lg.gain.value = 0.025;
    lfo.connect(lg); lg.connect(g.gain);
    lfo.start();

    const thunderLoop = () => {
      this._thunder();
      setTimeout(thunderLoop, rand(16000, 42000));
    };
    thunderLoop();
    const groanLoop = () => {
      this.growl(0.055);
      setTimeout(groanLoop, rand(9000, 22000));
    };
    groanLoop();
  }

  _thunder() {
    this._burst({ dur: 2.2, peak: 0.09, attack: 0.4, lp: 240, lpEnd: 60 });
    this._tone({ type: 'sine', f0: 46, f1: 30, dur: 1.8, peak: 0.05, attack: 0.3 });
  }

  // ------------------------------------------------ weapons
  shot(cls, vol = 1) {
    switch (cls) {
      case 'pistol':
        this._burst({ dur: 0.075, peak: 0.4 * vol, bp: 1100, q: 0.8 });
        this._tone({ type: 'square', f0: 190, f1: 60, dur: 0.06, peak: 0.22 * vol });
        break;
      case 'smg':
        this._burst({ dur: 0.05, peak: 0.33 * vol, bp: 1500, q: 0.9 });
        this._tone({ type: 'square', f0: 230, f1: 80, dur: 0.045, peak: 0.18 * vol });
        break;
      case 'mg':
        this._burst({ dur: 0.07, peak: 0.42 * vol, lp: 2200, lpEnd: 500 });
        this._tone({ type: 'square', f0: 130, f1: 50, dur: 0.08, peak: 0.28 * vol });
        break;
      case 'rifle':
        this._burst({ dur: 0.1, peak: 0.45 * vol, lp: 1800, lpEnd: 400 });
        this._tone({ type: 'square', f0: 150, f1: 55, dur: 0.09, peak: 0.3 * vol });
        break;
      case 'shotgun':
        this._burst({ dur: 0.26, peak: 0.65 * vol, lp: 900, lpEnd: 220 });
        this._tone({ type: 'sine', f0: 100, f1: 38, dur: 0.22, peak: 0.45 * vol });
        break;
      case 'ray':
        this._tone({ type: 'sine', f0: 1500, f1: 210, dur: 0.24, peak: 0.3 * vol });
        this._tone({ type: 'square', f0: 420, f1: 90, dur: 0.2, peak: 0.14 * vol, detune: 20 });
        this._burst({ dur: 0.16, peak: 0.14 * vol, bp: 2400, bpEnd: 800, q: 2 });
        break;
      case 'rocket':
        this._burst({ dur: 0.5, peak: 0.4 * vol, lp: 700, lpEnd: 150 });
        this._tone({ type: 'sawtooth', f0: 180, f1: 420, dur: 0.4, peak: 0.14 * vol });
        break;
    }
  }

  thunderShot(vol = 1) {
    this._burst({ dur: 0.4, peak: 0.6 * vol, bp: 350, bpEnd: 1600, q: 0.7 });
    this._tone({ type: 'sine', f0: 70, f1: 26, dur: 0.5, peak: 0.5 * vol });
    this._burst({ dur: 0.08, peak: 0.3 * vol, bp: 3000, q: 1.5, when: 0.02 });
  }

  dryFire() {
    this._burst({ dur: 0.02, peak: 0.25, bp: 2600, q: 2 });
    this._tone({ type: 'square', f0: 900, f1: 300, dur: 0.02, peak: 0.06 });
  }

  reloadStart() {
    this._burst({ dur: 0.04, peak: 0.3, bp: 1500, q: 1.5 });
    this._burst({ dur: 0.05, peak: 0.28, bp: 900, q: 1.4, when: 0.12 });
  }
  reloadMid() {
    this._burst({ dur: 0.05, peak: 0.24, bp: 1100, q: 1.2 });
  }
  reloadEnd() {
    this._burst({ dur: 0.05, peak: 0.34, bp: 1200, q: 1.4 });
    this._tone({ type: 'square', f0: 500, f1: 200, dur: 0.05, peak: 0.1 });
  }

  knifeSwing() {
    this._burst({ dur: 0.14, peak: 0.2, bp: 1200, bpEnd: 3600, q: 1.6 });
  }
  knifeHit() {
    this._burst({ dur: 0.12, peak: 0.4, lp: 900, lpEnd: 200 });
    this._tone({ type: 'sine', f0: 160, f1: 60, dur: 0.1, peak: 0.3 });
  }

  // ------------------------------------------------ zombies
  zombieHit(head = false, vol = 1) {
    this._tone({ type: 'sine', f0: head ? 220 : 150, f1: 60, dur: 0.09, peak: 0.3 * vol });
    this._burst({ dur: head ? 0.07 : 0.1, peak: 0.3 * vol, bp: head ? 1500 : 700, lpEnd: 200 });
    if (head) this._burst({ dur: 0.05, peak: 0.35 * vol, bp: 3200, q: 2, when: 0.01 });
  }

  zombieDie(vol = 1) {
    this.growl(0.16 * vol, true);
    this._burst({ dur: 0.3, peak: 0.3 * vol, lp: 800, lpEnd: 120 });
  }

  footstep(vol = 0.5, alt = false) {
    this._burst({ dur: 0.07, peak: 0.2 * vol, lp: alt ? 520 : 430, lpEnd: 130 });
    this._tone({ type: 'sine', f0: alt ? 108 : 88, f1: 46, dur: 0.06, peak: 0.07 * vol });
  }

  heartbeat(vol = 0.5) {
    this._tone({ type: 'sine', f0: 64, f1: 42, dur: 0.13, peak: 0.34 * vol });
    this._tone({ type: 'sine', f0: 56, f1: 36, dur: 0.11, peak: 0.22 * vol, when: 0.15 });
  }

  growl(vol = 0.2) {
    const c = this.ctx;
    if (!c || this.muted) return;
    const t0 = c.currentTime;
    const dur = rand(0.5, 0.9);
    const o = c.createOscillator();
    o.type = 'sawtooth';
    const f = rand(55, 85);
    o.frequency.setValueAtTime(f, t0);
    o.frequency.linearRampToValueAtTime(f * 0.75, t0 + dur);
    const lfo = c.createOscillator();
    lfo.frequency.value = rand(4, 7);
    const lg = c.createGain();
    lg.gain.value = 6;
    lfo.connect(lg); lg.connect(o.frequency);
    const lp = c.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 380;
    const g = c.createGain();
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.linearRampToValueAtTime(vol, t0 + 0.08);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    o.connect(lp); lp.connect(g); g.connect(this.master);
    o.start(t0); o.stop(t0 + dur + 0.1);
    lfo.start(t0); lfo.stop(t0 + dur + 0.1);
  }

  playerHurt() {
    this._burst({ dur: 0.18, peak: 0.35, lp: 600, lpEnd: 150 });
    this._tone({ type: 'sine', f0: 120, f1: 50, dur: 0.2, peak: 0.3 });
  }

  // ------------------------------------------------ explosions
  explode(kind = 'grenade') {
    const big = kind === 'grenade' || kind === 'rocket';
    this._burst({ dur: big ? 0.7 : 0.3, peak: big ? 0.9 : 0.5, lp: 1400, lpEnd: 90, attack: 0.004 });
    this._tone({ type: 'sine', f0: 80, f1: 28, dur: big ? 0.6 : 0.3, peak: big ? 0.7 : 0.4 });
    if (kind === 'ray') this._tone({ type: 'square', f0: 500, f1: 60, dur: 0.25, peak: 0.15 });
    if (kind === 'nuke') {
      this._burst({ dur: 1.6, peak: 0.8, lp: 2200, lpEnd: 60, attack: 0.01 });
      this._tone({ type: 'sine', f0: 55, f1: 20, dur: 1.5, peak: 0.6 });
    }
  }

  // ------------------------------------------------ economy / UI
  buy() {
    this._tone({ type: 'square', f0: 880, dur: 0.07, peak: 0.16 });
    this._tone({ type: 'square', f0: 1320, dur: 0.09, peak: 0.16, when: 0.09 });
  }
  deny() {
    this._tone({ type: 'square', f0: 140, f1: 110, dur: 0.18, peak: 0.2 });
  }
  perkBuy() {
    [523, 659, 784].forEach((f, i) =>
      this._tone({ type: 'sine', f0: f, dur: 0.14, peak: 0.22, when: i * 0.1 }));
    this._tone({ type: 'sine', f0: 380, f1: 180, dur: 0.3, peak: 0.14, when: 0.3 });
  }
  pap() {
    this._tone({ type: 'sawtooth', f0: 200, f1: 1200, dur: 0.7, peak: 0.2, lp: 2500 });
    [660, 880, 1320, 1760].forEach((f, i) =>
      this._tone({ type: 'square', f0: f, dur: 0.12, peak: 0.14, when: 0.35 + i * 0.08 }));
  }
  doorOpen() {
    this._burst({ dur: 0.5, peak: 0.5, lp: 900, lpEnd: 150 });
    this._tone({ type: 'sine', f0: 90, f1: 40, dur: 0.4, peak: 0.35 });
    this._burst({ dur: 0.3, peak: 0.2, bp: 500, bpEnd: 1800, q: 1.2, when: 0.05 });
  }
  boardRepair() {
    this._burst({ dur: 0.06, peak: 0.3, bp: 950, q: 1.6 });
    this._tone({ type: 'sine', f0: 210, f1: 160, dur: 0.05, peak: 0.12 });
  }
  boardBreak() {
    this._burst({ dur: 0.12, peak: 0.34, lp: 1400, lpEnd: 300 });
  }
  interactTick() {
    this._tone({ type: 'square', f0: 1050, dur: 0.025, peak: 0.06 });
  }

  boxOpen() {
    this._burst({ dur: 0.1, peak: 0.3, bp: 600, q: 1.2 });
    const notes = [330, 392, 440, 392, 330, 262, 220, 233];
    notes.forEach((f, i) => {
      this._tone({ type: 'triangle', f0: f, dur: 0.16, peak: 0.16, when: 0.15 + i * 0.16, detune: rand(-14, 14) });
    });
  }
  boxLand() {
    this._tone({ type: 'sawtooth', f0: 146, dur: 1.1, peak: 0.2, lp: 700 });
    this._tone({ type: 'sawtooth', f0: 155, dur: 1.1, peak: 0.2, lp: 700 });
    this._tone({ type: 'sine', f0: 60, f1: 30, dur: 0.8, peak: 0.4, when: 0.05 });
  }
  teddy() {
    [400, 300, 250, 180].forEach((f, i) =>
      this._tone({ type: 'sawtooth', f0: f, f1: f * 0.92, dur: 0.22, peak: 0.13, when: i * 0.18, lp: 900 }));
  }

  // ------------------------------------------------ round / powerups
  roundStart() {
    this._tone({ type: 'sawtooth', f0: 46, f1: 38, dur: 2.4, peak: 0.3, attack: 0.3, lp: 300 });
    this._tone({ type: 'sawtooth', f0: 69, f1: 57, dur: 2.4, peak: 0.2, attack: 0.3, lp: 400, detune: 30 });
    // bell toll
    [196, 392, 587, 784].forEach((f, i) =>
      this._tone({ type: 'sine', f0: f, dur: 2.2 - i * 0.4, peak: 0.16 - i * 0.03, attack: 0.005, when: 0.1 }));
  }
  gameOver() {
    this.growl(0.3);
    this._tone({ type: 'sine', f0: 110, f1: 50, dur: 2.5, peak: 0.3, attack: 0.01 });
    this._tone({ type: 'sawtooth', f0: 55, f1: 33, dur: 2.4, peak: 0.22, lp: 300 });
  }
  powerup(type = 'double') {
    const base = { instakill: 420, double: 520, maxammo: 620, carpenter: 500, nuke: 360 }[type] || 500;
    [1, 1.25, 1.5, 2].forEach((m, i) =>
      this._tone({ type: 'square', f0: base * m, dur: 0.09, peak: 0.16, when: i * 0.06 }));
  }
}

export const audio = new AudioEngine();
