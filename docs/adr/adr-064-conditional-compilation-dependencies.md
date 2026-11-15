# ADR-064：条件编译（`#ifdef`）的依赖边

**状态**: 已实施
**日期**: 2026-11-15
**作者**: 系统架构
**关联约束**: C3, C4
**关联文档**: `src/core/arch/imports.ts`（条件识别与标记）,
`src/core/arch/scan.ts`（边聚合）,
`src/core/arch/report.ts`（软偏离）
**前置**: ADR-062（C/C++ include 解析）

---

## 1. 摘要

ADR-062 让 C/C++ 的 `#include` 参与依赖图。但它**无条件**解析所有 include ——
包括落在 `#ifdef` 块里的。

本 ADR 处理这个问题：**条件编译的依赖仍是依赖，但要标记出来**。

**实测数据**（nimrtc-zelto，项目代码 491 个 C/C++ 文件）：

| 类别 | 数量 | 占 include 总数 |
|---|---|---|
| 条件编译块外 | 3090 | 82.0% |
| **include 守卫内** | 431 | 11.4% |
| **真条件编译内** | 249 | 6.6% |

真条件编译里的 249 条 include 中，**219 条指向系统头 / 第三方 SDK**
（本来就是外部依赖，没有假边问题），
**只有 30 条（0.8%）指向项目内部代码**。

---

## 2. 问题

### 2.1 「假边」到底存不存在？

ADR-062 §9 留了个尾巴：

> 条件编译（`#ifdef`）可能产生「假边」—— 只在某个分支里存在的依赖，
> 被算成了始终存在的依赖。

但**这是真的吗**？先测。

### 2.2 include 守卫占了将近一半

第一轮调研（`scripts/research-conditional-compile.cjs`）：

```
项目代码 C/C++ 文件数: 491
include 总数: 3770
  条件编译块外: 3090 (82.0%)
  条件编译块内:  680 (18.0%)

=== 条件编译块内的 include —— 按条件分组 ===
   102 次  _WIN32
    32 次  defined(_WIN32)
    28 次  NIMRTC_ENGINE_ENGINE_HPP        ← 这个不是条件编译！
    21 次  defined(NIMRTC_PLUGINS_AMF_ON) && defined(_WIN32)
    21 次  NIMRTC_PLUGINS_REGISTRY_HPP     ← 这个也不是！
```

`NIMRTC_ENGINE_ENGINE_HPP` 是什么？看文件：

```cpp
#ifndef NIMRTC_ENGINE_ENGINE_HPP
#define NIMRTC_ENGINE_ENGINE_HPP
   ...
```

**include 守卫**。它**永远为真**（下一行就把宏定义了）——
里面的 include 一直生效，根本不是条件依赖。

**不区分守卫和真条件，标记就全是噪音**：431 条守卫内的 include
会全部被标成「条件依赖」，而它们一条都不是。

### 2.3 区分之后

判据（确定性，可判定）：

- `#ifndef X` **紧跟** `#define X` → **include 守卫**（永远为真）
- `#ifdef X` / `#ifndef X` 单独出现 → **真条件编译**
- `#if <表达式>` → 真条件编译

分开统计：

```
include 总数: 3770
  条件编译块外:   3090 (82.0%)
  include 守卫内:  431 (11.4%)  ← 永远为真，不是条件性的
  真条件编译内:   249 (6.6%)   ← 边可能不存在
```

### 2.4 真条件里的 include，指向哪？

| 条件 | 次数 | 指向 |
|---|---|---|
| `_WIN32` / `defined(_WIN32)` | 134 | `windows.h`、`ws2tcpip.h` —— 系统头 |
| `NIMRTC_PLUGINS_AMF_ON && _WIN32` | 21 | `AMF/core/*.h` —— 第三方 SDK |
| `NIMRTC_PLUGINS_VAAPI_ON && __linux__` | 18 | vaapi —— 第三方 SDK |
| `NIMRTC_PLUGINS_{DXVA,QSV,NVDEC,NVENC}_ON` | 52 | 项目内部头文件 |
| `NIMRTC_HAS_VIDEO_STATS` | 1 | `nimrtc/video_stats/video_stats.hpp` —— 项目内部 |

**219 条指向外部**（本来就是外部依赖，不进模块图，没有假边问题）
**30 条指向项目内部** —— 这才是真正要处理的。

---

## 3. 决策

### 3.1 条件边**仍然是依赖** —— 不隐藏

**条件编译不是「这段代码不存在」，而是「这段代码在某些构建配置下存在」。**

开启那个特性时，这条依赖就在 —— 设计该声明就得声明。
所以：

- **不隐藏**条件边
- **不报**「未声明依赖」
- 只**标记** + 在报告里给一句提示（软偏离 `conditional_dependency`）

**为什么不隐藏**：隐藏了等于说「这条依赖不算」。
那么开启特性后代码里明明有依赖，设计里却没写 —— 架构检查就漏了
一个**真实的**问题。把假边藏起来，代价是真边被放过。

**为什么不报违规**：条件依赖**不违反任何设计约束**。
设计说「A 依赖 B」，A 在某个配置下确实依赖 B —— 这是**一致**的，
不是偏离。

### 3.2 区分「纯条件边」与「混合边」

一条边可能有多个来源：

```
src/modules → src/core
  无条件来源 253 处 + 条件来源 6 处
```

这是**混合边** —— 依赖本身一直存在，但有一部分来源只在特定配置下生效。

**纯条件边**是整条边都来自条件编译 —— 换构建配置它会消失。

两者要分开说：

