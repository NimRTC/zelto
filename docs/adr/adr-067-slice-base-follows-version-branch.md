# ADR-067：切片的基点必须跟随归属版本分支推进

**状态**: 已实施
**日期**: 2026-11-16
**作者**: 系统架构
**关联约束**: C1, C3, C9
**关联文档**: `src/cli/commands/shared.ts`（`ensureWorktree`）,
`src/cli/commands/parallel-executor.ts`（批次执行）,
`src/core/sched/audit.ts`（写集审计）,
`src/core/version/branch.ts`（归属解析）

---

## 1. 摘要

同一个版本里的第二片切片，如果从**主干 HEAD** 建 worktree 而不是从
**版本分支的 tip** 建，它就看不到前一片的产物 —— 而这正是
「版本分支模式」（ADR-056）存在的全部理由。

本 ADR 修的正是这个洞：**`zelto run <id>`（单片路径）不解析切片归属，
直接拿主干 HEAD 当基点。**

实测代价（nimrtc-zelto 第二轮演练，缺陷 **D-28**）：

| 项 | 事实 |
|---|---|
| 受影响的切片 | `v1-engineimpl`（版本 `v1` 的第二片，依赖 `v1-rtcpprocessor`） |
| 基点 | `489de212`（主干 HEAD）—— 与 `v1-rtcpprocessor` **完全相同** |
| 后果 | agent 看不到 `rtcp_processor.hpp` / `engine_rtcp_xr.cpp` / 上一片的验收测试 |
| agent 的反应 | 被迫**重新实现**上一片的内容（`rtcp_processor.cpp` 716 行、`engine_media.cpp` 净减 306 行） |
| 写集守卫生效 | 是 —— agent 想改 `rtcp_processor.hpp`（上一片的文件）被当场拦下 |
| 写集审计误报 | 是 —— 把**上一片的产物**算成「越界写入」，切片退回 `frozen` |

**审计误报是本文的核心。** 详见 §3。

---

## 2. 现象与根因

### 2.1 时间线（实测 reflog，2026-11-16）

```
11:27:17  c117d13a  feat(v1-rtcpprocessor): slice approved      ← 上一片产出
11:27:24  720d47ab  version/v1 ← merge slice/v1-rtcpprocessor    ← 合进版本分支
11:28:25  489de212  slice/v1-engineimpl: branch: Created from 489de212  ← ✗ 从主干 HEAD 建
11:28:47  run.started  v1-engineimpl
   ...    agent 跑了 50 分钟，反复实现上一片的内容
11:38:30  c117d13a  slice/v1-engineimpl ← merge slice/v1-rtcpprocessor (Fast-forward)
                                                       ← ✗ 事后才把上一片拉进来
```

两片的 `baseCommit` 都是 `489de212`（主干 HEAD）：

```
v1-rtcpprocessor.json  baseCommit=489de2123c90c0acf55a89dbfc29108bdf7ccefb
v1-engineimpl.json     baseCommit=489de2123c90c0acf55a89dbfc29108bdf7ccefb
```

### 2.2 根因：单片路径不解析归属

ADR-056 §3.3 已经把「基点覆盖」做出来了 ——
`ensureWorktree(id, { baseCommitOverride })` 支持指定基点，
`executeSlicesByPhase` 也把它透传下去。

但**只有版本流水线（`zelto version start`）会传它**：

```ts
// src/cli/commands/ai-pipeline.ts:1414
const result = await executeSlicesByPhase({
  ...
  baseCommitOverride: versionBaseCommit,   // ← 版本分支的 tip
});
```

而单片路径（`zelto run <id>`）不传：

```ts
// src/cli/commands/core-slice.ts:1151
worktree = await ensureWorktree(id);   // ← 没有 override
```

`ensureWorktree` 于是退回 `slice.baseCommit ?? null`，再退回
`this.headCommit()`（= 主干 HEAD）。

**结果**：`zelto version start v1` 能让同版本切片看到彼此，
但 `zelto run v1-engineimpl`（或者任何走单片路径的执行）不能。

