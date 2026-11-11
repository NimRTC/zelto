# zelto 技术架构

> 版本: v0.3.0 · 最后更新: 2026-11-04
> 项目定位见 `docs/zelto-项目目标.md`；功能全貌见 `docs/zelto-场景功能地图.md`

---

## 0. 架构服务什么

zelto 是「一个人 + 一组 agent」做中大型项目时的**驾驶舱**，分三段：

| 段 | 谁主导 | 架构职责 | 对应层 |
|---|---|---|---|
| **规划** | 人 | 把方案设计、版本规划、模块划分、切片设置落成**可判定的结构化约束** | 规划层 `core/require·design·version` |
| **高速并行** | zelto | 把切片拆成互不冲突的写集，隔离执行，运行时逐写判定 | 编排层 `core/sched·worktree` + `src/hook/` |
| **拉闸** | 人接手 | 越界当场拦下、卡住挂起、停机分类、事后可查可定责 | 治理层 `core/policy·gate·stall·audit` |

三段共用同一个底座：**append-only 事件流**（`core/events`）。
它是追溯链的载体——没有它，规划层的约束无法校验、拉闸时无法定责、交付后无法复盘。

下面的架构分层，就是按这三段 + 一个底座组织的。

---

## 1. 架构总览

```
                    ┌──────────────────────────────────────┐
                    │            CLI (src/cli/)             │
                    │   commands/ — 59 个命令              │
                    └──────────────┬───────────────────────┘
                                   │
        ┌──────────────────────────┼──────────────────────────┐
        ▼                          ▼                          ▼
┌───────────────┐        ┌─────────────────┐        ┌─────────────────┐
│  规划层       │        │   编排层        │        │   治理层        │
│ core/require │        │ core/sched      │        │ core/policy     │
│ core/design  │        │ core/worktree   │        │ core/gate       │
│ core/version │        │ core/question   │        │ core/stall      │
│ （需求/设计/  │        │ core/slice      │        │ core/spec       │
│  版本状态）   │        │ （准入/写集/    │        │ core/audit      │
│ llm/ 仅产草稿 │        │  隔离/提问）    │        │ core/contracts  │
└───────────────┘        └─────────────────┘        └─────────────────┘
        │                          │                          │
        └──────────────────────────┼──────────────────────────┘
                                   ▼
                    ┌──────────────────────────────────────┐
                    │  core/events — append-only 事件流    │
                    │  58 种事件 · 判定留痕 · 追溯的底座    │
                    └──────────────────────────────────────┘

     ┌────────────────┐  ┌────────────────┐  ┌────────────────┐
     │  src/hook/     │  │ src/adapters/  │  │  src/llm/      │
     │  独立判定进程   │  │  执行器适配器   │  │  草案生成       │
     │  + PreToolUse  │  │  claude-agent  │  │  不参与判定     │
     └────────────────┘  └────────────────┘  └────────────────┘
```

### 1.1 依赖方向

```
hook/ → Node 内置（零依赖）
cli/ → core/*, Node 内置
core/ → Node 内置（零第三方运行时依赖）
adapters/ → core/ports（预留）
```

**核心原则 C6**: `core/` 不得 import `adapters/`。依赖单向向下。

### 1.2 分层职责

| 层 | 职责 | 判定性质 |
|---|---|---|
| **规划层** | 需求 → 设计（模块划分）→ 版本计划 → 切片规格 | LLM 产出**草稿**，人 `confirm`；不参与任何判定（C7） |
| **编排层** | 并行准入、写集解析与冲突、worktree 隔离、agent 提问 | **确定性**（C3） |
| **治理层** | 策略判定、门禁验收、停机分类、规格校验、审计 | **确定性**（C3） |
| **事件层** | 所有动作的 append-only 留痕 | 追溯链的底座（C4） |

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

**文件**: `state.ts`, `store.ts`, `kind.ts`

`kind.ts` 是**切片的分类**（`SliceType`：code / docs / config / refactor）的定义处，零 import（ADR-031）。
`core/gate` 侧保留 re-export 兼容旧路径，`detectSliceType` 仍住在 gate —— 它是门禁选 profile 的逻辑。

