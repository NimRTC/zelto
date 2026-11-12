# ADR-056: 版本级分支 —— 多版本并行时的分支与合并拓扑

**状态**: 已实现（2026-11-12），D1–D6 按倾向表采纳
**日期**: 2026-11-12
**作者**: 系统架构
**关联约束**: C1, C3, C4, C7, C9
**关联文档**: `docs/adr-011-worktree-isolation.md`,
`docs/adr-012-parallel-coordination.md`,
`docs/adr-017-version-level-orchestration.md`,
`docs/adr-018-no-auto-merge-on-sign.md`,
`docs/adr-019-phased-execution.md`,
`docs/zelto-项目目标.md`

---

## 1. 摘要

今天的「版本」不是 git 实体，只是 `.zelto/versions/<planId>.json` 里的一个
label 加一个 status。切片产物一律合入**主仓当前检出的分支**，
版本级验收也跑在主仓。这套拓扑隐含一个前提：**同一时刻只有一个版本在推进**。

本 ADR 让版本成为 git 的一等分支实体：

```
version/<label>            ← 版本分支（git 实体）
  ├─ slice/<id-a>          ← 切片的产物合入这里，不直接合 main
  └─ slice/<id-b>
main                        ← 版本分支由人显式合入这里
```

- 每个版本有自己的**版本工作目录**（version worktree），版本内切片共用它
- 切片的 worktree 从**版本分支 tip** 建，基点不再是 main HEAD
- 切片产物合入**版本分支**，不合 main
- 版本级验收跑在**版本工作目录**（验的是这个版本的代码状态）
- 版本分支合入主干是**独立显式动作**（`zelto version ship`），不与签字绑定

解决三件事：

1. **多版本并行**：v2、v3 可以同时推进到各自的完成态
2. **版本级可追溯**：能 checkout 出「这个版本整体长什么样」，而不只是切片碎片
3. **版本级回滚单位**：版本分支就是回滚单位

**不**解决：跨版本的语义级冲突（仍是规则引擎，见 §3.6）；
**不**取消版本间的依赖串行（`dependsOn` 仍然强制前置版本先 integrated，见 §3.2）。

---

## 2. 动机

### 2.1 现状

| 事实 | 位置 | 影响 |
|---|---|---|
| 合并目标固定是 `repoRoot` 当前 HEAD | `src/cli/commands/merge-executor.ts:191` `executeMergePlan` | 没有「合到别处」的概念，版本只能是 label |
| 切片基点默认是主仓 HEAD | `src/cli/commands/shared.ts:873` `ensureWorktree` | 切片的基点与它所属的版本无关 |
| 版本级验收跑主仓 | `src/cli/commands/ai-pipeline.ts:885` | 验的是主干代码，不是这个版本的代码 |
| 交付判据隐含「合入主干」 | `src/cli/commands/ai-pipeline.ts:831` | `isMergedIntoHead(branch, repoRoot)` 拿 main 的 HEAD 判 |
| 版本之间无冲突检测 | `core/sched/artifact.ts` 只在单批次内检测 | v2/v3 并行时碰同一批文件，无人拦 |
| 前置版本必须已 integrated | `src/cli/commands/ai-pipeline.ts:1049` | v3 必须等 v2 合入 main 才能开跑 —— **这条要保留，但含义要改** |

### 2.2 典型场景

```
场景：v2（重构核心）和 v3（加新接口层）并行推进。
→ v3 的切片基点是 main HEAD，它看不到 v2 的新接口 → 门禁②必失败。
→ 当前唯一出路：等 v2 合入 main，v3 再从新 main 建基点。串行。
```

```
场景：v2 交付后要回退。
→ 今天没有版本级单位 —— 只能逐个把 slice 分支 revert 回去，
   而 slice 分支在合并后已被删除（merge-runner.ts:228 `git branch -d`）。
```

```
场景：v2 与 v3 都改 types.ts，并行跑。
→ 两个批次各自内部无冲突，跨批次没人比 → 合主干时才发现，冲突可见但太晚。
```

### 2.3 为什么不用「clone 不同目录」

这条路已被排除，理由是它会破不变量：

- **状态会丢**：`.gitignore` 第 5 行是 `.zelto/`，而 `.zelto/` 装着
  `slices/` / `events/` / `locks/` / `versions/` 全部状态。clone 出来是空的
  —— 没有切片、没有追溯链、没有写集预约。
- **C9 会失效**：预约文件在 `projectRoot/.zelto/locks/`
  （`src/core/sched/reservation.ts:17`），`projectRoot` 传 `process.cwd()`
  （`src/cli/commands/parallel-executor.ts:425`）。clone A 与 clone B 各有各的
  locks 目录 → 两个版本互相看不见对方的写集 → 写集预约的跨版本强制直接失效。
- **worktree 已经做到了目录隔离，且更便宜**：共享 `.git` 对象库、共享 `.zelto/`
  状态，只多一个目录；clone 要复制对象、复制 submodule 对象（ADR-044 那套
  初始化逻辑还得多跑一遍）。

**结论：目录隔离永远用 worktree，不用 clone。**

---

## 3. 设计

### 3.1 分支与目录拓扑

| 实体 | 分支 | 目录 | 生命周期 |
|---|---|---|---|
| 主干 | `main`（或人当前分支） | 主仓 | 长期 |
| 版本 | `version/<label>` | `.zelto/version-worktrees/<label>/` | 版本从 `in_progress` 到 `shipped` |
| 切片 | `slice/<id>` | `.zelto/worktrees/<id>/` | 切片从冻结到合并 |

版本工作目录**另起一个 base**，不复用 `.zelto/worktrees/`：

```
.zelto/worktrees/<sliceId>/          ← 现有，不动（ADR-011 的路径是契约）
.zelto/version-worktrees/<label>/     ← 新增
```

理由：`WorktreeManager.list()` 按路径里的 `.zelto/worktrees/` 标记反解
sliceId（`src/core/worktree/manager.ts:381`），版本工作目录混进去会被
误认成切片 worktree，进而被 `cleanupMergedSlices` 之类逻辑误删。
另起 base 就不用改这个解析。

**版本工作目录里检出 `version/<label>`**，是所有 git 合并动作的执行地。

### 3.2 切片 → 版本的归属解析

