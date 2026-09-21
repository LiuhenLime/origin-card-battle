// 入口：装配卡牌数据、引擎与 UI，处理点击交互与 AI 回合调度。
import "./ui/style.css";
import rawCards from "../data/cards.json";
import type { CardDef, GameState, TargetRef } from "./engine/types";
import { attack, isPlayable, playCard, endTurn as endTurnAction } from "./engine/actions";
import { createGame } from "./engine/state";
import { legalTargets, needsTarget } from "./engine/effects";
import { applyAiStep } from "./engine/ai";
import { refKey, render, type UiMode } from "./ui/render";

// JSON 推断为宽泛类型，收窄到 CardDef
const CARDS = rawCards as unknown as CardDef[];
const defs: Record<string, CardDef> = Object.fromEntries(CARDS.map((c) => [c.id, c]));

let state: GameState = createGame(CARDS, ["你", "AI"]);
let mode: UiMode = { kind: "idle" };

const app = document.querySelector<HTMLDivElement>("#app")!;

function paint(): void {
  app.innerHTML = render(state, mode, defs);
}

/** 找到点击对应的目标引用；不在高亮集合里则返回 undefined */
function hitTarget(el: Element | null): TargetRef | undefined {
  if (!el) return undefined;
  const heroPanel = el.closest<HTMLElement>("[data-hero]");
  if (heroPanel) {
    const ref: TargetRef = { kind: "hero", side: Number(heroPanel.dataset.hero) as 0 | 1 };
    return ref;
  }
  const creature = el.closest<HTMLElement>("[data-creature-uid]");
  if (creature) {
    const ref: TargetRef = {
      kind: "creature",
      side: Number(creature.dataset.side) as 0 | 1,
      uid: Number(creature.dataset.creatureUid),
    };
    return ref;
  }
  return undefined;
}

function isTargetable(ref: TargetRef, keys: Set<string>): boolean {
  return keys.has(refKey(ref));
}

function targetKeys(): Set<string> {
  // 从已渲染 DOM 读取高亮，避免重复计算
  const keys = new Set<string>();
  document.querySelectorAll(".targetable").forEach((el) => {
    const heroPanel = el.closest<HTMLElement>("[data-hero]");
    if (heroPanel) {
      keys.add(`hero:${heroPanel.dataset.hero}`);
      return;
    }
    const creature = el.closest<HTMLElement>("[data-creature-uid]");
    if (creature) keys.add(`c:${creature.dataset.creatureUid}`);
  });
  return keys;
}

function runAi(): void {
  if (state.winner !== null) {
    paint();
    return;
  }
  applyAiStep(state, defs);
  paint();
  if (state.active === 1 && state.winner === null) {
    setTimeout(runAi, 600);
  }
}

app.addEventListener("click", (ev) => {
  const target = ev.target as HTMLElement;

  if (target.closest("#restart")) {
    state = createGame(CARDS, ["你", "AI"]);
    mode = { kind: "idle" };
    paint();
    return;
  }

  if (target.closest("#end-turn")) {
    endTurnAction(state);
    paint();
    setTimeout(runAi, 600);
    return;
  }

  if (state.winner !== null || state.active !== 0) return;
  const keys = targetKeys();

  // 点击空白处取消当前的选择（选目标/选攻击者）
  if (
    mode.kind !== "idle" &&
    !target.closest("[data-hand-uid], [data-creature-uid], [data-hero], #end-turn")
  ) {
    mode = { kind: "idle" };
    paint();
    return;
  }

  // 目标选择阶段
  if (mode.kind === "targetPlay") {
    const ref = hitTarget(target.closest("[data-hero], [data-creature-uid]"));
    if (ref && isTargetable(ref, keys)) {
      const err = playCard(state, defs, 0, mode.handUid, ref);
      if (err) state.log.push(`⚠ ${err}`);
      mode = { kind: "idle" };
      paint();
      return;
    }
    const again = target.closest<HTMLElement>("[data-hand-uid]");
    if (again && Number(again.dataset.handUid) === mode.handUid) {
      mode = { kind: "idle" }; // 再点同一张手牌取消
      paint();
      return;
    }
    return;
  }

  // 攻击目标阶段
  if (mode.kind === "selectAttacker") {
    const ref = hitTarget(target.closest("[data-hero], [data-creature-uid]"));
    if (ref && isTargetable(ref, keys)) {
      const err = attack(state, 0, mode.uid, ref);
      if (err) state.log.push(`⚠ ${err}`);
      mode = { kind: "idle" };
      paint();
      return;
    }
    const own = target.closest<HTMLElement>('[data-creature-uid][data-side="0"]');
    if (own && Number(own.dataset.creatureUid) === mode.uid) {
      mode = { kind: "idle" }; // 取消选择
      paint();
      return;
    }
    return;
  }

  // 空闲：选手牌出牌
  const handEl = target.closest<HTMLElement>("[data-hand-uid]");
  if (handEl) {
    const uid = Number(handEl.dataset.handUid);
    const hc = state.players[0].hand.find((h) => h.uid === uid);
    const def = hc ? defs[hc.cardId] : undefined;
    if (!hc || !def || !isPlayable(state, 0, def)) return;
    const effects = [...(def.battlecry ?? []), ...(def.effects ?? [])];
    const hasTarget = effects
      .filter(needsTarget)
      .some((e) => legalTargets(state, 0, e).length > 0);
    if (hasTarget) {
      mode = { kind: "targetPlay", handUid: uid };
    } else {
      const err = playCard(state, defs, 0, uid);
      if (err) state.log.push(`⚠ ${err}`);
    }
    paint();
    return;
  }

  // 空闲：选攻击者
  const ownCreature = target.closest<HTMLElement>('[data-creature-uid][data-side="0"]');
  if (ownCreature) {
    const uid = Number(ownCreature.dataset.creatureUid);
    const c = state.players[0].board.find((x) => x.uid === uid);
    if (c && c.attacksLeft > 0 && c.atk > 0) {
      mode = { kind: "selectAttacker", uid };
      paint();
    }
  }
});

paint();