演练里走的就是后者 —— 第一片跑完后，我单独跑了第二片。

### 2.3 为什么 `baseCommitOverride` 不能直接复用

`baseCommitOverride` 是**调用方**传进来的具体 commit。它解决不了
「单片路径不知道自己属于哪个版本」这个问题。

归属解析（`resolveSliceOwnership`）已经存在，且优先级明确：

1. 命令行显式指定（`--target`）
2. 版本计划成员扫描
3. 规格 frontmatter 的 `version:` 字段
4. 兜底：合入主干当前分支

**缺的只是把它接进 `ensureWorktree`。** 切片属于版本 `v1` →
基点就应该是 `version/v1` 的 tip。

---

## 3. 为什么表现是「越界误报」而不是「看不见」

这是本 ADR 最需要说清楚的一节 —— 因为**症状极具误导性**。

### 3.1 写集守卫生效了（这是对的）

agent 想改 `src/engine/src/rtcp_processor.hpp`（上一片建的），hook 判：

```json
{"decision":"deny","ruleId":"writes:v1-engineimpl",
 "reason":"写入目标 \"src/engine/src/rtcp_processor.hpp\" 不在切片 \"v1-engineimpl\" 的写集内",
 "tool":"Edit"}
```

**这条拦截完全正确** —— `rtcp_processor.hpp` 确实不在本片的写集里。
C9 的运行时守卫没有漏判。

### 3.2 但运行后的审计把它算成了「agent 越界」

`auditWorktreeWrites` 的审计范围是 **基点..HEAD 加上工作区改动**：

```ts
// src/core/sched/audit.ts:237
if (baseCommit) {
  const diff = git(['diff', '--name-only', `${baseCommit}..HEAD`], worktreeRoot);
  ...
}
```

而 `HEAD` 在运行中途被快进到了 `c117d13a`（上一片的提交）。
于是审计看到的「已提交改动」是：

```
$ git diff --name-only 489de212..HEAD
src/engine/CMakeLists.txt                            ← 上一片
src/engine/src/engine_media.cpp                       ← 上一片
src/engine/src/engine_rtcp.cpp                        ← 上一片
src/engine/src/engine_rtcp_xr.cpp                     ← 上一片（不在本片写集）
src/engine/src/rtcp_processor.cpp                     ← 上一片
src/engine/src/rtcp_processor.hpp                     ← 上一片（不在本片写集）
tests/acceptance/v1-rtcpprocessor/acceptance.test.cjs ← 上一片（不在本片写集）
```

**三个「越界」文件，没有一个是本片 agent 写的** —— 它们是上一片的产物，
经由一次事后快进进了本片的分支历史。

于是审计判本片越界，切片退回 `frozen`：

```
[run.aborted] {"sliceId":"v1-engineimpl", ...}
```

**这是三重误报叠在一起：**

| 层 | 误报 |
|---|---|
| 现象 | 「agent 越界写了 3 个文件」 |
| 事实 | agent **一个字节都没碰**那三个文件 |
| 更深 | agent 是**被迫**去实现上一片的内容（因为基点错了） |

### 3.3 为什么 agent 会「被迫重新实现」

agent 在 worktree 里**看不到** `rtcp_processor.hpp`（基点里没有这个文件），
但规格明写「让 `Impl` 持有 `RtcpProcessor` 成员」、「`rtcp_processor.cpp` 里
不得出现 `impl_->` 形式的引擎私有路径访问」。

agent 的处境：规格要求它接线一个**不存在的协作者**。
它唯一能做的就是在 `rtcp_processor.cpp` 里**造一个**。

于是：

```
M src/engine/src/engine_impl.hpp                 ← 本片该改的
M src/engine/src/engine_media.cpp                ← 本片该改的
M src/engine/src/engine_rtcp.cpp                 ← 本片该改的
M src/engine/src/rtcp_processor.cpp              ← 本片写集内（但内容是重造上一片）
M tests/acceptance/v1-engineimpl/acceptance.test.cjs ← 本片该改的
```