`zelto merge` 要知道「这个切片该合进哪个版本分支」。切片文件里
**没有**版本字段（`src/core/slice/store.ts:67` `SliceData`），所以要解析。

解析顺序（全部确定性）：

1. **命令行显式指定**：`zelto merge <id> --target version/<label>`（最高优先）
2. **版本计划成员**：扫描 `.zelto/versions/*.json`，找 `versions[].slices[].id`
   包含该切片的计划。**命中多个计划则报错**，要求 `--plan` 指定
3. **规格 frontmatter**：`specs/slices/<id>.md` 的 `version:` 字段
   （`src/cli/commands/slice-detail.ts:475` 已经在读它）
4. **兜底**：合入主仓当前分支（= 今天的行为）

第 4 条是**向后兼容的关键**：不在任何版本计划里的切片（老项目、
手工建的切片），行为与今天完全一致。

版本间的依赖串行**保留但改判据**：现在前置版本必须 `integrated`（= 已合入 main）；
改后 `integrated` = **该版本所有切片已合入版本分支**。于是：

```
v3 依赖 v2
→ v2 integrated（切片都进了 version/v2）→ v3 的分支从 version/v2 的 tip 建
→ v2 还没 ship 进 main 时，v3 就能开跑，且 v3 看得见 v2 的全部改动
```

这比今天**更强**：今天 v3 只能看到 v2 已合进 main 的部分，
改后 v3 看到的是 v2 的完整版本状态。

### 3.3 合并目标参数化

`executeMergePlan` 现在在 `repoRoot` 执行 `git merge`（合进当前检出的分支）。
改为：合并动作在**目标工作目录**执行。

```typescript
// 现状
export async function executeMergePlan(
  plan: MergePlan,
  slices: MergeSliceInfo[],
  options: MergeExecutorOptions,   // { repoRoot, events, log }
): Promise<MergeExecutionResult>

// 改后
export interface MergeExecutorOptions {
  repoRoot: string;
  /** 合并目标工作目录 —— 版本工作目录，或主仓（合 main 时） */
  targetDir?: string;              // 默认 = repoRoot，向后兼容
  events: EventStream;
  log?: (m: string) => void;
}
```

`targetDir` 默认 `repoRoot`，**老调用方零改动**。

连带要改的判定（都改成「相对目标 ref」而不是「相对 HEAD」）：

| 现有 | 问题 | 改后 |
|---|---|---|
| `isMergedIntoHead(branch, repoRoot)` | 拿 main 的 HEAD 判 | 新增 `isMergedIntoRef(branch, ref, repoRoot)`；`isMergedIntoHead` 保留为薄封装 |
| `isStaleBase(baseCommit, repoRoot)` | 拿 main 的 HEAD 比 | 改成拿**目标分支 tip** 比（版本分支 tip） |
| `canFastForward(branch, repoRoot)` | HEAD vs branch | 改成目标 ref vs branch |
| `headCommit(repoRoot)` | main 的 HEAD | 用目标 ref 的 commit |

`git merge-base --is-ancestor` / `git rev-parse` 在 worktree 里同样有效，
因为 worktree 与主仓是同一个仓库。

**基点回写**：`ensureWorktree` 建切片 worktree 时，基点改成**所属版本分支的 tip**
（不是 main HEAD），并写进 `slice.baseCommit`。这样切片基点与版本绑定，
`merge.stale_base` 的判据才有意义。

### 3.4 `version deliver` 重写

现在的两道判据（ADR-017 §3.3）：

| 现在 | 改后 |
|---|---|
| 前置①：切片 state = `completed` | 不变 |
| 前置②：`slice/<id>` 已合入 main HEAD | 改为：已合入**版本分支** `version/<label>` |
| 架构护栏：扫主仓 | 改为：扫**版本工作目录** |
| 契约演进检查：读主仓契约 | 改为：读**版本工作目录**的契约 |
| 版本级验收：跑主仓 `gate.commands` | 改为：跑**版本工作目录**的 `gate.commands` |
| 跨版本回归基线 | 不变（基线在 `.zelto/`，与目录无关） |

ADR-017 §3.3 的理由是「跑在主仓 = 验的是真实的主干代码」。
改后这个理由仍然成立，只是「真实代码」从 main 变成**这个版本的代码状态** ——
这才是版本交付该验的东西（v2 还没 ship，main 上还没有 v2 的东西）。

回归检查有版本顺序语义：v3 的回归基线要与**上一个已交付版本**比。
基线记录的是 TAP 用例状态，跨版本可比 —— 与目录无关，不受影响。

### 3.5 `version ship` —— 版本分支合入主干

**独立命令，显式执行**：

```
zelto version ship <version-label> [--plan <id>] [--dry-run] [--push]
```

- 目标：把 `version/<label>` 合入**主仓当前分支**
- 用 `executeMergePlan` 的同一套机制（策略选择、冲突处理、`--abort` 保护）
- 冲突 → `git merge --abort`，主干回到合并前状态，输出冲突文件清单
  （与 `src/cli/commands/merge-executor.ts:340` 现有行为一致）
- 基点漂移 → 降级 `--no-ff` 合并提交，写 `merge.stale_base`
- 成功后：版本状态 `delivered`，版本工作目录可清理（分支保留，由人决定）

**与 ADR-018 的关系**：ADR-018 禁止的是「签字后自动合并」。
`version ship` 是**独立的、人显式执行的**一个动作，粒度与今天的
`zelto merge` 完全一致（人显式跑一次，zelto 执行一次合并）。
它没有把合并挂到签字上，也没有把「逐片签字」变成「一次批准」。

**为什么必须有这一步**：版本分支不自动进 main（禁区：自动合并）。
但版本分支留在仓库里，主干就看不到它 —— 所以要有一个人工触发点。

**ship 之后要不要重跑验收？** 见 §6 D3。

### 3.6 跨版本写集冲突检测

并行版本会把「两个版本碰同一批文件」的问题暴露出来。现在
`core/sched/artifact.ts` 只在**单批次内**检测。

扩展：`version start` 时，把本版本的写集与**其它 in_progress 版本**的写集比：

| 冲突类别 | 严重度 | 处理 |
|---|---|---|
| 同一 `type_definition` / `api_contract` | error | 阻断（要求先解决，或把其中一个版本降级为等另一个 ship） |
| 同一 `schema` / `config` | warning | 提示，人决定 |
| 同一 `test_fixture` / `documentation` | info | 只记录 |

