// 玩家行动：道具牌（不换手）、上阵/下阵/技能/结束回合（换手；第 8 回合起进攻方上阵不换手）。规则校验集中在此，UI 与 AI 共用。
import type {
  CellPos,
  CharDef,
  CharRef,
  FieldChar,
  GameState,
  ItemDef,
  Side,
} from "./types";
import { RECYCLE_ITEM_GAIN, canChainDeploy, isValidCell, volcanoCell } from "./types";
import { damageChar, destroyChar, findChar, healChar, resolveNormalAttack } from "./combat";
import { applyItemEffects } from "./effects";
import { drawItems, endRoundSettlement, makeFieldChar, opponent } from "./state";

/**
 * 部署费用：原费用 ×(1 + 0.5×死亡次数)，不超过原费用的两倍；
 * 自爆小车等 noCostGrowth 角色费用不随死亡增长；守方地面角色上高地 ×2，向下取整。
 */
export function deployCostOf(def: CharDef, deathCount: number, elevated: boolean): number {
  let c = def.noCostGrowth ? def.cost : def.cost * (1 + 0.5 * deathCount);
  if (!def.noCostGrowth) c = Math.min(c, def.cost * 2);
  if (elevated) c *= 2;
  return Math.floor(c);
}

/**
 * 高地格：仅防守方拥有高地，为其后排左右两角（守方 6 区 = 2 高地 + 4 地面）。
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

/** 进攻方场上层级数量上限：3 级 ≤ 2，2 级 ≤ 4，1 级无限制 */
export const TIER_CAPS: Record<number, number> = { 2: 4, 3: 2 };

function tierCapError(
  s: GameState,
  side: Side,
  def: CharDef,
  charDefs: Record<string, CharDef>,
): string | null {
  if (!def.tier) return null;
  const cap = TIER_CAPS[def.tier];
  if (!cap) return null;
  const count = s.players[side].field.filter((c) => charDefs[c.defId]?.tier === def.tier).length;
  if (count >= cap) return `场上 ${def.tier} 级进攻方角色已达上限（${cap}）`;
  return null;
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

/** 上阵角色。第 8 回合起进攻方部署不换手（一次行动可连续部署多位），其余成功后换手。 */
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
  if (!isValidCell(p.role, pos)) return "该区域不存在";
  if (isBlockedCell(s, pos)) return "火山口不能部署角色";
  if (isCellOccupied(s, side, pos)) return "每个区域只能放置一个角色";
  const tierErr = tierCapError(s, side, def, charDefs);
  if (tierErr) return tierErr;
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
  // 第 8 回合起进攻方部署不消耗行动权：保留行动权，可继续部署或执行其他行动
  if (!canChainDeploy(p.role, s.round)) flipActor(s);
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
  p.handChars.push({ uid: c.uid, defId: c.defId, cooldown: 5 + c.cooldownDelta, deathCount: 1 });
  if (c.equipment) {
    s.itemDeck.push({ uid: s.nextUid++, itemId: c.equipment });
    s.log.push(`♻ 装备洗回了公共牌库`);
  }
  s.events.push({ t: "undeploy", side, uid });
  s.log.push(`⬆ ${p.name} 下阵「${c.name}」，返还 ${refund} 部署费，进入冷却`);
  flipActor(s);
  return null;
}

/** 普通攻击（每回合每位角色限一次；大招不受此限）。成功后换手。 */
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
  if (attacker.attacked) return "该角色本回合已普通攻击";
  const target = findChar(s, targetRef.side, targetRef.uid);
  if (!target || target.hp <= 0) return "目标不存在";
  if (attacker.passive === "healer") {
    if (targetRef.side !== side) return "疗养师只能治疗我方角色";
  } else if (targetRef.side === side) {
    return "普通攻击只能指定敌方角色";
  }

  attacker.attacked = true;
  resolveNormalAttack(s, attacker, target);
  flipActor(s);
  return null;
}

/** 某方某领域格的空位（部署/召唤通用） */
export function emptyCells(s: GameState, side: Side): CellPos[] {
  const role = s.players[side].role;
  const rows = role === "attack" ? 3 : 2;
  const out: CellPos[] = [];
  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < 3; col++) {
      const pos: CellPos = { row: row as 0 | 1 | 2, col: col as 0 | 1 | 2 };
      if (!isBlockedCell(s, pos) && !isCellOccupied(s, side, pos)) out.push(pos);
    }
  }
  return out;
}

