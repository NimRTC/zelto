# ADR-069：Go 与 Rust 的依赖解析

**状态**: 已实施
**日期**: 2026-11-16
**作者**: 系统架构
**关联约束**: C3
**关联文档**: `src/core/arch/imports.ts`（Go / Rust 解析）,
`src/core/arch/scan.ts`（路径解析与边计算）,
`src/core/arch/types.ts`（数据契约）

**前置**: ADR-060 §4（语言覆盖面）、ADR-061（代码 vs 已验证）、
ADR-062（C++ include 解析）、ADR-064（条件编译依赖）、ADR-065（vendor 边界）

---

## 1. 摘要

`arch check` 目前能验证 TypeScript / JavaScript / Python / C / C++ 的依赖关系。
**Go 与 Rust 不在其中** —— 它们的代码文件被算进「有代码但验不了」。

本文补上这两种语言。

| 语言 | 依赖表达 | 解析难度 |
|---|---|---|
| Go | `import "..."` / `import (...)` | 低 —— 语法简单，路径语义明确 |
| Rust | `use ...;` / `extern crate ...;` / `mod ...;` | 中 —— `use` 的路径形态多 |

---

## 2. 调研：Go 与 Rust 的依赖长什么样

### 2.1 Go

Go 的 import 有两种形态：

```go
import "fmt"                       // 单行
import (                            // 块
    "fmt"
    "github.com/foo/bar"
    alias "github.com/baz/qux"
    _ "embed"
)
```

**关键特征**：

- 路径**总是**以模块路径或标准库名开头，**没有相对路径**（`.` / `..`）
- `import` 块里可以有**别名**（`alias "path"`）与**空导入**（`_ "path"`）
- 条件编译靠 `//go:build` 注释 + 构建约束文件名（`_linux.go` / `_test.go`）

**条件编译的判据**（Go 官方规范）：

```go
//go:build linux && amd64
// +build linux,amd64
```

注释在文件**顶部**（package 子句之前），旧格式是 `// +build`。

### 2.2 Rust

Rust 的依赖表达有四种：

```rust
use std::collections::HashMap;      // ① use —— 最常见
use crate::core::registry;          // ① crate 内部
use super::parent;                  // ① 父模块
use self::sibling;                  // ① 同级
extern crate serde;                 // ② extern crate（2015 edition 常见）
mod submodule;                      // ③ mod 声明
pub mod submodule;                  // ③ 同上
use crate::foo as bar;              // ① 带别名
use crate::{a, b};                  // ① 嵌套花括号
```

**关键特征**：

- `use` 路径以 `crate::` / `super::` / `self::` 开头 → **项目内部**
- `use` 路径以 `std::` / `core::` / `alloc::` 开头 → **标准库**
- 其它 → **外部 crate**（第三方依赖）
- `use` 可以带别名：`use crate::foo as bar;`
- `use` 可以用嵌套花括号：`use crate::{a, b::c};`
- `extern crate serde;` —— 引入整个 crate（2015 edition 常见）
- `mod submodule;` —— 声明子模块，**不是引用**（它指向同目录的 `submodule.rs`
  或 `submodule/mod.rs`）

**条件编译**：

```rust
#[cfg(target_os = "linux")]
use nix::unistd::close;
```

`#[cfg(...)]` 是个**属性**，可以挂在任何 item 上。

---

## 3. 决策

### 3.1 D1：Go 的解析

**解析目标**：`import` 的路径字符串。

```
import "fmt"                        → fmt
import ( "fmt" \n "x/y" )           → fmt, x/y
import alias "x/y"                  → x/y（别名不是路径的一部分）
import _ "x/y"                      → x/y（空导入也是依赖）
```

**归类**：

| 路径形态 | 归类 | 进模块图？ |
|---|---|---|
| 标准库（`fmt` / `os` / `net/http` …） | `builtin` | 否 |
| 其它（`github.com/...`） | `package` | 尝试按模块名匹配 |
| `.` / `..` 开头 | — | Go 没有相对 import，**不解析** |

**Go 的 import 路径怎么映射到模块？**

Go 的 import 路径是**模块路径**（`github.com/foo/bar/internal/baz`），
跟文件系统路径没有对应关系。项目的模块名通常出现在 `go.mod` 里。

**判据（约定法，与 ADR-062 的 include 根同一思路）**：
从 `go.mod` 的第一行读出 module path，然后
「import 路径以 module path 开头」→ 去掉前缀 → 按**目录路径**去匹配模块归属。

