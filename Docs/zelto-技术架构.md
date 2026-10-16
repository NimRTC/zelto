# zelto 技术架构

> 版本: v0.1.0 · 最后更新: 2026-10-15

---

## 1. 架构总览

```
                    ┌──────────────────────────────────────┐
                    │            CLI (src/cli/)             │
                    │   commands.ts — 14 个命令 + help       │
                    └──────────────┬───────────────────────┘
                                   │
              ┌────────────────────┼────────────────────┐
              ▼                    ▼                    ▼
     ┌────────────────┐  ┌────────────────┐  ┌────────────────┐
     │   core/policy  │  │  core/slice    │  │  core/events   │
     │  策略规则引擎   │  │  切片状态机    │  │  append-only   │
     │  保护域判定     │  │  文件持久化    │  │  JSONL 流      │
     └────────────────┘  └────────────────┘  └────────────────┘
              │                    │                    │
              ▼                    ▼                    ▼
     ┌────────────────┐  ┌────────────────┐  ┌────────────────┐
     │  core/gate     │  │  core/sched    │  │  core/stall    │
     │  门禁执行器     │  │  并行准入      │  │  停机分类器    │
     │  签名管理器     │  │  约束分发      │  │  6 类停机      │
     └────────────────┘  └────────────────┘  └────────────────┘
              │                    │                    │
              ▼                    ▼                    ▼
     ┌────────────────┐  ┌────────────────┐  ┌────────────────┐
     │  core/clarify  │  │ core/metrics   │  │  core/audit    │
     │  澄清引擎       │  │  度量收集      │  │  审计追踪      │
     │  5 类问题       │  │  3 类指标      │  │  29 种摘要     │
     └────────────────┘  └────────────────┘  └────────────────┘

     ┌────────────────┐  ┌────────────────┐
     │  core/ports    │  │   hook/       │
     │  端口接口定义   │  │  独立判定进程  │
     │  4 个 Port     │  │  零依赖可执行  │
     └────────────────┘  └────────────────┘
```

### 1.1 依赖方向

```
hook/ → Node 内置（零依赖）
cli/ → core/*, Node 内置
core/ → Node 内置（零第三方运行时依赖）
adapters/ → core/ports（预留）
```

**核心原则 C6**: `core/` 不得 import `adapters/`。依赖单向向下。

---

## 2. 技术选型

| 层 | 技术 | 理由 |
|---|---|---|
| 语言 | TypeScript 7, strict: true | 类型安全，ESM 原生 |
| 运行时 | Node 22 | 内置 `node:test`, `node:fs`, `node:crypto` |
| 包管理 | pnpm 9 | 严格，速度快 |
| 测试 | `node --test` | 零测试框架依赖，Node 原生 |
| 格式化/Lint | Biome | 统一，零配置 |
| 运行时依赖 | **零** | `core/` 仅用 Node 内置模块 |
| 路径映射 | `@zelto/core/*` 等 | tsconfig paths |

---

## 3. 模块详解

### 3.1 Policy Engine — `src/core/policy/`

**文件**: `types.ts`, `engine.ts`

**职责**: 确定性策略判定。接收 path + operation，返回 allow / deny / ask。

**关键函数**:

```typescript
matchPath(pattern: string, path: string): boolean
  // Glob 转正则匹配，支持 **（多级）和 *（单段）

isProtectedPath(path: string): boolean
  // 硬编码保护域：policy/**, .zelto/**, AGENTS.md, .cursor/rules/**, zelto-hook

hashPolicy(content: string): string
  // sha256 策略哈希

evaluatePolicy(config, path, operation, policyVersion): PolicyDecision
  // 1. 保护域检查 → 2. 路径逃逸检查 → 3. 规则匹配（priority 排序，deny 优先）

checkAnchor(currentHash, anchorHash): { valid, mismatch }
  // 锚点校验：当前哈希 vs 锁定哈希
```

**判定优先级**:
1. 保护域（hardcoded）→ deny
2. 路径逃逸 → deny
3. 策略规则（按 priority 降序）→ deny 优先于 allow/ask
4. 默认 → deny

### 3.2 Slice State Machine — `src/core/slice/`

**文件**: `state.ts`, `store.ts`

**6 种状态**: `draft → clarifying → frozen → running → completed → abandoned`

