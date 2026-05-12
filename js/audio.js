/**
 * 程序化 Web Audio：背景音乐与音效（无外部音频文件）。
 * 需在用户手势后调用 resumeAudio() 以解除浏览器自动播放限制。
 */

const STORAGE_KEY = "pudding_guard_audio_v1";

let ctx = null;
let masterGain = null;
let sfxGain = null;
let bgmGain = null;
let muted = false;
let bgmIntervalId = null;
let bgmMode = "off";
let lastKingSfx = 0;
let lastShootSfx = 0;
let lastProjHitSfx = 0;
let endedSfxPlayed = false;

function loadPrefs() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return;
    const j = JSON.parse(raw);
    if (typeof j.muted === "boolean") muted = j.muted;
  } catch {
    /* ignore */
  }
}

function savePrefs() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ muted }));
  } catch {
    /* ignore */
  }
}

function applyMuteGain() {
  if (!masterGain || !ctx) return;
  const t = ctx.currentTime;
  masterGain.gain.cancelScheduledValues(t);
  masterGain.gain.setValueAtTime(muted ? 0 : 1, t);
}

export function isMuted() {
  return muted;
}

export function setMuted(m) {
  muted = !!m;
  savePrefs();
  applyMuteGain();
  if (muted) stopBgmLoop();
}

function ensureContext() {
  if (ctx && ctx.state !== "closed") return ctx;
  const Ctx = window.AudioContext || window.webkitAudioContext;
  if (!Ctx) return null;
  ctx = new Ctx();
  masterGain = ctx.createGain();
  masterGain.gain.value = muted ? 0 : 1;
  sfxGain = ctx.createGain();
  sfxGain.gain.value = 0.5;
  bgmGain = ctx.createGain();
  bgmGain.gain.value = 0.2;
  sfxGain.connect(masterGain);
  bgmGain.connect(masterGain);
  masterGain.connect(ctx.destination);
  return ctx;
}

export async function resumeAudio() {
  const c = ensureContext();
  if (!c) return;
  if (c.state === "suspended") await c.resume();
  applyMuteGain();
}

function nowT() {
  return ctx ? ctx.currentTime : 0;
}

function beep({
  freq = 440,
  duration = 0.06,
  type = "sine",
  peak = 0.12,
  freqEnd,
}) {
  if (muted || !ctx) return;
  const t0 = nowT();
  const osc = ctx.createOscillator();
  const g = ctx.createGain();
  osc.type = type;
  osc.frequency.setValueAtTime(freq, t0);
  if (freqEnd != null) {
    const fe = Math.max(30, freqEnd);
    osc.frequency.exponentialRampToValueAtTime(fe, t0 + duration);
  }
  g.gain.setValueAtTime(0.0001, t0);
  g.gain.exponentialRampToValueAtTime(peak, t0 + 0.006);
  g.gain.exponentialRampToValueAtTime(0.0001, t0 + duration);
  osc.connect(g);
  g.connect(sfxGain);
  osc.start(t0);
  osc.stop(t0 + duration + 0.03);
}

function noiseBurst(duration = 0.04, peak = 0.055, freq = 2200) {
  if (muted || !ctx) return;
  const n = Math.floor(ctx.sampleRate * duration);
  const buf = ctx.createBuffer(1, n, ctx.sampleRate);
  const d = buf.getChannelData(0);
  for (let i = 0; i < n; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / n);
  const src = ctx.createBufferSource();
  src.buffer = buf;
  const filt = ctx.createBiquadFilter();
  filt.type = "lowpass";
  filt.frequency.value = freq;
  const g = ctx.createGain();
  const t0 = nowT();
  g.gain.setValueAtTime(0.0001, t0);
  g.gain.linearRampToValueAtTime(peak, t0 + 0.008);
  g.gain.exponentialRampToValueAtTime(0.0001, t0 + duration);
  src.connect(filt);
  filt.connect(g);
  g.connect(sfxGain);
  src.start(t0);
  src.stop(t0 + duration + 0.03);
}

function playChord(t0, freqs, duration, vol) {
  if (muted || !ctx) return;
  for (const f of freqs) {
    const osc = ctx.createOscillator();
    osc.type = "sine";
    const g = ctx.createGain();
    osc.frequency.value = f;
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.linearRampToValueAtTime(vol, t0 + 0.12);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + duration);
    osc.connect(g);
    g.connect(bgmGain);
    osc.start(t0);
    osc.stop(t0 + duration + 0.06);
  }
}

function scheduleBgmPulse() {
  if (!ctx || muted || bgmMode === "off") return;
  const t0 = ctx.currentTime + 0.02;
  const period = bgmMode === "shop" ? 2.5 : 1.65;
  const freqs =
    bgmMode === "shop"
      ? [196, 246.94, 293.66]
      : [146.83, 174.61, 220];
  const vol = bgmMode === "shop" ? 0.075 : 0.09;
  playChord(t0, freqs, period * 0.82, vol);

  const sub = ctx.createOscillator();
  sub.type = "sine";
  const g2 = ctx.createGain();
  sub.frequency.value = freqs[0] * 0.5;
  g2.gain.setValueAtTime(0.0001, t0);
  g2.gain.linearRampToValueAtTime(0.055, t0 + 0.06);
  g2.gain.exponentialRampToValueAtTime(0.0001, t0 + period * 0.48);
  sub.connect(g2);
  g2.connect(bgmGain);
  sub.start(t0);
  sub.stop(t0 + period * 0.5 + 0.05);
}

