// 贪心 AI：同时支持进攻方与防守方（人机模式 AI 恒为 side 1）。
// 每次返回一个行动，由 UI 逐步执行（道具不换手、主要行动换手均由引擎保证）。
import type { CellPos, CharDef, CharRef, GameState, ItemDef, ItemEffect } from "./types";
import { volcanoBlastCells } from "./types";
import { findChar } from "./combat";
import { deployChar, deployCostOf, playItem, passAction, undeployChar, useBurst, useNormalAttack } from "./actions";

const AI_SIDE = 1 as const;
const GOBLIN_ID = "goblin";

/** AI 每个行动回合最多使用的道具牌数（道具不换手，无上限会无限刷增益道具） */
const AI_ITEM_BUDGET = 2;
/** AI 每回合最多部署次数（超过则宣告结束，避免囤兵不止、回合无法结算） */
const AI_DEPLOY_BUDGET = 2;
let aiItemsUsed = 0;
let aiDeploysUsed = 0;
let aiLastRoundSeen = 0;

export type AiStep =
  | { kind: "deploy"; handUid: number; pos: CellPos }
  | { kind: "undeploy"; uid: number }
  | { kind: "attack"; uid: number; target: CharRef }
  | { kind: "burst"; uid: number; target?: CharRef }
  | { kind: "item"; handUid: number; target?: CharRef; moveTo?: CellPos }
  | { kind: "pass" };

/** 火山喷发范围内（含火山口自身）的格子 */
function isBlasted(s: GameState, side: 0 | 1, pos: CellPos): boolean {
  if (s.terrain !== "volcano") return false;
  const cells = [...volcanoBlastCells(side), { row: 0, col: 1 }];
  return cells.some((b) => b.row === pos.row && b.col === pos.col);
}

/** 挑一个不容易吃火山伤害的空位（优先前排两侧，其次任意非火山口格） */
function pickCell(s: GameState): CellPos {
  const safe: CellPos[] = [
    { row: 1, col: 0 },
    { row: 1, col: 2 },
  ];
  const rest: CellPos[] = [
    { row: 0, col: 0 },
    { row: 0, col: 2 },
    { row: 1, col: 1 },
  ];
  for (const pos of [...safe, ...rest]) {
    if (!isBlasted(s, AI_SIDE, pos)) return pos;
  }
  return { row: 1, col: 0 };
}

/** 可部署的手牌角色（冷却完毕且付得起） */
function deployable(s: GameState, charDefs: Record<string, CharDef>) {
  const p = s.players[AI_SIDE];
  const out: { uid: number; def: CharDef; cost: number; elevated: boolean }[] = [];
  for (const h of p.handChars) {
    if (h.cooldown > 0) continue;
    const def = charDefs[h.defId];
    if (!def) continue;
    // AI 永远部署在普通格（前排/任意格），不主动付高地双倍费
    const cost = deployCostOf(def, h.deathCount, false);
    if (p.cost >= cost) out.push({ uid: h.uid, def, cost, elevated: false });
  }
  return out;
}

/** 部署候选按“所需领域价值”排序 */
function deployValue(def: CharDef, role: "attack" | "defense", need: "ground" | "sky" | "any"): number {
  const laneVal = role === "attack" ? def.atkVal : def.defVal;
  if (need === "any") return laneVal + def.atk / 2;
  return def.domain === (need === "ground" ? "ground" : "sky") ? laneVal * 2 + def.atk / 2 : laneVal / 2;
}

/** 道具牌是否值得现在使用；返回行动描述或 null */
function evaluateItem(
  s: GameState,
  def: ItemDef,
  handUid: number,
): AiStep | null {
  const me = s.players[AI_SIDE];
  const foeSide = (1 - AI_SIDE) as 0 | 1;
  if (me.cost < def.cost) return null;
  const want = (k: ItemEffect["kind"]) => def.effects.some((e) => e.kind === k);

  if (want("damage")) {
    const value = def.effects.find((e): e is Extract<ItemEffect, { kind: "damage" }> => e.kind === "damage")!.value;
    const victims = s.players[foeSide].field
      .filter((c) => c.hp > 0 && c.hp <= value + 2)
      .sort((a, b) => a.hp - b.hp);
    if (victims[0]) return { kind: "item", handUid, target: { side: foeSide, uid: victims[0].uid } };
    return null;
  }
  if (want("heal")) {
    const hurt = me.field.filter((c) => c.hp > 0 && c.hp <= c.maxHp * 0.5).sort((a, b) => a.hp / a.maxHp - b.hp / b.maxHp);
    if (hurt[0]) return { kind: "item", handUid, target: { side: AI_SIDE, uid: hurt[0].uid } };
    return null;
  }
  if (want("sp")) {
    const ready = me.field
      .filter((c) => c.hp > 0 && c.spMax - c.sp <= 2 && c.sp < c.spMax)
      .sort((a, b) => b.sp - a.sp);
    if (ready[0]) return { kind: "item", handUid, target: { side: AI_SIDE, uid: ready[0].uid } };
    return null;
  }
  if (want("equip_armor")) {
    const wall = [...me.field].filter((c) => c.hp > 0 && !c.equipment).sort((a, b) => b.defVal - a.defVal)[0];
    if (wall) return { kind: "item", handUid, target: { side: AI_SIDE, uid: wall.uid } };
    return null;
  }
  if (want("atk_buff")) {
    const carry = [...me.field].filter((c) => c.hp > 0).sort((a, b) => b.atk - a.atk)[0];
    if (carry) return { kind: "item", handUid, target: { side: AI_SIDE, uid: carry.uid } };
    return null;
  }
  if (want("draw") && me.handItems.length <= 2) {
    return { kind: "item", handUid };
  }
  return null;
}

