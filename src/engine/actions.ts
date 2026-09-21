// 玩家行动：出牌、攻击、结束回合。所有规则校验集中在这里，UI 与 AI 共用。
import type { CardDef, GameState, Side, TargetRef } from "./types";
import { MAX_BOARD, checkWinner, startTurn } from "./state";
import { applyEffect, legalTargets, needsTarget, sameRef, sweepDeaths } from "./effects";

/** 这张手牌当前是否可出（费用与战场容量） */
export function isPlayable(s: GameState, side: Side, def: CardDef): boolean {
  const p = s.players[side];
  if (def.cost > p.mana) return false;
  if (def.type === "creature" && p.board.length >= MAX_BOARD) return false;
  return true;
}

/**
 * 出一张牌。成功返回 null，失败返回错误信息。
 * target：当效果需要指定目标时必填（战吼与法术共用这一目标）。
 */
export function playCard(
  s: GameState,
  defs: Record<string, CardDef>,
  side: Side,
  handUid: number,
  target?: TargetRef,
): string | null {
  if (s.winner !== null) return "对局已结束";
  if (s.active !== side) return "还没轮到你";
  const p = s.players[side];
  const idx = p.hand.findIndex((h) => h.uid === handUid);
  if (idx < 0) return "手牌不存在";
  const hc = p.hand[idx]!;
  const def = defs[hc.cardId];
  if (!def) return `未知卡牌：${hc.cardId}`;
  if (!isPlayable(s, side, def)) return def.cost > p.mana ? "法力不足" : "战场已满";

  // 战吼与法术效果共用同一目标参数
  const effects = [...(def.battlecry ?? []), ...(def.effects ?? [])];
  const targeted = effects.filter(needsTarget);
  // 仅当确实存在可选目标时才强制指定；全部落空允许直接打出（效果无效化）
  const anyLegalTarget = targeted.some((e) => legalTargets(s, side, e).length > 0);
  if (targeted.length > 0 && !target && anyLegalTarget) return "需要选择一个目标";
  if (target) {
    const ok = targeted.some((e) => legalTargets(s, side, e).some((t) => sameRef(t, target)));
    if (!ok) return "目标不合法";
  }

  // 通过全部校验，开始结算
  p.mana -= def.cost;
  p.hand.splice(idx, 1);

  if (def.type === "creature") {
    p.board.push({
      uid: s.nextUid++,
      cardId: def.id,
      name: def.name,
      owner: side,
      atk: def.atk ?? 0,
      hp: def.hp ?? 0,
      maxHp: def.hp ?? 0,
      taunt: def.taunt ?? false,
      attacksLeft: 0, // 召唤眩晕
    });
    s.log.push(`🎴 ${p.name} 打出随从「${def.name}」（${def.atk}/${def.hp}）`);
    for (const e of def.battlecry ?? []) applyEffect(s, side, e, target);
  } else {
    s.log.push(`✨ ${p.name} 施放法术「${def.name}」`);
    for (const e of def.effects ?? []) applyEffect(s, side, e, target);
  }
  sweepDeaths(s);
  return null;
}

/**
 * 用己方随从攻击。目标只能是敌方英雄或敌方随从。
 * 敌方存在嘲讽随从时必须先攻击嘲讽。
 */
export function attack(
  s: GameState,
  side: Side,
  attackerUid: number,
  target: TargetRef,
): string | null {
  if (s.winner !== null) return "对局已结束";
  if (s.active !== side) return "还没轮到你";
  const p = s.players[side];
  const foe = (1 - side) as Side;
  const attacker = p.board.find((c) => c.uid === attackerUid);
  if (!attacker) return "攻击者不存在";
  if (attacker.attacksLeft <= 0) return attacker.atk <= 0 ? "该随从没有攻击力" : "该随从本回合已攻击";
  if (attacker.atk <= 0) return "攻击力为 0，无法攻击";
  if (target.kind === "hero" && target.side === side) return "不能攻击自己";
  if (target.kind === "creature" && target.side !== foe) return "只能攻击敌方随从";

  const defender =
    target.kind === "creature" ? s.players[foe].board.find((c) => c.uid === target.uid) : undefined;
  if (target.kind === "creature" && !defender) return "目标随从不存在";

  const taunts = s.players[foe].board.filter((c) => c.taunt);
  if (taunts.length > 0 && target.kind === "hero") return "敌方有嘲讽随从，必须先攻击它";
  if (taunts.length > 0 && defender && !defender.taunt) return "必须先攻击嘲讽随从";

  attacker.attacksLeft -= 1;

  if (!defender) {
    const hero = s.players[foe];
    hero.hp -= attacker.atk;
    s.log.push(`⚔ 「${attacker.name}」攻击 ${hero.name}，造成 ${attacker.atk} 点伤害（剩余 ${Math.max(0, hero.hp)}）`);
    checkWinner(s);
    return null;
  }

  s.log.push(
    `⚔ 「${attacker.name}」(${attacker.atk}/${attacker.hp}) 交换 「${defender.name}」(${defender.atk}/${defender.hp})`,
  );
  defender.hp -= attacker.atk;
  attacker.hp -= defender.atk;
  sweepDeaths(s);
  return null;
}

/** 结束当前行动方回合，轮到对方 */
export function endTurn(s: GameState): void {
  if (s.winner !== null) return;
  const next = (1 - s.active) as Side;
  startTurn(s, next);
}