判定仍是**规则引擎**（glob + 内置工件映射），不调模型、不触网（C3）。
C7 不受影响。

**这是规则引擎，不是语义分析**。它能挡住「两个版本都改 `types.ts`」，
挡不住「v2 改了 `types.ts` 里的字段含义，v3 按旧语义写消费者」。
后者要到 ship 时的合并冲突才暴露，或者由版本级验收（集成缺口）暴露。
这一点必须在 UI 上说清楚，不能让人以为「跨版本也安全了」。

### 3.7 `node_modules` 的归属

今天所有 worktree 的 `node_modules` 都链接到主仓那一份
（`src/core/worktree/manager.ts:505` `linkNodeModules`），
理由是 ADR-011 §3.2「每次重装代价过高且易与锁文件漂移」。

**这个理由在多版本下失效**：v2 升了依赖版本、v3 还在用旧依赖，
共用一份 `node_modules` 必然打架。

改后归属：

```
.zelto/version-worktrees/v2/node_modules   ← 真的，v2 自己装
.zelto/version-worktrees/v3/node_modules   ← 真的，v3 自己装
.zelto/worktrees/<id>/node_modules         ← 链接到所属版本的那一份
```

代价：每个版本一次 `npm install`。见 §6 D4。

### 3.8 事件（不新增类型，只加 payload 字段）

事件 `type` 枚举**不动**（`contracts/schemas/event-envelope.json` 的 enum 是契约）。
payload 是无约束对象（`{"type":"object"}`），加字段不改 schema。

| 事件 | 新增 payload | 说明 |
|---|---|---|
| `merge.completed` | `target: "version:<label>" \| "main"` | 这次合并进了哪里 |
| `merge.planned` | `target` | 同上 |
| `merge.phase_complete` | `target` | 同上 |
| `merge.stale_base` | `target` | 同上 |
| `version.accepted` | `branch: "version/<label>"` | 版本验收通过时它在哪 |
| `version.delivered` | `branch`、`shippedTo`、`mergeCommit` | ship 落地信息 |
| `worktree.created` | `kind: "slice" \| "version"` | 区分两类工作目录 |

`worktree.created` 加 `kind` 是为了 `WorktreeManager.list()` 与清理逻辑
能分辨两类目录（见 §3.1）。

---

## 4. 契约变更

### 4.1 版本计划文件（`.zelto/versions/<planId>.json`）

`Version` 接口新增**可选**字段（向后兼容，老文件读出来是 `undefined`）：

```typescript
export interface Version {
  version: string;
  dependsOn: string[];
  description: string;
  slices: VersionSlice[];
  integrationTestDir: string;
  status: VersionStatus;
  // ── 新增（可选）─────────────────────────────
  /** 版本分支名，默认 `version/<version>` */
  branch?: string;
  /** 版本分支的基点 commit（建分支时的主干 HEAD） */
  baseCommit?: string | null;
}
```

`branch` 为空时默认 `version/<version>` —— 派生值不必落盘，
只在需要显式覆盖时写。

### 4.2 事件类型集合

**不变**。`contracts/schemas/event-envelope.json` 的 enum 一字不改。
只加 payload 字段。

### 4.3 事件类型集合之外的

- `contracts/schemas/slice.json` / `slice-v2.json`：**不变**
  （切片文件不需要版本字段 —— 归属从版本计划解析，见 §3.2）
- `policy.yaml` 格式：**不变**
- CLI 命令集合：**新增** `zelto version ship`；`zelto merge` 新增
  `--target` / `--plan` / `--strict` 参数
- git tag：**新增** `v<label>` 作为版本不可变锚点（D6）

---

## 5. 约束合规检查

| 约束 | 检查 | 合规 |
|---|---|---|
| **C1** 状态只在文件里 | 版本分支信息落 `.zelto/versions/<planId>.json`；git 自身承担分支元数据；无数据库、无常驻进程 | ✅ |
| **C2** `core/` 零第三方依赖 | 新增判定代码（归属解析、跨版本工件检测）只用 Node 内置；`core/` 不 import `adapters/` | ✅ |
| **C3** 判定确定性 | 归属解析（文件扫描）、跨版本工件检测（glob + 内置映射）、基点判定（git）全是字符串/集合运算与本地 git 调用；不调模型、不触网 | ✅ |
| **C4** append-only 事件 | 每次合并动作写 `merge.planned` / `merge.phase_complete` / `merge.completed`；版本验收与 ship 写 `version.accepted` / `version.delivered`；新增 payload 字段不改事件类型 | ✅ |
| **C5/C8** 保护域与锚点 | 不动保护域判定与 `policy/lock.json` | ✅ |
| **C7** `llm/` 只产草稿 | 版本计划里的 `branch` 若由 LLM 生成只能是草稿，人确认后才落盘；跨版本冲突判定不经 LLM | ✅ |
| **C9** 写集预约运行时强制 | 预约仍在**主仓** `.zelto/locks/`（同 repoRoot），版本工作目录不改变这一点 —— 这正是不能用 clone 的原因（§2.3）；hook 判定顺序一字未改 | ✅ |

---

## 6. 待决策（按 AGENTS.md「停下来问，不自己选」）

### 6.0 一个前置事实（影响 D2/D5 的权重）

**独立版本今天已经能并行跑。** `version start` 只检查 `dependsOn` 声明的
前置版本状态（`src/cli/commands/ai-pipeline.ts:1049`），两个互不依赖的版本
不会互相阻塞。

所以 B 方案要修的不是「打开并行」，而是**并行了但语义是糊的**：

| 现状 | 问题 |
|---|---|
| v2、v3 并行跑，切片基点都是 main HEAD | 两个版本的切片**互相看不见**对方的改动 |
| 切片产物一律合 main | v2、v3 抢同一个落点，合并顺序成了隐式决策 |
| 跨版本写集冲突无人检查 | 两版本碰同一批文件，到合并时才炸 |
| `integrated` = 已合 main | 版本依赖只能靠「先 ship 前一个」串起来 |

这决定了 D5 的性质：**跨版本冲突检查是「新增判据」，不是「解除限制」**。

