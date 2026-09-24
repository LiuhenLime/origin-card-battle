// 渲染层：把 GameState 与 UI 状态映射为 HTML。纯展示，不含规则；交互经 data-* 属性由 main.ts 路由。
import type { CellPos, CharDef, FieldChar, GameState, ItemDef, Side } from "../engine/types";
import { DIFFICULTY, RECYCLE_ITEM_GAIN, volcanoBlastCells } from "../engine/types";
import { effectiveAtk, laneTotals, previewHpLoss } from "../engine/combat";
import { deployCostOf, elevationFor, isBlockedCell, isCellOccupied } from "../engine/actions";
import { charArt, charThumb, itemArt } from "./art";

// ---------- UI 状态 ----------

export type UiMode =
  | { kind: "idle" }
  | { kind: "charMenu"; uid: number }
  | { kind: "deploy"; handUid: number }
  | { kind: "attack"; uid: number }
  | { kind: "burst"; uid: number }
  | { kind: "itemMenu"; handUid: number }
  | { kind: "item"; handUid: number }
  | { kind: "movePick"; handUid: number; targetUid: number };

export interface FxState {
  attackUid: number | null;
  hitUids: Set<number>;
  healUids: Set<number>;
  spUids: Set<number>;
  deployUid: number | null;
  breach: boolean;
}

export function emptyFx(): FxState {
  return { attackUid: null, hitUids: new Set(), healUids: new Set(), spUids: new Set(), deployUid: null, breach: false };
}

export interface UiState {
  mode: UiMode;
  fx: FxState;
  viewer: Side;
  logOpen: boolean;
  inspectUid: number | null;
}

/** 血条预演：目标若被当前指定行为命中，血条将如何变化 */
export interface HpPreview {
  kind: "dmg" | "heal";
  value: number;
  after: number;
}

// ---------- 开局设置屏 ----------

export interface SetupChoice {
  difficulty: "normal" | "hard";
  terrain: "plain" | "volcano";
}

export function renderSetup(sel: SetupChoice): string {
  const opt = (value: string, cur: string, label: string) =>
    `<button class="pill ${cur === value ? "on" : ""}" data-setup="${value}">${label}</button>`;
  return `
  <div class="screen setup">
    <h1>攻防对决</h1>
    <p class="sub">单机防守战 · 你执防守方，AI 执进攻方</p>
    <div class="setup-group">
      <h3>难度</h3>
      ${opt("normal", sel.difficulty, "标准（总生命10 · 守10回合）")}
      ${opt("hard", sel.difficulty, "艰难（总生命15 · 守15回合）")}
    </div>
    <div class="setup-group">
      <h3>地形</h3>
      ${opt("plain", sel.terrain, "平原")}
      ${opt("volcano", sel.terrain, "火山（火山口周边每回合受 6 点真实伤害）")}
    </div>
    <button id="to-draft" class="primary">选择角色 →</button>
    <button id="open-help-setup" class="ghost">玩法说明</button>
  </div>`;
}

// ---------- 选人屏 ----------

export interface DraftState {
  picks: string[];
  selected: string[];
}

export function renderDraft(
  ds: DraftState,
  charDefs: Record<string, CharDef>,
): string {
  const cards = Object.values(charDefs)
    .filter((d) => d.faction === "defense") // 单机：玩家只能选择防守方角色牌
    .map((d) => {
      const picked = ds.selected.includes(d.id);
      return `
      <div class="draft-card ${picked ? "picked" : ""}" data-draft="${d.id}">
        ${charArt(d)}
        <div class="draft-name">${d.name}</div>
        <div class="draft-tags">
          <span class="tag ${d.domain}">${d.domain === "sky" ? "天空" : "地面"}</span>
          <span class="tag">💰${d.cost}</span>
          <span class="tag">❤${d.hp}</span>
          <span class="tag">⚔${d.atk}</span>
          <span class="tag">${d.domain === "sky" ? "天防" : "地防"}${d.laneVal}</span>
        </div>
        <div class="draft-passive">✦ ${d.passiveText}</div>
      </div>`;
    })
    .join("");
  return `
  <div class="screen draft">
    <header class="draft-head">
      <h2>防守方 · 选择角色 <b class="${ds.selected.length === 8 ? "ok" : ""}">${ds.selected.length}/8</b></h2>
      <p class="sub">你将驻守高地，抵御 AI 进攻方</p>
    </header>
    <div class="draft-grid">${cards}</div>
    <footer class="draft-foot">
      <button id="draft-reset" class="ghost">重选</button>
      <button id="draft-confirm" class="primary" ${ds.selected.length === 8 ? "" : "disabled"}>确认出战 →</button>
    </footer>
  </div>`;
}