/** 计算当前 AI 的下一个行动（AI 恒为进攻方） */
export function aiNextAction(
  s: GameState,
  charDefs: Record<string, CharDef>,
  itemDefs: Record<string, ItemDef>,
): AiStep {
  // 轮次推进或轮到对方时，重置道具/部署预算
  if (s.round !== aiLastRoundSeen || s.active !== AI_SIDE) {
    aiItemsUsed = 0;
    aiDeploysUsed = 0;
    aiLastRoundSeen = s.round;
  }
  const me = s.players[AI_SIDE];
  const foeSide = (1 - AI_SIDE) as 0 | 1;
  const foe = s.players[foeSide];

  // 1. 能击杀的攻击（优先消灭高威胁防守者）
  const attacker = [...me.field]
    .filter((c) => c.hp > 0 && !c.skillUsed)
    .sort((a, b) => b.atk - a.atk)[0];
  if (attacker && attacker.passive !== "healer") {
    const victims = [...foe.field]
      .filter((c) => c.hp > 0)
      .sort((a, b) => b.defVal - a.defVal || b.atkVal - a.atkVal);
    const killable = victims.find((v) => v.hp <= attacker.atk);
    if (killable) return { kind: "attack", uid: attacker.uid, target: { side: foeSide, uid: killable.uid } };
  }

  // 2. 治疗类大招（我方伤势重时优先）
  const healer = me.field.find(
    (c) => c.hp > 0 && !c.skillUsed && c.sp >= c.spMax && charDefs[c.defId]?.burst.target === "all_allies",
  );
  if (healer) {
    const missing = me.field.reduce((sum, c) => sum + (c.maxHp - c.hp), 0);
    if (missing >= 6) return { kind: "burst", uid: healer.uid };
  }

  // 3. 有价值的道具牌（受每回合预算限制）
  if (aiItemsUsed < AI_ITEM_BUDGET) {
    for (const h of me.handItems) {
      const def = itemDefs[h.itemId];
      if (!def) continue;
      const step = evaluateItem(s, def, h.uid);
      if (step) {
        aiItemsUsed += 1;
        return step;
      }
    }
  }

  // 4. 普通攻击：优先斩杀，其次打血最少的敌人
  if (attacker) {
    const victims = [...foe.field]
      .filter((c) => c.hp > 0)
      .sort((a, b) => a.hp - b.hp || b.atkVal - a.atkVal);
    if (victims[0]) return { kind: "attack", uid: attacker.uid, target: { side: foeSide, uid: victims[0].uid } };
  }

  // 5. 充能满的伤害大招
  const burster = [...me.field]
    .filter((c) => c.hp > 0 && !c.skillUsed && c.sp >= c.spMax)
    .sort((a, b) => b.atk - a.atk)[0];
  if (burster) {
    const burst = charDefs[burster.defId]?.burst;
    if (burst && (burst.value ?? 0) > 0) {
      const target =
        burst.target === "one_enemy"
          ? [...foe.field].filter((c) => c.hp > 0).sort((a, b) => a.hp - b.hp)[0]
          : undefined;
      if (burst.target !== "one_enemy" || target) {
        return {
          kind: "burst",
          uid: burster.uid,
          target: target ? { side: foeSide, uid: target.uid } : undefined,
        };
      }
    }
  }

  // 6. 补充进攻力量（受每回合部署预算限制），随后宣告结束
  if (aiDeploysUsed < AI_DEPLOY_BUDGET) {
    const options = deployable(s, charDefs).sort(
      (a, b) => deployValue(b.def, "attack", "any") / b.cost - deployValue(a.def, "attack", "any") / a.cost,
    );
    if (options[0]) {
      aiDeploysUsed += 1;
      return { kind: "deploy", handUid: options[0].uid, pos: pickCell(s) };
    }
  }

  return { kind: "pass" };
}

/** 在真实对局上执行一个 AI 行动（供 UI 调用） */
export function applyAiStep(
  s: GameState,
  charDefs: Record<string, CharDef>,
  itemDefs: Record<string, ItemDef>,
): AiStep {
  const step = aiNextAction(s, charDefs, itemDefs);
  switch (step.kind) {
    case "deploy":
      deployChar(s, charDefs, AI_SIDE, step.handUid, step.pos);
      break;
    case "undeploy":
      undeployChar(s, AI_SIDE, step.uid);
      break;
    case "attack":
      useNormalAttack(s, AI_SIDE, step.uid, step.target, GOBLIN_ID);
      break;
    case "burst":
      useBurst(s, charDefs, AI_SIDE, step.uid, step.target, GOBLIN_ID);
      break;
    case "item":
      playItem(s, itemDefs, AI_SIDE, step.handUid, step.target, step.moveTo);
      break;
    case "pass":
      passAction(s, charDefs, AI_SIDE);
      break;
  }
  return step;
}
