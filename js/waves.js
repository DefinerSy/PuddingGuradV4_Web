/** 每波固定配置：幽灵数量、生成间隔、属性与通关奖励（可后续改为数据表） */
export function buildWaveTable() {
  const table = [];
  for (let w = 1; w <= 19; w++) {
    table[w] = {
      ghosts: 4 + Math.floor(w * 1.4),
      spawnInterval: Math.max(0.55, 1.15 - w * 0.03),
      hp: 18 + w * 8,
      speed: 52 + w * 3,
      damageToKing: 8 + Math.floor(w / 3),
      bounty: 2 + Math.floor(w / 4),
      clearGold: 6 + w * 2,
    };
  }
  table[20] = {
    ghosts: 1,
    spawnInterval: 0,
    hp: 1400,
    speed: 28,
    damageToKing: 35,
    bounty: 80,
    clearGold: 50,
    boss: true,
  };
  return table;
}