// ---------- 血条预演 ----------

/**
 * 计算当前指定行为下，每个可选目标血条的变化预演。
 * 普攻/大招/道具指向前，所有合法目标的血条都会闪烁显示预计变化。
 */
function computePreviews(
  s: GameState,
  ui: UiState,
  defs: Record<string, CharDef>,
  itemDefs: Record<string, ItemDef>,
): Map<number, HpPreview> {
  const map = new Map<number, HpPreview>();
  const m = ui.mode;
  const me = s.players[ui.viewer];
  const foeSide = (1 - ui.viewer) as Side;
  const foe = s.players[foeSide];
  const setDmg = (c: FieldChar, loss: number) => {
    if (loss > 0) map.set(c.uid, { kind: "dmg", value: loss, after: Math.max(0, c.hp - loss) });
  };
  const setHeal = (c: FieldChar, value: number) => {
    const real = Math.min(value, c.maxHp - c.hp);
    if (real > 0) map.set(c.uid, { kind: "heal", value: real, after: c.hp + real });
  };

  if (m.kind === "attack") {
    const a = me.field.find((c) => c.uid === m.uid);
    if (!a) return map;
    if (a.passive === "healer") {
      for (const t of me.field) setHeal(t, 8);
    } else {
      const atk = effectiveAtk(s, a);
      const hits = a.passive === "triple_head"
        ? [1, 1, 1].map(() => Math.max(1, atk))
        : [atk];
      for (const t of foe.field) setDmg(t, previewHpLoss(t, hits, false));
    }
  } else if (m.kind === "burst") {
    const c = me.field.find((x) => x.uid === m.uid);
    const burst = c ? defs[c.defId]?.burst : undefined;
    if (!burst) return map;
    if (burst.target === "all_enemies" || burst.target === "one_enemy") {
      for (const t of foe.field) setDmg(t, previewHpLoss(t, [burst.value ?? 0], burst.pure === true));
    } else if (burst.target === "all_allies") {
      for (const t of me.field) setHeal(t, burst.value ?? 0);
    }
  } else if (m.kind === "item") {
    const h = me.handItems.find((x) => x.uid === m.handUid);
    const def = h ? itemDefs[h.itemId] : undefined;
    if (!def) return map;
    for (const e of def.effects) {
      if (e.kind === "damage") {
        for (const t of foe.field) setDmg(t, previewHpLoss(t, [e.value], e.pure === true));
      } else if (e.kind === "heal") {
        for (const t of me.field) setHeal(t, e.value);
      }
    }
  }
  return map;
}

// ---------- 战斗屏 ----------

