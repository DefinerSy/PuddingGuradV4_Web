/** 非 BOSS：按波次随机敌人类型 */
export function rollEnemyKindForWave(wave) {
  const r = Math.random();
  if (wave <= 3) return "ghost";

  if (wave <= 7) {
    if (r < 0.17) return "shifter";
    if (r < 0.28) return "ranged";
    if (wave >= 5 && r < 0.36) return "hijacker";
    return "ghost";
  }

  if (wave <= 12) {
    if (r < 0.2) return "shifter";
    if (r < 0.35) return "ranged";
    if (r < 0.46) return "hijacker";
    return "ghost";
  }

  if (r < 0.24) return "shifter";
  if (r < 0.42) return "ranged";
  if (r < 0.54) return "hijacker";
  return "ghost";
}

/** 每波固定配置：幽灵数量、生成间隔、属性与通关奖励（可后续改为数据表） */
export function buildWaveTable() {
  const table = [];
  for (let w = 1; w <= 19; w++) {
    const late = Math.max(0, w - 7);
    const end = Math.max(0, w - 13);
    table[w] = {
      ghosts: 4 + Math.floor(w * 1.4),
      spawnInterval: Math.max(0.52, 1.12 - w * 0.032),
      hp: 18 + w * 9 + late * 5 + end * 10,
      speed: 52 + w * 3 + Math.floor(late * 1.4),
      damageToKing: 8 + Math.floor(w / 3) + Math.floor(Math.max(0, w - 5) / 2),
      bounty: 2 + Math.floor(w / 4) + (w >= 12 ? 1 : 0),
      clearGold: 6 + w * 2,
    };
  }
  table[20] = {
    ghosts: 1,
    spawnInterval: 0,
    hp: 1680,
    speed: 30,
    damageToKing: 40,
    bounty: 88,
    clearGold: 50,
    boss: true,
  };
  return table;
}
