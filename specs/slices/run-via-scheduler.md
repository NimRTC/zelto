# Slice: run-via-scheduler

## 目的
让 `zelto run` 在执行前先通过 scheduler 做准入检查（写集冲突检测），打通约束强制执行闭环。

## 范围
- `src/cli/commands.ts` — `zelto run` 实现，执行前调用 `scheduler.admit()`
- `src/core/sched/engine.ts` — 可能补充缺失的接口

## 验收标准
1. `zelto run <id>` 先调 `scheduler.admit(id)`，blocked 时输出冲突信息并退出（不执行）
2. 准入通过时调 `scheduler.startRun()` 后再拉起 agent
3. 原有 `--dry-run` 逻辑不变
4. 现有测试全部通过

## 风险
- 中风险：修改了执行流程核心路径，需要确保不影响已有 start/run 流程