function chipHtml(
  c: FieldChar,
  ui: UiState,
  extraCls: string,
  ownerRole: "attack" | "defense",
  preview?: HpPreview,
): string {
  const fx = ui.fx;
  // 本回合还没普攻的角色绿底；已普攻（本回合只能放大招/下阵）红底
  const stateCls = c.hp <= 0 ? "" : c.attacked ? "chip-used" : "chip-ready";
  const cls = [
    "chip",
    stateCls,
    extraCls,
    fx.attackUid === c.uid ? "fx-attack" : "",
    fx.hitUids.has(c.uid) ? "fx-hit" : "",
    fx.healUids.has(c.uid) ? "fx-heal" : "",
    fx.spUids.has(c.uid) ? "fx-sp" : "",
    fx.deployUid === c.uid ? "fx-deploy" : "",
  ]
    .filter(Boolean)
    .join(" ");
  const hpPct = Math.max(0, Math.round((c.hp / c.maxHp) * 100));
  let previewSeg = "";
  let hpText = `${Math.max(0, c.hp)}/${c.maxHp}`;
  if (preview && preview.value > 0) {
    const fromPct = preview.kind === "dmg" ? Math.max(0, (preview.after / c.maxHp) * 100) : (c.hp / c.maxHp) * 100;
    const widthPct = (preview.value / c.maxHp) * 100;
    previewSeg = `<b class="hp-preview ${preview.kind}" style="left:${fromPct}%;width:${widthPct}%"></b>`;
    hpText = `${Math.max(0, c.hp)}→${preview.after}`;
  }
  const shieldHtml = c.shield > 0 ? ` <i class="badge shield">🐢${c.shield}</i>` : "";
  const orbs = Array.from({ length: c.spMax }, (_, i) => (i < c.sp ? "●" : "○")).join("");
  const laneTag = c.elevated || c.domain === "sky" ? "天" : "地";
  const isAttacker = ownerRole === "attack";
  const laneHtml = isAttacker
    ? `<span class="chip-atklane">${laneTag}攻${c.laneVal}</span>`
    : `<span class="chip-def">${laneTag}防${c.laneVal}</span>`;
  return `
  <div class="${cls}" data-uid="${c.uid}" data-side="${c.owner}" data-domain="${c.domain}">
    <div class="chip-art">${charThumb(c.defId, c.name)}</div>
    <div class="chip-body">
      <div class="chip-name">${c.name}${c.elevated ? ' <i class="badge elev">高地</i>' : ""}${c.equipment ? ' <i class="badge eq">🛡</i>' : ""}${shieldHtml}</div>
      <div class="chip-hp"><i style="width:${hpPct}%"></i>${previewSeg}<span>${hpText}</span></div>
      <div class="chip-row"><span class="chip-atk">⚔${c.atk}</span>${laneHtml}<span class="chip-orbs">${orbs}</span></div>
    </div>
  </div>`;
}

