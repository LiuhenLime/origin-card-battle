// 玩家行动：道具牌（不换手）、上阵/下阵/技能/结束回合（换手）。规则校验集中在此，UI 与 AI 共用。
import type {
  CellPos,
  CharDef,
  CharRef,
  FieldChar,
  GameState,
  ItemDef,
  Side,
} from "./types";
import { COST_PER_ROUND, volcanoCell } from "./types";
import { damageChar, findChar, healChar, resolveNormalAttack } from "./combat";
import { applyItemEffects } from "./effects";
import { endRoundSettlement, makeFieldChar, opponent } from "./state";

/** 部署费用：原费用 ×(1 + 0.5×死亡次数)，守方地面角色上高地 ×2，向下取整 */
export function deployCostOf(def: CharDef, deathCount: number, elevated: boolean): number {
  let c = def.cost * (1 + 0.5 * deathCount);
  if (elevated) c *= 2;
  return Math.floor(c);
}

/**
 * 高地格：仅防守方拥有高地，为其后排左右两角（每方 6 区 = 2 高地 + 4 地面）。
 * 进攻方无高地概念，部署无双倍费用惩罚。
 */
export function isHighlandCell(role: "attack" | "defense", pos: CellPos): boolean {
  return role === "defense" && pos.row === 0 && pos.col !== 1;
}

/** 守方地面角色站上高地后转为提供天空防守值 */
export function elevationFor(role: "attack" | "defense", domain: "ground" | "sky", pos: CellPos): boolean {
  return domain === "ground" && isHighlandCell(role, pos);
}

/** 火山口格（双方后排中间）不可部署 */
export function isBlockedCell(s: GameState, pos: CellPos): boolean {
  if (s.terrain !== "volcano") return false;
  const v = volcanoCell(0);
  return pos.row === v.row && pos.col === v.col;
}

/** 每个区域只能放置一个角色 */
export function isCellOccupied(s: GameState, side: Side, pos: CellPos): boolean {
  return s.players[side].field.some((c) => c.pos.row === pos.row && c.pos.col === pos.col);
}

/** 当前行动方校验；返回错误信息或 null */
function actorError(s: GameState, side: Side): string | null {
  if (s.winner !== null) return "对局已结束";
  if (s.active !== side) return "还没轮到你";
  if (s.passed[side]) return "你已宣告结束";
  return null;
}

/** 行动结束后换手；对方已宣告结束则由己方继续行动，直至双方都结束 */
function flipActor(s: GameState): void {
  const next = opponent(s.active);
  if (!s.passed[next]) s.active = next;
}

/** 上阵角色。成功后换手。 */
export function deployChar(
  s: GameState,
  charDefs: Record<string, CharDef>,
  side: Side,
  handUid: number,
  pos: CellPos,
): string | null {
  const err = actorError(s, side);
  if (err) return err;
  const p = s.players[side];
  const hand = p.handChars.find((h) => h.uid === handUid);
  if (!hand) return "手牌中不存在该角色";
  if (hand.cooldown > 0) return `冷却中，还需 ${hand.cooldown} 回合`;
  const def = charDefs[hand.defId];
  if (!def) return "未知角色";
  if (isBlockedCell(s, pos)) return "火山口不能部署角色";
  if (isCellOccupied(s, side, pos)) return "每个区域只能放置一个角色";
  const elevated = elevationFor(p.role, def.domain, pos);
  const cost = deployCostOf(def, hand.deathCount, elevated);
  if (p.cost < cost) return `部署费用不足（需 ${cost}）`;

  p.cost -= cost;
  p.handChars = p.handChars.filter((h) => h.uid !== handUid);
  const fc = makeFieldChar(def, hand.uid, side, cost);
  fc.pos = pos;
  fc.elevated = elevated;
  p.field.push(fc);
  s.events.push({ t: "deploy", side, uid: fc.uid, pos });
  s.log.push(`⬇ ${p.name} 部署「${def.name}」${elevated ? "（高地）" : ""}，花费 ${cost} 部署费`);
  flipActor(s);
  return null;
}

