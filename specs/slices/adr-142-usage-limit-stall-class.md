# Slice: adr-142-usage-limit-stall-class

## 目的

实施 ADR-142（`docs/adr/adr-142-usage-limit-stall-class.md`）：
新增停机类 `usage_limit` —— agent 服务端的配额 / 限流耗尽
**不自动重试**（配额墙不会因为重试而恢复）。

## 背景：现在的洞

`src/core/stall/types.ts` 的 `StallClass` 九个分类里
**没有「配额 / 限流耗尽」**。

所以撞 429 的 agent 走的是：

```
退出码非 0
  → classifyStall({ type: 'test_failure' }) → 'environment_failure'
  → isAutoResolvable('environment_failure') → true
  → 自动重试（默认 2 次）→ 每次重试再撞一次 429
```

**纯浪费**：配额不会因为重试而恢复；每次重试还要重新起会话、
重新读上下文、重新烧 token；更糟的是**重试预算被烧光** ——
下次真正需要重试的机会（环境抖动）也没了。

注意 `budget_exhausted`（⑥）是 **zelto 自己的预算闸门**（ADR-035）——
那是**钱**，调高上限就能继续。本片要加的是**agent 服务端的配额** ——
那是**账号**，调高 zelto 的配置没用。

## 范围

要改的：

- `src/core/stall/types.ts` —— `StallClass` 增加 `'usage_limit'`
- `src/core/stall/classifier.ts` —— 加分类规则；`isAutoResolvable` 排除它
- `src/core/stall/usage-limit.ts`（**新增**） —— 纯文本识别 + reset time 提取
- `src/core/stall/index.ts` —— 导出新函数
- `src/cli/commands/run-support.ts` —— `handleAgentFailure` 接 `agentOutput`；停机说明
- `src/cli/commands/core-slice.ts` —— 两个调用点传 `agentOutput`
- `src/cli/commands/parallel-executor.ts` —— 调用点传 `agentOutput`
- `src/cli/commands/supervisor.ts` —— 调用点传 `agentOutput`
- `src/cli/commands/question.ts` —— 续跑失败路径也识别配额
- `docs/zelto-技术架构.md` —— 同步 `StallClass` 清单
- `tests/adr-142-usage-limit.test.ts`（**新增**）

只读参考（**不得修改**）：

- 只读 `docs/adr/adr-142-usage-limit-stall-class.md` —— 本片的规则真源。
- 只读 `tests/stall-classifier.test.ts` —— 既有分类单测（本片不改它；
  引用它是为了说明「既有分类行为不变」这条要求）。

## 需求

- 无（本片没有关联的需求条目；验收口径见下）。

## 验收标准

1. **配额错误 → 分类为 `usage_limit`** ——
   验证方式：单测给一段含 `rate limit` / `429` / `quota` 的输出文本，
   断言 `classifyStall({ type: 'usage_limit', ... }) === 'usage_limit'`。

2. **`usage_limit` 不可自动恢复** ——
   验证方式：单测断言 `isAutoResolvable('usage_limit') === false`。
   > **为什么这条不能省**：这条是整个 ADR 的核心。判成 true =
   > 配额墙面前自动重试 = 纯浪费 + 烧掉重试预算。

3. **识别靠输出文本，且认不出时不误判** ——
   验证方式：单测给一段普通失败输出（无配额特征），断言**不**识别为配额；
   给一段含配额特征的输出，断言识别为配额。
   > **为什么这条不能省**：「宁可漏认，不可误认」——
   > 误认成配额 = 一次本该重试的环境抖动被白白放弃。

4. **不改既有分类的行为** ——
   验证方式：既有 `tests/stall-classifier.test.ts` 全绿。

5. **`handleAgentFailure` 拿到配额输出时不自动重试** ——
   验证方式：单测让 agent 输出含 `rate limit`，断言**没有**走重试分支
   （`stall.autoResolved` 不变），而是直接停机。
   > **为什么这条不能省**：这是「识别 → 处置」这条链的**端到端**验证。
   > 分类对了但处置没跟着变 = 配额错误照样被重试。

6. **停机时说明「等配额」并给出 reset time** ——
   验证方式：单测断言停机输出里有「配额」字样与 reset time。

