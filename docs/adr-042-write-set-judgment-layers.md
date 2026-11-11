# ADR-042: 写集判定分层 —— 「新建文件」不是写集问题

**状态**: 已实施
**日期**: 2026-11-11
**作者**: 系统架构
**关联约束**: C1, C3, C5, C8, C9
**关联文档**: `docs/adr-032-trace-judgment-enforcement.md`,
`docs/adr-041-config-blocks-and-slice-ledger.md`,
`src/core/spec/write-set.ts`, `src/cli/commands/core-slice.ts`

---

## 1. 摘要

门禁①原来把「写集里的路径在仓库里不存在」列为**阻断项**。
这条规则对「修改已有文件」的切片成立，对**新建文件**的切片则是死结。

真实案例：nimrtc-zelto 的 `v1-exception-handling` 要新建
`safety_check.hpp` / `safety_check.cpp` / `test_safety_check.cpp`，
这三个文件在 agent 动手之前本来就不存在 —— 于是门禁①连报七次
「Write-set paths not found」，切片卡在 `draft` 一步都走不出去。

根因不是「检查写错了」，而是**把两件事混成了一件事**：

| 判定 | 语义 | 该不该阻断 |
|---|---|---|
| 写集写进保护域 / 逃出项目根 | 写集**本身**有问题 | **阻断** —— 跑之前就注定跑不起来 |
| 写集路径尚不存在 | 那是 agent 要**新建**的文件 | **提示** —— 这正是 agent 该干的事 |

本次定案：写集判定分层，判据收敛到 `core/spec/write-set.ts` 一处。

### 1.1 契约变更

**无**。事件类型集合、`slice.json` schema、`policy.yaml` 都没变。
`spec.checked` 事件的 `details` 内容变了（少了误报、多了别的），
但事件类型与字段结构不变。

---

## 2. 问题

### 2.1 现象

```console
$ zelto check v1-exception-handling
zelto check v1-exception-handling — running gate① checks...
  Slice:   基础数据校验功能
  State:   draft
  Issues:  No requirements traced, Write-set paths not found:
           src/modules/net_feedback/include/nimrtc/net_feedback/safety_check.hpp,
           src/modules/net_feedback/src/safety_check.cpp
  Result:  ❌ Fix issues before freezing
```

同一条报错在事件流里出现了七次（`spec.checked` 事件）——
每一次 `zelto check` 报一遍，人改不掉，agent 也改不掉。

### 2.2 为什么这是死结

新建文件型切片的流程是：

```
规格写好 → 冻结 → agent 新建文件 → 门禁②编译 → 签字 → 合并
```

门禁①卡在第二步之前。也就是说：**这片永远走不到 agent**，
而 agent 才是那个会创建这些文件的东西。

反过来，如果有人为了绕过这个报错，去建一堆空占位文件，
那也是错的 —— 那是**人替 agent 干了活**，写集就失去了
「声明这片该产出什么」的意义。

### 2.3 为什么以前没被发现

上一个切片 `v1-net-feedback-core` 也有同样的问题
（它的 `aggregator.hpp` 当时也是新建的），但那次人**手工**把文件建好
才推进流程，误报被绕过去了 —— 绕过去的方式正好掩盖了 bug。

ADR-040 与 ADR-041 修的都不是这一层（策略迁移、配置解析与记账），
所以这层一直裸露着。**一个被手工操作掩盖的缺陷，要等流程第一次
从头跑通时才会显形。**

---

## 3. 决策

### 3.1 写集判定分层

新增 `src/core/spec/write-set.ts`，把写集判定收敛到一处，
返回三个互不重叠的集合：

```typescript
interface WriteSetCheckResult {
  existing: string[];   // 已存在（agent 要改的已有文件）
  toCreate: string[];   // 尚不存在（agent 要新建的文件）
  globs: string[];      // glob 写集（一片路径，无法逐个核实）
  issues: string[];     // 阻断项：写集本身有问题
  advisories: string[]; // 提示项：路径还不存在
}
```

判定规则：

1. **保护域**（`policy/**`、`.zelto/**`、`AGENTS.md`、`.cursor/rules/**`）
   → 阻断。保护域是硬约束（C5 / C8），写集要写进去 = hook 必然逐条 deny，
   在 agent 还没跑时就该拦下来。
2. **路径逃逸**（写出项目根）→ 阻断。同 `core/policy/engine.ts` 第 2 步的语义。
3. **glob 写集** → 归入 `globs`，不逐个核实。若 glob 命中不到任何已有文件，
   给一条提示（「这一片还没建」），但**不阻断**。
4. **具体路径已存在** → 归入 `existing`，不提示也不阻断。
5. **具体路径尚不存在** → 归入 `toCreate`，给一条提示，**不阻断**。

