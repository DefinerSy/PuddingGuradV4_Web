/**
 * 布丁类型、词条与《土豆兄弟》式叠层：同名词条按「份数」累加，前几档陡峭、后续递减并封顶。
 */

/** 词条：显示名 + 根据叠层数 n（场上所有布丁身上该词条出现次数之和）给的加成 */
export const TRAIT_DEFS = {
  sharp: {
    name: "锋利",
    synergy(n) {
      const dmg = tierCurve(n, [0.06, 0.06, 0.08, 0.08, 0.1, 0.1, 0.12], 0.04, 0.85);
      return { damageMul: 1 + dmg };
    },
  },
  rapid: {
    name: "急促",
    synergy(n) {
      const asp = tierCurve(n, [0.05, 0.05, 0.07, 0.07, 0.09, 0.09, 0.1], 0.035, 0.75);
      return { aspMul: 1 + asp };
    },
  },
  reach: {
    name: "远望",
    synergy(n) {
      const r = tierCurve(n, [0.04, 0.04, 0.06, 0.06, 0.08, 0.08, 0.09], 0.03, 0.65);
      return { rangeMul: 1 + r };
    },
  },
  thick: {
    name: "厚实",
    synergy(n) {
      const d = tierCurve(n, [0.03, 0.04, 0.05, 0.05, 0.06, 0.07], 0.025, 0.55);
      return { damageMul: 1 + d * 0.6, rangeMul: 1 + d * 0.5 };
    },
  },
  lucky: {
    name: "幸运糖粒",
    synergy(n) {
      const asp = tierCurve(n, [0.04, 0.05, 0.06, 0.07, 0.08], 0.04, 0.55);
      const dmg = tierCurve(n, [0.02, 0.03, 0.04, 0.05], 0.025, 0.35);
      return { aspMul: 1 + asp, damageMul: 1 + dmg };
    },
  },
  regen: {
    name: "回甘",
    synergy(n) {
      const heal = tierCurve(n, [0.2, 0.25, 0.3, 0.35, 0.4, 0.45], 0.08, 2.5);
      return { kingHealPerWave: heal };
    },
  },
};

/** 前几层用表格，之后线性衰减并封顶 */
function tierCurve(n, earlySteps, tailStep, cap) {
  if (n <= 0) return 0;
  let sum = 0;
  for (let i = 0; i < n; i++) {
    const inc = i < earlySteps.length ? earlySteps[i] : tailStep;
    sum += inc;
    if (sum >= cap) return cap;
  }
  return Math.min(cap, sum);
}

export const PUDDING_TYPES = {
  vanilla: {
    name: "原味布丁",
    traits: [],
    baseDamage: 11,
    baseInterval: 0.55,
    baseRange: 700,
    hue: 42,
  },
  caramel: {
    name: "焦糖近卫",
    traits: ["sharp", "thick"],
    baseDamage: 9,
    baseInterval: 0.6,
    baseRange: 640,
    hue: 28,
  },
  mint: {
    name: "薄荷连珠",
    traits: ["rapid", "lucky"],
    baseDamage: 8,
    baseInterval: 0.48,
    baseRange: 680,
    hue: 168,
  },
  mirror: {
    name: "镜面布丁",
    traits: ["reach", "reach"],
    baseDamage: 7,
    baseInterval: 0.58,
    baseRange: 820,
    hue: 210,
  },
  cream: {
    name: "奶油巫医",
    traits: ["regen", "lucky"],
    baseDamage: 7,
    baseInterval: 0.62,
    baseRange: 660,
    hue: 320,
  },
  storm: {
    name: "风暴奶冻",
    traits: ["sharp", "rapid"],
    baseDamage: 8,
    baseInterval: 0.52,
    baseRange: 660,
    hue: 200,
  },
  nut: {
    name: "坚果盾卫",
    traits: ["thick"],
    baseDamage: 0,
    baseInterval: 999,
    baseRange: 0,
    baseHp: 400,
    hue: 30,
    mechanic: "defender"
  },
  chili: {
    name: "烈焰辣椒",
    traits: ["sharp"],
    baseDamage: 0,
    baseInterval: 999,
    baseRange: 0,
    hue: 0,
    mechanic: "buff_fire"
  },
  /** 不攻击：周期为王权齐射蓄力；子弹穿过后击杀时额外蓄力（可叠多层穿过多个该布丁） */
  starwell: {
    name: "星井甘露",
    traits: ["regen"],
    baseDamage: 0,
    baseInterval: 999,
    baseRange: 0,
    hue: 268,
    mechanic: "buff_killcharge"
  },
  /** 不自动射击：拖到环轨外侧战场区域松手释放范围轰炸（击退+伤害），有冷却；等级越高冷却越短 */
  cob_cannon: {
    name: "玉米加农炮布丁",
    traits: ["thick", "lucky"],
    baseDamage: 0,
    baseInterval: 999,
    baseRange: 0,
    baseHp: 130,
    hue: 48,
    mechanic: "cob_bombard"
  },
  grape: {
    name: "葡萄连弹",
    traits: ["rapid"],
    baseDamage: 6,
    baseInterval: 0.65,
    baseRange: 600,
    hue: 280,
    attackType: "split"
  },
  bomb: {
    name: "爆弹布丁",
    traits: ["thick", "sharp"],
    baseDamage: 15,
    baseInterval: 1.2,
    baseRange: 600,
    hue: 10,
    attackType: "aoe"
  }
};

