import { Game } from "./game.js";
import {
  isMuted,
  onGamePhaseChanged,
  pumpAudioContext,
  resumeAudio,
  setMuted,
  sfxBuy,
  sfxReroll,
  sfxUiClick,
  sfxUiDeny,
  syncBgmToPhase,
  unlockAudioFromGesture,
} from "./audio.js";

if (typeof window.PuddingGuardStart !== "function") {
  window.PuddingGuardStart = () => {
    console.warn("国王布丁：脚本尚在加载，请稍候片刻再点开始。");
  };
}

const canvas = document.getElementById("game");
const game = new Game(canvas);

window.PuddingGuardUnlockAudio = unlockAudioFromGesture;

window.addEventListener(
  "pointerdown",
  () => {
    unlockAudioFromGesture();
  },
  { capture: true, passive: true }
);

const el = (id) => document.getElementById(id);

const overlayMenu = el("overlay-menu");
const overlayPlace = el("overlay-place");
const overlayShop = el("overlay-shop");
const overlayEnd = el("overlay-end");
const shopCards = el("shop-cards");
const hudWave = el("hud-wave");
const hudGold = el("hud-gold");
const hudKingHp = el("hud-king-hp");
const kingBar = el("king-bar");
const kingSkillBar = el("king-skill-bar");
const hudKingSkill = el("hud-king-skill");
const hudHint = el("hud-hint");
const shopWaveLabel = el("shop-wave-label");
const shopGold = el("shop-gold");
const shopRerollCost = el("shop-reroll-cost");
const endTitle = el("end-title");
const endDesc = el("end-desc");
const tooltip = el("tooltip");
const btnAudioMute = el("btn-audio-mute");
const appRoot = el("app") ?? document.body;

/** 商店卡片：委托点击 + data-offer-id，避免闭包索引错误导致购买后卡片不消失 */
shopCards?.addEventListener("click", (e) => {
  if (game.getHud().phase !== "shop") return;
  const t = e.target;
  if (!(t instanceof Element)) return;
  const card = t.closest(".shop-card");
  if (!card || !shopCards.contains(card)) return;
  if (card.classList.contains("disabled")) {
    sfxUiDeny();
    return;
  }
  const offerId = card.getAttribute("data-offer-id");
  if (!offerId) return;
  const idx = game.shopOffers.findIndex((o) => o.id === offerId);
  if (idx < 0) return;
  if (game.buyOffer(idx)) {
    sfxBuy();
    shopGold.textContent = String(game.gold);
    renderShop();
    syncHud();
  }
});

appRoot.addEventListener(
  "pointerdown",
  (e) => {
    if (e.button !== 0) return;
    const t = e.target;
    if (!(t instanceof Element)) return;
    const card = t.closest(".shop-card");
    if (card) {
      if (card.classList.contains("disabled")) sfxUiDeny();
      else sfxUiClick();
      return;
    }
    if (t.closest("button")) sfxUiClick();
  },
  { passive: true }
);

function updateAudioMuteLabel() {
  if (btnAudioMute)
    btnAudioMute.textContent = isMuted() ? "开声" : "静音";
}

let rerollCost = 5;
let lastTs = 0;

function canvasPoint(clientX, clientY) {
  const r = canvas.getBoundingClientRect();
  const sx = canvas.width / r.width;
  const sy = canvas.height / r.height;
  return [(clientX - r.left) * sx, (clientY - r.top) * sy];
}

function setVisible(node, on) {
  node.classList.toggle("hidden", !on);
}

/** 画布用 setPointerCapture 时的 pointer id；若在战斗切到菜单/商店时未释放会抢走下层按钮点击 */
let canvasCapturedPointerId = null;

function releaseCanvasPointerCaptureTracked() {
  if (canvasCapturedPointerId === null) return;
  try {
    canvas.releasePointerCapture(canvasCapturedPointerId);
  } catch {
    /* ignore */
  }
  canvasCapturedPointerId = null;
}

function syncOverlays() {
  const h = game.getHud();
  setVisible(overlayMenu, h.phase === "menu");
  setVisible(overlayPlace, h.phase === "placeStarter");
  setVisible(overlayShop, h.phase === "shop");
  setVisible(overlayEnd, h.phase === "ended");

  const allowCanvasPointer =
    h.phase === "combat" || h.phase === "placeStarter";
  canvas.style.pointerEvents = allowCanvasPointer ? "auto" : "none";

  if (!allowCanvasPointer) {
    releaseCanvasPointerCaptureTracked();
  }

  if (h.phase === "shop") {
    shopWaveLabel.textContent = `第 ${h.wave} 波已完成 · 准备第 ${h.wave + 1} 波`;
    shopGold.textContent = String(h.gold);
    shopRerollCost.textContent = String(rerollCost);
  }

  if (h.phase === "ended") {
    if (h.victory) {
      endTitle.textContent = "通关！";
      endDesc.textContent = "幽灵领主被击退，国王布丁安全了。";
    } else {
      endTitle.textContent = "守卫失败";
      endDesc.textContent = "国王布丁的生命归零，或 BOSS 闯入了王座。";
    }
  }
}