**agent 的每一步都在写集内** —— 它没有违反任何约束。
它只是被放在了一个**信息不完整的世界**里。

第二次运行（续跑）时，它在已有的 `rtcp_processor.cpp` 上继续写，
并且明确报告：「The RTCP collaborator wiring was already in place when I started」
—— 它以为那是上一片留下的，实际上是它自己第一次跑时造的。

---

## 4. 决策

### 4.1 D1：基点跟随归属版本分支

`ensureWorktree` 在没有显式 `baseCommitOverride` 时，
**自己解析归属**，取归属版本分支的 tip 作为基点。

```
基点解析顺序（与 ADR-056 §3.2 的归属解析同一优先级）：
1. 显式 baseCommitOverride        —— 版本流水线已经算好了
2. slice.baseCommit 已钉死        —— 已经跑过一次，基点要可复现
3. 归属版本分支的 tip              —— 本次新增
4. 主干 HEAD                      —— 兜底（老项目 / 不在任何版本计划里）
```

**第 2 条不能省。** 切片文件的 `baseCommit` 一旦写入就不再重算 ——
那是 ADR-041 §3.2 的「基点可复现」保证。重跑同一个切片必须回到同一个基点，
否则审计的 diff 范围会变，越界判据会漂。

### 4.2 D2：归属解析失败不阻塞

`resolveSliceOwnership` 在命中多个版本计划时抛 `AmbiguousOwnershipError`。
**基点解析不应该因为这个抛异常** —— 合并路径上已经有一条明确的报错路径，
而基点解析发生在更早的阶段（建 worktree 时）。

处理：捕获异常 → 退回主干 HEAD → **写一条事件**说明「归属不明确，基点退回主干」。
不静默降级（事件流里看得见，C4）。

### 4.3 D3：审计的 diff 范围要排除「非本片产生的提交」

这一条是 §3.2 那个误报的**根治**。

即便基点修好了，还有一个残留风险：如果 `slice/<id>` 分支在运行期间
被别的东西推进过（比如人手动 merge 了别的东西），审计仍会把那些提交
算成「本片的越界写入」。

审计要回答的问题是「**本片 agent 改了什么**」，不是
「**本片分支上有哪些提交**」。

所以审计需要一个**提交白名单**：本片自己产出的提交（`Refs-Slice: <id>` trailer）
才算本片的改动；其余提交**不计入**。

这个判据用 git 的 commit trailer（已有的 `Refs-Slice:` 约定），
确定性可判（C3），不需要任何模型参与。

### 4.4 D4：`git merge` / `git checkout` 不写文件，但会改工作区状态

agent 在 worktree 里跑 `git merge <别的分支>`（实测中 agent 自己做过
`git merge slice/v1-rtcpprocessor` 来找上一片的东西），**不写任何文件**，
所以 hook 的写目标提取（`extractBashWriteTargets`）抽不出目标 →
`hook:no-target` → 放行。

这在**当前隔离模型下**是安全的（worktree 是 agent 独占的，
merge 进来的内容仍会被审计抓到），但它是一个**未被表达的假设**。

本 ADR 不改 hook 行为（改动面大、风险高），但把它记进 ADR-067 §5，
作为 D3 的动机之一：D3 让审计不再依赖「HEAD 里的东西都是本片的」这个假设。

---

## 5. 变更清单

| 文件 | 变更 |
|---|---|
| `src/cli/commands/shared.ts` | `ensureWorktree` 增加归属解析 → 基点取版本分支 tip |
| `src/cli/commands/shared.ts` | 新增 `resolveSliceBaseCommit`（纯函数，可单测） |
| `src/core/sched/audit.ts` | 审计按 `Refs-Slice:` trailer 过滤提交，只算本片产物 |
| `src/core/sched/audit.ts` | `auditWorktreeWrites` 新增 `sliceId` 选项 |
| `src/cli/commands/runtime-guard.ts` | 传递 `sliceId` 给审计 |
| `src/cli/commands/parallel-executor.ts` | 传递 `sliceId` 给守卫 |
| `src/cli/commands/core-slice.ts` | 传递 `sliceId` 给守卫 |
| `docs/adr/adr-067-slice-base-follows-version-branch.md` | 本文 |

