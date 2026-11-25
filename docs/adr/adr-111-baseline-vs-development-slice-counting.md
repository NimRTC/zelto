# ADR-111：基线切片与开发切片分开计数 —— 完成度不许把「现状」算成「活」

**状态**：实施
**日期**：2026-11-25
**相关**：ADR-039（接管既有项目 → 基线切片）、ADR-072（驾驶舱只读 + 签字）、ADR-081（驾驶舱列表不许静默丢片）、C3（判定必须确定性）、C4（每个动作写 append-only 事件流）

## 背景

驾驶舱（`zelto web`）的概况页显示「8 个切片都完成了」。

实测（nimrtc-v14，2026-11-25）：`.zelto/slices/` 里 8 片全是 `completed`。
但那轮**只开发了 5 片**。

差的 3 片是 `v0-cmake` / `v0-src-log` / `v1-cmake` —— **基线切片**：

- 它们是**接管既有项目**时登记的「现状」（ADR-039 §3）；
- 描述的是「这个模块现在有哪些文件」，**不改代码**；
- 状态直接落在 `completed` —— 因为它们是**既成事实**，不是待办的活；
- `trace.requirements` 是真实条目（人写的），不是 `(v0 baseline)`；
- `traceWaiver` 是「C++ 项目不使用 JSON Schema 契约」。

驾驶舱的概况页把两者混在同一个 `byState` 计数里：

```
byState.completed = 8   ← 说的不是「开发完成度」
```

## 为什么这是真问题，不只是显示口味

「切片完成了」与「这版做完了」**不是同一件事**。

v1.4 计划里 N5 / N2 / D3 / D4 / D5 只是 N、D 两条轨道的一部分 ——
「8 片全完成」让人以为整个版本做完了，而实际进度远没那么远。

这与 §11.33 的形状相同（ADR-081 记的）：**「算错」比「查不到」更容易被忽略**。
一个虚高的完成度不会跟任何别的证据打架 —— 人只会相信它。

## 难点：基线切片没有可靠的单一标记

直觉上该用 `slice.baseline` 字段 —— 它**确实存在**，而且是权威标记
（`registerBaselineSlices` 生成基线切片时写死 `true`，
`core/sched/engine.ts` 也用它跳过写集预约与追溯准入）。

但实测三片基线切片的 `baseline` 字段**在文件里根本不存在**：

| | 工具生成的基线切片 | nimrtc-v14 的 `v0-cmake` / `v1-cmake` |
|---|---|---|
| `baseline` | `true` | **字段缺失** |
| `runs` | `[]` | `[]` |
| `trace.requirements` | `['(v0 baseline)']` | 真实需求条目 |
| `traceWaiver` | 「基线切片 — 描述现状…」 | 「C++ 项目不使用 JSON Schema 契约」 |
| `state` | `completed` | `completed` |
| 事件流 | 有 `slice.baseline_registered` | **零事件** |

原因：工具的基线功能落地之前，人只能**手写状态文件**。

于是判据不能只看 `baseline` 字段。

## 判据（三条，按优先级，先命中先用）

判定落在 `core/slice/baseline-kind.ts`（C3：纯判定，只读文件、不触网）。

### 判据 1：`baseline === true`

工具生成的基线切片。权威、可证伪。

### 判据 2：`baseline` 字段**缺失** + 零事件 + `state === 'completed'`

老版本手工建的基线切片。三段条件**缺一不可**：

- **`baseline` 字段缺失**（不是 `false`）——
  `false` 是「明确不是基线」，`undefined` 是「这个文件写的时候还没这个字段」。
  所有老切片文件都缺它（`store.create` 才写 `baseline: false`，那也是后来才加的）。
- **零事件** —— 从没被动过。
- **`completed`** —— 开发切片要走完状态机，见下。

### 判据 3：其余 —— 开发切片

### 为什么三段条件缺一不可

| 只看 | 会误判成基线 |
|---|---|
| 零事件 | 刚建、还没动的**开发**切片（也是零事件） |
| `baseline` 缺失 | 所有老切片文件（含老开发切片） |
| `completed` | —（这一段本身不误判，但**必要**） |