### D1 版本分支的基点

**问题**：`version/<label>` 分支从哪个 commit 建？

| 选项 | 规则 | 优点 | 缺点 |
|---|---|---|---|
| **A** | 从**主干 HEAD** 建 | 基点是一句话能说清的（"这个版本从 main 出发"）；审计时基点不递归 | v3 从 main 建分支时看不到 v2 的未 ship 改动 |
| **B** | 从**前置版本的分支 tip** 建（依赖链传递） | v3 天然含 v2 的全部改动 | 基点推导变递归：v4 的基点 = v3 的 tip = v2 的 tip…；链条断了要重新推导；审计时「这个版本从哪来」要追溯整条链 |

**倾向 A。** 理由有二：

1. B 的递归基点在 `dependsOn` 链改动时会**静默漂移** —— 人改了 v2 的依赖声明，
   v4 的基点就变了，但 v4 的切片早就基于旧基点跑过了。基点不可复现。
2. B 实际把「依赖」表达了两遍（`dependsOn` 声明 + 基点隐含），两者可能不一致。

**但 A 必须配 D2 的 A 一起用** —— 否则「v3 依赖 v2」就是假的依赖。

### D2 `dependsOn` 的新判据与基点

**问题**：前置版本还没 ship 时，后置版本从哪儿建分支？

| 选项 | v3 的基点 | v3 看得见 v2 的改动吗 | 「依赖」是真的吗 |
|---|---|---|---|
| **A** | 前置版本分支 `version/v2` 的 tip | ✅ 全部 | ✅ 是 |
| **B** | 主干 HEAD | ❌ 未 ship 的部分看不到 | ❌ 假的 |

**倾向 A，强烈倾向。** 选 B 的话，`dependsOn: [v2]` 只是一句声明 ——
v3 的代码里根本没有 v2 的东西，依赖是假的。这比串行更糟：
串行至少让人看到「得等」，假的依赖让人以为「已经考虑了」。

**A 的实现代价**：需要「取前置版本分支 tip」这个操作。它必须是确定性的
（读 git，不调模型），并且要在版本分支还不存在时报清晰的错
（"前置版本 v2 的分支还不存在，先把 v2 跑到 integrated"）。

**A 与 D1 的关系**：D1-A（版本分支从 main 建）+ D2-A（后置版本从前置分支 tip 建）
—— 版本分支的**创建**基点是 main，但**依赖版本**的切片基点是前置分支的 tip。
两者不矛盾：一个说「这个版本分支从哪出发」，一个说「这个版本的切片从哪出发」。

### D3 `ship` 之后要不要重跑版本级验收

**问题**：验收已跑在版本分支上（§3.4）。ship 时主干可能已前进，
合入可能产生集成缺口。要不要在主干再验一遍？

| 选项 | ship 的语义 | 集成缺口 | 代价 |
|---|---|---|---|
| **A** | 「合入 + 验证」 | 检出即拦，main 不会坏 | ship 变慢（跑一遍全量门禁）；**ship 失败要回滚**，回滚逻辑是新复杂度 |
| **B** | 「现在就合」 | 下一次交付才发现 | 漏检 |
| **C** | 「现在就合」+ 事后提示 | 检出即提示，人决定 | ship 后多一轮门禁耗时 |

**倾向 C。** 理由：

- ADR-018 的原则是「签字回答『这份改动可以不可以合入主线』，
  合并回答『现在就合』」。ship 的语义是后者 —— 不该塞进验证。
- A 的回滚是新引入的复杂逻辑（合了、退不了），而 zelto 现在没有版本级回滚机制。
- C 与 A 的区别只在**阻断与否**，而集成缺口本来就是启发式判断
  （门禁命令全绿也可能漏掉集成问题）—— 拿它做硬阻断容易误伤。

**但 C 有个前提**：ship 后的验收结果必须**可见且有留痕** ——
写 `version.delivered` 事件，payload 里带上主干验收的结论。
人想查「这个版本合进 main 之后跑过什么」时查得到。

### D4 版本工作目录的 `node_modules`

**问题**：版本工作目录的依赖怎么来？

今天所有 worktree 链接主仓那一份（`src/core/worktree/manager.ts:505`），
理由是 ADR-011 §3.2「每次重装代价过高且易与锁文件漂移」。

**这个理由在多版本下失效**：v2 升了依赖、v3 还在用旧依赖，共用一份必然打架。

| 选项 | 机制 | 优点 | 缺点 |
|---|---|---|---|
| **A** | 每个版本工作目录各自 `npm install` | 真独立 | 每版本一次安装（慢）；**可能改锁文件**（ADR-011 当初否决的就是这条）；占磁盘 |
| **B** | 继续链接主仓那一份 | 零成本 | 多版本依赖不同时打架 —— 正是要解决的问题 |
| **C** | 默认链接主仓；**检测到锁文件与主干不同时**才独立装 | 只在真需要时付代价 | 锁文件判定要确定性（hash 比对）；仍有可能改锁文件 |
| **D** | 版本工作目录链接**上一个已交付版本**的 `node_modules` | 增量 | 首版本无解；链条复杂 |

**倾向 C，但坦白说 C 的「确定性」有坑。** 锁文件判定用 hash 比对是确定的，
但「装完之后锁文件被 npm 改了」这件事不可控 —— 这正是 ADR-011 §3.2 的原话：

> 共享连接成本恒定，且不触碰依赖清单。

**C 在触发安装时正好踩中这条否决理由。** 所以真正的取舍是：

- 要么接受「版本级安装可能动锁文件」，并在装完后**校验锁文件没被改**
  （改了就报错并 `git checkout` 还原），
- 要么退回 B，承认「多版本不能各自升级依赖」，把这条限制写进文档。

**我倾向 C + 装后校验锁文件**。理由：不动锁文件的安装（`npm ci` 语义）
本来就有；关键是**检测到越界就还原并报错**，而不是静默接受。

**这需要人拍板**：多版本各自升级依赖，是不是真的需求？
如果实际上「多版本并行时不会同时改依赖」，那 B 就够了，整个 D4 不必动。

### D5 跨版本冲突：阻断还是降级

**问题**：跨版本写集冲突检出 error 级（比如两个版本都改 `types.ts`）时怎么办？

