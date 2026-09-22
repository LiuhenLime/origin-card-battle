// 渲染层：把 GameState 与 UI 状态映射为 HTML。纯展示，不含规则；交互经 data-* 属性由 main.ts 路由。
import type { CellPos, CharDef, FieldChar, GameState, ItemDef, Side } from "../engine/types";
import { DIFFICULTY, volcanoBlastCells } from "../engine/types";
import { laneTotals } from "../engine/combat";
import { deployCostOf, elevationFor, isBlockedCell, isCellOccupied } from "../engine/actions";
import { charArt, charThumb, itemArt } from "./art";

// ---------- UI 状态 ----------

export type UiMode =
  | { kind: "idle" }
  | { kind: "charMenu"; uid: number }
  | { kind: "deploy"; handUid: number }
  | { kind: "attack"; uid: number }
  | { kind: "burst"; uid: number }
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
          <span class="tag">${d.domain === "sky" ? "天" : "地"}${d.atkVal}/${d.defVal}</span>
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

// ---------- 战斗屏 ----------

function posKey(pos: CellPos): string {
  return `${pos.row}-${pos.col}`;
}

function chipHtml(
  c: FieldChar,
  ui: UiState,
  extraCls: string,
): string {
  const fx = ui.fx;
  // 本回合还能行动的角色绿底；已用过技能（无法行动）红底
  const stateCls = c.hp <= 0 ? "" : c.skillUsed ? "chip-used" : "chip-ready";
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
  const orbs = Array.from({ length: c.spMax }, (_, i) => (i < c.sp ? "●" : "○")).join("");
  const laneTag = c.elevated || c.domain === "sky" ? "天" : "地";
  return `
  <div class="${cls}" data-uid="${c.uid}" data-side="${c.owner}" data-domain="${c.domain}">
    <div class="chip-art">${charThumb(c.defId, c.name)}</div>
    <div class="chip-body">
      <div class="chip-name">${c.name}${c.elevated ? ' <i class="badge elev">高地</i>' : ""}${c.equipment ? ' <i class="badge eq">🛡</i>' : ""}</div>
      <div class="chip-hp"><i style="width:${hpPct}%"></i><span>${Math.max(0, c.hp)}/${c.maxHp}</span></div>
      <div class="chip-row"><span class="chip-atk">⚔${c.atk}</span><span class="chip-def">${laneTag}${c.defVal}</span><span class="chip-orbs">${orbs}</span></div>
    </div>
  </div>`;
}