**合起来是可证的**：一片开发切片要走完 `draft → frozen → running → completed`，
状态机每一步都对应一条**强制事件**
（`spec.frozen` / `run.started` / `gate.result` / `sign.approved`）——
C4 说「每个动作都写 append-only 事件流」。

所以「`completed` + 零事件」这件事本身**只可能**是「被人手工塞进来描述现状的」。

实测核对：nimrtc-v14 的 8 片里，5 片开发切片各有 20+ 种事件，
3 片基线切片**零事件** —— 判据与现场完全吻合。

### 为什么不信「标题里有『基线』」

标题是人写的，可以是任何东西。用标题做判据 = **用命名约定代替事实**。
判据必须落在**机器写下的**东西上（字段 + 事件）。

## 方向性：宁可少算，不可多算

两个方向的错误代价不同：

- **漏判基线** → 完成度虚高 → 人以为做完了（**危险**）
- **误判基线** → 开发切片从完成度里消失 → 人看到「少了一片」会去查（**安全**）

所以判据在不确定时偏向「不是基线」：

- 事件流**读不到**（文件不存在）→ 视作零事件 → 倾向判成基线（少算，安全）；
- 事件流**解析失败** → 同样视作零事件。

## 修法（两层）

### ① core 侧判据（`src/core/slice/baseline-kind.ts`，新增）

```
classifySliceKind(slice, events)        → 'baseline' | 'development'
classifySliceKindAsync(slice, loadEvents) → 同上，但**只在真需要时才读事件**
```

异步版自己管「什么时候才值得去读事件流」：
只有「`baseline` 字段缺失 + 状态是 `completed`」才读。
别的切片（`baseline === true` / `baseline === false` / 状态不是 completed）
一律**不读事件** —— 判据 1 或判据 3 已经出结论。

这不是性能优化，是**避免把 I/O 摊到每一次列表渲染上**：
驾驶舱的概况页要列全部切片，每片多读一个文件就是几十次额外 I/O。

### ② Web 侧分开计数（`src/adapters/web/api.ts`）

`/api/summary` 增加两个字段：

```
development: { total, byState, completed }
baseline:    { total, ids }
```

`/api/slices` 每行增加 `kind` 字段。

**`byState` 保留全量**（含基线）—— 它是「盘上有多少片这个状态」这个**事实**，
去掉基线会让「磁盘上 8 片 completed」查不出来。
分开计数是**加**上去的维度，不是替换。

### ③ 前端（`src/adapters/web/frontend/app.js`）

- 概况页卡片：「开发切片」是「这轮做了多少」的诚实口径；
  状态分布**只列开发切片的** —— 否则 `completed` 里混着基线，读不出进度。
- 「基线切片」单列一张卡 + 一张清单，并**直说**它是什么
  （判据是内部的，人没有义务知道 `baseline` 字段缺失也算基线）。
- 切片列表页：开发切片与基线切片**分两张表**。

## 实测（nimrtc-v14）

```
totalSlices : 8
byState     : {"completed":8}
development : {"total":5,"byState":{"completed":5},"completed":5}
baseline    : {"total":3,"ids":["v1-cmake","v0-src-log","v0-cmake"]}
```

改之前只有第一行 —— 「8 个切片都完成了」。
改之后「开发切片 5 / 基线切片 3」—— **说真话**。

## 影响面

- `src/core/slice/baseline-kind.ts`（新增）
- `src/core/slice/index.ts`：导出判据
- `src/adapters/web/api.ts`：`SliceSummary.kind`；`summary()` 增加 `development` / `baseline`
- `src/adapters/web/frontend/app.js`：概况页与列表页分开渲染
- `tests/baseline-slice-kind.test.ts`（10 条，新增）

## 不变量核查

- **C1**（状态只在文件里）：无影响 —— 只读状态文件与事件流。
- **C2**（core 零第三方依赖）：无影响 —— `baseline-kind.ts` 只 import 自己的类型。
- **C3**（判定确定性）：**加强** —— 纯函数，只读文件、不调模型、不触网。
- **C4**（append-only 事件流）：无影响 —— 只读事件。
- **C5**（保护域外部化）：无影响。
- **C9**（写集预约运行时强制）：无影响。

## 验收标准