**6 种状态**: `draft → clarifying → frozen → running → completed → abandoned`

**10 种事件**:
- `CLARIFY_START` (draft → clarifying)
- `CLARIFY_CONVERGED` (clarifying → draft)
- `FREEZE` (draft → frozen)
- `REFREEZE` (frozen → draft) — 人确认新规格后重新冻结（ADR-037）
- `RUN_START` (frozen/completed → running)
- `RUN_FINISH` (running → frozen) — 也用于**写集越界后退回 frozen**（ADR-037）
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
  runs: SliceRun[];              // 运行记录：每次 agent 运行结束追加一条
  clarifyRounds?: number;        // 已走过的澄清轮次（单调递增）
  stall: { class, autoResolved, gateRetries };
  createdAt: string;
  updatedAt: string;
}

interface SliceRun {
  at: string;          // 运行结束时刻（ISO 8601）
  ok: boolean;         // agent 进程是否正常退出
  exitCode: number | null;
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
  type: EventType;      // 58 种之一
  actor: string;        // 产生者
  payload: Record<string, unknown>;
}
```

**存储**: `.zelto/events/<sliceId>/events.jsonl`

**58 种事件类型**: 见场景功能地图 §5。事件类型的真源是
`contracts/schemas/event-envelope.json` 的 enum —— 代码与契约不允许不一致。

这份清单由 `stream.ts` 的 `EVENT_TYPES`（运行时数组）承载，`EventType` 联合类型派生自它，
`audit/trail.ts` 的摘要表键类型是 `Record<EventType, ...>`，
`tests/event-contract-parity.test.ts` 在测试期把三方对账 ——
所以「代码能发、契约不认」这件事不会等到人工审计才发现。

**版本级事件**用 `version-<label>` 作归属键（版本不是切片，事件流按切片分目录），
见 `docs/adr-017-version-level-orchestration.md`。

### 3.4 Gate Executor — `src/core/gate/`

**文件**: `types.ts`, `executor.ts`, `sign.ts`

`types.ts` 从 `core/slice/kind.ts` re-export `SliceType`（定义归 slice 域，ADR-031）。

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
  | 'budget_exhausted'     // 预算超限
  | 'gate_retry'           // 门禁重试耗尽
  | 'agent_question'       // agent 提问，等人回答（ADR-013）
  | 'human_halt';          // 人工拉闸，等人处理现场（ADR-020）

function classifyStall(signal): StallClass
function isAutoResolvable(stallClass): boolean
  // permission_prompt / environment_failure / context_exhaustion 可自动恢复
  // agent_question / human_halt 永远不可自动恢复 —— 都要人介入
```

### 3.6 Scheduler — `src/core/sched/`

**文件**: `types.ts`, `engine.ts`

**职责**:
1. 准入控制 — 切片必须 frozen 且有 frozenHash
2. 写集冲突检测 — 不能与 running 切片有路径重叠
3. 约束分发 — 生成 ConstraintBundle 供 agent 使用
4. 恢复执行 — `resume()` 方法处理 stalled slice 恢复

```typescript
class Scheduler {
  async admit(sliceId, actor): SchedResult
  buildConstraints(slice): ConstraintBundle
  async startRun(sliceId, actor): SliceData
  async resume(sliceId, options): void  // skip/abandon/retry
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

为 58 种事件各定义摘要生成器。支持：
- `forSlice(sliceId)` — 获取结构化审计条目
- `toText(sliceId)` — 生成可读文本报告
- `latestEvent(sliceId, eventType)` — 获取最新事件

### 3.10 SpecMdExecutor — `src/core/spec/`

**文件**: `SpecMdExecutor.ts`

**职责**: 从结构化 Markdown 规格文件（`specs/slices/<id>.md`）中解析 `## Spec` 和 `## Checklists` 章节，直接驱动验证流程，消除规格→测试的翻译损耗。

```typescript
class SpecMdExecutor {
  constructor(sliceRoot: string)        // sliceRoot = specs/slices/

  parse(sliceId: string): ParsedSpec
  // 返回 { spec: string, checklists: string[] }

  validate(sliceId: string): ValidationResult
  // 检查文件存在、## Spec 章节、## Checklists 章节、非空条目

  runChecklists(sliceId: string): Promise<ChecklistResult[]>
  // 对每个 checklist 条目执行验证
}
```

