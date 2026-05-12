import { buildWaveTable } from "./waves.js";
import {
  aggregateTraitCounts,
  computeSynergyMultipliers,
  formatPuddingTraitsLine,
  formatSynergySummary,
  makePudding,
  PUDDING_TYPES,
} from "./puddings.js";

const LANES = 5;
const BELT_COUNT = 3;
const SLOTS_PER_BELT = 5;
const CANVAS_W = 1200;
const CANVAS_H = 640;
const PLAY_TOP = 72;
const PLAY_BOTTOM = CANVAS_H - 24;
const PLAY_H = PLAY_BOTTOM - PLAY_TOP;
const KING_X1 = 18;
const KING_X2 = 108;
const BELT_X0 = 120;
const BELT_X1 = CANVAS_W - 40;
const SPAWN_X = CANVAS_W - 20;
const BELT_CENTERS_X = [340, 600, 860];
const BELT_HIT_HW = 34;
const PUDDING_HIT_R = 28;
const SLOT_PICK_R = 44;
const MAX_PLACE_START_DIST = 200;

function laneCenterY(lane) {
  const h = PLAY_H / LANES;
  return PLAY_TOP + h * (lane + 0.5);
}

function clamp(v, a, b) {
  return Math.max(a, Math.min(b, v));
}

function modPos(v, H = PLAY_H) {
  let m = v % H;
  if (m < 0) m += H;
  return m;
}

function dist(ax, ay, bx, by) {
  const dx = ax - bx;
  const dy = ay - by;
  return Math.hypot(dx, dy);
}

function yToLane(y) {
  const h = PLAY_H / LANES;
  return clamp(Math.floor((y - PLAY_TOP) / h), 0, LANES - 1);
}

/** 槽位在环上的固定弧长位置（中心） */
function slotAlong(i) {
  return ((i + 0.5) * PLAY_H) / SLOTS_PER_BELT;
}

