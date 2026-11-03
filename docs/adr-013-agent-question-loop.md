# ADR-013: Agent 提问回路与停机续跑

**状态**: 已实现
**日期**: 2026-11-03
**作者**: 系统架构
**关联约束**: C1, C2, C3, C4, C6, C7, C9
**关联文档**: `docs/zelto-并行自治计划.md` §4 切片 B, `docs/adr-011-worktree-isolation.md`, `docs/adr-012-parallel-coordination.md`

---

## 1. 摘要

本 ADR 引入 **提问回路（question loop）**：agent 以问题收尾时，zelto 不再把它当成
「运行成功」，而是记录一条待答问题、挂起该切片；人通过 `zelto answer` 回答后，
**同一会话**被续跑，无需重新 `run`。

对应计划条目：`docs/zelto-并行自治计划.md` §4 切片 B `agent-question-loop`。

---

## 2. 动机

### 2.1 现状

| 事实 | 位置 | 影响 |
|---|---|---|
| agent 退出码为 0 一律记为「运行成功」 | `src/cli/commands/core-slice.ts:1048` | agent 以问题收尾时，问题被吞成成功 |
| 停机分类器有 7 类，调用点只喂 `type: 'test_failure'` | `src/core/stall/classifier.ts:7` vs `src/cli/commands/core-slice.ts:1528` | 6 类永远不会被判定出来 |
| `isAutoResolvable` 把 `environment_failure` 视为可自动解决 | `src/core/stall/classifier.ts:28` | 所有非零退出都被当成环境故障重试，掩盖真实原因 |
| adapter 能力声明 `resume: false` / `events: false` | `src/adapters/claude-agent/index.ts:91` | 回答之后无法接回原会话 |
| `resume()` 直接抛异常 | `src/adapters/claude-agent/index.ts` | 续跑路径完全不存在 |
| 没有 `zelto ask` / `zelto answer` | — | 人看不到待答问题，也没有回答入口 |

### 2.2 典型场景

```
场景：agent 实现到一半，发现规格里没写清「找不到资源时返回 404 还是 422」。
→ agent 退出码 0，zelto 记「运行成功」，自动跑门禁。
→ 门禁失败，原因不明，人去翻日志才发现 agent 一直在问。
→ 人回答了，agent 早就不在了——只能重新 run，前面的工作全部重来。
```

---

## 3. 设计

### 3.1 提问协议（确定性，不依赖模型判定）

agent 用一个**固定标记**在输出末尾提出问题。zelto 用纯文本解析该标记——
解析是确定性的字符串处理，不调用模型、不触网（满足 C3）。

标记格式：

```
<<<ZELTO_QUESTION
type: spec_gap | choice | blocker
question: 找不到资源时该返回 404 还是 422？
options: 404 | 422 | 409
>>>
```

- `type` 三选一：`spec_gap`（规格缺口）/ `choice`（二选一）/ `blocker`（阻塞）
- `options` 可选，用 `|` 分隔
- 标记必须出现在输出的**最后**一块，zelto 只解析尾部

**严重度（severity）由 type 确定性推导**，不由 agent 自报：

| type | severity | 含义 |
|---|---|---|
| `spec_gap` | `blocking` | 规格没写，无法继续——必须等人 |
| `choice` | `blocking` | 有多个可行选项，需要人拍板——必须等人 |
| `blocker` | `blocking` | 明确阻塞——必须等人 |

即：**所有经协议提出的问题都是阻塞型**。非阻塞问题不通过提问协议表达——
agent 若只是想同步进度，直接写在输出里即可。`non_blocking` 保留在类型里，
是为了让队列能承载未来「不打断批次、只入队」的场景（见 §3.5）。

> **为什么不让 agent 自报 severity**：自报严重度等于让模型参与判定（违反 C3/C7）。
> 类型→严重度的映射写死在 `core/question/`，是纯规则。

### 3.2 问题队列

问题状态落在 `.zelto/questions/<id>.json`（C1：状态只在文件里）：

```typescript
interface QuestionRecord {
  id: string;              // q-<sliceId>-<timestamp>
  sliceId: string;
  type: 'spec_gap' | 'choice' | 'blocker';
  severity: 'blocking' | 'non_blocking';
  question: string;
  options: string[];
  status: 'pending' | 'answered';
  askedAt: string;
  answeredAt: string | null;
  answer: string | null;
  /** 提问时的 agent 会话 id —— 续跑时用它接回同一会话 */
  agentSessionId: string | null;
}
```

### 3.3 事件流新增类型

| 事件 | 触发点 | 关键 payload |
|---|---|---|
| `question.raised` | agent 提出问题 | `questionId`, `sliceId`, `type`, `severity`, `question`, `options` |
| `question.answered` | 人回答了问题 | `questionId`, `answer`, `answeredBy` |

`agent.resumed` 已存在，用于续跑；`stall.classified` 复用，新增 `class: 'agent_question'`。

### 3.4 会话续跑

**验证结论（本机实测，Claude Code CLI 2.1.317）**：

| 验证项 | 结果 |
|---|---|
| `--print --output-format json` 返回 `session_id` | ✅ |
| `--print --resume <session_id>` 能接回同一会话 | ✅（`cache_read` 显示历史已进入上下文，模型正确回答了上一轮的问题） |
| `--print --session-id <uuid>` 可指定会话 id | ✅ |
| `--print --session-id X` 之后再 `--resume X` | ✅（模型正确回忆了 4242 这个数字） |