### 5.1 基点解析的落点

```ts
// src/cli/commands/shared.ts
export function resolveSliceBaseCommit(
  sliceId: string,
  sliceBaseCommit: string | null,
  options: { override?: string | null; repoRoot?: string },
): { commit: string | null; source: 'override' | 'pinned' | 'version-branch' | 'head' }
```

### 5.2 审计的提交过滤

```ts
// src/core/sched/audit.ts
/**
 * 分支上的提交里，哪些是「本片自己产出的」。
 *
 * 判据：commit message 里有 `Refs-Slice: <sliceId>` trailer。
 */
export function commitsOfSlice(
  repoRoot: string,
  baseCommit: string,
  headCommit: string,
  sliceId: string,
): string[];
```

审计的 diff 范围变成「本片的提交」而不是「基点..HEAD 的全部」。

---

## 6. 验证

### 6.1 单元测试（新增 `tests/slice-base-version-branch.test.ts`）

1. 切片属于版本 `v1` → 基点取 `version/v1` 的 tip
2. 切片不属于任何版本 → 基点取主干 HEAD
3. `slice.baseCommit` 已钉死 → 不被版本分支 tip 覆盖（可复现性）
4. 显式 `baseCommitOverride` 优先于一切
5. 归属歧义（命中多个计划）→ 退回主干 HEAD，**不抛异常**
6. 审计：`Refs-Slice: other` 的提交**不计入**本片越界
7. 审计：`Refs-Slice: <本片>` 的提交**计入**

### 6.2 端到端

`v1-engineimpl` 重跑：基点应为 `c117d13a`（`version/v1` 的 tip），
agent 应能看到 `rtcp_processor.hpp`，不再重造上一片，
写集审计不应报越界。

### 6.3 回归

`npm test` 全绿 + `npx biome check` 干净。

---

## 7. 教训

### 7.1 「误报」比「漏报」更容易误导人

D-28 的现象是「agent 越界写了 3 个文件」。这句话**每一部分都是错的**
（agent 没越界、没写、那 3 个文件不是它的）。但它出现在
`run.aborted` 事件里，出现在切片退回 `frozen` 的原因里 ——
**人读到的是「agent 不老实」**。

如果不去查 git reflog 逐条对时间线，这个误报会被当成
「agent 能力不足 / 模型不听话」，然后被「优化规格」或「加大写集」，
而**真正的根因**（基点错了）会被完全掩盖。

**判据出问题时，先查「它到底在说什么」的事实基础，再谈怎么修。**

### 7.2 一个洞往往在「另一条路径上」

基点覆盖（`baseCommitOverride`）**早就存在**了，ADR-056 §3.3 还专门写了
「版本里的切片基点来自版本分支的 tip，而不是主仓 HEAD」。

但那条能力只接在**版本流水线**上。单片路径没接。

**同一个概念在两条路径上实现，迟早有一路径漏掉。**
这次的代价是 50 分钟 agent 运行 + 一次写入白工 + 一个误导性的「越界」结论。

### 7.3 「守卫正确地拦住了」不等于「系统是对的」

写集守卫生效了 —— agent 想改 `rtcp_processor.hpp` 被当场拦下。
这条记录看起来是「C9 有效」。

但它拦住的其实是一个**被基点错误逼出来的合理请求**：
agent 想改那个文件，是因为那个文件**本该存在**。

**守卫拦住了越界，不等于守卫前面没有制造越界。**
防御性机制生效，反而容易让人不去追问「为什么会有人想越界」。

---

## 8. 关联

- ADR-056（多版本并行，版本分支模式）—— 本 ADR 补它的单片路径
- ADR-041 §3.2（基点回写与可复现）—— D1 第 2 条的依据
- ADR-014 §5（写集审计作为运行后兜底）—— §3.2 的误报发生在这里
- ADR-024（亲和调度与写集重叠检测）—— 写集重叠检测准确，但基点错了它也无能为力
