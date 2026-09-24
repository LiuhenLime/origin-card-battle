// src/engine/types.ts
var DIFFICULTY = {
  normal: { hp: 10, rounds: 10 },
  hard: { hp: 15, rounds: 15 }
};
var COST_PER_ROUND = 15;
var DEATH_COOLDOWN = 5;
function volcanoCell(side) {
  return { row: 0, col: 1 };
}
function volcanoBlastCells(side) {
  return [
    { row: 1, col: 1 },
    // 上
    { row: 0, col: 0 },
    // 左
    { row: 0, col: 2 }
    // 右
  ];
}

// src/engine/combat.ts
function findChar(s, side, uid) {
  return s.players[side].field.find((c) => c.uid === uid);
}
function sameNameCount(s, c) {
  return s.players[c.owner].field.filter((x) => x.defId === c.defId).length;
}
function effectiveAtk(s, c) {
  let atk = c.atk;
  if (c.passive === "pack_tactics" && sameNameCount(s, c) > 1) atk += 2;
  return atk;
}
function laneTotals(s, side) {
  const p = s.players[side];
  const totals = { ground: 0, sky: 0 };
  for (const c of p.field) {
    if (p.role === "attack") {
      if (c.domain === "ground") totals.ground += c.laneVal;
      else totals.sky += c.laneVal;
    } else if (c.domain === "sky" || c.elevated) totals.sky += c.laneVal;
    else totals.ground += c.laneVal;
  }
  return totals;
}
function damageChar(s, target, amount, opts, killer) {
  if (amount <= 0 || target.hp <= 0) return;
  let dmg = amount;
  if (!opts.pure) {
    if (target.equipment === "armor") dmg -= 1;
    if (target.passive === "tough_skin" && opts.source === "attack") dmg -= 1;
    if (target.passive === "shell") dmg -= 2;
    if (target.passive === "spikes" && opts.source === "skill") dmg -= 1;
    if (target.passive === "wraith") dmg -= 1;
  }
  dmg = Math.max(0, dmg);
  if (dmg === 0) {
    s.log.push(`\u{1F6E1} \u300C${target.name}\u300D\u7684\u9632\u5FA1\u5B8C\u5168\u62B5\u6D88\u4E86\u4F24\u5BB3`);
    return;
  }
  target.hp -= dmg;
  const killed = target.hp <= 0;
  s.events.push({ t: "damage", side: target.owner, uid: target.uid, amount: dmg, pure: opts.pure === true, killed });
  s.log.push(
    `\u{1F4A5} ${opts.pure ? "\uFF08\u771F\u5B9E\u4F24\u5BB3\uFF09" : ""}\u300C${target.name}\u300D\u53D7\u5230 ${dmg} \u70B9\u4F24\u5BB3\uFF08${Math.max(0, target.hp)}/${target.maxHp}\uFF09`
  );
  if (killed) killChar(s, target, killer);
}
function healChar(s, target, amount) {
  if (amount <= 0 || target.hp <= 0) return;
  const real = Math.min(amount, target.maxHp - target.hp);
  if (real <= 0) return;
  target.hp += real;
  s.events.push({ t: "heal", side: target.owner, uid: target.uid, amount: real });
  s.log.push(`\u271A \u300C${target.name}\u300D\u56DE\u590D ${real} \u70B9\u751F\u547D\uFF08${target.hp}/${target.maxHp}\uFF09`);
}
function killChar(s, target, killer) {
  target.hp = 0;
  const p = s.players[target.owner];
  p.field = p.field.filter((c) => c.uid !== target.uid);
  const hand = p.handChars.find((h) => h.uid === target.uid);
  if (hand) {
    hand.cooldown = DEATH_COOLDOWN + 1;
    hand.deathCount += 1;
  }
  s.log.push(`\u2620 \u300C${target.name}\u300D\u88AB\u51FB\u5012\uFF0C\u8FDB\u5165 ${DEATH_COOLDOWN} \u56DE\u5408\u51B7\u5374`);
  if (killer && killer.passive === "bloodthirst" && killer.hp > 0) {
    healChar(s, killer, 3);
  }
  if (target.equipment) recycleEquipment(s, target.equipment);
}
function recycleEquipment(s, itemId) {
  s.itemDeck.push({ uid: s.nextUid++, itemId });
  s.log.push(`\u267B \u89D2\u8272\u7684\u88C5\u5907\u6D17\u56DE\u4E86\u516C\u5171\u724C\u5E93`);
}
function gainSp(s, c, amount = 1) {
  if (c.hp <= 0 || c.sp >= c.spMax) return;
  const real = Math.min(amount, c.spMax - c.sp);
  c.sp += real;
  s.events.push({ t: "sp", side: c.owner, uid: c.uid, amount: real });
}
function resolveNormalAttack(s, attacker, target) {
  const atk = effectiveAtk(s, attacker);
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
    s.log.push(`\u{1F5E1} \u300C${attacker.name}\u300D\u89E6\u53D1\u5077\u88AD\uFF0C\u4F24\u5BB3 +2`);
  }
  if (attacker.passive === "execute" && target.hp <= target.maxHp / 2) {
    dmg += 2;
    s.log.push(`\u{1F5E1} \u300C${attacker.name}\u300D\u89E6\u53D1\u65A9\u6740\uFF0C\u4F24\u5BB3 +2`);
  }
  s.events.push({ t: "attack", side: attacker.owner, uid: attacker.uid, targetUid: target.uid, heal: false, pure, amount: dmg });
  damageChar(s, target, dmg, { pure, source: "attack" }, attacker);
  gainSp(s, attacker);
}

