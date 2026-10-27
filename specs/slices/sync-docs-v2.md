# Slice: sync-docs-v2

## 目的
同步 `docs/zelto-场景功能地图.md` 的数字和命令列表至代码当前状态。

## 背景
上一轮开发新增了以下内容：
- 新命令：`config`、`slice`、`policy show`
- 新 flag：`--json`（create/check/freeze/run/gate/sign）、`--active`（slices）、`--dry-run`（gate）、`--yes`（start）、`--with-examples`（init）
- 修复：`zelto help <cmd>` 路由
- 强化：`policy validate` 新增重叠/不可达/优先级冲突检测
- 完成 16 项 P0-P2 改进

## 范围
- `docs/zelto-场景功能地图.md` — 更新 §3.2 CLI 命令列表、附录 A 测试清单数字、附录 C 开发命令
- `docs/zelto-开工包.md` — 更新测试数字
- `docs/zelto-技术架构.md` — 更新测试数字

## 具体修改

### docs/zelto-场景功能地图.md
1. §3.2 CLI 命令：加入 `config`、`slice`、`policy show`、`help <cmd>`
2. §3.2 更新所有命令的 flag 信息
3. 附录 A：测试数 551→567, 套件 118→125
4. 附录 C：开发命令部分加入新命令

### docs/zelto-开工包.md
- 更新测试数字 544→567

### docs/zelto-技术架构.md
- 更新测试数字 551→567

## 验收标准
1. `docs/zelto-场景功能地图.md` 中 CLI 命令列表包含 config、slice、policy show
2. 文档中的测试数字与当前 `pnpm test:quick` 输出一致
3. 所有 flag 信息正确
4. 文档格式一致，无 Markdown 损坏

## 风险
- 低：只改 docs/，不改代码
- 注意保持 Markdown 表格对齐
