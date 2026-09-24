// 战斗结算：攻防值统计、伤害与治疗（含被动/装备减免）、死亡与冷却。
import type { DamageSource, FieldChar, GameState, Side } from "./types";
import { DEATH_COOLDOWN } from "./types";

export interface LaneTotals {
  ground: number;
  sky: number;
}

export function findChar(s: GameState, side: Side, uid: number): FieldChar | undefined {
  return s.players[side].field.find((c) => c.uid === uid);
}

/** 某方场上同名角色数量（群聚被动用） */
function sameNameCount(s: GameState, c: FieldChar): number {
  return s.players[c.owner].field.filter((x) => x.defId === c.defId).length;
}

/** 角色的有效攻击力（含群聚被动） */
export function effectiveAtk(s: GameState, c: FieldChar): number {
  let atk = c.atk;
  if (c.passive === "pack_tactics" && sameNameCount(s, c) > 1) atk += 2;
  return atk;
}

/** 双方攻防值合计。进攻方看进攻值（与站位无关）；防守方看防守值（受高地转化影响） */
export function laneTotals(s: GameState, side: Side): LaneTotals {
  const p = s.players[side];
  const totals: LaneTotals = { ground: 0, sky: 0 };
  for (const c of p.field) {
    if (p.role === "attack") {
      if (c.domain === "ground") totals.ground += c.laneVal;
      else totals.sky += c.laneVal;
    } else if (c.domain === "sky" || c.elevated) totals.sky += c.laneVal;
    else totals.ground += c.laneVal;
  }
  return totals;
}

/**
 * 纯计算一次伤害经装备/被动减免后的数值，不修改任何状态。
 * 真实伤害无视全部减免。供 damageChar 与界面血条预演共用。
 */
export function computeDamage(
  target: FieldChar,
  amount: number,
  opts: { pure?: boolean },
): number {
  if (amount <= 0) return 0;
  let dmg = amount;
  if (!opts.pure) {
    if (target.equipment === "armor") dmg -= 1; // 防御胸甲
    if (target.ghostVeil) dmg -= 1; // 虚体
    if (target.passive === "tough_skin") dmg -= 1; // 皮糙肉厚
    if (target.passive === "shell") dmg -= 2; // 龙鳞
    if (target.passive === "magic_armor") dmg -= target.armorStacks; // 魔铠（可叠加）
  }
  return Math.max(0, dmg);
}

/** 目标最终会损失的生命（考虑护盾吸收，不改状态；多段伤害按顺序模拟） */
export function previewHpLoss(target: FieldChar, hits: number[], pure: boolean): number {
  let shield = target.shield;
  let loss = 0;
  for (const hit of hits) {
    let d = computeDamage(target, hit, { pure });
    if (d > 0 && shield > 0) {
      const absorbed = Math.min(shield, d);
      shield -= absorbed;
      d -= absorbed;
    }
    loss += d;
  }
  return loss;
}

