# Slice: clarify-state-event

## 目的
为 clarify 命令的中间状态转换（`CLARIFY_START` 和 `CLARIFY_CONVERGED`）添加 `slice.state.changed` 事件发射，确保 `draft → clarifying` 和 `clarifying → draft` 转换在事件流中有对应记录。

## 范围
- `src/cli/commands.ts` — clarify 命令的 `CLARIFY_START` 和 `CLARIFY_CONVERGED` 转换后添加 `events.append('slice.state.changed', ...)`
- `tests/acceptance/clarify-state-event/` — 新增验收测试

## 验收标准
1. `zelto clarify <id>` 从 draft 开始时，事件流中包含 `slice.state.changed` 事件（`from: "draft"`, `to: "clarifying"`）
2. `zelto clarify <id> --auto` 收敛后，事件流中包含 `slice.state.changed` 事件（`from: "clarifying"`, `to: "draft"`）
3. 两个事件的 `event` 字段分别为 `"CLARIFY_START"` 和 `"CLARIFY_CONVERGED"`
4. 验收测试使用 `node --test` 运行，输出符合 TAP 格式
5. 验收测试使用独立的临时目录运行，不影响项目工作目录

## 不包含
- 交互模式（`--auto` 已经覆盖两种状态转换）
- 修改 clarify 命令的行为逻辑

## 风险
- 验收测试需要 `dist/cli/index.js` 已编译（依赖 `pnpm build`）