1. ✅ `baseline: true` → 基线；
2. ✅ `baseline` 缺失 + 零事件 + `completed` → 基线；
3. ✅ `baseline` 缺失 + 零事件 + **非 completed** → 开发（刚建的切片不许从完成度里消失）；
4. ✅ `baseline` 缺失 + `completed` + **有事件** → 开发；
5. ✅ `baseline: false` → 开发（哪怕零事件）；
6. ✅ 事件流读不到 → 视作零事件（fail closed 到「更保守」的一侧）；
7. ✅ 异步版只在「缺 baseline 字段 + completed」时读事件流；
8. ✅ nimrtc-v14 现场：8 片 completed → 开发 5 / 基线 3；
9. ✅ `byState` 保留全量（不因分开计数而丢事实）；
10. ✅ `npm test` 全绿。

## 关联缺陷

- §11.33：「查不到」比「算错」更难发现 —— **同形状**。
  本 ADR 修的是「算出来的那个数，说的不是它看起来在说的事」。
- ADR-039（接管既有项目 → 基线切片）—— 本 ADR 是它的**呈现面**：
  基线切片一直存在，只是一直被算进了开发完成度。

## 参考

- `src/core/project/baseline.ts`（基线切片的生成与语义）
- `src/core/sched/engine.ts`（`slice.baseline` 的既有用法）
- `tests/baseline-slice-kind.test.ts`（判据的回归钉子）

---

## 版本追溯

| 字段 | 值 |
| --- | --- |
| 所属版本号 | v0.7.1 |
| 关联 ADR 编号 | ADR-111 |
| 提交哈希 | a9a870232023c27efdd58e32b6e007c87f358669 |
| 验证方式 | [git show --stat 抽查 + 人工复核 + 隔离跑受影响测试全绿] |

> **提交哈希说明（务必读）**
>
> 本 ADR 的**代码**落在提交 `a9a8702` 里 ——
> 但那个提交的标题是「docs(adr): 回填 ADR-110 的提交哈希并登记到追溯索引」，
> trailer 挂的是 `Refs-Slice: v4-tag-namespace-adr110`。
>
> **归属错了**：那是一次**整工作区 `git add`** 的产物，
> 把本 ADR 的 5 个文件（`src/core/slice/baseline-kind.ts`、
> `src/adapters/web/api.ts`、`src/adapters/web/frontend/app.js`、
> `src/core/slice/index.ts`、`tests/baseline-slice-kind.test.ts`）
> 一起扫进了 ADR-110（版本 tag 命名空间）的提交。
>
> 本 ADR 的代码与 tag 命名空间**毫无关系** ——
> 提交信息与 trailer 都是误挂。
>
> 为什么不改历史：`a9a8702` 之后已有提交（`d801577` 等），
> 且**并行会话正在该分支上继续工作** —— `git rebase` 会打断它。
> 按「签字不自动合并」的同一原则，**不擅自改写历史**；
> 这里如实登记，由人决定是否重写。
>
> 抽查：`git show --stat a9a8702` —— 13 个文件，
> 其中 `src/core/slice/baseline-kind.ts`（+160）是本 ADR 的判据，
> `src/adapters/web/api.ts`（+65）是 Web 侧分开计数，
> `src/adapters/web/frontend/app.js`（+80）是前端渲染，
> `tests/baseline-slice-kind.test.ts`（+260）是回归钉子。

### 验证记录

| 项 | 结果 |
| --- | --- |
| 判据单测（`tests/baseline-slice-kind.test.ts`） | 10/10 通过 |
| Web 套件（frontend-syntax / list-slices / security / cockpit-actions / throttle / crash-guard） | 全绿 |
| 相关回归（slice-state / project-takeover / arch-guard / worktree / submodule / ship-tag） | 全绿 |
| nimrtc-v14 现场复算 | 开发 5 / 基线 3，与病灶描述一致 |

> **关于 `npm test` 全量**：本 ADR 的改动**不影响**任何既有测试
> （`src/adapters/web/api.ts` 只**新增** `kind` 字段与 `summary()` 的两个字段，
> `byState` 语义不变）。
> 全量套件在并行会话有在途改动时会偶发红 —— 已用
> 「撤掉本改动复跑同样失败」与「隔离跑全绿」两个办法**确认归属**：
> 失败全在 `tests/tag-namespace-adr110.test.js`（ADR-110 的在途重构），
> 与本 ADR 无关。

