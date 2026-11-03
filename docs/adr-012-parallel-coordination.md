# ADR-012: 并行切片协调协议与工件冲突解决

**状态**: 实现中
**日期**: 2026-11-03
**作者**: 系统架构
**关联约束**: C1, C2, C3, C4, C6, C7, C9
**关联文档**: `docs/zelto-技术架构.md`, `docs/adr-011-worktree-isolation.md`

---

## 1. 摘要

当前并行执行（`zelto run --parallel`）仅基于文件路径做写集冲突检测，
缺乏切片间依赖排序、语义级冲突检测和合并编排机制。
本 ADR 引入三层协调协议：**依赖图（dependency graph）→ 工件冲突检测（artifact conflict）→ 合并编排（merge orchestration）**，
让并行切片可安全地按序执行并合并回主分支。

所有新增模块均在 `core/` 内，零第三方依赖、全确定性。

---

## 2. 动机

### 2.1 现状

| 事实 | 位置 | 影响 |
|---|---|---|
| `runParallel` 启动前只检查路径重叠 | `src/cli/commands/core-slice.ts:1152` | 两切片改同类型的不同文件，路径不重叠但逻辑冲突 |
| 无切片依赖关系 | `src/core/sched/engine.ts` | 无法表达「B 依赖 A 的输出」 |
| 合并策略写死 `--ff-only` | ADR-011 §3.6 | 并行分支必然失败 |
| 无协调事件 | `src/core/events/stream.ts` | 无法审计并行执行的阶段流转 |
| 冲突解决无人知晓 | — | 冲突发生时无记录、无通知 |

### 2.2 典型场景

```
场景：重构一个模块（A）的同时，另一个切片（B）依赖该模块的新接口。
→ A 和 B 写集不重叠（A 改 src/core/，B 改 src/cli/），但 B 必须在 A 之后执行。
→ 当前机制：两切片同时启动，B 看到的是 A 改之前的旧接口。
→ 结果：B 的测试必失败。
```

```
场景：两个切片分别修改了类型定义文件和消费者文件。
→ 路径不重叠，准入通过。
→ 执行中：类型定义变，消费者不变，类型检查失败。
→ 结果：门禁失败，浪费一次执行周期。
```

---

## 3. 设计

### 3.1 架构概览

```
                    ┌─────────────────────────────────────┐
                    │        core/sched/                   │
                    │                                      │
                    │  engine.ts  (现有)                    │
                    │     ├── admit()                      │
                    │     ├── buildConstraints()            │
                    │     └── checkConflicts()              │
                    │                                      │
                    │  depgraph.ts  ★ 新增                   │
                    │     ├── DependencyGraph               │
                    │     ├── topologicalSort()             │
                    │     ├── checkCycles()                 │
                    │     └── phasesFromDeps()              │
                    │                                      │
                    │  artifact.ts  ★ 新增                   │
                    │     ├── ArtifactMap                   │
                    │     ├── detectArtifactConflicts()     │
                    │     └── ArtifactConflict               │
                    │                                      │
                    │  merge.ts  ★ 新增                      │
                    │     ├── MergePlanner                  │
                    │     ├── MergePlan                     │
                    │     ├── detectMergeConflicts()        │
                    │     └── mergePlanFromSlices()         │
                    └─────────────────────────────────────┘
```

### 3.2 依赖图（Dependency Graph）

切片规格文件（`specs/slices/<id>.md`）的 `## Prerequisites` 章节声明前置切片：

```markdown
## Prerequisites
- v2-core-refactor
- v2-api-types
```

运行时也支持 CLI 参数覆盖：

```
zelto run --coordinated slice-b --depends-on slice-a
```

#### DependencyGraph

```typescript
interface DepGraphNode {
  sliceId: string;
  dependsOn: string[];   // 前置切片 ID 列表
  phase: number;         // 拓扑排序后所在阶段（0-based）
}

class DependencyGraph {
  addNode(sliceId, dependsOn): void
  topologicalSort(): DepGraphNode[]
  checkCycles(): CycleInfo | null
  phasesFromDeps(): string[][]  // 按阶段分组
}
```

**算法**：
1. 构建 DAG（`sliceId → dependsOn[]`）
2. Kahn 拓扑排序 → 生成 `phase[]`（同一 phase 的切片可并行）
3. 检测环 → 如有环则报错并列出环路径
4. 输出阶段化执行计划

### 3.3 工件冲突检测（Artifact Conflict）

当前路径重叠检测仅检查直接文件名冲突。工件级检测检查**语义关系**：

#### ArtifactMap

```typescript
interface ArtifactMapping {
  pattern: string;       // 文件 glob 模式
  artifact: string;      // 工件名称
  category: ArtifactCategory;
}

type ArtifactCategory =
  | 'type_definition'    // .d.ts, interfaces, types
  | 'api_contract'       // API 路由、handler 签名
  | 'schema'             // JSON Schema、数据契约
  | 'config'             // 配置文件
  | 'test_fixture'       // 测试夹具、mock
  | 'documentation';     // 文档
```

