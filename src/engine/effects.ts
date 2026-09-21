// 效果系统：把数据文件里的 Effect 描述落到 GameState 上。
import type { Effect, GameState, Side, TargetRef } from "./types";
import { checkWinner, drawCard } from "./state";

export function sameRef(a: TargetRef, b: TargetRef): boolean {
  if (a.kind !== b.kind) return false;
  if (a.kind === "hero" && b.kind === "hero") return a.side === b.side;
  if (a.kind === "creature" && b.kind === "creature") return a.uid === b.uid;
  return false;
}

/** 该效果是否需要玩家手动指定目标 */
export function needsTarget(e: Effect): boolean {
  if (e.type === "draw") return false;
  return (
    e.target !== undefined &&
    e.target !== "all_enemy_creatures" &&
    e.target !== "all_own_creatures" &&
    e.target !== "random_enemy_creature"
  );
}

/** bySide 视角下，效果 e 可选中的全部合法目标 */
export function legalTargets(s: GameState, bySide: Side, e: Effect): TargetRef[] {
  if (e.target === undefined) return [];
  const out: TargetRef[] = [];
  const creatures = (side: Side) =>
    s.players[side].board.map<TargetRef>((c) => ({ kind: "creature", side, uid: c.uid }));
  switch (e.target) {
    case "enemy_hero":
      out.push({ kind: "hero", side: (1 - bySide) as Side });
      break;
    case "own_hero":
      out.push({ kind: "hero", side: bySide });
      break;
    case "enemy_creature":
      out.push(...creatures((1 - bySide) as Side));
      break;
    case "own_creature":
      out.push(...creatures(bySide));
      break;
    case "any_creature":
      out.push(...creatures(0), ...creatures(1));
      break;
    case "any":
      out.push(
        { kind: "hero", side: 0 },
        { kind: "hero", side: 1 },
        ...creatures(0),
        ...creatures(1),
      );
      break;
    case "all_enemy_creatures":
    case "all_own_creatures":
    case "random_enemy_creature":
      break; // 无需指定
  }
  return out;
}

function findCreature(s: GameState, ref: TargetRef) {
  if (ref.kind !== "creature") return undefined;
  return s.players[ref.side].board.find((c) => c.uid === ref.uid);
}

/** 结算单个效果。target 仅对需要指定的目标生效；无候选时静默跳过。 */
export function applyEffect(s: GameState, bySide: Side, e: Effect, target?: TargetRef): void {
  // 抽牌与目标无关，始终为施法者抽牌
  if (e.type === "draw") {
    const n = e.value ?? 1;
    for (let i = 0; i < n; i++) drawCard(s, bySide);
    if (n > 0) s.log.push(`📖 ${s.players[bySide].name} 抽了 ${n} 张牌`);
    return;
  }
  if (e.target === undefined) return;
  const foe = (1 - bySide) as Side;
  const value = e.value ?? 0;

  const damageCreature = (uid: number, side: Side, amount: number) => {
    const c = s.players[side].board.find((x) => x.uid === uid);
    if (!c) return;
    c.hp -= amount;
    s.log.push(`💥 「${c.name}」受到 ${amount} 点伤害（${Math.max(0, c.hp)}/${c.maxHp}）`);
  };
  const healCreature = (uid: number, side: Side, amount: number) => {
    const c = s.players[side].board.find((x) => x.uid === uid);
    if (!c) return;
    const real = Math.min(amount, c.maxHp - c.hp);
    c.hp += real;
    if (real > 0) s.log.push(`✚ 「${c.name}」回复 ${real} 点生命（${c.hp}/${c.maxHp}）`);
  };

  switch (e.target) {
    case "enemy_hero":
    case "own_hero": {
      const side = e.target === "own_hero" ? bySide : foe;
      const p = s.players[side];
      if (e.type === "damage") {
        p.hp -= value;
        s.log.push(`💥 ${p.name} 受到 ${value} 点伤害（剩余 ${Math.max(0, p.hp)}）`);
        checkWinner(s);
      } else if (e.type === "heal") {
        const real = Math.min(value, p.maxHp - p.hp);
        p.hp += real;
        if (real > 0) s.log.push(`✚ ${p.name} 回复 ${real} 点生命（${p.hp}/${p.maxHp}）`);
      }
      return;
    }
    case "enemy_creature":
    case "own_creature":
    case "any_creature":
    case "any": {
      if (!target) return;
      const t = findCreature(s, target);
      if (e.type === "damage") {
        if (t) damageCreature(t.uid, t.owner, value);
        else if (target.kind === "hero") {
          const p = s.players[target.side];
          p.hp -= value;
          s.log.push(`💥 ${p.name} 受到 ${value} 点伤害（剩余 ${Math.max(0, p.hp)}）`);
          checkWinner(s);
        }
      } else if (e.type === "heal" && t) {
        healCreature(t.uid, t.owner, value);
      } else if (e.type === "buff" && t) {
        const atkUp = e.atk ?? value;
        const hpUp = e.hp ?? value;
        t.atk += atkUp;
        t.maxHp += hpUp;
        t.hp += hpUp;
        s.log.push(`⬆ 「${t.name}」获得 +${atkUp}/+${hpUp}（${t.atk}/${t.hp}）`);
      }
      return;
    }
    case "all_enemy_creatures":
    case "all_own_creatures": {
      const side = e.target === "all_own_creatures" ? bySide : foe;
      const board = [...s.players[side].board];
      if (e.type === "damage") {
        for (const c of board) damageCreature(c.uid, side, value);
      } else if (e.type === "buff") {
        const atkUp = e.atk ?? value;
        const hpUp = e.hp ?? value;
        for (const c of board) {
          c.atk += atkUp;
          c.maxHp += hpUp;
          c.hp += hpUp;
          s.log.push(`⬆ 「${c.name}」获得 +${atkUp}/+${hpUp}（${c.atk}/${c.hp}）`);
        }
      } else if (e.type === "heal") {
        for (const c of board) healCreature(c.uid, side, value);
      }
      return;
    }
    case "random_enemy_creature": {
      const board = s.players[foe].board;
      if (board.length === 0) return;
      const c = board[Math.floor(Math.random() * board.length)]!;
      if (e.type === "damage") damageCreature(c.uid, foe, value);
      return;
    }
  }
}

/** 结算一批效果后清扫阵亡随从 */
export function sweepDeaths(s: GameState): void {
  for (const side of [0, 1] as const) {
    const p = s.players[side];
    const dead = p.board.filter((c) => c.hp <= 0);
    if (dead.length > 0) {
      for (const c of dead) s.log.push(`☠ 「${c.name}」被消灭`);
      p.board = p.board.filter((c) => c.hp > 0);
    }
  }
}
