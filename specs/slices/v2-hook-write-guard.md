# Slice: v2-hook-write-guard

## 目的

验证现有写保护核心的全链路拦截能力：预约收集允许路径、逐写判定拦截越界、运行后 git 审计兜底。本片不改判定内核，只做只读验证与回归断言，证明预约→逐写判定→审计链路真实可用。

## 范围

要改的（这些是 agent 会去改的文件）：
- `tests/acceptance/v2-hook-write-guard/acceptance.test.cjs`

只读参考（**不得修改**，agent 只许读）：
- 只读 `src/hook/pretool.ts` —— 参考逐写判定的写入目标提取与判定顺序
- 只读 `src/core/policy/engine.ts` —— 参考策略判定口径
- 只读 `src/core/sched/audit.ts` —— 参考运行后审计的覆盖口径
- 只读 `src/cli/commands/runtime-guard.ts` —— 参考预约装配与审计上报流程

## 需求

无（本片验证已有能力，不新增需求；验收标准即本片出处）。

## 验收标准

1. 预约缺失时逐写判定默认拒绝：构造无预约的 PreTool 上下文，对写集外路径调用判定，返回 deny，且 ruleId 为 reservation:missing；验证方式：验收测试直接调用判定函数断言。
2. 写集外路径被逐写判定拒绝：构造有预约的上下文，对写集外路径调用判定，返回 deny，且目标落在写集外；验证方式：验收测试断言 decision 为 deny。
3. 写集内路径被逐写判定放行：对写集内路径调用判定，策略允许时返回 allow；验证方式：验收测试断言 decision 为 allow。
4. 运行后审计能识别越界改动：构造含越界改动的 worktree 状态，调用审计接口，violations 非空；验证方式：验收测试断言 violations 包含越界路径。

## 风险

- 判定内核已有实现，本片只读验证，不改内核行为；应对：验收测试只调用判定与审计接口，不修改被只读参考的源文件。