7. **reset time 取不到时如实留空** ——
   验证方式：单测给一段没有 reset time 的配额输出，断言事件里
   `resetAt === null`（**不是**编一个）。
   > **为什么这条不能省**：「测不到 ≠ 零」——
   > 编一个 reset time 会让人按错的时间去等。

8. **四个调用点都传了 `agentOutput`** ——
   验证方式：源码检查（四个文件里 `handleAgentFailure` 调用处
   都有 `agentOutput`）。
   > **为什么这条不能省**：不传 = 识别不到 = 本片在真实路径上不生效。

9. **不传 `agentOutput` 时行为不变** ——
   验证方式：单测调 `handleAgentFailure(id, 1, { maxRetries })`（不传输出），
   断言行为与改动前一致（仍然自动重试）。

10. **文档同步** ——
    验证方式：核对 `docs/zelto-技术架构.md` 的 `StallClass` 清单
    含 `'usage_limit'`。
    > **为什么这条不能省**：ADR-036 踩过「代码能发、契约不认」——
    > 文档与代码漂移会在下一次审计里变成真 bug。

11. **事件契约不受影响** ——
    验证方式：核对 `contracts/schemas/event-envelope.json` 的 enum
    （事件**类型**）不含 `StallClass` 取值；`slice.json` 里
    `stall.class` 是 `{"type": ["string", "null"]}` —— 都不受本片影响。
    > **为什么这条不能省**：确认**不需要**改契约 schema。

12. **`npm test` 全绿、`npm run lint` 通过。**

13. **不越界** —— 改动只在写集内；
    `docs/adr/adr-142-*.md` 的规则正文不得改动。
    验证方式：`git status --porcelain` 断言改动路径全部落在写集内。

## 关键实现要点（规格里已定，实施时不要重新发明）

### 判定放在哪

- `classifyStall()` 只多一条规则：
  `if (signal.type === 'usage_limit') return 'usage_limit';`
- 识别文本的**纯函数**放 `src/core/stall/usage-limit.ts`（C3：不读文件）。
- `handleAgentFailure()` 调它。

**为什么不把输出传进 `classifyStall()`**：那会让 `core/` 的判定函数
依赖「输出从哪来」的形状。**调用方**读输出 → 判出 type → 传进去。

### 特征串

```
'rate limit' / 'rate_limit' / 'usage limit' / 'usage_limit'
/ 'quota' / '429' / 'too many requests' / 'overloaded'
/ 'insufficient_quota' / 'credit balance is too low'
```

固定串 → 纯文本判定 → 确定性（C3）。**不调模型、不猜。**

### reset time 的两种形态

- `resets at 2026-11-28T17:30:00Z` → 绝对时间 → `resetAt`
- `try again in 3600s` → 相对秒数 → `retryAfterSec`（**不换算**成绝对时间 ——
  换算要引入「现在几点」，那是推测）

两种都取不到 → `resetAt: null` + `retryAfterSec: null`（如实留空）。

### `handleAgentFailure` 的新参数是**可选**的

```ts
options?: { maxRetries?: number; agentOutput?: string }
```

不传 = 拿不到输出 = 识别不了 = 退回现状行为。
**但四个调用点都要传** —— 否则本片在真实路径上不生效。

## 边界（规格里已定，实施时不要越界）

- **不改**判定内核（`src/hook/`）、写集匹配、保护域；
- **不改**事件**类型**清单与事件契约 schema；
- **不改** `budget_exhausted` 的语义（那是 zelto 自己的预算闸门）；
- **不引入**第三方依赖；
- **`core/` 保持零第三方依赖**（C2），新增的 `usage-limit.ts` 只用 Node 内置。

## 一个自查提醒（实施时不要按直觉走）

**「配额耗尽也是失败的一种，归到 `environment_failure` 就行了」** —— 不行。

`environment_failure` 在 `isAutoResolvable()` 里 → **会自动重试**。
而配额墙**不会因为重试而恢复** —— 重试只是再撞一次同样的墙，
而且会**烧掉重试预算**（`stall.autoResolved`），
让下次真正需要重试的机会也没了。

**验收时要看的是「重试有没有发生」**，不是「分类对不对」。
