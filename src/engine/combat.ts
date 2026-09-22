// 战斗结算：攻防值统计、伤害与治疗（含被动/装备减免）、死亡与冷却。
import type { CharDef, FieldChar, GameState, Side } from "./types";
import { DEATH_COOLDOWN } from "./types";

export interface LaneTotals {
  ground: number;
  sky: number;
}

export function findChar(s: GameState, side: Side, uid: number): FieldChar | undefined {
  return s.players[side].field.find((c) => c.uid === uid);
}

/** 某方场上哥布林数量（结对被动用） */
function goblinCount(s: GameState, side: Side, goblinId: string): number {
  return s.players[side].field.filter((c) => c.defId === goblinId).length;
}

/** 角色的有效攻击力（含结对被动） */
export function effectiveAtk(s: GameState, c: FieldChar, goblinId: string): number {
  let atk = c.atk;
  if (c.passive === "pack_tactics" && goblinCount(s, c.owner, goblinId) > 1) atk += 2;
  return atk;
}

/** 双方攻防值合计。进攻方看进攻值（与站位无关）；防守方看防守值（受高地转化影响） */
export function laneTotals(s: GameState, side: Side): LaneTotals {
  const p = s.players[side];
  const totals: LaneTotals = { ground: 0, sky: 0 };
  for (const c of p.field) {
    if (p.role === "attack") {
      if (c.domain === "ground") totals.ground += c.atkVal;
      else totals.sky += c.atkVal;
    } else if (c.domain === "sky" || c.elevated) totals.sky += c.defVal;
    else totals.ground += c.defVal;
  }
  return totals;
}

/** 伤害入口：应用装备与被动减免（真实伤害除外），死亡进入冷却 */
export function damageChar(
  s: GameState,
  target: FieldChar,
  amount: number,
  opts: { pure?: boolean; source: "attack" | "skill" | "terrain" },
  killer?: FieldChar,
): void {
  if (amount <= 0 || target.hp <= 0) return;
  let dmg = amount;
  if (!opts.pure) {
    if (target.equipment === "armor") dmg -= 1; // 防御胸甲
    if (target.passive === "tough_skin" && opts.source === "attack") dmg -= 1;
    if (target.passive === "shell") dmg -= 2;
    if (target.passive === "spikes" && opts.source === "skill") dmg -= 1;
  }
  dmg = Math.max(0, dmg);
  if (dmg === 0) {
    s.log.push(`🛡 「${target.name}」的防御完全抵消了伤害`);
    return;
  }
  target.hp -= dmg;
  const killed = target.hp <= 0;
  s.events.push({ t: "damage", side: target.owner, uid: target.uid, amount: dmg, pure: opts.pure === true, killed });
  s.log.push(
    `💥 ${opts.pure ? "（真实伤害）" : ""}「${target.name}」受到 ${dmg} 点伤害（${Math.max(0, target.hp)}/${target.maxHp}）`,
  );
  if (killed) killChar(s, target, killer);
}

/** 治疗（角色生命；防守方总生命不可回复） */
export function healChar(s: GameState, target: FieldChar, amount: number): void {
  if (amount <= 0 || target.hp <= 0) return;
  const real = Math.min(amount, target.maxHp - target.hp);
  if (real <= 0) return;
  target.hp += real;
  s.events.push({ t: "heal", side: target.owner, uid: target.uid, amount: real });
  s.log.push(`✚ 「${target.name}」回复 ${real} 点生命（${target.hp}/${target.maxHp}）`);
}

/** 死亡：回手牌并进入冷却；击杀者结算嗜血 */
export function killChar(s: GameState, target: FieldChar, killer?: FieldChar): void {
  target.hp = 0;
  const p = s.players[target.owner];
  p.field = p.field.filter((c) => c.uid !== target.uid);
  const hand = p.handChars.find((h) => h.uid === target.uid);
  if (hand) {
    hand.cooldown = DEATH_COOLDOWN + 1; // 含死亡回合当次的结算递减
    hand.deathCount += 1;
  }
  s.log.push(`☠ 「${target.name}」被击倒，进入 ${DEATH_COOLDOWN} 回合冷却`);
  if (killer && killer.passive === "bloodthirst" && killer.hp > 0) {
    healChar(s, killer, 3);
  }
  // 装备的防御胸甲洗回公共牌库
  if (target.equipment) recycleEquipment(s, target.equipment);
}

/** 装备回收：洗回公共牌库（由 killChar 调用） */
export function recycleEquipment(s: GameState, itemId: string): void {
  s.itemDeck.push({ uid: s.nextUid++, itemId });
  s.log.push(`♻ 角色的装备洗回了公共牌库`);
}

/** 攻击或治疗后获得 1 技能点 */
export function gainSp(s: GameState, c: FieldChar, amount = 1): void {
  if (c.hp <= 0 || c.sp >= c.spMax) return;
  const real = Math.min(amount, c.spMax - c.sp);
  c.sp += real;
  s.events.push({ t: "sp", side: c.owner, uid: c.uid, amount: real });
}

/** 普通攻击结算：法师被动真实伤害、治愈师强制治疗、刺客偷袭加成 */
export function resolveNormalAttack(
  s: GameState,
  attacker: FieldChar,
  target: FieldChar,
  goblinId: string,
): void {
  const atk = effectiveAtk(s, attacker, goblinId);
  if (attacker.passive === "healer") {
    s.events.push({ t: "attack", side: attacker.owner, uid: attacker.uid, targetUid: target.uid, heal: true, pure: false, amount: atk });
    healChar(s, target, atk);
    gainSp(s, attacker);
    return;
  }
  const pure = attacker.passive === "archmage";
  let dmg = atk;
  if (attacker.passive === "ambush" && target.hp < attacker.hp) {
    dmg += 2;
    s.log.push(`🗡 「${attacker.name}」触发偷袭，伤害 +2`);
  }
  s.events.push({ t: "attack", side: attacker.owner, uid: attacker.uid, targetUid: target.uid, heal: false, pure, amount: dmg });
  damageChar(s, target, dmg, { pure, source: "attack" }, attacker);
  gainSp(s, attacker);
}
