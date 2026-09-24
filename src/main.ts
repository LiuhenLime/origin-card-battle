// 入口：装配数据与引擎，处理三块屏幕（设置 → 选人 → 战斗）、点击路由、AI 回合与动画管线。
import "./ui/style.css";
import rawChars from "../data/characters.json";
import rawItems from "../data/items.json";
import { COOLDOWN_RESET_ROUND, MULTI_DEPLOY_FROM_ROUND } from "./engine/types";
import type { CharDef, GameState, ItemDef, Side, CellPos } from "./engine/types";
import { createGame } from "./engine/state";
import { deployChar, deployCostOf, playItem, passAction, recycleItem, undeployChar, useBurst, useNormalAttack } from "./engine/actions";
import { applyAiStep } from "./engine/ai";
import {
  emptyFx,
  renderBattle,
  renderDraft,
  renderSetup,
  setItemTargetLookup,
  helpContent,
  type DraftState,
  type SetupChoice,
  type UiState,
} from "./ui/render";

// JSON 推断为宽泛类型，收窄到引擎定义
const CHARS = rawChars as unknown as CharDef[];
const ITEMS = rawItems as unknown as ItemDef[];
const charDefs: Record<string, CharDef> = Object.fromEntries(CHARS.map((c) => [c.id, c]));
const itemDefs: Record<string, ItemDef> = Object.fromEntries(ITEMS.map((i) => [i.id, i]));

type Screen = "setup" | "draft" | "battle";

let screen: Screen = "setup";
let setup: SetupChoice = { terrain: "plain" };
let draft: DraftState = { picks: [], selected: [] };
let state: GameState | null = null;
let ui: UiState = freshUi(0);
let aiRunning = false;

const app = document.querySelector<HTMLDivElement>("#app")!;

function freshUi(viewer: Side): UiState {
  return { mode: { kind: "idle" }, fx: emptyFx(), viewer, logOpen: false, inspectUid: null };
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function shuffle<T>(arr: readonly T[]): T[] {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j]!, a[i]!];
  }
  return a;
}

// ---------- 渲染 ----------

function paint(): void {
  if (screen === "setup") {
    app.innerHTML = renderSetup(setup);
  } else if (screen === "draft") {
    app.innerHTML = renderDraft(draft, charDefs);
  } else if (state) {
    ui.viewer = 0; // 单机：玩家恒为防守方
    app.innerHTML = renderBattle(state, ui, charDefs, itemDefs);
  }
}

// 全局玩法说明弹窗（设置/选人/战斗屏均可打开）
const helpNode = document.createElement("div");
helpNode.className = "modal";
helpNode.innerHTML = `<div class="modal-box"><button class="inspect-close" id="help-close">✕</button>${helpContent()}</div>`;
document.body.appendChild(helpNode);
helpNode.addEventListener("click", (ev) => {
  const t = ev.target as HTMLElement;
  if (t.id === "help-close" || t === helpNode) helpNode.classList.remove("open");
});

function toast(msg: string, ms = 1200): void {
  const el = document.createElement("div");
  el.className = "float-num settle";
  el.style.left = "50%";
  el.style.top = "30%";
  el.textContent = msg;
  document.body.appendChild(el);
  setTimeout(() => el.remove(), ms);
}

// ---------- 动画管线 ----------

function floatAtSel(sel: string, text: string, cls: string): void {
  const el = document.querySelector(sel);
  if (!el) return;
  const r = el.getBoundingClientRect();
  spawnFloat(r.left + r.width / 2, r.top + 6, text, cls);
}

function spawnFloat(x: number, y: number, text: string, cls: string): void {
  const el = document.createElement("div");
  el.className = `float-num ${cls}`;
  el.style.left = `${x}px`;
  el.style.top = `${y}px`;
  el.textContent = text;
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 1300);
}

