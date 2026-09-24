// 对局构建、抽牌与回合结算。
import type {
  CharDef,
  FieldChar,
  GameConfig,
  GameState,
  HandItem,
  ItemDef,
  PlayerState,
  Side,
} from "./types";
import { COST_PER_ROUND, DIFFICULTY, volcanoBlastCells } from "./types";
import { damageChar, gainSp, healChar, laneTotals } from "./combat";

/** Fisher–Yates 洗牌（返回新数组） */
export function shuffle<T>(arr: readonly T[]): T[] {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j]!, a[i]!];
  }
  return a;
}

export function opponent(side: Side): Side {
  return (1 - side) as Side;
}

/** 创建 FieldChar（复制被动数值参数，战斗层无需反查定义表） */
function makeFieldChar(def: CharDef, uid: number, owner: Side, paidCost: number): FieldChar {
  return {
    uid,
    defId: def.id,
    name: def.name,
    owner,
    pos: { row: 1, col: 0 },
    hp: def.hp,
    maxHp: def.hp,
    atk: def.atk,
    sp: def.initSp ?? 0,
    spMax: def.spMax,
    laneVal: def.laneVal,
    domain: def.domain,
    elevated: false,
    equipment: null,
    paidCost,
    attacked: false,
    passive: def.passive,
    passiveText: def.passiveText,
    shield: 0,
    armorStacks: 0,
    ghostVeil: false,
    tempAtk: 0,
    tempAtkTurns: 0,
    endHeal: def.endHeal ?? 0,
    enemyDeathHeal: def.enemyDeathHeal ?? 0,
    cooldownDelta: def.cooldownDelta ?? 0,
    noCostGrowth: def.noCostGrowth ?? false,
  };
}

/** 从公共牌库抽 n 张道具牌 */
export function drawItems(s: GameState, side: Side, n: number): void {
  const p = s.players[side];
  for (let i = 0; i < n; i++) {
    const card = s.itemDeck.pop();
    if (!card) return; // 牌库枯竭：静默停止
    p.handItems.push(card);
  }
}

/** 创建一局。单机：玩家（side 0）恒为防守方，AI（side 1）为进攻方，防守方先行动。 */
export function createGame(
  config: GameConfig,
  charDefs: Record<string, CharDef>,
  itemDefs: Record<string, ItemDef>,
): GameState {
  const roles: [PlayerState["role"], PlayerState["role"]] = ["defense", "attack"];
  const diff = DIFFICULTY[config.difficulty];

  let uid = 1;
  const makePlayer = (id: Side): PlayerState => ({
    id,
    name: config.names[id],
    role: roles[id],
    cost: COST_PER_ROUND,
    handChars: config.decks[id].map((defId) => ({ uid: uid++, defId, cooldown: 0, deathCount: 0 })),
    handItems: [],
    field: [],
    totalHp: roles[id] === "defense" ? diff.hp : 0,
    totalHpMax: roles[id] === "defense" ? diff.hp : 0,
  });

  const deck: HandItem[] = [];
  for (const def of Object.values(itemDefs)) {
    for (let i = 0; i < def.count; i++) deck.push({ uid: uid++, itemId: def.id });
  }

  const s: GameState = {
    players: [makePlayer(0), makePlayer(1)],
    active: roles[0] === "defense" ? 0 : 1, // 防守方先行动
    passed: [false, false],
    round: 1,
    terrain: config.terrain,
    difficulty: config.difficulty,
    itemDeck: shuffle(deck),
    winner: null,
    log: [],
    events: [],
    nextUid: uid,
  };

  drawItems(s, 0, 5);
  drawItems(s, 1, 5);
  s.log.push(
    `── 第 1 回合 · ${s.players[s.active].name}（${roles[s.active] === "attack" ? "进攻方" : "防守方"}）先行动`,
  );
  s.log.push(`🎯 ${roles[1] === "defense" ? s.players[1].name : s.players[0].name} 需守住 ${diff.hp} 点总生命 ${diff.rounds} 回合`);
  return s;
}

/**
 * 回合结束结算：抽牌 → 技能点 → 被动回复 → 地形伤害 → 攻防比对 → 胜负 → 冷却与限时增益 → 费用。
 * 结算完成后开启新一轮，防守方先行动。
 */