export class Game {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext("2d");
    this.waveTable = buildWaveTable();
    this.reset();
  }

  reset() {
    this.phase = "menu";
    this.wave = 1;
    this.gold = 0;
    this.kingMaxHp = 100;
    this.kingHp = 100;
    this.global = { dmg: 1, asp: 1, range: 1 };
    this.starterPlaced = false;
    this.drag = null;
    this.dragLastMy = 0;
    this.enemies = [];
    this.spawnQueue = 0;
    this.spawnTimer = 0;
    this.spawnInterval = 1;
    this.shopOpened = false;
    this.victory = false;
    this.gameOver = false;
    this.floatTexts = [];
    this.projectiles = [];

    this.belts = [];
    for (let i = 0; i < BELT_COUNT; i++) {
      const slots = [];
      for (let s = 0; s < SLOTS_PER_BELT; s++) {
        slots.push({ pudding: null });
      }
      this.belts.push({
        id: i,
        x: BELT_CENTERS_X[i],
        scroll: i * 36,
        slots,
      });
    }
  }

  start() {
    this.reset();
    this.phase = "placeStarter";
    this.gold = 10;
  }

  slotWorldPos(belt, slotIndex) {
    const along = slotAlong(slotIndex);
    const y = PLAY_TOP + modPos(along + belt.scroll);
    const lane = yToLane(y);
    return { x: belt.x, y, lane };
  }

  countPuddings() {
    let n = 0;
    for (const b of this.belts) {
      for (const s of b.slots) {
        if (s.pudding) n++;
      }
    }
    return n;
  }

  hasEmptySlot() {
    return this.belts.some((b) => b.slots.some((s) => !s.pudding));
  }

  firstEmptySlot() {
    for (let bi = 0; bi < this.belts.length; bi++) {
      for (let si = 0; si < this.belts[bi].slots.length; si++) {
        if (!this.belts[bi].slots[si].pudding) return { bi, si };
      }
    }
    return null;
  }

  placePuddingInFirstEmpty(typeId) {
    const pos = this.firstEmptySlot();
    if (!pos) return false;
    this.belts[pos.bi].slots[pos.si].pudding = makePudding(typeId);
    return true;
  }

  /** 开局：在离点击最近的空槽放一只原味布丁 */
  placeStarter(mx, my) {
    let best = null;
    let bestD = Infinity;
    for (let bi = 0; bi < this.belts.length; bi++) {
      const belt = this.belts[bi];
      if (Math.abs(mx - belt.x) > BELT_HIT_HW + 20) continue;
      for (let si = 0; si < belt.slots.length; si++) {
        if (belt.slots[si].pudding) continue;
        const p = this.slotWorldPos(belt, si);
        const d = dist(mx, my, p.x, p.y);
        if (d < bestD) {
          bestD = d;
          best = { bi, si };
        }
      }
    }
    if (!best || bestD > MAX_PLACE_START_DIST) return false;
    this.belts[best.bi].slots[best.si].pudding = makePudding("vanilla");
    this.starterPlaced = true;
    this.phase = "combat";
    this.beginWave();
    return true;
  }

  beginWave() {
    const cfg = this.waveTable[this.wave];
    if (!cfg) return;
    this.spawnQueue = cfg.ghosts;
    this.spawnTimer = 0.4;
    this.spawnInterval = cfg.spawnInterval;
    this.shopOpened = false;
    this.enemies = [];

    const counts = aggregateTraitCounts(this.belts);
    const syn = computeSynergyMultipliers(counts);
    if (syn.kingHealPerWave > 0) {
      this.kingHp = Math.min(this.kingMaxHp, this.kingHp + syn.kingHealPerWave);
    }
  }

  pickPuddingAt(mx, my) {
    let best = null;
    let bestD = Infinity;
    for (let bi = 0; bi < this.belts.length; bi++) {
      const belt = this.belts[bi];
      for (let si = 0; si < belt.slots.length; si++) {
        if (!belt.slots[si].pudding) continue;
        const p = this.slotWorldPos(belt, si);
        const d = dist(mx, my, p.x, p.y);
        if (d <= PUDDING_HIT_R && d < bestD) {
          bestD = d;
          best = { bi, si };
        }
      }
    }
    return best;
  }

  pickSlotAt(mx, my) {
    let best = null;
    let bestD = Infinity;
    for (let bi = 0; bi < this.belts.length; bi++) {
      const belt = this.belts[bi];
      if (Math.abs(mx - belt.x) > BELT_HIT_HW + 24) continue;
      for (let si = 0; si < belt.slots.length; si++) {
        const p = this.slotWorldPos(belt, si);
        const d = dist(mx, my, p.x, p.y);
        if (d < bestD && d <= SLOT_PICK_R) {
          bestD = d;
          best = { bi, si };
        }
      }
    }
    return best;
  }

  hitBeltColumn(mx, my) {
    if (my < PLAY_TOP || my > PLAY_BOTTOM) return null;
    let best = null;
    let bestDx = Infinity;
    for (let bi = 0; bi < this.belts.length; bi++) {
      const belt = this.belts[bi];
      const dx = Math.abs(mx - belt.x);
      if (dx <= BELT_HIT_HW && dx < bestDx) {
        bestDx = dx;
        best = bi;
      }
    }
    return best;
  }

  onPointerDown(mx, my) {
    if (this.phase === "placeStarter") {
      return { type: "place" };
    }
    if (this.phase !== "combat") return null;

    const pud = this.pickPuddingAt(mx, my);
    if (pud) {
      this.drag = { kind: "pudding", bi: pud.bi, si: pud.si };
      return { type: "pudding" };
    }

    const col = this.hitBeltColumn(mx, my);
    if (col !== null) {
      this.drag = { kind: "belt", bi: col };
      this.dragLastMy = my;
      return { type: "belt" };
    }
    return null;
  }

  onPointerMove(mx, my) {
    if (!this.drag) return;
    if (this.drag.kind === "belt") {
      const belt = this.belts[this.drag.bi];
      const dy = my - this.dragLastMy;
      this.dragLastMy = my;
      belt.scroll += dy;
    }
  }

  onPointerUp(mx, my) {
    if (!this.drag) return;

    if (this.drag.kind === "belt") {
      const belt = this.belts[this.drag.bi];
      belt.scroll = modPos(belt.scroll);
    } else if (this.drag.kind === "pudding") {
      const from = { bi: this.drag.bi, si: this.drag.si };
      const to = this.pickSlotAt(mx, my);
      if (to && (from.bi !== to.bi || from.si !== to.si)) {
        const a = this.belts[from.bi].slots[from.si].pudding;
        const b = this.belts[to.bi].slots[to.si].pudding;
        this.belts[from.bi].slots[from.si].pudding = b;
        this.belts[to.bi].slots[to.si].pudding = a;
      }
    }
    this.drag = null;
  }

  update(dt) {
    if (this.phase !== "combat" || this.gameOver || this.victory) return;

    this.updateSpawns(dt);
    this.updateEnemies(dt);

    if (this.gameOver) {
      this.phase = "ended";
      return;
    }
    if (this.victory) {
      this.phase = "ended";
      return;
    }

    this.updateDefenders(dt);
    this.updateProjectiles(dt);
    this.updateFloatTexts(dt);

    if (this.kingHp <= 0) {
      this.kingHp = 0;
      this.gameOver = true;
      this.phase = "ended";
      return;
    }

    const waveDone = this.spawnQueue <= 0 && this.enemies.length === 0;
    if (waveDone && !this.shopOpened) {
      if (this.wave === 20) return;
      this.shopOpened = true;
      this.gold += this.waveTable[this.wave].clearGold;
      this.rollShopOffers();
      this.phase = "shop";
    }
  }

  updateSpawns(dt) {
    if (this.spawnQueue <= 0) return;
    this.spawnTimer -= dt;
    if (this.spawnTimer > 0) return;
    const cfg = this.waveTable[this.wave];
    const boss = !!cfg.boss;
    const lane = boss ? 2 : Math.floor(Math.random() * LANES);
    this.spawnEnemy(lane, cfg);
    this.spawnQueue -= 1;
    this.spawnTimer = this.spawnInterval;
  }

  spawnEnemy(lane, cfg) {
    const boss = !!cfg.boss;
    this.enemies.push({
      id: Math.random().toString(36).slice(2),
      lane,
      x: SPAWN_X,
      hp: cfg.hp,
      maxHp: cfg.hp,
      speed: cfg.speed,
      damageToKing: cfg.damageToKing,
      bounty: cfg.bounty,
      boss,
      hitFlash: 0,
    });
  }

  updateEnemies(dt) {
    const reach = KING_X2 + 10;
    for (const e of this.enemies) {
      e.x -= e.speed * dt;
      if (e.hitFlash > 0) e.hitFlash -= dt;
    }
    const remain = [];
    for (const e of this.enemies) {
      if (e.x <= reach) {
        this.kingHp -= e.damageToKing;
        this.addFloatText(KING_X2, laneCenterY(e.lane), `-${e.damageToKing}`, "#ff6b8a");
        if (e.boss) this.gameOver = true;
        continue;
      }
      if (e.hp <= 0) {
        this.gold += e.bounty;
        if (e.boss) this.victory = true;
        continue;
      }
      remain.push(e);
    }
    this.enemies = remain;
  }

  updateDefenders(dt) {
    const counts = aggregateTraitCounts(this.belts);
    const syn = computeSynergyMultipliers(counts);

    for (const belt of this.belts) {
      for (let si = 0; si < belt.slots.length; si++) {
        const slot = belt.slots[si];
        const pud = slot.pudding;
        if (!pud) continue;

        pud.attackCd -= dt;
        const pos = this.slotWorldPos(belt, si);
        const range = pud.baseRange * this.global.range * syn.rangeMul;
        const lane = pos.lane;

        let target = null;
        let best = Infinity;
        for (const e of this.enemies) {
          if (e.lane !== lane) continue;
          const dd = dist(pos.x, pos.y, e.x, laneCenterY(e.lane));
          if (dd <= range && e.x < best) {
            best = e.x;
            target = e;
          }
        }

        const interval = (pud.baseInterval / syn.aspMul) / this.global.asp;
        if (target && pud.attackCd <= 0) {
          const finalDmg = pud.baseDamage * this.global.dmg * syn.damageMul;
          target.hp -= finalDmg;
          target.hitFlash = 0.12;
          pud.attackCd = interval;
          this.projectiles.push({
            x1: pos.x,
            y1: pos.y,
            x2: target.x,
            y2: laneCenterY(target.lane),
            t: 0,
            dur: 0.08,
          });
        }
      }
    }
  }

  updateProjectiles(dt) {
    this.projectiles = this.projectiles.filter((p) => {
      p.t += dt;
      return p.t < p.dur;
    });
  }

  updateFloatTexts(dt) {
    this.floatTexts = this.floatTexts.filter((ft) => {
      ft.life -= dt;
      ft.y -= 22 * dt;
      return ft.life > 0;
    });
  }

  addFloatText(x, y, text, color) {
    this.floatTexts.push({ x, y, text, color, life: 0.9 });
  }

  draw() {
    const ctx = this.ctx;
    ctx.clearRect(0, 0, CANVAS_W, CANVAS_H);

    ctx.fillStyle = "#12162a";
    ctx.fillRect(0, 0, CANVAS_W, CANVAS_H);
    ctx.strokeStyle = "rgba(255,255,255,0.04)";
    ctx.lineWidth = 1;
    for (let i = 0; i <= LANES; i++) {
      const y = PLAY_TOP + (PLAY_H / LANES) * i;
      ctx.beginPath();
      ctx.moveTo(BELT_X0, y);
      ctx.lineTo(BELT_X1, y);
      ctx.stroke();
    }

    const grd = ctx.createLinearGradient(KING_X1, 0, KING_X2, 0);
    grd.addColorStop(0, "rgba(255, 200, 120, 0.25)");
    grd.addColorStop(1, "rgba(255, 160, 200, 0.08)");
    ctx.fillStyle = grd;
    ctx.fillRect(KING_X1, PLAY_TOP, KING_X2 - KING_X1, PLAY_BOTTOM - PLAY_TOP);
    this.drawKing(ctx);

    const laneH = PLAY_H / LANES;
    for (let i = 0; i < LANES; i++) {
      const y0 = PLAY_TOP + laneH * i;
      ctx.fillStyle = i % 2 === 0 ? "rgba(255,255,255,0.02)" : "rgba(255,255,255,0.04)";
      ctx.fillRect(BELT_X0, y0, BELT_X1 - BELT_X0, laneH);
    }

    for (const belt of this.belts) {
      this.drawVerticalBeltTrack(ctx, belt);
    }

    for (const e of this.enemies) {
      this.drawEnemy(ctx, e);
    }

    for (const belt of this.belts) {
      this.drawBeltSlotsAndPuddings(ctx, belt);
    }

    for (const p of this.projectiles) {
      const k = clamp(p.t / p.dur, 0, 1);
      const x = p.x1 + (p.x2 - p.x1) * k;
      const y = p.y1 + (p.y2 - p.y1) * k;
      ctx.fillStyle = "#ffe066";
      ctx.beginPath();
      ctx.arc(x, y, 5, 0, Math.PI * 2);
      ctx.fill();
    }

    ctx.font = "600 14px Segoe UI, PingFang SC, Microsoft YaHei, sans-serif";
    ctx.textAlign = "center";
    for (const ft of this.floatTexts) {
      ctx.fillStyle = ft.color;
      ctx.fillText(ft.text, ft.x, ft.y);
    }

    ctx.fillStyle = "rgba(255,255,255,0.35)";
    ctx.font = "12px monospace";
    ctx.textAlign = "right";
    ctx.fillText(`WAVE ${this.wave}`, CANVAS_W - 16, 28);
  }

  drawKing(ctx) {
    const cx = (KING_X1 + KING_X2) / 2;
    const cy = (PLAY_TOP + PLAY_BOTTOM) / 2;
    ctx.save();
    ctx.translate(cx, cy);
    ctx.fillStyle = "#ffd79a";
    ctx.beginPath();
    ctx.ellipse(0, 6, 34, 40, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = "rgba(120,80,40,0.35)";
    ctx.lineWidth = 2;
    ctx.stroke();
    ctx.fillStyle = "#ffe566";
    ctx.beginPath();
    ctx.moveTo(-18, -28);
    ctx.lineTo(-10, -12);
    ctx.lineTo(0, -22);
    ctx.lineTo(10, -12);
    ctx.lineTo(18, -28);
    ctx.lineTo(14, -36);
    ctx.lineTo(-14, -36);
    ctx.closePath();
    ctx.fill();
    ctx.restore();
  }

  drawVerticalBeltTrack(ctx, belt) {
    const x = belt.x;
    const hw = 26;
    const top = PLAY_TOP;
    const bot = PLAY_BOTTOM;
    ctx.save();
    ctx.fillStyle = "rgba(18, 28, 48, 0.55)";
    ctx.fillRect(x - hw, top, hw * 2, bot - top);
    ctx.strokeStyle = "rgba(122, 231, 199, 0.35)";
    ctx.lineWidth = 1.5;
    ctx.strokeRect(x - hw + 0.75, top + 0.75, hw * 2 - 1.5, bot - top - 1.5);

    ctx.strokeStyle = "rgba(122, 231, 199, 0.45)";
    ctx.lineWidth = 2;
    ctx.setLineDash([8, 10]);
    ctx.lineDashOffset = -modPos(belt.scroll * 1.15);
    ctx.beginPath();
    ctx.moveTo(x, top);
    ctx.lineTo(x, bot);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.lineDashOffset = 0;

    ctx.strokeStyle = "rgba(255,255,255,0.1)";
    ctx.beginPath();
    ctx.arc(x, top, hw, 0, Math.PI, true);
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(x, bot, hw, Math.PI, 0, true);
    ctx.stroke();

    ctx.fillStyle = "rgba(122, 231, 199, 0.18)";
    ctx.font = "11px sans-serif";
    ctx.textAlign = "center";
    ctx.fillText("↻", x, top - 6);
    ctx.fillText("↻", x, bot + 16);
    ctx.restore();
  }

  drawBeltSlotsAndPuddings(ctx, belt) {
    for (let si = 0; si < belt.slots.length; si++) {
      const pos = this.slotWorldPos(belt, si);
      const slot = belt.slots[si];
      ctx.save();
      ctx.strokeStyle = slot.pudding ? "rgba(255,255,255,0.12)" : "rgba(255,255,255,0.06)";
      ctx.lineWidth = 1.5;
      ctx.setLineDash(slot.pudding ? [] : [4, 4]);
      ctx.beginPath();
      ctx.arc(pos.x, pos.y, 14, 0, Math.PI * 2);
      ctx.stroke();
      ctx.setLineDash([]);

      if (slot.pudding) {
        this.drawDefenderPudding(ctx, pos.x, pos.y, slot.pudding);
      } else if (this.phase === "placeStarter") {
        ctx.fillStyle = "rgba(255,255,255,0.15)";
        ctx.font = "10px sans-serif";
        ctx.textAlign = "center";
        ctx.fillText("空", pos.x, pos.y + 3);
      }
      ctx.restore();
    }
  }

  drawDefenderPudding(ctx, x, y, pud) {
    const hue = pud.hue ?? 200;
    ctx.fillStyle = `hsl(${hue} 68% 68%)`;
    ctx.beginPath();
    ctx.arc(x, y - 1, 20, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = "rgba(0,0,0,0.22)";
    ctx.beginPath();
    ctx.arc(x - 5, y - 7, 2.5, 0, Math.PI * 2);
    ctx.arc(x + 7, y - 7, 2.5, 0, Math.PI * 2);
    ctx.fill();
  }

  drawEnemy(ctx, e) {
    const y = laneCenterY(e.lane);
    const r = e.boss ? 34 : 18;
    if (e.hitFlash > 0) {
      ctx.shadowColor = "#fff";
      ctx.shadowBlur = 16;
    }
    ctx.fillStyle = e.boss ? "rgba(200,160,255,0.95)" : "rgba(200,220,255,0.55)";
    ctx.beginPath();
    ctx.arc(e.x, y, r, 0, Math.PI * 2);
    ctx.fill();
    ctx.shadowBlur = 0;
    ctx.strokeStyle = "rgba(255,255,255,0.35)";
    ctx.lineWidth = 2;
    ctx.stroke();
    const w = e.boss ? 80 : 44;
    ctx.fillStyle = "rgba(0,0,0,0.45)";
    ctx.fillRect(e.x - w / 2, y - r - 14, w, 6);
    ctx.fillStyle = "#7ae7c7";
    ctx.fillRect(e.x - w / 2, y - r - 14, w * clamp(e.hp / e.maxHp, 0, 1), 6);
  }

  rollShopOffers() {
    const pool = [];
    const typeIds = Object.keys(PUDDING_TYPES).filter((k) => k !== "vanilla");

    for (let k = 0; k < 3; k++) {
      const tid = typeIds[Math.floor(Math.random() * typeIds.length)];
      const def = PUDDING_TYPES[tid];
      pool.push({
        id: `shop_pud_${k}_${tid}`,
        title: def.name,
        desc: `${formatPuddingTraitsLine({ traits: def.traits })}。需空槽位。`,
        price: 18 + this.wave * 2 + Math.floor(Math.random() * 6),
        puddingType: tid,
        canBuy: () => this.hasEmptySlot(),
        buy: () => this.placePuddingInFirstEmpty(tid),
      });
    }

    pool.push(
      {
        id: "dmg",
        title: "焦糖涂层",
        desc: "全局伤害 +12%。",
        price: 14,
        canBuy: () => true,
        buy: () => {
          this.global.dmg += 0.12;
        },
      },
      {
        id: "asp",
        title: "薄荷糖浆",
        desc: "全局攻速 +10%。",
        price: 14,
        canBuy: () => true,
        buy: () => {
          this.global.asp += 0.1;
        },
      },
      {
        id: "range",
        title: "望远勺子",
        desc: "全局射程 +8%。",
        price: 12,
        canBuy: () => true,
        buy: () => {
          this.global.range += 0.08;
        },
      },
      {
        id: "heal",
        title: "蜂蜜淋面",
        desc: "国王立刻恢复 25 生命。",
        price: 10,
        canBuy: () => this.kingHp < this.kingMaxHp,
        buy: () => {
          this.kingHp = Math.min(this.kingMaxHp, this.kingHp + 25);
        },
      },
      {
        id: "crown",
        title: "王室训练",
        desc: "国王最大生命 +15。",
        price: 18,
        canBuy: () => true,
        buy: () => {
          this.kingMaxHp += 15;
          this.kingHp += 15;
        },
      },
    );

    const picks = [];
    const used = new Set();
    const shuffled = [...pool].sort(() => Math.random() - 0.5);
    for (const c of shuffled) {
      if (picks.length >= 4) break;
      if (!used.has(c.id)) {
        used.add(c.id);
        picks.push({ ...c });
      }
    }
    this.shopOffers = picks;
  }

  buyOffer(index) {
    const o = this.shopOffers[index];
    if (!o) return false;
    if (this.gold < o.price) return false;
    if (!o.canBuy()) return false;
    this.gold -= o.price;
    o.buy();
    o.price = Math.floor(o.price * 1.22);
    return true;
  }

  rerollShop(cost) {
    if (this.gold < cost) return false;
    this.gold -= cost;
    this.rollShopOffers();
    return true;
  }

  nextWaveFromShop() {
    if (this.victory || this.gameOver) return;
    if (this.wave >= 20) return;
    this.wave += 1;
    this.phase = "combat";
    this.beginWave();
  }

  getHud() {
    const counts = aggregateTraitCounts(this.belts);
    return {
      wave: this.wave,
      maxWave: 20,
      gold: this.gold,
      kingHp: this.kingHp,
      kingMaxHp: this.kingMaxHp,
      phase: this.phase,
      victory: this.victory,
      gameOver: this.gameOver,
      synergyLine: formatSynergySummary(counts),
      puddingCount: this.countPuddings(),
    };
  }
}