**9 种事件**:
- `CLARIFY_START` (draft → clarifying)
- `CLARIFY_CONVERGED` (clarifying → draft)
- `FREEZE` (draft → frozen)
- `RUN_START` (frozen/completed → running)
- `RUN_FINISH` (running → frozen)
- `GATE_PASS` (frozen → completed)
- `SIGN_APPROVE` (completed → completed)
- `SIGN_REJECT` (completed → abandoned)
- `ABANDON` (任意 → abandoned)

**SliceData 结构**:
```typescript
interface SliceData {
  id: string;
  title: string;
  state: SliceState;
  spec: { path, frozenHash, frozenAt };
  acceptance: { dir, frozenHash, oracleSrc };
  baseCommit: string | null;
  drift: { detected, reason, at };
  trace: { requirements, contracts, tests };
  traceWaiver: string | null;
  writes: string[];
  runs: string[];
  stall: { class, autoResolved, gateRetries };
  createdAt: string;
  updatedAt: string;
}
```

**SliceStore**: 文件持久化到 `.zelto/slices/<id>.json`，`read/write/transit/create/list/exists`。

### 3.3 Event Stream — `src/core/events/`

**文件**: `stream.ts`

**格式**: append-only JSONL，每行一个 EventEnvelope。

```typescript
interface EventEnvelope {
  ts: string;           // ISO 8601
  runSeq: number;       // 单调递增
  slice: string;        // 切片 ID
  run: string | null;   // 运行 ID
  type: EventType;      // 29 种之一
  actor: string;        // 产生者
  payload: Record<string, unknown>;
}
```

**存储**: `.zelto/events/<sliceId>/events.jsonl`

**29 种事件类型**: 见场景功能地图 §5。

### 3.4 Gate Executor — `src/core/gate/`

**文件**: `types.ts`, `executor.ts`, `sign.ts`

**GateExecutor**: 运行配置的命令序列（如 `pnpm test`、`pnpm lint`），支持重试。

```typescript
class GateExecutor {
  async execute(sliceId, actor): GateReport
  // 按序执行命令 → 失败重试 → 记录事件
}

interface GateConfig {
  commands: GateCommand[];    // { name, run }
  changedLineCoverage: number;
  timeoutSec: number;
  retry: { max, budgetStepUsd };
}
```

**SignManager**: 签名请求生命周期。

```typescript
class SignManager {
  async request(sliceId, requestedBy): SignRequest
  async approve(id, decidedBy, comment): SignRequest
  async reject(id, decidedBy, comment): SignRequest
  async get(id): SignRequest
  async list(status?): SignRequest[]
  async delete(id): void
}
```

签名请求存储到 `.zelto/locks/sign-<sliceId>-<timestamp>.json`。

### 3.5 Stall Classifier — `src/core/stall/`

**文件**: `classifier.ts`

```typescript
type StallClass =
  | 'permission_prompt'    // hook 返回 ask
  | 'environment_failure'  // 构建/测试失败
  | 'context_exhaustion'   // max_turns 耗尽
  | 'cognitive_stuck'      // 同种失败 ≥ 3 次
  | 'plan_gate'            // agent 请求计划审批
  | 'budget_exhausted';    // 预算超限

function classifyStall(signal): StallClass
function isAutoResolvable(stallClass): boolean
  // permission_prompt / environment_failure / context_exhaustion 可自动恢复
```

### 3.6 Scheduler — `src/core/sched/`

**文件**: `types.ts`, `engine.ts`

**职责**:
1. 准入控制 — 切片必须 frozen 且有 frozenHash
2. 写集冲突检测 — 不能与 running 切片有路径重叠
3. 约束分发 — 生成 ConstraintBundle 供 agent 使用

```typescript
class Scheduler {
  async admit(sliceId, actor): SchedResult
  buildConstraints(slice): ConstraintBundle
  async startRun(sliceId, actor): SliceData
}
```

### 3.7 Clarify Engine — `src/core/clarify/`

**文件**: `engine.ts`

**5 类问题**:
1. **需求追溯** — 切片关联哪些需求？
2. **契约定义** — 需要定义哪些契约？
3. **验收测试** — 如何验收？
4. **写集** — 修改哪些文件？
5. **Oracle 来源** — 验收依据是什么？

支持 **self-answer** 模式：自动用默认值回答所有问题，适用于无人值守场景。

### 3.8 Metrics Collector — `src/core/metrics/`

**文件**: `collector.ts`

