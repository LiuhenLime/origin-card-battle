// 对局状态构建与回合推进
import type { CardDef, GameState, PlayerState, Side } from "./types";

export const MAX_HAND = 10;
export const MAX_MANA = 10;
export const MAX_BOARD = 7;
export const START_HP = 30;

/** Fisher–Yates 洗牌（返回新数组） */
export function shuffle<T>(arr: readonly T[]): T[] {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j]!, a[i]!];
  }
  return a;
}

/** 按每张卡的 count 字段把卡组展开并洗匀 */
export function buildDeck(defs: readonly CardDef[]): string[] {
  const list: string[] = [];
  for (const d of defs) {
    for (let i = 0; i < (d.count ?? 1); i++) list.push(d.id);
  }
  return shuffle(list);
}

export function createPlayer(id: Side, name: string, deck: string[]): PlayerState {
  return {
    id,
    name,
    hp: START_HP,
    maxHp: START_HP,
    mana: 0,
    maxMana: 0,
    deck,
    hand: [],
    board: [],
    fatigue: 0,
  };
}

/** 检查并记录胜负（血量归零即负；同归为平局） */
export function checkWinner(s: GameState): void {
  if (s.winner !== null) return;
  const [a, b] = s.players;
  if (a.hp <= 0 && b.hp <= 0) s.winner = "draw";
  else if (a.hp <= 0) s.winner = 1;
  else if (b.hp <= 0) s.winner = 0;
}

/** 抽一张牌：牌库空 → 疲劳递增扣血；手牌满 → 烧牌 */
export function drawCard(s: GameState, side: Side): void {
  const p = s.players[side];
  if (p.deck.length === 0) {
    p.fatigue += 1;
    p.hp -= p.fatigue;
    s.log.push(`⚡ ${p.name} 牌库枯竭，受到 ${p.fatigue} 点疲劳伤害（剩余 ${Math.max(0, p.hp)}）`);
    checkWinner(s);
    return;
  }
  const cardId = p.deck.pop()!;
  if (p.hand.length >= MAX_HAND) {
    s.log.push(`🔥 ${p.name} 手牌已满，烧掉了一张牌`);
    return;
  }
  p.hand.push({ uid: s.nextUid++, cardId });
}

/** 开始一个回合：法力水晶成长、随从解除眩晕并恢复攻击、抽一张牌 */
export function startTurn(s: GameState, side: Side): void {
  s.active = side;
  s.turn += 1;
  const p = s.players[side];
  p.maxMana = Math.min(MAX_MANA, p.maxMana + 1);
  p.mana = p.maxMana;
  for (const c of p.board) c.attacksLeft = 1;
  drawCard(s, side);
  s.log.push(`── 第 ${Math.ceil(s.turn / 2)} 回合 · ${p.name}（法力 ${p.mana}/${p.maxMana}）`);
}

/** 创建一局：双方同卡组构筑、先手 3 张后手 4 张 */
export function createGame(defs: readonly CardDef[], names: [string, string]): GameState {
  const s: GameState = {
    players: [
      createPlayer(0, names[0], buildDeck(defs)),
      createPlayer(1, names[1], buildDeck(defs)),
    ],
    active: 0,
    turn: 0,
    winner: null,
    log: [],
    nextUid: 1,
  };
  for (let i = 0; i < 3; i++) drawCard(s, 0);
  for (let i = 0; i < 4; i++) drawCard(s, 1);
  startTurn(s, 0);
  return s;
}