内置映射规则（hardcoded 在 `artifact.ts` 中，C3/C5 合规）：

```typescript
const BUILTIN_MAPPINGS: ArtifactMapping[] = [
  { pattern: '**/types.ts', artifact: 'type-definitions', category: 'type_definition' },
  { pattern: '**/*.d.ts', artifact: 'type-definitions', category: 'type_definition' },
  { pattern: 'contracts/schemas/*.json', artifact: 'contract-schemas', category: 'schema' },
  { pattern: 'policy/**', artifact: 'policy', category: 'config' },
  { pattern: '.zelto/**', artifact: 'zelto-state', category: 'config' },
  // ...
];
```

#### 冲突检测

```typescript
interface ArtifactConflict {
  sliceA: string;
  sliceB: string;
  artifact: string;
  category: ArtifactCategory;
  severity: 'info' | 'warning' | 'error';
  description: string;
}

function detectArtifactConflicts(
  slices: SliceData[],
  customMappings?: ArtifactMapping[],
): ArtifactConflict[]
```

检测逻辑：
1. 将每个切片的写集路径映射到工件
2. 找出共享同一工件的切片对
3. 按严重程度分级：
   - `error`: 同一 `type_definition` 或 `api_contract` 工件的写集冲突
   - `warning`: 同一 `schema` 或 `config` 工件的写集冲突
   - `info`: 同一 `test_fixture` 或 `documentation` 工件的写集冲突
4. 返回所有冲突列表

### 3.4 合并编排（Merge Orchestration）

每个切片在独立 worktree 中执行后，需要编排合并回主分支。

#### MergeStrategy

```typescript
type MergeStrategy =
  | 'sequential_ff'    // 顺序 fast-forward（依赖图保证无冲突）
  | 'merge_commit'     // 创建合并提交（并行切片，有冲突风险）
  | 'rebase_onto'      // 变基到主分支（需解决冲突）
  | 'manual';          // 需要人工介入
```

#### MergePlanner

```typescript
interface MergePlan {
  slices: string[];                    // 有序的切片 ID 列表
  strategy: MergeStrategy;
  phases: MergePhase[];                // 分阶段合并
  estimatedConflicts: string[];        // 预估冲突文件列表
  createdAt: string;
}

interface MergePhase {
  phase: number;
  slices: string[];
  strategy: MergeStrategy;
}

class MergePlanner {
  planFromDependencyGraph(graph: DependencyGraph): MergePlan
  planFromSlices(slices: SliceData[], deps?: string[][]): MergePlan
  detectMergeConflicts(plan: MergePlan): MergeConflict[]
}
```

**策略选择规则**：
1. 无依赖且写集不重叠 → `merge_commit`（并行合并）
2. 有依赖关系（phase 不同）→ `sequential_ff`（按 phase 串行 ff）
3. 写集重叠（`artifact.ts` 检测到冲突）→ `manual`（人工介入）
4. 单个切片 → `sequential_ff`

### 3.5 事件流新增类型

| 事件 | 触发点 | 关键 payload |
|---|---|---|
| `coord.dep_added` | 添加依赖关系 | `sliceId`, `dependsOn`, `phase` |
| `coord.phase_ready` | 某阶段所有切片可执行 | `phase`, `sliceIds` |
| `coord.phase_complete` | 某阶段全部完成 | `phase`, `sliceIds`, `results` |
| `coord.cycle_detected` | 检测到循环依赖 | `cycle` (环路径列表) |
| `artifact.conflict_detected` | 工件冲突检测 | `conflicts[]` |
| `merge.planned` | 生成合并计划 | `plan` |
| `merge.phase_complete` | 合并阶段完成 | `phase`, `slices`, `conflicts` |
| `merge.conflict` | 合并冲突 | `files`, `resolution` |
| `merge.completed` | 合并全部完成 | `slices`, `strategy` |

### 3.6 数据流

```
协调执行流程：

1. zelto run --coordinated <id1> <id2> ... [--depends-on <id>=<dep>]

2. DependencyGraph
   ├── 从规格 ## Prerequisites 读取依赖
   ├── 合并 CLI --depends-on 参数
   ├── checkCycles() → 有环则报错退出
   └── topologicalSort() → [[phase0切片], [phase1切片], ...]

3. Artifact Conflict Detection
   ├── 对同 phase 切片做工件冲突检测
   ├── 严重 error → 报错退出
   └── 严重 warning → 提示并确认

4. 按 phase 执行：
   Phase 0: admit → run → wait all
   Phase 1: admit → run → wait all
   ...

5. MergePlanner
   ├── 根据依赖图和写集生成合并计划
   ├── 执行合并（按 strategy）
   └── 报告结果

6. 事件记录：所有步骤写 append-only 事件
```