**集成**:
- CLI: `zelto spec-md validate|run <slice-id>`
- Gate: `zelto gate --spec-md` 批量校验所有新格式规格
- 旧格式文件（无 `## Spec` 章节）自动跳过，不报错

### 3.11 Ports — `src/core/ports/`

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

### 3.12 Hook — `src/hook/`

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

### 3.13 CLI — `src/cli/`

**文件**: `commands/`（按域拆分）+ `commands/catalog.ts`（命令目录唯一真源）

59 个命令，全部对接真实实现。配置从 `.zelto/config.yaml` 读取。

`catalog.ts` 是「有哪些命令、怎么用、分在哪组」的**唯一真源**：
`zelto help`、`zelto help <cmd>`、shell 补全脚本三者都从它出。
新增命令只要在 `COMMAND_CATALOG` 加一行，help 与补全自动跟上；
`tests/cli-catalog.test.ts` 守着「注册了的命令必须在目录里、目录里不能有没实现的命令」。

### 3.14 规划层存储 — `src/core/requirements/` / `design/` / `version/`

三段规划各自有独立的文件化状态（C1）：

| 模块 | 状态文件 | 内容 |
|---|---|---|
| `core/requirements/` | `.zelto/requirements/<id>.json` | 需求文档、验收标准、`draft → confirmed` |
| `core/design/` | `.zelto/designs/<id>.json` | 设计正文、**模块划分**（name / files / deps）、`draft → confirmed` |
| `core/version/` | `.zelto/versions/<id>.json` | 版本计划（versions / slices / dependsOn）、版本状态 |
| `core/review/` | `.zelto/revisions/<kind>/<id>/*.json` | 草稿修订快照——refine 之前留一份，diff 才有得可对（ADR-023） |

**版本状态机**：`planned → in_progress → integrated → delivered`
（ADR-017 新增 `integrated` 中间态：版本级验收通过但尚未交付）。

**草稿评审**（ADR-023）：`core/review/` 是纯计算层——
`diff.ts`（行级 LCS diff）、`decision-points.ts`（决策点抽取）、
`review.ts`（`buildDraftReview`）、`revisions.ts`（快照存储）。
决策点按稳定 id 跨版本对齐，标出新增 / 移除 / 变更。
判定不调模型、不触网（C3），快照只落在文件里（C1）。

模块划分（`DesignDoc.modules`）过去是**文档级**的——
它描述了模块边界，但没有被校验过。现在 `core/arch/` 会拿它跟代码里实际的
import 图比一遍，出偏离报告（`zelto arch check`，见 §3.18），
再按 `policy.yaml` 的 `arch:` 段定级成护栏结论（G-4/A，ADR-027）。

**模块声明以设计正文为真源**（ADR-029）：`DesignDoc.body` 是人读的 Markdown，
`DesignDoc.modules` 只是给人看的快照；判定时一律经 `core/design/derive.ts`
的 `deriveModules()` 从正文重新推导。解析口径只有一份
（`core/design/parse.ts`），「什么算空」也只有一份（`core/text/normalize.ts`）。

### 3.15 编排层 — `src/core/worktree/` / `question/` / `sched/`

| 模块 | 职责 |
|---|---|
| `core/worktree/manager.ts` | 建/查/删 worktree，路径固定 `.zelto/worktrees/<sliceId>`（ADR-011） |
| `core/question/protocol.ts` | agent 以提问收尾 → 挂起该切片 → 回答后续跑（ADR-013） |
| `core/sched/engine.ts` | 准入、写集冲突检测、约束分发 |
| `core/sched/batch.ts` | 批次审核、依赖分层（`planBatchPhases`）、工件冲突 |
| `core/sched/depgraph.ts` | 依赖图与环检测（Kahn 拓扑排序） |
| `core/sched/merge.ts` | 合并计划与冲突可见（ADR-012） |
| `core/sched/reservation.ts` | 写集预约文件，C9 的落地载体 |

### 3.16 单一并行执行实现 — `src/cli/commands/parallel-executor.ts`