**3 类指标**:
| 指标 | 公式 | 单位 |
|---|---|---|
| rework_rate | gate.retry / gate.executed | ratio |
| cycle_time | 末事件时间 - 首事件时间 | seconds |
| stall_counts | stall.classified 事件数 | count |

### 3.9 Audit Trail — `src/core/audit/`

**文件**: `trail.ts`

为 29 种事件各定义摘要生成器。支持：
- `forSlice(sliceId)` — 获取结构化审计条目
- `toText(sliceId)` — 生成可读文本报告
- `latestEvent(sliceId, eventType)` — 获取最新事件

### 3.10 Ports — `src/core/ports/`

```typescript
interface SessionPort {    // agent 会话管理
  start, resume, stop, events
}
interface BudgetPort {     // 预算跟踪
  getSpent, getLimit, isExhausted
}
interface EventSinkPort {  // 事件写入
  append
}
interface HarnessMetaPort { // 执行器元信息
  id, version, capabilities
}
```

### 3.11 Hook — `src/hook/`

**文件**: `index.ts`

独立可执行进程，内联了 policy engine 的完整实现（零依赖）。

**协议**:
```
stdin:  {"path":"src/foo.ts","operation":"write","harness":"claude-code"}
stdout: {"decision":"allow","decision_id":"hook-...","basis":"...","policy_version":"sha256:...","matched_rule":"..."}
```

**决策流程**:
1. 读 policy.yaml → sha256 版本哈希
2. 保护域检查（硬编码）
3. 路径逃逸检查
4. 策略规则匹配（与 core/ 相同逻辑）
5. 返回决策

### 3.12 CLI — `src/cli/`

**文件**: `commands.ts`

14 个命令 + help，全部对接真实实现。配置从 `.zelto/config.yaml` 读取。

---

## 4. 数据流

### 4.1 创建切片

```
zelto create → SliceStore.create(id, title) → .zelto/slices/<id>.json
                → events.append('spec.drafted')
```

### 4.2 澄清流程

```
zelto clarify → ClarifyEngine.generateQuestions(slice)
                → events.append('clarify.question')
                → 人回答问题
                → ClarifyEngine.applyAnswers(slice, answers)
                → events.append('clarify.answer')
                → transitionSlice('CLARIFY_CONVERGED')
```

### 4.3 冻结流程

```
zelto freeze → check 门禁①
               → slice.spec.frozenHash = sha256(spec)
               → store.transit('FREEZE')
               → events.append('spec.frozen')
```

### 4.4 执行流程

```
zelto run → Scheduler.admit(sliceId)
             ├── blocked → events.append('sched.blocked')
             └── admitted → Scheduler.startRun(sliceId)
                              → events.append('sched.admitted')
                              → events.append('run.started')
                              → 拉起 agent（带 ConstraintBundle）
```

### 4.5 门禁流程

```
zelto gate → GateExecutor.execute(sliceId)
              → events.append('gate.executed')
              → for each command:
                  run → 失败 → retry → events.append('gate.retry')
              → events.append('gate.result')
              → 全部通过 → transitionSlice('GATE_PASS')
```

### 4.6 签名流程

```
zelto sign --approve → SignManager.request(sliceId)
                        → events.append('sign.requested')
                        → SignManager.approve(id, 'human')
                        → events.append('sign.approved')
```

---

## 5. 架构约束实现

| 约束 | 实现方式 |
|---|---|
| **C1** 状态只在文件里 | `SliceStore` 读写 `.zelto/slices/*.json`；`EventStream` 追加 `.zelto/events/*/events.jsonl` |
| **C2** core/ 无 SDK | `package.json` 无运行时 dependencies；只 import `node:*` |
| **C3** 确定性 | policy 无网络无模型；gate 仅 spawn 子进程；sched 纯计算 |
| **C4** append-only | `EventStream.append()` 使用 `appendFile`；无 delete/update |
| **C5/C8** 保护域 | `PROTECTED_PATTERNS` 硬编码常量，策略规则无法覆盖 |
| **C6** 单向依赖 | tsconfig 无反向路径映射；代码级无 import 从 adapters 到 core |
| **C7** llm 不判定 | `llm/` 目录预留；所有判定模块（policy/gate/sched）不引用 llm |
| **C9** 写集预约 | `Scheduler.admit()` 检查 running 切片的 writes 数组 |

---

## 6. 安全边界

### 6.1 保护域（不可绕过）

