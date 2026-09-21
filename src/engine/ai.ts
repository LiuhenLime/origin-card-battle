// 贪心 AI：每次返回一个行动，由 UI 逐步执行（便于回放观战）。
// 优先级：致命一击 > 出牌（战吼/增益先于攻击） > 优势交换 > 打脸 > 结束回合。
import type { CardDef, Effect, GameState, TargetRef } from "./types";
import { isPlayable, playCard, attack, endTurn } from "./actions";
import { legalTargets, needsTarget } from "./effects";

export type AiStep =
  | { kind: "play"; handUid: number; target?: TargetRef }
  | { kind: "attack"; attackerUid: number; target: TargetRef }
  | { kind: "end" };

/** 为一个需要目标的效果挑选当前最优合法目标；挑不到返回 undefined（该效果自动落空） */
function pickTarget(s: GameState, side: 0 | 1, e: Effect): TargetRef | undefined {
  const foe = (1 - side) as 0 | 1;
  const options = legalTargets(s, side, e);
  if (options.length === 0) return undefined;
  const heroes = options.filter((o) => o.kind === "hero");
  const creatures = options
    .filter((o) => o.kind === "creature")
    .map((o) => o.kind === "creature" ? { ref: o, c: s.players[o.side].board.find((x) => x.uid === o.uid)! } : null)
    .filter((x): x is NonNullable<typeof x> => x !== null);

  if (e.type === "damage") {
    // 能斩杀英雄直接打脸
    const foeHero = s.players[foe];
    if (e.target === "any" && (e.value ?? 0) >= foeHero.hp) {
      return { kind: "hero", side: foe };
    }
    // 优先斩杀攻击力最高的敌方随从
    const killable = creatures
      .filter((x) => x.c.owner === foe && (e.value ?? 0) >= x.c.hp)
      .sort((a, b) => b.c.atk - a.c.atk);
    if (killable[0]) return killable[0].ref;
    if (creatures.some((x) => x.c.owner === foe)) {
      const foeCreatures = creatures
        .filter((x) => x.c.owner === foe)
        .sort((a, b) => b.c.atk - a.c.atk);
      return foeCreatures[0]?.ref;
    }
    // 只有己方随从可选（理论上不会出现在示例卡里）
    return heroes[0] ?? creatures[0]?.ref;
  }
  if (e.type === "heal") {
    // 治疗己方伤势最重的随从，否则英雄
    const hurt = creatures
      .filter((x) => x.c.owner === side)
      .sort((a, b) => a.c.hp - a.c.maxHp - (b.c.hp - b.c.maxHp));
    return hurt[0]?.ref ?? { kind: "hero", side };
  }
  if (e.type === "buff") {
    const strongest = creatures.filter((x) => x.c.owner === side).sort((a, b) => b.c.atk - a.c.atk);
    return strongest[0]?.ref;
  }
  return options[0];
}

/** 给一张可出的手牌打分，返回 [分数, 目标] */
function scorePlay(
  s: GameState,
  side: 0 | 1,
  def: CardDef,
): { score: number; target?: TargetRef } {
  const foe = (1 - side) as 0 | 1;
  const p = s.players[side];
  const opp = s.players[foe];
  let target: TargetRef | undefined;

  if (def.type === "creature") {
    let score = def.cost * 10 + (def.atk ?? 0) + (def.hp ?? 0) + (def.taunt ? 1 : 0);
    if (def.battlecry?.some(needsTarget)) {
      const e = def.battlecry.find(needsTarget)!;
      target = pickTarget(s, side, e);
      if (!target) score -= 100; // 目标落空则先不出
    }
    return { score, target };
  }

  // 法术
  let score = def.cost * 10;
  for (const e of def.effects ?? []) {
    if (needsTarget(e)) {
      target = pickTarget(s, side, e);
      if (!target) return { score: -1 };
    }
    switch (e.target) {
      case "all_enemy_creatures":
        // AOE：敌方场面 >= 3 时才值得
        if (opp.board.length >= 3) score += 15;
        else score -= 20;
        break;
      case "enemy_hero":
      case "any":
        if (e.type === "damage") {
          const killable = opp.board.filter((c) => (e.value ?? 0) >= c.hp);
          if (target && target.kind === "creature") score += 6; // 点杀
          else if ((e.value ?? 0) >= opp.hp) score += 999; // 斩杀
          else if (killable.length === 0 && e.target === "any") score -= 8; // 只能打脸且无收益
        }
        break;
      case "own_hero":
        if (e.type === "heal") {
          const missing = p.maxHp - p.hp;
          score += missing >= 6 ? Math.min(12, missing) : -25; // 不残血不奶自己
        }
        break;
      case "own_creature":
        if (e.type === "buff" && p.board.length === 0) return { score: -1 };
        if (e.type === "heal" && !p.board.some((c) => c.hp < c.maxHp)) return { score: -1 };
        score += 5;
        break;
      default:
        break;
    }
  }
  return { score, target };
}