`executeSlicesParallel()` 是**唯一**的并行执行实现，
`zelto run --parallel` 与 `zelto version start` 共用（ADR-017）。

为什么要共用：版本层若另写一份，迟早漏掉 worktree 隔离或写集预约守卫——
漏掉隔离 → agent 互相覆盖；漏掉预约 → 越界写入无人拦（C9）。

六个阶段（准入 → 写集解析 → 冲突检测 → 隔离与守卫 → 拉起 agent → 收尾）
详见 `docs/zelto-场景功能地图.md` §2.5。

### 3.17 显式合并 — `src/cli/commands/merge*.ts`

**文件**: `merge.ts`（命令入口）、`merge-runner.ts`（候选收集 / worktree 提交 / 清理 / 推送）、
`merge-plan.ts`（计划构建）、`merge-executor.ts`（计划执行）

合并是**签字之后的唯一归并路径**（ADR-018）。四个文件的职责切分：

| 文件 | 职责 |
|---|---|
| `merge.ts` | 解析参数（id / `--strategy` / `--plan` / `--dry-run` / `--push`）、收集候选、驱动流程 |
| `merge-runner.ts` | `collectMergeCandidates()` 收集「已批准且未合入」的切片；`commitPendingWorktrees()` 提交产物；`cleanupMergedSlices()` 清理 worktree 与分支；`pushCurrentBranch()` 推送 |
| `merge-plan.ts` | 按依赖图与写集冲突构建合并计划（`core/sched/merge.ts` 的纯计算部分） |
| `merge-executor.ts` | 执行计划：按策略合并、冲突即 `git merge --abort` 回滚、写 `merge.*` 事件 |

**关键设计**：`core/sched/merge.ts` 只做**纯计算**（计划、冲突判定、策略选择），
不碰 git；碰 git 的部分全在 `cli/`。这样 C3 成立——
合并判定确定性、不调模型、不触网。

**为什么合并必须在 CLI 层而不在签字路径里**：
签字是「批准」，合并是「动作」；分开之后，
批准写进 `sign.*` 事件，动作写进 `merge.*` 事件，追溯链才不会断。

### 3.18 架构偏离检查 — `src/core/arch/`

**文件**: `imports.ts`（import 解析）、`scan.ts`（扫描与归属）、`report.ts`（比对出偏离）、
`guard.ts`（按 `arch:` 段定级，ADR-027）、`resolve.ts`（依赖名按归属解析，ADR-029）、
`normalize.ts`（形状归一化）、`types.ts`

**职责**：把「设计里画的模块图」和「代码里实际的 import 图」摆在一起比，
差出来的东西就是**架构腐化的证据**。

模块图从**设计正文**推导（ADR-029），不读存的结构化副本：
`core/design/derive.ts` → `core/design/parse.ts`。
依赖名先经 `resolve.ts` 按「该路径下的文件归谁」解析到模块，
所以设计里写 `src/core/ports` 不会被误报成「未知模块」。

```typescript
scanArchitecture(root: string, modules: ModuleSpec[]): ScanResult
  // 扫源码 → 算每个文件的模块归属 → 算模块间的实际依赖边

buildArchitectureReport(modules: ModuleSpec[], scan: ScanResult): ArchitectureReport
  // 设计与实际比对 → 偏离列表 + 依赖环
```

**七类偏离**：

| kind | 含义 |
|---|---|
| `undeclared_dependency` | 代码里有这条 import，设计里没声明 |
| `missing_dependency` | 设计声明了，代码里没有 |
| `unknown_module` | 依赖指向的模块在设计里根本不存在 |
| `unverifiable_dependency` | 目标模块没有源文件（契约 JSON、规格 md），无法用 import 验证 |
| `ambiguous_module` | 一个文件同时落在多个同样具体的模块范围里 |
| `unmapped_file` | 一个文件不在任何模块的 glob 范围里 |
| `cycle` | 实际依赖成环（跨模块边之间） |

其中 `unverifiable_dependency` 是**软偏离**：目标模块本来就没有代码，
无法用 import 验证，不计入「是否一致」的结论。