/** 下阵角色：视为死亡进入冷却，返还一半部署费。成功后换手。 */
export function undeployChar(s: GameState, side: Side, uid: number): string | null {
  const err = actorError(s, side);
  if (err) return err;
  const p = s.players[side];
  const c = findChar(s, side, uid);
  if (!c) return "场上不存在该角色";
  const refund = Math.floor(c.paidCost / 2);
  p.field = p.field.filter((x) => x.uid !== uid);
  p.cost += refund;
  p.handChars.push({ uid: c.uid, defId: c.defId, cooldown: 6, deathCount: 1 });
  if (c.equipment) {
    s.itemDeck.push({ uid: s.nextUid++, itemId: c.equipment });
    s.log.push(`♻ 装备洗回了公共牌库`);
  }
  s.events.push({ t: "undeploy", side, uid });
  s.log.push(`⬆ ${p.name} 下阵「${c.name}」，返还 ${refund} 部署费，进入冷却`);
  flipActor(s);
  return null;
}

/** 普通攻击/治疗。成功后换手。 */
export function useNormalAttack(
  s: GameState,
  side: Side,
  uid: number,
  targetRef: CharRef,
): string | null {
  const err = actorError(s, side);
  if (err) return err;
  const attacker = findChar(s, side, uid);
  if (!attacker) return "场上不存在该角色";
  if (attacker.hp <= 0) return "该角色已被击倒";
  if (attacker.skillUsed) return "该角色本回合已使用过技能";
  const target = findChar(s, targetRef.side, targetRef.uid);
  if (!target || target.hp <= 0) return "目标不存在";
  if (attacker.passive === "healer") {
    if (targetRef.side !== side) return "治愈师只能治疗我方角色";
  } else if (targetRef.side === side) {
    return "普通攻击只能指定敌方角色";
  }

  attacker.skillUsed = true;
  resolveNormalAttack(s, attacker, target);
  flipActor(s);
  return null;
}

/** 大招。成功后换手。 */
export function useBurst(
  s: GameState,
  charDefs: Record<string, CharDef>,
  side: Side,
  uid: number,
  targetRef: CharRef | undefined,
): string | null {
  const err = actorError(s, side);
  if (err) return err;
  const c = findChar(s, side, uid);
  if (!c) return "场上不存在该角色";
  if (c.hp <= 0) return "该角色已被击倒";
  if (c.skillUsed) return "该角色本回合已使用过技能";
  if (c.sp < c.spMax) return `技能点不足（${c.sp}/${c.spMax}）`;
  const def = charDefs[c.defId];
  if (!def) return "未知角色";
  const burst = def.burst;

  let target: FieldChar | undefined;
  if (burst.target === "one_enemy") {
    if (!targetRef) return "需要选择一名敌方角色";
    target = findChar(s, targetRef.side, targetRef.uid);
    if (!target || target.hp <= 0 || targetRef.side === side) return "目标必须是敌方角色";
  } else if (burst.target === "self" && targetRef) {
    target = findChar(s, targetRef.side, targetRef.uid);
  }

  c.skillUsed = true;
  c.sp = 0;
  s.events.push({ t: "burst", side, uid, name: burst.name });
  s.log.push(`🌟 ${s.players[side].name} 的「${c.name}」释放大招「${burst.name}」`);

  const foeSide = opponent(side);
  const value = burst.value ?? 0;
  switch (burst.target) {
    case "all_enemies": {
      for (const t of [...s.players[foeSide].field]) {
        s.events.push({ t: "attack", side, uid, targetUid: t.uid, heal: false, pure: burst.pure === true, amount: value });
        damageChar(s, t, value, { pure: burst.pure, source: "skill" }, c);
      }
      break;
    }
    case "all_allies": {
      for (const t of [...s.players[side].field]) healChar(s, t, value);
      break;
    }
    case "one_enemy": {
      if (target) {
        s.events.push({ t: "attack", side, uid, targetUid: target.uid, heal: false, pure: burst.pure === true, amount: value });
        damageChar(s, target, value, { pure: burst.pure, source: "skill" }, c);
      }
      break;
    }
    case "self": {
      if (burst.atkBuff) {
        c.atk += burst.atkBuff;
        s.log.push(`💪 「${c.name}」攻击力 +${burst.atkBuff}（${c.atk}）`);
      }
      if (burst.defBuff) {
        c.laneVal += burst.defBuff;
        s.log.push(`🛡 「${c.name}」防守值 +${burst.defBuff}（${c.laneVal}）`);
      }
      if (burst.value) {
        s.players[side].cost += burst.value;
        s.log.push(`💰 ${s.players[side].name} 获得 ${burst.value} 部署费`);
      }
      break;
    }
    case "none":
      break;
  }
  if (burst.addCopyToHand) {
    s.players[side].handChars.push({ uid: s.nextUid++, defId: c.defId, cooldown: 0, deathCount: 0 });
    s.log.push(`👥 一张新的「${c.name}」加入了手牌`);
  }
  if (def.selfHeal && c.hp > 0) {
    const real = Math.min(def.selfHeal, c.maxHp - c.hp);
    if (real > 0) {
      c.hp += real;
      s.events.push({ t: "heal", side, uid, amount: real });
      s.log.push(`✚ 「${c.name}」回复 ${real} 点生命（${c.hp}/${c.maxHp}）`);
    }
  }
  flipActor(s);
  return null;
}

