import { Game } from "./game.js";

const canvas = document.getElementById("game");
const game = new Game(canvas);

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
const hudHint = el("hud-hint");
const shopWaveLabel = el("shop-wave-label");
const shopGold = el("shop-gold");
const shopRerollCost = el("shop-reroll-cost");
const endTitle = el("end-title");
const endDesc = el("end-desc");

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

function syncOverlays() {
  const h = game.getHud();
  setVisible(overlayMenu, h.phase === "menu");
  setVisible(overlayPlace, h.phase === "placeStarter");
  setVisible(overlayShop, h.phase === "shop");
  setVisible(overlayEnd, h.phase === "ended");

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
  offers.forEach((o, i) => {
    const card = document.createElement("div");
    card.className = "shop-card";
    const affordable = game.gold >= o.price;
    const allowed = o.canBuy();
    if (!affordable || !allowed) card.classList.add("disabled");
    card.innerHTML = `<strong>${o.title}</strong><p class="small" style="margin:8px 0 0;color:var(--muted)">${o.desc}</p><div class="price">${o.price} 金</div>`;
    card.addEventListener("click", () => {
      if (game.buyOffer(i)) {
        shopGold.textContent = String(game.gold);
        renderShop();
        syncHud();
      }
    });
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

  if (h.phase === "placeStarter") {
    hudHint.textContent = "在纵向传送带上点击，布丁会出现在你点的高度。";
  } else if (h.phase === "combat") {
    hudHint.textContent =
      "在传送带区域上下拖动可卷动环轨；布丁到底会从上方瞬移接上。布丁所在高度决定攻击哪一路。";
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

el("btn-start").addEventListener("click", () => {
  game.start();
  syncOverlays();
  syncHud();
});

el("btn-place-cancel").addEventListener("click", () => {
  setVisible(overlayPlace, false);
});

el("btn-reroll").addEventListener("click", () => {
  if (game.rerollShop(rerollCost)) {
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
  game.reset();
  rerollCost = 5;
  syncOverlays();
  syncHud();
});

canvas.addEventListener("pointerdown", (ev) => {
  const ph = game.getHud().phase;
  if (ph !== "combat" && ph !== "placeStarter") return;
  const [mx, my] = canvasPoint(ev.clientX, ev.clientY);
  const r = game.onPointerDown(mx, my);
  if (r && r.type === "place") {
    game.placeStarterOnBelt(r.belt, mx, my);
    syncOverlays();
    syncHud();
  }
  canvas.setPointerCapture(ev.pointerId);
});

canvas.addEventListener("pointermove", (ev) => {
  const [mx, my] = canvasPoint(ev.clientX, ev.clientY);
  game.onPointerMove(mx, my);
});

canvas.addEventListener("pointerup", (ev) => {
  game.onPointerUp();
  try {
    canvas.releasePointerCapture(ev.pointerId);
  } catch {
    /* ignore */
  }
});

canvas.addEventListener("pointercancel", () => {
  game.onPointerUp();
});

function frame(ts) {
  if (!lastTs) lastTs = ts;
  const dt = Math.min(0.05, (ts - lastTs) / 1000);
  lastTs = ts;

  const prevPhase = game.phase;
  game.update(dt);
  game.draw();

  if (game.phase !== prevPhase) {
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
requestAnimationFrame(frame);