**层级模块的处理**：设计里的模块常是层级的——`src/core` 是组，
`src/core/events` 是成员。「`src/core` 声明依赖 `src/core/events`」
不是一条 import 边，按字面比会报一堆假缺失。所以判定用**包含关系**
（scope containment）：A 覆盖 B ⟺ B 拥有的每个文件都落在 A 的 glob 范围内，
包含关系从**实际归属结果**算出来，不是从名字猜的。

scope(A) 与 scope(B) 有交集的边算**内部边**——它只是组与成员的关系，
不算「未声明依赖」，也不参与成环判定。只有 scope 互不相交的边
才是真正的跨模块依赖。

**实现要点**：

- import 解析用正则，不解析 AST——`core/` 零第三方依赖，装不起解析器
- 相对路径解析用**正斜杠**拼接（不用 `node:path` 的 `join`，那在 Windows 上产出反斜杠）
- 扫描分两遍：先定完所有文件的归属，再算依赖边——否则「a 引用 b」
  这类边会因为 b 的文件还没扫到而被丢掉
- glob 匹配复用 `core/sched/paths.ts` 的 `pathMatches`（policy engine 同源，ADR-014 §4）
- 归属冲突按**模式最具体者胜**——`src/core/**` 与 `src/core/audit/*.ts`
  同时命中时后者拿走，前者只是组；同样具体才算真歧义
- 设计声明先归一化——反引号、「无」类占位词、`无（仅定义类型和接口）` 这类写法
  不该变成假偏离

**报告层**（G-4/B）：偏离是给人看的证据；**护栏层**（G-4/A，ADR-027）
按 `policy.yaml` 的 `arch:` 段给六类硬偏离定级（`deny` / `ask` / `allow`）。

CLI 入口：`zelto arch check [--design <id>] [--root <dir>] [--strict] [--json]`。
不带 `--strict` 时纯报告（退出码恒 0，不读配置）；`--strict` 按护栏配置重算结论，
有 `deny` 类偏离时返回退出码 1（给 CI 用）。

### 3.21 契约演进检查与跨版本回归基线（ADR-036）

架构护栏看的是**模块依赖方向**，看不见「接口字段被改了」；版本级验收看的是
**这一版的测试绿不绿**，看不见「上个版本验证过的东西这一版还在不在」。
这两样是 G-4 剩下的两块，ADR-036 补齐：

| 能力 | 判定口径 | 落点 |
|---|---|---|
| 契约演进检查 | 收窄 = 写入方破坏（新契约不再接受旧数据）；放宽 = 读取方破坏（新数据旧程序读不懂）；两侧都判不了兼容的按写入方破坏处理 | `core/contracts/evolution.ts`（纯函数）+ `core/contracts/baseline.ts`（基线文件） |
| 跨版本回归基线 | 上版本通过、本版本失败 / 退化成 todo / 用例消失 —— 三类回归 | `core/regression/`（TAP 解析 + 基线 + 差集） |

两条都接在 `zelto version deliver` 这一层：交付是版本对外生效的边界，
契约破坏与行为退化留到交付之后才发现，代价已经出去了。

基线的更新是**人显式跑 `zelto contract baseline`** —— 更新基线等于签字接受
这次变化，自动化会把破坏也一起签掉，那道闸门就白设了。
回归检出同样留了人的出口：`--accept-regression` 显式放行并留事件
（与 ADR-015 的 hotfix `--yes` 同一思路）。

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
                        → 只改状态，不碰主干（ADR-018）
                        → 提示下一步：zelto merge <id>
```

签字**不自动合并**（`docs/adr-018-no-auto-merge-on-sign.md`）。合并是显式动作：

```
zelto merge [id ...] [--strategy <s>] [--dry-run] [--push] [--json]
  1. 不带 id → 收集「已批准且尚未合入」的切片
  2. 提交各切片 worktree 里未提交的改动（分支必须先带上产物）
  3. MergePlanner 按依赖图生成合并计划（core/sched/merge.ts）
  4. executeMergePlan 执行：冲突即 git merge --abort，主干回滚
  5. 清理已合并切片的 worktree 与分支
  6. --push → 推送合并后的分支
