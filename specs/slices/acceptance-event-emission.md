# Slice: acceptance-event-emission

## 目的
为已完成的 `event-emission` 切片编写端到端验收测试，验证 `freeze`、`check`、`start` 命令正确发射对应事件到事件流。

## 范围
- `tests/acceptance/event-emission/` — 新建验收测试脚本

## 验收标准
1. 验收测试创建切片后执行 `zelto freeze <id>`，验证事件流中写入 `spec.frozen` 事件
2. 验收测试创建并冻结切片后执行 `zelto check <id>`，验证事件流中写入 `spec.checked` 事件
3. 验收测试修改已冻结切片的 spec 文件后执行 `zelto check <id>`，验证事件流中写入 `slice.drift_detected` 事件
4. 验收测试使用 `zelto start <id>` 自动 freeze，验证事件流中写入 `spec.frozen` 事件
5. 验收测试使用 `node --test` 运行，输出符合 TAP 格式
6. 验收测试使用独立的临时目录运行，不影响项目工作目录

## 不包含
- 其他命令（gate、clarify 等）的事件发射
- 修改任何已存在的源文件或测试文件

## 风险
- 验收测试需要 `dist/cli/index.js` 已编译（依赖 `pnpm build`）
- 事件流写入 `.zelto/events/<sliceId>/events.jsonl`，测试需读取该文件验证