// src/engine/state.ts
function opponent(side) {
  return 1 - side;
}
function makeFieldChar(def, uid, owner, paidCost) {
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
    skillUsed: false,
    passive: def.passive,
    passiveText: def.passiveText
  };
}
function drawItems(s, side, n) {
  const p = s.players[side];
  for (let i = 0; i < n; i++) {
    const card = s.itemDeck.pop();
    if (!card) return;
    p.handItems.push(card);
  }
}
function endRoundSettlement(s, charDefs) {
  const round = s.round;
  s.log.push(`\u2500\u2500 \u7B2C ${round} \u56DE\u5408\u7ED3\u7B97`);
  drawItems(s, 0, 2);
  drawItems(s, 1, 2);
  for (const side of [0, 1]) {
    for (const c of [...s.players[side].field]) {
      gainSp(s, c, 2);
    }
  }
  for (const side of [0, 1]) {
    for (const c of [...s.players[side].field]) {
      if (c.passive === "bones" && c.hp > 0) healChar(s, c, 1);
    }
  }
  if (s.terrain === "volcano") {
    for (const side of [0, 1]) {
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
  const atkSide = s.players[0].role === "attack" ? 0 : 1;
  const defSide = opponent(atkSide);
  const atkT = laneTotals(s, atkSide);
  const defT = laneTotals(s, defSide);
  const breach = atkT.ground > defT.ground || atkT.sky > defT.sky;
  const groundDiff = Math.max(0, atkT.ground - defT.ground);
  const skyDiff = Math.max(0, atkT.sky - defT.sky);
  const total = groundDiff + skyDiff;
  s.events.push({ t: "settlement", round, groundDiff, skyDiff, breach });
  const defender = s.players[defSide];
  if (breach) {
    defender.totalHp -= total;
    s.log.push(`\u2694 \u9632\u7EBF\u88AB\u7A81\u7834\uFF01\u5730\u9762\u5DEE ${groundDiff} + \u5929\u7A7A\u5DEE ${skyDiff}\uFF0C${defender.name} \u603B\u751F\u547D -${total}\uFF08${Math.max(0, defender.totalHp)}/${defender.totalHpMax}\uFF09`);
  } else {
    s.log.push(`\u{1F6E1} \u9632\u5B88\u6210\u529F\uFF01\u5730\u9762 ${defT.ground}\u2265${atkT.ground}\uFF0C\u5929\u7A7A ${defT.sky}\u2265${atkT.sky}`);
  }
  if (defender.totalHp <= 0) {
    s.winner = { side: atkSide, reason: `\u9632\u5B88\u65B9\u603B\u751F\u547D\u5F52\u96F6` };
  } else if (round >= DIFFICULTY[s.difficulty].rounds) {
    s.winner = { side: "defense", reason: `\u9632\u5B88\u65B9\u5B8C\u6574\u5B88\u4F4F\u4E86 ${DIFFICULTY[s.difficulty].rounds} \u4E2A\u56DE\u5408` };
  }
  for (const side of [0, 1]) {
    for (const h of s.players[side].handChars) {
      if (h.cooldown > 0) {
        h.cooldown -= 1;
        if (h.cooldown === 0) s.log.push(`\u23F3 \u300C${charDefs[h.defId]?.name ?? h.defId}\u300D\u51B7\u5374\u7ED3\u675F\uFF0C\u53EF\u4EE5\u518D\u6B21\u4E0A\u573A`);
      }
    }
  }
  for (const side of [0, 1]) {
    const p = s.players[side];
    p.cost += COST_PER_ROUND;
    for (const c of p.field) c.skillUsed = false;
  }
  s.passed = [false, false];
  if (!s.winner) {
    s.round = round + 1;
    s.active = defSide;
    s.events.push({ t: "round", n: s.round });
    s.log.push(`\u2500\u2500 \u7B2C ${s.round} \u56DE\u5408 \xB7 ${s.players[defSide].name} \u5148\u884C\u52A8`);
  }
}

// src/engine/effects.ts
function applyItemEffects(s, itemDefs, side, def, target, moveTo) {
  void itemDefs;
  for (const e of def.effects) {
    switch (e.kind) {
      case "heal": {
        if (!target) return "\u9700\u8981\u76EE\u6807";
        healChar(s, target, e.value);
        break;
      }
      case "sp": {
        if (!target) return "\u9700\u8981\u76EE\u6807";
        const real = Math.min(e.value, target.spMax - target.sp);
        if (real > 0) {
          target.sp += real;
          s.events.push({ t: "sp", side: target.owner, uid: target.uid, amount: real });
          s.log.push(`\u26A1 \u300C${target.name}\u300D\u83B7\u5F97 ${real} \u6280\u80FD\u70B9\uFF08${target.sp}/${target.spMax}\uFF09`);
        }
        break;
      }
      case "damage": {
        if (!target) return "\u9700\u8981\u76EE\u6807";
        damageChar(s, target, e.value, { pure: e.pure, source: "skill" });
        break;
      }
      case "equip_armor": {
        if (!target) return "\u9700\u8981\u76EE\u6807";
        target.equipment = "armor";
        s.log.push(`\u{1F6E1} \u300C${target.name}\u300D\u88C5\u5907\u4E86\u62A4\u7532\uFF0C\u53D7\u5230\u7684\u975E\u771F\u5B9E\u4F24\u5BB3 -1`);
        break;
      }
      case "atk_buff": {
        if (!target) return "\u9700\u8981\u76EE\u6807";
        target.atk += e.value;
        s.log.push(`\u{1F4AA} \u300C${target.name}\u300D\u653B\u51FB\u529B +${e.value}\uFF08${target.atk}\uFF09`);
        break;
      }
      case "def_buff": {
        if (!target) return "\u9700\u8981\u76EE\u6807";
        target.laneVal += e.value;
        s.log.push(`\u{1F6E1} \u300C${target.name}\u300D\u9632\u5B88\u503C +${e.value}\uFF08${target.laneVal}\uFF09`);
        break;
      }
      case "draw": {
        drawItems(s, side, e.value);
        s.log.push(`\u{1F4D6} ${s.players[side].name} \u62BD\u4E86 ${e.value} \u5F20\u9053\u5177\u724C`);
        break;
      }
      case "move": {
        if (!target) return "\u9700\u8981\u76EE\u6807";
        if (!moveTo) return "\u9700\u8981\u9009\u62E9\u76EE\u6807\u4F4D\u7F6E";
        if (isBlockedCell(s, moveTo)) return "\u4E0D\u80FD\u79FB\u52A8\u5230\u706B\u5C71\u53E3";
        if (isCellOccupied(s, side, moveTo)) return "\u6BCF\u4E2A\u533A\u57DF\u53EA\u80FD\u653E\u7F6E\u4E00\u4E2A\u89D2\u8272";
        if (moveTo.row === target.pos.row && moveTo.col === target.pos.col) return "\u4F4D\u7F6E\u672A\u53D8\u5316";
        target.pos = moveTo;
        target.elevated = elevationFor(s.players[side].role, target.domain, moveTo);
        s.events.push({ t: "move", side, uid: target.uid, to: moveTo });
        s.log.push(
          `\u{1F4A8} \u300C${target.name}\u300D\u79FB\u52A8\u5230 ${moveTo.row === 0 ? "\u540E\u6392" : "\u524D\u6392"}\u7B2C ${moveTo.col + 1} \u5217${target.elevated ? "\uFF08\u9AD8\u5730\uFF1A\u9632\u5B88\u503C\u8F6C\u5929\u7A7A\uFF09" : ""}`
        );
        break;
      }
      case "weaken": {
        if (!target) return "\u9700\u8981\u76EE\u6807";
        const real = Math.min(e.value, target.atk);
        target.atk -= real;
        s.log.push(`\u{1F4C9} \u300C${target.name}\u300D\u653B\u51FB\u529B -${real}\uFF08${target.atk}\uFF09`);
        break;
      }
    }
  }
  return null;
}

// src/engine/actions.ts
function deployCostOf(def, deathCount, elevated) {
  let c = def.cost * (1 + 0.5 * deathCount);
  if (elevated) c *= 2;
  return Math.floor(c);
}
function isHighlandCell(role, pos) {
  return role === "defense" && pos.row === 0 && pos.col !== 1;
}
function elevationFor(role, domain, pos) {
  return domain === "ground" && isHighlandCell(role, pos);
}
function isBlockedCell(s, pos) {
  if (s.terrain !== "volcano") return false;
  const v = volcanoCell(0);
  return pos.row === v.row && pos.col === v.col;
}
function isCellOccupied(s, side, pos) {
  return s.players[side].field.some((c) => c.pos.row === pos.row && c.pos.col === pos.col);
}
function actorError(s, side) {
  if (s.winner !== null) return "\u5BF9\u5C40\u5DF2\u7ED3\u675F";
  if (s.active !== side) return "\u8FD8\u6CA1\u8F6E\u5230\u4F60";
  if (s.passed[side]) return "\u4F60\u5DF2\u5BA3\u544A\u7ED3\u675F";
  return null;
}
function flipActor(s) {
  const next = opponent(s.active);
  if (!s.passed[next]) s.active = next;
}
function deployChar(s, charDefs, side, handUid, pos) {
  const err = actorError(s, side);
  if (err) return err;
  const p = s.players[side];
  const hand = p.handChars.find((h) => h.uid === handUid);
  if (!hand) return "\u624B\u724C\u4E2D\u4E0D\u5B58\u5728\u8BE5\u89D2\u8272";
  if (hand.cooldown > 0) return `\u51B7\u5374\u4E2D\uFF0C\u8FD8\u9700 ${hand.cooldown} \u56DE\u5408`;
  const def = charDefs[hand.defId];
  if (!def) return "\u672A\u77E5\u89D2\u8272";
  if (isBlockedCell(s, pos)) return "\u706B\u5C71\u53E3\u4E0D\u80FD\u90E8\u7F72\u89D2\u8272";
  if (isCellOccupied(s, side, pos)) return "\u6BCF\u4E2A\u533A\u57DF\u53EA\u80FD\u653E\u7F6E\u4E00\u4E2A\u89D2\u8272";
  const elevated = elevationFor(p.role, def.domain, pos);
  const cost = deployCostOf(def, hand.deathCount, elevated);
  if (p.cost < cost) return `\u90E8\u7F72\u8D39\u7528\u4E0D\u8DB3\uFF08\u9700 ${cost}\uFF09`;
  p.cost -= cost;
  p.handChars = p.handChars.filter((h) => h.uid !== handUid);
  const fc = makeFieldChar(def, hand.uid, side, cost);
  fc.pos = pos;
  fc.elevated = elevated;
  p.field.push(fc);
  s.events.push({ t: "deploy", side, uid: fc.uid, pos });
  s.log.push(`\u2B07 ${p.name} \u90E8\u7F72\u300C${def.name}\u300D${elevated ? "\uFF08\u9AD8\u5730\uFF09" : ""}\uFF0C\u82B1\u8D39 ${cost} \u90E8\u7F72\u8D39`);
  flipActor(s);
  return null;
}
function undeployChar(s, side, uid) {
  const err = actorError(s, side);
  if (err) return err;
  const p = s.players[side];
  const c = findChar(s, side, uid);
  if (!c) return "\u573A\u4E0A\u4E0D\u5B58\u5728\u8BE5\u89D2\u8272";
  const refund = Math.floor(c.paidCost / 2);
  p.field = p.field.filter((x) => x.uid !== uid);
  p.cost += refund;
  p.handChars.push({ uid: c.uid, defId: c.defId, cooldown: 6, deathCount: 1 });
  if (c.equipment) {
    s.itemDeck.push({ uid: s.nextUid++, itemId: c.equipment });
    s.log.push(`\u267B \u88C5\u5907\u6D17\u56DE\u4E86\u516C\u5171\u724C\u5E93`);
  }
  s.events.push({ t: "undeploy", side, uid });
  s.log.push(`\u2B06 ${p.name} \u4E0B\u9635\u300C${c.name}\u300D\uFF0C\u8FD4\u8FD8 ${refund} \u90E8\u7F72\u8D39\uFF0C\u8FDB\u5165\u51B7\u5374`);
  flipActor(s);
  return null;
}
function useNormalAttack(s, side, uid, targetRef) {
  const err = actorError(s, side);
  if (err) return err;
  const attacker = findChar(s, side, uid);
  if (!attacker) return "\u573A\u4E0A\u4E0D\u5B58\u5728\u8BE5\u89D2\u8272";
  if (attacker.hp <= 0) return "\u8BE5\u89D2\u8272\u5DF2\u88AB\u51FB\u5012";
  if (attacker.skillUsed) return "\u8BE5\u89D2\u8272\u672C\u56DE\u5408\u5DF2\u4F7F\u7528\u8FC7\u6280\u80FD";
  const target = findChar(s, targetRef.side, targetRef.uid);
  if (!target || target.hp <= 0) return "\u76EE\u6807\u4E0D\u5B58\u5728";
  if (attacker.passive === "healer") {
    if (targetRef.side !== side) return "\u6CBB\u6108\u5E08\u53EA\u80FD\u6CBB\u7597\u6211\u65B9\u89D2\u8272";
  } else if (targetRef.side === side) {
    return "\u666E\u901A\u653B\u51FB\u53EA\u80FD\u6307\u5B9A\u654C\u65B9\u89D2\u8272";
  }
  attacker.skillUsed = true;
  resolveNormalAttack(s, attacker, target);
  flipActor(s);
  return null;
}
function useBurst(s, charDefs, side, uid, targetRef) {
  const err = actorError(s, side);
  if (err) return err;
  const c = findChar(s, side, uid);
  if (!c) return "\u573A\u4E0A\u4E0D\u5B58\u5728\u8BE5\u89D2\u8272";
  if (c.hp <= 0) return "\u8BE5\u89D2\u8272\u5DF2\u88AB\u51FB\u5012";
  if (c.skillUsed) return "\u8BE5\u89D2\u8272\u672C\u56DE\u5408\u5DF2\u4F7F\u7528\u8FC7\u6280\u80FD";
  if (c.sp < c.spMax) return `\u6280\u80FD\u70B9\u4E0D\u8DB3\uFF08${c.sp}/${c.spMax}\uFF09`;
  const def = charDefs[c.defId];
  if (!def) return "\u672A\u77E5\u89D2\u8272";
  const burst = def.burst;
  let target;
  if (burst.target === "one_enemy") {
    if (!targetRef) return "\u9700\u8981\u9009\u62E9\u4E00\u540D\u654C\u65B9\u89D2\u8272";
    target = findChar(s, targetRef.side, targetRef.uid);
    if (!target || target.hp <= 0 || targetRef.side === side) return "\u76EE\u6807\u5FC5\u987B\u662F\u654C\u65B9\u89D2\u8272";
  } else if (burst.target === "self" && targetRef) {
    target = findChar(s, targetRef.side, targetRef.uid);
  }
  c.skillUsed = true;
  c.sp = 0;
  s.events.push({ t: "burst", side, uid, name: burst.name });
  s.log.push(`\u{1F31F} ${s.players[side].name} \u7684\u300C${c.name}\u300D\u91CA\u653E\u5927\u62DB\u300C${burst.name}\u300D`);
  const foeSide = opponent(side);
  const value = burst.value ?? 0;
  switch (burst.target) {
    case "all_enemies": {
      for (const t of [...s.players[foeSide].field]) {
        s.events.push({ t: "attack", side, uid, targetUid: t.uid, heal: false, pure: burst.pure === true, amount: value });
        damageChar(s, t, value, { pure: burst.pure, source: "skill" }, c);
      }
      break;
    }
    case "all_allies": {
      for (const t of [...s.players[side].field]) healChar(s, t, value);
      break;
    }
    case "one_enemy": {
      if (target) {
        s.events.push({ t: "attack", side, uid, targetUid: target.uid, heal: false, pure: burst.pure === true, amount: value });
        damageChar(s, target, value, { pure: burst.pure, source: "skill" }, c);
      }
      break;
    }
    case "self": {
      if (burst.atkBuff) {
        c.atk += burst.atkBuff;
        s.log.push(`\u{1F4AA} \u300C${c.name}\u300D\u653B\u51FB\u529B +${burst.atkBuff}\uFF08${c.atk}\uFF09`);
      }
      if (burst.defBuff) {
        c.laneVal += burst.defBuff;
        s.log.push(`\u{1F6E1} \u300C${c.name}\u300D\u9632\u5B88\u503C +${burst.defBuff}\uFF08${c.laneVal}\uFF09`);
      }
      if (burst.value) {
        s.players[side].cost += burst.value;
        s.log.push(`\u{1F4B0} ${s.players[side].name} \u83B7\u5F97 ${burst.value} \u90E8\u7F72\u8D39`);
      }
      break;
    }
    case "none":
      break;
  }
  if (burst.addCopyToHand) {
    s.players[side].handChars.push({ uid: s.nextUid++, defId: c.defId, cooldown: 0, deathCount: 0 });
    s.log.push(`\u{1F465} \u4E00\u5F20\u65B0\u7684\u300C${c.name}\u300D\u52A0\u5165\u4E86\u624B\u724C`);
  }
  if (def.selfHeal && c.hp > 0) {
    const real = Math.min(def.selfHeal, c.maxHp - c.hp);
    if (real > 0) {
      c.hp += real;
      s.events.push({ t: "heal", side, uid, amount: real });
      s.log.push(`\u271A \u300C${c.name}\u300D\u56DE\u590D ${real} \u70B9\u751F\u547D\uFF08${c.hp}/${c.maxHp}\uFF09`);
    }
  }
  flipActor(s);
  return null;
}
function playItem(s, itemDefs, side, handUid, targetRef, moveTo) {
  const err = actorError(s, side);
  if (err) return err;
  const p = s.players[side];
  const idx = p.handItems.findIndex((h) => h.uid === handUid);
  if (idx < 0) return "\u624B\u724C\u4E2D\u4E0D\u5B58\u5728\u8BE5\u9053\u5177";
  const def = itemDefs[p.handItems[idx].itemId];
  if (!def) return "\u672A\u77E5\u9053\u5177";
  if (p.cost < def.cost) return `\u90E8\u7F72\u8D39\u7528\u4E0D\u8DB3\uFF08\u9700 ${def.cost}\uFF09`;
  let target;
  if (def.target !== "none") {
    if (!targetRef) return "\u9700\u8981\u9009\u62E9\u4E00\u4E2A\u76EE\u6807";
    target = findChar(s, targetRef.side, targetRef.uid);
    if (!target || target.hp <= 0) return "\u76EE\u6807\u4E0D\u5B58\u5728";
    if (def.target === "own_char" && targetRef.side !== side) return "\u5FC5\u987B\u6307\u5B9A\u6211\u65B9\u89D2\u8272";
    if (def.target === "enemy_char" && targetRef.side === side) return "\u5FC5\u987B\u6307\u5B9A\u654C\u65B9\u89D2\u8272";
  }
  p.cost -= def.cost;
  p.handItems.splice(idx, 1);
  s.events.push({ t: "item", side, itemId: def.id });
  s.log.push(`\u{1F0CF} ${p.name} \u4F7F\u7528\u9053\u5177\u300C${def.name}\u300D`);
  const err2 = applyItemEffects(s, itemDefs, side, def, target, moveTo);
  if (err2) {
    p.cost += def.cost;
    p.handItems.push({ uid: handUid, itemId: def.id });
    return err2;
  }
  if (def.recycle === "immediate") {
    s.itemDeck.push({ uid: s.nextUid++, itemId: def.id });
    s.log.push(`\u267B \u300C${def.name}\u300D\u6D17\u56DE\u4E86\u516C\u5171\u724C\u5E93`);
  }
  return null;
}
function passAction(s, charDefs, side) {
  const err = actorError(s, side);
  if (err) return err;
  s.passed[side] = true;
  s.log.push(`\u23ED ${s.players[side].name} \u5BA3\u544A\u7ED3\u675F\u56DE\u5408`);
  if (s.passed[0] && s.passed[1]) {
    endRoundSettlement(s, charDefs);
  } else {
    flipActor(s);
  }
  return null;
}
var ROUND_COST = COST_PER_ROUND;
export {
  ROUND_COST,
  deployChar,
  deployCostOf,
  elevationFor,
  isBlockedCell,
  isCellOccupied,
  isHighlandCell,
  passAction,
  playItem,
  undeployChar,
  useBurst,
  useNormalAttack
};