/** 消费引擎事件：烘焙 fx 类 → 重绘 → 飘字 → 延时清除 */
async function drainEvents(): Promise<void> {
  if (!state) return;
  const events = state.events.splice(0);
  if (events.length === 0) return;

  const fx = emptyFx();
  let breachDmg = 0;
  let breachSide: Side = 1;
  for (const ev of events) {
    switch (ev.t) {
      case "attack":
        fx.attackUid = ev.uid;
        break;
      case "damage":
        fx.hitUids.add(ev.uid);
        break;
      case "heal":
        fx.healUids.add(ev.uid);
        break;
      case "sp":
        fx.spUids.add(ev.uid);
        break;
      case "deploy":
        fx.deployUid = ev.uid;
        break;
      case "settlement":
        if (ev.breach) {
          fx.breach = true;
          breachDmg = ev.groundDiff + ev.skyDiff;
          breachSide = state.players[0].role === "defense" ? 0 : 1;
        }
        break;
      default:
        break;
    }
  }

  ui.fx = fx;
  paint();

  // 飘字（在 fx 重绘后定位）
  for (const ev of events) {
    switch (ev.t) {
      case "damage":
        floatAtSel(`[data-uid="${ev.uid}"]`, `-${ev.amount}`, ev.pure ? "pure" : "dmg");
        if (ev.killed) floatAtSel(`[data-uid="${ev.uid}"]`, "击倒", "settle");
        break;
      case "heal":
        floatAtSel(`[data-uid="${ev.uid}"]`, `+${ev.amount}`, "heal");
        break;
      case "sp":
        floatAtSel(`[data-uid="${ev.uid}"]`, `+${ev.amount}⚡`, "sp");
        break;
      case "volcano":
        floatAtSel(`[data-uid="${ev.uid}"]`, "🌋-6", "volcano");
        break;
      case "round":
        if (ev.n === MULTI_DEPLOY_FROM_ROUND || ev.n === COOLDOWN_RESET_ROUND) {
          const parts: string[] = [];
          if (ev.n === MULTI_DEPLOY_FROM_ROUND) parts.push("进攻方可连续部署多位角色");
          if (ev.n === COOLDOWN_RESET_ROUND) parts.push("进攻方死亡冷却全部清零");
          toast(`⚠ 第 ${ev.n} 回合：${parts.join("，")}！`, 3200);
        }
        break;
      case "settlement":
        if (ev.breach) {
          floatAtSel(`[data-totalhp="${breachSide}"]`, `-${ev.groundDiff + ev.skyDiff}`, "settle");
          if (ev.ghostBreach) {
            floatAtSel(`[data-totalhp="${breachSide}"]`, "👻-1", "pure");
          }
        }
        else floatAtSel(`[data-totalhp="${state.players[0].role === "defense" ? 0 : 1}"]`, "守住", "heal");
        break;
      default:
        break;
    }
  }

  if (fx.breach) {
    app.classList.add("fx-breach");
    setTimeout(() => app.classList.remove("fx-breach"), 950);
  }

  await sleep(780);
  ui.fx = emptyFx();
  if (screen === "battle") paint();
}

// ---------- AI ----------

async function kickAi(): Promise<void> {
  if (!state || aiRunning) return;
  if (state.winner || state.active !== 1) return;
  aiRunning = true;
  try {
    while (state && screen === "battle" && state.active === 1 && !state.winner) {
      await sleep(720);
      if (!state || screen !== "battle" || state.active !== 1 || state.winner) break;
      applyAiStep(state, charDefs, itemDefs);
      await drainEvents();
      paint();
    }
  } finally {
    aiRunning = false;
  }
}

// ---------- 行动后统一处理 ----------

function afterAction(err: string | null): void {
  if (err) {
    toast(err);
    ui.mode = { kind: "idle" };
    paint();
    return;
  }
  ui.mode = { kind: "idle" };
  ui.inspectUid = null;
  void (async () => {
    await drainEvents();
    paint();
    void kickAi();
  })();
}

// ---------- 道具目标查询（渲染层用） ----------

setItemTargetLookup((handUid) => {
  if (!state) return "none";
  const h = state.players[0].handItems.find((x) => x.uid === handUid);
  return h ? itemDefs[h.itemId]?.target ?? "none" : "none";
});

function handItemId(handUid: number): ItemDef | undefined {
  if (!state) return undefined;
  const h = state.players[0].handItems.find((x) => x.uid === handUid);
  return h ? itemDefs[h.itemId] : undefined;
}

// ---------- 点击路由 ----------

