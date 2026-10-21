# Slice: event-emission

## 目的
补齐 3 个容易发射但尚未发射的关键事件类型：`spec.frozen`、`spec.checked`、`slice.drift_detected`。

## 范围
- `src/cli/commands.ts` — 在 freeze/check/start 命令中添加对应事件发射

## 验收标准
1. `zelto freeze <id>` 时发射 `spec.frozen` 事件
2. `zelto check <id>` 时发射 `spec.checked` 事件
3. `zelto check <id>` 检测到 drift 时发射 `slice.drift_detected` 事件
4. `zelto start <id>` 中自动 freeze 时也发射 `spec.frozen` 事件
5. 已有测试全部通过（204+）
6. 新增 3+ 测试验证事件被正确记录

## 不包含
- `policy.decision` — 属于 hook 集成
- `stall.classified` — 属于 stall 检测特征
- `run.resumed/stalled` — resume/stall 功能未实现
- `budget.spent/llm.called/queue.*/merge.*` — 对应功能未实现
