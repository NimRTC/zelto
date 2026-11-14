# Slice: v2-sign-review-fix

## 目的

修复 `zelto sign --review` 在主干验证中暴露的两处误判（v1 已交付切片显示 FAIL）：

1. 写集项陈旧 —— `collectWriteSetAudit` 只取最新一条 `policy.violation` 事件，
   无视之后已通过的 `gate.result`。第一轮重跑的越界（16:50）在扩写集后已通过
   两次 gate（17:30），陈旧结论一直留着，已交付切片永远显示「改动在写集内 FAIL」。
2. 验收项漏判 —— `collectGateFacts` 只认 `payload.acceptance` 字段与
   `results[].command === 'acceptance'`。本项目没配 `gate.acceptance`（skipped），
   真正跑过的验收是 `spec.gateCommands` 里的 `acceptance-cli`（6 用例全过），
   被判成「没跑过」。

## 范围

- src/cli/sign-review/collect-facts.ts
- tests/acceptance/v2-sign-review-fix/acceptance.test.cjs

## 需求

- req-1794561287258：控制面——`zelto sign --review` 签字上下文（第二轮修复）

## 验收标准

1. 写集项以后通过的 gate 为准：若最新一条通过（passed=true）的 `gate.result`
   事件时间晚于最新一条 `policy.violation` 事件，则 `writeSetAudit.violations`
   为空（越界已在扩写集/重跑后解决）。验证方式：对 `v1-sign-review-cli` 的真实
   事件流跑收集，`writeSetAudit.violations` 为空，`evaluateSignChecks` 第三项为 ok。
2. 验收项识别 `spec.gateCommands` 的验收命令：`payload.acceptance.status`
   为 `skipped`/缺失时，回退扫描 `results[]` 中名字含 `acceptance` 的命令；
   有一条 passed 且 stdout 能解析出 `pass > 0`（复用 `parseTestRunnerStats`），
   即判 `acceptanceRan=true / acceptancePassed=true`，pass/total 从该命令的
   stdout 解析。验证方式：对 `v1-sign-review-cli` 跑收集，gate 段为
   ran=true/passed=true 且 total=6；`evaluateSignChecks` 第二项为 ok。
3. 回归：`v1-sign-review-core` 的 review 四项仍与修复前一致（追溯 ok / 验收 FAIL
   待定——core 片本身没有 acceptance 记录，保持原判，不被回退逻辑误判成通过）；
   无 violation 事件的切片仍为空清单；`npx tsc --noEmit` 退出码为 0。
4. `--json` 仍可被 `JSON.parse` 解析；`--review` 只读性与非 TTY 行为不变
   （现有 CLI 验收用例继续通过）。