```
go.mod:  module github.com/foo/bar
import "github.com/foo/bar/internal/core"
       → 内部路径 "internal/core"
       → 在文件系统里找 internal/core/ 目录 → 归属到哪个模块就是哪个
```

**为什么用约定法而不解析 go.mod 的全部语义**：
`go.mod` 的 `replace` / `exclude` / `require` 语义复杂（模块图、版本选择），
而我们只需要「哪个 import 路径算项目内部」。**只读 module path 一行**就够了，
其余一律当外部依赖 —— 宁可漏，不猜（ADR-062 §7 同样的权衡）。

### 3.2 D2：Rust 的解析

**解析目标**：`use` / `extern crate` 的路径。

```
use crate::core::registry;    → crate::core::registry
use super::parent;            → super::parent
use std::collections::HashMap;→ std::collections::HashMap
use crate::{a, b::c};         → crate::a, crate::b::c
use crate::foo as bar;        → crate::foo
extern crate serde;           → serde
```

**`mod` 声明不产生依赖边** —— 它不是「引用」，是「声明」：
`mod submodule;` 指的是**同目录的** `submodule.rs`，
那不是「这个模块依赖了另一个模块」，而是「这个文件是那个模块的一部分」。

**归类**：

| 路径前缀 | 归类 | 进模块图？ |
|---|---|---|
| `crate::` | `relative`（项目内部） | 是 |
| `self::` | `relative` | 是 |
| `super::` | `relative` | 是 |
| `std::` / `core::` / `alloc::` | `builtin` | 否 |
| 其它（裸路径，如 `serde`） | `package`（外部 crate） | 尝试按模块名匹配 |

**Rust 的内部路径怎么映射到文件？**

Rust 的模块树由文件路径决定：

```
src/
  main.rs        ← crate 根
  core/
    registry.rs  ← crate::core::registry
    mod.rs
```

`crate::core::registry` → 找 `src/core/registry.rs` 或 `src/core/registry/mod.rs`。

**判据（约定法）**：crate 根目录 = 含 `Cargo.toml` 的目录（再往上是 `src/`）。
找到 `Cargo.toml` → 它的 `src/` 目录就是 crate 根。

**没有 `Cargo.toml` 怎么办？** —— 退回「按路径后缀猜」：
`crate::core::registry` 去掉 `crate::` 得到 `core::registry`，
转成 `core/registry`，在文件树里找 `core/registry.rs` 或 `core/registry/mod.rs`。

### 3.3 D3：条件编译的处理

**与 ADR-064（C++ 条件编译）一致**：

- 条件块里的依赖**仍然是依赖**（开启那个特性时它就在）
- 但要**标记**条件（`cppCondition` 字段复用为通用的 `condition`）

Go：`//go:build` 注释在文件顶部，覆盖**整个文件**。
Rust：`#[cfg(...)]` 挂在 item 上，只影响**那一个 item**。

**Go 的处理**：找出文件顶部的 `//go:build` / `// +build` 行，
**整个文件**的依赖都带上这个条件标记。

**Rust 的处理**：找出 `#[cfg(...)]` 与它**紧跟的下一个 item**（`use` / `extern crate`），
只给那个 item 标条件。

### 3.4 D4：条件编译下的**文件级**条件

Go 的文件名后缀本身是构建约束：

```
foo_linux.go    ← 只在 linux 构建
foo_test.go     ← 只在测试构建
```

**要不要处理？** 不处理。

理由：`foo_linux.go` 与 `foo.go` 是**同一模块的两个文件**，
它们之间的依赖关系是「同一个模块引用自己」，不产生跨模块边。
文件名约束影响的是「这个文件在什么平台存在」，不是「它依赖谁」。

**但**它影响**覆盖率数字** —— 一个只在 Windows 构建的文件
在 Linux 上「验过了」，但那份代码在 Windows 上可能不一样。

这是**覆盖率口径**问题，不是**依赖关系**问题。
本 ADR 不处理，记为已知局限（§6）。

### 3.5 D5：Go / Rust 计入「已验证」

`isVerifiableLang` 增加 `go` / `rust`。
`isCodeLangCategory` 不变（它们本来就是代码类）。

**影响**：`arch check` 的报告里，Go / Rust 文件从
「有代码但验不了」变成「已验证」。

---

## 4. 与既有解析的衔接

### 4.1 `ImportRef` 的扩展

```ts
export interface ImportRef {
  specifier: string;
  kind: 'relative' | 'package' | 'builtin';
  line: number;
  cppBracket?: '<' | '"';
  cppCondition?: string;   // ← 复用为「通用条件标记」
}
```