function cellHtml(
  s: GameState,
  ui: UiState,
  side: Side,
  pos: CellPos,
  defs: Record<string, CharDef>,
  previews: Map<number, HpPreview>,
): string {
  const classes = ["cell"];
  const defenderSide = (s.players[0].role === "defense" ? 0 : 1) as Side;
  const highland = side === defenderSide && pos.row === 0 && pos.col !== 1;
  if (highland) classes.push("highland");
  const blocked = isBlockedCell(s, pos);
  if (blocked) classes.push("volcano");
  else if (s.terrain === "volcano" && volcanoBlastCells(side).some((b) => b.row === pos.row && b.col === pos.col))
    classes.push("blast");
  const occupied = isCellOccupied(s, side, pos);
  if (occupied) classes.push("occupied");
  // 部署/移动目标格只标在己方区域
  const m = ui.mode;
  if ((m.kind === "deploy" || m.kind === "movePick") && side === ui.viewer && !blocked && !occupied) {
    classes.push("deployable", "cell-active");
    if (m.kind === "deploy") {
      const handUid = m.handUid;
      const p = s.players[ui.viewer];
      const hand = p.handChars.find((h) => h.uid === handUid);
      const def = hand ? defs[hand.defId] : undefined;
      if (hand && def) {
        const elevated = elevationFor(p.role, def.domain, pos);
        if (deployCostOf(def, hand.deathCount, elevated) > p.cost) classes.push("poor");
        if (elevated) classes.push("elev-cell");
      }
    }
  }
  const chars = s.players[side].field.filter((c) => c.pos.row === pos.row && c.pos.col === pos.col);
  const mode = ui.mode;
  const itemNeed = mode.kind === "item" ? itemTargetOf(mode.handUid) : null;
  // 普攻目标侧：疗养师治疗我方，其余攻击敌方
  const attacker = mode.kind === "attack" ? s.players[ui.viewer].field.find((c) => c.uid === mode.uid) : undefined;
  const attackTargetsOwn = attacker?.passive === "healer";
  const label = blocked
    ? `<span class="cell-tag volcano">火山口</span>`
    : highland
      ? `<span class="cell-tag">高地 ×2</span>`
      : classes.includes("blast")
        ? `<span class="cell-tag blast-tag">火山带</span>`
        : "";
  return `
  <div class="${classes.filter(Boolean).join(" ")}" data-row="${pos.row}" data-col="${pos.col}" data-zone="${side}">
    ${label}
    <div class="cell-chips">${chars.map((c) => {
      const selected =
        (mode.kind === "charMenu" && mode.uid === c.uid) ||
        ((mode.kind === "attack" || mode.kind === "burst") && mode.uid === c.uid);
      const targetable =
        (mode.kind === "attack" && (attackTargetsOwn ? c.owner === ui.viewer : c.owner !== ui.viewer)) ||
        (mode.kind === "burst" && c.owner !== ui.viewer) ||
        (mode.kind === "item" && (itemNeed === "own_char" ? c.owner === ui.viewer : c.owner !== ui.viewer)) ||
        (mode.kind === "movePick" && c.owner === ui.viewer);
      const cls = [selected ? "selected" : "", targetable ? "targetable" : ""].filter(Boolean).join(" ");
      return chipHtml(c, ui, cls, s.players[side].role, previews.get(c.uid));
    }).join("")}</div>
  </div>`;
}

// 由 main 注入的目标查询（避免把 itemDefs 传来传去）
let itemTargetLookup: (handUid: number) => "own_char" | "enemy_char" | "none" = () => "none";
export function setItemTargetLookup(fn: (handUid: number) => "own_char" | "enemy_char" | "none"): void {
  itemTargetLookup = fn;
}
function itemTargetOf(handUid: number): "own_char" | "enemy_char" | "none" {
  return itemTargetLookup(handUid);
}

function handHtml(s: GameState, ui: UiState, defs: Record<string, CharDef>, itemDefs: Record<string, ItemDef>): string {
  const p = s.players[ui.viewer];
  const myTurn = s.active === ui.viewer && s.winner === null && !s.passed[ui.viewer];
  const charCards = p.handChars
    .map((h) => {
      const def = defs[h.defId];
      if (!def) return "";
      const cooling = h.cooldown > 0;
      const cost = deployCostOf(def, h.deathCount, false);
      const poor = cost > p.cost;
      const sel = ui.mode.kind === "deploy" && ui.mode.handUid === h.uid;
      return `
      <div class="hand-card char-card ${cooling ? "cooling" : ""} ${poor && !cooling ? "poor" : ""} ${sel ? "selected" : ""}"
           data-hand-char="${h.uid}" title="${def.passiveText}">
        ${charArt(def)}
        <div class="hand-cost">💰${cost}</div>
        ${cooling ? `<div class="hand-cool">⏳冷却 ${h.cooldown}</div>` : ""}
        <div class="hand-name">${def.name}</div>
        <div class="hand-stats"><span class="${def.domain}">${def.domain === "sky" ? "天空" : "地面"}${def.faction === "attack" ? "攻" : "防"}${def.laneVal}</span> ❤${def.hp} ⚔${def.atk} ⚡${def.spMax}</div>
      </div>`;
    })
    .join("");
  const itemCards = p.handItems
    .map((h) => {
      const def = itemDefs[h.itemId];
      if (!def) return "";
      const poor = def.cost > p.cost;
      const sel = (ui.mode.kind === "item" || ui.mode.kind === "movePick") && ui.mode.handUid === h.uid;
      return `
      <div class="hand-card item-card ${poor ? "poor" : ""} ${sel ? "selected" : ""}" data-hand-item="${h.uid}" title="${def.text}">
        ${itemArt(def)}
        <div class="hand-cost">💰${def.cost}</div>
        <div class="hand-name">${def.name}</div>
        <div class="hand-stats">${def.text}</div>
      </div>`;
    })
    .join("");
  return `
  <div class="hand ${myTurn ? "" : "dim"}">${charCards}${itemCards}</div>`;
}