```

`--push` 只属于合并，不属于签字——推的必须是合并结果。

**签错了能撤**（`docs/adr-021-sign-revoke.md`）：

```
zelto sign <id> --revoke → SignManager.revoke(id, 'human')
                         → events.append('sign.revoked')
                         → 签字记录状态 approved → revoked
```

撤销只作废「人批准」这条记录，不改切片状态（门禁②的结论仍然成立）。
记录不删、只改状态并留事件——签字记录是证据，删掉等于把历史从链上抹掉。

### 4.7 版本级流程

```
zelto version start <ver>
  Phase 1  准备切片：建切片文件 → 写规格 → 冻结（哈希 + spec.frozen 事件）
  Phase 2  并行执行：executeSlicesParallel() —— 与 run --parallel 同一条路径
  Phase 3  结果解读：全部通过 → 打印逐片签字命令；否则提示 --retry-failed

zelto version deliver <ver>
  第一步  前置条件：切片状态 completed + 分支已合入 HEAD（只读磁盘与 git）
  第二步  版本级验收：在主仓跑 config.gate.commands（真实主干代码）
  通过 → events.append('version.accepted') → 状态 integrated → delivered
```

详见 `docs/adr-017-version-level-orchestration.md`。

---

## 5. 架构约束实现

| 约束 | 实现方式 |
|---|---|
| **C1** 状态只在文件里 | `SliceStore` 读写 `.zelto/slices/*.json`；`EventStream` 追加 `.zelto/events/*/events.jsonl`；状态变更只经文件读写 |
| **C2** 核心纯洁性（含原 C6 单向依赖） | `package.json` 无运行时 dependencies；只 import `node:*`；tsconfig 无反向路径映射；代码级无 `core/` import `adapters/` |
| **C3** 确定性 | policy 无网络无模型；gate 仅 spawn 子进程；sched 纯计算、只读文件 |
| **C4** append-only | `EventStream.append()` 使用 `appendFile`；无 delete/update；事件是追溯的唯一证据载体 |
| **C5** 保护域与锚点外部化（含原 C8） | `PROTECTED_PATTERNS` 硬编码常量，策略规则无法覆盖；策略哈希锚点存于 `policy/lock.json` |
| **C7** llm 不判定 | `llm/` 只用于需求/设计/计划的**草案**生成；所有判定模块（policy/gate/sched）不引用 llm；草案须经人 `confirm` 才进入下游 |
| **C9** 写集预约 | 准入：`Scheduler.admit()` 检查 running 切片的 writes 数组；运行期：`.zelto/locks/<id>.json` 预约 + PreToolUse 钩子逐写判定（主） + 运行后 git 改动审计兜底（ADR-014）；预约缺失 fail closed |

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

### 6.4 运行时写集强制（ADR-014）

写集不只在准入时被读。agent 运行期间每一层强制都在：

```
agent 写文件
   │
   ├─ PreToolUse 钩子（src/hook/pretool.ts）
   │    判定顺序：路径逃逸 → 保护域 → 写集预约 → policy.yaml
   │    预约缺失 = 一律拒绝（fail closed）
   │    每次判定写一条 policy.decision 事件
   │
   └─ 运行结束后审计（src/core/sched/audit.ts）
        拿 git 真实改动对写集：未提交改动 + baseCommit..HEAD 的已提交改动
        钩子拦不住的写（解释器里的 writeFileSync）在这里兜住
        越界 → 不进 gate②、不自动生成签字请求
