import { buildWaveTable, rollEnemyKindForWave } from "./waves.js";
import {
  aggregateTraitCounts,
  computeSynergyMultipliers,
  formatPuddingTraitsLine,
  formatSynergySummary,
  makePudding,
  PUDDING_TYPES,
  rollShopPuddingTypeId,
} from "./puddings.js";
import {
  sfxAoeBoom,
  sfxEnemyDeath,
  sfxHitEnemy,
  sfxKingHurt,
  sfxKingRoyalVolley,
  sfxMerge,
  sfxPlacePudding,
  sfxRangedFire,
  sfxShoot,
  sfxShootSplit,
} from "./audio.js";

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
/** 玉米加农炮：轰炸半径（像素） */
const CORN_BOMB_RADIUS = 132;
/** 绘制时圆弧中心相对槽位逻辑的竖直偏移（与 drawDefenderPudding 一致） */
const PUDDING_SPRITE_CY_OFF = -1;
const PUDDING_SPRITE_R = 20;
/** 悬停说明用：贴合可见圆盘，小于拖拽/拾取半径，避免光标在圆旁仍一直认为在布丁上 */
const PUDDING_TOOLTIP_HOVER_R = PUDDING_SPRITE_R + 3;
const SLOT_PICK_R = 44;
const MAX_PLACE_START_DIST = 200;
/** 数字键操控轨道时用该槽的中心弧位对齐鼠标纵向位置（0..SLOTS_PER_BELT-1） */
const KEYBOARD_BELT_SNAP_SLOT = Math.floor(SLOTS_PER_BELT / 2);
/** 国王主动技：累计击杀达到该数后可按空格释放五路穿透齐射 */
const KING_SKILL_KILLS_REQUIRED = 22;

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

/** 点到线段的最短距离（像素） */
function pointSegDistance(px, py, ax, ay, bx, by) {
  const abx = bx - ax;
  const aby = by - ay;
  const apx = px - ax;
  const apy = py - ay;
  const ab2 = abx * abx + aby * aby || 1;
  let t = (apx * abx + apy * aby) / ab2;
  t = clamp(t, 0, 1);
  const cx = ax + abx * t;
  const cy = ay + aby * t;
  return dist(px, py, cx, cy);
}

function beltSegLen(belt) {
  return dist(belt.p0.x, belt.p0.y, belt.p1.x, belt.p1.y) || 1;
}

function beltUnitAlong(belt) {
  const L = beltSegLen(belt);
  return {
    ux: (belt.p1.x - belt.p0.x) / L,
    uy: (belt.p1.y - belt.p0.y) / L,
  };
}

