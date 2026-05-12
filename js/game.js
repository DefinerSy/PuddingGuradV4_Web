import { buildWaveTable } from "./waves.js";

const LANES = 5;
const BELT_COUNT = 3;
const CANVAS_W = 1200;
const CANVAS_H = 640;
const PLAY_TOP = 72;
const PLAY_BOTTOM = CANVAS_H - 24;
const KING_X1 = 18;
const KING_X2 = 108;
const BELT_X0 = 120;
const BELT_X1 = CANVAS_W - 40;
const SPAWN_X = CANVAS_W - 20;

function laneCenterY(lane) {
  const h = (PLAY_BOTTOM - PLAY_TOP) / LANES;
  return PLAY_TOP + h * (lane + 0.5);
}

function clamp(v, a, b) {
  return Math.max(a, Math.min(b, v));
}

function dist(ax, ay, bx, by) {
  const dx = ax - bx;
  const dy = ay - by;
  return Math.hypot(dx, dy);
}

function makeDefender() {
  return {
    damage: 12,
    attackCd: 0,
    attackInterval: 0.55,
    range: 720,
  };
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
    this.draggingBelt = null;
    this.dragOffsetY = 0;
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
      this.belts.push({
        id: i,
        lane: i % LANES,
        defender: null,
      });
    }
  }

  start() {
    this.reset();
    this.phase = "placeStarter";
    this.gold = 8;
  }

  /** 点击某条传送带索引 0..2，放置开局布丁 */
  placeStarterOnBelt(beltIndex) {
    const b = this.belts[beltIndex];
    if (!b || b.defender) return false;
    b.defender = makeDefender();
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
  }

  /** 世界坐标：哪条传送带被点中（含拖动命中） */
  pickBeltAt(mx, my) {
    let best = null;
    let bestDy = Infinity;
    for (let i = 0; i < this.belts.length; i++) {
      const belt = this.belts[i];
      const y = laneCenterY(belt.lane);
      if (mx >= BELT_X0 && mx <= BELT_X1) {
        const dy = Math.abs(my - y);
        if (dy < 38 && dy < bestDy) {
          bestDy = dy;
          best = i;
        }
      }
    }
    return best;
  }

  onPointerDown(mx, my) {
    if (this.phase === "placeStarter") {
      const idx = this.pickBeltAt(mx, my);
      if (idx !== null) return { type: "place", belt: idx };
      return null;
    }
    if (this.phase !== "combat") return null;
    const idx = this.pickBeltAt(mx, my);
    if (idx !== null) {
      this.draggingBelt = idx;
      const y = laneCenterY(this.belts[idx].lane);
      this.dragOffsetY = my - y;
      return { type: "drag" };
    }
    return null;
  }

  onPointerMove(mx, my) {
    if (this.draggingBelt === null) return;
    const belt = this.belts[this.draggingBelt];
    const h = (PLAY_BOTTOM - PLAY_TOP) / LANES;
    const targetY = my - this.dragOffsetY;
    const laneFloat = (targetY - PLAY_TOP) / h - 0.5;
    belt.lane = clamp(Math.round(laneFloat), 0, LANES - 1);
  }

  onPointerUp() {
    this.draggingBelt = null;
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
      if (this.wave === 20) {
        return;
      }
      this.shopOpened = true;
      this.gold += this.waveTable[this.wave].clearGold;
      this.rollShopOffers();
      this.phase = "shop";
    }
  }

  updateSpawns(dt) {
    if (this.spawnQueue <= 0) {
      return;
    }
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
        if (e.boss) {
          this.gameOver = true;
        }
        continue;
      }
      if (e.hp <= 0) {
        this.gold += e.bounty;
        if (e.boss) {
          this.victory = true;
        }
        continue;
      }
      remain.push(e);
    }
    this.enemies = remain;
  }

  updateDefenders(dt) {
    for (const belt of this.belts) {
      const d = belt.defender;
      if (!d) continue;
      d.attackCd -= dt;
      const ax = 150;
      const ay = laneCenterY(belt.lane);
      const range = d.range * this.global.range;
      let target = null;
      let best = Infinity;
      for (const e of this.enemies) {
        if (e.lane !== belt.lane) continue;
        const dd = dist(ax, ay, e.x, ay);
        if (dd <= range && e.x < best) {
          best = e.x;
          target = e;
        }
      }
      const interval = d.attackInterval / this.global.asp;
      if (target && d.attackCd <= 0) {
        const dmg = d.damage * this.global.dmg;
        target.hp -= dmg;
        target.hitFlash = 0.12;
        d.attackCd = interval;
        this.projectiles.push({
          x1: ax,
          y1: ay,
          x2: target.x,
          y2: ay,
          t: 0,
          dur: 0.08,
        });
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

    // 背景格
    ctx.fillStyle = "#12162a";
    ctx.fillRect(0, 0, CANVAS_W, CANVAS_H);
    ctx.strokeStyle = "rgba(255,255,255,0.04)";
    ctx.lineWidth = 1;
    for (let i = 0; i <= LANES; i++) {
      const y = PLAY_TOP + ((PLAY_BOTTOM - PLAY_TOP) / LANES) * i;
      ctx.beginPath();
      ctx.moveTo(BELT_X0, y);
      ctx.lineTo(BELT_X1, y);
      ctx.stroke();
    }

    // 国王区
    const grd = ctx.createLinearGradient(KING_X1, 0, KING_X2, 0);
    grd.addColorStop(0, "rgba(255, 200, 120, 0.25)");
    grd.addColorStop(1, "rgba(255, 160, 200, 0.08)");
    ctx.fillStyle = grd;
    ctx.fillRect(KING_X1, PLAY_TOP, KING_X2 - KING_X1, PLAY_BOTTOM - PLAY_TOP);
    this.drawKing(ctx);

    // 五路浅带
    const laneH = (PLAY_BOTTOM - PLAY_TOP) / LANES;
    for (let i = 0; i < LANES; i++) {
      const y0 = PLAY_TOP + laneH * i;
      ctx.fillStyle = i % 2 === 0 ? "rgba(255,255,255,0.02)" : "rgba(255,255,255,0.04)";
      ctx.fillRect(BELT_X0, y0, BELT_X1 - BELT_X0, laneH);
    }

    // 传送带
    for (const belt of this.belts) {
      this.drawBelt(ctx, belt);
    }

    // 敌人
    for (const e of this.enemies) {
      this.drawEnemy(ctx, e);
    }

    // 飞弹
    for (const p of this.projectiles) {
      const k = clamp(p.t / p.dur, 0, 1);
      const x = p.x1 + (p.x2 - p.x1) * k;
      const y = p.y1 + (p.y2 - p.y1) * k;
      ctx.fillStyle = "#ffe066";
      ctx.beginPath();
      ctx.arc(x, y, 6, 0, Math.PI * 2);
      ctx.fill();
    }

    // 飘字
    ctx.font = "600 14px Segoe UI, PingFang SC, Microsoft YaHei, sans-serif";
    ctx.textAlign = "center";
    for (const ft of this.floatTexts) {
      ctx.fillStyle = ft.color;
      ctx.fillText(ft.text, ft.x, ft.y);
    }

    // 波次角标
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
    ctx.scale(1, 1);
    // 身体
    ctx.fillStyle = "#ffd79a";
    ctx.beginPath();
    ctx.ellipse(0, 6, 34, 40, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = "rgba(120,80,40,0.35)";
    ctx.lineWidth = 2;
    ctx.stroke();
    // 小皇冠
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

  drawBelt(ctx, belt) {
    const y = laneCenterY(belt.lane);
    ctx.save();
    ctx.strokeStyle = "rgba(122, 231, 199, 0.55)";
    ctx.lineWidth = 3;
    ctx.setLineDash([14, 10]);
    ctx.beginPath();
    ctx.moveTo(BELT_X0, y);
    ctx.lineTo(BELT_X1, y);
    ctx.stroke();
    ctx.setLineDash([]);
    // 寿司碟感：椭圆板
    ctx.fillStyle = "rgba(255,255,255,0.08)";
    ctx.beginPath();
    ctx.ellipse(150, y, 46, 18, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = "rgba(255,255,255,0.2)";
    ctx.lineWidth = 1.2;
    ctx.stroke();

    if (belt.defender) {
      this.drawDefenderPudding(ctx, 150, y, belt.id);
    } else if (this.phase === "placeStarter") {
      ctx.fillStyle = "rgba(255,255,255,0.25)";
      ctx.font = "12px sans-serif";
      ctx.textAlign = "center";
      ctx.fillText("点击放置", 150, y + 4);
    }
    ctx.restore();
  }

  drawDefenderPudding(ctx, x, y, beltId) {
    const hue = [200, 140, 280][beltId % 3];
    ctx.fillStyle = `hsl(${hue} 70% 72%)`;
    ctx.beginPath();
    ctx.arc(x, y - 2, 22, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = "rgba(0,0,0,0.2)";
    ctx.beginPath();
    ctx.arc(x - 6, y - 8, 3, 0, Math.PI * 2);
    ctx.arc(x + 8, y - 8, 3, 0, Math.PI * 2);
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
    // 血条
    const w = e.boss ? 80 : 44;
    ctx.fillStyle = "rgba(0,0,0,0.45)";
    ctx.fillRect(e.x - w / 2, y - r - 14, w, 6);
    ctx.fillStyle = "#7ae7c7";
    ctx.fillRect(e.x - w / 2, y - r - 14, w * clamp(e.hp / e.maxHp, 0, 1), 6);
  }

  /** 商店：生成随机商品 */
  rollShopOffers() {
    const pool = [];
    const emptyBelts = this.belts.filter((b) => !b.defender).length;
    if (emptyBelts > 0) {
      pool.push({
        id: "pudding",
        title: "布丁守卫",
        desc: "在一条空传送带上摆放新的布丁。",
        price: 22 + this.wave * 2,
        canBuy: () => this.belts.some((b) => !b.defender),
        buy: () => {
          const slot = this.belts.find((b) => !b.defender);
          if (slot) slot.defender = makeDefender();
        },
      });
    }
    pool.push(
      {
        id: "dmg",
        title: "焦糖涂层",
        desc: "所有布丁伤害 +12%。",
        price: 14,
        canBuy: () => true,
        buy: () => {
          this.global.dmg += 0.12;
        },
      },
      {
        id: "asp",
        title: "薄荷糖浆",
        desc: "攻击速度 +10%。",
        price: 14,
        canBuy: () => true,
        buy: () => {
          this.global.asp += 0.1;
        },
      },
      {
        id: "range",
        title: "望远勺子",
        desc: "射程 +8%。",
        price: 12,
        canBuy: () => true,
        buy: () => {
          this.global.range += 0.08;
        },
      },
      {
        id: "heal",
        title: "蜂蜜淋面",
        desc: "国王布丁恢复 25 生命。",
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
    while (picks.length < 4 && used.size < pool.length) {
      const c = pool[Math.floor(Math.random() * pool.length)];
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
    o.price = Math.floor(o.price * 1.25);
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
    return {
      wave: this.wave,
      maxWave: 20,
      gold: this.gold,
      kingHp: this.kingHp,
      kingMaxHp: this.kingMaxHp,
      phase: this.phase,
      victory: this.victory,
      gameOver: this.gameOver,
    };
  }
}
