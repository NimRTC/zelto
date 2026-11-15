# ADR-065：vendor 目录是架构的外部边界

**状态**: 已实施
**日期**: 2026-11-15
**作者**: 系统架构
**关联约束**: C3, C4
**关联文档**: `src/core/arch/scan.ts`（识别与排除）,
`src/core/arch/report.ts`（偏离判定）,
`src/cli/commands/architecture.ts`（展示）
**前置**: ADR-062（C/C++ include 解析）、ADR-064（条件编译）

---

## 1. 摘要

真实项目里 `src/third_party` 有 **11943 个文件 / 4434 个代码文件** ——
占全项目代码文件的 **97%**。

它把架构报告淹没了。本 ADR 把 vendor 代码确立为**外部边界**：
不参与依赖图，但**计入覆盖率**并单独报出来。

---

## 2. 问题

### 2.1 三个具体后果

**实测**（nimrtc-zelto，ADR-064 实施后的报告）：

```
src/third_party              11943 个文件（4434 代码 / 4355 已验证）
src/core                         14 个文件（13 代码）
```

#### 后果一：淹没真正的信号

报告里的 5 条「未声明依赖」**全部**指向 `src/third_party`：

```
● 未声明依赖    src/modules → src/third_party
● 未声明依赖    src/plugins → src/third_party
● 未声明依赖    src/raw_udp → src/third_party
● 未声明依赖    src/sctp → src/third_party
● 未声明依赖    src/transport → src/third_party
● 未声明依赖    src/web_transport → src/third_party
● 未声明依赖    tests → src/third_party
```

**7 条噪音，0 条信息**。「这个模块用了第三方库」不是架构问题。

而且它们**挤掉了真正要看的** —— 比如 `src/modules → src/plugins`
（那个真的成环）、`src/engine → src/dtls`。

#### 后果二：统计失真

```
✔ C / C++                   4481 个文件 （依赖已验证）
```

读起来像「这个项目的 C++ 代码验过了」。**实际上项目自己的 C++ 只有 496 个**，
97% 是 vendor。

同样地，`Python 447 个文件` —— 其中 374 个是 **googletest 的 Python 测试**
（在 `src/third_party/googletest` 里）。

#### 后果三：不是人的设计决策

`src/modules → src/third_party` 这条边，
它的含义是「opus 内部依赖了 wolfssl」—— 那是 **opus 的设计**，
不是这个项目的架构决策。

**「用了第三方库」和「A 模块耦合了 B 模块」是两种完全不同的东西。**
报告把它们混在一起，等于把架构信号和依赖清单混在一起。

---

## 3. 决策

### 3.1 vendor 目录**不参与**依赖图

三类都不产生边：

| 情况 | 处理 |
|---|---|
| 项目代码 → vendor 代码 | 不产生边（「用了第三方库」不是架构耦合） |
| vendor 代码 → 项目代码 | 不产生边（那是第三方库碰巧用到了本项目的什么） |
| vendor 代码 → vendor 代码 | 不产生边（第三方库之间的内部结构） |

### 3.2 但**计入覆盖率** —— 单独一行报

**关键**：不能假装 vendor 代码不存在。

不报的话会有人说「你说 C++ 有 496 个文件，那另外 4385 个呢？」
—— 数字对不上，报告就不可信了。

所以：

```
  扫描覆盖
    ✔ TypeScript / JavaScript     12 个文件 （依赖已验证）
    ✔ Python                      73 个文件 （依赖已验证）
    ✔ C / C++                    496 个文件 （依赖已验证）
    ⚠ Rust                        76 个文件 （代码 —— 无 import 语义，依赖未验证）
    ...

  外部代码边界
    · src/third_party
      4355 个文件在 vendor 目录里 —— 引入的外部代码，不参与架构检查。
      设计里的 vendor 模块：src/third_party —— 它们的依赖不算架构耦合。
```

**「只验证了 577/8514」的分母也排除了 vendor** ——
比「580/14439」诚实得多。

### 3.3 vendor **模块**（设计里声明的那个）

真实项目的设计里会写：

```
### src/third_party
- **职责**：第三方库集成
- **文件路径**：src/third_party/*, src/third_party/**/*
- **依赖模块**：无
```

这个模块是**外部边界**，不是架构的一部分：

- A 声明依赖它 → **不报**「缺失依赖」（第三方库当然存在）
- 代码里 A 依赖它 → **不报**「未声明依赖」（那不是架构耦合）
- 它自己「0 个文件」→ **不报**「模块无文件」（vendor 文件被排除在归属之外）
- 报告里标 `[外部代码]`

### 3.4 识别判据：**目录名约定**

`third_party` / `thirdparty` / `third-party` / `vendor` / `vendors` /
`external` / `externals` / `deps` / `3rdparty`

**与 ADR-062 的 include 根同样的思路**：约定法只漏不错。
漏了的后果是「把 vendor 当普通模块」—— 回到今天的状态，不产生假偏离。

**只认顶层的约定名**，且**找到就不再往下找** ——
第三方库内部的目录结构不是边界，规则不能失控。

### 3.5 顺带修：`build2` 这类带序号的构建目录

真实项目里有 `build2/`（CMake 的第二个构建树）。
它的 `CMakeFiles/CompilerIdC/` 是编译器探测产物，
之前被算进「文件无归属」（3 条噪音）。

判据：`/^build\d*$/` —— `build`、`build2`、`build10` 都排除。

---

## 4. 实现

### 4.1 扫描阶段

```ts
// vendor 文件不参与模块图
if (isVendorPath(path, vendorDirs)) {
  ownerOf.set(path, null);
  continue;
}
```

**但仍然计入 `vendorFiles`** —— 覆盖率要单独报。

