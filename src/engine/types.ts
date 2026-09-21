// 核心类型：静态卡牌定义（来自 data/cards.json）与运行时对局状态严格分离。
// 规则引擎只操作 GameState；卡牌内容全部是数据，加新卡不需要改代码。

export type Side = 0 | 1;

/** 效果目标选择器。带 all_/random_ 前缀的为无需手动指定的目标。 */
export type TargetSelector =
  | "enemy_hero"
  | "own_hero"
  | "enemy_creature"
  | "own_creature"
  | "any_creature"
  | "any"
  | "all_enemy_creatures"
  | "all_own_creatures"
  | "random_enemy_creature";

export type EffectType = "damage" | "heal" | "buff" | "draw";

/** 一个可结算的效果单元（draw 类型无需 target） */
export interface Effect {
  type: EffectType;
  target?: TargetSelector;
  /** damage / heal / draw 的数值；buff 时若不填 atk/hp 则作为双围增量 */
  value?: number;
  /** buff 专用：攻击力增量 */
  atk?: number;
  /** buff 专用：生命增量（同时提高上限） */
  hp?: number;
}

export type CardType = "creature" | "spell";
export type Rarity = "common" | "rare" | "epic" | "legendary";

/** 一张卡的静态定义（数据文件），加卡 = 往 data/cards.json 加一条 */
export interface CardDef {
  id: string;
  name: string;
  type: CardType;
  cost: number;
  /** creature 专用 */
  atk?: number;
  hp?: number;
  /** 嘲讽：对方必须先攻击嘲讽随从 */
  taunt?: boolean;
  /** 战吼：随从进场时触发的效果 */
  battlecry?: Effect[];
  /** spell 专用：结算效果 */
  effects?: Effect[];
  /** 展示文本（描述效果/风味） */
  text?: string;
  /** 阵营/系列标记，仅供整理筛选 */
  faction?: string;
  rarity?: Rarity;
  /** 在起始卡组中的张数，默认 1 */
  count?: number;
}

/** 场上的随从（运行时实体） */
export interface Creature {
  uid: number;
  cardId: string;
  name: string;
  owner: Side;
  atk: number;
  hp: number;
  maxHp: number;
  taunt: boolean;
  /** 本回合剩余攻击次数；召唤眩晕 = 进场回合为 0 */
  attacksLeft: number;
}

export interface HandCard {
  uid: number;
  cardId: string;
}

export interface PlayerState {
  id: Side;
  name: string;
  hp: number;
  maxHp: number;
  mana: number;
  maxMana: number;
  /** 牌库：卡牌 id 序列，抽牌从末尾 pop */
  deck: string[];
  hand: HandCard[];
  board: Creature[];
  /** 疲劳计数：牌库枯竭后每次抽牌受伤递增 */
  fatigue: number;
}

export interface GameState {
  players: [PlayerState, PlayerState];
  /** 当前行动方 */
  active: Side;
  /** 回合计数（双方各行动一次） */
  turn: number;
  winner: Side | "draw" | null;
  /** 对局日志，最新在末尾 */
  log: string[];
  nextUid: number;
}

/** 目标引用：英雄或某个随从 */
export type TargetRef =
  | { kind: "hero"; side: Side }
  | { kind: "creature"; side: Side; uid: number };
