// 核心类型：攻防塔防式桌游引擎（进攻方 vs 防守方，地面/天空双维攻防值）。
// 静态定义（data/*.json）与运行时状态严格分离；引擎只操作 GameState。

export type Side = 0 | 1;

/** 战术角色：进攻方设法扣防守方总生命，防守方拖到回合数耗尽 */
export type Role = "attack" | "defense";

/** 防守方总生命（唯一模式） */
export const DEFENDER_TOTAL_HP = 10;
/** 防守方需完整守住的回合数 */
export const TOTAL_ROUNDS = 10;

/** 单位领域：地面 或 天空 */
export type Domain = "ground" | "sky";

/** 防守方每回合获得的部署费用（固定） */
export const COST_PER_ROUND = 20;

/**
 * 回合开始时某方获得的部署费用：
 * 进攻方按回合递增——第 1-5 回合 20、第 6-7 回合 30、第 8 回合 40、第 9 回合 45、第 10 回合起 50；
 * 防守方恒为 COST_PER_ROUND。
 */
export function roundIncome(role: Role, round: number): number {
  if (role === "defense") return COST_PER_ROUND;
  if (round <= 5) return 20;
  if (round <= 7) return 30;
  if (round === 8) return 100;
  if (round === 9) return 150;
  return 200;
}

/** 回收一张手牌道具洗回牌库时立即获得的部署费用 */
export const RECYCLE_ITEM_GAIN = 3;

/** 角色死亡后的冷却回合数 */
export const DEATH_COOLDOWN = 4;

/** 从该回合起（含），进攻方部署不再消耗行动权——一次行动可连续部署多位角色 */
export const MULTI_DEPLOY_FROM_ROUND = 8;

/** 进攻方部署后是否保留行动权（第 MULTI_DEPLOY_FROM_ROUND 回合起连续部署） */
export function canChainDeploy(role: Role, round: number): boolean {
  return role === "attack" && round >= MULTI_DEPLOY_FROM_ROUND;
}

/** 该回合开始时，进攻方手牌中所有死亡冷却立即清零（阵亡过的角色即刻可再上阵） */
export const COOLDOWN_RESET_ROUND = 8;

/** 站位。row 0 = 后排（防守方为高地），大 row = 前排（靠近中线） */
export interface CellPos {
  row: 0 | 1 | 2;
  col: 0 | 1 | 2;
}

/** 双方区域尺寸：防守方 2×3（6 格），进攻方 3×3（9 格） */
export function gridRows(role: Role): number {
  return role === "attack" ? 3 : 2;
}

/** 位置是否在该方场地内 */
export function isValidCell(role: Role, pos: CellPos): boolean {
  return pos.row >= 0 && pos.row < gridRows(role) && pos.col >= 0 && pos.col <= 2;
}

export type Terrain = "plain" | "volcano";
/** 火山口固定替换双方后排中间格，其上/左/右区域回合结束受 6 点真实伤害 */
export const VOLCANO_DAMAGE = 6;
export function volcanoCell(_side: Side): CellPos {
  return { row: 0, col: 1 };
}
export function volcanoBlastCells(_side: Side): CellPos[] {
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
  /** 阵营：防守方牌仅显示防守值，进攻方牌仅显示进攻值 */
  faction: "defense" | "attack";
  /** 领域数值：防守方牌为防守值，进攻方牌为进攻值 */
  laneVal: number;
  /** 进攻方角色稀有层级：1/2/3。场上同层级数量受上限约束（3 级 ≤2，2 级 ≤4） */
  tier?: 1 | 2 | 3;
  /** 大招：技能点满后可释放，释放后清空 */
  burst: BurstDef;
  /** 大招附加：释放后治疗自身（深渊海蛇） */
  selfHeal?: number;
  /** 被动效果描述与标识 */
  passive: PassiveId;
  passiveText: string;
  /** 初始技能点（默认 0） */
  initSp?: number;
  /** 每回合结束被动回复生命量（bones 被动，默认 0） */
  endHeal?: number;
  /** 每当有敌人死亡时回复的生命量（bloodthirst 被动，默认 0） */
  enemyDeathHeal?: number;
  /** 死亡冷却回合修正（自爆小车 -2） */
  cooldownDelta?: number;
  /** true = 再次上阵费用不随死亡次数增长（自爆小车） */
  noCostGrowth?: boolean;
  text: string;
}