function controlsHtml(s: GameState, ui: UiState, defs: Record<string, CharDef>, itemDefs: Record<string, ItemDef>): string {
  const p = s.players[ui.viewer];
  const myTurn = s.active === ui.viewer && s.winner === null;
  if (!myTurn || s.passed[ui.viewer]) {
    return `<div class="controls"><span class="waiting">${s.winner ? "对局结束" : s.passed[ui.viewer] ? "已宣告结束，等待对方…" : "对方行动中…"}</span></div>`;
  }
  if (ui.mode.kind === "charMenu") {
    const selUid = ui.mode.uid;
    const c = s.players[ui.viewer].field.find((x) => x.uid === selUid);
    if (c) {
      const def = defs[c.defId];
      const canAtk = !c.attacked;
      const canBurst = !!def && c.sp >= c.spMax;
      const burstNeedsTarget = def?.burst.target === "one_enemy";
      const normalBtn = canAtk
        ? `<button class="act" data-act="normal">普通攻击${c.passive === "healer" ? "（治疗）" : ""}</button>`
        : `<button class="act" disabled title="每回合每位角色只能普通攻击一次">已普攻</button>`;
      const burstBtn = canBurst
        ? `<button class="act burst" data-act="burst">大招·${def!.burst.name}${burstNeedsTarget ? "（选目标）" : ""}</button>`
        : `<button class="act burst" disabled title="技能点未满">大招·${def!.burst.name}（${c.sp}/${c.spMax}）</button>`;
      const hint = !canAtk && !canBurst ? `<span class="hint used-hint">✓ 本回合已普通攻击，只能查看详情或下阵</span>` : "";
      return `
      <div class="controls menu">
        ${normalBtn}
        ${burstBtn}
        ${hint}
        <button class="act danger" data-act="undeploy">下阵（返 ⌊${Math.floor(c.paidCost / 2)}⌋）</button>
        <button class="act ghost" data-act="inspect">详情</button>
        <button class="act ghost" data-act="cancel">取消</button>
      </div>`;
    }
  }
  if (ui.mode.kind === "itemMenu") {
    const m = ui.mode;
    const h = p.handItems.find((x) => x.uid === m.handUid);
    const def = h ? itemDefs[h.itemId] : undefined;
    if (def) {
      const canUse = def.cost <= p.cost;
      const targetHint = def.target === "none" ? "" : def.effects.some((e) => e.kind === "move") ? "（选角色和位置）" : "（选目标）";
      return `
      <div class="controls menu">
        <button class="act" data-act="use-item" ${canUse ? "" : "disabled"} title="${def.text}">使用·${def.name}${targetHint}${canUse ? "" : `（需 ${def.cost}💰）`}</button>
        <button class="act" data-act="recycle-item">回收（+${RECYCLE_ITEM_GAIN}💰）</button>
        <button class="act ghost" data-act="cancel">取消</button>
      </div>`;
    }
  }
  if (ui.mode.kind === "deploy" || ui.mode.kind === "attack" || ui.mode.kind === "burst" || ui.mode.kind === "item" || ui.mode.kind === "movePick") {
    const itemHint =
      ui.mode.kind === "item"
        ? `选择目标使用「${handItemName(s, ui.viewer, ui.mode.handUid, itemDefs)}」`
        : "";
    const hints: Record<string, string> = {
      deploy: "点击格子上阵（高地双倍费用）",
      attack: "点击目标进行攻击（血条会预演变化）",
      burst: "点击敌方角色释放大招（血条会预演变化）",
      item: itemHint,
      movePick: "点击要移动的我方角色",
    };
    return `<div class="controls"><span class="hint">${hints[ui.mode.kind]}</span><button class="act ghost" data-act="cancel">取消</button></div>`;
  }
  return `<div class="controls"><button id="btn-pass" class="primary">结束回合</button></div>`;
}

