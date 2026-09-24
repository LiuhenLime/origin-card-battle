// 道具牌效果结算。
import type { CellPos, FieldChar, GameState, ItemDef, Side } from "./types";
import { damageChar, healChar } from "./combat";
import { drawItems } from "./state";
import { elevationFor, isBlockedCell, isCellOccupied } from "./actions";

/**
 * 结算一张道具牌的效果。失败返回错误信息（调用方退还费用与手牌）。
 * target：需要目标的道具必填；moveTo：传送类道具的目的地。
 */
export function applyItemEffects(
  s: GameState,
  itemDefs: Record<string, ItemDef>,
  side: Side,
  def: ItemDef,
  target: FieldChar | undefined,
  moveTo?: CellPos,
): string | null {
  void itemDefs;
  for (const e of def.effects) {
    switch (e.kind) {
      case "heal": {
        if (!target) return "需要目标";
        healChar(s, target, e.value);
        break;
      }
      case "sp": {
        if (!target) return "需要目标";
        const real = Math.min(e.value, target.spMax - target.sp);
        if (real > 0) {
          target.sp += real;
          s.events.push({ t: "sp", side: target.owner, uid: target.uid, amount: real });
          s.log.push(`⚡ 「${target.name}」获得 ${real} 技能点（${target.sp}/${target.spMax}）`);
        }
        break;
      }
      case "damage": {
        if (!target) return "需要目标";
        damageChar(s, target, e.value, { pure: e.pure, source: "item" });
        break;
      }
      case "equip_armor": {
        if (!target) return "需要目标";
        target.equipment = "armor";
        s.log.push(`🛡 「${target.name}」装备了护甲，受到的非真实伤害 -1`);
        break;
      }
      case "atk_buff": {
        if (!target) return "需要目标";
        target.atk += e.value;
        s.log.push(`💪 「${target.name}」攻击力 +${e.value}（${target.atk}）`);
        break;
      }
      case "def_buff": {
        if (!target) return "需要目标";
        target.laneVal += e.value;
        s.log.push(`🛡 「${target.name}」防守值 +${e.value}（${target.laneVal}）`);
        break;
      }
      case "draw": {
        drawItems(s, side, e.value);
        s.log.push(`📖 ${s.players[side].name} 抽了 ${e.value} 张道具牌`);
        break;
      }
      case "move": {
        if (!target) return "需要目标";
        if (!moveTo) return "需要选择目标位置";
        if (isBlockedCell(s, moveTo)) return "不能移动到火山口";
        if (isCellOccupied(s, side, moveTo)) return "每个区域只能放置一个角色";
        if (moveTo.row === target.pos.row && moveTo.col === target.pos.col) return "位置未变化";
        target.pos = moveTo;
        target.elevated = elevationFor(s.players[side].role, target.domain, moveTo);
        s.events.push({ t: "move", side, uid: target.uid, to: moveTo });
        s.log.push(
          `💨 「${target.name}」移动到 ${moveTo.row === 0 ? "后排" : "前排"}第 ${moveTo.col + 1} 列${target.elevated ? "（高地：防守值转天空）" : ""}`,
        );
        break;
      }
      case "weaken": {
        if (!target) return "需要目标";
        const real = Math.min(e.value, target.atk);
        target.atk -= real;
        s.log.push(`📉 「${target.name}」攻击力 -${real}（${target.atk}）`);
        break;
      }
    }
  }
  return null;
}