/** 敌人从右侧逼近时，用于判定贴近环轨的「靠左」端 x */
function beltLeftHookX(belt) {
  return Math.min(belt.p0.x, belt.p1.x);
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
    /** 战场：`classic` 竖轨 · `diagonal` 斜向环轨 */
    this.mapStyle = "classic";

    /** 王权齐射：本局累计击杀蓄力，满格后主动释放 */
    this.kingSkillKillCharge = 0;
    this.kingSkillKillsRequired = KING_SKILL_KILLS_REQUIRED;

    this.belts = [];
    for (let i = 0; i < BELT_COUNT; i++) {
      const slots = [];
      for (let s = 0; s < SLOTS_PER_BELT; s++) {
        slots.push({ pudding: null });
      }
      const x = BELT_CENTERS_X[i];
      this.belts.push({
        id: i,
        x,
        scroll: i * 36,
        slots,
        p0: { x, y: PLAY_TOP },
        p1: { x, y: PLAY_BOTTOM },
      });
    }
    this.applyBeltLayout();
  }

  /**
   * 从主菜单直接带地图开局：进入放置首布丁阶段（选关做在主菜单按钮上，避免单独遮罩层与旧 JS 缓存问题）。
   * @param {"classic"|"diagonal"} mapStyle
   */
  startWithMap(mapStyle) {
    this.reset();
    this.mapStyle = mapStyle === "diagonal" ? "diagonal" : "classic";
    this.applyBeltLayout();
    this.phase = "placeStarter";
    this.gold = 10;
  }

  applyBeltLayout() {
    for (let i = 0; i < this.belts.length; i++) {
      const b = this.belts[i];
      if (this.mapStyle === "diagonal") {
        const cx = BELT_CENTERS_X[i];
        b.p0 = { x: cx - 178, y: PLAY_TOP + 32 + i * 7 };
        b.p1 = { x: cx + 168, y: PLAY_BOTTOM - 36 - i * 6 };
      } else {
        const x = BELT_CENTERS_X[i];
        b.p0 = { x, y: PLAY_TOP };
        b.p1 = { x, y: PLAY_BOTTOM };
      }
      b.x = (b.p0.x + b.p1.x) / 2;
    }
  }

  slotWorldPos(belt, slotIndex) {
    const along = slotAlong(slotIndex);
    const raw = modPos(along + belt.scroll);
    const u = raw / PLAY_H;
    const x = belt.p0.x + (belt.p1.x - belt.p0.x) * u;
    const y = belt.p0.y + (belt.p1.y - belt.p0.y) * u;
    const lane = yToLane(y);
    return { x, y, lane };
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
    sfxPlacePudding();
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
    for (const b of this.belts) {
      b.hijackEnemyId = null;
      b.hijackScrollSpeed = 0;
    }

    const counts = aggregateTraitCounts(this.belts);
    const syn = computeSynergyMultipliers(counts);
    if (syn.kingHealPerWave > 0) {
      this.kingHp = Math.min(this.kingMaxHp, this.kingHp + syn.kingHealPerWave);
    }
  }

  /**
   * 国王主动技「王权齐射」：击杀蓄满后按空格释放，五路各一发高伤穿透弹。
   * @returns {boolean} 是否成功释放
   */
  tryFireKingRoyalVolley() {
    if (this.phase !== "combat" || this.gameOver || this.victory) return false;
    if (this.kingSkillKillCharge < this.kingSkillKillsRequired) return false;

    this.kingSkillKillCharge = 0;
    const baseDmg = (48 + this.wave * 9) * this.global.dmg;
    const speed = 380;
    const startX = KING_X2 + 28;
    for (let lane = 0; lane < LANES; lane++) {
      const y = laneCenterY(lane);
      this.projectiles.push({
        x: startX,
        y,
        vx: speed,
        vy: 0,
        damage: baseDmg,
        attackType: "king_skill",
        skillLane: lane,
        effects: new Set(),
        buffedBy: new Set(),
        hitIds: new Set(),
        life: 3.4,
        trail: [],
      });
    }
    sfxKingRoyalVolley();
    this.addFloatText(
      KING_X2 + 52,
      PLAY_TOP + PLAY_H * 0.48,
      "王权齐射!",
      "#ffd45a"
    );
    return true;
  }

  /**
   * 增加「王权齐射」蓄力（不超过上限）。
   * @returns {number} 实际增加的格数
   */
  addKingSkillCharge(n = 1) {
    if (this.phase !== "combat" || n <= 0) return 0;
    const cap = this.kingSkillKillsRequired;
    if (this.kingSkillKillCharge >= cap) return 0;
    const add = Math.min(n, cap - this.kingSkillKillCharge);
    this.kingSkillKillCharge += add;
    return add;
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

  /** 用于开始「空白拖轨」；被劫持的轨返回 null，但 pickPuddingAt / pickSlotAt 仍可操作该轨上的布丁与槽位 */
  hitBeltColumn(mx, my) {
    if (my < PLAY_TOP || my > PLAY_BOTTOM) return null;
    let best = null;
    let bestD = Infinity;
    for (let bi = 0; bi < this.belts.length; bi++) {
      const belt = this.belts[bi];
      if (belt.hijackEnemyId) continue;
      const d = pointSegDistance(
        mx,
        my,
        belt.p0.x,
        belt.p0.y,
        belt.p1.x,
        belt.p1.y
      );
      if (d <= BELT_HIT_HW + 8 && d < bestD) {
        bestD = d;
        best = bi;
      }
    }
    return best;
  }

  /** 轰炸落点：在战场竖带内、国王右侧，且不在任一环轨宽带内 */
  isValidCornBombPosition(mx, my) {
    if (this.phase !== "combat") return false;
    if (my < PLAY_TOP + 10 || my > PLAY_BOTTOM - 10) return false;
    if (mx < KING_X2 + 52 || mx > CANVAS_W - 28) return false;
    for (const belt of this.belts) {
      const d = pointSegDistance(
        mx,
        my,
        belt.p0.x,
        belt.p0.y,
        belt.p1.x,
        belt.p1.y
      );
      if (d < BELT_HIT_HW + 48) return false;
    }
    return true;
  }

  fireCornBombard(fromBi, fromSi, mx, my) {
    const slot = this.belts[fromBi]?.slots[fromSi];
    const pud = slot?.pudding;
    if (!pud || pud.isDead || pud.mechanic !== "cob_bombard") return false;
    if ((pud.cornBombCd || 0) > 0) return false;
    if (!this.isValidCornBombPosition(mx, my)) return false;

    const counts = aggregateTraitCounts(this.belts);
    const syn = computeSynergyMultipliers(counts);
    const lv = pud.level || 1;
    const baseDmg =
      (28 + lv * 15 + this.wave * 4.5) * this.global.dmg * syn.damageMul;
    const R = CORN_BOMB_RADIUS;
    const K = 460;

    for (const e of this.enemies) {
      const rr = e.hitRadius || 18;
      if (dist(mx, my, e.x, e.y) >= R + rr) continue;
      e.hp -= baseDmg;
      e.hitFlash = 0.16;
      const dx = e.x - mx;
      const dy = e.y - my;
      const d = Math.hypot(dx, dy) || 1;
      e.knockbackVx += (dx / d) * K;
      e.knockbackVy += (dy / d) * K * 0.52;
    }

    this.addFloatText(mx, my - 28, "轰炸!", "#ffe8a0");
    sfxAoeBoom();
    pud.cornBombCd = pud.cornBombBaseInterval ?? 5;
    pud.hitFlash = 0.22;
    return true;
  }

  clearKeyboardBeltFollow() {
    const bi = this.keyboardBeltFollowBi;
    if (bi !== null && this.belts[bi]) {
      delete this.belts[bi]._keyboardScrollUx;
    }
    this.keyboardBeltFollowBi = null;
  }

  /**
   * 数字键 1..BELT_COUNT 切换到对应环轨，由 applyKeyboardBeltFollowFromMouse 将指定槽贴合到指针在轨上的投影；
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
    if (this.belts[beltIndex]?.hijackEnemyId) return;
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

  /** 将当前选中轨的中间槽对齐到指针在环轨上的投影（无需按住左键） */
  applyKeyboardBeltFollowFromMouse(mx, my) {
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
    if (belt.hijackEnemyId) {
      this.clearKeyboardBeltFollow();
      return;
    }
    const p0 = belt.p0;
    const p1 = belt.p1;
    const abx = p1.x - p0.x;
    const aby = p1.y - p0.y;
    const ab2 = abx * abx + aby * aby || 1;
    const t = clamp(
      ((mx - p0.x) * abx + (my - p0.y) * aby) / ab2,
      0,
      1
    );

    // 展开的 scroll：与上一帧在实数轴上取最短等价类，避免仅 mod PLAY_H 时跨边产生约一整槽的相位跳变
    const uxTarget =
      t * PLAY_H -
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

    /** 仅禁止「空白拖轨」滚动；劫持轨上仍可拖布丁换位（上分支已处理） */
    const col = this.hitBeltColumn(mx, my);
    if (col !== null) {
      this.drag = { kind: "belt", bi: col, lastMx: mx, lastMy: my };
      return { type: "belt" };
    }
    return null;
  }

  onPointerMove(mx, my) {
    if (!this.drag) return;
    if (this.drag.kind === "belt") {
      const belt = this.belts[this.drag.bi];
      if (belt.hijackEnemyId) {
        this.drag = null;
        return;
      }
      const { ux, uy } = beltUnitAlong(belt);
      const lx = this.drag.lastMx ?? my;
      const ly = this.drag.lastMy ?? my;
      const dmx = mx - lx;
      const dmy = my - ly;
      this.drag.lastMx = mx;
      this.drag.lastMy = my;
      const ds = dmx * ux + dmy * uy;
      belt.scroll += ds;
      belt.vy = ds / 0.016;
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
      const a = this.belts[from.bi].slots[from.si].pudding;

      if (
        a &&
        !a.isDead &&
        a.mechanic === "cob_bombard" &&
        (a.cornBombCd || 0) <= 0 &&
        this.isValidCornBombPosition(mx, my)
      ) {
        this.fireCornBombard(from.bi, from.si, mx, my);
      } else if (to && (from.bi !== to.bi || from.si !== to.si)) {
        const b = this.belts[to.bi].slots[to.si].pudding;

        if (a && b && a.typeId === b.typeId && a.level === b.level && a.level < 4 && !a.isDead && !b.isDead) {
          this.belts[to.bi].slots[to.si].pudding = makePudding(a.typeId, a.level + 1);
          this.belts[from.bi].slots[from.si].pudding = null;
          sfxMerge();
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
    this.applyBeltHijackScroll(dt);
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
    } else if (kind === "hijacker") {
      speedMul = 0.9;
      hpMul = 1.12;
      hitR = 19;
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

    if (kind === "hijacker") {
      const freeBi = [];
      for (let i = 0; i < this.belts.length; i++) {
        if (!this.belts[i].hijackEnemyId) freeBi.push(i);
      }
      const choices = freeBi.length ? freeBi : [0, 1, 2];
      e.hijackBeltId = choices[Math.floor(Math.random() * choices.length)];
      e.hijackPhase = "approach";
      e.hijackScrollSpeed =
        (Math.random() < 0.5 ? -1 : 1) * (80 + Math.random() * 38);
    }

    this.enemies.push(e);
  }

  /** 轨骇幽灵死亡或进王座时解除对环轨的劫持 */
  releaseBeltHijackForEnemy(enemyId) {
    if (!enemyId) return;
    for (const b of this.belts) {
      if (b.hijackEnemyId === enemyId) {
        b.hijackEnemyId = null;
        b.hijackScrollSpeed = 0;
      }
    }
  }

  applyBeltHijackScroll(dt) {
    for (const belt of this.belts) {
      if (!belt.hijackEnemyId) continue;
      const v = belt.hijackScrollSpeed || 0;
      if (v === 0) continue;
      belt.scroll += v * dt;
    }
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
            sfxRangedFire();
            e.rangedCd = e.rangedInterval;
          }
          syncLaneY();
        } else if (kind === "hijacker") {
          const bi = e.hijackBeltId ?? 1;
          const belt = this.belts[bi];
          const hookX = belt ? beltLeftHookX(belt) + 52 : BELT_CENTERS_X[bi] ?? BELT_CENTERS_X[1];
          if (e.hijackPhase === "linked") {
            e.vx = 0;
            syncLaneY();
          } else {
            e.x += e.vx * dt;
            syncLaneY();
            if (e.hijackPhase === "approach" && e.x <= hookX) {
              if (belt && !belt.hijackEnemyId) {
                e.hijackPhase = "linked";
                const anchor = beltLeftHookX(belt) + 26;
                e.x = Math.max(anchor + 6, Math.min(e.x, anchor + 28));
                e.vx = 0;
                belt.hijackEnemyId = e.id;
                belt.hijackScrollSpeed = e.hijackScrollSpeed ?? 88;
                if (this.keyboardBeltFollowBi === bi) {
                  this.clearKeyboardBeltFollow();
                }
                if (this.drag?.kind === "belt" && this.drag.bi === bi) {
                  belt.scroll = modPos(belt.scroll);
                  this.drag = null;
                }
                const tx = (belt.p0.x + belt.p1.x) * 0.5;
                const ty = (belt.p0.y + belt.p1.y) * 0.38;
                this.addFloatText(tx, ty, "轨道被劫持", "#ff9a4a");
              } else {
                e.hijackPhase = "failed";
              }
            }
          }
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
        this.releaseBeltHijackForEnemy(e.id);
        this.kingHp -= e.damageToKing;
        sfxKingHurt();
        this.addFloatText(KING_X2, e.y, `-${e.damageToKing}`, "#ff6b8a");
        if (e.boss) this.gameOver = true;
        continue;
      }
      if (e.hp <= 0) {
        this.releaseBeltHijackForEnemy(e.id);
        this.gold += e.bounty;
        sfxEnemyDeath();
        this.addKingSkillCharge(1);
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
        sfxKingHurt();
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

        if (pud.mechanic === "buff_killcharge") {
          const interval = pud.killChargeAuraInterval ?? 4.1;
          pud.killChargeAuraTimer =
            (pud.killChargeAuraTimer ?? interval * 0.75) - dt;
          if (pud.killChargeAuraTimer <= 0) {
            const gained = this.addKingSkillCharge(1);
            if (gained > 0) {
              this.addFloatText(pos.x, pos.y - 30, "+蓄力", "#e8c878");
            }
            pud.killChargeAuraTimer = interval;
          }
        }

        if (pud.mechanic === "cob_bombard" && (pud.cornBombCd || 0) > 0) {
          pud.cornBombCd -= dt;
        }

        if (
          pud.mechanic === "defender" ||
          (pud.mechanic && pud.mechanic.startsWith("buff_")) ||
          pud.mechanic === "cob_bombard"
        ) {
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
            life: 3.0,
            trail: [],
          });
          sfxShoot();
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

      if (!p.trail) p.trail = [];
      p.trail.unshift({ x: p.x, y: p.y });
      const maxTrail = 18;
      const minStep = 5;
      while (
        p.trail.length > 1 &&
        dist(p.trail[0].x, p.trail[0].y, p.trail[1].x, p.trail[1].y) < minStep
      ) {
        p.trail.splice(1, 1);
      }
      while (p.trail.length > maxTrail) p.trail.pop();

      for (const belt of this.belts) {
        for (let si = 0; si < belt.slots.length; si++) {
          const pud = belt.slots[si].pudding;
          if (
            pud &&
            !pud.isDead &&
            pud.mechanic &&
            pud.mechanic.startsWith("buff_") &&
            p.attackType !== "king_skill"
          ) {
            const pos = this.slotWorldPos(belt, si);
            if (dist(p.x, p.y, pos.x, pos.y) < PUDDING_HIT_R + 10) {
              const pudId = belt.id + "_" + si;
              if (!p.buffedBy.has(pudId)) {
                p.buffedBy.add(pudId);
                if (pud.mechanic === "buff_fire") {
                  p.effects.add("fire");
                  p.damage *= 1.25;
                } else if (pud.mechanic === "buff_killcharge") {
                  p.killChargeKillBonus = (p.killChargeKillBonus || 0) + 1;
                }
              }
            }
          }
        }
      }

      if (p.attackType === "king_skill") {
        if (!p.hitIds) p.hitIds = new Set();
        const hitR = 16;
        for (const e of this.enemies) {
          if (e.lane !== p.skillLane) continue;
          if (p.hitIds.has(e.id)) continue;
          if (dist(p.x, p.y, e.x, e.y) < e.hitRadius + hitR) {
            e.hp -= p.damage;
            e.hitFlash = 0.12;
            p.hitIds.add(e.id);
            sfxHitEnemy(Math.floor(e.x + e.y));
          }
        }
        if (p.x > CANVAS_W + 40) return false;
        return true;
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
         sfxHitEnemy(Math.floor(hitEnemy.x + hitEnemy.y));

         if (hitEnemy.hp <= 0) {
           const bonus = p.killChargeKillBonus || 0;
           if (bonus > 0) {
             const gained = this.addKingSkillCharge(bonus);
             if (gained > 0) {
               this.addFloatText(
                 hitEnemy.x,
                 hitEnemy.y - 28,
                 bonus > 1 ? `+${gained}槽` : "+槽",
                 "#ffd45a"
               );
             }
           }
         }
         
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
           sfxAoeBoom();
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
                 killChargeKillBonus: p.killChargeKillBonus || 0,
                 life: 1.0,
                 trail: [],
               });
               splits++;
               if (splits >= 2) break;
             }
           }
           if (splits > 0) sfxShootSplit();
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

  /** 拖尾 + 弹芯：速度方向长条渐变（必显）+ 轨迹采样增强 */
  drawProjectile(ctx, p) {
    const royal = p.attackType === "king_skill";
    const fire = !royal && p.effects.has("fire");
    const killChargeBuff = !royal && (p.killChargeKillBonus || 0) > 0;
    const spd = Math.hypot(p.vx, p.vy) || 260;
    const nx = p.vx / spd;
    const ny = p.vy / spd;
    const ribbonLen = royal
      ? Math.min(160, 52 + spd * 0.32)
      : Math.min(130, 42 + spd * 0.28);
    const bx = p.x - nx * ribbonLen;
    const by = p.y - ny * ribbonLen;

    const coreFill = royal ? "#ffe8a8" : fire ? "#ff9228" : "#fff85c";
    const tailMid = royal
      ? "rgba(200,140,255,"
      : fire
        ? "rgba(255,150,70,"
        : "rgba(255,245,150,";
    const tailHot = royal
      ? "rgba(255,230,160,"
      : fire
        ? "rgba(255,95,40,"
        : "rgba(255,255,230,";

    ctx.save();

    const rib = ctx.createLinearGradient(bx, by, p.x, p.y);
    rib.addColorStop(0, tailMid + "0)");
    rib.addColorStop(0.25, tailMid + (royal ? "0.22)" : "0.15)"));
    rib.addColorStop(0.55, tailMid + (royal ? "0.62)" : "0.55)"));
    rib.addColorStop(0.88, tailHot + "0.9)");
    rib.addColorStop(
      1,
      royal
        ? "rgba(255,255,255,0.98)"
        : fire
          ? "rgba(255,255,220,0.98)"
          : "rgba(255,255,255,0.98)"
    );
    ctx.strokeStyle = rib;
    ctx.lineWidth = royal ? 14 : fire ? 11 : 10;
    ctx.lineCap = "round";
    ctx.beginPath();
    ctx.moveTo(bx, by);
    ctx.lineTo(p.x, p.y);
    ctx.stroke();
    ctx.strokeStyle = royal
      ? "rgba(60,30,90,0.55)"
      : fire
        ? "rgba(40,18,8,0.55)"
        : "rgba(30,24,8,0.5)";
    ctx.lineWidth = royal ? 3.5 : 3;
    ctx.stroke();

    if (killChargeBuff) {
      ctx.strokeStyle = "rgba(255, 215, 120, 0.55)";
      ctx.lineWidth = 5;
      ctx.beginPath();
      ctx.moveTo(bx, by);
      ctx.lineTo(p.x, p.y);
      ctx.stroke();
    }

    const trail = p.trail && p.trail.length >= 2 ? p.trail : null;
    if (trail) {
      for (let i = trail.length - 1; i >= 0; i--) {
        const pt = trail[i];
        const t = trail.length > 1 ? i / (trail.length - 1) : 0;
        const alpha = 0.18 + t * 0.55;
        const rad = (royal ? 2.5 : 2) + t * (royal ? 7 : 6);
        if (royal) {
          ctx.fillStyle = `rgba(230,${160 + t * 70},${255},${alpha})`;
        } else if (fire) {
          ctx.fillStyle = `rgba(255,${70 + t * 140},${30 + t * 60},${alpha})`;
        } else {
          ctx.fillStyle = `rgba(255,${200 + t * 55},${60 + t * 120},${alpha})`;
        }
        ctx.beginPath();
        ctx.arc(pt.x, pt.y, rad, 0, Math.PI * 2);
        ctx.fill();
      }

      const tail = trail[trail.length - 1];
      const grad = ctx.createLinearGradient(tail.x, tail.y, p.x, p.y);
      grad.addColorStop(0, tailMid + "0)");
      grad.addColorStop(0.35, tailMid + "0.35)");
      grad.addColorStop(0.75, tailMid + "0.75)");
      grad.addColorStop(1, tailHot + "0.95)");
      ctx.strokeStyle = grad;
      ctx.lineWidth = royal ? 9 : 7;
      ctx.lineCap = "round";
      ctx.lineJoin = "round";
      ctx.beginPath();
      ctx.moveTo(tail.x, tail.y);
      for (let i = trail.length - 2; i >= 0; i--) {
        ctx.lineTo(trail[i].x, trail[i].y);
      }
      ctx.lineTo(p.x, p.y);
      ctx.stroke();
    }

    ctx.shadowColor = royal
      ? "rgba(200, 120, 255, 0.95)"
      : fire
        ? "rgba(255, 140, 50, 0.95)"
        : "rgba(255, 250, 150, 0.9)";
    ctx.shadowBlur = royal ? 20 : fire ? 16 : 14;
    ctx.fillStyle = coreFill;
    ctx.beginPath();
    ctx.arc(p.x, p.y, royal ? 7.5 : 6.5, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = royal ? "#2a1048" : fire ? "#3a1208" : "#1a1608";
    ctx.lineWidth = royal ? 2.5 : 2;
    ctx.stroke();
    if (killChargeBuff) {
      ctx.strokeStyle = "rgba(255, 210, 90, 0.9)";
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.arc(p.x, p.y, 9.5, 0, Math.PI * 2);
      ctx.stroke();
    }
    ctx.shadowBlur = 0;
    ctx.restore();
  }

  draw() {
    const ctx = this.ctx;
    ctx.clearRect(0, 0, CANVAS_W, CANVAS_H);

    const cx = CANVAS_W * 0.48;
    const cy = PLAY_TOP + PLAY_H * 0.45;
    const bgGrad = ctx.createRadialGradient(cx, cy, 80, cx, cy, 720);
    bgGrad.addColorStop(0, "#3d2848");
    bgGrad.addColorStop(0.35, "#24182c");
    bgGrad.addColorStop(0.75, "#160f1c");
    bgGrad.addColorStop(1, "#0c060e");
    ctx.fillStyle = bgGrad;
    ctx.fillRect(0, 0, CANVAS_W, CANVAS_H);

    ctx.strokeStyle = "rgba(40, 32, 52, 0.9)";
    ctx.lineWidth = 2;
    for (let i = 0; i <= LANES; i++) {
      const y = PLAY_TOP + (PLAY_H / LANES) * i;
      ctx.beginPath();
      ctx.moveTo(BELT_X0, y);
      ctx.lineTo(BELT_X1, y);
      ctx.stroke();
    }

    const grd = ctx.createLinearGradient(KING_X1, PLAY_TOP, KING_X2, PLAY_BOTTOM);
    grd.addColorStop(0, "rgba(80, 50, 40, 0.45)");
    grd.addColorStop(0.5, "rgba(120, 70, 90, 0.2)");
    grd.addColorStop(1, "rgba(40, 28, 48, 0.35)");
    ctx.fillStyle = grd;
    ctx.fillRect(KING_X1, PLAY_TOP, KING_X2 - KING_X1, PLAY_BOTTOM - PLAY_TOP);
    ctx.strokeStyle = "rgba(20, 12, 24, 0.85)";
    ctx.lineWidth = 3;
    ctx.strokeRect(
      KING_X1 + 1.5,
      PLAY_TOP + 1.5,
      KING_X2 - KING_X1 - 3,
      PLAY_BOTTOM - PLAY_TOP - 3
    );
    this.drawKing(ctx);

    const laneH = PLAY_H / LANES;
    for (let i = 0; i < LANES; i++) {
      const y0 = PLAY_TOP + laneH * i;
      ctx.fillStyle =
        i % 2 === 0 ? "rgba(45, 38, 55, 0.55)" : "rgba(38, 32, 48, 0.55)";
      ctx.fillRect(BELT_X0, y0, BELT_X1 - BELT_X0, laneH);
    }

    for (const belt of this.belts) {
      this.drawVerticalBeltTrack(ctx, belt);
    }

    for (const e of this.enemies) {
      this.drawEnemy(ctx, e);
    }

    this.drawHijackerTethers(ctx);

    for (const belt of this.belts) {
      this.drawBeltSlotsAndPuddings(ctx, belt);
    }

    this.drawDraggedPuddingFollow(ctx);

    for (const s of this.enemyShots) {
      ctx.save();
      ctx.fillStyle = "#ff4d8a";
      ctx.shadowColor = "rgba(255, 100, 180, 0.9)";
      ctx.shadowBlur = 14;
      ctx.beginPath();
      ctx.arc(s.x, s.y, 7, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = "#3a1020";
      ctx.lineWidth = 2;
      ctx.stroke();
      ctx.shadowBlur = 0;
      ctx.restore();
    }

    for (const p of this.projectiles) {
      this.drawProjectile(ctx, p);
    }

    ctx.font = '700 15px "Silkscreen", "Noto Sans SC", monospace';
    ctx.textAlign = "center";
    for (const ft of this.floatTexts) {
      const t = ft.text;
      ctx.lineJoin = "round";
      ctx.strokeStyle = "rgba(0,0,0,0.82)";
      ctx.lineWidth = 4;
      ctx.strokeText(t, ft.x, ft.y);
      ctx.fillStyle = ft.color;
      ctx.fillText(t, ft.x, ft.y);
    }

    ctx.fillStyle = "#c8b8d8";
    ctx.font = '700 14px "Silkscreen", monospace';
    ctx.textAlign = "right";
    ctx.lineWidth = 3;
    ctx.strokeStyle = "#0c060c";
    ctx.strokeText(`WAVE ${this.wave}`, CANVAS_W - 14, 30);
    ctx.fillStyle = "#fff275";
    ctx.fillText(`WAVE ${this.wave}`, CANVAS_W - 14, 30);
  }

  drawHijackerTethers(ctx) {
    const t = typeof performance !== "undefined" ? performance.now() : 0;
    for (const e of this.enemies) {
      if (e.enemyKind !== "hijacker" || e.hijackPhase !== "linked") continue;
      const belt = this.belts[e.hijackBeltId];
      if (!belt) continue;
      const tx = (belt.p0.x + belt.p1.x) * 0.5;
      const ty = (belt.p0.y + belt.p1.y) * 0.5;
      ctx.save();
      ctx.strokeStyle = "rgba(255, 140, 70, 0.92)";
      ctx.lineWidth = 2.5;
      ctx.setLineDash([6, 11]);
      ctx.lineDashOffset = -(t * 0.05) % 20;
      ctx.beginPath();
      ctx.moveTo(e.x, e.y);
      ctx.lineTo(tx, ty);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.lineDashOffset = 0;
      ctx.restore();
    }
  }

  drawKing(ctx) {
    const cx = (KING_X1 + KING_X2) / 2;
    const cy = (PLAY_TOP + PLAY_BOTTOM) / 2;
    ctx.save();
    ctx.translate(cx, cy);
    ctx.fillStyle = "#e8b86a";
    ctx.beginPath();
    ctx.ellipse(0, 6, 34, 40, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = "#1a0e08";
    ctx.lineWidth = 4;
    ctx.stroke();
    ctx.strokeStyle = "rgba(255,255,255,0.22)";
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(-10, -2, 8, Math.PI * 0.9, Math.PI * 2.1);
    ctx.stroke();
    ctx.fillStyle = "#ffe566";
    ctx.strokeStyle = "#2a1808";
    ctx.lineWidth = 2;
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
    ctx.stroke();
    ctx.fillStyle = "#1a1210";
    ctx.beginPath();
    ctx.arc(-8, 8, 3.5, 0, Math.PI * 2);
    ctx.arc(8, 8, 3.5, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }

  drawVerticalBeltTrack(ctx, belt) {
    const p0 = belt.p0;
    const p1 = belt.p1;
    const L = beltSegLen(belt);
    const { ux, uy } = beltUnitAlong(belt);
    const hw = 26;
    const px = -uy * hw;
    const py = ux * hw;
    const hijacked = !!belt.hijackEnemyId;
    const keyFollow =
      !hijacked && this.keyboardBeltFollowBi === belt.id;
    ctx.save();
    ctx.lineJoin = "round";
    ctx.lineCap = "round";
    ctx.beginPath();
    ctx.moveTo(p0.x + px, p0.y + py);
    ctx.lineTo(p1.x + px, p1.y + py);
    ctx.lineTo(p1.x - px, p1.y - py);
    ctx.lineTo(p0.x - px, p0.y - py);
    ctx.closePath();
    ctx.fillStyle = hijacked
      ? "rgba(72, 32, 28, 0.93)"
      : keyFollow
        ? "rgba(55, 40, 72, 0.92)"
        : "rgba(38, 28, 52, 0.88)";
    ctx.fill();
    ctx.strokeStyle = hijacked
      ? "#ff7a44"
      : keyFollow
        ? "#9ee671"
        : "#4a3a5c";
    ctx.lineWidth = hijacked ? 3 : keyFollow ? 3 : 2;
    ctx.stroke();

    ctx.strokeStyle = hijacked
      ? "rgba(255, 120, 60, 0.75)"
      : keyFollow
        ? "rgba(158,230,113,0.75)"
        : "rgba(158, 230, 113, 0.35)";
    ctx.lineWidth = 2;
    ctx.setLineDash([6, 8]);
    ctx.lineDashOffset = -(modPos(belt.scroll) * (L / PLAY_H));
    ctx.beginPath();
    ctx.moveTo(p0.x, p0.y);
    ctx.lineTo(p1.x, p1.y);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.lineDashOffset = 0;

    ctx.fillStyle = hijacked
      ? "rgba(255, 140, 90, 0.45)"
      : keyFollow
        ? "rgba(158,230,113,0.35)"
        : "rgba(158, 230, 113, 0.2)";
    ctx.font = '700 11px "Silkscreen", monospace';
    ctx.textAlign = "center";
    const ol = 18;
    ctx.fillText(
      hijacked ? "!" : "↻",
      p0.x - ux * ol - uy * 12,
      p0.y - uy * ol + ux * 12
    );
    ctx.fillText(
      hijacked ? "!" : "↻",
      p1.x + ux * ol + uy * 12,
      p1.y + uy * ol - ux * 12
    );
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
    if (pud.mechanic === "cob_bombard") {
      const ok =
        (pud.cornBombCd || 0) <= 0 && this.isValidCornBombPosition(mx, my);
      ctx.save();
      ctx.globalAlpha = ok ? 0.42 : 0.22;
      ctx.strokeStyle = ok ? "rgba(255, 230, 140, 0.95)" : "rgba(255, 120, 90, 0.75)";
      ctx.lineWidth = 2.5;
      ctx.setLineDash([9, 10]);
      ctx.beginPath();
      ctx.arc(mx, my, CORN_BOMB_RADIUS, 0, Math.PI * 2);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.restore();
    }
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
        ? "rgba(100, 90, 120, 0.45)"
        : "rgba(200, 190, 220, 0.35)";
      ctx.lineWidth = 2;
      ctx.setLineDash(slotLooksEmpty ? [5, 5] : []);
      ctx.beginPath();
      ctx.arc(pos.x, pos.y, 14, 0, Math.PI * 2);
      ctx.stroke();
      ctx.setLineDash([]);

      if (slot.pudding && !lifted) {
        if (slot.pudding.isDead) {
           ctx.globalAlpha = 0.35;
           this.drawDefenderPudding(ctx, pos.x, pos.y, slot.pudding);
           ctx.globalAlpha = 1.0;
        } else {
           this.drawDefenderPudding(ctx, pos.x, pos.y, slot.pudding);
        }
      } else if (this.phase === "placeStarter") {
        ctx.fillStyle = "rgba(200, 180, 220, 0.35)";
        ctx.font = '600 10px "Noto Sans SC", sans-serif';
        ctx.textAlign = "center";
        ctx.fillText("空", pos.x, pos.y + 3);
      }
      ctx.restore();
    }
  }

  drawDefenderPudding(ctx, x, y, pud) {
    const hue = pud.hue ?? 200;
    const lvl = pud.level || 1;
    const rarityColors = { 1: "#1a1520", 2: "#5ad85a", 3: "#5ab0ff", 4: "#c86bff" };

    if (pud.hitFlash > 0) {
      ctx.shadowColor = "#fff";
      ctx.shadowBlur = 14;
    }
    const fill = pud.hitFlash > 0 ? "#fff" : `hsl(${hue} 72% 58%)`;
    ctx.fillStyle = fill;
    ctx.beginPath();
    ctx.arc(x, y - 1, 20, 0, Math.PI * 2);
    ctx.fill();
    ctx.shadowBlur = 0;
    ctx.strokeStyle = "#120818";
    ctx.lineWidth = 3;
    ctx.stroke();
    ctx.strokeStyle = "rgba(255,255,255,0.2)";
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.arc(x - 6, y - 8, 6, Math.PI * 1.1, Math.PI * 2.2);
    ctx.stroke();

    ctx.fillStyle = rarityColors[lvl] || rarityColors[1];
    for (let i = 0; i < lvl; i++) {
       ctx.beginPath();
       ctx.arc(x - (lvl - 1) * 3.5 + i * 7, y - 16, 3, 0, Math.PI * 2);
       ctx.fill();
       ctx.strokeStyle = "#0c0810";
       ctx.lineWidth = 1;
       ctx.stroke();
    }

    ctx.fillStyle = "#0c060c";
    ctx.beginPath();
    ctx.arc(x - 5, y - 6, 2.8, 0, Math.PI * 2);
    ctx.arc(x + 7, y - 6, 2.8, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = "#fff";
    ctx.beginPath();
    ctx.arc(x - 5.5, y - 6.5, 0.9, 0, Math.PI * 2);
    ctx.arc(x + 6.5, y - 6.5, 0.9, 0, Math.PI * 2);
    ctx.fill();
    
    if (pud.mechanic === "buff_killcharge") {
      ctx.strokeStyle = "rgba(255, 210, 130, 0.95)";
      ctx.lineWidth = 2;
      ctx.setLineDash([3, 5]);
      ctx.beginPath();
      ctx.arc(x, y - 1, 25, 0, Math.PI * 2);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle = "rgba(255, 230, 160, 0.9)";
      ctx.font = "10px Silkscreen, monospace";
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText("★", x, y + 10);
    }

    if (pud.mechanic === "cob_bombard") {
      ctx.fillStyle = "rgba(40, 28, 12, 0.9)";
      ctx.fillRect(x - 14, y - 22, 28, 10);
      ctx.strokeStyle = "#2a1a0a";
      ctx.lineWidth = 1.5;
      ctx.strokeRect(x - 14, y - 22, 28, 10);
      ctx.fillStyle = "#f4d03f";
      ctx.beginPath();
      ctx.arc(x + 10, y - 17, 4, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = "#1a1008";
      ctx.stroke();
      const intv = pud.cornBombBaseInterval || 1;
      const cd = Math.max(0, pud.cornBombCd || 0);
      if (cd > 0) {
        const t = Math.min(1, cd / intv);
        ctx.strokeStyle = "#2a2018";
        ctx.lineWidth = 3;
        ctx.beginPath();
        ctx.arc(x, y + 12, 9, -Math.PI / 2, -Math.PI / 2 + (1 - t) * Math.PI * 2);
        ctx.stroke();
        ctx.strokeStyle = "rgba(255, 200, 80, 0.9)";
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.arc(x, y + 12, 9, -Math.PI / 2, -Math.PI / 2 + (1 - t) * Math.PI * 2);
        ctx.stroke();
      }
    }
    
    if (pud.hp !== undefined && pud.hp < pud.maxHp) {
       ctx.fillStyle = "#0c060c";
       ctx.fillRect(x - 15, y + 13, 30, 6);
       ctx.strokeStyle = "#1a1218";
       ctx.lineWidth = 1;
       ctx.strokeRect(x - 15, y + 13, 30, 6);
       ctx.fillStyle = "#9ee671";
       ctx.fillRect(x - 14, y + 14, 28 * Math.max(0, pud.hp / pud.maxHp), 4);
    }
  }

  drawEnemy(ctx, e) {
    const y = e.y;
    const r = e.hitRadius || (e.boss ? 34 : 18);
    if (e.hitFlash > 0) {
      ctx.shadowColor = "#fff";
      ctx.shadowBlur = 18;
    }
    const kind = e.enemyKind || "ghost";
    let fill;
    if (e.boss) {
      fill = "#b070f0";
    } else if (kind === "shifter") {
      fill = "#58d8a8";
    } else if (kind === "ranged") {
      fill = "#ff7ab0";
    } else if (kind === "hijacker") {
      fill = "#ffb347";
    } else {
      fill = "#a8c8ff";
    }
    ctx.fillStyle = fill;
    ctx.beginPath();
    ctx.arc(e.x, y, r, 0, Math.PI * 2);
    ctx.fill();
    ctx.shadowBlur = 0;
    ctx.strokeStyle = "#0c0610";
    ctx.lineWidth = e.boss ? 4 : 3;
    ctx.stroke();
    ctx.strokeStyle = "rgba(255,255,255,0.18)";
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.arc(e.x - r * 0.35, y - r * 0.25, r * 0.35, Math.PI * 1, Math.PI * 2.2);
    ctx.stroke();
    const w = e.boss ? 82 : 46;
    const bh = 8;
    const by = y - r - 16;
    ctx.fillStyle = "#0c060c";
    ctx.fillRect(e.x - w / 2 - 1, by - 1, w + 2, bh + 2);
    ctx.fillStyle = "#1a1218";
    ctx.fillRect(e.x - w / 2, by, w, bh);
    ctx.fillStyle = "#9ee671";
    ctx.fillRect(e.x - w / 2, by, w * clamp(e.hp / e.maxHp, 0, 1), bh);
    ctx.strokeStyle = "#000";
    ctx.lineWidth = 1;
    ctx.strokeRect(e.x - w / 2, by, w, bh);
  }

  rollShopOffers() {
    const pool = [];

    for (let k = 0; k < 3; k++) {
      const tid = rollShopPuddingTypeId();
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

    /** 有放回随机 4 格：刷新后可出现重复商品；单格购买后 splice 移除该按钮即可 */
    const picks = [];
    for (let slot = 0; slot < 4; slot++) {
      const src = pool[Math.floor(Math.random() * pool.length)];
      picks.push({
        ...src,
        id: `offer_${slot}_${Math.random().toString(36).slice(2, 11)}`,
      });
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
    this.shopOffers.splice(index, 1);
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
      mapStyle: this.mapStyle,
      victory: this.victory,
      gameOver: this.gameOver,
      synergyLine: formatSynergySummary(counts),
      puddingCount: this.countPuddings(),
      kingSkillKillCharge: this.kingSkillKillCharge,
      kingSkillKillsRequired: this.kingSkillKillsRequired,
    };
  }
}
