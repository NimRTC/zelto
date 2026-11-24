# 0.7.0 开发计划：可验证性 + 接入成本

> 来源：对外部分析报告的逐条验真（2026-11-23）。
> 结论：骨架不缺，缺的是"承诺可被外部验证"和"接入成本"。
> 本计划只含验真后值得做的项。

## 范围

- 做：M1（三平台 CI + 无模型越界 e2e）、M2（`zelto why`）、M3（事件哈希链 P0）、M4（help 分层 + 文档澄清）。
- 不做：事件签名、并发锁/单写者队列、策略双实现合一、SDK 移 optional（另起 ADR 或等投诉）。
- 已落地不用重做：init 默认策略生成、事后写集审计 fail closed。

## M1：三平台 CI + "越界被拦"无模型 e2e（P0）

### M1-1：加 Windows job
- 改动：`.github/workflows/ci.yml` 新增 `windows-latest + Node 22`，跑 `build + test:quick + lint`。Linux 保持全量 `pnpm test`。
- 验收：Windows job 绿；历史坑（换行吞 trailer、路径分隔符、锁残留）能在 CI 先暴露。
- 约束：不碰 `core/`，不碰契约，无需 ADR。

### M1-2：无模型的"越界被拦"e2e
- 新增 `tests/guard-deny-e2e.test.ts`：
  1. 建临时项目 + worktree（或直接调 `installRuntimeGuard`）；
  2. 调 `src/hook/pretool.ts` 判未预约路径 → 断言 `deny`；
  3. 调 `auditWorktreeWrites` 对 git 真实改动再判 → 断言 `violations` 非空 + `policy.violation` 事件落盘；
  4. 协议输入按 `contracts/schemas/hook-io.json` 构造，覆盖 Claude/Cursor/Codex 三种 harness 信封。
- 验收：`pnpm test`（Linux）与 Windows job 里都跑，不进 `HANGING`，不挂起、无网络、无模型。

## M2：`zelto why <path>`（P0，ROI 最高）

- 新命令 `why`（建议 `src/cli/commands/policy-why.ts` 或并入现有 policy 命令文件，保持小文件惯例）。
- 组装已有能力，不写新判定：`core/policy/engine.ts#evaluatePolicy` + `ReservationStore` + `isZeltoManagedSpecPath` 例外 + 保护域。
- 输出四行：结论 allow/deny/ask、命中的 ruleId + basis、归属切片与预约写集、修复建议。
- `catalog.ts` 加一行（`COMMAND_CATALOG` 真源，`tests/cli-catalog.test.ts` 守注册一致性）；`--json` 供 web/脚本消费。
- 验收：四种输入各一条用例（命中 allow、无规则落 default deny、保护域 agent 上下文 deny、托管规格文件 allow）；`zelto help why` 可用。
- 约束：C3（只解释判定，不参与判定）；只读，不写状态。

## M3：事件哈希链 P0（需先写 ADR 再动手）

- ADR 前置：字段名（`prevHash/hash`）、哈希算法与串接规则、老文件迁移（建议"创世块"处理，`verify` 明确报告"某行之前无链"而不判假）、`verify` 退出码语义。
- 改动：
  - `contracts/schemas/event-envelope.json` 加可选字段（先可选，保证老文件可读；新写入必带）；
  - `src/core/events/stream.ts#append` 计算链（`hash = sha256(prevHash + canonical_json)`，canonical 规则写进 ADR）；
  - `zelto audit verify [slice-id]`（或 `--verify`，ADR 里二选一）：全链校验，逐行报断点，退出码 1=断链；
  - `src/core/audit/trail.ts` 读链时容错老格式。
- 验收：新写入事件链式可验；篡改中间一行 `verify` 必红并定位行号；老仓库给出"无链/部分链"明确结论，不误报"被篡改"。
- 约束：C1（只落文件）、C4（校验不改文件）。并发保护明确不在本 M 内。

## M4：接入收尾（P1，小批量）

### M4-1：`help` 分层
- `src/cli/commands/info-help.ts#help` 默认只显示"核心切片 + 项目管理"两组（或 catalog 标记 `essential: true`），`zelto help --all` 展开全部 7 组。`help <cmd>` 不变。
- 验收：默认输出行数减半以上；`--all` 与现有全量一致；补全脚本不受影响。
### M4-2：文档澄清（纯文档，不碰代码）
- `init` 成功输出或开工包加一句："已按探测生成最小可用策略集，请按需收紧"（代码 `buildPolicyYaml` 已生成）。
- 架构文档/开工包写清："PreToolUse 可能漏解释器内写，但 `enforceWriteSet` 事后必查，读不到 git 即 fail closed 退回 frozen"。
- 验收：新人不再提出"默认 deny 没法起步"或"绕过 shell 怎么办"。

