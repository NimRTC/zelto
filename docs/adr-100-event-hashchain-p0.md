# ADR-100：事件流哈希链 P0（只上链、不签名、不补历史）

状态：已接受（0.7.0 v1）
日期：2026-11-23

## 背景

事件流是追溯的唯一证据载体（C4），但此前它只是 append-only 文本：
一行被改、被删、被重排，`audit` 照读不报错。“证据存在”不等于“证据没被动过”。
0.7.0 的目标是让篡改**可被外部验证**，而不是让 zelto 自己说“我没改”。

## 决策

1. 每片一条链。`EventEnvelope` 新增可选 `prevHash: string|null` 与 `hash: string`，
   新写入必带；老事件缺省，`verify` 明确报告“某行之前无链”，不判假。
2. 哈希 `SHA-256(prevHash + 规范内容)`，规范内容固定字段序
   `ts,runSeq,slice,run,type,actor,payload,prevHash`，对象键排序（`stableStringify`）。
   `hash` 自身不参与自哈希。
3. `verifyChain` 只读：复算 hash + 对 prevHash 链接；空 hash 非法值直接失败；
   链中间出现未上链事件判失败；退出码 0=OK、1=断链。
   **（2026-11-24 补充，见 ADR-105）**：结论已从布尔扩展为三态
   `ok` / `broken` / `no-chain` —— 「没有已上链事件可验」既不是 `ok`
   也不是 `broken`，但仍按本条退出码约定记 0（不误报被篡改）。
4. `zelto audit verify <slice>` 为只读入口，不写任何文件。
5. 本次不做：签名（无密钥管理需求）、并发锁/单写者队列（另起 ADR）、
   历史追补（只覆盖新写入）、`hook-io.json` 改动。

## 对接点

- 写：`src/core/events/stream.ts#append`（读本片文件找链尾 hash）。
- 读：`loadChain`（= `read` 的只读命名）、`verifyChain`。
- 契约：`contracts/schemas/event-envelope.json` 可选字段，老文件可读。
- 审计：`src/cli/commands/audit.ts` 新增 `verify` 分支；`catalog.ts` 目录同步。

## 写保护 e2e 的关系

哈希链回答“证据没被动过”，写保护（PreToolUse 逐写判定 + 事后 git 审计）
回答“越界没发生”。两者正交：v2 用 `tests/guard-deny-e2e.test.ts`
固化后者，本 ADR 只管前者。`audit verify` 不替代写集审计。

## 后果

- 新事件体积 +2 字段；老仓库 `verify` 给出“无链/部分链”结论。
- `EventStream.append` 每次写前读一次本片文件（O(n) 读），事件量大时可优化为缓存链尾，本次不做。