```
policy/**
.zelto/**
AGENTS.md
.cursor/rules/**
zelto-hook
zelto-hook.exe
```

### 6.2 路径逃逸检测

```
../outside  → deny
/absolute   → deny
C:\path     → deny
```

### 6.3 判定分层

```
┌─────────────────────────────────────┐
│  ① 保护域（hardcoded, 最高优先级）   │
├─────────────────────────────────────┤
│  ② 路径逃逸检测                      │
├─────────────────────────────────────┤
│  ③ 策略规则（policy.yaml, 可配置）   │
├─────────────────────────────────────┤
│  ④ 默认 deny（无匹配规则时）          │
└─────────────────────────────────────┘
```

---

## 7. 测试架构

### 7.1 测试框架

使用 Node 原生 `node:test` + `node:assert/strict`。零测试框架依赖。

### 7.2 测试策略

| 层级 | 覆盖 | 方法 |
|---|---|---|
| 单元测试 | 每个核心模块 | 纯函数测试，mock 文件系统 |
| Hook 集成 | 独立进程 | spawn child_process，stdin/stdout |
| 验收测试 | 端到端 | 预留 `tests/acceptance/` |

### 7.3 当前覆盖

- **101 tests, 23 suites, 全部通过**
- 核心模块覆盖率 > 90%
- Hook 可执行体 7 个集成测试

---

## 8. 未来架构方向

### 8.1 adapters/ 实现

Port 接口已定义，待实现：
- `adapters/claude-agent-sdk` — Claude Agent SDK 适配器
- 其他 agent 平台适配器

### 8.2 llm/ 集成

`llm/` 目录预留，用于：
- 丰富澄清问题生成（现为规则引擎）
- 语义发现（代码库分析）
- **不参与任何判定**

### 8.3 验收测试

`tests/acceptance/` 预留，用于端到端验收测试。

---

## 附录 A：关键接口一览

```typescript
// Policy
matchPath(pattern, path): boolean
isProtectedPath(path): boolean
hashPolicy(content): string
evaluatePolicy(config, path, operation, policyVersion): PolicyDecision
checkAnchor(currentHash, anchorHash): { valid, mismatch }

// Slice
transitionSlice(current, event): SliceState
SliceStore.read(id): SliceData
SliceStore.write(slice): void
SliceStore.transit(id, event, by): SliceData
SliceStore.create(id, title, opts): SliceData

// Events
EventStream.append(sliceId, type, actor, payload, runId): EventEnvelope
EventStream.read(sliceId): EventEnvelope[]

// Gate
GateExecutor.execute(sliceId, actor): GateReport
SignManager.request(sliceId, requestedBy): SignRequest
SignManager.approve(id, decidedBy, comment): SignRequest
SignManager.reject(id, decidedBy, comment): SignRequest

// Stall
classifyStall(signal): StallClass
isAutoResolvable(stallClass): boolean

// Sched
Scheduler.admit(sliceId, actor): SchedResult
Scheduler.buildConstraints(slice): ConstraintBundle

// Clarify
ClarifyEngine.generateQuestions(slice, round): ClarifyRound
ClarifyEngine.applyAnswers(slice, answers): SliceData
ClarifyEngine.runRound(slice, round, actor, selfAnswer): ClarifyRound

// Metrics
MetricsCollector.reworkRate(sliceId): MetricSnapshot | null
MetricsCollector.cycleTime(sliceId): MetricSnapshot | null
MetricsCollector.stallCounts(sliceId): MetricSnapshot
MetricsCollector.generateReport(sliceIds): MetricsReport

// Audit
AuditTrail.forSlice(sliceId): AuditReport
AuditTrail.toText(sliceId): string
AuditTrail.latestEvent(sliceId, eventType): EventEnvelope | null
```

## 附录 B：文件路径约定

| 路径 | 用途 |
|---|---|
| `.zelto/slices/<id>.json` | 切片持久化 |
| `.zelto/events/<id>/events.jsonl` | 事件日志 |
| `.zelto/locks/sign-<id>-<ts>.json` | 签名请求 |
| `.zelto/config.yaml` | 项目配置 |
| `policy/policy.yaml` | 策略规则 |
| `policy/lock.json` | 策略锚点 |
| `specs/slices/<id>.md` | 切片规格 |
| `tests/acceptance/<id>/` | 验收测试 |
| `contracts/schemas/*.json` | JSON Schema 真源 |