## 附录A：0.7.0 五主题小节（v3-docs）

> 本附录把 M1–M4 已落地的决策收拢成五个主题小节，供验收标准 1 逐条核对。
> 权威设计见 ADR-100（哈希链）与 ADR-101（v3 文档束）；
> 用户用法见 `docs/guide-zelto-why.md` 与 `docs/guide-help-layers.md`。

### 哈希链设计

事件流是追溯的唯一证据载体（C4），0.7.0 用哈希链让篡改可被外部验证。
对接点是只读扩展的 `src/core/events/stream.ts`：`append` 写入时先读本片文件
找链尾 hash 当 `prevHash`，再算 `hash = SHA-256(prevHash + 规范内容)` 落盘；
`loadChain` 只读读回整链；`verifyChain` 只读逐行复算 hash 并对 `prevHash`
链接。`EventEnvelope` 新增可选 `prevHash/hash`，新写入必带；
老事件（无 hash 前缀）`verify` 只计数为 `unchained` 而不判假。
本次不做签名、并发锁与历史追补（只覆盖新写入）。

### `audit verify` 只读路径

`zelto audit verify <slice-id>` 是哈希链的只读（read-only）校验入口。
只读保证：全程只调 `EventStream.verifyChain`（读文件、纯计算），
不修改审计日志、不修改任何状态、不写任何文件（C1/C4）。
输出 `Chain: OK/BROKEN/NO CHAIN`（**三态**，ADR-105）+ `Checked/Unchained/Head` + 逐行断点（行号 + runSeq + 原因）；
退出码 0 = 链完整或无链可验，1 = 断链。
**三态的区分是必须的**：布尔会把「链完好且验过了」与「压根没有链可验」压成同一个 `true`，
外部读者把「无链」读成「已验」——恰恰是追溯链最不能出的错。
`NO CHAIN` 明确说「没有链」，不判假（不误报被篡改），但也不是「验过了」。
它回答“证据没被动过”，不替代写集审计回答的“越界没发生”。

### 写保护 e2e 验证策略

写保护 = PreToolUse 逐写判定（主）+ 事后 git 审计兜底（`auditWorktreeWrites`），
缺预约时 fail closed（一律拒绝）。e2e（端到端）验证策略固化在
`tests/guard-deny-e2e.test.ts`，无模型、无网络，Linux 与 Windows 双平台都跑。
写保护开启时写操作被拒绝的验证场景：① 越界写入被逐写判定拒绝
（三 harness 信封一致，`judgeWriteTargets` 判 `deny`）；
② 未预约路径判 `reservation:missing` 默认拒绝；
③ git 真实改动的审计兜底 `violations` 非空（含 `other/evil.ts`）；
④ 审计结论落盘为 `policy.violation` 事件；
⑤ 写集内且策略允许的路径放行（反例，证明拒绝不是“全拒”）。

### 帮助分层

帮助分三层：顶层帮助（L1，`zelto help` 默认两组，`zelto help --all` 全量）、
命令帮助（L2，`zelto help <command>`，用法行 + 选项列表）、
子命令/参数帮助（L3，`zelto help <command> <param>`，参数名 + 描述 + 约束/默认值）。
`..` 返回上层，`top` 返回顶层；`--help` / `-h` 与当前层级自适应。
数据源是 `catalog.ts` 的 `COMMAND_CATALOG` 唯一真源，
未知组/命令/参数给可识别提示且退出码 0、不崩溃。

### Windows CI

CI 同时纳入 Windows 与 Linux 双平台：Linux（`ubuntu-latest`）跑全量
`pnpm test`，是门禁的主判据；Windows（`windows-latest + Node 22`，
显式 `shell: bash`）跑 `build + test:quick + lint`，与 Linux 同一份脚本复用。
历史坑（换行吞 trailer、路径分隔符、残留锁、cmd 管道符、BOM 头）只在
Windows 上暴露，双平台都纳入 CI 才能先暴露。

## 运营 checklist（不进工程排期，单独跟）

- 90 秒录屏：Cursor 改测试文件 → 被拦 → 事件留证 → 人签字。
- 每月 dogfood 数字：拦了多少次越界、抓到几次验收造假。
- 找 3 个真实用户跑一遍接管流程，记录摩擦点。

## 明确不做（本次排除，备查）

- 事件签名：单用户工程阶段不需要密钥管理负担。
- 锁文件/单写者队列：Windows 残留锁风险高，另起 ADR。
- 策略双实现合一：有意隔离（hook 独立编译/零依赖），维持 ADR-028 等价性测试；要合一必须先写动 C2 边界的 ADR。
- SDK 移 optional：`optionalDependencies` 默认仍安装，真省需 peer + 动态 import + 报错文案，ROI 不如上面四件。