function renderShop() {
  shopCards.innerHTML = "";
  const offers = game.shopOffers || [];
  offers.forEach((o) => {
    const card = document.createElement("div");
    card.className = "shop-card";
    card.setAttribute("data-offer-id", o.id);
    const affordable = game.gold >= o.price;
    const allowed = o.canBuy();
    if (!affordable || !allowed) card.classList.add("disabled");
    card.innerHTML = `<strong>${o.title}</strong><p class="small" style="margin:8px 0 0;color:var(--muted)">${o.desc}</p><div class="price">${o.price} 金</div>`;
    shopCards.appendChild(card);
  });
}

function syncHud() {
  const h = game.getHud();
  hudWave.textContent = `${h.wave} / ${h.maxWave}`;
  hudGold.textContent = String(h.gold);
  hudKingHp.textContent = `${Math.ceil(h.kingHp)} / ${h.kingMaxHp}`;
  const ratio = h.kingMaxHp > 0 ? Math.max(0, h.kingHp / h.kingMaxHp) : 0;
  kingBar.style.transform = `scaleX(${ratio})`;

  if (kingSkillBar && hudKingSkill && h.kingSkillKillsRequired != null) {
    const req = h.kingSkillKillsRequired;
    const ch = Math.min(h.kingSkillKillCharge ?? 0, req);
    const skillRatio = req > 0 ? ch / req : 0;
    kingSkillBar.style.transform = `scaleX(${skillRatio})`;
    const ready = ch >= req;
    hudKingSkill.textContent = ready
      ? `${ch} / ${req} · 空格释放`
      : `${ch} / ${req}`;
  }

  if (h.phase === "placeStarter") {
    hudHint.textContent =
      "点击任意「空槽」圆位放置第一只布丁；每条环轨有多个固定槽，之后可拖布丁换位。";
  } else if (h.phase === "combat") {
    const base =
      "空白处上下拖环轨：整根带子一起卷动，槽位随之循环。\n拖住布丁拖到另一槽位可换位（含跨轨）。布丁高度决定打哪一路。\n键 1/2/3：指定三条环轨之一，中轨槽紧贴指针竖直位置（勿按左键）；左键点一下取消。\n青雾幽灵会横向换路；粉雾幽灵在中距停步并发射粉弹攻击布丁或国王；波次靠后特殊敌人出现更频繁。\n琥珀轨骇幽灵贴近一条环轨后会用虚线劫持该轨：该轨自动滚动，至死前不可拖该轨或用数字键控制其滚动；仍可拖布丁在任意槽位间换位（含被劫持轨）。\n玉米加农炮布丁拖到<strong>环轨外侧</strong>松手可范围轰炸（冷却随等级缩短）。\n击杀敌人可为「王权齐射」蓄力，满后按空格：五路各一发穿透高伤。";
    hudHint.textContent = h.synergyLine ? `${base}\n${h.synergyLine}` : base;
  } else if (h.phase === "shop") {
    hudHint.textContent = "在商店购买新布丁或强化，然后进入下一波。";
  } else if (h.phase === "menu") {
    hudHint.textContent = "点击「开始游戏」。";
  } else {
    hudHint.textContent = "";
  }
}

function openShopPhase() {
  rerollCost = 5 + Math.floor(game.getHud().wave / 4);
  syncOverlays();
  syncHud();
  renderShop();
}

let lastMenuStartAt = 0;
async function tryStartGameFromMenu() {
  try {
    if (game.getHud().phase !== "menu") return;
    const now = performance.now();
    if (now - lastMenuStartAt < 350) return;
    lastMenuStartAt = now;
    const oldPhase = game.getHud().phase;
    unlockAudioFromGesture();
    await resumeAudio();
    game.start();
    onGamePhaseChanged(game.phase, oldPhase, {});
    syncOverlays();
    syncHud();
  } catch (err) {
    console.error("开始游戏失败", err);
  }
}

/** 菜单层委托 */
overlayMenu?.addEventListener("click", (e) => {
  const hit = e.target;
  if (!(hit instanceof Element) || !hit.closest("#btn-start")) return;
  tryStartGameFromMenu();
});