| 选项 | 行为 | 优点 | 缺点 |
|---|---|---|---|
| **A** | 阻断 `version start` | 保守，绝不放冲突版本并行 | 启发式误伤；且**阻断发生在启动时**，此时人已经准备开跑了 |
| **B** | 提示 + 事件留痕，不阻断；另给 `--strict` 供人硬拦 | 不误伤；人拿主意 | 需要人注意到提示 |
| **C** | 自动把冲突的两个版本**串行化**（同 ADR-019 的写集降级） | 不用人管 | 跨版本串行 = 一个版本整个等另一个，代价极大；且版本级串行需要跨批次调度，zelto 现在没有这个机制 |

**倾向 B。** 理由：

1. 跨版本判定是**启发式的**（§3.6 明说挡不住语义冲突）——
   拿启发式判定硬阻断会误伤。ADR-019 把「整批 abort」改成「降级为串行」，
   正是同一个思路：**冲突可预期时不该让整个批次停下来**。
2. C 看起来最优雅，但代价不对等：同批次内降级只让两片串行；
   跨版本降级要让**整个 v2 等 v3 全部跑完**，那是天级 vs 分钟级的差别。
3. B 与 zelto 的一贯风格一致：**可预期的问题给人看，不自动决策**。

**B 的准确形态是「提示 + 事件留痕 + 默认不阻断」**，而不是「必须加参数才继续」。
`version start` 检出 error 级冲突时应该：

- 打印冲突的具体文件（哪个版本、哪个工件、哪些路径）
- 明确提示「两个版本并行会互相覆盖这些文件的后果」
- 默认**继续跑**，事件里记 `artifact.conflict_detected`
- 另给 `--strict` 让想要硬拦的人用

### D6 版本分支要不要在 ship 后删除

ADR-056 原文漏了这条。`merge-runner.ts:228` 现在合并完切片就 `git branch -d`
删掉切片分支。版本分支呢？

- **A** ship 后自动删 —— 但那样「版本级可追溯」（checkout 出这个版本整体）
  就没了。**与 §1 的第 2 条目标冲突。**
- **B** ship 后保留分支，人自己删 —— 保留追溯能力，代价是仓库里分支堆积。
- **C** ship 后保留，并打 tag 作为不可变锚点 —— 分支可删但版本状态可寻址。

**倾向 C。** git tag 是**不可变**的（分支会被 rebase、被删），
而「这个版本整体长什么样」需要不可变锚点。

但 C 要新增 tag 管理，且 tag 命名要跟分支分开
（`v2` vs `version/v2`，否则 `git tag version/v2` 和 `git branch version/v2` 混淆）。

### D1–D6 汇总

| # | 倾向 | 一句话理由 |
|---|---|---|
| D1 | **A** 从 main HEAD 建 | 基点可复现，不随依赖链改动漂移 |
| D2 | **A** 从前置版本分支 tip 建 | 否则 `dependsOn` 是假的依赖 |
| D3 | **C** 重跑但不阻断 | ship 的语义是「现在就合」，不是「再验一遍」；但结论要可见可查 |
| D4 | **C** + 装后校验锁文件 | 只在真需要时付代价；动了锁文件要还原并报错 |
| D5 | **B** 提示不阻断（默认），另给 `--strict` | 启发式判定不硬阻断，与 ADR-019 同思路 |
| D6 | **C** 保留分支 + 打不可变 tag | 「版本整体长什么样」需要不可变锚点，分支给不了 |

---

## 7. 替代方案

### 方案 A：只做版本级 worktree，不做版本分支

版本有自己的工作目录（隔离目录与 `node_modules`），但合并目标仍是 main。

**放弃理由**：解决目录与依赖隔离，解决不了「v3 看得见 v2 的改动」
（基点还是 main HEAD）与「版本级回滚单位」。是把问题挪开而不是解决。

### 方案 B：版本分支 + 人手工 `git checkout` 切换

zelto 只做版本分支的命名约定，合并目标由人自己 checkout 后 `git merge`。

**放弃理由**：C9 的写集预约跨版本就失效了 —— 人切分支时，
`process.cwd()` 变了，预约目录跟着变（`reservation.ts:17` 用相对
`projectRoot` 解析），另一个版本看不见这个预约。zelto 的价值恰恰是
「不靠人记得切换」。

### 方案 C：把版本做成「大切片」

一个版本 = 一个切片，版本间并行 = 切片间并行。

**放弃理由**：版本内的切片有依赖，需要阶段化并行；做成大切片就丢掉
阶段划分，退化成串行。ADR-017 §6 方案 B 已经否决过同样的思路。

### 方案 D：每个版本一个 clone

**放弃理由**：§2.3 —— 状态丢失、C9 跨版本失效、成本更高。

### 方案 E：版本分支自动 ship 进 main

**放弃理由**：禁区「自动合并」。ADR-017 §3.4 已经因为同一原因
移除了 `version start --auto`。

---

## 8. 影响与迁移

### 破坏性变更

1. **`zelto merge` 的默认目标语义在「切片属于某版本」时改变** ——
   从合 main 变成合版本分支。
   - 缓解：不属任何版本计划的切片走原路径（§3.2 第 4 条），老项目无感
   - 需要更新的脚本：`zelto merge <id>` 在有版本计划的项目里，
     要加 `--target main` 才能保持原语义
2. **`version deliver` 的前置条件判据改变** —— 从「已合入 main」改成
   「已合入版本分支」。**已有项目在升级后需要先跑一次 ship**
   （否则版本永远交付不了）
3. **`node_modules` 的链接目标变化**（若采纳 D4-C）——
   老 worktree 里的链接指向主仓，需要重建

### 没有改的东西

事件类型集合、`slice.json` / `slice-v2.json` schema、`policy.yaml` 格式、
写集预约机制、hook 判定顺序、AGENTS.md 的任何禁区。

### 新增文件

