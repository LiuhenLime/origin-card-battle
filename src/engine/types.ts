// 核心类型：攻防塔防式桌游引擎（进攻方 vs 防守方，地面/天空双维攻防值）。
// 静态定义（data/*.json）与运行时状态严格分离；引擎只操作 GameState。

export type Side = 0 | 1;

/** 战术角色：进攻方设法扣防守方总生命，防守方拖到回合数耗尽 */
export type Role = "attack" | "defense";

export type Difficulty = "normal" | "hard";
/** normal：防守方总生命 10、需存活 10 回合；hard：15、15 */
export const DIFFICULTY: Record<Difficulty, { hp: number; rounds: number }> = {
  normal: { hp: 10, rounds: 10 },
  hard: { hp: 15, rounds: 15 },
};

/** 单位领域：地面 或 天空 */
export type Domain = "ground" | "sky";

/** 每回合双方各获得的部署费用 */
export const COST_PER_ROUND = 15;

/** 角色死亡后的冷却回合数 */
export const DEATH_COOLDOWN = 5;

/** 站位：每方 2×3。row 0 = 后排（防守方为高地），row 1 = 前排（防守方为地面） */
export interface CellPos {
  row: 0 | 1;
  col: 0 | 1 | 2;
}
export const CELL_ROWS = 2;
export const CELL_COLS = 3;

export type Terrain = "plain" | "volcano";
/** 火山口固定替换双方后排中间格，其上/左/右区域回合结束受 6 点真实伤害 */
export const VOLCANO_DAMAGE = 6;
export function volcanoCell(side: Side): CellPos {
  return { row: 0, col: 1 };
}
export function volcanoBlastCells(side: Side): CellPos[] {
  return [
    { row: 1, col: 1 }, // 上
    { row: 0, col: 0 }, // 左
    { row: 0, col: 2 }, // 右
  ];
}

/** 角色静态定义（角色牌） */
export interface CharDef {
  id: string;
  name: string;
  title: string;
  cost: number; // 部署费用
  hp: number; // 生命值上限
  atk: number; // 攻击力（普通攻击的伤害/治疗量）
  spMax: number; // 技能点上限
  domain: Domain;
  /** 领域攻防值 */
  atkVal: number; // 进攻值（攻方生效）
  defVal: number; // 防守值（守方生效）
  /** 大招：技能点满后可释放，释放后清空 */
  burst: BurstDef;
  /** 大招附加：释放后治疗自身（影刺客） */
  selfHeal?: number;
  /** 被动效果描述与标识 */
  passive: PassiveId;
  passiveText: string;
  /** 初始技能点（默认 0） */
  initSp?: number;
  text: string;
}

export type PassiveId =
  | "none"
  | "tough_skin" // 小火龙：受到的普通攻击伤害 -1
  | "pack_tactics" // 哥布林：己方场上哥布林>1 时攻击 +2
  | "archmage" // 魔法师：普通攻击为真实伤害
  | "healer" // 治愈师：普通攻击改为治疗我方，初始技能点 2
  | "stone_wing" // 石像鬼：不受火山伤害
  | "bloodthirst" // 兽人战士：击杀敌人后回复 3 点生命
  | "bones" // 骷髅弓手：每回合结束回复 1 点生命
  | "spikes" // 双足飞龙：受到的技能伤害 -1
  | "shell" // 岩甲龟：受到的非真实伤害 -2
  | "ambush"; // 影刺客：攻击生命值低于自己的敌人时伤害 +2

export type BurstTarget = "all_enemies" | "all_allies" | "one_enemy" | "self" | "none";

export interface BurstDef {
  name: string;
  /** 目标类型（one_enemy/self 需要玩家选择目标） */
  target: BurstTarget;
  /** 数值：伤害/治疗/费用 */
  value?: number;
  /** true = 真实伤害 */
  pure?: boolean;
  /** 哥布林成群：将一张同名角色牌加入手牌 */
  addCopyToHand?: boolean;
  /** 永久攻击力加成（狂暴） */
  atkBuff?: number;
  /** 永久领域防守值加成（岩翼） */
  defBuff?: number;
  text: string;
}

