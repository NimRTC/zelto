# ADR-073：无模块归属的测试文件不报「文件无归属」；合并后同步版本计划状态

**状态**: 已实施
**日期**: 2026-11-17
**作者**: 系统架构
**关联约束**: C3, C4
**关联文档**: `src/core/arch/scan.ts`, `src/cli/commands/merge-executor.ts`,
`src/core/events/stream.ts`, `src/core/audit/trail.ts`
**关联 ADR**: ADR-066（测试文件不是架构耦合）、ADR-056（版本分支）、ADR-027（架构护栏）

---

## 1. 摘要

第六轮端到端复验（nimrtc-zelto 靶子项目，M1 两个切片）暴露两个会让**整条流水线卡死**的缺陷：

1. **每个切片都被自己的验收骨架拦住门禁**。
   `zelto version start` 为每个切片生成 `tests/acceptance/<id>/acceptance.test.cjs`，
   它不存在于任何设计模块的文件范围里，于是被架构护栏判成
   `unmapped_file`（默认 deny）→ `zelto gate` 直接 blocked。
   **修这个触发的切片自己也过不去**（自锁）。

2. **版本状态永远不会前进**。切片签字合并进 `version/v1` 之后，
   版本计划里的 `v1` 仍然是 `in_progress`，于是 `zelto version start v2`
   被 `dependsOn` 门永远挡住 —— 人反复重跑、重跑、再重跑，找不到"还要做什么"。

**决策**：

- **A**：扫描器把无模块归属的**测试文件**从 `unmapped` 中剔除（与 ADR-066 同一判据）。
- **B**：合并完成后，若某版本的**全部切片**已合入该版本的分支，
  合并器把版本计划状态推进到 `integrated`，并写 `version.integrated` 事件。

---

## 2. 背景

### 2.1 缺陷 A：测试骨架自锁门禁

ADR-066 已经确立了判据：**测试文件引用被测对象是测试的本职，不构成架构耦合**。
它落实了两处：测试文件不产生依赖边、只含测试的模块不报「缺失依赖」。

但「文件无归属」（`unmapped_file`）这条路没跟上同一判据：

```text
tests/acceptance/v1-video-processing/acceptance.test.cjs
→ 文件 "tests/acceptance/v1-video-processing/acceptance.test.cjs" 不在任何模块的负责范围里
→ action: deny → 架构护栏拦截 → zelto gate 退出 1
```

实测证据（nimrtc-zelto，第六轮）：

```console
$ zelto gate v1-video-processing
  Arch: ❌ 架构护栏拦截：缺失依赖×2（deny）、文件无归属×1（deny）
```

agent 的产物改动完全正确、`build` 与 1998 个 `ctest` 用例全绿，
**唯一被拦下的原因是 zelto 自己生成的验收骨架**。

### 2.2 缺陷 B：版本状态无人推进

`zelto merge` 把切片合进了 `version/v1`（`merge.completed` 事件写得很完整），
但**没有一处代码**在合并后改写版本计划文件，于是：

```console
$ zelto versions
  🔄 v1: in_progress — [v1-game-source, v1-video-processing]   ← 实际都合完了
  ⏳ v2: planned
  Next: v2 (waiting for: v1)

$ zelto version start v2
{ "error": "Dependency v1 is not yet integrated (status: in_progress)." }
```

`integrated` 这个状态在类型里存在、在 `version start` 的门里有判据，
**但没有任何代码路径会写它** —— 是一个死状态。

---

## 3. 决策

### 3.1 A：`unmapped` 排除测试文件

`scanArchitecture` 计算 `unmapped` 时，用 `isTestFile`（ADR-066 的同一函数）过滤：

```ts
const unmapped = scanned
  .filter((f) => f.module === null && !f.isTest)
  .map((f) => f.path);
```

- 测试文件**仍计入**文件总数与覆盖统计（它们是事实）。
- **生产文件**的无归属继续报 —— 不吞掉人真该修的东西。

单测：`tests/arch-test-deps.test.ts` 的
「报告：无归属的测试文件不报『文件无归属』偏离」同时断言两个方向。

### 3.2 B：合并后同步版本计划

在 `merge-executor` 的 `merge.completed` 事件之后：

1. 对**本轮刚合的每个切片**解析归属（`resolveSliceOwnership`）。
   归属解析不出来（不在任何计划 / 归属歧义）→ **不写任何东西**，不替人做决定。
2. 找到归属计划里**状态为 `in_progress` 且版本分支等于本次合并目标**的版本。
3. 用**事实**判断是否全部合入：版本内每个切片的分支
   （存在时）都已 `merge-base --is-ancestor` 于目标 ref。
4. 全部成立 → `VersionStore.updateVersionStatus(plan, version, 'integrated')`，
   并写 `version.integrated` 事件（C4）。

不处理：`planned`（还没开工）、`delivered`（已交付）、已是 `integrated` 的。

### 3.3 契约变更

- 事件类型新增 `version.integrated`（`core/events/stream.ts`），
  摘要翻译在 `core/audit/trail.ts`。
- 事件归属键：`version-<label>`（与 `version.adopted` 一致）。

---

## 4. 不变量自查

| 约束 | 满足方式 |
|---|---|
| C1 | 版本状态只写进 `.zelto/versions/<plan>.json`，无内存状态 |
| C3 | 两条判据都是纯计算：`isTestFile` 是命名约定；`is-ancestor` 是 git 退出码。不调模型、不触网 |
| C4 | 新增事件类型仍然 append-only；`version.integrated` 不改写历史 |
| C6 | `scan.ts` 在 `core/arch/`，只 import `core/` 内文件；合并器在 `cli/` |

## 5. 兼容性

- A 只影响「无归属的测试文件」这一类偏离；老项目的生产代码判据不变。
- B 只在「本轮合并的切片确实属于某计划」时触发；手工合主干的老工作流
  （切片不在任何计划里）完全不受影响。