/** 计算当前 AI 的下一个行动 */
export function aiNextAction(s: GameState, defs: Record<string, CardDef>): AiStep {
  const side = s.active;
  const me = s.players[side];
  const foe = s.players[(1 - side) as 0 | 1];

  const ready = me.board.filter((c) => c.attacksLeft > 0 && c.atk > 0);
  const taunts = foe.board.filter((c) => c.taunt);
  const totalAtk = ready.reduce((sum, c) => sum + c.atk, 0);

  // 1. 场面无嘲讽且总攻足以斩杀 → 全部打脸
  if (taunts.length === 0 && ready.length > 0 && totalAtk >= foe.hp) {
    const a = ready[0]!;
    return { kind: "attack", attackerUid: a.uid, target: { kind: "hero", side: foe.id } };
  }

  // 2. 先出牌（增益类效果要先于攻击结算）
  let best: { score: number; uid: number; target?: TargetRef } | null = null;
  for (const hc of me.hand) {
    const def = defs[hc.cardId];
    if (!def || !isPlayable(s, side, def)) continue;
    const { score, target } = scorePlay(s, side, def);
    if (score > 0 && (!best || score > best.score)) best = { score, uid: hc.uid, target };
  }
  if (best) return { kind: "play", handUid: best.uid, target: best.target };

  // 3. 攻击阶段
  if (ready.length > 0) {
    // 3a. 有嘲讽必须先解嘲讽：优先能白吃嘲讽的攻击者
    if (taunts.length > 0) {
      const sortedTaunts = [...taunts].sort((a, b) => a.hp - b.hp);
      for (const t of sortedTaunts) {
        const killer = ready
          .filter((a) => a.atk >= t.hp && a.hp > t.atk)
          .sort((a, b) => b.atk - a.atk)[0];
        if (killer) return { kind: "attack", attackerUid: killer.uid, target: { kind: "creature", side: foe.id, uid: t.uid } };
      }
      // 白吃不了 → 用攻击力最低的随从去换
      const chump = [...ready].sort((a, b) => a.atk - b.atk)[0]!;
      const t = sortedTaunts[0]!;
      return { kind: "attack", attackerUid: chump.uid, target: { kind: "creature", side: foe.id, uid: t.uid } };
    }
    // 3b. 优势交换：能杀掉对方随从且自己不死
    for (const d of [...foe.board].sort((a, b) => b.atk - a.atk)) {
      const killer = ready
        .filter((a) => a.atk >= d.hp && d.atk < a.hp)
        .sort((a, b) => a.atk - b.atk)[0]; // 用最小的代价完成击杀
      if (killer) {
        return { kind: "attack", attackerUid: killer.uid, target: { kind: "creature", side: foe.id, uid: d.uid } };
      }
    }
    // 3c. 没有好交换 → 打脸
    const a = [...ready].sort((x, y) => y.atk - x.atk)[0]!;
    return { kind: "attack", attackerUid: a.uid, target: { kind: "hero", side: foe.id } };
  }

  // 4. 结束回合
  return { kind: "end" };
}

/** 在真实对局上执行一个 AI 行动（供 UI 调用） */
export function applyAiStep(s: GameState, defs: Record<string, CardDef>): AiStep {
  const step = aiNextAction(s, defs);
  if (step.kind === "play") playCard(s, defs, s.active, step.handUid, step.target);
  else if (step.kind === "attack") attack(s, s.active, step.attackerUid, step.target);
  else endTurn(s);
  return step;
}