### 4.2 边聚合阶段

```ts
const ownerIsVendor = vendorModuleSet.has(owner);
const targetIsVendor = vendorModuleSet.has(targetModule);
if (ownerIsVendor || targetIsVendor) continue;
```

### 4.3 报告阶段

- `declaredPairs` 跳过 vendor 模块（来源侧和目标侧都跳）
- `empty_module` 跳过 vendor 模块
- `modules[]` 加 `isVendor` 标记

### 4.4 覆盖率

`counts` 只数**项目自己的**文件；vendor 单独走 `vendorFiles`。

**关键实现细节**：vendor 文件按**语言类别**分，不是按「是不是源文件」。

```ts
const vendorFiles = allFiles.filter((path) => isVendorPath(path, vendorDirs));
```

如果按源文件筛（`detectLang(path) !== null`），**vendor 里的 Rust 文件会漏出去** ——
因为扫描器读不懂 Rust（`detectLang` 对 `.rs` 返回 `null`）。

真实项目里 `src/third_party` 有 **76 个 Rust 文件**（wolfssl 66 + msquic 10）。
漏出去的后果：报告里冒出「⚠ Rust 76 个文件（依赖未验证）」——
但它们在 vendor 里，**根本不参与架构检查**。

按语言类别分之后，真实项目的覆盖率变成：

```
  扫描覆盖
    ✔ TypeScript / JavaScript     12 个文件 （依赖已验证）
    ✔ Python                      73 个文件 （依赖已验证）
    ✔ C / C++                    493 个文件 （依赖已验证）
    · 构建脚本                       102 个文件 （不产生依赖边）
    · 文档                           137 个文件 （不产生依赖边）
    · 配置文件                        30 个文件 （不产生依赖边）
    · 其它文件                        79 个文件 （不产生依赖边）

  外部代码边界
    · src/third_party
      11943 个文件在 vendor 目录里 —— 引入的外部代码，不参与架构检查。
```

**「⚠ 只验证了 N/M」的警告消失了** —— 项目自己的代码**全部**验证过了。
这不是「工具没判据」，是真的验完了。

---

## 4.5 一个连带的结论：Rust 依赖解析**不急了**

ADR-060 §4 方案 B/C 提到要补 Go / Rust 的依赖解析。
但实测发现：**真实项目里唯一的 76 个 Rust 文件全在 `src/third_party`** ——
项目自己的 Rust 代码是 **0 个**。

**所以「Rust 76 个文件的依赖解析」这个遗留项，实际上不存在** ——
那是 vendor 代码的依赖，不是这个项目的架构。

真要补 Rust 解析，得先遇到一个**有自己 Rust 代码**的项目。
本 ADR 顺带把这个遗留项消掉了。

---

## 5. 真实项目验证

### 5.1 偏离：26 → 25，噪音清零

**消失的 7 条**（全是 `→ src/third_party`）：
`src/modules`、`src/plugins`、`src/raw_udp`、`src/sctp`、
`src/transport`、`src/web_transport`、`tests`

**保留的 25 条**全是真实的项目内部问题：
`src/modules → src/plugins`（真环）、`src/engine → src/dtls`、
`examples → src/plugins` 等。

### 5.2 统计：从失真到真实

| 指标 | 之前 | 之后 |
|---|---|---|
| C / C++ 文件 | 4481 | **496** |
| Python 文件 | 447 | **73** |
| vendor 文件 | 混在里面 | **4355（单独报）** |
| 「只验证了 N/M」 | 580/14439 | **577/8514** |

### 5.3 「文件无归属」：7 → 3 → 0

`build2/` 的噪音也没了。

---

## 6. 测试

`tests/arch-vendor-dir.test.ts`（14 条）：

**识别**
- 发现约定名的目录
- 路径归属判定（含 `src/third_party_extra` **不算** vendor 的边界用例）

**依赖图**
- vendor 文件不被模块认领
- vendor 模块被识别
- 项目代码 → vendor 的边不产生

**报告**
- 不报「未声明依赖 → vendor」
- 不报「缺失依赖 → vendor」
- 不报「模块无文件」（vendor 模块）
- vendor 模块在概况里标出来
- 报告带上 vendor 目录与模块

**覆盖率**

- C++ 文件数不含 vendor
- **vendor 里的「扫描器读不懂」的语言（Rust）也不算「没验证」**

**反向**
- 没有 vendor 目录时行为不变

---

## 7. 约束核对

| 约束 | 核对 |
|---|---|
| **C3** 判定确定性 | 目录名约定 + 路径前缀比对，纯字符串计算 |
| **C4** append-only 事件 | `arch check` 是只读报告，不写事件 |
| **C2** core/ 零依赖 | 只用 `node:fs` / `node:path` |

---

## 8. 遗留

- **目录名约定可能不够** —— 真实项目里 vendor 目录也可能叫
  `external_libs`、`third-party-cpp` 之类。当前靠约定覆盖常见的，
  漏了的会回到「当普通模块」的老状态（安全方向）。
  将来可以支持在设计里**显式声明** vendor 模块 —— 那更准，
  但那要改设计契约（要写 ADR）。
- **`deps` 这个名字有点宽** —— Rust 生态里 `deps/` 有时是**自己写的**代码
  （`cargo vendor` 的默认目录是 `vendor/`）。
  当前的约定偏保守：漏判安全（回到老状态），误判才会漏掉真信号。
  误判的代价是「本该检查的依赖没检查」—— 这个方向的错误**比噪音更严重**，
  将来若要收紧，考虑去掉 `deps`。
- **vendor 模块的「职责」仍要人写** —— 设计里那个 `### src/third_party`
  段落现在是纯标记。它不参与判定，但保留着让人知道「这里有第三方库」。
