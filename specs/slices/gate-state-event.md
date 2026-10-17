# Slice: gate-state-event

## 目的
为 gate 命令的 `GATE_PASS` 转换添加 `slice.state.changed` 事件发射，确保 `frozen → completed` 状态转换在事件流中有对应记录。

## 范围
- `src/cli/commands.ts` — gate 命令的 `GATE_PASS` 转换后添加 `events.append('slice.state.changed', ...)`
- `tests/acceptance/gate-state-event/` — 新增验收测试

## 验收标准
1. `zelto gate <id>` 在 gate 通过后，事件流中包含 `slice.state.changed` 事件
2. `slice.state.changed` 事件的 `from` 为 `"frozen"`，`to` 为 `"completed"`
3. `slice.state.changed` 事件的 `event` 为 `"GATE_PASS"`
4. 验收测试使用 `node --test` 运行，输出符合 TAP 格式
5. 验收测试使用独立的临时目录运行，不影响项目工作目录

## 不包含
- 其他命令的事件修复
- 修改事件流核心逻辑

## 风险
- 验收测试需要 `dist/cli/index.js` 已编译（依赖 `pnpm build`）
- gate 命令需要配置 gate commands 才能通过
