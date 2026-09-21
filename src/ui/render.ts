// 渲染层：把 GameState 映射为 HTML 字符串，并计算当前交互模式下的可点目标。
import type { CardDef, GameState, TargetRef } from "../engine/types";
import { legalTargets, needsTarget } from "../engine/effects";

export type UiMode =
  | { kind: "idle" }
  | { kind: "targetPlay"; handUid: number }
  | { kind: "selectAttacker"; uid: number };

export function refKey(r: TargetRef): string {
  return r.kind === "hero" ? `hero:${r.side}` : `c:${r.uid}`;
}

/** 当前模式下可被点击作为目标的对象（用于高亮与点击校验） */
export function targetableRefs(
  state: GameState,
  mode: UiMode,
  defs: Record<string, CardDef>,
): Set<string> {
  const keys = new Set<string>();
  const add = (r: TargetRef) => keys.add(refKey(r));
  if (mode.kind === "targetPlay") {
    const hc = state.players[0].hand.find((h) => h.uid === mode.handUid);
    const def = hc ? defs[hc.cardId] : undefined;
    const effects = [...(def?.battlecry ?? []), ...(def?.effects ?? [])].filter(needsTarget);
    for (const e of effects) legalTargets(state, 0, e).forEach(add);
  } else if (mode.kind === "selectAttacker") {
    const foe = state.players[1];
    const taunts = foe.board.filter((c) => c.taunt);
    // 有嘲讽则只能选嘲讽
    const list = taunts.length > 0 ? taunts : foe.board;
    list.forEach((c) => add({ kind: "creature", side: 1, uid: c.uid }));
    if (taunts.length === 0) add({ kind: "hero", side: 1 });
  }
  return keys;
}

function handCardHtml(uid: number, def: CardDef, playable: boolean): string {
  const stats =
    def.type === "creature" ? `<div class="stats"><b>${def.atk}</b>/<b>${def.hp}</b></div>` : "";
  const typeLabel = def.type === "creature" ? "随从" : "法术";
  return `
    <div class="card ${playable ? "" : "unplayable"}" data-hand-uid="${uid}">
      <div class="cost">${def.cost}</div>
      <div class="card-name">${def.name}</div>
      <div class="card-type">${typeLabel}${def.taunt ? " · 嘲讽" : ""}</div>
      <div class="card-text">${def.text ?? ""}</div>
      ${stats}
    </div>`;
}

function creatureHtml(uid: number, c: GameState["players"][0]["board"][0], cls: string): string {
  return `
    <div class="creature ${cls}" data-creature-uid="${uid}" data-side="${c.owner}">
      <div class="creature-name">${c.taunt ? "🛡 " : ""}${c.name}</div>
      <div class="creature-stats"><b>${c.atk}</b>/<b>${c.hp}</b></div>
    </div>`;
}

export function render(
  state: GameState,
  mode: UiMode,
  defs: Record<string, CardDef>,
): string {
  const targets = targetableRefs(state, mode, defs);
  const myTurn = state.active === 0 && state.winner === null;
  const me = state.players[0];
  const foe = state.players[1];

  const foeBoard = foe.board
    .map((c) => {
      const key = refKey({ kind: "creature", side: 1, uid: c.uid });
      const cls = targets.has(key) ? "targetable" : "";
      return creatureHtml(c.uid, c, cls);
    })
    .join("");

  const myBoard = me.board
    .map((c) => {
      const key = refKey({ kind: "creature", side: 0, uid: c.uid });
      const cls =
        mode.kind === "selectAttacker" && mode.uid === c.uid
          ? "selected"
          : targets.has(key)
            ? "targetable"
            : c.attacksLeft > 0 && c.atk > 0
              ? "ready"
              : "";
      return creatureHtml(c.uid, c, cls);
    })
    .join("");

  const hand = me.hand
    .map((h) => {
      const def = defs[h.cardId];
      return def ? handCardHtml(h.uid, def, myTurn && me.mana >= def.cost) : "";
    })
    .join("");

  const log = state.log
    .slice(-40)
    .reverse()
    .map((l) => `<div class="log-line">${l}</div>`)
    .join("");

  const overlay =
    state.winner !== null
      ? `<div class="overlay"><div class="overlay-box">
           <div class="overlay-title">${state.winner === 0 ? "🏆 胜利！" : state.winner === "draw" ? "⚖ 平局" : "💀 失败"}</div>
           <button id="restart">再来一局</button>
         </div></div>`
      : "";

  const hint =
    mode.kind === "targetPlay"
      ? "点击高亮目标（再点一次手牌取消）"
      : mode.kind === "selectAttacker"
        ? "选择攻击目标（点击已选随从取消）"
        : myTurn
          ? "出牌 → 点击随从攻击 → 结束回合"
          : "对方回合…";

  return `
    <div class="layout">
      <main class="arena">
        <section class="hero-panel enemy ${targets.has("hero:1") ? "targetable" : ""}" data-hero="1">
          <span class="hp">❤ ${Math.max(0, foe.hp)}</span>
          <span class="mana">🔹 ${foe.mana}/${foe.maxMana}</span>
          <span class="meta">🤖 ${foe.name}</span>
          <span class="meta">手牌 ${foe.hand.length} · 牌库 ${foe.deck.length}</span>
        </section>
        <section class="board-row">${foeBoard}</section>
        <section class="board-row">${myBoard}</section>
        <section class="hero-panel mine ${targets.has("hero:0") ? "targetable" : ""}" data-hero="0">
          <span class="hp">❤ ${Math.max(0, me.hp)}</span>
          <span class="mana">🔹 ${me.mana}/${me.maxMana}</span>
          <span class="meta">🙂 ${me.name}</span>
          <button id="end-turn" ${myTurn && mode.kind === "idle" ? "" : "disabled"}>结束回合</button>
          <span class="meta">牌库 ${me.deck.length}</span>
        </section>
        <section class="hand-row">${hand}</section>
        <footer class="hint">${hint}</footer>
      </main>
      <aside class="log"><h3>战报</h3>${log}</aside>
      ${overlay}
    </div>`;
}
