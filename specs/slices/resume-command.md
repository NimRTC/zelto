# Slice: resume-command

## 目的
新增 `zelto resume <id>` 命令，用于从 stalled 状态恢复 agent 执行，支持重新拉起 agent 或跳过 stall。

## 范围
- `src/cli/commands.ts` — 新增 resume 命令
- `src/core/sched/engine.ts` — 需暴露 resume 方法
- `tests/resume-command.test.ts` — 单元测试

## 验收标准
1. `zelto resume <id>` 对 stalled slice 重新拉起 agent（发射 run.resumed 事件）
2. `zelto resume <id> --skip` 标记 stall 为已解决但不重新执行
3. `zelto resume <id> --abandon` 将 slice 标记为 abandoned
4. 对 stall 字段为空的 slice 拒绝操作（slice.stall.class === null）
5. 不存在的切片 ID 给出友好错误

## 事件
- `run.resumed` — 事件 payload 包含 `resolution: 'manual_retry' | 'manual_skip' | 'manual_abandon'`

## 风险
- 中风险：修改 slice 状态和启动 agent 执行
