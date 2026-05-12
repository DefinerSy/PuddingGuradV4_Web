import { buildWaveTable, rollEnemyKindForWave } from "./waves.js";
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
/** 绘制时圆弧中心相对槽位逻辑的竖直偏移（与 drawDefenderPudding 一致） */
const PUDDING_SPRITE_CY_OFF = -1;
const PUDDING_SPRITE_R = 20;
/** 悬停说明用：贴合可见圆盘，小于拖拽/拾取半径，避免光标在圆旁仍一直认为在布丁上 */
const PUDDING_TOOLTIP_HOVER_R = PUDDING_SPRITE_R + 3;
const SLOT_PICK_R = 44;
const MAX_PLACE_START_DIST = 200;
/** 数字键操控轨道时用该槽的中心弧位对齐鼠标纵向位置（0..SLOTS_PER_BELT-1） */
const KEYBOARD_BELT_SNAP_SLOT = Math.floor(SLOTS_PER_BELT / 2);

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
    this.enemyShots = [];
    /** null | 0..BELT_COUNT-1 ，数字键 1–3 选中后与鼠标纵向同步滚动，不占拖曳态 */
    this.keyboardBeltFollowBi = null;

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

  placePuddingInFirstEmpty(typeId, level = 1) {
    const pos = this.firstEmptySlot();
    if (!pos) return false;
    this.belts[pos.bi].slots[pos.si].pudding = makePudding(typeId, level);
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
    this.enemyShots = [];

    const counts = aggregateTraitCounts(this.belts);
    const syn = computeSynergyMultipliers(counts);
    if (syn.kingHealPerWave > 0) {
      this.kingHp = Math.min(this.kingMaxHp, this.kingHp + syn.kingHealPerWave);
    }
  }

  pickPuddingAt(mx, my, opts = {}) {
    const hitR = opts.hitR ?? PUDDING_HIT_R;
    const cyAdj = opts.cyAdj ?? 0;
    let best = null;
    let bestD = Infinity;
    for (let bi = 0; bi < this.belts.length; bi++) {
      const belt = this.belts[bi];
      for (let si = 0; si < belt.slots.length; si++) {
        if (!belt.slots[si].pudding) continue;
        const p = this.slotWorldPos(belt, si);
        const d = dist(mx, my, p.x, p.y + cyAdj);
        if (d <= hitR && d < bestD) {
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

  clearKeyboardBeltFollow() {
    const bi = this.keyboardBeltFollowBi;
    if (bi !== null && this.belts[bi]) {
      delete this.belts[bi]._keyboardScrollUx;
    }
    this.keyboardBeltFollowBi = null;
  }

  /**
   * 数字键 1..BELT_COUNT 切换到对应竖轨，由 applyKeyboardBeltFollowFromMouse 贴合鼠标；
   * 拖拽布丁中时忽略以免冲突。
   */
  setKeyboardBeltFollowFromKey(beltIndex) {
    if (
      this.phase !== "combat" &&
      this.phase !== "placeStarter"
    )
      return;
    if (
      beltIndex < 0 ||
      beltIndex >= this.belts.length
    )
      return;
    if (this.drag?.kind === "pudding") return;
    if (this.drag?.kind === "belt") {
      const b = this.belts[this.drag.bi];
      b.scroll = modPos(b.scroll);
      this.drag = null;
    }

    const prevBi = this.keyboardBeltFollowBi;
    if (prevBi !== null && prevBi !== beltIndex && this.belts[prevBi]) {
      delete this.belts[prevBi]._keyboardScrollUx;
    }
    this.keyboardBeltFollowBi = beltIndex;
    if (prevBi !== beltIndex) {
      delete this.belts[beltIndex]._keyboardScrollUx;
    }
  }

  /** 将当前选中轨的中间槽对齐到画布纵坐标 `my`（无需按住左键） */
  applyKeyboardBeltFollowFromMouse(_mx, my) {
    const bi =
      this.keyboardBeltFollowBi;
    if (bi == null) return;
    if (
      this.phase !== "combat" &&
      this.phase !== "placeStarter"
    ) {
      return;
    }
    const belt = this.belts[bi];
    if (!belt) return;
    const ty = clamp(
      my,
      PLAY_TOP,
      PLAY_BOTTOM
    );

    // 展开的 scroll：与上一帧在实数轴上取最短等价类，避免仅 mod PLAY_H 时跨边产生约一整槽的相位跳变
    const uxTarget =
      ty - PLAY_TOP -
      slotAlong(KEYBOARD_BELT_SNAP_SLOT);
    const prevUx =
      belt._keyboardScrollUx !== undefined ? belt._keyboardScrollUx : belt.scroll;
    belt._keyboardScrollUx =
      uxTarget +
      Math.round((prevUx - uxTarget) / PLAY_H) * PLAY_H;

    belt.scroll = modPos(belt._keyboardScrollUx);
    belt.vy = 0;
  }

  onPointerDown(mx, my) {
    if (this.phase === "placeStarter") {
      return { type: "place" };
    }
    if (this.phase !== "combat") return null;

    const pud = this.pickPuddingAt(mx, my);
    if (pud) {
      this.drag = { kind: "pudding", bi: pud.bi, si: pud.si, mx, my };
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
      belt.vy = dy / 0.016; // Approx velocity
    } else if (this.drag.kind === "pudding") {
      this.drag.mx = mx;
      this.drag.my = my;
    }
  }

  getHoveredPudding(mx, my) {
    const hit = this.pickPuddingAt(mx, my, {
      hitR: PUDDING_TOOLTIP_HOVER_R,
      cyAdj: PUDDING_SPRITE_CY_OFF,
    });
    if (!hit) return null;
    const pud = this.belts[hit.bi].slots[hit.si].pudding;
    pud.name = PUDDING_TYPES[pud.typeId]?.name || "布丁";
    return pud;
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
        
        if (a && b && a.typeId === b.typeId && a.level === b.level && a.level < 4 && !a.isDead && !b.isDead) {
          this.belts[to.bi].slots[to.si].pudding = makePudding(a.typeId, a.level + 1);
          this.belts[from.bi].slots[from.si].pudding = null;
        } else {
          this.belts[from.bi].slots[from.si].pudding = b;
          this.belts[to.bi].slots[to.si].pudding = a;
        }
      }
    }
    this.drag = null;
  }

  update(dt) {
    if (this.phase !== "combat" || this.gameOver || this.victory) return;

    this.updateSpawns(dt);
    this.updateEnemies(dt);
    this.updateEnemyShots(dt);

    if (this.gameOver) {
      this.enemyShots = [];
      this.phase = "ended";
      return;
    }
    if (this.victory) {
      this.enemyShots = [];
      this.phase = "ended";
      return;
    }

    this.updateDefenders(dt);
    this.updateProjectiles(dt);
    this.updateFloatTexts(dt);

    if (this.kingHp <= 0) {
      this.enemyShots = [];
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

      for (const belt of this.belts) {
        for (const slot of belt.slots) {
          if (slot.pudding) {
            slot.pudding.hp = slot.pudding.maxHp;
            slot.pudding.isDead = false;
          }
        }
      }

      this.enemyShots = [];
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
    const kind = boss ? "ghost" : rollEnemyKindForWave(this.wave);
    this.spawnEnemy(lane, cfg, kind);
    this.spawnQueue -= 1;
    this.spawnTimer = this.spawnInterval;
  }

  spawnEnemy(lane, cfg, enemyKind) {
    const boss = !!cfg.boss;
    const kind = boss ? "ghost" : enemyKind || "ghost";

    let speedMul = 1;
    let hpMul = 1;
    let hitR = boss ? 34 : 18;
    let rangedStopX = 0;
    let rangedInterval = 2.4;
    let rangedCd = 0;
    let rangedBoltDmgPud = 0;
    let rangedBoltDmgKing = 0;
    let laneSwitchTimer = 0;

    if (kind === "shifter") {
      speedMul = 0.96;
      laneSwitchTimer = 1.4 + Math.random() * 2.2;
    } else if (kind === "ranged") {
      speedMul = 0.8;
      hpMul = 0.9;
      hitR = 17;
      rangedStopX = 670 + Math.random() * 110;
      rangedInterval = 2.1 + Math.random() * 0.85;
      rangedCd = 0.55 + Math.random() * 0.55;
      rangedBoltDmgPud = Math.max(9, Math.floor(cfg.damageToKing * 1.15));
      rangedBoltDmgKing = Math.max(4, Math.floor(cfg.damageToKing * 0.42));
    }

    const speed = cfg.speed * speedMul;
    const hp = cfg.hp * hpMul;

    const e = {
      id: Math.random().toString(36).slice(2),
      enemyKind: kind,
      lane,
      x: SPAWN_X,
      y: laneCenterY(lane),
      hp,
      maxHp: hp,
      speed,
      vx: -speed,
      knockbackVx: 0,
      knockbackVy: 0,
      damageToKing: cfg.damageToKing,
      bounty: cfg.bounty,
      boss,
      hitFlash: 0,
      activeEffects: {},
      hitRadius: hitR,
      laneSwitchTimer,
      rangedStopX,
      rangedInterval,
      rangedCd,
      rangedBoltDmgPud,
      rangedBoltDmgKing,
    };

    this.enemies.push(e);
  }

  updateEnemies(dt) {
    const reach = KING_X2 + 10;
    
    // Apply effects and movement
    for (const e of this.enemies) {
      if (e.hitFlash > 0) e.hitFlash -= dt;

      if (e.activeEffects.fire && e.activeEffects.fire.duration > 0) {
        e.activeEffects.fire.duration -= dt;
        e.activeEffects.fire.tickTimer -= dt;
        if (e.activeEffects.fire.tickTimer <= 0) {
          e.hp -= 4;
          this.addFloatText(e.x, e.y - 20, "-4", "#ff6b33");
          e.activeEffects.fire.tickTimer = 0.5;
        }
      }

      if (e.knockbackVx !== 0 || e.knockbackVy !== 0) {
        e.x += e.knockbackVx * dt;
        e.y += e.knockbackVy * dt;
        e.knockbackVx *= Math.pow(0.01, dt);
        e.knockbackVy *= Math.pow(0.01, dt);
        if (Math.abs(e.knockbackVx) < 20) e.knockbackVx = 0;
        if (Math.abs(e.knockbackVy) < 20) e.knockbackVy = 0;
        e.lane = yToLane(e.y);
      } else {
        const kind = e.enemyKind || "ghost";
        const syncLaneY = () => {
          const ty = laneCenterY(e.lane);
          e.y += (ty - e.y) * 8 * dt;
        };

        if (kind === "shifter") {
          e.laneSwitchTimer -= dt;
          if (e.laneSwitchTimer <= 0) {
            const opts = [];
            if (e.lane > 0) opts.push(e.lane - 1);
            if (e.lane < LANES - 1) opts.push(e.lane + 1);
            if (opts.length) {
              e.lane = opts[Math.floor(Math.random() * opts.length)];
            }
            e.laneSwitchTimer = 2 + Math.random() * 2.2;
          }
          e.x += e.vx * dt;
          syncLaneY();
        } else if (kind === "ranged") {
          const stopX = e.rangedStopX || 710;
          e.rangedCd -= dt;
          let dx = e.vx * dt;
          if (e.x <= stopX) dx *= 0.12;
          e.x += dx;
          const inFireBand = e.x <= stopX + 55;
          if (e.rangedCd <= 0 && inFireBand && e.hp > 0) {
            this.enemyShots.push({
              x: e.x - 26,
              y: e.y,
              vx: -(215 + Math.min(this.wave, 20) * 5),
              lane: e.lane,
              dmgPud: e.rangedBoltDmgPud,
              dmgKing: e.rangedBoltDmgKing,
              life: 3.8,
            });
            e.rangedCd = e.rangedInterval;
          }
          syncLaneY();
        } else {
          e.x += e.vx * dt;
          syncLaneY();
        }
      }
    }

    // Enemy knockback collisions
    for (let i = 0; i < this.enemies.length; i++) {
      const e1 = this.enemies[i];
      if (Math.abs(e1.knockbackVx) > 50 || Math.abs(e1.knockbackVy) > 50) {
        for (let j = 0; j < this.enemies.length; j++) {
          if (i === j) continue;
          const e2 = this.enemies[j];
          if (dist(e1.x, e1.y, e2.x, e2.y) < e1.hitRadius + e2.hitRadius) {
             e2.hp -= 15;
             e2.hitFlash = 0.12;
             this.addFloatText(e2.x, e2.y, "-15", "#fff");
             e1.knockbackVx *= 0.5;
             e1.knockbackVy *= 0.5;
          }
        }
      }
    }

    const remain = [];
    for (const e of this.enemies) {
      if (e.x <= reach) {
        this.kingHp -= e.damageToKing;
        this.addFloatText(KING_X2, e.y, `-${e.damageToKing}`, "#ff6b8a");
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

  updateEnemyShots(dt) {
    const next = [];
    for (const s of this.enemyShots) {
      s.life -= dt;
      if (s.life <= 0) continue;
      s.x += s.vx * dt;

      let consumed = false;

      outer: for (const belt of this.belts) {
        for (let si = 0; si < belt.slots.length; si++) {
          const pud = belt.slots[si].pudding;
          if (!pud || pud.isDead) continue;
          const pos = this.slotWorldPos(belt, si);
          if (pos.lane !== s.lane) continue;
          if (dist(s.x, s.y, pos.x, pos.y) < PUDDING_HIT_R + 12) {
            pud.hp -= s.dmgPud;
            pud.hitFlash = 0.12;
            this.addFloatText(pos.x, pos.y - 18, `-${s.dmgPud}`, "#ff9ec4");
            if (pud.hp <= 0) pud.isDead = true;
            consumed = true;
            break outer;
          }
        }
      }

      if (!consumed && s.x <= KING_X2 + 52 && s.y >= PLAY_TOP && s.y <= PLAY_BOTTOM) {
        this.kingHp -= s.dmgKing;
        this.addFloatText(KING_X2 + 6, s.y, `-${s.dmgKing}`, "#ff6b8a");
        consumed = true;
      }

      if (!consumed && s.x > KING_X1 - 80) next.push(s);
    }
    this.enemyShots = next;
  }

  updateDefenders(dt) {
    const counts = aggregateTraitCounts(this.belts);
    const syn = computeSynergyMultipliers(counts);

    for (const belt of this.belts) {
      if (this.drag && this.drag.kind === "belt" && this.drag.bi === belt.id) {
         belt.vy = belt.vy * 0.9 || 0;
      } else {
         belt.vy = 0;
      }
    }

    for (const belt of this.belts) {
      for (let si = 0; si < belt.slots.length; si++) {
        const slot = belt.slots[si];
        const pud = slot.pudding;
        if (!pud || pud.isDead) continue;

        if (pud.hitFlash > 0) pud.hitFlash -= dt;

        const pos = this.slotWorldPos(belt, si);

        for (const e of this.enemies) {
          if (dist(pos.x, pos.y, e.x, e.y) < PUDDING_HIT_R + e.hitRadius) {
             pud.hp -= (e.damageToKing * 2) * dt;
             pud.hitFlash = 0.1;
             if (pud.mechanic === "defender") {
                e.knockbackVx = 300;
                e.knockbackVy = (belt.vy || 0) * 0.6;
                e.hitFlash = 0.12;
                pud.hp -= e.damageToKing * 2;
             }
          }
        }

        if (pud.hp <= 0) {
           pud.isDead = true;
           continue;
        }

        if (pud.mechanic === "defender" || (pud.mechanic && pud.mechanic.startsWith("buff_"))) {
          continue;
        }

        pud.attackCd -= dt;
        const range = pud.baseRange * this.global.range * syn.rangeMul;
        const lane = pos.lane;

        let target = null;
        let best = Infinity;
        for (const e of this.enemies) {
          if (e.lane !== lane) continue;
          const dd = dist(pos.x, pos.y, e.x, e.y);
          if (dd <= range && e.x < best) {
            best = e.x;
            target = e;
          }
        }

        const interval = (pud.baseInterval / syn.aspMul) / this.global.asp;
        if (target && pud.attackCd <= 0) {
          const finalDmg = pud.baseDamage * this.global.dmg * syn.damageMul;
          pud.attackCd = interval;
          
          const dx = target.x - pos.x;
          const dy = target.y - pos.y;
          const d = Math.hypot(dx, dy);
          const speed = 260; // Lowered initial speed

          this.projectiles.push({
            x: pos.x,
            y: pos.y,
            vx: (dx / d) * speed,
            vy: (dy / d) * speed,
            damage: finalDmg,
            attackType: pud.attackType || "normal",
            effects: new Set(),
            buffedBy: new Set(),
            life: 3.0
          });
        }
      }
    }
  }

  updateProjectiles(dt) {
    const newProj = [];
    this.projectiles = this.projectiles.filter((p) => {
      p.life -= dt;
      if (p.life <= 0) return false;
      
      p.x += p.vx * dt;
      p.y += p.vy * dt;

      for (const belt of this.belts) {
        for (let si = 0; si < belt.slots.length; si++) {
          const pud = belt.slots[si].pudding;
          if (pud && !pud.isDead && pud.mechanic && pud.mechanic.startsWith("buff_")) {
            const pos = this.slotWorldPos(belt, si);
            if (dist(p.x, p.y, pos.x, pos.y) < PUDDING_HIT_R + 10) {
              const pudId = belt.id + "_" + si;
              if (!p.buffedBy.has(pudId)) {
                p.buffedBy.add(pudId);
                if (pud.mechanic === "buff_fire") {
                  p.effects.add("fire");
                  p.damage *= 1.25;
                }
              }
            }
          }
        }
      }

      let hitEnemy = null;
      for (const e of this.enemies) {
        if (dist(p.x, p.y, e.x, e.y) < e.hitRadius + 5) {
           hitEnemy = e;
           break;
        }
      }

      if (hitEnemy) {
         hitEnemy.hp -= p.damage;
         hitEnemy.hitFlash = 0.12;
         
         if (p.effects.has("fire")) {
           hitEnemy.activeEffects.fire = { duration: 3.5, tickTimer: 0 };
         }

         if (p.attackType === "aoe") {
           for (const e of this.enemies) {
             if (e !== hitEnemy && dist(hitEnemy.x, hitEnemy.y, e.x, e.y) < 140) {
               e.hp -= p.damage * 0.5;
               e.hitFlash = 0.12;
             }
           }
           this.addFloatText(hitEnemy.x, hitEnemy.y, "BOOM", "#ff4444");
         }

         if (p.attackType === "split") {
           let splits = 0;
           for (const e of this.enemies) {
             if (e !== hitEnemy && dist(hitEnemy.x, hitEnemy.y, e.x, e.y) < 250) {
               const dx = e.x - hitEnemy.x;
               const dy = e.y - hitEnemy.y;
               const d = Math.hypot(dx, dy);
               const speed = 260;
               newProj.push({
                 x: hitEnemy.x, y: hitEnemy.y,
                 vx: (dx/d)*speed, vy: (dy/d)*speed,
                 damage: p.damage * 0.6,
                 attackType: "normal",
                 effects: new Set(p.effects),
                 buffedBy: new Set(),
                 life: 1.0
               });
               splits++;
               if (splits >= 2) break;
             }
           }
         }
         return false;
      }
      return true;
    });
    
    this.projectiles.push(...newProj);
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

    this.drawDraggedPuddingFollow(ctx);

    for (const s of this.enemyShots) {
      ctx.save();
      ctx.fillStyle = "rgba(255,75,130,0.95)";
      ctx.shadowColor = "rgba(255,130,168,0.55)";
      ctx.shadowBlur = 10;
      ctx.beginPath();
      ctx.arc(s.x, s.y, 6.5, 0, Math.PI * 2);
      ctx.fill();
      ctx.shadowBlur = 0;
      ctx.restore();
    }

    for (const p of this.projectiles) {
      ctx.fillStyle = p.effects.has("fire") ? "#ff6b33" : "#ffe066";
      ctx.beginPath();
      ctx.arc(p.x, p.y, 6, 0, Math.PI * 2);
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
    const keyFollow =
      this.keyboardBeltFollowBi === belt.id;
    ctx.save();
    ctx.fillStyle = keyFollow
      ? "rgba(22, 38, 58, 0.62)"
      : "rgba(18, 28, 48, 0.55)";
    ctx.fillRect(x - hw, top, hw * 2, bot - top);
    ctx.strokeStyle = keyFollow
      ? "rgba(122, 231, 199, 0.55)"
      : "rgba(122, 231, 199, 0.35)";
    ctx.lineWidth = 1.5;
    ctx.strokeRect(x - hw + 0.75, top + 0.75, hw * 2 - 1.5, bot - top - 1.5);

    ctx.strokeStyle = "rgba(122, 231, 199, 0.45)";
    ctx.lineWidth = 2;
    ctx.setLineDash([8, 10]);
    ctx.lineDashOffset = -modPos(belt.scroll);
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

  drawDraggedPuddingFollow(ctx) {
    const d = this.drag;
    if (!d || d.kind !== "pudding") return;
    const belt = this.belts[d.bi];
    const slot = belt?.slots[d.si];
    const pud = slot?.pudding;
    if (!pud || pud.isDead) return;
    const mx = clamp(d.mx, 22, CANVAS_W - 22);
    const my = clamp(d.my, PLAY_TOP + 22, PLAY_BOTTOM - 22);
    ctx.save();
    ctx.globalAlpha = 0.93;
    // drawDefenderPudding 主圆心在 (x, y-1)，传入 y = my+1 使圆心在指针处
    this.drawDefenderPudding(ctx, mx, my + 1, pud);
    ctx.restore();
  }

  drawBeltSlotsAndPuddings(ctx, belt) {
    for (let si = 0; si < belt.slots.length; si++) {
      const pos = this.slotWorldPos(belt, si);
      const slot = belt.slots[si];
      const lifted =
        this.drag?.kind === "pudding" &&
        belt.id === this.drag.bi &&
        si === this.drag.si &&
        slot.pudding;
      ctx.save();
      const slotLooksEmpty = !slot.pudding || lifted;
      ctx.strokeStyle = slotLooksEmpty
        ? "rgba(255,255,255,0.06)"
        : "rgba(255,255,255,0.12)";
      ctx.lineWidth = 1.5;
      ctx.setLineDash(slotLooksEmpty ? [4, 4] : []);
      ctx.beginPath();
      ctx.arc(pos.x, pos.y, 14, 0, Math.PI * 2);
      ctx.stroke();
      ctx.setLineDash([]);

      if (slot.pudding && !lifted) {
        if (slot.pudding.isDead) {
           ctx.globalAlpha = 0.3;
           this.drawDefenderPudding(ctx, pos.x, pos.y, slot.pudding);
           ctx.globalAlpha = 1.0;
        } else {
           this.drawDefenderPudding(ctx, pos.x, pos.y, slot.pudding);
        }
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
    const lvl = pud.level || 1;
    const rarityColors = { 1: "rgba(0,0,0,0.22)", 2: "#4ade80", 3: "#3b82f6", 4: "#a855f7" };

    if (pud.hitFlash > 0) {
      ctx.shadowColor = "#fff";
      ctx.shadowBlur = 12;
    }
    ctx.fillStyle = pud.hitFlash > 0 ? "#fff" : `hsl(${hue} 68% 68%)`;
    ctx.beginPath();
    ctx.arc(x, y - 1, 20, 0, Math.PI * 2);
    ctx.fill();
    ctx.shadowBlur = 0;
    
    ctx.fillStyle = rarityColors[lvl] || rarityColors[1];
    for (let i = 0; i < lvl; i++) {
       ctx.beginPath();
       ctx.arc(x - (lvl - 1) * 3.5 + i * 7, y - 16, 2.5, 0, Math.PI * 2);
       ctx.fill();
    }

    ctx.fillStyle = "rgba(0,0,0,0.22)";
    ctx.beginPath();
    ctx.arc(x - 5, y - 7, 2.5, 0, Math.PI * 2);
    ctx.arc(x + 7, y - 7, 2.5, 0, Math.PI * 2);
    ctx.fill();
    
    if (pud.hp !== undefined && pud.hp < pud.maxHp) {
       ctx.fillStyle = "rgba(0,0,0,0.5)";
       ctx.fillRect(x - 14, y + 14, 28, 4);
       ctx.fillStyle = "#ff6b8a";
       ctx.fillRect(x - 14, y + 14, 28 * Math.max(0, pud.hp / pud.maxHp), 4);
    }
  }

  drawEnemy(ctx, e) {
    const y = e.y;
    const r = e.hitRadius || (e.boss ? 34 : 18);
    if (e.hitFlash > 0) {
      ctx.shadowColor = "#fff";
      ctx.shadowBlur = 16;
    }
    const kind = e.enemyKind || "ghost";
    if (e.boss) {
      ctx.fillStyle = "rgba(200,160,255,0.95)";
    } else if (kind === "shifter") {
      ctx.fillStyle = "rgba(130,230,185,0.78)";
    } else if (kind === "ranged") {
      ctx.fillStyle = "rgba(255,155,178,0.82)";
    } else {
      ctx.fillStyle = "rgba(200,220,255,0.55)";
    }
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
      
      let lvl = 1;
      const r = Math.random();
      if (this.wave >= 4 && r < 0.15 + this.wave * 0.01) lvl = 2;
      if (this.wave >= 8 && r < 0.05 + this.wave * 0.005) lvl = 3;
      
      const price = Math.floor((18 + this.wave * 2 + Math.floor(Math.random() * 6)) * Math.pow(2.2, lvl - 1));
      
      pool.push({
        id: `shop_pud_${k}_${tid}`,
        title: `Lv.${lvl} ${def.name}`,
        desc: `${formatPuddingTraitsLine({ traits: def.traits })}。需空槽位。`,
        price: price,
        puddingType: tid,
        canBuy: () => this.hasEmptySlot(),
        buy: () => this.placePuddingInFirstEmpty(tid, lvl),
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
