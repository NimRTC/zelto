# ADR-061：C++ 项目上的架构报告 —— 「代码」与「扫描器读得懂」要分开

**状态**: 已实施（D-13 / D-14）
**日期**: 2026-11-15
**作者**: 系统架构
**关联约束**: C1, C3
**关联文档**: `src/core/arch/scan.ts`（归属与统计）,
`src/core/arch/report.ts`（偏离判定）,
`src/core/arch/types.ts`（数据契约）,
`src/cli/commands/architecture.ts`（报告渲染）
**前置**: ADR-058（不可扫描目标降级）、ADR-060 §4（语言覆盖面报告）

---

## 1. 摘要

ADR-060 §4 方案 A 让 `arch check` **说清**了「哪些文件验过、哪些没验过」。
把它装到真实项目（nimrtc-zelto，14439 个文件）上一跑，
立刻暴露出报告本身的三处失真 —— **数字是准的，标签和分母是错的**。

| 编号 | 现象 | 后果 |
|---|---|---|
| **D-13** | C++ 模块显示「14 个文件（**0 源码**）」 | 读起来像「这个模块没有代码」。它有 13 个 `.cpp`/`.hpp` |
| **D-14** | 可扫描率的分母把文档/配置也算进去 | 「文档多」被误判成「代码读不懂」，该拦的偏离被降级 |
| **D-15** | 不可验证的说明只有一句话 | 「没有源文件」把人引向「是不是漏写了」，而真相是「语言不支持」 |

三个问题都源于**同一个混淆**：**「代码」** 与 **「扫描器读得懂的代码」**
被当成了同一件事。

本文的核心结论：**这两件事必须用两个字段分别表达。**

---

## 2. D-13：「0 源码」是错的标签

### 2.1 现象

真实项目上跑 `arch check`：

```
  模块
    src/core       14 个文件（0 源码）         声明依赖: —  实际依赖: —
    src/engine     33 个文件（0 源码）         声明依赖: src/core, src/plugins
    src/modules   399 个文件（0 源码）         声明依赖: src/core, src/dtls, src/sctp
```

但 `src/core` 实际内容：

```
CMakeLists.txt  api_version.hpp  bytes.hpp  engine_errors.hpp  error.hpp
gpu_device_registry.hpp  log.hpp  nimrtc_export.h  plugin_id.hpp
registry.hpp  time.hpp  gpu_device_registry.cpp  pal_default_registrars.cpp
plugin_registry.cpp
```

**14 个文件里有 13 个是代码。** 说「0 源码」是错的。

### 2.2 根因：一个字段承担了两个语义

`ScanResult.moduleCodeFiles` 装的是「**扫描器读得懂**的文件」
（`detectLang(path) !== null`，即 TS/JS/Python）。

而报告把它渲染成「N 个文件（M **源码**）」。

`detectLang` 的语义是「**能不能参与 import 图**」，
不是「是不是源码」。字段名与用法在演进中错位了：
ADR-058 引入这个字段时是为了算「可扫描率」，
报告层却直接把它当成「源码数」渲染。

### 2.3 决策：拆成两个字段

```ts
export interface ScanResult {
  /** 模块名 → 该模块负责的全部文件 */
  moduleFiles: Map<string, string[]>;
  /**
   * 模块名 → 该模块负责的**代码文件**（不限语言）
   *
   * ADR-061：这里原先只放扫描器读得懂的文件，
   * 于是 C++ 模块在报告里显示「0 源码」—— 而它明明有几十个 `.cpp`。
   *
   * 「源码」和「扫描器读得懂的源码」是**两件事**，
   * 报告里要用两个字段分别表达。
   */
  moduleCodeFiles: Map<string, string[]>;
  /**
   * 模块名 → 该模块里**已验证**（扫描器读得懂、参与了 import 图）的文件
   *
   * `moduleCodeFiles.length - moduleVerifiedFiles.length`
   * 就是这个模块「有代码但没验过」的部分。
   */
  moduleVerifiedFiles: Map<string, string[]>;
}
```

**「代码文件」的判定**：用 `classifyLangCategory` + `isCodeLangCategory`
（`typescript` / `python` / `cpp` / `go` / `rust` / `java`）。

**「已验证文件」的判定**：`detectLang(path) !== null`，
即参与 import 图的那些。

### 2.4 报告的渲染