app.addEventListener("click", (ev) => {
  const t = ev.target as HTMLElement;

  // 全局按钮
  if (t.closest("#btn-help") || t.closest("#open-help-setup")) {
    helpNode.classList.add("open");
    return;
  }
  if (t.closest("#btn-log")) {
    ui.logOpen = true;
    paint();
    return;
  }
  const act = t.closest<HTMLElement>("[data-act]")?.dataset.act;
  if (act === "close-log") {
    ui.logOpen = false;
    paint();
    return;
  }
  if (act === "close-inspect") {
    ui.inspectUid = null;
    paint();
    return;
  }
  if (act === "cancel") {
    ui.mode = { kind: "idle" };
    paint();
    return;
  }
  if (t.closest("#btn-again")) {
    screen = "setup";
    state = null;
    paint();
    return;
  }

  // 设置屏
  const setupBtn = t.closest<HTMLElement>("[data-setup]");
  if (setupBtn) {
    const v = setupBtn.dataset.setup!;
    if (v === "plain" || v === "volcano") setup.terrain = v;
    paint();
    return;
  }
  if (t.closest("#to-draft")) {
    draft = { picks: [], selected: [] };
    screen = "draft";
    paint();
    return;
  }

  // 选人屏
  const draftBtn = t.closest<HTMLElement>("[data-draft]");
  if (draftBtn) {
    const id = draftBtn.dataset.draft!;
    if (draft.selected.includes(id)) draft.selected = draft.selected.filter((x) => x !== id);
    else if (draft.selected.length < 8) draft.selected.push(id);
    paint();
    return;
  }
  if (t.closest("#draft-reset")) {
    draft.selected = [];
    paint();
    return;
  }
  if (t.closest("#draft-confirm") && draft.selected.length === 8) {
    draft.picks = [...draft.selected];
    startBattle();
    return;
  }

  if (screen !== "battle" || !state) return;
  const viewer = ui.viewer;
  const myTurn = state.active === viewer && !state.winner && !state.passed[viewer];

  // 结束回合
  if (t.closest("#btn-pass")) {
    if (!myTurn) return;
    afterAction(passAction(state, charDefs, viewer));
    return;
  }

  // 道具菜单打开时，点击场上角色/格子不改变状态（只能选菜单或换选手牌道具）
  if (ui.mode.kind === "itemMenu" && t.closest(".chip, .cell")) return;

  // 行动菜单（charMenu）
  if (ui.mode.kind === "charMenu" && myTurn) {
    const uid = ui.mode.uid;
    if (act === "normal") {
      ui.mode = { kind: "attack", uid };
      paint();
      return;
    }
    if (act === "burst") {
      const c = state.players[viewer].field.find((x) => x.uid === uid);
      const def = c ? charDefs[c.defId] : undefined;
      if (!c || !def) return;
      if (c.sp < c.spMax) {
        toast(`技能点不足（${c.sp}/${c.spMax}）`);
        return;
      }
      if (def.burst.target === "one_enemy") {
        ui.mode = { kind: "burst", uid };
        paint();
        return;
      }
      afterAction(useBurst(state, charDefs, viewer, uid, undefined));
      return;
    }
    if (act === "undeploy") {
      afterAction(undeployChar(state, viewer, uid));
      return;
    }
    if (act === "inspect") {
      ui.inspectUid = uid;
      ui.mode = { kind: "idle" };
      paint();
      return;
    }
  }

  // 道具菜单（itemMenu）：使用或回收
  if (ui.mode.kind === "itemMenu" && myTurn) {
    if (act === "use-item") {
      const def = handItemId(ui.mode.handUid);
      if (!def) return;
      if (def.cost > state.players[viewer].cost) return;
      if (def.target === "none") {
        afterAction(playItem(state, itemDefs, viewer, ui.mode.handUid, undefined));
        return;
      }
      ui.mode = { kind: "item", handUid: ui.mode.handUid };
      paint();
      return;
    }
    if (act === "recycle-item") {
      afterAction(recycleItem(state, itemDefs, viewer, ui.mode.handUid));
      return;
    }
  }

  // 场上角色点击
  const chip = t.closest<HTMLElement>("[data-uid]");
  if (chip) {
    const uid = Number(chip.dataset.uid);
    const side = Number(chip.dataset.side) as Side;
    if (!myTurn) {
      ui.inspectUid = uid;
      paint();
      return;
    }
    if (ui.mode.kind === "attack") {
      afterAction(useNormalAttack(state, viewer, ui.mode.uid, { side, uid }));
      return;
    }
    if (ui.mode.kind === "burst") {
      afterAction(useBurst(state, charDefs, viewer, ui.mode.uid, { side, uid }));
      return;
    }
    if (ui.mode.kind === "item") {
      const def = handItemId(ui.mode.handUid);
      const targetRef = { side, uid };
      if (def && def.effects.some((e) => e.kind === "move")) {
        ui.mode = { kind: "movePick", handUid: ui.mode.handUid, targetUid: uid };
        paint();
        return;
      }
      afterAction(playItem(state, itemDefs, viewer, ui.mode.handUid, targetRef));
      return;
    }
    if (ui.mode.kind === "movePick") {
      if (side === viewer) {
        ui.mode = { kind: "movePick", handUid: ui.mode.handUid, targetUid: uid };
        paint();
      }
      return;
    }
    // 空闲：我方角色 → 行动菜单；敌方角色 → 查看详情
    if (side === viewer) {
      ui.mode = { kind: "charMenu", uid };
    } else {
      ui.inspectUid = uid;
    }
    paint();
    return;
  }

  // 网格点击（部署 / 移动目的地）
  const cell = t.closest<HTMLElement>("[data-row]");
  if (cell && myTurn) {
    const pos: CellPos = {
      row: Number(cell.dataset.row) as 0 | 1,
      col: Number(cell.dataset.col) as 0 | 1 | 2,
    };
    if (ui.mode.kind === "deploy") {
      afterAction(deployChar(state, charDefs, viewer, ui.mode.handUid, pos));
      return;
    }
    if (ui.mode.kind === "movePick") {
      afterAction(playItem(state, itemDefs, viewer, ui.mode.handUid, { side: viewer, uid: ui.mode.targetUid }, pos));
      return;
    }
  }

  // 手牌点击
  const handChar = t.closest<HTMLElement>("[data-hand-char]");
  if (handChar && myTurn && ui.mode.kind === "idle") {
    const uid = Number(handChar.dataset.handChar);
    const h = state.players[viewer].handChars.find((x) => x.uid === uid);
    if (!h) return;
    if (h.cooldown > 0) {
      toast(`冷却中，还需 ${h.cooldown} 回合`);
      return;
    }
    const def = charDefs[h.defId]!;
    const cost = deployCostOf(def, h.deathCount, false);
    if (cost > state.players[viewer].cost) {
      toast(`部署费用不足（需 ${cost}）`);
      return;
    }
    ui.mode = { kind: "deploy", handUid: uid };
    paint();
    return;
  }
  const handItem = t.closest<HTMLElement>("[data-hand-item]");
  if (handItem && myTurn && (ui.mode.kind === "idle" || ui.mode.kind === "charMenu" || ui.mode.kind === "itemMenu")) {
    const uid = Number(handItem.dataset.handItem);
    const def = handItemId(uid);
    if (!def) return;
    ui.mode = { kind: "itemMenu", handUid: uid };
    paint();
    return;
  }

  // 点击空白处取消
  if (ui.mode.kind !== "idle" && !t.closest(".hand-card, .chip, .controls, .cell")) {
    ui.mode = { kind: "idle" };
    paint();
  }
});

// ---------- 开局 ----------

function startBattle(): void {
  const names: [string, string] = ["你（防守方）", "AI（进攻方）"];
  // AI 从进攻方专属卡池随机取 8 种角色，每种 2 张（同名单位可并存）
  const attackIds = CHARS.filter((c) => c.faction === "attack").map((c) => c.id);
  const aiDeck = shuffle(attackIds).slice(0, 8).flatMap((id) => [id, id]);
  state = createGame(
    {
      terrain: setup.terrain,
      decks: [draft.picks, aiDeck],
      names,
    },
    charDefs,
    itemDefs,
  );
  ui = freshUi(0);
  screen = "battle";
  paint();
  void kickAi();
}

paint();