### 3.7 CLI 接口

```
zelto run --coordinated <id1> [id2 ...] [--depends-on <id>=<dep>] [--agent <name>]
zelto run --depgraph <id1> [id2 ...]            # 仅显示依赖图，不执行
zelto depgraph <id1> [id2 ...]                  # 查看切片间依赖关系
zelto merge <id1> [id2 ...] [--strategy <s>]    # 合并已完成的切片
zelto merge plan <id1> [id2 ...]                # 查看合并计划
zelto artifact check <id1> [id2 ...]            # 检查工件冲突
```

---

## 4. 约束合规性检查

| 约束 | 检查 | 合规 |
|---|---|---|
| **C1** | 状态仅存于切片文件（依赖关系在 SliceData 或规格中）；`DependencyGraph` 在内存构造后丢弃 | ✅ |
| **C2** | `src/core/sched/depgraph.ts`、`artifact.ts`、`merge.ts` 只用 Node 内置 | ✅ |
| **C3** | 拓扑排序、工件映射、合并策略均为确定性计算，无模型、无网络 | ✅ |
| **C4** | 每个协调/合并事件写一条 append-only 事件 | ✅ |
| **C5/C8** | 未改动保护域与策略锚点 | ✅ |
| **C6** | `core/` 不 import `adapters/` | ✅ |
| **C7** | LLM 不参与依赖判定或工件冲突检测 | ✅ |
| **C9** | 写集预约仍由 `Scheduler.admit()` 执行；合并不绕过准入 | ✅ |

---

## 5. 实现计划

### Phase 1: core/ 模块

| 文件 | 内容 | 测试数 |
|---|---|---|
| `src/core/sched/depgraph.ts` | `DependencyGraph`, `topologicalSort`, `checkCycles`, `phasesFromDeps` | ~15 |
| `src/core/sched/artifact.ts` | `ArtifactMapping`, `ArtifactConflict`, `detectArtifactConflicts`, `BUILTIN_MAPPINGS` | ~12 |
| `src/core/sched/merge.ts` | `MergeStrategy`, `MergePlan`, `MergePlanner`, `detectMergeConflicts` | ~10 |
| `src/core/sched/types.ts` | 新增导出 | — |

### Phase 2: 事件流扩展

| 文件 | 变更 |
|---|---|
| `src/core/events/stream.ts` | 新增 8 种事件类型 |
| `contracts/schemas/event-envelope.json` | 枚举追加 |
| `src/core/audit/trail.ts` | 新增事件摘要生成 |

### Phase 3: CLI 命令

| 文件 | 变更 |
|---|---|
| `src/cli/commands/core-slice.ts` | 新增 `--coordinated` 标志、依赖图解析 |
| `src/cli/commands/merge.ts` ★ 新增 | `zelto merge`, `zelto merge plan` |
| `src/cli/commands/depgraph.ts` ★ 新增 | `zelto depgraph`, `zelto artifact check` |

### Phase 4: 测试

| 文件 | 测试数 |
|---|---|
| `tests/depgraph.test.ts` | ~15 |
| `tests/artifact.test.ts` | ~12 |
| `tests/merge.test.ts` | ~10 |
| `tests/coordinated-run.test.ts` | ~8 |

---

## 6. 替代方案

### 方案 A：在规格 Markdown 中用 YAML frontmatter 声明依赖

**放弃理由**：当前规格解析（`SpecMdExecutor`）只认 `## Spec` 和 `## Checklists` 章节，
引入 frontmatter 需额外解析器且与现有格式不兼容。用 `## Prerequisites` 章节更自然。

### 方案 B：在独立的 `coord.yaml` 中声明切片间关系

**放弃理由**：多一个状态文件违反"状态只在文件里"的精神——依赖关系应附着在切片数据上，
或从规格中派生。

### 方案 C：用 LLM 自动检测工件冲突

**放弃理由**：违反 C3（判定确定性）。工件映射基于文件命名约定和项目结构，
纯规则引擎即可实现，无需 LLM。

### 方案 D：用 git merge 的冲突输出来反向推导合并计划

**放弃理由**：先有鸡还是先有蛋——合并计划应该在执行前生成，而非执行后补救。
执行前的合并计划让用户有机会调整切片划分。

---

## 7. 决定

采用 **方案 A 与 C 的结合**：

1. 依赖关系从规格 `## Prerequisites` 章节解析 + CLI `--depends-on` 覆盖
2. 工件冲突检测基于内置规则 + 可选的自定义映射
3. 合并编排根据依赖图和工件冲突自动选择策略
4. 所有协调流程产生 append-only 事件
5. 新增 CLI 命令：`zelto run --coordinated`、`zelto depgraph`、`zelto merge`、`zelto artifact check`
