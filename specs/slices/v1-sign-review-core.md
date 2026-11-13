# Slice: v1-sign-review-core

## 目的

实现 ADR-070 §5 的判定层：共享类型 `SignReviewFacts` / `SignCheck` 加纯函数
`evaluateSignChecks(facts)`。只吃已经算好的事实、吐四项签字前确认项，不碰文件、
不跑 git（C2/C3），CLI 与将来的 HTML 共用同一份判定。

## 范围

- src/core/sign-review/types.ts
- src/core/sign-review/evaluate.ts

## 需求

- req-1794561287258：控制面——`zelto sign --review` 签字上下文（第一轮）

## 验收标准

1. `src/core/sign-review/types.ts` 定义并导出 `SignReviewFacts` 与 `SignCheck`。`SignReviewFacts` 至少包含切片标识与状态、trace 三元组（requirements/contracts/tests）、gate 结果（acceptance 是否跑过、通过数/总数）、diff 统计（文件数/增删行）、成本聚合、停机摘要、写集审计结论（violations）、产物证据（三态 `in-trunk | not-in-trunk | unknown`，复用 `artifact-evidence.ts` 的 `ArtifactEvidence` 语义）；`SignCheck` 为 `{ label: string; ok: boolean; evidence: string; adrRef: string }`。验证方式：项目根执行 `npx tsc --noEmit` 退出码为 0。
2. `src/core/sign-review/evaluate.ts` 导出纯函数 `evaluateSignChecks(facts: SignReviewFacts): SignCheck[]`，按 ADR-070 §5.2 输出四项确认项：追溯链未断（判据 `evaluateFreezeTrace`，ADR-060/032）、验收真跑过本片（判据 `gate.result` 事件的 acceptance 字段，ADR-033/051）、改动在写集内（判据写集审计结论 `violations.length === 0`，ADR-014）、产物真落地（判据 `ArtifactEvidence`，ADR-059/061）。验证方式：对 `evaluate.ts` 执行 `grep -nE 'fs|child_process|execFile|fetch|http|Date\.now|Math\.random|console\.'` 无命中（类型导入除外），且该文件不导入 `src/cli/` 下任何模块。
3. 四项确认项各有一条 ADR 锚点：每条 `SignCheck` 的 `adrRef` 非空且指向 ADR-070 §5.2 的判据来源（追溯→ADR-060/032，验收→ADR-033/051，写集→ADR-014，产物→ADR-059/061）。验证方式：Node 临时脚本构造一份全通过的 facts，断言返回数组长度为 4、四条全部 `ok === true`、四条 `adrRef` 均非空。
4. 产物证据为 `unknown` 时不谎报失败：facts 中 artifact 为 `unknown`（HEAD 读不到、非 git 仓库等）的那一项 `ok === false` 但 `evidence` 必须明示"未知、未核对"，不得写成"产物不在主干"。验证方式：Node 临时脚本只把 artifact 置为 `unknown`、其余全通过，断言产物项 `ok === false` 且 `evidence` 包含"未知"或"unknown"（大小写不敏感）。
5. 阴性对照四种失败各一组断言：trace 为空→追溯项失败；gate 无 acceptance 记录→验收项失败；violations 非空→写集项失败；artifact 为 `not-in-trunk`→产物项失败；且每次只坏一项时其余三项仍通过。验证方式：Node 临时脚本跑四组 facts 逐项断言。
6. 纯函数可复现：同一份 facts 连续调用三次返回 `deepStrictEqual` 相等，且不修改入参（冻结入参后调用不抛 `TypeError`）。验证方式：Node 临时脚本用 `Object.freeze` 断言。

## 风险

- `types.ts` 与 `evaluate.ts` 循环依赖；应对：`types.ts` 只放类型零导入，`evaluate.ts` 只从它导入类型。
- 判定里混入 IO/时间/随机破坏可复现；应对：验收标准第 2 条用 grep 锁死。
- `unknown` 被当成失败误导签字人；应对：验收标准第 4 条锁死文案语义（ADR-059 哲学：查不到就说查不到）。
