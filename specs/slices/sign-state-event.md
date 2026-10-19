# Slice: sign-state-event

## 目的
为 sign 命令的 `SIGN_APPROVE` 和 `SIGN_REJECT` 转换添加 `slice.state.changed` 事件发射，确保状态转换在事件流中有对应记录。

## 范围
- `src/core/gate/sign.ts` — `approve()` 和 `reject()` 的 `store.transit()` 后添加 `events.append('slice.state.changed', ...)`
- `tests/acceptance/sign-state-event/` — 新增验收测试

## 验收标准
1. `zelto sign <id> --approve` 后，事件流中包含 `slice.state.changed` 事件
2. `SIGN_APPROVE` 事件的 `from` 为 `"completed"`，`to` 为 `"completed"`，`event` 为 `"SIGN_APPROVE"`
3. `zelto sign <id> --reject` 后，事件流中包含 `slice.state.changed` 事件
4. `SIGN_REJECT` 事件的 `from` 为 `"completed"`，`to` 为 `"abandoned"`，`event` 为 `"SIGN_REJECT"`
5. 验收测试使用 `node --test` 运行，输出符合 TAP 格式
6. 验收测试使用独立的临时目录运行，不影响项目工作目录

## 不包含
- 修改 sign 命令的行为逻辑
- 修改事件流核心逻辑
- 交互模式测试（使用 `--approve` 和 `--reject` 标志）

## 风险
- 验收测试需要 `dist/cli/index.js` 已编译（依赖 `pnpm build`）
- sign 命令依赖 gate 先通过以创建 sign request