function handItemName(s: GameState, side: Side, uid: number, itemDefs: Record<string, ItemDef>): string {
  const h = s.players[side].handItems.find((x) => x.uid === uid);
  return h ? itemDefs[h.itemId]?.name ?? "" : "";
}

function laneStrip(s: GameState): string {
  const atkSide = (s.players[0].role === "attack" ? 0 : 1) as Side;
  const defSide = (1 - atkSide) as Side;
  const atk = laneTotals(s, atkSide);
  const def = laneTotals(s, defSide);
  const ghostBreach = s.players[atkSide].field.some((c) => c.passive === "nightmare" && c.hp > 0);
  const gBreach = atk.ground > def.ground;
  const sBreach = atk.sky > def.sky || ghostBreach;
  const verdict = gBreach || sBreach
    ? gBreach && sBreach ? "双线告破" : gBreach ? "地面告破" : ghostBreach ? "👻天空失守" : "天空告破"
    : "防线稳固";
  const ghostNote = ghostBreach ? `<span class="lane ghost-note" title="暗影幽灵在场：天空防线视为失守，结算时额外扣 1 点总生命">👻-1</span>` : "";
  return `
  <div class="lane-strip">
    <span class="lane ${gBreach ? "breach" : ""}">地 ${atk.ground} : ${def.ground}</span>
    <span class="lane ${sBreach ? "breach" : ""}">天 ${atk.sky} : ${def.sky}</span>
    ${ghostNote}
    <span class="verdict ${gBreach || sBreach ? "bad" : "good"}">${verdict}</span>
  </div>`;
}

function zoneInfoHtml(s: GameState, side: Side): string {
  const p = s.players[side];
  const role = p.role === "attack" ? "⚔ 进攻方" : "🛡 防守方";
  const hpBar =
    p.role === "defense"
      ? `<div class="total-hp" data-totalhp="${side}"><div class="total-hp-bar"><i style="width:${Math.max(0, (p.totalHp / p.totalHpMax) * 100)}%"></i></div><span>🏰 ${Math.max(0, p.totalHp)}/${p.totalHpMax}</span></div>`
      : "";
  return `
  <div class="zone-info">
    <span class="pname ${p.role}">${p.name} · ${role}</span>
    <span class="meta">💰 ${p.cost}</span>
    <span class="meta">✋ ${p.handChars.length + p.handItems.length}</span>
    <span class="meta">🗃 ${s.itemDeck.length}</span>
    ${hpBar}
  </div>`;
}

