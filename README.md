# 卡牌对战（原型）

一个基于原创世界观的卡牌战斗桌游程序。当前是**可完整游玩的规则引擎 + 人机对战原型**：示例卡组驱动的 1v1 回合制卡牌对战，浏览器即玩。

> 世界观内容尚未写入 —— `data/cards.json` 里的卡牌均为标有【示例卡】的占位卡组，用于验证引擎。按下面的「添加你自己的卡牌」逐步替换即可，**全程不需要改任何代码**。

## 快速开始

```bash
npm install
npm run dev      # 开发服务器（默认 http://localhost:5173）
npm run build    # 类型检查 + 产出 dist/
```

## 在线游玩（GitHub Pages）

仓库已内置自动部署（`.github/workflows/deploy.yml`）：推送 `main` 后自动构建并发布。

首次启用：仓库 **Settings → Pages → Source 选择 GitHub Actions**，之后每次推送自动更新。

## 目录结构

```
data/cards.json        卡牌定义（数据驱动，加卡只改这里）
src/engine/types.ts    核心类型：卡牌定义 / 对局状态 / 效果
src/engine/state.ts    建局、回合推进、抽牌与疲劳
src/engine/actions.ts  玩家行动：出牌 / 攻击 / 结束回合（全部规则校验）
src/engine/effects.ts  效果结算器（伤害/治疗/增益/抽牌 × 多种目标）
src/engine/ai.ts       贪心 AI（斩杀 > 出牌 > 优势交换 > 打脸）
src/ui/                渲染与交互（纯展示层，不含规则）
docs/rules.md          完整规则说明书
docs/worldview.md      世界观与卡牌设计模板（等你的设定填进来）
```

## 架构原则

- **数据与引擎分离**：卡牌数值、效果、文本全部是 `data/cards.json` 里的数据；引擎只认通用效果原语（`damage / heal / buff / draw` × 目标选择器）。
- **规则校验集中在引擎**：UI 和 AI 调用同一套 `playCard / attack`，不可能绕过规则。
- **UI 可整体替换**：`src/ui` 只读状态做渲染，未来换成更精美的界面不影响规则。

## 添加你自己的卡牌

往 `data/cards.json` 加一条（示例）：

```json
{
  "id": "my_dragon",
  "name": "你的巨龙名字",
  "type": "creature",
  "cost": 6,
  "atk": 6,
  "hp": 7,
  "taunt": true,
  "battlecry": [{ "type": "damage", "target": "all_enemy_creatures", "value": 2 }],
  "text": "战吼：对所有敌方随从造成 2 点伤害。",
  "count": 1
}
```

可用效果原语：`damage / heal / buff / draw`；可用目标：`enemy_hero / own_hero / enemy_creature / own_creature / any_creature / any / all_enemy_creatures / all_own_creatures / random_enemy_creature`。`count` 是该卡在起始卡组中的张数（双方同构筑，各 30 张）。

扩展新原语（如「沉默」「召唤」）：在 `src/engine/effects.ts` 的 `EffectType` 与 `applyEffect` 各加一个分支即可。

## 路线图

- [ ] 世界观设定集与卡牌替换（进行中）
- [ ] 阵营/职业系统与多卡组构筑
- [ ] 更强 AI（场面评估 / 搜索）
- [ ] 动画与音效
- [ ] 联机对战

## 许可证

代码 MIT（见 LICENSE）。世界观文本与美术资源的授权由你决定后在此注明。