/** 大招：只要技能点满且轮到我方行动就可释放（不受普攻次数限制）。成功后换手。 */
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
  if (c.sp < c.spMax) return `技能点不足（${c.sp}/${c.spMax}）`;
  const def = charDefs[c.defId];
  if (!def) return "未知角色";
  const burst = def.burst;

  // 召唤类大招需要空位，先校验再消耗技能点
  if (burst.summonTier1 && emptyCells(s, side).length === 0) return "没有可以召唤的空位";

  let target: FieldChar | undefined;
  if (burst.target === "one_enemy") {
    if (!targetRef) return "需要选择一名敌方角色";
    target = findChar(s, targetRef.side, targetRef.uid);
    if (!target || target.hp <= 0 || targetRef.side === side) return "目标必须是敌方角色";
  } else if (burst.target === "self" && targetRef) {
    target = findChar(s, targetRef.side, targetRef.uid);
  }

  c.sp = 0;
  s.events.push({ t: "burst", side, uid, name: burst.name });
  s.log.push(`🌟 ${s.players[side].name} 的「${c.name}」释放大招「${burst.name}」`);

  const foeSide = opponent(side);
  const value = burst.value ?? 0;
  switch (burst.target) {
    case "all_enemies": {
      for (const t of [...s.players[foeSide].field]) {
        s.events.push({ t: "attack", side, uid, targetUid: t.uid, heal: false, pure: burst.pure === true, amount: value });
        damageChar(s, t, value, { pure: burst.pure, source: "burst" }, c);
      }
      if (burst.weakenTopAtk) {
        const top = [...s.players[foeSide].field].filter((t) => t.hp > 0).sort((a, b) => b.atk - a.atk)[0];
        if (top) {
          top.atk = Math.max(0, top.atk - burst.weakenTopAtk);
          s.log.push(`📉 「${top.name}」攻击力 -${burst.weakenTopAtk}（${top.atk}）`);
        }
      }
      break;
    }
    case "all_allies": {
      const allies = [...s.players[side].field].filter((t) => t.hp > 0);
      for (const t of allies) healChar(s, t, value);
      if (burst.extraLowestHeal && allies.length > 0) {
        const lowest = [...allies].sort((a, b) => a.hp / a.maxHp - b.hp / b.maxHp)[0]!;
        s.log.push(`✚ 「${lowest.name}」伤势最重，获得额外治疗`);
        healChar(s, lowest, burst.extraLowestHeal);
      }
      break;
    }
    case "one_enemy": {
      if (target) {
        s.events.push({ t: "attack", side, uid, targetUid: target.uid, heal: false, pure: burst.pure === true, amount: value });
        damageChar(s, target, value, { pure: burst.pure, source: "burst" }, c);
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
      if (burst.shield) {
        c.shield += burst.shield;
        s.log.push(`🐢 「${c.name}」获得了 ${burst.shield} 点护盾（可吸收真实与非真实伤害）`);
      }
      if (burst.tempAtk) {
        c.atk += burst.tempAtk.value;
        c.tempAtk += burst.tempAtk.value; // 累加：加成未过期时再次释放，过期时须全额回收
        c.tempAtkTurns = Math.max(c.tempAtkTurns, burst.tempAtk.turns);
        s.log.push(`🗡 「${c.name}」攻击力 +${burst.tempAtk.value}（${c.atk}），持续 ${burst.tempAtk.turns} 回合`);
      }
      if (burst.ghostVeil) {
        c.ghostVeil = true;
        s.log.push(`👻 「${c.name}」化为虚体，受到的非真实伤害 -1`);
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
  if (burst.selfKill && c.hp > 0) {
    s.log.push(`💣 「${c.name}」引爆了自己！`);
    destroyChar(s, c);
  }
  if (burst.summonTier1) {
    const pool = Object.values(charDefs).filter((d) => d.faction === "attack" && d.tier === 1);
    const cells = emptyCells(s, side);
    if (pool.length > 0 && cells.length > 0) {
      const defSum = pool[Math.floor(Math.random() * pool.length)]!;
      const pos = cells[Math.floor(Math.random() * cells.length)]!;
      const summoned = makeFieldChar(defSum, s.nextUid++, side, 0);
      summoned.pos = pos;
      s.players[side].field.push(summoned);
      s.events.push({ t: "deploy", side, uid: summoned.uid, pos });
      s.log.push(`🌀 「${c.name}」召唤了「${defSum.name}」！`);
    }
  }
  if (def.selfHeal && c.hp > 0) {
    const real = Math.min(def.selfHeal, c.maxHp - c.hp);
    if (real > 0) {
      c.hp += real;
      s.events.push({ t: "heal", side, uid, amount: real });
      s.log.push(`✚ 「${c.name}」回复 ${real} 点生命（${c.hp}/${c.maxHp}）`);
    }
  }
  // 我来支援：释放大招后抽三张牌
  if (c.passive === "support" && c.hp > 0) {
    drawItems(s, side, 3);
    s.log.push(`📖 「${c.name}」的支援号令：从公共牌库抽了 3 张道具牌`);
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
  if (moveTo && !isValidCell(p.role, moveTo)) return "该区域不存在";

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

/**
 * 回收一张手牌道具：洗回公共牌库随机位置，立即获得部署费用。
 * 与使用道具一样不消耗行动权、不换手。
 */
export function recycleItem(
  s: GameState,
  itemDefs: Record<string, ItemDef>,
  side: Side,
  handUid: number,
): string | null {
  const err = actorError(s, side);
  if (err) return err;
  const p = s.players[side];
  const idx = p.handItems.findIndex((h) => h.uid === handUid);
  if (idx < 0) return "手牌中不存在该道具";
  const [card] = p.handItems.splice(idx, 1);
  const name = itemDefs[card!.itemId]?.name ?? card!.itemId;
  const pos = Math.floor(Math.random() * (s.itemDeck.length + 1)); // 洗入随机位置
  s.itemDeck.splice(pos, 0, { uid: s.nextUid++, itemId: card!.itemId });
  p.cost += RECYCLE_ITEM_GAIN;
  s.log.push(`♻ ${p.name} 回收「${name}」洗回公共牌库，获得 ${RECYCLE_ITEM_GAIN} 部署费`);
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
