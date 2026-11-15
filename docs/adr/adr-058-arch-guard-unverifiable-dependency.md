# ADR-058：架构守卫对不可扫描目标不再报硬性缺失依赖

**状态**: 已实施
**日期**: 2026-11-15
**作者**: 系统架构
**关联约束**: C3
**关联文档**: `src/core/arch/report.ts`（`missing_dependency` 判据）,
`src/core/arch/scan.ts`（`detectLang` 与代码文件统计）

---

## 1. 摘要

**在非 JS/TS / Python 的项目里，`zelto arch check` 会把大量第三方文件
误报成「设计声明了依赖，代码里没有对应的 import」的硬性偏离。**

C++ 项目里第三方库（googletest、msquic 等）带 Python 脚本、`.inc` 文件、
无扩展名脚本等，扫描器识别不了它们的语言，于是「目标模块的可读代码比例」
很低。旧判据只看「目标模块有没有代码」，不看「代码能不能被扫描」，
于是第三方模块被误判为缺依赖 —— 而这类偏离在 arch check 里是**硬性拒绝**。

## 2. 问题

### 2.1 触发路径

2026-11-15 的实战演练（对 `nimrtc-zelto` 跑完整切片生命周期）里踩到。

`zelto arch check` 输出：

```
❌ 架构偏离 377 项（硬性 2 项）
```

两项硬性偏离分别指向：

- `src/third_party` —— 第三方库目录
- 另一个未登记模块 —— `msquic` 相关

### 2.2 为什么是误报

`src/third_party` 里是 googletest / msquic 的源码。arch 扫描器
（`detectLang`）只识别 JS/TS 与 Python。这些 C++ 文件全部落入
「有代码但不可读」的状态。

设计侧 JSON（`prj-1792993843912.json`）里声明了 `src/third_party` 模块
和它对 `src/third_party` 的依赖关系。判据问的是：
「代码里有没有 `import` 这个模块？」—— 对 C++ 来说这个问法本身就没意义，
因为 C++ 没有 `import` 语句（至少 `rtp::` 那种集中化约束不是靠 import 表达）。

于是判据的结论变成「设计声明了依赖，代码里没有对应的 import」，
**但真相是：这个目标根本扫不了**。第三方目录尤其不该被这样要求 ——
第三方代码本来就不该被要求「import 自己的依赖」。

### 2.3 后果的严重性

这是**硬性偏离**，不是警告。意味着：

- 任何 C++ / Rust / Go / Java 项目的 `arch check` 基本跑不过
- 第三方目录一旦被登记进设计，就必然触发硬性拒绝
- 用户会误以为是设计写错了，去反复改设计 JSON 而不是修工具

## 3. 决策

### 3.1 可扫描性作为硬性偏离的前置条件

`missing_dependency` 只在「目标模块**可扫描**」时才成立。可扫描性用
「目标模块中能被扫描器识别为代码的文件比例」衡量：

```
可读文件数 / 总文件数 >= 0.5   →  可扫描
```

判据的实现（`src/core/arch/report.ts`）：

```ts
const totalFiles = (scan.moduleFiles.get(to) ?? []).length;
const readableFiles = (scan.moduleCodeFiles.get(to) ?? []).length;
const readableRatio = totalFiles > 0 ? readableFiles / totalFiles : 1;
const scannable = readableRatio >= 0.5;

deviations.push({
  kind: targetHasCode && scannable ? 'missing_dependency' : 'unverifiable_dependency',
  from,
  to,
  detail: targetHasCode && scannable
    ? '设计声明了依赖，代码里没有对应的 import'
    : '目标模块没有源文件（契约 / 规格一类），无法用 import 验证',
});
```

### 3.2 两类偏离的语义差别

| 类别 | 含义 | 严重性 |
|---|---|---|
| `missing_dependency` | 目标可扫描、扫描器能看出没有 import —— **真的没写** | 硬性 |
| `unverifiable_dependency` | 目标不可扫描（C++ / 第三方 / 契约规格）—— **看不出来** | 警告 |

判据从「有没有」变成「看不看得见」：**只有看得见的缺失才算缺失。**
这与 C3「判定必须确定性」不冲突 —— 判据仍是纯文件计算，没有引入模型或网络。

### 3.3 为什么不是「干脆不管不可扫描的目标」

若直接跳过，第三方目录的偏离就彻底隐形了。保留
`unverifiable_dependency` 这一档（警告级）能保证：

- 报告里仍然能看出「设计里提到了这个依赖，但本次验证不到」
- 不阻断流程，但留下痕迹

### 3.4 为什么阈值取 0.5 而不是别的数

0.5 是「半数以上文件可读」的粗判据，不追求精确。理由：

- 精确的「这个模块能不能被 import 验证」判定需要语言相关的 import 机制
  （C++ 的 `#include`、Go 的 `import`、Rust 的 `use`），超出当前扫描器能力
- 取 0.5 让「混合模块」（大部分是 C++、少量是 Python 脚本）仍被判为可扫描，
  保持对真实 JS/Python 项目的判据强度不降

## 4. 约束核对

| 约束 | 核对 |
|---|---|
| **C3** 判定确定性 | 判据只读扫描统计，比例阈值是纯计算；未调模型、未触网 |
| **C1** 状态只在文件里 | 未引入任何新状态载体 |

## 5. 影响

- C++ 等非 JS/TS/Python 项目的 `arch check` 不再因第三方目录被硬性拒绝
- 真正「该 import 没 import」的偏离仍然被硬性拒绝，判据强度不降
- 不可扫描的目标改为输出警告级 `unverifiable_dependency`

## 6. 遗留问题

- 扫描器的 `detectLang` 仍只覆盖 JS/TS 与 Python。C++ / Go / Rust 项目里
  「依赖是否真的被引用」的验证能力仍然缺失（只能验证「可见的 import 缺失」）。
  补齐这块需要引入语言相关的 import 机制，属于独立议题。
- `unverifiable_dependency` 在报告里的呈现方式（是否聚合、是否列出全部）
  还比较朴素，可以再打磨。