### 3.2 门禁①的接线

`zelto check`：

- `issues` → 计入退出码（阻断）；
- `advisories` → 只打印（提示）；
- 另外打印一行 `New files: N path(s) will be created by the agent`，
  让「本片会新建哪些文件」在门禁①的输出里一眼可见。

### 3.3 门禁①与门禁②各管一段

沿用 ADR-032 §3.5 的分工：

- 门禁①管「追溯到没追溯」与「规格写没写清楚」；
- 门禁②管「这片东西编不编得过、测不测得过」。

写集路径存不存在，是**运行期**的事实。门禁①在 agent 跑之前问这个问题，
问出来的答案必然是「不存在」（对新建文件型切片而言），所以它**不该问**。

但「写集本身有没有问题」（保护域、逃逸）是**运行前**就能确定、
且一定会出事的 —— 门禁①问这个问题是对的，答案也永远有意义。

### 3.4 跑完之后：写集该产出的文件产出了没有

同一个模块提供 `findUnproducedWriteSetPaths(writes, changedPaths)`：
给定 agent 实际改动过的路径，算出写集里**一个都没动**的文件。

这不是门禁①的判据（跑之前这些文件本来就不存在），
而是给「agent 说做完了，但它什么都没干」这种情形用的。

---

## 4. 被否决的方案

**方案一：把「路径不存在」整体降级为提示。**

否决理由：会连带放过「写集写进 `policy/`」这种真正跑不起来的情况。
分层比一刀切准确 —— 前者是「agent 该干的活」，后者是「人配错了」。

**方案二：门禁①改成「路径存在 OR 在写集预约里」。**

否决理由：写集预约（`.zelto/locks/`）是**运行期**凭据，
门禁①跑的时候还没预约。而且这会把两个不同阶段的凭据混在一起。

**方案三：让 agent 先跑一遍再检查写集。**

否决理由：违反不变量 C7 —— agent 只在冻结后、追溯合格时才允许跑。
用「先跑后查」绕过门禁①，等于取消门禁①。

**方案四：在 `zelto create` 时把写集里的路径全部建出来（空占位）。**

否决理由：那是**人替 agent 干了活**，写集就失去了「声明产出」的语义，
而且空占位文件会被当成「已存在」，门禁②会拿它当真的源码去编。

---

## 5. 影响与迁移

**破坏性变更**：

1. **`zelto check` 的退出码语义变了**：写集路径不存在不再计入退出码。
   依赖「check 报写集缺失就返回 1」的脚本需要改。
   —— 但这样的脚本本来就在依赖一个 bug。

2. **写集写进保护域 / 逃出项目根现在会被拦**。
   以前这类写集能过门禁①，但跑起来时 hook 会逐条 deny。
   —— 现在拦得更早，是修正不是回归。

**没有改的东西**：事件类型集合、`slice.json` schema、`policy.yaml`、
`contracts/schemas/` 都没变。

**新增文件**：

| 文件 | 作用 |
|---|---|
| `src/core/spec/write-set.ts` | 写集判定的唯一实现 |
| `tests/core/spec/write-set.test.ts` | 21 个用例 |

---

## 6. 验证方式

- 单元测试 `tests/core/spec/write-set.test.ts`：
  - 新建文件型写集 → 不进 `issues`，进 `toCreate`，产生一条提示；
  - 已存在路径 → 进 `existing`，无提示；
  - 混合写集 → 两路分流各自正确；
  - 保护域（`policy/`、`.zelto/`、`AGENTS.md`、glob 形式）→ 阻断；
  - 路径逃逸（相对与绝对）→ 阻断；
  - glob 写集 → 归入 `globs`，命中不到文件时给提示；
  - `findUnproducedWriteSetPaths` 的四种情形。
- 全量测试 `node --test dist-test/tests` 全绿（1531 个用例）。
- 真实项目验证：nimrtc-zelto 的 `v1-exception-handling`
  —— 门禁①从「七次报 Write-set paths not found」变成
  「✅ All checks passed」，并打印
  `New files: 3 path(s) will be created by the agent`。

---

## 7. 附带发现（本次不改，记录在此）

`core/spec/write-set.ts` 与 `core/sched/paths.ts` 各自有一套 glob 语义，
与 `core/policy/engine.ts` 的 `matchPath` 是**第三份**实现。

本次把 `write-set.ts` 里的 glob 正则收敛成了单一辅助函数
（`globToRegExp`），语义与 `matchPath` 一致，但仍是两份代码。
彻底合并要动 `core/sched/paths.ts` 与 `core/policy/engine.ts` 的边界，
属于独立的一次整理，留待后续。