```ts
function formatModuleFiles(fileCount: number, codeFileCount: number, verifiedFileCount: number): string {
  if (fileCount === 0) return '0 个文件';
  if (codeFileCount === fileCount && verifiedFileCount === codeFileCount) {
    return `${fileCount} 个文件`;
  }
  if (codeFileCount === fileCount) {
    return `${fileCount} 个文件（${verifiedFileCount} 已验证）`;
  }
  if (verifiedFileCount === codeFileCount) {
    return `${fileCount} 个文件（${codeFileCount} 代码）`;
  }
  return `${fileCount} 个文件（${codeFileCount} 代码 / ${verifiedFileCount} 已验证）`;
}
```

三种情况的措辞分别对应：

| 情况 | 显示 | 例（真实项目） |
|---|---|---|
| 全是代码，都验得了 | `N 个文件` | `tools 53 个文件` |
| 全是代码，部分验不了 | `N 个文件（M 已验证）` | `src/core 14 个文件（0 已验证）` |
| 有代码有非代码，都验得了 | `N 个文件（M 代码）` | `scripts 38 个文件（10 代码）` |
| 有代码有非代码，部分验不了 | `N 个文件（M 代码 / K 已验证）` | `src/core 14 个文件（13 代码 / 0 已验证）` |

修复后真实项目的输出：

```
src/core        14 个文件（13 代码 / 0 已验证）
src/engine      33 个文件（32 代码 / 0 已验证）
src/modules    399 个文件（327 代码 / 0 已验证）
src/third_party 11943 个文件（4434 代码 / 377 已验证）
```

**「13 代码 / 0 已验证」** 一眼就能看出：
代码是有的，只是这个工具读不懂 C++。

---

## 3. D-14：可扫描率的分母

### 3.1 现状（ADR-058）

ADR-058 为了避免 C++ 项目上的假硬偏离，加了「可扫描率 ≥ 0.5」的判据：

```ts
const totalFiles = (scan.moduleFiles.get(to) ?? []).length;
const readableFiles = (scan.moduleCodeFiles.get(to) ?? []).length;
const readableRatio = totalFiles > 0 ? readableFiles / totalFiles : 1;
const scannable = readableRatio >= 0.5;
```

**分母 `totalFiles` 是全部文件** —— 含文档、配置、构建脚本、证书。

### 3.2 问题

一个模块里 80% 的文件是 `README.md` / `CMakeLists.txt` / `*.pem` 时，
那个比例反映的是「**文档多**」，不是「**代码读不懂**」。

用它判断会把「代码读得懂」误判成「读不懂」，
于是**本该拦的 `missing_dependency` 被降级成软偏离** ——
护栏在最该拦的时候放行了。

**方向是反的**：文档多不该让代码的可读比例变低。

### 3.3 决策：分母改成代码文件数

```ts
const codeFiles = (scan.moduleCodeFiles.get(to) ?? []).length;
const verifiedFiles = (scan.moduleVerifiedFiles.get(to) ?? []).length;
// 没有代码文件 → 不是「读不懂」，是「没有代码可读」→ 不可验证
const readableRatio = codeFiles > 0 ? verifiedFiles / codeFiles : 0;
const scannable = readableRatio >= 0.5;
```

**注意 `codeFiles > 0 ? ... : 0` 里的 `0`**：
原来的 fallback 是 `1`（没有文件 → 视为可扫描 → 报硬偏离）。
改成 `0` —— 没有代码文件时，正确结论是「无法验证」而不是「可扫描」。

这一改动让判据的两个分支都对得上：

| 目标模块 | 代码文件 | 已验证 | 比例 | 结论 |
|---|---|---|---|---|
| 纯 TS 模块 | 20 | 20 | 1.0 | ✅ 可扫描 → 该拦就拦 |
| 文档多的 TS 模块 | 5 | 5 | 1.0 | ✅ 可扫描（修复前可能是 0.1 → 错） |
| 纯 C++ 模块 | 30 | 0 | 0 | ⚠️ 不可验证 → 软偏离 |
| 只有契约的模块 | 0 | 0 | — | ⚠️ 不可验证 → 软偏离 |

---

## 4. D-15：不可验证的说明要区分原因

### 4.1 现状

```ts
detail: targetHasCode && scannable
  ? '设计声明了依赖，代码里没有对应的 import'
  : '目标模块没有源文件（契约 / 规格一类），无法用 import 验证',
```

两种情况共用一句话。而触发这条的原因其实有**三种**，
排查方向**完全不同**：

| 原因 | 真实情况 | 人该做什么 |
|---|---|---|
| 1 | 目标模块**根本没有代码**（契约/规格） | 没什么可查的，正常 |
| 2 | 目标模块**有代码，但扫描器读不懂** | 补语言支持，或接受盲区 |
| 3 | 目标模块**有代码，也读得懂**，但比例 < 0.5 | 查依赖是否真的漏了 |