/** 捕获阶段兜底：部分嵌套浏览器/预览里冒泡或目标阶段异常时仍能收到 */
document.addEventListener(
  "click",
  (e) => {
    const hit = e.target;
    if (!(hit instanceof Element)) return;
    if (!hit.closest("#btn-start")) return;
    if (game.getHud().phase !== "menu") return;
    tryStartGameFromMenu();
  },
  true
);

el("btn-place-cancel").addEventListener("click", () => {
  setVisible(overlayPlace, false);
});

el("btn-reroll").addEventListener("click", () => {
  if (game.rerollShop(rerollCost)) {
    sfxReroll();
    rerollCost += 2;
    shopGold.textContent = String(game.gold);
    shopRerollCost.textContent = String(rerollCost);
    renderShop();
    syncHud();
  }
});

el("btn-next-wave").addEventListener("click", () => {
  game.nextWaveFromShop();
  syncOverlays();
  syncHud();
});

el("btn-restart").addEventListener("click", () => {
  const oldPhase = game.getHud().phase;
  game.reset();
  rerollCost = 5;
  onGamePhaseChanged("menu", oldPhase, {});
  syncOverlays();
  syncHud();
});

let currentMouseX = 0;
let currentMouseY = 0;
let currentClientX = 0;
let currentClientY = 0;

function syncPointerClient(ev) {
  currentClientX = ev.clientX;
  currentClientY = ev.clientY;
}

function hideGameTooltip() {
  tooltip.classList.add("hidden");
}

function invalidatePointerOffDocument() {
  currentClientX = NaN;
  currentClientY = NaN;
}

document.addEventListener("pointermove", syncPointerClient);
document.addEventListener("pointerdown", syncPointerClient);

/** 任意位置左键：取消数字键选中的轨道跟随模式 */
document.addEventListener(
  "pointerdown",
  (ev) => {
    if (ev.button !== 0) return;
    game.clearKeyboardBeltFollow();
  },
  true
);

/** 战斗中 1/2/3 切换要跟指针的竖轨；空格释放国王主动技 */
document.addEventListener("keydown", (ev) => {
  if (ev.repeat) return;
  if (ev.ctrlKey || ev.metaKey || ev.altKey) return;
  const ph = game.getHud().phase;

  if (ev.key === " " || ev.code === "Space") {
    if (ph === "combat") {
      ev.preventDefault();
      game.tryFireKingRoyalVolley();
    }
    return;
  }

  const key = ev.key;
  if (key !== "1" && key !== "2" && key !== "3") return;
  if (ph !== "combat" && ph !== "placeStarter") return;
  const idx = Number(key) - 1;
  if (idx >= game.belts.length) return;
  ev.preventDefault();
  game.setKeyboardBeltFollowFromKey(idx);
});

document.documentElement.addEventListener("pointerleave", () => {
  invalidatePointerOffDocument();
  hideGameTooltip();
});

window.addEventListener("blur", hideGameTooltip);

document.addEventListener("visibilitychange", () => {
  if (document.hidden) hideGameTooltip();
});

canvas.addEventListener("lostpointercapture", () => {
  canvasCapturedPointerId = null;
});

canvas.addEventListener("pointerdown", (ev) => {
  const ph = game.getHud().phase;
  if (ph !== "combat" && ph !== "placeStarter") return;
  const [mx, my] = canvasPoint(ev.clientX, ev.clientY);
  const r = game.onPointerDown(mx, my);
  if (r && r.type === "place") {
    game.placeStarter(mx, my);
    syncOverlays();
    syncHud();
  }
  if (game.drag) {
    try {
      canvas.setPointerCapture(ev.pointerId);
      canvasCapturedPointerId = ev.pointerId;
    } catch {
      canvasCapturedPointerId = null;
    }
  }
});

canvas.addEventListener("pointermove", (ev) => {
  const [mx, my] = canvasPoint(ev.clientX, ev.clientY);
  currentMouseX = mx;
  currentMouseY = my;
  game.onPointerMove(mx, my);

  const ph = game.getHud().phase;
  if (
    (ph === "combat" || ph === "placeStarter") &&
    game.keyboardBeltFollowBi != null
  ) {
    game.applyKeyboardBeltFollowFromMouse(mx, my);
  }
});

canvas.addEventListener("pointerleave", () => {
  hideGameTooltip();
});

canvas.addEventListener("pointerup", (ev) => {
  const [mx, my] = canvasPoint(ev.clientX, ev.clientY);
  game.onPointerUp(mx, my);
  try {
    canvas.releasePointerCapture(ev.pointerId);
  } catch {
    /* ignore */
  }
  if (canvasCapturedPointerId === ev.pointerId) {
    canvasCapturedPointerId = null;
  }
});

