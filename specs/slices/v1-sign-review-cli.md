# Slice: v1-sign-review-cli

## 目的

实现 ADR-070 §5.1 的 CLI 层：事实收集 `collectSignReviewFacts()`、终端渲染
`renderSignReview`、命令注册 `zelto sign --review <id>`。本层是整个流程中
唯一允许读 `.zelto` 文件、跑 git 的模块；判定逻辑零新增，全部委托给
`evaluateSignChecks`。

## 范围

- src/cli/sign-review/collect-facts.ts
- src/cli/sign-review/render.ts
- src/cli/commands/sign-review.ts
- src/cli/commands/gate-sign.ts

## 需求

- req-1794561287258：控制面——`zelto sign --review` 签字上下文（第一轮）

## 验收标准

1. `collect-facts.ts` 导出 `collectSignReviewFacts(sliceId)`：读 `.zelto/slices/<id>.json` 取切片摘要与 trace 字段；读 `.zelto/events/<id>/events.jsonl` 按行解析并过滤 `gate.result`、`budget.spent`、`stall.classified` 三类事件；跑 `git diff --numstat` 取变更文件数与增删行；复用 `src/cli/commands/artifact-evidence.ts` 的 `collectTrunkSnapshot` 与 `judgeArtifactEvidence` 计算产物证据。返回 `SignReviewFacts`，不做任何判定。验证方式：对真实切片（如 `v1-sign-review-core`）跑一次收集，返回对象含 trace/gate/diff/artifact 四段且不抛错；`npx tsc --noEmit` 退出码为 0。
2. `render.ts` 导出纯函数 `renderSignReview(checks: SignCheck[], facts: SignReviewFacts, viewport?)`：80x24 视口内单屏结构化文本，复用 `src/cli/color.ts` 的颜色/图标体系，含追溯链、验收、改动、成本、停机、四项确认项六段，外加"签字≠合并"提示行（ADR-018 锚点）。不做 IO。验证方式：Node 临时脚本用 mock facts 渲染，输出含四项确认项标题与签字≠合并行，且行数不超过 24（默认视口）。
3. `sign-review.ts` 导出编排入口 `runSignReview(sliceId)`：依次调用收集→`evaluateSignChecks`→渲染→stdout；`gate-sign.ts` 的 `register('sign', …)` 识别 `--review <id>` 并转发过去，未传 `--review` 时原有 `--approve/--reject/--revoke` 行为不变。验证方式：`node dist/cli/index.js sign v1-sign-review-core --review` 退出码为 0 且输出六段；`--approve` 路径回归测试仍通过。
4. 非 TTY 不挂死：管道/重定向下只打印不提示确认（沿用 `core-slice.ts` 非 TTY 不等人做法）。验证方式：`node dist/cli/index.js sign <id> --review | cat` 正常退出不等待输入。
5. 只读性：`--review` 不写 `.zelto` 下任何文件、不追加任何事件。验证方式：跑一次 `--review` 前后对 `.zelto/slices/` 与 `.zelto/events/` 做快照对比，无新增无修改。
6. `--json` 输出结构化 `SignReview`（facts + checks），可被 `JSON.parse` 解析，供将来的 `cockpit` 复用同一份结构（ADR-070 §5.5）。验证方式：`--json` 输出管道进 `node -e "JSON.parse(...)"` 退出码为 0。

## 风险

- git 调用失败（非仓库/无提交）时产物证据必须退为 `unknown` 而不是抛错；应对：`collectTrunkSnapshot` 本身已有空快照特判（`snapshot.files.size === 0 → 'unknown'`），收集层透传即可。
- 事件文件缺失（新切片无事件目录）时 gate/cost/stall 段标"无记录"而不是崩；应对：读不到按空处理，`evaluate` 侧判失败并明示证据缺失。
- `gate-sign.ts` 改动影响现有签字路径；应对：`--review` 分支在参数解析最前分流，原有分支一字不动，现有 sign 回归测试全过。
