# Slice: v3-sign-review-acceptance-spec

## 目的

修复 `collectGateFacts` 回退路径漏识别 Node spec 报告器输出的问题（v2 修复后残留）：

- v2 回退只认 TAP 汇总行（`# pass N`，`parseTestRunnerStats` 唯一能解析的形态）。
- 真实 `gate.result` 事件里 `results[].stdout` 是门禁存的**前 500 字符**
  （executor 把 stdout 截到 500），内容是 Node spec 报告器形态：
  `✔ … / ℹ tests 6 / ℹ pass 6 / ℹ fail 0 …`——没有一行 `# pass`，
  回退找不到 `pass > 0`，验收项保持 FAIL。
- 本片让回退同时识别 spec 报告器的 `ℹ pass N` 汇总行
  （`ℹ`/`#` 前缀等价，其余语义与 `parseTestRunnerStats` 一致）。

## 范围

- src/core/gate/acceptance.ts（`parseTestRunnerStats` 同时识别 `#` 与 `ℹ` 前缀）
- src/cli/sign-review/collect-facts.ts（回退注释与判据说明同步，若实现已透传则只改注释）
- tests/acceptance/v3-sign-review-acceptance-spec/acceptance.test.cjs

## 需求

- req-1794561287258：控制面——`zelto sign --review` 签字上下文（第三轮修复）

## 验收标准

1. `parseTestRunnerStats('✔ a (1ms)\nℹ tests 6\nℹ pass 6\nℹ fail 0\n')`
   返回 `{ known: true, pass: 6, … }`；原有 `# pass` 形态保持不变
   （现有 `adr-034-spec-draft.test.ts` 中「读得出 TAP 汇总行」用例仍过）。
2. 对 `v1-sign-review-cli` 的真实事件流跑收集：`facts.gate` 为
   ran=true/passed=true 且 pass/total=6/6；`evaluateSignChecks` 第二项为 ok，
   第三项保持 ok（v2 已修），第四项保持 ok。
3. 回归：对 `v1-sign-review-core` 的真实事件流跑收集，验收项保持 FAIL
   （core 的 `acceptance-core` stdout 只有 `✔/ℹ tests 5/ℹ pass 5`？
   若同样含 `ℹ pass 5` 则会被判通过——本标准以真实事件流为准：
   若 core 的 stdout 同样可解析出 pass>0，则允许判通过，但必须在实现注释中
   说明「core 片同样有可解析的验收证据」而不是静默翻转；若解析不到则保持 FAIL）。
   以实现后实际跑出的结论为准，标准 3 的通过条件是「结论与证据一致且有注释」。
4. `--json` 可 parse；`--review` 只读性与非 TTY 不变；`npx tsc --noEmit` 退出码 0。