/** 道具牌静态定义 */
export type ItemEffect =
  | { kind: "heal"; value: number }
  | { kind: "sp"; value: number }
  | { kind: "damage"; value: number; pure?: boolean } // 对一名敌方角色
  | { kind: "equip_armor" } // 受到的非真实伤害 -1
  | { kind: "atk_buff"; value: number } // 攻击力 +n（本场）
  | { kind: "def_buff"; value: number } // 领域防守值 +n（本场）
  | { kind: "draw"; value: number }
  | { kind: "move" } // 移动一名己方角色到任意合法空格
  | { kind: "weaken"; value: number }; // 敌方角色攻击 -n（最低 0）

/** 装备回收时机 */
export type Recycle = "immediate" | "on_wearer_death" | "consume";

export interface ItemDef {
  id: string;
  name: string;
  cost: number; // 消耗部署费用
  /** 需要目标：己方角色 / 敌方角色 / 己方角色(可移动) */
  target: "own_char" | "enemy_char" | "none";
  effects: ItemEffect[];
  recycle: Recycle;
  text: string;
  count: number; // 公共牌库张数
}

// ---------- 运行时 ----------

/** 场上角色 */
export interface FieldChar {
  uid: number;
  defId: string;
  name: string;
  owner: Side;
  pos: CellPos;
  hp: number;
  maxHp: number;
  atk: number; // 当前攻击力（含增益）
  sp: number;
  spMax: number;
  atkVal: number; // 当前进攻值（含增益）
  defVal: number; // 当前防守值（含增益）
  domain: Domain;
  /** 守方地面单位站上高地后转提供天空防守值 */
  elevated: boolean;
  equipment: string | null; // 装备的道具牌 id
  /** 实际支付过的部署费用（下阵时返还一半，向下取整） */
  paidCost: number;
  /** 本回合是否已使用技能（普攻或大招二选一） */
  skillUsed: boolean;
  passive: PassiveId;
  passiveText: string;
}

/** 手牌中的角色牌（待部署或冷却中） */
export interface HandChar {
  uid: number;
  defId: string;
  /** >0 = 冷却中（剩余回合数），不能部署 */
  cooldown: number;
  deathCount: number;
}

export interface HandItem {
  uid: number;
  itemId: string;
}

export interface PlayerState {
  id: Side;
  name: string;
  role: Role;
  /** 部署费用（可累计） */
  cost: number;
  handChars: HandChar[];
  handItems: HandItem[];
  field: FieldChar[];
  /** 防守方总生命（进攻方无用） */
  totalHp: number;
  totalHpMax: number;
}

export type GameEvent =
  | { t: "deploy"; side: Side; uid: number; pos: CellPos }
  | { t: "undeploy"; side: Side; uid: number }
  | { t: "attack"; side: Side; uid: number; targetUid: number; heal: boolean; pure: boolean; amount: number }
  | { t: "burst"; side: Side; uid: number; name: string }
  | { t: "damage"; side: Side; uid: number; amount: number; pure: boolean; killed: boolean }
  | { t: "heal"; side: Side; uid: number; amount: number }
  | { t: "sp"; side: Side; uid: number; amount: number }
  | { t: "item"; side: Side; itemId: string }
  | { t: "move"; side: Side; uid: number; to: CellPos }
  | { t: "settlement"; round: number; groundDiff: number; skyDiff: number; breach: boolean }
  | { t: "volcano"; side: Side; uid: number }
  | { t: "round"; n: number };

export interface GameConfig {
  /** 单机：玩家恒为防守方（side 0），AI 进攻方（side 1） */
  difficulty: Difficulty;
  terrain: Terrain;
  /** 双方选定的角色牌 defId（各 8 张）；decks[0] = 玩家（防守），decks[1] = AI（进攻） */
  decks: [string[], string[]];
  names: [string, string];
}

export interface GameState {
  players: [PlayerState, PlayerState];
  /** 当前行动方 */
  active: Side;
  /** 双方是否已宣告结束 */
  passed: [boolean, boolean];
  round: number;
  terrain: Terrain;
  difficulty: Difficulty;
  /** 公共道具牌库 */
  itemDeck: HandItem[];
  winner: null | { side: Side | "defense"; reason: string };
  log: string[];
  events: GameEvent[];
  nextUid: number;
}

/** 角色引用（场上或手牌） */
export interface CharRef {
  side: Side;
  uid: number;
}