/** 伤害入口：应用装备与被动减免 → 护盾吸收 → 扣血 → 尖鳞反伤 → 死亡进入冷却 */
export function damageChar(
  s: GameState,
  target: FieldChar,
  amount: number,
  opts: { pure?: boolean; source: DamageSource },
  killer?: FieldChar,
): void {
  if (amount <= 0 || target.hp <= 0) return;
  let dmg = computeDamage(target, amount, opts);
  if (dmg > 0 && target.shield > 0) {
    const absorbed = Math.min(target.shield, dmg);
    target.shield -= absorbed;
    dmg -= absorbed;
    s.log.push(`🛡 「${target.name}」的护盾吸收了 ${absorbed} 点伤害（剩余护盾 ${target.shield}）`);
  }
  if (dmg === 0) {
    s.log.push(`🛡 「${target.name}」的防御完全抵消了伤害`);
    return;
  }
  if (!opts.pure && target.passive === "magic_armor") target.armorStacks += 1;
  target.hp -= dmg;
  const killed = target.hp <= 0;
  s.events.push({ t: "damage", side: target.owner, uid: target.uid, amount: dmg, pure: opts.pure === true, killed });
  s.log.push(
    `💥 ${opts.pure ? "（真实伤害）" : ""}「${target.name}」受到 ${dmg} 点伤害（${Math.max(0, target.hp)}/${target.maxHp}）`,
  );
  // 尖鳞：受到普通攻击或大招伤害时反伤来源
  if (
    (opts.source === "attack" || opts.source === "burst") &&
    target.passive === "thorns" &&
    killer &&
    killer.hp > 0
  ) {
    s.log.push(`🦔 「${target.name}」的尖鳞刺伤了「${killer.name}」`);
    damageChar(s, killer, 5, { pure: true, source: "thorns" });
  }
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

/** 死亡：回手牌并进入冷却；结算亡语与嗜血 */
export function killChar(s: GameState, target: FieldChar, _killer?: FieldChar): void {
  target.hp = 0;
  const p = s.players[target.owner];
  p.field = p.field.filter((c) => c.uid !== target.uid);
  const foeSide = (1 - target.owner) as Side;
  const cooldown = DEATH_COOLDOWN + 1 + target.cooldownDelta; // 含死亡回合当次的结算递减
  const hand = p.handChars.find((h) => h.uid === target.uid);
  if (hand) {
    hand.cooldown = cooldown;
    hand.deathCount += 1;
  } else {
    // 上阵时手牌条目已被移除：死亡后重新入列进入冷却（含召唤单位）
    p.handChars.push({ uid: target.uid, defId: target.defId, cooldown, deathCount: 1 });
  }
  s.log.push(
    `☠ 「${target.name}」被击倒，进入 ${DEATH_COOLDOWN + target.cooldownDelta} 回合冷却`,
  );
  // 自爆小车亡语：对一名随机敌方单位造成 8 点非真实伤害
  if (target.passive === "die_blast") {
    const foes = s.players[foeSide].field.filter((c) => c.hp > 0);
    if (foes.length > 0) {
      const victim = foes[Math.floor(Math.random() * foes.length)]!;
      s.log.push(`💥 「${target.name}」的自爆引信被触发了！`);
      damageChar(s, victim, 8, { source: "passive" });
    }
  }
  // 嗜血：敌方阵营中拥有该被动的角色，在任意敌人死亡时回复生命
  for (const c of [...s.players[foeSide].field]) {
    if (c.passive === "bloodthirst" && c.hp > 0 && c.enemyDeathHeal > 0) {
      s.log.push(`🩸 「${c.name}」嗜血发动，回复 ${c.enemyDeathHeal} 点生命`);
      healChar(s, c, c.enemyDeathHeal);
    }
  }
  // 装备洗回公共牌库
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

/**
 * 立即击倒一名角色（不经过伤害流程，如自爆）。
 * 直接调用 killChar 以完整结算亡语、冷却与装备回收。
 */
export function destroyChar(s: GameState, target: FieldChar): void {
  if (target.hp <= 0) return;
  killChar(s, target);
}

/**
 * 单目标行动的合法候选（对被动规则生效）：
 * 嘲讽（你过来呀）优先；隐匿角色在有其他选择时被跳过。供 AI 与道具目标筛选共用。
 */
export function targetCandidates(s: GameState, foeSide: Side): FieldChar[] {
  const alive = s.players[foeSide].field.filter((c) => c.hp > 0);
  const taunts = alive.filter((c) => c.passive === "taunt");
  if (taunts.length > 0) return taunts;
  const visible = alive.filter((c) => c.passive !== "stealth");
  return visible.length > 0 ? visible : alive;
}

/** 普通攻击结算：疗养师强制治疗、三头犬三连击、暗蚀削上限 */
export function resolveNormalAttack(s: GameState, attacker: FieldChar, target: FieldChar): void {
  const atk = effectiveAtk(s, attacker);
  if (attacker.passive === "healer") {
    s.events.push({ t: "attack", side: attacker.owner, uid: attacker.uid, targetUid: target.uid, heal: true, pure: false, amount: 8 });
    healChar(s, target, 8);
    gainSp(s, attacker);
    healProc(s, attacker);
    return;
  }
  const hits = attacker.passive === "triple_head" ? 3 : 1;
  for (let i = 0; i < hits; i++) {
    if (target.hp <= 0) break; // 目标已倒下，剩余攻击落空
    const dmg = attacker.passive === "triple_head" ? Math.max(1, atk) : atk;
    s.events.push({ t: "attack", side: attacker.owner, uid: attacker.uid, targetUid: target.uid, heal: false, pure: false, amount: dmg });
    damageChar(s, target, dmg, { source: "attack" }, attacker);
  }
  // 暗蚀：普攻使目标生命上限 -1，持续到目标死亡
  if (attacker.passive === "curse" && target.hp > 0) {
    target.maxHp = Math.max(1, target.maxHp - 1);
    if (target.hp > target.maxHp) target.hp = target.maxHp;
    s.log.push(`🌑 「${target.name}」的生命上限被暗蚀 -1（${target.hp}/${target.maxHp}）`);
  }
  gainSp(s, attacker);
}

/** 疗养师被动：使用普攻/大招后随机对一名敌方角色造成 4 点真实伤害 */
function healProc(s: GameState, healer: FieldChar): void {
  const foes = s.players[(1 - healer.owner) as Side].field.filter((c) => c.hp > 0);
  if (foes.length === 0) return;
  const victim = foes[Math.floor(Math.random() * foes.length)]!;
  damageChar(s, victim, 4, { pure: true, source: "passive" });
}