canvas.addEventListener("pointercancel", (ev) => {
  const [mx, my] = canvasPoint(ev.clientX, ev.clientY);
  game.onPointerUp(mx, my);
  try {
    canvas.releasePointerCapture(ev.pointerId);
  } catch {
    /* ignore */
  }
  if (canvasCapturedPointerId === ev.pointerId) {
    canvasCapturedPointerId = null;
  }
});

function frame(ts) {
  if (!lastTs) lastTs = ts;
  const dt = Math.min(0.05, (ts - lastTs) / 1000);
  lastTs = ts;

  const prevPhase = game.phase;

  const cr = canvas.getBoundingClientRect();
  const mouseInCanvasBox =
    Number.isFinite(currentClientX) &&
    Number.isFinite(currentClientY) &&
    currentClientX >= cr.left &&
    currentClientX < cr.right &&
    currentClientY >= cr.top &&
    currentClientY < cr.bottom;

  let pointerOnCanvasSurface = false;
  if (mouseInCanvasBox) {
    pointerOnCanvasSurface =
      document.elementFromPoint(
        currentClientX,
        currentClientY
      ) === canvas;
  }

  if (pointerOnCanvasSurface) {
    const sx = canvas.width / cr.width;
    const sy = canvas.height / cr.height;
    currentMouseX = (currentClientX - cr.left) * sx;
    currentMouseY = (currentClientY - cr.top) * sy;
    const beltPh = game.getHud().phase;
    if (beltPh === "combat" || beltPh === "placeStarter") {
      game.applyKeyboardBeltFollowFromMouse(currentMouseX, currentMouseY);
    }
  }

  game.update(dt);
  pumpAudioContext();
  game.draw();

  if (!pointerOnCanvasSurface) {
    tooltip.classList.add("hidden");
  } else {
    const ph = game.getHud().phase;
    if (ph === "combat" || ph === "placeStarter") {
      const pud = game.getHoveredPudding(
        currentMouseX,
        currentMouseY
      );
      if (pud) {
        tooltip.classList.remove("hidden");
        tooltip.style.left = currentClientX + "px";
        tooltip.style.top = currentClientY + "px";
        let text = `<h4>Lv.${pud.level || 1} ${pud.name || "布丁"}</h4>`;
        if (pud.mechanic === "defender") {
          text += `<p>防御型 - 击退敌人</p>`;
          text += `<p>生命值: ${Math.ceil(pud.hp)} / ${Math.ceil(pud.maxHp)}</p>`;
        } else if (pud.mechanic === "buff_killcharge") {
          text += `<p>增益型 - 周期为「王权齐射」蓄力；子弹穿过后击杀额外蓄力（可叠层）。</p>`;
        } else if (pud.mechanic === "cob_bombard") {
          text += `<p>战术型 - 不自动射击；拖到<strong>环轨外侧战场</strong>松手轰炸（范围击退+伤害），有冷却；等级越高冷却越短。</p>`;
        } else if (pud.mechanic === "buff_fire") {
          text += `<p>增益型 - 附加火焰</p>`;
        } else {
          text += `<p>伤害: ${Math.round(pud.baseDamage)}  |  冷却: ${pud.baseInterval}s</p>`;
        }
        if (pud.traits && pud.traits.length > 0) {
          text += `<p>词条: ${pud.traits.join(", ")}</p>`;
        }
        tooltip.innerHTML = text;
      } else {
        tooltip.classList.add("hidden");
      }
    } else {
      tooltip.classList.add("hidden");
    }
  }

  if (game.phase !== prevPhase) {
    onGamePhaseChanged(game.phase, prevPhase, { victory: game.victory });
    if (game.phase === "shop") {
      openShopPhase();
    } else {
      syncOverlays();
      syncHud();
    }
  } else {
    syncHud();
  }

  requestAnimationFrame(frame);
}

syncOverlays();
syncHud();
updateAudioMuteLabel();

btnAudioMute?.addEventListener("click", (e) => {
  e.preventDefault();
  unlockAudioFromGesture();
  void resumeAudio().then(() => {
    setMuted(!isMuted());
    updateAudioMuteLabel();
    if (!isMuted()) syncBgmToPhase(game.getHud().phase);
  });
});

document.addEventListener("visibilitychange", () => {
  if (document.hidden) return;
  unlockAudioFromGesture();
  if (!isMuted()) syncBgmToPhase(game.getHud().phase);
});

document.body.addEventListener(
  "touchstart",
  () => {
    unlockAudioFromGesture();
    if (!isMuted()) syncBgmToPhase(game.getHud().phase);
  },
  { passive: true, once: true }
);

/** F12 里可手动试：typeof PuddingGuardStart === "function" && PuddingGuardStart() */
window.PuddingGuardStart = tryStartGameFromMenu;

requestAnimationFrame(frame);