/** 打出道具牌（不换手，可连续使用）。 */
export function playItem(
  s: GameState,
  itemDefs: Record<string, ItemDef>,
  side: Side,
  handUid: number,
  targetRef: CharRef | undefined,
  moveTo?: CellPos,
): string | null {
  const err = actorError(s, side);
  if (err) return err;
  const p = s.players[side];
  const idx = p.handItems.findIndex((h) => h.uid === handUid);
  if (idx < 0) return "手牌中不存在该道具";
  const def = itemDefs[p.handItems[idx]!.itemId];
  if (!def) return "未知道具";
  if (p.cost < def.cost) return `部署费用不足（需 ${def.cost}）`;

  // 目标校验
  let target: FieldChar | undefined;
  if (def.target !== "none") {
    if (!targetRef) return "需要选择一个目标";
    target = findChar(s, targetRef.side, targetRef.uid);
    if (!target || target.hp <= 0) return "目标不存在";
    if (def.target === "own_char" && targetRef.side !== side) return "必须指定我方角色";
    if (def.target === "enemy_char" && targetRef.side === side) return "必须指定敌方角色";
  }

  p.cost -= def.cost;
  p.handItems.splice(idx, 1);
  s.events.push({ t: "item", side, itemId: def.id });
  s.log.push(`🃏 ${p.name} 使用道具「${def.name}」`);

  const err2 = applyItemEffects(s, itemDefs, side, def, target, moveTo);
  if (err2) {
    // 效果无法结算（如移动无合法位置）：退还费用与手牌
    p.cost += def.cost;
    p.handItems.push({ uid: handUid, itemId: def.id });
    return err2;
  }

  // 回收
  if (def.recycle === "immediate") {
    s.itemDeck.push({ uid: s.nextUid++, itemId: def.id });
    s.log.push(`♻ 「${def.name}」洗回了公共牌库`);
  }
  return null;
}

/** 宣告结束回合。成功后换手；双方都结束则进行回合结算。 */
export function passAction(
  s: GameState,
  charDefs: Record<string, CharDef>,
  side: Side,
): string | null {
  const err = actorError(s, side);
  if (err) return err;
  s.passed[side] = true;
  s.log.push(`⏭ ${s.players[side].name} 宣告结束回合`);
  if (s.passed[0] && s.passed[1]) {
    endRoundSettlement(s, charDefs);
  } else {
    flipActor(s);
  }
  return null;
}

/** 本回合双方各获得的部署费用（供 UI 展示） */
export const ROUND_COST = COST_PER_ROUND;