/**
 * 商店随机布丁类型：辅助型（坚果盾卫 / 增益布丁）权重更高。
 */
export function rollShopPuddingTypeId() {
  const ids = Object.keys(PUDDING_TYPES).filter((k) => k !== "vanilla");
  const weights = ids.map((id) => {
    const m = PUDDING_TYPES[id].mechanic;
    if (m === "defender" || (m && String(m).startsWith("buff_"))) return 2.85;
    if (m === "cob_bombard") return 2.35;
    return 1;
  });
  let total = 0;
  for (const w of weights) total += w;
  let r = Math.random() * total;
  for (let i = 0; i < ids.length; i++) {
    r -= weights[i];
    if (r <= 0) return ids[i];
  }
  return ids[ids.length - 1];
}

export function makePudding(typeId, level = 1) {
  const def = PUDDING_TYPES[typeId];
  if (!def) return makePudding("vanilla", level);
  const hpMultiplier = Math.pow(1.8, level - 1);
  const dmgMultiplier = Math.pow(1.8, level - 1);
  const hp = (def.baseHp || 100) * hpMultiplier;
  const pud = {
    typeId,
    level,
    traits: [...def.traits],
    baseDamage: def.baseDamage * dmgMultiplier,
    baseInterval: def.baseInterval,
    baseRange: def.baseRange,
    maxHp: hp,
    hp: hp,
    hue: def.hue,
    mechanic: def.mechanic || null,
    attackType: def.attackType || "normal",
    attackCd: 0,
    hitFlash: 0,
  };
  if (def.mechanic === "buff_killcharge") {
    const lv = pud.level || 1;
    const baseAura = 4.1;
    pud.killChargeAuraInterval = baseAura / (1 + 0.18 * (lv - 1));
    pud.killChargeAuraTimer = 1.2 + Math.random() * 0.9 * pud.killChargeAuraInterval;
  }
  if (def.mechanic === "cob_bombard") {
    const lv = pud.level || 1;
    pud.cornBombBaseInterval = Math.max(2.05, 6.5 - (lv - 1) * 0.82);
    pud.cornBombCd = 0;
  }
  return pud;
}

export function puddingDisplayName(p) {
  return PUDDING_TYPES[p.typeId]?.name ?? "布丁";
}

export function formatPuddingTraitsLine(p) {
  if (!p.traits.length) return "词条：无";
  const parts = p.traits.map((t) => TRAIT_DEFS[t]?.name ?? t);
  return `词条：${parts.join("、")}`;
}

export function aggregateTraitCounts(belts) {
  const counts = {};
  for (const belt of belts) {
    for (const slot of belt.slots) {
      if (!slot.pudding || slot.pudding.isDead) continue;
      const lvl = slot.pudding.level || 1;
      for (const t of slot.pudding.traits) {
        counts[t] = (counts[t] || 0) + lvl;
      }
    }
  }
  return counts;
}

export function computeSynergyMultipliers(counts) {
  let damageMul = 1;
  let aspMul = 1;
  let rangeMul = 1;
  let kingHealPerWave = 0;

  for (const [tid, def] of Object.entries(TRAIT_DEFS)) {
    const n = counts[tid] || 0;
    if (n <= 0) continue;
    const s = def.synergy(n);
    if (s.damageMul) damageMul *= s.damageMul;
    if (s.aspMul) aspMul *= s.aspMul;
    if (s.rangeMul) rangeMul *= s.rangeMul;
    if (s.kingHealPerWave) kingHealPerWave += s.kingHealPerWave;
  }

  return { damageMul, aspMul, rangeMul, kingHealPerWave };
}

export function formatSynergySummary(counts) {
  const parts = [];
  for (const [tid, def] of Object.entries(TRAIT_DEFS)) {
    const n = counts[tid] || 0;
    if (n <= 0) continue;
    parts.push(`${def.name}×${n}`);
  }
  return parts.length ? `协同：${parts.join("  ")}` : "";
}

export function randomShopPuddingTypeId() {
  const keys = Object.keys(PUDDING_TYPES).filter((k) => k !== "vanilla");
  return keys[Math.floor(Math.random() * keys.length)];
}
