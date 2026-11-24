# ADR-105：`audit verify` 的三态结论

状态：已接受
日期：2026-11-24
取代/补充：ADR-100 §3

## 背景

ADR-100 给事件流加了哈希链，`verifyChain` 返回一个**布尔** `ok`。

问题出在「布尔把两件事压成了一件」：

- 「链完好，而且我逐行验过了」
- 「压根没有链可验（流不存在 / 流为空 / 全是上链前的老格式事件）」

两者都得到 `ok: true`。

对「用来证明『证据没被动过』」的命令来说，这是个真问题：
外部读者拿到 `ok: true` 会读成「验过了」，而实际是「没东西可验」。
把「无链」误读成「已验」——**恰恰是追溯链最不能出的错**。

ADR-100 §3 已经规定「不误报被篡改」（无链不判假），
但那只是**退出码**层面的约定，没有落到**结论本身**。
本 ADR 把三态补上。

## 决策

### 1. 结论是三态

`ChainVerdict` 新增 `status: 'ok' | 'broken' | 'no-chain'`：

| status | 含义 | 退出码 |
|---|---|---|
| `ok` | 链完整：至少有一个已上链事件，且逐行校验通过 | 0 |
| `broken` | 断链：哈希对不上 / 链中间出现未上链事件 / 链尾链接断裂 | 1 |
| `no-chain` | **没有已上链事件可验**：流不存在 / 流为空 / 全是老格式事件 | 0 |

### 2. `ok` 布尔保留，但降级为「便捷视图」

`ok` 保留（不破坏既有调用方），但**语义收窄**为 `status !== 'broken'`：

- `no-chain` 时 `ok` 仍是 `true` —— 遵守 ADR-100 §3「不误报被篡改」；
- 但它**不再表示「验过了」**。

**新代码一律读 `status`。** 既有调用方（`audit.ts` 的退出码、验收断言）
继续读 `ok` 也依然正确，因为 `ok` 的取值与旧版完全一致。

### 3. CLI 输出必须让人分得清

`zelto audit verify <slice>` 按 `status` 分支渲染：

- `ok` → `Chain: OK`
- `broken` → `Chain: BROKEN`
- `no-chain` → `Chain: NO CHAIN` + 一句说明「没有已上链事件可验」

`no-chain` 的文案必须明确「没有链」，不能写成「OK」，
否则人在终端里看到的结果仍然是误读。

### 4. 判定纯函数、只读、不触网

三态的判定完全在 `verifyChain` 内，只读文件、纯计算（C3）。
不引入模型调用、不引入网络请求。

## 对接点

- 核心：`src/core/events/stream.ts` —— `ChainStatus`、`ChainVerdict.status`、
  `verifyChain` 的三态计算。
- CLI：`src/cli/commands/audit.ts` —— `audit verify` 分支按 `status` 渲染。
- 验收：`tests/acceptance/v1-audit-verify-command/acceptance.test.cjs` ——
  自建临时链，覆盖 `ok` / `no-chain` / `broken` 三种状态。

## 后果

- **退出码语义不变**：`ok` 与 `no-chain` 都是 0，`broken` 是 1。
  所以已有 CI / 脚本不会因为本次改动而变红。
- 布尔 `ok` 无法表达「没东西可验」这件事本身没变 ——
  它现在有了 `status` 作为出口，但**误用 `ok` 的风险依然存在**。
  所以第 2 条明确「新代码一律读 `status`」。