```

钩子装在 worktree（agent 实际工作的目录），但它读的预约与策略在主仓库——
命令行里显式给了 `--project-root`。详见 `docs/adr-014-runtime-policy-enforcement.md`。

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

- **1097 tests, 226 suites, 0 fail**（2026-11-05 全量验证）
- 核心模块覆盖率 > 90%
- Hook 可执行体 7 个集成测试
- 运行时守卫 1 个验收测试（起真实 CLI 进程 + 假 agent，验钩子判定 + 审计兜底）
- 架构偏离检查 1 组测试（判定层直测 `core/arch/`，命令层起真实 CLI 进程）

---

## 8. 未来架构方向

完整的目标、现状差距与待决策项见 `docs/zelto-项目目标.md` §6 与 §7。
此处只列架构层面的方向。

### 8.1 架构护栏（G-4 的一部分）

当前 zelto 自身的 C2/C6（`core/` 不依赖 `adapters/`）只约束 zelto 自己。
**被 zelto 管理的项目没有对应机制**——`DesignDoc.modules[].dependencies`
只是文档里的字，没有被校验。

**G-4/B 已落地（只读报告层）**：`zelto arch check` 把设计里画的模块图
和代码里实际的 import 图摆在一起比，列出七类偏离：

| 偏离 | 含义 |
|---|---|
| 未声明依赖 | 代码里有这条 import，设计里没写（架构腐化的主要来源） |
| 缺失依赖 | 设计写了，代码里没有 |
| 未知模块 | 依赖指向的模块在设计里不存在 |
| 依赖无法验证 | 目标模块没有源文件（契约 / 规格），没法用 import 验证 |
| 模块归属歧义 | 一个文件同时落在多个同样具体的模块范围里 |
| 文件无归属 | 一个文件不在任何模块的 glob 范围里 |
| 依赖成环 | 跨模块的实际依赖形成了环 |

设计里的模块常是层级的（`src/core` 是组，`src/core/events` 是成员），
所以判定走**包含关系**而不是名字相等：组依赖自己的成员不算偏离，
组与成员之间的边也不参与成环判定。细节见 §3.18。

实现落在 `core/arch/`（纯计算，C3：不调模型不触网；C6：不依赖 `adapters/`）：

- `imports.ts` —— 正则抽 import 说明符，分相对 / 包 / 内置三类
- `scan.ts` —— 扫源码、算文件归属、算模块间的实际依赖边
- `report.ts` —— 拿设计与实际比，产出偏离列表与依赖环（只报告，不定结论）
- `guard.ts` —— 按 `policy.yaml` 的 `arch:` 段给六类硬偏离定级（G-4/A，ADR-027；
  `deny` 拦、`ask` 只待确认、`allow` 不计入结论；缺段时全按 `deny`，与旧 `--strict` 一致）

报告层只出证据，护栏层只算结论：`arch check --strict`（整图结论定退出码）、
`version deliver`（整图结论作交付门）、`batch` 准入与单片 `gate`
（只看与本片写集相关的偏离）四处执行点共用 `cli/commands/arch-guard.ts` 的接线层。

### 8.2 版本内依赖分层（G-1）——已落地

排阶段的真源是 `core/sched/batch.ts` 的 `planExecutionPhases()`：
先按依赖拓扑分层，再在层内按写集重叠贪心着色（G-2 降级为串行）。

CLI 侧唯一入口是 `src/cli/commands/execution-plan.ts` 的 `buildExecutionPlan()`：
`zelto batch`（只查）、`zelto version start` 与 `zelto run --parallel`（要跑）
消费的是同一份计划。执行时按阶段顺序推进——某个阶段没过，
后面的阶段不启动，把控制权交回给人。

排阶段是纯计算（C3：不调模型、不触网），计划只落在文件里（C1）。

### 8.3 批次级闸门（G-3）

目前只有被动停机（agent 自己挂了、被 hook 拦了），没有主动刹车。
需要的是：暂停 → 快照现场 → 人处理 → 继续；以及签错后的回退路径。

### 8.4 llm/ 集成

`llm/` 已用于需求/设计/计划的草案生成，后续可用于：
- 丰富澄清问题生成（现为规则引擎）
- 语义发现（代码库分析）
- **永远不参与任何判定**（C7）

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
SignManager.revoke(id, decidedBy, comment): SignRequest   // 撤销已通过的签字（ADR-021）

// Stall
classifyStall(signal): StallClass
isAutoResolvable(stallClass): boolean
isSliceStalled(slice): boolean

// Halt
HaltStore.request(scope, requestedBy, reason): HaltRequest
HaltStore.isHalted(scope): HaltRequest | null
rollbackHaltedSlice(store, events, sliceId, options): HaltRollbackResult
findStuckRunningSlices(store, reservations): string[]

// Sched
Scheduler.admit(sliceId, actor): SchedResult
Scheduler.buildConstraints(slice): ConstraintBundle
Scheduler.resume(sliceId, options): void

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
