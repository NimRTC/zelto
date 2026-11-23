# ADR-102: agent 环境里的「未展开的 `${VAR}` 占位符」—— 剔除，而不是就地展开

**状态**: 已实现（2026-11-23）
**日期**: 2026-11-23
**作者**: 系统架构
**关联约束**: C2, C3, C4
**关联文档**: `docs/adr-026-env-var-refs-in-config.md`,
`docs/adr-090-agent-env-and-credentials.md`,
`docs/实战缺陷记录-nimrtc-v14.md`

---

## 1. 摘要

agent 子进程的环境里可能残留**没展开的 `${VAR}` 占位符**（例如
`ANTHROPIC_API_KEY="${NIMRTC_LLM_API_KEY}"`）。这样的值对 agent **毫无用处**，
却会**顶掉**一个本来能用的凭据来源 —— 于是 agent 秒退（401），
症状看起来像「agent 干了活但没改文件」。

本 ADR 规定：**值是 `${VAR}` 形状 → 当它不存在**，让 agent 回落��
下一个来源（`ANTHROPIC_AUTH_TOKEN` → `~/.claude/settings.json` → `~/.claude/.credentials.json`）。

---

## 2. 动机

### 2.1 现场（实测 nimrtc-v14 v1-ice-recovery，2026-11-23）

`zelto run v1-ice-recovery --agent --detach` 起了一个监督进程，agent 起来后
**约 3 分钟**就退出，退出码 1。zelto 判成 `environment_failure`，
自动重试两次，三次都是同样的结果。

会话文件里是答案：

```json
{
  "terminal_reason": "api_error",
  "api_error_status": 401,
  "result": "Failed to authenticate. API Error: 401 Invalid token",
  "num_turns": 1
}
```

### 2.2 为什么「401」查起来费劲

症状是「agent 跑了 3 分钟、退出码 1、零文件改动」——
这与「agent 上下文超限」「agent 写错了」「环境没配好」**长得一样**。

真正的线索在两个地方，都不在 zelto 的报错里：

1. **凭据来源被顶掉了**。Claude Code 取凭据的顺序是
   `ANTHROPIC_API_KEY` **优先于** `ANTHROPIC_AUTH_TOKEN`。
   而后者在 `~/.claude/settings.json` 的 `env` 块里，本来是好的。
   进程环境里那个占位符把它**顶掉了**。
2. **占位符是「带引号」的**：`ANTHROPIC_API_KEY="${NIMRTC_LLM_API_KEY}"` ——
   连引号一起留在环境里（`set VAR="${OTHER}"` 而 `OTHER` 没展开时的产物）。

### 2.3 实测验证

同一把 key，只换「值是不是占位符」，结果相反：

| 用的 key | HTTP |
|---|---|
| `"${NIMRTC_LLM_API_KEY}"`（占位符） | **401** Invalid token |
| 真实 key | **200**，正常返回 message |

把 `ANTHROPIC_API_KEY` 从环境里去掉后跑 Claude Code：
`api_error_status: null`、`terminal_reason: "completed"`、`is_error: false`。
（`~/.claude/settings.json` 的 `ANTHROPIC_AUTH_TOKEN` 接管了。）

---

## 3. 决策

### 3.1 剔除，而不是就地展开

在 `mergeAgentEnv`（`src/cli/commands/shared.ts`）里，
**凡��整串是 `${NAME}` 形状的值，一律从 agent 的 spawn env 里剔掉**。

「就地展开」看起来更自然，但**语义不对**：

- 引用源（`NIMRTC_LLM_API_KEY`）**不一定**是 agent 该用的那个凭据 ——
  规格起草用的模型和 agent 执行的模型本就该分开（`agent.model` vs `llm.model`）；
- 展开需要知道「展开成什么」，而占位符的引用源可能是**另一个系统**留下的痕迹。

剔除 = 让 Claude Code **自己按它的优先级**去找凭据，语义更对。

### 3.2 带引号也算

判据用 `parseEnvRef`（ADR-026 的口径），但**先剥掉成对引号**：

```
"${NIMRTC_LLM_API_KEY}"   → 占位符 → 剔除
${NIMRTC_LLM_API_KEY}     → 占位符 → 剔除
prefix-${NAME}            → 不是（刻意拼的字符串）
"${VAR}                   → 不是（引号不成对）
```

`parseEnvRef` **不改** —— 它服务于 `llm.apiKey` 的展开，
那里 YAML 引号在解析时已经被剥掉了。改动它会波及那条路径。

### 3.3 不改变覆盖方向

剔除只针对「占位符形状」，**不改变** `process.env` < `agent.env` 的优先级
（ADR-090）。`agent.env` 里的真实值照样顶掉 `process.env`。

### 3.4 惰性拷贝

没有占位符时**原样返回入参**（不拷贝）——
`mergeAgentEnv` 的既有契约被 `tests/cursor-agent-adapter.test.ts` 依赖
（引用相等）。有占位符才建新对象。

---

## 4. 后果

### 4.1 正面

- agent 的凭据来源不再被「死值」顶掉 —— 这是**静默**故障（秒退 + 零改动），
  代价是**整轮** agent 时间 + 一次人肉误判（怀疑自己的代码）。
- 判据是**形状**（`${VAR}`），不依赖具体变量名 ——
  对所有「配置里写了引用、环境里没展开」的变量都成立。

### 4.2 需要接受的代价

- 进程环境里那些占位符**不再传给 agent**。
  如果某个 agent 真的**需要**看到「未展开的引用」（极少见），
  它得从别处拿（例如 `agent.env` 里显式写死值）。
- 这是**丢弃**，不是「改写成别的值」——
  丢的是「agent 用不上的值」，不是「agent 需要但被改错的值」。

---

## 5. 判据的可测形式

`tests/agent-env-placeholder-strip.test.ts`（12 条）：

1. 整串 `${VAR}` → 剔除；
2. 引用目标**存在**时也剔除（值本该是展开后的真值）；
3. `prefix-${VAR}` → **不剔**；
4. `"${VAR}"`（带引号）→ 剔除；
5. `"${VAR}`（引号不成对）→ **不剔**；
6. 没占位符时**原样返回 base**（引用相等，既有契约）；
7. `agent.env` 的真实值不被 `process.env` 的占位符顶掉。

---

## 6. 另一条相关的路（不是本 ADR 的范围）

`claude-agent-sdk` 适配器原先拿 `llm.model`（**规格起草**用的模型）当
agent 的模型。Claude Code 不认识那个模型名 → agent 秒退，
症状同样是「退出码 0、零改动」。

修法是给 `agent:` 段加一个**独立的** `model:` 键（见
`src/core/config/loader.ts` 与 `tests/config-agent-model.test.ts`）。
两条路的**共同教训**：
**agent 的模型与 agent 的凭据，都必须与「规格起草」那条路分开。**