export function renderBattle(
  s: GameState,
  ui: UiState,
  defs: Record<string, CharDef>,
  itemDefs: Record<string, ItemDef>,
): string {
  const diff = DIFFICULTY[s.difficulty];
  const previews = computePreviews(s, ui, defs, itemDefs);
  // 底方（玩家）区域：前排（靠近中线的大 row）渲染在上；进攻方 3×3，防守方 2×3
  const rowsFor = (side: Side): CellPos[] => {
    const rows = s.players[side].role === "attack" ? 3 : 2;
    const ordered: CellPos[] = [];
    for (let r = rows - 1; r >= 0; r--) {
      for (let c = 0; c < 3; c++) ordered.push({ row: r as 0 | 1 | 2, col: c as 0 | 1 | 2 });
    }
    return ordered;
  };
  const grid = (side: Side) =>
    `<div class="grid" data-zone="${side}">${rowsFor(side).map((pos) => cellHtml(s, ui, side, pos, defs, previews)).join("")}</div>`;

  const inspectChar =
    ui.inspectUid !== null
      ? [...s.players[0].field, ...s.players[1].field].find((c) => c.uid === ui.inspectUid)
      : undefined;
  const inspect = inspectChar
    ? `<div class="inspect" data-inspect-panel>
        <button class="inspect-close" data-act="close-inspect">✕</button>
        ${(() => {
          const def = defs[inspectChar.defId]!;
          const lane = inspectChar.elevated ? "天空（高地转化）" : inspectChar.domain === "sky" ? "天空" : "地面";
          const tier = def.tier ? ` · ${["一", "二", "三"][def.tier - 1]}级` : "";
          return `<h3>${inspectChar.name} <small>${def.title}${tier}</small></h3>
          <p>生命 ${inspectChar.hp}/${inspectChar.maxHp} · 攻击 ${inspectChar.atk} · 技能点 ${inspectChar.sp}/${inspectChar.spMax}${inspectChar.shield > 0 ? ` · 护盾 ${inspectChar.shield}` : ""}</p>
          <p>${lane}${s.players[inspectChar.owner].role === "attack" ? "进攻值 " : "防守值 "}${inspectChar.laneVal}${inspectChar.elevated ? "（计入天空防守）" : ""}</p>
          <p>被动 ✦ ${inspectChar.passiveText}</p>
          <p>大招 🌟 ${def.burst.name}：${def.burst.text}</p>
          <p>${inspectChar.attacked ? "本回合已普通攻击" : "本回合尚未普通攻击"}${inspectChar.equipment ? " · 已装备 🛡 防御胸甲" : ""}</p>`;
        })()}
      </div>`
    : "";

  const winnerOverlay = s.winner
    ? `<div class="overlay"><div class="overlay-box">
        <div class="overlay-title">${winTitle(s, ui.viewer)}</div>
        <p class="overlay-reason">${s.winner.reason}</p>
        <button id="btn-again" class="primary">再来一局</button>
      </div></div>`
    : "";

  const logLines = s.log.slice(-60).reverse().map((l) => `<div class="log-line">${l}</div>`).join("");

  return `
  <div class="app">
    <header class="topbar">
      <span class="round-chip">第 ${s.round}/${diff.rounds} 回合</span>
      ${laneStrip(s)}
      <button id="btn-help" class="icon-btn">玩法</button>
      <button id="btn-log" class="icon-btn">战报</button>
    </header>
    <main class="battlefield">
      <section class="zone enemy">${zoneInfoHtml(s, 1)}${grid(1)}</section>
      <div class="midline"><span>⚔</span></div>
      <section class="zone mine">${zoneInfoHtml(s, 0)}${grid(0)}</section>
    </main>
    <section class="dock">
      ${controlsHtml(s, ui, defs, itemDefs)}
      ${handHtml(s, ui, defs, itemDefs)}
    </section>
    ${inspect}
    <aside class="log ${ui.logOpen ? "open" : ""}">
      <div class="log-head">战报 <button class="inspect-close" data-act="close-log">✕</button></div>
      <div class="log-body">${logLines}</div>
    </aside>
    ${winnerOverlay}
  </div>`;
}

function winTitle(s: GameState, viewer: Side): string {
  if (s.winner!.side === "defense") {
    return s.players[viewer].role === "defense" ? "🏆 防守成功！" : "💀 进攻失败";
  }
  if (s.winner!.side === viewer) {
    return s.players[viewer].role === "attack" ? "🏆 防线告破，胜利！" : "🏆 防守成功！";
  }
  return s.players[viewer].role === "attack" ? "💀 进攻失败" : "💀 防线告破";
}