**为什么不改字段名？** `cppCondition` 已经被 ADR-064 的报告层用了。
改名要动报告层 + 测试。改成通用名 `condition` 更干净，但**改名是破坏性的**。

**决策**：**新增通用字段 `condition`**，保留 `cppCondition` 作为别名
（C++ 解析器两个都填，其它语言只填 `condition`）。
报告层优先读 `condition`，回退读 `cppCondition`。

### 4.2 `SourceLang` 的扩展

```ts
export type SourceLang = 'ts' | 'python' | 'cpp' | 'go' | 'rust';
```

### 4.3 扫描流程的扩展

`scan.ts` 里现在按 `file.lang === 'cpp'` 分派到 `resolveCppInclude`。
新增两个分支：

```
'go'   → resolveGoImport
'rust' → resolveRustImport
```

---

## 5. 变更清单

| 文件 | 变更 |
|---|---|
| `src/core/arch/types.ts` | `SourceLang` 增加 `go` / `rust`；`ImportRef` 增加 `condition` |
| `src/core/arch/imports.ts` | `parseGoImports` / `parseRustImports`；`detectLang` 扩展；`isVerifiableLang` 扩展 |
| `src/core/arch/scan.ts` | `resolveGoImport` / `resolveRustImport`；发现 `go.mod` / `Cargo.toml` 根 |
| `tests/arch-go-import.test.ts` | **新增** —— Go 的回归测试 |
| `tests/arch-rust-import.test.ts` | **新增** —— Rust 的回归测试 |
| `docs/adr/adr-069-go-rust-dependency-parsing.md` | 本文 |

---

## 6. 已知局限

### 6.1 Go 的文件名构建约束（`_linux.go` / `_test.go`）

影响**覆盖率口径**，不影响依赖关系。见 §3.4。

### 6.2 Go 的 `replace` 指令

`go.mod` 里的 `replace` 可以把一个模块路径指向本地目录。
**不解析** —— 影响是「本地 replace 的模块算外部依赖」，
即那条边**不出现**（漏边，不是假边）。

### 6.3 Rust 的 `#[path]` 属性

`#[path = "other.rs"] mod foo;` 会改变模块的文件位置。
**不解析** —— 后果是 `mod` 本来就不产生边，无影响。

### 6.4 Rust 的 workspace

Cargo workspace 里多个 crate 各有 `Cargo.toml`。
本 ADR 只认**离文件最近的那个** `Cargo.toml` 作为 crate 根。

### 6.5 Rust 的 re-export（`pub use`）

`pub use crate::foo::Bar;` 是 re-export（把别处的类型暴露到本模块）。
它**确实**是一条依赖边 —— 本 ADR 解析它（`use` 的路径形态一致）。

---

## 7. 验证

### 7.1 单元测试

**Go**：
1. `import "fmt"` → `builtin`
2. `import ( "a" \n "b" )` → 两条
3. `import alias "x"` → 说明符是 `x`（不是 `alias x`）
4. `import _ "x"` → 说明符是 `x`
5. `//go:build linux` 的文件 → 所有依赖都带条件标记
6. 项目内部 import（以 `go.mod` 的 module path 开头）→ 解析到模块
7. 外部 import（`github.com/other/...`）→ 不产生边

**Rust**：
1. `use std::x;` → `builtin`
2. `use crate::core::registry;` → `relative`
3. `use super::x;` / `use self::x;` → `relative`
4. `use crate::{a, b::c};` → 两条
5. `use crate::foo as bar;` → 说明符是 `crate::foo`
6. `extern crate serde;` → `package`
7. `mod submodule;` → **不产生依赖边**
8. `#[cfg(...)] use x;` → 带条件标记
9. `crate::core::registry` → 解析到 `src/core/registry.rs`

**共同**：
10. 确定性（C3）：同样输入两次结果完全相同
11. 跨模块边正确产生
12. Go / Rust 计入「已验证」（`coverage.verifiable`）

### 7.2 回归

`npm test` 全绿 + `npx biome check` 干净。

---

## 8. 关联

- ADR-060 §4（语言覆盖面）—— 「没有判据」要说清楚，本 ADR 缩小盲区
- ADR-061（代码 vs 已验证）—— 本 ADR 让 Go / Rust 从前者移到后者
- ADR-062（C++ include 解析）—— 「约定法只漏不错」的权衡，本 ADR 沿用
- ADR-064（条件编译依赖）—— 条件边**仍然是依赖**，本 ADR 沿用
- ADR-065（vendor 边界）—— Go / Rust 的 vendor 目录同样适用