export function endRoundSettlement(
  s: GameState,
  charDefs: Record<string, CharDef>,
): void {
  const round = s.round;
  s.log.push(`── 第 ${round} 回合结算`);

  // 1) 双方各抽 2 张道具牌
  drawItems(s, 0, 2);
  drawItems(s, 1, 2);

  // 2) 场上所有角色 +2 技能点
  for (const side of [0, 1] as const) {
    for (const c of [...s.players[side].field]) {
      gainSp(s, c, 2);
    }
  }

  // 3) 被动回合回复（骷髅射手 / 深渊海蛇）
  for (const side of [0, 1] as const) {
    for (const c of [...s.players[side].field]) {
      if (c.passive === "bones" && c.hp > 0 && c.endHeal > 0) healChar(s, c, c.endHeal);
    }
  }

  // 4) 地形伤害（火山口上/左/右区域，真实伤害；石像鬼免疫）
  if (s.terrain === "volcano") {
    for (const side of [0, 1] as const) {
      const blast = volcanoBlastCells(side);
      for (const c of [...s.players[side].field]) {
        const hit = blast.some((b) => b.row === c.pos.row && b.col === c.pos.col);
        if (hit && c.passive !== "stone_wing") {
          s.events.push({ t: "volcano", side, uid: c.uid });
          damageChar(s, c, 6, { pure: true, source: "terrain" });
        }
      }
    }
  }

  // 5) 攻防比对（暗影幽灵在场时天空防线视为失守）
  const atkSide = (s.players[0].role === "attack" ? 0 : 1) as Side;
  const defSide = opponent(atkSide);
  const atkT = laneTotals(s, atkSide);
  const defT = laneTotals(s, defSide);
  const ghostBreach = s.players[atkSide].field.some((c) => c.passive === "nightmare" && c.hp > 0);
  const breach = atkT.ground > defT.ground || atkT.sky > defT.sky || ghostBreach;
  const groundDiff = Math.max(0, atkT.ground - defT.ground);
  const skyDiff = Math.max(0, atkT.sky - defT.sky);
  const total = groundDiff + skyDiff + (ghostBreach ? 1 : 0);
  s.events.push({ t: "settlement", round, groundDiff, skyDiff, breach, ghostBreach });
  const defender = s.players[defSide];
  if (breach) {
    defender.totalHp -= total;
    s.log.push(
      `⚔ 防线被突破！地面差 ${groundDiff} + 天空差 ${skyDiff}${ghostBreach ? " + 幽灵 1" : ""}，${defender.name} 总生命 -${total}（${Math.max(0, defender.totalHp)}/${defender.totalHpMax}）`,
    );
  } else {
    s.log.push(`🛡 防守成功！地面 ${defT.ground}≥${atkT.ground}，天空 ${defT.sky}≥${atkT.sky}`);
  }
  if (ghostBreach) {
    s.log.push(`👻 暗影幽灵仍在场上游荡，天空防线被视作失守，额外扣除 1 点总生命`);
  }

  // 6) 胜负判定
  if (defender.totalHp <= 0) {
    s.winner = { side: atkSide, reason: `防守方总生命归零` };
  } else if (round >= DIFFICULTY[s.difficulty].rounds) {
    s.winner = { side: "defense", reason: `防守方完整守住了 ${DIFFICULTY[s.difficulty].rounds} 个回合` };
  }

  // 7) 冷却递减（死亡当次结算也计入）与限时增益递减
  for (const side of [0, 1] as const) {
    for (const h of s.players[side].handChars) {
      if (h.cooldown > 0) {
        h.cooldown -= 1;
        if (h.cooldown === 0) s.log.push(`⏳ 「${charDefs[h.defId]?.name ?? h.defId}」冷却结束，可以再次上场`);
      }
    }
    for (const c of s.players[side].field) {
      if (c.tempAtkTurns > 0) {
        c.tempAtkTurns -= 1;
        if (c.tempAtkTurns === 0 && c.tempAtk > 0) {
          c.atk = Math.max(0, c.atk - c.tempAtk);
          s.log.push(`⌛ 「${c.name}」的突袭加成结束了（攻击力 -${c.tempAtk}）`);
          c.tempAtk = 0;
        }
      }
    }
  }

  // 8) 部署费用与新一轮（对局已结束时不再推进回合数）
  for (const side of [0, 1] as const) {
    const p = s.players[side];
    p.cost += COST_PER_ROUND;
    for (const c of p.field) c.attacked = false;
  }
  s.passed = [false, false];
  if (!s.winner) {
    s.round = round + 1;
    s.active = defSide; // 防守方先行动
    s.events.push({ t: "round", n: s.round });
    s.log.push(`── 第 ${s.round} 回合 · ${s.players[defSide].name} 先行动`);
  }
}

export { makeFieldChar };