export type PassiveId =
  | "none"
  | "tough_skin" // 皮糙肉厚：受到的非真实伤害 -1
  | "die_blast" // 自爆小车亡语：死亡时对随机敌方单位造成 8 点非真实伤害
  | "support" // 我来支援：释放大招后抽 3 张牌
  | "healer" // 疗养师：普攻治疗我方 8 点；使用普攻/大招时随机对敌方一名角色 4 点真实伤害
  | "stone_wing" // 飞行：不受场地（火山）伤害
  | "bloodthirst" // 嗜血：每当有敌人死亡时回复生命
  | "bones" // 每回合结束回复生命（量见 endHeal）
  | "thorns" // 尖鳞：受到普通攻击或大招伤害时对来源造成 5 点真实伤害
  | "shell" // 龙鳞：受到的非真实伤害 -2
  | "taunt" // 你过来呀：优先被敌方攻击
  | "stealth" // 隐匿：场上有其他我方角色时，敌人优先攻击其他角色
  | "pack_tactics" // 群聚：己方场上同名角色 >1 时攻击 +2
  | "magic_armor" // 魔铠：每受到一次非真实伤害，其后受到的非真实伤害 -1（死亡重置）
  | "triple_head" // 我有三个头：普攻连续造成三次非真实伤害（每次至少 1）
  | "curse" // 暗蚀：普攻使目标生命值上限 -1（持续到目标死亡）
  | "nightmare"; // 暗影幽灵：回合结束时若仍在场上，天空防线视为失守并额外扣 1 点总生命

export type BurstTarget = "all_enemies" | "all_allies" | "one_enemy" | "self" | "none";

export interface BurstDef {
  name: string;
  /** 目标类型（one_enemy/self 需要玩家选择目标） */
  target: BurstTarget;
  /** 数值：伤害/治疗/费用 */
  value?: number;
  /** true = 真实伤害 */
  pure?: boolean;
  /** 永久攻击力加成（狂暴） */
  atkBuff?: number;
  /** 永久领域防守值加成（变硬） */
  defBuff?: number;
  /** 护盾：吸收真实与非真实伤害（龟甲护体） */
  shield?: number;
  /** 限时攻击力加成（突袭） */
  tempAtk?: { value: number; turns: number };
  /** 额外治疗血量百分比最低的我方角色（治治你的） */
  extraLowestHeal?: number;
  /** 所有敌方角色受伤后，削减敌方攻击力最高者的攻击力（魔军冲锋） */
  weakenTopAtk?: number;
  /** 化为虚体：受到的非真实伤害 -1，持续到死亡（虚体大招） */
  ghostVeil?: boolean;
  /** 立即死亡（自爆，触发亡语） */
  selfKill?: boolean;
  /** 召唤一个随机一级进攻方角色到己方随机空位（深渊召唤） */
  summonTier1?: boolean;
  text: string;
}

/** 道具牌静态定义 */
export type ItemEffect =
  | { kind: "heal"; value: number }
  | { kind: "sp"; value: number }
  | { kind: "damage"; value: number; pure?: boolean } // 对一名敌方角色
  | { kind: "equip_armor" } // 受到的非真实伤害 -1
  | { kind: "atk_buff"; value: number } // 攻击力 +n（本场）
  | { kind: "def_buff"; value: number } // 领域防守/进攻值 +n（本场）
  | { kind: "draw"; value: number }
  | { kind: "move" } // 移动一名己方角色到任意合法空格
  | { kind: "weaken"; value: number }; // 敌方角色攻击 -n（最低 0）

/** 装备回收时机 */
export type Recycle = "immediate" | "on_wearer_death" | "consume";

export interface ItemDef {
  id: string;
  name: string;
  cost: number; // 消耗部署费用
  /** 需要目标：己方角色 / 敌方角色 / 无 */
  target: "own_char" | "enemy_char" | "none";
  effects: ItemEffect[];
  recycle: Recycle;
  text: string;
  count: number; // 公共牌库张数
}

// ---------- 运行时 ----------

/** 伤害来源类型（决定尖鳞反伤等被动是否触发） */
export type DamageSource = "attack" | "burst" | "item" | "terrain" | "thorns" | "passive";

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
  /** 领域数值：防守方为防守值，进攻方为进攻值 */
  laneVal: number;
  domain: Domain;
  /** 守方地面单位站上高地后转提供天空防守值 */
  elevated: boolean;
  equipment: string | null; // 装备的道具牌 id
  /** 实际支付过的部署费用（下阵时返还一半，向下取整） */
  paidCost: number;
  /** 本回合是否已普通攻击（大招不受此限制） */
  attacked: boolean;
  passive: PassiveId;
  passiveText: string;
  /** 护盾值（吸收真实与非真实伤害） */
  shield: number;
  /** 魔铠叠加层数（每受一次非真实伤害 +1，死亡重置） */
  armorStacks: number;
  /** 虚体：受到的非真实伤害 -1 */
  ghostVeil: boolean;
  /** 限时攻击力加成（突袭） */
  tempAtk: number;
  tempAtkTurns: number;
  /** 从静态定义复制的被动参数（避免战斗层反查定义表） */
  endHeal: number;
  enemyDeathHeal: number;
  cooldownDelta: number;
  noCostGrowth: boolean;
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
  | { t: "settlement"; round: number; groundDiff: number; skyDiff: number; breach: boolean; ghostBreach?: boolean }
  | { t: "volcano"; side: Side; uid: number }
  | { t: "round"; n: number };

export interface GameConfig {
  terrain: Terrain;
  /** 双方选定的角色牌 defId；decks[0] = 玩家（防守，8 张），decks[1] = AI（进攻，8 种各 2 张） */
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
