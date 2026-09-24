// 贪心 AI（进攻方，恒为 side 1）：道具不换手、主要行动换手由引擎保证。
// 目标选择尊重嘲讽/隐匿被动，并在合法候选中随机变化，避免每回合追打同一个人。
import type { CellPos, CharDef, CharRef, FieldChar, GameState, ItemDef, ItemEffect } from "./types";
import { isValidCell, volcanoBlastCells } from "./types";
import { computeDamage, effectiveAtk, targetCandidates } from "./combat";
import { deployChar, deployCostOf, emptyCells, isCellOccupied, playItem, passAction, undeployChar, useBurst, useNormalAttack } from "./actions";

const AI_SIDE = 1 as const;

/** AI 每个行动回合最多使用的道具牌数（道具不换手，无上限会无限刷增益道具） */
const AI_ITEM_BUDGET = 2;
/** AI 每回合最多部署次数 */
const AI_DEPLOY_BUDGET = 3;
let aiStateRef: GameState | null = null;
let aiItemsUsed = 0;
let aiDeploysUsed = 0;
let aiLastRoundSeen = 0;
/** 上一次攻击的目标：连续攻击时尽量换人 */
let aiLastTargetUid = 0;

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

/** 进攻方 3×3 的全部格子 */
function allCells(): CellPos[] {
  const out: CellPos[] = [];
  for (let row = 0; row < 3; row++) {
    for (let col = 0; col < 3; col++) {
      out.push({ row: row as 0 | 1 | 2, col: col as 0 | 1 | 2 });
    }
  }
  return out;
}

/** 挑一个可部署的空格：优先前排展开、避开火山带 */
function pickCell(s: GameState): CellPos | null {
  const preferred: CellPos[] = [
    { row: 2, col: 0 },
    { row: 2, col: 2 },
    { row: 2, col: 1 },
    { row: 1, col: 0 },
    { row: 1, col: 2 },
  ];
  const risky: CellPos[] = [
    { row: 1, col: 1 },
    { row: 0, col: 0 },
    { row: 0, col: 2 },
  ];
  for (const pos of preferred) {
    if (!isBlasted(s, AI_SIDE, pos) && isCellFree(s, pos)) return pos;
  }
  for (const pos of [...preferred, ...risky]) {
    if (isCellFree(s, pos)) return pos; // 全是火山带也只好硬上
  }
  return null; // 没有空格了
}

function isCellFree(s: GameState, pos: CellPos): boolean {
  return isValidCell(s.players[AI_SIDE].role, pos) && !isCellOccupied(s, AI_SIDE, pos);
}

/** 在候选中随机挑选，并尽量避开上一次攻击的目标 */
function variedPick(candidates: FieldChar[]): FieldChar | undefined {
  if (candidates.length === 0) return undefined;
  const fresh = candidates.filter((c) => c.uid !== aiLastTargetUid);
  const pool = fresh.length > 0 ? fresh : candidates;
  return pool[Math.floor(Math.random() * pool.length)];
}

/** 单目标攻击的候选：先斩杀（有则从中随机），否则在全部合法候选中随机 */
function pickAttackTarget(
  s: GameState,
  attacker: FieldChar,
  foeSide: 0 | 1,
): FieldChar | undefined {
  const candidates = targetCandidates(s, foeSide);
  if (candidates.length === 0) return undefined;
  const atk = effectiveAtk(s, attacker);
  const hit = (v: FieldChar) => computeDamage(v, atk, {});
  const killable = candidates.filter((v) => hit(v) >= v.hp);
  const chosen = variedPick(killable.length > 0 ? killable : candidates);
  if (chosen) aiLastTargetUid = chosen.uid;
  return chosen;
}

/** 可部署的手牌角色（冷却完毕且付得起） */
function deployable(s: GameState, charDefs: Record<string, CharDef>) {
  const p = s.players[AI_SIDE];
  const out: { uid: number; def: CharDef; cost: number }[] = [];
  for (const h of p.handChars) {
    if (h.cooldown > 0) continue;
    const def = charDefs[h.defId];
    if (!def) continue;
    const cost = deployCostOf(def, h.deathCount, false);
    if (p.cost >= cost) out.push({ uid: h.uid, def, cost });
  }
  return out;
}

/** 部署候选按“性价比”排序：进攻价值 ÷ 费用 */
function deployScore(def: CharDef): number {
  return (def.laneVal * 2 + def.atk / 2) / Math.max(1, def.cost);
}