因此 `ClaudeAgentAdapter` 的做法：

1. `start()` 时若配置了 `sessionId`，加 `--session-id <uuid>`；否则从
   `--output-format json` 的结果里取回 `session_id` 存入会话文件
2. `resume(sessionId, patch)` 时用 `--resume <session_id>` + 答案文本重新拉起
   agent；**agent 的工作目录不变**，仍在该切片的 worktree 里
3. 能力声明改为 `resume: true`

> **为什么不用 SDK 的 `resume` 选项**：`@anthropic-ai/claude-agent-sdk` 的
> `Options.resume` 存在（`sdk.d.ts:2120`），但 SDK 适配器在无凭据环境下会
> 挂住整个测试进程（`scripts/filter-tests.mjs` 已将其列为 hanging）。
> 默认适配器是 shell spawn 的 `claude-agent`，它在真实项目里被使用，
> 所以续跑能力优先实现在它上面。SDK 适配器的 `resume` 保持现状（它已经声明
> `resume: true` 但实现是「拼上下文重新问」，不是真续跑）——这是已知缺陷，
> 本 ADR 不修，因为它是 SDK 适配器自身的语义问题，且不影响默认路径。

### 3.5 阻塞与非阻塞

- **阻塞问题**：挂起该切片（`slice.stall.class = 'agent_question'`），
  写 `question.raised` 事件，**不**跑门禁，**不**进签字流程。
  并行批次中的其它切片不受影响。
- **非阻塞问题**：只入队 + 写事件，不挂起切片，不打断批次。

### 3.6 数据流

```
1. zelto run <id>
   ├── agent 在 worktree 内执行
   ├── agent 退出
   └── 解析输出尾部：
       ├── 无标记 → 正常收尾：跑门禁 → 签字请求
       └── 有标记 → 提问收尾：
           ├── 写 question.raised 事件
           ├── 写入 .zelto/questions/<id>.json
           ├── slice.stall.class = 'agent_question'
           └── 提示：zelto answer <questionId> "<答案>"

2. zelto answer <questionId> "<答案>"
   ├── 写 question.answered 事件
   ├── 以 --resume <agent_session_id> + 答案文本重新拉起 agent（同一 worktree）
   ├── agent 再次退出 → 回到步骤 1 的解析分支
   └── 若不再提问 → 跑门禁 → 签字请求
```

### 3.7 CLI 接口

```
zelto ask                          列出所有待答问题
zelto ask --slice <id>            只看某个切片的待答问题
zelto ask --json                  JSON 输出
zelto answer <questionId> "<答案>" 回答问题并续跑该切片
zelto answer --list               列出待答问题（同 ask）
```

---

## 4. 约束合规性检查

| 约束 | 检查 | 合规 |
|---|---|---|
| **C1** | 问题状态写在 `.zelto/questions/*.json`；会话 id 写在 `.zelto/sessions/*.json` | ✅ |
| **C2 / C6** | `src/core/question/` 只用 Node 内置模块，不 import `adapters/` | ✅ |
| **C3** | 提问标记解析与 type→severity 映射是纯字符串/查表，无模型、无网络 | ✅ |
| **C4** | 每个问题、每条答案各写一条 append-only 事件 | ✅ |
| **C5 / C8** | 未改动保护域与策略锚点 | ✅ |
| **C7** | agent 自报的内容只作为「问题文本」被记录，不参与任何判定；严重度由规则推导 | ✅ |
| **C9** | 续跑仍在该切片的 worktree 内，写集预约不受影响 | ✅ |

---

## 5. 替代方案

### 方案 A：用模型判断 agent 是否在提问

**放弃理由**：违反 C3（判定必须确定性）与 C7（LLM 产出不参与判定）。
标记协议让 agent 显式声明，zelto 只做字符串解析——既确定又零成本。

### 方案 B：让 agent 把问题写进某个文件

**放弃理由**：需要 agent 知道 zelto 的内部文件布局，且写文件属于写集外的动作，
会触发保护域判定。输出末尾的标记更简单，也不越界。

### 方案 C：直接重跑整个切片（退化方案）

**这是本 ADR 的 fallback**。若 Claude Code CLI 未来不再支持 `--print --resume`，
则按 `docs/zelto-并行自治计划.md` §4 切片 B 的风险项退化为「重跑该切片」，
并在本 ADR 记录差异。**当前验证通过，不启用退化。**

### 方案 D：把问题队列放进内存

**放弃理由**：违反 C1（状态只在文件里）。进程退出后问题就丢了，人回来就看不到。

---

## 6. 决定

1. 采用**标记协议**：agent 在输出末尾用 `<<<ZELTO_QUESTION ... >>>` 提问，
   zelto 做确定性文本解析
2. 严重度由 type 确定性推导，不让 agent 自报
3. 问题状态落在 `.zelto/questions/`，问题与答案各写一条事件
4. `ClaudeAgentAdapter` 实现真续跑：`--session-id` + `--resume`，工作目录不变
5. 阻塞问题挂起单个切片，不影响并行批次中的其它切片
6. 提问回路的引入**不改变门禁与签字流程**——续跑成功后才进入原有链路