| 文件 | 作用 |
|---|---|
| `src/core/version/branch.ts` | 版本分支名派生、版本 ↔ 切片归属解析 |
| `src/core/sched/cross-version.ts` | 跨版本写集/工件冲突检测 |
| `src/core/worktree/dependencies.ts` | 版本工作目录的依赖隔离（D4-C） |
| `src/cli/commands/version-runtime.ts` | 版本工作目录准备、基点计算、跨版本冲突呈现 |
| `src/cli/commands/version-ship.ts` | `zelto version ship` / `version cleanup` |
| `tests/adr-056-version-branches.test.ts` | ADR-056 判定测试（44 个） |
| `tests/adr-056-real-project.test.ts` | 真实项目验证挖出的 bug 的回归测试（18 个） |
| `scripts/verify-adr056.mjs` | 端到端验证脚本（版本分支 → ship） |
| `scripts/verify-adr056-multiversion.mjs` | 多版本验收脚本（并行 / 依赖 / 冲突） |
| `scripts/verify-adr056-nimrtc.mjs` | 真实项目验收脚本（nimrtc-zelto 副本） |
| `docs/adr-056-version-level-branches.md` | 本文件 |

---

## 8.1 实现时发现的问题（补记）

实现过程中撞到三个 ADR 没预料到的坑，记在这里：

### 坑 1：`--target` 的值被当成切片 id

`zelto merge --target version/v2` 报「Slice(s) not found: version/v2」。

原因：参数解析只排除了以 `--` 开头的参数，而 `--target` 的**值**
（`version/v2`）不以 `--` 开头，被当成了切片 id。

修法：解析 ids 时排除所有**带值选项**的值
（`--strategy` / `--target` / `--plan` / `--depends-on`）。

**这是既有缺陷**——`--strategy merge_commit` 之前也有同样的问题，
只是当时没人用 `--strategy` 时会连带把值传下去。ADR 顺手修了。

### 坑 2：合进版本分支后，切片分支删不掉

`git branch -d slice/sl-a` 报「may have unmerged changes」——
因为 `-d` 要求分支已合入 **HEAD**，而 HEAD 是主仓当前分支，
切片合的是 `version/v2`。

修法：`cleanupMergedSlices` 接目标分支，按目标 ref 判：
`git branch -d slice/sl-a version/v2`。

### 坑 3：版本工作目录路径含 `worktrees` 子串

`list()` 按 `.zelto/worktrees/` 标记反解 sliceId。版本目录是
`.zelto/version-worktrees/v2/` —— **含 `worktrees` 子串**，
顺序判错就会被当成切片 worktree，进而被切片清理逻辑误删。

修法：`list()` 里**先判版本标记再判切片标记**。这印证了 §3.1
「另起一个 base」的判断是对的 —— 但还不够，还得管判的顺序。

### 坑 4：编码守卫误报

编码守卫把某个常用汉字当成 GBK 误解码特征字符。
我在注释里写了一句带这个字的文案，被判成乱码污染。

修法：改文案避开那个字。**守卫本身没动** —— 它的标记字符集是从
语料统计出来的，动它会影响所有文件。

**教训**：注释里的中文也是受管内容，写完要过 `check:encoding`。

### 坑 5：跨版本冲突检测**永远检不出冲突**（最严重的一个）

D5-B 实现完后，端到端验收一跑就露馅了 —— `version start v3`
一个字都没提示。

根因在 `detectCrossVersionConflictsFor`：

```ts
// 错的
return detectCrossVersionConflicts(versions.filter((v) => v.version !== currentVersion));
```

它把**当前版本**从列表里排除了。而 `detectCrossVersionConflicts`
是**两两比对** —— 列表里只剩「别人」之后，没有任何一对可比，
于是结果恒为空。

**为什么单元测试没发现**：单元测试直接测 `detectCrossVersionConflicts`
（传两个版本），而错误的过滤在**上一层**（`detectCrossVersionConflictsFor`）。
测了内层、没测外层。

修法：当前版本**必须留在列表里**（它就是要跟别人比的那个）。
另加按 label 去重（同一个版本被重复收集时只算一次）。

**教训**：包装函数也要测。这次补了 4 个针对 `detectCrossVersionConflictsFor`
的回归测试（`tests/adr-056-version-branches.test.ts`）。

### 坑 6：跨版本写集收集用的是内存副本

`collectVersionWriteSets(targetPlan)` 传的是内存里的计划对象。
但 `updateVersionStatus` 写的是**盘**，内存副本的 `status` 还是旧的 ——
本版本刚被设成 `in_progress`，内存里还是 `planned`，
于是**本版本自己被过滤掉**了（即使修好坑 5 也检不出）。

修法：`collectVersionWriteSets` 改成收 `planId` 并**重新读盘**。

### 坑 7：冲突检测的位置

原本放在 Phase 2 里，「没有待执行切片」的早退在它前面 ——
于是重跑一个已跑完的版本时，冲突永远不会被报出来。

修法：移到 Phase 1 之后、Phase 2 之前，早退也在它后面。

### 坑 8：真实工程里才暴露的 6 个 bug

见 §9「真实项目验证」。其中三个值得单独记：

**坑 8a：验收骨架挡住一切合并**

`zelto version start` 会给每个切片生成验收骨架
（`tests/acceptance/<id>/acceptance.test.cjs`，ADR-034）。
骨架落在**主仓**里 → 主仓多了未跟踪目录 → **之后每次 merge 与 ship
都被「工作区必须干净」守卫拦下**。

`version start` 生成骨架 → 之后什么都合不进去 —— 这是个闭环死锁。

处置：豁免「还全是 todo 的骨架」。**只豁免纯 todo** ——
agent 把 todo 改成真断言之后，那文件就是代码（进了写集、参与门禁②），
合并会覆盖它，必须挡住。

> 坑中坑：git 把未跟踪**目录**折叠成目录本身
> （`?? tests/acceptance/v2-x/` 而不是逐个文件）。
> 拿到的不是文件路径，读不到内容 → 判定失效。得按目录判：
> 目录里每个骨架都得是纯 todo，且不能有别的测试文件。

**坑 8b：跨版本与同批次的粒度要求不同**

`detectArtifactConflicts`（同批次，ADR-012）按**工件名**分组 ——
两个切片碰同一类工件就算冲突。`type-definitions` 这个名字指所有 `.hpp`。

把 C++ 规则加进 `BUILTIN_MAPPINGS` 会怎样：
「A 改 foo.hpp、B 改 bar.hpp」→ 同一个 `type-definitions` → **error**
→ `batch.ts` 把它塞进 issues → **并行准入被阻断**。