export function helpContent(): string {
  return `
  <h2>玩法说明</h2>
  <div class="help-body">
    <h3>🎯 模式与胜利条件</h3>
    <p><b>单机防守战</b>：你执防守方，AI 执进攻方。<br><b>防守方（你）</b>：守住总生命（标准 10 / 艰难 15），完整撑过 10 / 15 个回合即获胜。<br><b>进攻方（AI）</b>：把你的总生命扣到 0。</p>
    <h3>🔄 回合流程</h3>
    <p>每回合开始双方各获得 20 部署费用（可累计）。防守方先行动，双方轮流：行动方可<b>不限次数</b>使用道具牌，然后选择其一执行（执行后换对方行动）——上阵一个角色 / 下阵一个角色（视为死亡进冷却，返还一半部署费）/ 使用一个角色的<b>普通攻击</b>或<b>大招</b> / 结束回合。<br>普通攻击每位角色每回合只能使用一次；<b>大招不受次数限制</b>，只要技能点满且轮到我方行动就能释放。双方都结束后结算：各抽 2 张道具牌 → 全场角色 +2 技能点 → 地形伤害 → 攻防比对。</p>
    <h3>⚔ 攻防比对</h3>
    <p>统计进攻方地面/天空进攻值与防守方地面/天空防守值。任一线<b>进攻 &gt; 防守</b>即被突破：扣除两线差值之和的总生命。暗影幽灵在场上时，天空防线被视为失守并额外扣除 1 点总生命。</p>
    <h3>🗺 站位</h3>
    <p><b>防守方 2×3 共 6 格，进攻方 3×3 共 9 格</b>，每个区域只能放置一个角色。防守方拥有 2 个高地（后排两角）与 4 个地面区域：天空角色可放任意区域；地面角色放地面区域提供地面防守，也可花<b>双倍部署费</b>上高地转为天空防守。进攻方无高地概念，部署永不翻倍。火山地形下双方后排中间为火山口（不可部署），其上/左/右区域的角色每回合结束受 6 点真实伤害。</p>
    <h3>🧙 角色与阵营</h3>
    <p>角色牌分阵营专属：<b>防守方角色牌</b>（玩家选 8 张）仅显示地面/天空<b>防守值</b>；<b>进攻方角色牌</b>（AI 随机 8 种、每种 2 张，同名角色可分两次部署并存于场上）仅显示地面/天空<b>进攻值</b>，并分一级/二级/三级——<b>场上三级进攻方角色 ≤ 2，二级 ≤ 4，一级不限</b>。<br>共同属性：部署费、生命、攻击、技能点上限。<br>技能一（普通攻击）：按攻击力伤害敌方角色（疗养师被动改为治疗我方 8 点），不耗技能点。<br>技能二（大招）：技能点满才能释放，释放后清空，不限次数。<br>被动：每角色一个，自动生效。</p>
    <h3>⚡ 技能点</h3>
    <p>每回合结束全场角色 +2；角色每攻击或治疗一次 +1。</p>
    <h3>☠ 死亡与冷却</h3>
    <p>角色死亡后冷却 4 个完整回合回到手牌；再次上阵费用 = 原费用 ×(1 + 0.5×死亡次数)，<b>最高不超过原费用的两倍</b>。</p>
    <h3>🃏 道具牌</h3>
    <p>公共牌库首回合各抽 5 张、每回合结束各抽 2 张。使用消耗部署费用，每回合不限次数；点击手牌道具可「使用」或「回收」——<b>回收将道具洗回公共牌库并立即获得 3 点部署费用</b>（不消耗行动权）。用后的洗回方式依牌面说明。</p>
    <h3>💡 提示</h3>
    <p>点击场上角色查看详情；点击我方角色打开行动菜单；点击手牌角色进入部署，点击手牌道具选择目标。<b>指定攻击/治疗/大招/道具目标时，所有可选对象的血条会闪烁预演</b>即将发生的变化（含减伤结算后的真实损失）。真实伤害无视被动、减伤、装备与护盾。</p>
  </div>`;
}