/** 大招的粗略价值（用于排序释放顺序） */
function burstValue(def: CharDef): number {
  const b = def.burst;
  if (b.summonTier1) return 8;
  let v = b.value ?? 0;
  if (b.target === "all_enemies") v *= 2;
  if (b.pure) v *= 1.2;
  if (b.weakenTopAtk) v += b.weakenTopAtk;
  if (b.atkBuff) v += b.atkBuff * 2;
  if (b.defBuff) v += b.defBuff;
  if (b.shield) v += b.shield;
  if (b.tempAtk) v += b.tempAtk.value * b.tempAtk.turns;
  if (b.ghostVeil || b.selfKill) v = Math.min(v, 2); // 低优先级
  return v;
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
    const victims = targetCandidates(s, foeSide).filter((c) => c.hp <= value + 2).sort((a, b) => a.hp - b.hp);
    if (victims[0]) return { kind: "item", handUid, target: { side: foeSide, uid: victims[0].uid } };
    return null;
  }
  if (want("heal")) {
    const value = def.effects.find((e): e is Extract<ItemEffect, { kind: "heal" }> => e.kind === "heal")!.value;
    const hurt = me.field.filter((c) => c.hp > 0 && c.hp <= c.maxHp - value).sort((a, b) => a.hp / a.maxHp - b.hp / b.maxHp);
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
    const wall = [...me.field].filter((c) => c.hp > 0 && !c.equipment).sort((a, b) => b.laneVal - a.laneVal)[0];
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
  // 新对局（对象不同）或轮次推进或轮到对方时，重置道具/部署预算
  if (aiStateRef !== s || s.round !== aiLastRoundSeen || s.active !== AI_SIDE) {
    aiStateRef = s;
    aiItemsUsed = 0;
    aiDeploysUsed = 0;
    aiLastRoundSeen = s.round;
  }
  const me = s.players[AI_SIDE];
  const foeSide = (1 - AI_SIDE) as 0 | 1;
  const foe = s.players[foeSide];

  // 1. 能击杀的攻击（目标尊重嘲讽/隐匿，多个可杀目标中随机）
  const attackers = [...me.field].filter((c) => c.hp > 0 && !c.attacked && c.passive !== "healer");
  for (const attacker of attackers.sort((a, b) => effectiveAtk(s, b) - effectiveAtk(s, a))) {
    const victim = pickAttackTarget(s, attacker, foeSide);
    if (victim && computeDamage(victim, effectiveAtk(s, attacker), {}) >= victim.hp) {
      return { kind: "attack", uid: attacker.uid, target: { side: foeSide, uid: victim.uid } };
    }
  }

  // 2. 有价值的道具牌（受每回合预算限制）
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

  // 3. 技能点已满的大招（按价值排序；目标同样随机变化）
  const bursters = [...me.field]
    .filter((c) => c.hp > 0 && c.sp >= c.spMax)
    .sort((a, b) => burstValue(charDefs[b.defId]!) - burstValue(charDefs[a.defId]!));
  for (const burster of bursters) {
    const burst = charDefs[burster.defId]?.burst;
    if (!burst || burstValue(charDefs[burster.defId]!) < 2) continue;
    if (burst.summonTier1 && emptyCells(s, AI_SIDE).length === 0) continue;
    let target: CharRef | undefined;
    if (burst.target === "one_enemy") {
      const victim = pickAttackTarget(s, burster, foeSide);
      if (!victim) continue;
      target = { side: foeSide, uid: victim.uid };
    }
    return { kind: "burst", uid: burster.uid, target };
  }

  // 4. 普通攻击：在合法候选中随机选择，避免总打同一个人
  const attacker = attackers[0];
  if (attacker) {
    const victim = pickAttackTarget(s, attacker, foeSide);
    if (victim) return { kind: "attack", uid: attacker.uid, target: { side: foeSide, uid: victim.uid } };
  }

  // 5. 补充进攻力量（受每回合部署预算限制）
  if (aiDeploysUsed < AI_DEPLOY_BUDGET) {
    const pos = pickCell(s);
    const options = pos
      ? deployable(s, charDefs).sort((a, b) => deployScore(b.def) - deployScore(a.def))
      : [];
    if (pos && options[0]) {
      aiDeploysUsed += 1;
      return { kind: "deploy", handUid: options[0].uid, pos };
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
      useNormalAttack(s, AI_SIDE, step.uid, step.target);
      break;
    case "burst":
      useBurst(s, charDefs, AI_SIDE, step.uid, step.target);
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
