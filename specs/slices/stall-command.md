# Slice: stall-command

## 目的
新增 `zelto stall` 命令，用于查看 stalled slices 的状态和详情，方便开发者了解哪些切片在 agent 执行中遇到了问题。

## 范围
- `src/cli/commands.ts` — 新增 stall 命令
- `src/core/stall/classifier.ts` — 可能需暴露辅助方法
- `tests/stall-command.test.ts` — 单元测试

## 验收标准
1. `zelto stall` 列出所有 stalled slices（判定条件: slice.stall.class !== null，包含 stall 分类、次数）
2. `zelto stall <id>` 查看单个 slice 的 stall 详情
3. `zelto stall --auto-resolved` 列出已自动解决的 stall
4. 没有 stalled slices 时显示空状态
5. 不存在的切片 ID 给出友好错误

## 风险
- 低风险：只读操作，不修改任何状态
