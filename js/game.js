/**
 * 布丁回转防线 — Web 原型
 * 站桩核心 + 回转带取餐 + 转盘布阵 + 击退（无主角走位）
 */
(function () {
  "use strict";

  const canvas = document.getElementById("game");
  const ctx = canvas.getContext("2d");
  const hpFill = document.getElementById("hpFill");
  const hpText = document.getElementById("hpText");
  const waveText = document.getElementById("waveText");
  const knockText = document.getElementById("knockText");
  const btnCard1 = document.getElementById("btnCard1");
  const btnCard2 = document.getElementById("btnCard2");
  const cd1 = document.getElementById("cd1");
  const cd2 = document.getElementById("cd2");

  const W = 960;
  const H = 600;
  const cx = W / 2;
  const cy = 250;
  const CORE_R = 26;
  const SLOT_R = 118;
  const SLOT_COUNT = 6;
  const BELT_Y = 508;
  const BELT_X0 = 72;
  const BELT_X1 = W - 72;
  const BELT_LEN = BELT_X1 - BELT_X0;

  const PUDDING = {
    milk: { name: "奶冻", kb: 2.8, range: 92, color: "#fff5f8", rim: "#e8b4c8" },
    caramel: { name: "焦糖", kb: 2.0, range: 86, slow: 0.92, color: "#c9956c", rim: "#6b4423" },
    berry: { name: "莓果", kb: 1.35, range: 108, dot: 0.35, color: "#ff6b9d", rim: "#8b2252" },
  };

  const TYPE_KEYS = Object.keys(PUDDING);

  let dpr = 1;
  let lastT = performance.now();
  let wave = 1;
  let kills = 0;

  const state = {
    coreHp: 100,
    coreMax: 100,
    tableAngle: 0,
    tableSpeed: 0.35,
    slots: Array.from({ length: SLOT_COUNT }, () => null),
    plates: [],
    nextPlateId: 1,
    plateSpawnAcc: 0,
    enemies: [],
    spawnAcc: 0,
    drag: null,
    card1Cd: 0,
    card2Cd: 0,
    buffWideUntil: 0,
    buffSlowUntil: 0,
    beltSpeed: 0.055,
    gameOver: false,
  };

  function beltSpeedNow() {
    const now = performance.now();
    let s = state.beltSpeed;
    if (now < state.buffSlowUntil) s *= 0.55;
    return s;
  }

  function pickupRange() {
    const now = performance.now();
    let lo = 0.38;
    let hi = 0.62;
    if (now < state.buffWideUntil) {
      lo -= 0.12;
      hi += 0.12;
    }
    lo = Math.max(0.02, lo);
    hi = Math.min(0.98, hi);
    return { lo, hi };
  }

  function slotAngles() {
    const out = [];
    for (let i = 0; i < SLOT_COUNT; i++) {
      const base = -Math.PI / 2 + (i * 2 * Math.PI) / SLOT_COUNT;
      out.push(base + state.tableAngle);
    }
    return out;
  }

  function slotPos(i) {
    const ang = slotAngles()[i];
    return { x: cx + Math.cos(ang) * SLOT_R, y: cy + Math.sin(ang) * SLOT_R, ang };
  }

  function platePos(t) {
    const x = BELT_X0 + t * BELT_LEN;
    return { x, y: BELT_Y };
  }

  function dist(a, b) {
    const dx = a.x - b.x;
    const dy = a.y - b.y;
    return Math.hypot(dx, dy);
  }

  function norm(dx, dy) {
    const l = Math.hypot(dx, dy) || 1;
    return { x: dx / l, y: dy / l };
  }

  function spawnPlate() {
    const k = TYPE_KEYS[(Math.random() * TYPE_KEYS.length) | 0];
    state.plates.push({ id: state.nextPlateId++, type: k, t: 0 });
  }

  function spawnEnemy() {
    const ang = Math.random() * Math.PI * 2;
    const spawnR = 300;
    const x = cx + Math.cos(ang) * spawnR;
    const y = cy + Math.sin(ang) * spawnR;
    const hp = 36 + wave * 6;
    const spd = 52 + wave * 4;
    state.enemies.push({
      x,
      y,
      vx: 0,
      vy: 0,
      hp,
      maxHp: hp,
      spd,
      r: 14,
      slowMul: 1,
      absorbedByCore: false,
    });
  }

  function resize() {
    dpr = Math.min(2, window.devicePixelRatio || 1);
    canvas.width = W * dpr;
    canvas.height = H * dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  function clientToCanvas(ev) {
    const rect = canvas.getBoundingClientRect();
    const sx = ev.clientX ?? ev.touches?.[0]?.clientX;
    const sy = ev.clientY ?? ev.touches?.[0]?.clientY;
    const x = ((sx - rect.left) / rect.width) * W;
    const y = ((sy - rect.top) / rect.height) * H;
    return { x, y };
  }

  function plateAtPoint(p) {
    for (let i = state.plates.length - 1; i >= 0; i--) {
      const pl = state.plates[i];
      const pos = platePos(pl.t);
      if (dist(p, pos) < 34) return pl;
    }
    return null;
  }

  function slotIndexAtPoint(p) {
    for (let i = 0; i < SLOT_COUNT; i++) {
      const sp = slotPos(i);
      if (dist(p, sp) < 40) return i;
    }
    return -1;
  }

  function tryStartDrag(p) {
    const pl = plateAtPoint(p);
    if (!pl) return;
    const { lo, hi } = pickupRange();
    if (pl.t < lo || pl.t > hi) return;
    state.drag = { type: pl.type, sx: p.x, sy: p.y, cx: p.x, cy: p.y };
    const idx = state.plates.indexOf(pl);
    if (idx >= 0) state.plates.splice(idx, 1);
  }

  function endDrag(p) {
    if (!state.drag) return;
    const idx = slotIndexAtPoint(p);
    if (idx >= 0 && state.slots[idx] === null) {
      state.slots[idx] = { type: state.drag.type };
    } else {
      state.plates.push({ id: state.nextPlateId++, type: state.drag.type, t: 0.5 });
    }
    state.drag = null;
  }

  canvas.addEventListener("mousedown", (e) => {
    if (state.gameOver) return;
    tryStartDrag(clientToCanvas(e));
  });
  canvas.addEventListener("mousemove", (e) => {
    if (!state.drag) return;
    const p = clientToCanvas(e);
    state.drag.cx = p.x;
    state.drag.cy = p.y;
  });
  window.addEventListener("mouseup", (e) => {
    if (!state.drag) return;
    endDrag(clientToCanvas(e));
  });

  canvas.addEventListener(
    "touchstart",
    (e) => {
      if (state.gameOver) return;
      e.preventDefault();
      tryStartDrag(clientToCanvas(e));
    },
    { passive: false }
  );
  canvas.addEventListener(
    "touchmove",
    (e) => {
      if (!state.drag) return;
      e.preventDefault();
      const p = clientToCanvas(e);
      state.drag.cx = p.x;
      state.drag.cy = p.y;
    },
    { passive: false }
  );
  canvas.addEventListener(
    "touchend",
    (e) => {
      if (!state.drag) return;
      e.preventDefault();
      const p = clientToCanvas(e.changedTouches[0]);
      endDrag(p);
    },
    { passive: false }
  );

  function useCard1() {
    const now = performance.now();
    if (state.card1Cd > now || state.gameOver) return;
    state.buffWideUntil = now + 8000;
    state.card1Cd = now + 12000;
  }

  function useCard2() {
    const now = performance.now();
    if (state.card2Cd > now || state.gameOver) return;
    state.buffSlowUntil = now + 6000;
    state.card2Cd = now + 11000;
  }

  btnCard1.addEventListener("click", useCard1);
  btnCard2.addEventListener("click", useCard2);
  window.addEventListener("keydown", (e) => {
    if (e.code === "Digit1") useCard1();
    if (e.code === "Digit2") useCard2();
  });

  function update(dt) {
    const now = performance.now();
    if (state.gameOver) return;

    state.tableAngle += state.tableSpeed * dt;

    const bs = beltSpeedNow();
    for (const pl of state.plates) {
      pl.t += bs * dt;
    }
    state.plates = state.plates.filter((pl) => pl.t <= 1.02);

    state.plateSpawnAcc += dt;
    const spawnEvery = Math.max(0.55, 1.1 - wave * 0.04);
    while (state.plateSpawnAcc >= spawnEvery) {
      state.plateSpawnAcc -= spawnEvery;
      if (state.plates.length < 9) spawnPlate();
    }

    state.spawnAcc += dt;
    const spawnInt = Math.max(0.65, 1.35 - wave * 0.06);
    while (state.spawnAcc >= spawnInt) {
      state.spawnAcc -= spawnInt;
      spawnEnemy();
    }

    for (const e of state.enemies) {
      let slow = 1;
      for (let i = 0; i < SLOT_COUNT; i++) {
        const s = state.slots[i];
        if (!s) continue;
        const def = PUDDING[s.type];
        if (!def.slow) continue;
        const sp = slotPos(i);
        if (dist(e, sp) < def.range) slow *= def.slow;
      }
      e.slowMul = slow;
    }

    for (const e of state.enemies) {
      const toC = norm(cx - e.x, cy - e.y);
      const spd = e.spd * e.slowMul;
      e.vx = toC.x * spd;
      e.vy = toC.y * spd;
      e.x += e.vx * dt;
      e.y += e.vy * dt;

      let dotTotal = 0;
      for (let i = 0; i < SLOT_COUNT; i++) {
        const s = state.slots[i];
        if (!s) continue;
        const def = PUDDING[s.type];
        const sp = slotPos(i);
        const d = dist(e, sp);
        if (d < def.range && d > 0.01) {
          const away = norm(e.x - sp.x, e.y - sp.y);
          const push = (def.kb * 520 * dt) / (1 + d / 50);
          e.x += away.x * push;
          e.y += away.y * push;
        }
        if (def.dot && d < def.range) dotTotal += def.dot * dt * 60;
      }
      e.hp -= dotTotal;

      if (dist(e, { x: cx, y: cy }) < CORE_R + e.r) {
        state.coreHp -= 8;
        e.hp = 0;
        e.absorbedByCore = true;
      }
    }

    state.enemies = state.enemies.filter((e) => {
      if (e.hp <= 0) {
        if (!e.absorbedByCore) kills += 1;
        return false;
      }
      return true;
    });

    if (state.coreHp <= 0) {
      state.coreHp = 0;
      state.gameOver = true;
    }

    wave = 1 + ((kills / 15) | 0);
    if (wave < 1) wave = 1;
  }

  function drawBackground() {
    const g = ctx.createRadialGradient(cx, cy, 40, cx, cy, 320);
    g.addColorStop(0, "#3d2e52");
    g.addColorStop(1, "#120a18");
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, W, H);
  }

  function drawBelt() {
    const { lo, hi } = pickupRange();
    const x0 = BELT_X0 + lo * BELT_LEN;
    const x1 = BELT_X0 + hi * BELT_LEN;

    ctx.save();
    ctx.strokeStyle = "rgba(255,200,220,0.25)";
    ctx.lineWidth = 56;
    ctx.lineCap = "round";
    ctx.beginPath();
    ctx.moveTo(BELT_X0, BELT_Y);
    ctx.lineTo(BELT_X1, BELT_Y);
    ctx.stroke();

    ctx.strokeStyle = "rgba(120,255,200,0.35)";
    ctx.lineWidth = 52;
    ctx.beginPath();
    ctx.moveTo(x0, BELT_Y);
    ctx.lineTo(x1, BELT_Y);
    ctx.stroke();

    ctx.fillStyle = "rgba(255,255,255,0.06)";
    ctx.fillRect(BELT_X0 - 20, BELT_Y - 36, BELT_LEN + 40, 72);

    ctx.fillStyle = "rgba(255,230,240,0.85)";
    ctx.font = "13px Segoe UI, PingFang SC, Microsoft YaHei, sans-serif";
    ctx.textAlign = "center";
    ctx.fillText("回转带 · 仅亮区可拖到转盘", cx, BELT_Y - 48);
    ctx.restore();
  }

  function drawPlates() {
    for (const pl of state.plates) {
      const p = platePos(pl.t);
      const def = PUDDING[pl.type];
      ctx.save();
      ctx.beginPath();
      ctx.arc(p.x, p.y, 28, 0, Math.PI * 2);
      ctx.fillStyle = def.color;
      ctx.fill();
      ctx.strokeStyle = def.rim;
      ctx.lineWidth = 3;
      ctx.stroke();
      ctx.fillStyle = "rgba(0,0,0,0.55)";
      ctx.font = "12px sans-serif";
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(def.name, p.x, p.y);
      ctx.restore();
    }
  }

  function drawTurntable() {
    ctx.save();
    ctx.strokeStyle = "rgba(255,200,230,0.35)";
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(cx, cy, SLOT_R + 22, 0, Math.PI * 2);
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(cx, cy, SLOT_R - 22, 0, Math.PI * 2);
    ctx.stroke();

    for (let i = 0; i < SLOT_COUNT; i++) {
      const sp = slotPos(i);
      ctx.beginPath();
      ctx.arc(sp.x, sp.y, 22, 0, Math.PI * 2);
      ctx.strokeStyle = "rgba(255,255,255,0.15)";
      ctx.stroke();
    }
    ctx.restore();
  }

  function drawPuddings() {
    for (let i = 0; i < SLOT_COUNT; i++) {
      const s = state.slots[i];
      if (!s) continue;
      const def = PUDDING[s.type];
      const sp = slotPos(i);
      ctx.save();
      ctx.beginPath();
      ctx.arc(sp.x, sp.y, 34, 0, Math.PI * 2);
      const grd = ctx.createRadialGradient(sp.x - 8, sp.y - 8, 4, sp.x, sp.y, 36);
      grd.addColorStop(0, "#ffffff");
      grd.addColorStop(0.35, def.color);
      grd.addColorStop(1, def.rim);
      ctx.fillStyle = grd;
      ctx.fill();
      ctx.strokeStyle = "rgba(255,255,255,0.35)";
      ctx.lineWidth = 2;
      ctx.stroke();
      ctx.strokeStyle = "rgba(255,255,255,0.12)";
      ctx.beginPath();
      ctx.arc(sp.x, sp.y, def.range, 0, Math.PI * 2);
      ctx.stroke();
      ctx.restore();
    }
  }

  function drawCore() {
    ctx.save();
    ctx.beginPath();
    ctx.arc(cx, cy, CORE_R, 0, Math.PI * 2);
    const g = ctx.createRadialGradient(cx - 6, cy - 6, 4, cx, cy, CORE_R);
    g.addColorStop(0, "#fff8ff");
    g.addColorStop(0.5, "#ffb8e8");
    g.addColorStop(1, "#c94b9d");
    ctx.fillStyle = g;
    ctx.fill();
    ctx.strokeStyle = "rgba(255,255,255,0.5)";
    ctx.lineWidth = 3;
    ctx.stroke();
    ctx.fillStyle = "rgba(40,10,30,0.75)";
    ctx.font = "bold 11px sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText("核心", cx, cy);
    ctx.restore();
  }

  function drawEnemies() {
    for (const e of state.enemies) {
      ctx.save();
      ctx.beginPath();
      ctx.arc(e.x, e.y, e.r, 0, Math.PI * 2);
      ctx.fillStyle = "#4a4a5a";
      ctx.fill();
      ctx.strokeStyle = "#9090a8";
      ctx.stroke();
      const ratio = Math.max(0, e.hp / e.maxHp);
      ctx.fillStyle = "#ff6670";
      ctx.fillRect(e.x - 18, e.y - 28, 36 * ratio, 4);
      ctx.strokeStyle = "rgba(0,0,0,0.4)";
      ctx.strokeRect(e.x - 18, e.y - 28, 36, 4);
      ctx.restore();
    }
  }

  function drawDrag() {
    if (!state.drag) return;
    const def = PUDDING[state.drag.type];
    ctx.save();
    ctx.globalAlpha = 0.88;
    ctx.beginPath();
    ctx.arc(state.drag.cx, state.drag.cy, 32, 0, Math.PI * 2);
    ctx.fillStyle = def.color;
    ctx.fill();
    ctx.strokeStyle = def.rim;
    ctx.lineWidth = 3;
    ctx.stroke();
    ctx.restore();
  }

  function drawGameOver() {
    if (!state.gameOver) return;
    ctx.save();
    ctx.fillStyle = "rgba(10,6,18,0.72)";
    ctx.fillRect(0, 0, W, H);
    ctx.fillStyle = "#ffe8f4";
    ctx.font = "bold 28px PingFang SC, Microsoft YaHei, sans-serif";
    ctx.textAlign = "center";
    ctx.fillText("烤炉失守 — 点击画面重开", cx, cy);
    ctx.font = "16px sans-serif";
    ctx.fillStyle = "rgba(255,220,240,0.85)";
    ctx.fillText("消灭 " + kills + " · 波次 " + wave, cx, cy + 36);
    ctx.restore();
  }

  function draw() {
    drawBackground();
    drawTurntable();
    drawBelt();
    drawPuddings();
    drawCore();
    drawEnemies();
    drawPlates();
    drawDrag();
    drawGameOver();
  }

  function updateHud(now) {
    const hp = Math.max(0, state.coreHp);
    const r = hp / state.coreMax;
    hpFill.style.transform = "scaleX(" + r + ")";
    hpText.textContent = Math.ceil(hp) + " / " + state.coreMax;
    waveText.textContent = String(wave);
    knockText.textContent = String(kills);

    btnCard1.disabled = now < state.card1Cd || state.gameOver;
    btnCard2.disabled = now < state.card2Cd || state.gameOver;
    cd1.textContent = now < state.card1Cd ? Math.ceil((state.card1Cd - now) / 1000) + "s" : "";
    cd2.textContent = now < state.card2Cd ? Math.ceil((state.card2Cd - now) / 1000) + "s" : "";
  }

  function loop(t) {
    const dt = Math.min(0.05, (t - lastT) / 1000);
    lastT = t;
    update(dt);
    draw();
    updateHud(performance.now());
    requestAnimationFrame(loop);
  }

  function resetGame() {
    state.coreHp = 100;
    state.coreMax = 100;
    state.tableAngle = 0;
    state.slots = Array.from({ length: SLOT_COUNT }, () => null);
    state.plates = [];
    state.enemies = [];
    state.drag = null;
    state.card1Cd = 0;
    state.card2Cd = 0;
    state.buffWideUntil = 0;
    state.buffSlowUntil = 0;
    state.gameOver = false;
    state.plateSpawnAcc = 0;
    state.spawnAcc = 0;
    wave = 1;
    kills = 0;
    for (let i = 0; i < 4; i++) {
      const k = TYPE_KEYS[(Math.random() * TYPE_KEYS.length) | 0];
      state.plates.push({ id: state.nextPlateId++, type: k, t: i * 0.14 });
    }
  }

  canvas.addEventListener("click", () => {
    if (state.gameOver) resetGame();
  });

  window.addEventListener("resize", resize);
  resize();
  resetGame();
  requestAnimationFrame(loop);
})();
