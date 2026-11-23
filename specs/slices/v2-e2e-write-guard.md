# Slice: v2-e2e-write-guard

## 目的

提供无模型的越界被拦端到端用例：基于现有 hook 写保护实现跑通预约→逐写判定→git 审计兜底链路，断言越界写入被拦截、审计报告标记异常，非越界写入正常通过。

## 范围

要改的（这些是 agent 会去改的文件）：
- `tests/guard-deny-e2e.test.ts`
- `tests/acceptance/v2-e2e-write-guard/acceptance.test.cjs`

只读参考（**不得修改**，agent 只许读）：
- 只读 `src/hook/pretool.ts` —— 供测试调用现有写保护入口并构造拒绝/放行断言
- 只读 `src/core/sched/audit.ts` —— 供测试调用审计接口验证兜底
- 只读 `contracts/schemas/hook-io.json` —— 协议输入按该契约构造，覆盖三 harness 信封

## 需求

无（本片为验证型用例，不新增产品需求；验收标准即本片出处）。

## 验收标准

1. 越界写入被逐写判定拒绝：用 `contracts/schemas/hook-io.json` 构造三 harness 信封输入，对未预约路径判定，断言 decision 为 deny；验证方式：运行 `tests/guard-deny-e2e.test.ts` 对应断言通过。
2. git 真实改动的审计兜底非空：对含越界改动的 worktree 调用审计，断言 violations 非空且含越界路径；验证方式：同一测试文件中断言通过。
3. 审计结论落盘为 policy.violation 事件：审计发现越界后，上报结论写入 append-only 事件流；验证方式：测试中断言事件文件含 policy.violation 记录。
4. 非越界写入正常通过：对写集内且策略允许的路径判定为 allow；验证方式：测试中断言通过。

## 风险

- 测试必须无模型、无网络、无挂起；应对：只调本地判定与 git，不起 agent 进程。