同批次的粒度是「碰同一类工件」，跨版本的粒度是「碰同一个文件」。
两者的冲突定义不同，映射表也不能共用。

处置：跨版本判定**按路径逐个定级**（每个重叠路径单独出一条），
并给跨版本判定一张专属的 `CROSS_VERSION_MAPPINGS`。

**坑 8c：`save(旧对象)` 覆盖 `updateVersionStatus` 写的状态**

```ts
await versionStore.updateVersionStatus(planId, label, 'delivered');  // 读盘→改→写盘
version.tag = tag;
await versionStore.save(targetPlan);   // ← targetPlan 是**旧对象**，status 还是 integrated
```

第二行把刚写进盘的 `delivered` 覆盖回了 `integrated`。
症状：ship 完成了、tag 打了，状态却没变。

修法：先在内存对象上改 tag 与 status，再一次性落盘。

---

## 9. 验证方式
### 单元测试（`tests/adr-056-version-branches.test.ts`，44 个，已实现）

- ✅ 版本分支名派生：`version/<label>`，label 含特殊字符时的规范化
- ✅ 版本 tag 名与分支名分开
- ✅ 归属解析：命中版本计划 / 命中多个计划报错 / `--plan` 消歧 /
  规格 frontmatter / 兜底合 main / `--target` 显式指定
- ✅ 跨版本工件检测：error / warning / info 三级分类
- ✅ **跨版本冲突检测的包装函数**（坑 5 的回归测试，4 个）
- ✅ 依赖隔离：锁文件状态、hash 比对、`link` vs `install` 策略判定
- ✅ 确定性：同输入必得同结果

### 端到端验证（`scripts/verify-adr056.mjs`，手动跑，已通过）

真实 git 仓库里跑完整链路：

```
1. 建仓库 + zelto init
2. 建版本计划（v2 含两个切片）
3. zelto version start v2        → 建 version/v2 分支 + 版本工作目录
4. 切片产物提交到 slice/<id>
5. zelto merge --target version/v2 → 合进版本分支，**主干不动**
6. zelto version ship v2          → 合进主干 + 打 tag
```

验证结果：

| 断言 | 结果 |
|---|---|
| 版本分支 `version/v2` 建出来了 | ✅ |
| 版本工作目录 `.zelto/version-worktrees/v2` 建出来了 | ✅ |
| 合并后主干**没有**拿到切片产物 | ✅ |
| 版本分支拿到了切片产物 | ✅ |
| ship 之后主干拿到 `src/a.ts` / `src/b.ts` | ✅ |
| 版本 tag 打上了（`v2`） | ✅ |
| 版本分支保留（追溯锚点） | ✅ |
| 写了 `merge.*` 与 `version.delivered` 事件 | ✅ |

### 多版本验收（`scripts/verify-adr056-multiversion.mjs`，手动跑，已通过）

覆盖 ADR §9 原本缺的那三项：

**A. 两个版本并行**

| 断言 | 结果 |
|---|---|
| v2、v3 两个版本分支都在 | ✅ |
| 两个版本各有自己的工作目录 | ✅ |
| v2 / v3 的基点已钉死 | ✅ |
| 两个版本基点相同（都是主线 HEAD，互相独立） | ✅ |
| **v3 的工作目录看不到 v2 的未 ship 改动** | ✅ |
| **v2 的工作目录看不到 v3 的未 ship 改动** | ✅ |
| 产物在切片分支上（还没合进版本分支） | ✅ |

**B. v3 依赖 v2**

| 断言 | 结果 |
|---|---|
| v2 的切片合进了 version/v2 | ✅ |
| **v3 的基点是 version/v2 的 tip** | ✅ |
| **v3 的工作目录看得见 v2 的改动（依赖是真的）** | ✅ |
| v3 切片 worktree 的基点是 version/v2 的 tip | ✅ |
| v3 切片 worktree 的 HEAD 就是 version/v2 的 tip | ✅ |

**C. 跨版本冲突**

| 断言 | 结果 |
|---|---|
| 提示了跨版本重叠（`type-definitions` / `src/types.ts`） | ✅ |
| 明说了这是启发式判断 | ✅ |
| 默认不阻断 | ✅ |
| 写了 `artifact.conflict_detected` 事件 | ✅ |
| `--strict` 下阻断（退出码非 0） | ✅ |
| `--strict` 的阻断理由是跨版本冲突 | ✅ |
| `--strict` 下没有继续执行切片 | ✅ |
| 低风险重叠（docs 类别）提示了但不阻断 | ✅ |

### 全量回归

- 单元测试：**1696 通过 / 0 失败**（含新增的 44 + 18 个 ADR-056 测试）
- `npm run lint`：通过
- `npm run check:encoding`：通过
- `npm run build`：通过

### 真实项目验证（nimrtc-zelto，`scripts/verify-adr056-nimrtc.mjs`，已通过）

在 nimrtc-zelto 的**克隆副本**上跑（不碰真实仓库）。
真实计划：`v1 → v2 → v3` 依赖链，v1 与 v3 都写
`net_feedback/aggregator.hpp` 与 `aggregator.cpp` —— 现成的跨版本重叠场景。

| 断言 | 结果 |
|---|---|
| 真实计划里确实存在跨版本写集重叠 | ✅ |
| C++ 头文件被判为 **error** 级（类型定义） | ✅ |
| C++ 源文件被判为 api_contract 级 | ✅ |
| 冲突按**具体路径**分别报出，不是笼统的「都动同一工件」 | ✅ |
| `version/v1` 分支 + 版本工作目录建出来 | ✅ |
| v3 因依赖 v2 未 integrated 被拦（ADR §3.2 依赖串行仍生效） | ✅ |
| 被拦时不建分支、不建工作目录 | ✅ |
| v1 的切片合进 `version/v1` | ✅ |
| v2 的基点是 `version/v1` 的 tip | ✅ |
| **v2 的工作目录看得见 v1 的改动**（依赖是真的） | ✅ |
| 未跟踪的验收骨架被判为 zelto 管理的产物 | ✅ |
| 骨架改成真断言后不再豁免 | ✅ |
| ship 之后打上 `v1` tag、版本分支保留 | ✅ |
| ship 之后版本状态 → `delivered` | ✅ |

**这一轮在真实工程里挖出 6 个 bug**（合成环境与单元测试全都测不到）：

