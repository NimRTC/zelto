# ADR-101：0.7.0 可验证性文档束 —— 哈希链 / audit verify 只读 / 写保护 e2e / 帮助分层 / Windows CI

状态：已接受（0.7.0 v3-docs）
日期：2026-11-23

> 本 ADR 是 v3-docs 的决策载体：把 0.7.0 已落地的四件事（v1 哈希链、v2 写保护 e2e + Windows CI、v3 why + help）
> 的决策一次说清，供 `docs/plan-0.7.0-verifiability.md` 五主题小节引用。
> 与 ADR-100 的关系：ADR-100 是哈希链的权威设计；本 ADR 不重复设计细节，
> 只补齐“只读、e2e、帮助分层、双平台”四条决策的验收口径。

## 1. 哈希链设计（基于 `src/core/events/stream.ts` 扩展）

事件流是追溯的唯一证据载体（C4），此前只是 append-only 文本。
0.7.0 用哈希链（hash chain）让篡改可被外部验证。

- 对接点：`src/core/events/stream.ts` 的 `append`（写入时计算链）、
  `loadChain`（只读读回整链）、`verifyChain`（只读逐行校验）。
- 链规则：每片一条链；`EventEnvelope` 新增可选 `prevHash/hash`；
  新写入必带，`hash = SHA-256(prevHash + 规范内容)`，规范内容固定字段序、
  对象键排序（`stableStringify`），`hash` 自身不参与自哈希。
- 追加语义：`append` 先读本片文件找链尾 hash 当 `prevHash`，再算新 `hash` 落盘。
- 校验语义：`verifyChain` 复算每个事件的 hash 并对 `prevHash` 链接；
  老事件（无 hash 前缀）只计数为 `unchained` 而不判假；
  链中间出现未上链事件、空 hash、复算不一致都判断链，逐行报断点。
- 本次不做：签名、并发锁/单写者队列、历史追补（只覆盖新写入）。

## 2. `audit verify` 为只读路径（read-only）

`zelto audit verify <slice-id>` 是哈希链的只读（read-only）校验入口。

- 只读保证：全程只调 `EventStream.verifyChain`（读文件、纯计算），
  不修改审计日志、不修改任何状态、不写任何文件（C1/C4）。
- 输出：`Chain: OK/BROKEN` + `Checked/Unchained/Head` + 逐行 `Failures`（行号 + runSeq + 原因）。
- 退出码：0 = 链完整；1 = 断链或用量错误（无链时给“无链可验”结论，不误报被篡改）。
- 与写集审计的关系：`audit verify` 回答“证据没被动过”，
  写保护（逐写判定 + 事后 git 审计）回答“越界没发生”，两者正交，不互相替代。

## 3. 写保护机制的 e2e 验证策略（e2e / 端到端）

写保护 = PreToolUse 逐写判定（主）+ 事后 git 审计兜底（`auditWorktreeWrites`），
缺预约时 fail closed（一律拒绝）。e2e（端到端）验证策略固化在
`tests/guard-deny-e2e.test.ts`，无模型、无网络，Linux 与 Windows 双平台都跑。

写保护开启时写操作被拒绝的验证场景与步骤：

1. 越界写入被逐写判定拒绝（三 harness 信封一致）：
   用 `contracts/schemas/hook-io.json` 构造 Claude/Cursor/Codex 三种信封，
   `extractWriteTargets` + `judgeWriteTargets(未预约路径)` → 断言 `deny`，
   且三者结论一致（`new Set(decisions).size === 1`）。
2. 未预约路径判定为 `reservation:missing`（默认拒绝）：
   `writes: null` 时同一次写 → `deny` + `ruleId === 'reservation:missing'`。
3. git 真实改动的审计兜底非空：
   建真实临时 git 仓库，写 `other/evil.ts`（写集外），
   `auditWorktreeWrites(repo, ['src/**'])` → `violations` 含 `other/evil.ts`。
4. 审计结论落盘为 `policy.violation` 事件：
   同上改动 → `EventStream.append(..., 'policy.violation', ...)`，
   `loadChain` 读回条数与 `violations` 一致。
5. 写集内且策略允许的路径放行（反例）：
   写集内 `src/a.ts` + allow 规则 → `allow`，证明拒绝不是“全拒”。

## 4. 帮助分层设计

帮助分三层，层层可达，不丢既有信息：

- 顶层帮助（L1）：入口 `zelto help`（默认仅“核心切片 + 项目管理”两组），
  全量入口 `zelto help --all`（全部 7 组，每条命令带 L3 参数清单）。
- 命令帮助（L2）：入口 `zelto help <command>`，
  输出命令名 + 用途 + 用法行（`usageOf`）+ 选项列表（`paramListOf`）。
- 子命令/参数帮助（L3）：入口 `zelto help <command> <param>`，
  也支持 `zelto help <group>/<command>/<param>` 直达；
  输出参数名 + 描述 + 约束/默认值。
- 层级导航：`..` 返回上层，`top` 返回顶层；
  `--help` / `-h` 与当前层级自适应（L1 传 `--help` 等于顶层概览，
  L2 等于命令说明，L3 等于参数详解）。
- 数据源：`src/cli/commands/catalog.ts` 的 `COMMAND_CATALOG` 唯一真源，
  `groupCommandIndex` / `commandsInGroup` / `paramListOf` 供帮助系统按组查询；
  未知组/命令/参数给可识别提示且退出码 0、不崩溃。

## 5. Windows CI 双平台决策

CI 同时纳入 Windows 与 Linux 双平台：

- Linux（`ubuntu-latest`）：全量 `pnpm test`，是门禁的主判据。
- Windows（`windows-latest + Node 22`，显式 `shell: bash`）：
  跑 `build + test:quick + lint`，与 Linux 同一份脚本复用（三脚本名字一致）。
- 为什么双平台都要进 CI：历史坑（换行吞 trailer 导致 `Refs-Slice` 丢失、
  路径分隔符、Windows 残留锁、cmd 管道符 `|` 打崩 `-R` 正则、BOM 头）只在
  Windows 上暴露；只跑 Linux 会让这些坑流到用户现场。
- 约束：加 job 不碰 `core/`、不碰契约，无需另起 ADR（本 ADR 即记录）。

## 后果

- 五个主题都有据可查：规划文档给入口，本 ADR 给决策，`guide-zelto-why` /
  `guide-help-layers` 给用户用法，验收测试逐条可验。
- 不新增代码与契约：本片只动 `docs/**`（验收文件除外），实现零回归风险。