function stopBgmLoop() {
  if (bgmIntervalId != null) {
    clearInterval(bgmIntervalId);
    bgmIntervalId = null;
  }
  bgmMode = "off";
}

/** @param {'off'|'combat'|'shop'} mode */
export function setBgmMode(mode) {
  stopBgmLoop();
  if (mode === "off" || muted || !ctx) return;
  bgmMode = mode;
  scheduleBgmPulse();
  const ms = mode === "shop" ? 2500 : 1650;
  bgmIntervalId = window.setInterval(() => {
    if (!ctx || muted || bgmMode === "off") return;
    scheduleBgmPulse();
  }, ms);
}

export function stopSessionAudio() {
  stopBgmLoop();
  endedSfxPlayed = false;
}

/**
 * @param {string} newPhase
 * @param {string} oldPhase
 * @param {{ victory?: boolean }} flags
 */
export function onGamePhaseChanged(newPhase, oldPhase, flags = {}) {
  if (newPhase === "menu") {
    endedSfxPlayed = false;
    stopBgmLoop();
  }
  if (newPhase === "placeStarter" && oldPhase === "menu") {
    endedSfxPlayed = false;
  }

  if (newPhase === "ended" && oldPhase !== "ended" && !endedSfxPlayed) {
    endedSfxPlayed = true;
    if (flags.victory) {
      [523, 659, 784, 1047].forEach((f, i) => {
        window.setTimeout(() => {
          beep({ freq: f, duration: 0.16, peak: 0.11, type: "triangle" });
        }, i * 130);
      });
    } else {
      beep({ freq: 165, duration: 0.32, peak: 0.13, type: "sawtooth", freqEnd: 48 });
      noiseBurst(0.1, 0.06, 900);
    }
  }

  if (muted || !ctx) {
    stopBgmLoop();
    return;
  }

  if (newPhase === "combat" || newPhase === "placeStarter") {
    if (oldPhase === "shop") {
      beep({ freq: 196, duration: 0.1, peak: 0.09, type: "triangle", freqEnd: 262 });
    }
    stopBgmLoop();
    setBgmMode("combat");
  } else if (newPhase === "shop") {
    stopBgmLoop();
    setBgmMode("shop");
    if (oldPhase === "combat") {
      beep({ freq: 392, duration: 0.11, peak: 0.09, type: "triangle", freqEnd: 587 });
      beep({ freq: 784, duration: 0.12, peak: 0.05, type: "sine" });
    }
  } else if (newPhase === "ended") {
    stopBgmLoop();
  }
}

export function sfxPlacePudding() {
  beep({ freq: 300, duration: 0.09, peak: 0.09, type: "triangle", freqEnd: 520 });
}

export function sfxMerge() {
  beep({ freq: 440, duration: 0.06, peak: 0.1, type: "sine", freqEnd: 700 });
  window.setTimeout(() => {
    beep({ freq: 700, duration: 0.07, peak: 0.08, type: "sine", freqEnd: 990 });
  }, 50);
}

export function sfxShoot() {
  if (muted || !ctx) return;
  const t = performance.now();
  if (t - lastShootSfx < 45) return;
  lastShootSfx = t;
  noiseBurst(0.022, 0.028, 3200);
}

export function sfxHitEnemy(seed = 0) {
  if (muted || !ctx) return;
  const t = performance.now();
  if (t - lastProjHitSfx < 28) return;
  lastProjHitSfx = t;
  const base = 200 + (seed % 5) * 28;
  beep({ freq: base + 50, duration: 0.045, peak: 0.07, type: "square", freqEnd: base });
}

export function sfxEnemyDeath() {
  beep({ freq: 620, duration: 0.055, peak: 0.09, type: "sine", freqEnd: 980 });
  beep({ freq: 1240, duration: 0.035, peak: 0.045, type: "sine" });
}

export function sfxKingHurt() {
  if (muted || !ctx) return;
  const t = performance.now();
  if (t - lastKingSfx < 110) return;
  lastKingSfx = t;
  beep({ freq: 95, duration: 0.12, peak: 0.15, type: "sawtooth", freqEnd: 42 });
  noiseBurst(0.07, 0.055, 700);
}

export function sfxRangedFire() {
  noiseBurst(0.032, 0.04, 2600);
}

export function sfxBuy() {
  beep({ freq: 523, duration: 0.07, peak: 0.1, type: "sine", freqEnd: 784 });
}

export function sfxReroll() {
  noiseBurst(0.055, 0.045, 1800);
  beep({ freq: 280, duration: 0.05, peak: 0.06, type: "triangle", freqEnd: 160 });
}

export function sfxAoeBoom() {
  noiseBurst(0.12, 0.09, 600);
  beep({ freq: 90, duration: 0.18, peak: 0.1, type: "sawtooth", freqEnd: 40 });
}

/** 取消静音后按当前阶段恢复 BGM（不播放阶段切换音效）。 */
export function syncBgmToPhase(phase) {
  if (muted || !ctx) {
    if (muted) stopBgmLoop();
    return;
  }
  if (phase === "combat" || phase === "placeStarter") {
    stopBgmLoop();
    setBgmMode("combat");
  } else if (phase === "shop") {
    stopBgmLoop();
    setBgmMode("shop");
  } else {
    stopBgmLoop();
  }
}

loadPrefs();