看到「没有源文件」会去找「是不是漏写了」——
而真相是「**这个工具不支持 C++**」。**指错方向比不给信息更糟。**

### 4.2 决策：三种原因三种说法

```ts
function describeUnverifiable(
  targetHasCode: boolean,
  scannable: boolean,
  codeFiles: number,
  verifiedFiles: number,
): string {
  if (targetHasCode && scannable) {
    return '设计声明了依赖，代码里没有对应的 import';
  }
  if (!targetHasCode) {
    return '目标模块没有代码文件（契约 / 规格一类），无法用 import 验证';
  }
  if (verifiedFiles === 0) {
    return `目标模块有 ${codeFiles} 个代码文件，但扫描器读不懂它们（暂只支持 TypeScript / JavaScript 与 Python），无法用 import 验证`;
  }
  return `目标模块的 ${codeFiles} 个代码文件里只有 ${verifiedFiles} 个是扫描器读得懂的，未达到 0.5 的可读比例，无法用 import 验证`;
}
```

真实项目上的效果：

```
● 依赖无法验证   examples → src/core
  目标模块有 13 个代码文件，但扫描器读不懂它们
  （暂只支持 TypeScript / JavaScript 与 Python），无法用 import 验证
```

---

## 5. 约束核对

| 约束 | 核对 |
|---|---|
| **C1** 状态只在文件里 | 未引入新状态；统计只从扫描结果算 |
| **C3** 判定确定性 | 判据只读文件字节与模块归属，无模型、无网络 |
| **C2** core/ 零依赖 | 只用 Node 内置 |

---

## 6. 影响

### 6.1 数据契约

- `ScanResult` 新增 `moduleVerifiedFiles`
- `ScanResult.moduleCodeFiles` 的**语义变了**：从「扫描器读得懂的文件」
  变成「**所有**代码文件（不限语言）」
- `ArchitectureReport.modules[]` 新增 `verifiedFileCount`
- `ArchitectureReport.modules[].codeFileCount` 的**语义变了**（同上）

**这两个语义变更影响 `arch check --json` 的输出** ——
`codeFileCount` 的数字会变大（现在包含 C++ 等语言）。

**调用方怎么办**：如果有外部脚本依赖 `codeFileCount` 的旧语义，
需要改用 `verifiedFileCount`。这是**事实上的接口变更**，明确记下。

### 6.2 判定

- 可扫描率的分母从「全部文件」改成「代码文件」
- 无代码文件时的 fallback 从 `1`（视为可扫描）改成 `0`（不可验证）
- 不可验证的说明分成三种原因

### 6.3 渲染

- 模块概况从「N 个文件（M 源码）」改成三档措辞
- 不再出现「0 源码」这种误导性标签

### 6.4 回归测试

- `tests/arch-cpp-project.test.ts` —— 5 条用例

---

## 7. 遗留

- **C++ / Go / Rust 的依赖解析**（ADR-060 §4 方案 B / C）待单独 ADR
- `src/third_party` 在真实项目里占 11943 个文件（占全项目 82%）。
  它在设计里是个**正当模块**（`src/dtls` / `src/sctp` 声明依赖它），
  但它让整张图的统计失去意义 ——
  将来可能需要「第三方模块」的单独处理（不参与偏离判定，只做归属）。
  本轮**不做** —— 那要先确认「第三方代码算不算架构问题」这个问题本身
- ADR-060 §4.5 的「模块归属要先在设计里说清楚」是**实践问题**，
  需要文档跟进

---

## 8. 给后续的教训

### 8.1 一个字段只能有一个语义

`moduleCodeFiles` 先后承担了两个含义：
「扫描器读得懂的源文件」（ADR-058 引入时）
与「模块的源码数」（报告层渲染时）。

字段名跟不上语义，报告就只能说错话。

**规则**：当一个字段的含义要变时，**改名或加新字段**，
不要让调用方去猜现在是哪个意思。

### 8.2 报告的每个数字都要能回答「这数的是什么」

「0 源码」这个标签之所以错，是因为它回答不了「0 指的是什么」——
到底是「这个模块没有代码」，还是「扫描器读不懂」？

**修复后的「13 代码 / 0 已验证」** 就没有这个问题：
两个数字，两个明确的问题。

### 8.3 错误信息要指向**该做的事**

「目标模块没有源文件」指向「去查是不是漏写了」；
「扫描器读不懂它们（暂只支持 TypeScript / JavaScript 与 Python）」
指向「这是工具的边界」。

后者还顺带告诉人**边界在哪** ——
人知道边界在哪，才知道这个结论能信几分。