function cellHtml(
  s: GameState,
  ui: UiState,
  side: Side,
  pos: CellPos,
  defs: Record<string, CharDef>,
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
        ((mode.kind === "attack" || mode.kind === "burst") && c.owner !== ui.viewer) ||
        (mode.kind === "item" && (itemNeed === "own_char" ? c.owner === ui.viewer : c.owner !== ui.viewer)) ||
        (mode.kind === "movePick" && c.owner === ui.viewer);
      const cls = [selected ? "selected" : "", targetable ? "targetable" : ""].filter(Boolean).join(" ");
      return chipHtml(c, ui, cls);
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
        <div class="hand-stats"><span class="${def.domain}">${def.domain === "sky" ? "天空" : "地面"} ${def.atkVal}/${def.defVal}</span> ❤${def.hp} ⚔${def.atk} ⚡${def.spMax}</div>
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
      const canAct = !c.skillUsed;
      const canBurst = canAct && c.sp >= c.spMax && def;
      const burstNeedsTarget = def?.burst.target === "one_enemy";
      const actionButtons = canAct
        ? `
        <button class="act" data-act="normal">普通攻击${c.passive === "healer" ? "（治疗）" : ""}</button>
        <button class="act burst" data-act="burst" ${canBurst ? "" : "disabled"}>大招·${def!.burst.name}${burstNeedsTarget ? "（选目标）" : ""}</button>`
        : `<span class="hint used-hint">✓ 本回合已使用过技能，只能查看详情或下阵</span>`;
      return `
      <div class="controls menu">
        ${actionButtons}
        <button class="act danger" data-act="undeploy">下阵（返 ⌊${Math.floor(c.paidCost / 2)}⌋）</button>
        <button class="act ghost" data-act="inspect">详情</button>
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
      attack: "点击敌方角色进行攻击",
      burst: "点击敌方角色释放大招",
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
  const atk = laneTotals(s, atkSide);
  const def = laneTotals(s, (1 - atkSide) as Side);
  const gBreach = atk.ground > def.ground;
  const sBreach = atk.sky > def.sky;
  const verdict = gBreach || sBreach ? (gBreach && sBreach ? "双线告破" : gBreach ? "地面告破" : "天空告破") : "防线稳固";
  return `
  <div class="lane-strip">
    <span class="lane ${gBreach ? "breach" : ""}">地 ${atk.ground} : ${def.ground}</span>
    <span class="lane ${sBreach ? "breach" : ""}">天 ${atk.sky} : ${def.sky}</span>
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
  // 底方（玩家）区域：前排（row 1，靠近中线）渲染在上，后排（row 0）在下
  const rowsFor = (side: Side): CellPos[] =>
    side === 1
      ? [ { row: 0, col: 0 }, { row: 0, col: 1 }, { row: 0, col: 2 }, { row: 1, col: 0 }, { row: 1, col: 1 }, { row: 1, col: 2 } ]
      : [ { row: 1, col: 0 }, { row: 1, col: 1 }, { row: 1, col: 2 }, { row: 0, col: 0 }, { row: 0, col: 1 }, { row: 0, col: 2 } ];
  const grid = (side: Side) =>
    `<div class="grid" data-zone="${side}">${rowsFor(side).map((pos) => cellHtml(s, ui, side, pos, defs)).join("")}</div>`;

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
          return `<h3>${inspectChar.name} <small>${def.title}</small></h3>
          <p>生命 ${inspectChar.hp}/${inspectChar.maxHp} · 攻击 ${inspectChar.atk} · 技能点 ${inspectChar.sp}/${inspectChar.spMax}</p>
          <p>${lane}进攻 ${inspectChar.atkVal} / 防守 ${inspectChar.defVal}${inspectChar.elevated ? "（计入天空防守）" : ""}</p>
          <p>被动 ✦ ${inspectChar.passiveText}</p>
          <p>大招 🌟 ${def.burst.name}：${def.burst.text}</p>
          <p>${inspectChar.skillUsed ? "本回合已使用技能" : "本回合尚未使用技能"}${inspectChar.equipment ? " · 已装备 🛡 防御胸甲" : ""}</p>`;
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
    <p>每回合双方各获得 15 部署费用（可累计）。防守方（你）先行动，双方轮流：可先不限次使用道具牌，再选择其一——上阵角色 / 下阵角色（视为死亡进冷却，返还一半部署费）/ 使用角色技能 / 结束回合。双方都结束后结算：各抽 2 张道具牌 → 全场角色 +2 技能点 → 地形伤害 → 攻防比对。</p>
    <h3>⚔ 攻防比对</h3>
    <p>统计进攻方地面/天空进攻值与防守方地面/天空防守值。任一线<b>进攻 &gt; 防守</b>即被突破：扣除两线差值之和的总生命；两线都守住则无伤。</p>
    <h3>🗺 站位</h3>
    <p>每方 2×3 共 6 个区域，<b>每个区域只能放置一个角色</b>。防守方拥有 2 个高地（后排两角）与 4 个地面区域：天空角色可放任意区域；地面角色放地面区域提供地面防守，也可花<b>双倍部署费</b>上高地转为天空防守。进攻方无高地概念，部署永不翻倍。火山地形下双方后排中间为火山口（不可部署），其上/左/右区域的角色每回合结束受 6 点真实伤害。</p>
    <h3>🧙 角色</h3>
    <p>属性：部署费、生命、攻击、技能点上限、地面或天空的进攻/防守值。<br>技能一（普通攻击）：按攻击力伤害敌方角色（治愈师被动改为治疗我方），不耗技能点。<br>技能二（大招）：技能点满才能释放，释放后清空。<br>被动：每角色一个，自动生效。</p>
    <h3>⚡ 技能点</h3>
    <p>每回合结束全场角色 +2；角色每攻击或治疗一次 +1。每回合每角色只能使用普攻或大招其一（刚上场的角色当回合也可用一次）。</p>
    <h3>☠ 死亡与冷却</h3>
    <p>角色死亡后冷却 5 个完整回合回到手牌；再次上阵费用 = 原费用 ×(1 + 0.5×死亡次数)。</p>
    <h3>🃏 道具牌</h3>
    <p>公共牌库共 80 张，首回合各抽 5 张、每回合结束各抽 2 张。使用消耗部署费用，每回合不限次数；用后是否洗回依牌面说明。</p>
    <h3>💡 提示</h3>
    <p>点击场上角色查看详情；点击我方角色打开行动菜单；点击手牌角色进入部署，点击手牌道具选择目标。真实伤害无视被动、减伤与装备。</p>
  </div>`;
}