| 情况 | 文案 |
|---|---|
| 纯条件 | 「这条依赖**只在条件编译下存在**（…）—— 关闭对应特性时这条边不存在」 |
| 混合 | 「这条依赖有**条件成分**（…）—— 依赖本身一直存在，但有 N 处来源只在特定构建配置下生效」 |

### 3.3 include 守卫**不是条件**

见 §2.2。判据是「`#ifndef X` 紧跟 `#define X`」。

**为什么这个区分重要**：不区分的话，11.4% 的 include 会被误标成条件依赖，
标记就失去意义了 —— 报告里全是噪音，人就不看了。

### 3.4 条件边的报告形态：**软偏离**

加进 `SOFT_DEVIATIONS` —— 不影响 `ok` 结论。

**理由**：它不是「代码违反了架构」，只是「让人知道真相」。
硬拦会挡住正常推进。

---

## 4. 实现

### 4.1 条件块识别

`findCppConditionalBlocks(source)`（`src/core/arch/imports.ts`）：

- 逐行扫，栈式匹配 `#if` / `#ifdef` / `#ifndef` ↔ `#endif`
- `#ifndef X` 且下一行是 `#define X` → `isGuard: true`
- 返回每个块的行范围 + 条件表达式 + 是否守卫

### 4.2 include 标记

`parseCppIncludes` 先算出所有条件块，再逐条 include 比对行号：

```ts
const active = blocks.filter(
  (b) => !b.isGuard && b.startLine < line && line < b.endLine,
);
```

守卫被过滤掉（`!b.isGuard`），只剩真条件。

### 4.3 边聚合

`scan.ts` 记两个计数：

```ts
edge.conditionalSources    // 条件来源数
edge.unconditionalSources  // 无条件来源数
```

然后：

```ts
if (hasConditional && !hasUnconditional) edge.conditionalOnly = true;
```

**为什么要两个计数**：一条边可能同时有两类来源。
只看「有没有条件来源」会把混合边误判成纯条件边。

---

## 5. 真实项目验证

### 5.1 结果：0 条纯条件边，5 条混合边

```
边总数: 49
纯条件边: 0
混合边: 5
```

五条混合边：

| 边 | 无条件 / 条件 | 条件 |
|---|---|---|
| `src/engine → src/modules` | 18 / 1 | `NIMRTC_HAS_VIDEO_STATS` |
| `src/modules → src/core` | 253 / 6 | AMF / DXVA / QSV / VAAPI / NVDEC / NVENC |
| `src/modules → src/plugins` | 88 / 6 | 同上 |
| `tests → src/core` | 70 / 3 | `_WIN32` |
| `tests → src/modules` | 45 / 2 | `_WIN32` |

### 5.2 结论：**依赖环不是条件编译造成的**

演练时报了两个环：

```
src/engine → src/dtls → src/plugins → src/modules
src/plugins → src/modules
```

**这是真的环** —— `src/modules/* → src/plugins` 有 88 处无条件来源
（h264 → plugins：10 无条件 + 4 条件；ice → plugins：11 处无条件……）。

**不是**「条件编译造成的假环」。这条结论很重要 ——
否则会误以为是工具的问题，去改工具。

### 5.3 报告输出

```
● 条件依赖     src/modules → src/core
  这条依赖有**条件成分**（defined(NIMRTC_PLUGINS_AMF_ON) && defined(_WIN32)、…）——
  依赖本身一直存在，但有 6 处来源只在特定构建配置下生效
```

**这个提示有实际价值**：它把「特性开关」在依赖图上的痕迹显出来了。
读者能看出 `src/modules` 对 `src/core` 的依赖有一部分是
「Windows 平台的 AMF/DXVA 编码器后端带来的」。

---

## 6. 测试

`tests/arch-conditional-dep.test.ts`（13 条）：

**解析层**
- 真条件里的 include 被标记
- **include 守卫里的 include 不被标记**
- 块外的不被标记
- `#if` 的条件表达式原样保留
- `#ifdef` 的条件是宏名本身
- 守卫套在真条件里 → 仍是条件依赖

**条件块识别**
- 区分守卫与真条件
- `#ifndef X` 后面不是 `#define X` → 不是守卫

**端到端**
- 混合边 `conditionalOnly === false`，且记下条件
- 报告出现「条件依赖」软偏离
- 软偏离**不影响** `ok` 结论
- 纯条件边 `conditionalOnly === true`
- 纯条件边的文案说清「关闭特性时这条边不存在」

---

## 7. 约束核对

| 约束 | 核对 |
|---|---|
| **C3** 判定确定性 | 条件识别是纯行扫描 + 正则，无模型、无网络 |
| **C4** append-only 事件 | `arch check` 是只读报告，不写事件（与既有行为一致） |
| **C2** core/ 零依赖 | 只用 `node:fs` / `node:path` |

---

## 8. 遗留

- **只处理了 C/C++** —— Go 的 `//go:build`、Rust 的 `#[cfg]`、
  Python 的 `if TYPE_CHECKING:` 都有同样的问题。
  那些语言的扫描器还没实现（ADR-060 §4），等实现了要补。
- **不追条件的传递性** —— 「A 依赖 B（B 只在 X 配置下）」这种
  跨配置的依赖链没建模。当前够用：报告让人看到条件，人自己判断。
- **条件表达式没做语义分析** —— `#if defined(A) || defined(B)` 与
  `#if defined(A) && defined(B)` 都原样保留，不做化简。
  真要化简得引入求值器 —— 那是**另一个量级**的复杂度。