| # | Bug | 后果 |
|---|---|---|
| 8 | C++ 头文件/源文件没有工件映射 | 「两个版本都改同一个 `.hpp`」降级成 warning，真冲突被当成提示 |
| 9 | 跨版本冲突按**工件名**合并 | 「A 改 foo.hpp、B 改 bar.hpp」被说成「都动 type-definitions」—— 不是冲突，是碰巧同类 |
| 10 | `version ship` 的工作区守卫没豁免 zelto 管理的规格文件 | ship 被自己的产物挡住（`merge` 早就豁免了，`ship` 漏了） |
| 11 | 未跟踪的**验收骨架**挡住 merge 与 ship | `version start` 生成骨架 → 主仓变脏 → 之后每次合并都被拦。**这个最狠** |
| 12 | `version ship` 里 `save(旧对象)` 覆盖了 `updateVersionStatus` 写的状态 | ship 完成了、tag 打了，状态却停在 `integrated` |
| 13 | `version deliver` 一路设到 `delivered` | 验收一过就宣布交付，但版本分支还没进主干 —— 报出假的交付状态 |

**处置**：

- **8 + 9** 合并处理：新增 `CROSS_VERSION_MAPPINGS`（跨版本判定**专属**的映射表），
  并把跨版本冲突判定改成**按路径逐个定级**。
  > 为什么不加进 `artifact.ts` 的 `BUILTIN_MAPPINGS`：那张表是给同批次判定用的，
  > 按**工件名**分组 —— 加进 C++ 规则会让「A 改 foo.hpp、B 改 bar.hpp」
  > 被判成 error，**误伤本可以并行的两个切片**。
  > 同批次与跨版本的粒度要求不同，所以分成两张表。
- **10 + 11**：新增 `core/project/managed-acceptance.ts` —— 判定「验收文件还是不是
  纯 todo 骨架」。**只豁免纯 todo**；agent 改成真断言之后那文件就是代码，必须挡住。
  > 坑：git 把未跟踪**目录**折叠成目录本身（`?? tests/acceptance/v2-x/`），
  > 拿到的不是文件路径 —— 得按目录判（目录里每个骨架都得是纯 todo，
  > 且不能有别的测试文件）。
- **12**：改成先在内存对象上改 tag 与 status，再一次性落盘。
- **13**：`version deliver` 只到 `integrated`；`delivered` 由 `version ship` 独占
  （ADR §3.5：「`delivered` = 已进主干」）。

**回归测试**：`tests/adr-056-real-project.test.ts`（18 个）

---

## 10. 决定

**已按倾向值实现（2026-11-12）。** §6 的 D1–D6 全部采纳倾向表。

| # | 采纳 | 一句话理由 |
|---|---|---|
| D1 | **A** —— 版本分支从主干 HEAD 建 | 基点可复现，不随依赖链改动漂移 |
| D2 | **A** —— 后置版本从前置版本分支 tip 建 | 否则 `dependsOn` 是假的依赖 |
| D3 | **C** —— ship 后重跑主干验收，只提示不阻断 | ship 的语义是「现在就合」；但结论写进 `version.delivered` 事件，可查 |
| D4 | **C** —— 锁文件不同才独立装 + 装后校验 | 只在真需要时付代价；动了锁文件要还原并报错 |
| D5 | **B** —— 提示不阻断（默认），另给 `--strict` | 启发式判定不硬阻断，与 ADR-019 同思路 |
| D6 | **C** —— 保留分支 + 打不可变 tag | 「版本整体长什么样」需要不可变锚点 |

### D4 的实现注记

D4-C 的「装后校验锁文件」实际落地为：

- 安装一律用**不改动锁文件**的语义（`npm ci` / `--frozen-lockfile`）
- 装完比对锁文件 hash —— 变了就 `git checkout` 还原并报错

**D4 的前提问题仍未回答**：多版本并行时各版本会不会各自升级依赖？
实现上这条链路已经就位（锁文件不同 → 独立装），但如果实际场景里
不会发生，D4 整条就是永不触发的死代码 —— 值得在真实项目上验证时
确认一下。

### 实现与 ADR 的偏差

| ADR 原文 | 实现 | 原因 |
|---|---|---|
| §3.8 「`worktree.created` 加 `kind` 字段」 | 已加（`slice` / `version`） | 一致 |
| §4.1 `Version` 加 `branch` / `baseCommit` | 已加，另加 `tag` | D6 需要 tag 落盘 |
| §3.5 `version ship` | 已加 `version cleanup` | 版本工作目录要有人清理 |
| §3.6 跨版本检测的 `target` 字段 | 改为事件 payload 的 `conflicts` 数组 | 结构化更好查 |

### 状态

**已实现并通过全部自动化验证** —— 含合成环境验收（多版本并行 / 依赖 / 跨版本冲突）
与**真实项目验收**（nimrtc-zelto，6 个 bug 全部修掉并加了回归测试）。

### 实现中修掉的 bug（按严重度）

| # | Bug | 影响 |
|---|---|---|
| 5 | 跨版本冲突检测永远检不出冲突（排除了当前版本，而比对是两两的） | **D5-B 整个功能形同虚设** |
| 6 | 跨版本写集收集用内存副本，本版本自己被过滤掉 | 同上，第二次踩 |
| 7 | 冲突检测位置在早退之后，重跑已完成的版本时不报 | 漏报 |
| 11 | 未跟踪的**验收骨架**挡住 merge 与 ship | **真实项目里最狠的一个**：主仓永远合不进去 |
| 12 | `version ship` 用旧对象覆盖了刚写的状态 | ship 完成了但状态没变 |
| 13 | `version deliver` 越权宣布 delivered | 报出假的交付状态 |
| 8 | C++ 头文件没有工件映射 | 真冲突降级成提示 |
| 9 | 跨版本冲突按工件名合并 | 「碰巧同类」被说成冲突 |
| 10 | `version ship` 没豁免 zelto 管理的规格文件 | ship 被自己的产物挡住 |
| 1 | `--target` 的值被当成切片 id | `zelto merge --target` 完全不可用 |
| 2 | 合进版本分支后切片分支删不掉 | 分支残留 |
| 3 | 版本工作目录路径含 `worktrees` 子串，可能被误删 | 数据丢失风险 |
