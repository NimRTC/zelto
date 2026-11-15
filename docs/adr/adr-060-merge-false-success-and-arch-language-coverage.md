# ADR-060：合并的假成功、架构扫描的语言覆盖面与编码守卫的误伤

**状态**: 已实施（D-11 / D-12 / §4 方案 A）/ 提案中（§4 方案 B、C）
**日期**: 2026-11-15
**作者**: 系统架构
**关联约束**: C1, C3, C9
**关联文档**: `src/cli/commands/merge-executor.ts`（中止语义）,
`src/cli/commands/merge.ts`（合并入口判据）,
`src/core/arch/imports.ts`（语言识别与 import 解析）,
`scripts/check-encoding.mjs`（编码守卫）

---

## 1. 摘要

本文记三件事：

1. **§2–§3：D-11 —— 合并的假成功（已修）**
   合并一步都没做，工具却打印「✅ Merge complete」并退出 0。
   这是**比误报更严重的一类缺陷**：工具报告了与事实相反的结论。

2. **§4：架构扫描的语言覆盖面（方案 A 已实施）**
   `arch check` 目前只对 JS/TS / Python 有判定能力。
   C++ / Go / Rust 项目里，它给出的结论是「大部分文件无法验证」——
   **但这个「无法验证」本身没有被诚实地报告出来**。

3. **§5：D-12 —— 编码守卫的误伤（已修）**
   编码守卫把常用汉字 `欢` 当成了乱码特征字，
   于是对着**干净文件**报错。误伤一个检测器比漏一个污染更糟。

三件事的共同点：**工具在信息不足时给出了确定性的结论**，
或者**工具给出的结论与事实相反**。

---

## 2. D-11：合并的假成功

### 2.1 现象

漂移探查（ADR-059 §6 遗留项）时实测到：

```
$ zelto merge dirty-workspace-slice

Merge Plan: 1 slices
Overall Strategy: sequential_ff
Phases: 1

  Phase 0 (sequential_ff):
    - dirty-workspace-slice

Executing merge (strategy: sequential_ff)...
  ⚠️  目标工作区有未提交改动，已跳过自动合并。
     ?? .zelto/
     先提交（git commit）或暂存（git stash）这些改动，再重新跑 zelto merge。
     签字已经过了，不用重新签。

✅ Merge complete (1 phases, 0 slices)
```

**退出码 0。** 合并一步都没做。

### 2.2 根因：`aborted` 只表示「冲突」

`MergeExecutionResult.aborted` 的语义被写成了「是否因冲突而中止」，
但工作区脏的守卫也用它来返回 —— 且返回的是 `aborted: false`：

```ts
// 修复前
if (dirty.length > 0) {
  log('  ⚠️  目标工作区有未提交改动，已跳过自动合并。');
  // ...
  return { merged, conflicts, staleBase, aborted: false };  // ← 这里
}
```

上层（`merge.ts`）只看 `aborted`：

```ts
if (result.aborted) { /* 报冲突 */ return 1; }
await cleanupMergedSlices(result.merged, targetBranch);
console.log(`✅ Merge complete (${plan.phases.length} phases, ${result.merged.length} slices)`);
return 0;
```

`aborted === false` → 打印 ✅ → 退出 0。

### 2.3 为什么这是最严重的一类缺陷

误报（该拦的没拦）的问题是「漏了防线」；
假成功（没做却报做了）的问题是「**结论与事实相反**」。

具体后果：

1. **人被骗**。人看到 ✅ 就以为合完了，去做下游的事（版本交付、发版）。
   真正的问题（工作区脏）被一句 ✅ 完全盖住。
2. **`--push` 会跟着跑**。推的是一条**没变过**的分支 ——
   远端看起来一切正常。
3. **下游判定基于假成功**。`version deliver` 的前置条件检查的是
   「切片是否已合入目标分支」，它读的是 git 状态（**正确**），
   所以版本交付会失败 —— 但人已经花时间在错误的方向上了。

### 2.4 决策

**（a）`aborted` 的语义改成「合并没有完成」，并加 `abortReason` 区分原因。**

```ts
export interface MergeExecutionResult {
  merged: string[];
  conflicts: MergeConflictReport[];
  staleBase: string[];
  /** 是否合并没有完成（冲突 / 工作区脏 / 其它） */
  aborted: boolean;
  /** 中止原因 —— 区分「冲突」与「工作区脏」，排查方向完全不同 */
  abortReason?: string;
}
```

**（b）工作区脏的守卫返回 `aborted: true`。**

**（c）上层区分两类中止，并堵住「0 slices 却报成功」的口子。**

```ts
if (result.aborted) {
  if (result.abortReason) {
    console.log(`❌ Merge aborted — ${result.abortReason}. The target branch was not modified.`);
  } else {
    console.log(`❌ Merge aborted — ${result.conflicts.length} slice(s) conflicted. The target branch was not modified.`);
  }
  return 1;
}

// ...
if (result.merged.length === 0) {
  console.log(`⚠️  Merge finished but no slice was merged (${plan.phases.length} phases, 0 slices).`);
  console.log(`   目标分支未被修改。`);
  return 1;
}
console.log(`✅ Merge complete (${plan.phases.length} phases, ${result.merged.length} slices)`);
```

最后那段是**兜底**：`aborted` 语义改了，但只要还有别的路径能返回
「merged 为空且没中止」，它就不该报成功。
**判据不依赖单一标志位** —— 这是这次事故的直接教训。

### 2.5 顺带修的：两条路径的判据对齐

漂移探查还发现另一处不一致：**「分支不存在」的处理**。

| 路径 | 原判据 |
|---|---|
| 不带 id | `collectMergeCandidates` 跳过（`branchExists` 为 false） |
| 带 id | **不查** —— 计划照列，执行阶段才发现合不了 |

而带 id 的路径在查分支之前已经跑了 `commitPendingWorktrees`（**有副作用**：
提交 worktree 里的改动）。

**修法**：显式 id 路径在 `commitPendingWorktrees` **之前**查分支存在性，
缺失就拒绝并点名。

```ts
const missingBranches = ids.filter((id) => !branchExists(`slice/${id}`, process.cwd()));
if (missingBranches.length > 0) {
  console.error('❌ 以下切片没有对应的分支，无法合并：');
  // ...
  return 1;
}
```

### 2.6 约束核对

| 约束 | 核对 |
|---|---|
| **C1** 状态只在文件里 | 未引入新状态；中止语义只经返回值传递 |
| **C3** 判定确定性 | 判据只读 git 状态（`branchExists`）与文件 |
| **C4** append-only 事件 | 未改事件类型；`merge.planned` 仍照写 |

### 2.7 回归测试

- `tests/merge-false-success.test.ts` —— D-11 的 4 条用例
- `tests/merge-path-drift.test.ts` —— 两条路径判据对齐的 5 条用例

---

## 3. 教训

### 3.1 「中止」不是「冲突」

`aborted` 这个名字在实现时想的是「冲突导致的中止」，但实际用它承载了
「任何导致合并没做完的情况」。**语义在实现中漂移，接口没跟上。**

规则：**布尔标志位的语义只能变宽，不能变窄**。
如果一个标志后来要表达更多情况，就该加一个原因字段，而不是复用它。

### 3.2 判据不能依赖单一标志位

D-11 的修复加了两道：`aborted: true` + `merged.length === 0` 兜底。
第二道是刻意加的 —— 第一道依赖调用方正确设置标志位，
第二道依赖**结果本身**（没有切片被合进去）。

**如果两个判据都指向同一件事，那么其中一个一定会在某处漏掉。**

### 3.3 「工具报告成功」比「工具报错」更需要审计

报错是显性的 —— 人会看见。假成功是隐性的 —— 人会**基于它继续行动**。

所以凡是能返回「成功」的路径，都值得问一句：
**「成功」的定义是什么？有没有一种情况是「什么都没做」但被算作成功？**

---

## 4. 提案：架构扫描的语言覆盖面

### 4.1 现状

`src/core/arch/imports.ts` 的 `detectLang` 只认两种语言：

```ts
export function detectLang(filePath: string): SourceLang | null {
  if (lower.endsWith('.ts') || ... ) return 'ts';
  if (lower.endsWith('.js') || ... ) return 'ts';
  if (lower.endsWith('.py')) return 'python';
  return null;   // ← C++ / Go / Rust / Java 全落这里
}
```

`SourceLang` 类型也只有 `'ts' | 'python'`。

后果链：

1. C++ 文件全部「不是源文件」→ 不参与 import 图
2. 模块的「可读代码比例」下降 → ADR-058 把它降级成
   `unverifiable_dependency`（警告级，不阻断）
3. **整个 C++ 项目的 `arch check` 几乎不产出任何有效结论** ——
   但它**没有说这件事**

### 4.2 问题不是「不支持 C++」，是「假装有结论」

如果 zelto 明确说「我只支持 JS/TS 与 Python 的依赖验证，
这个项目我验不了」，那是**诚实的工具边界**。

现在的问题是：`arch check` 在 C++ 项目上输出的是
「✅ 无偏离」或「⚠️ N 项无法验证」——
后者看起来像是「项目有点小问题」，而真相是「**这个工具在这个项目上没有判据**」。

**这两件事对人的行动含义完全不同**：
前者说「去修一下」，后者说「换个工具或补判据」。

### 4.3 提案（三档，按成本递增）

#### 方案 A：显式声明「语言覆盖面」（最小改动）—— **已实施**

在 `arch check` 的输出里**显式报告**本次扫描覆盖了哪些语言、
哪些文件没能验证：

```
扫描覆盖：
  ✔ TypeScript / JavaScript   142 个文件（依赖已验证）
  ✔ Python                     38 个文件（依赖已验证）
  ⚠ C / C++                   377 个文件（代码 —— 无 import 语义，依赖未验证）
  · 构建脚本                   12 个文件（不产生依赖边）

  ⚠ 本次只验证了 180/569 个文件的依赖关系。
    377 个代码文件没有可用的依赖语义 —— 它们的依赖关系**没有被检查过**。
    上面的偏离只涉及已验证的部分；未验证部分的偏离本次查不出来。
```

**已实施**：见 §4.3.1。

**改动量**：小（`scan.ts` 已经收集了 `moduleCodeFiles` 与 `moduleFiles`，
只是没把「不可扫描」这件事单独报出来）。

**价值**：把「验不了」变成一句明说的话，而不是让人从
「377 项无法验证」里自己推断。

**局限**：仍然验不了 C++ 的依赖。

#### 4.3.1 方案 A 的实现

**新增** `classifyLangCategory(path)` —— 判定文件属于哪一类语言：

| 类别 | 文件类型 | 是否有依赖语义 |
|---|---|---|
| `typescript` | `.ts` `.tsx` `.mts` `.cts` `.js` `.jsx` `.mjs` `.cjs` | ✅ 已支持 |
| `python` | `.py` `.pyi` | ✅ 已支持 |
| `cpp` | `.c` `.h` `.cc` `.cpp` `.cxx` `.hpp` `.hh` `.hxx` `.ipp` `.inl` `.m` `.mm` | ❌ 尚未支持 |
| `go` | `.go` | ❌ 尚未支持 |
| `rust` | `.rs` | ❌ 尚未支持 |
| `java` | `.java` `.kt` `.kts` | ❌ 尚未支持 |
| `build` | `Makefile` `Dockerfile` `CMakeLists.txt` `*.gradle` `meson.build` 等 | — 不产生依赖边 |
| `doc` | `.md` `.rst` `.txt` `LICENSE` `README` 等 | — 不产生依赖边 |
| `config` | `.json` `.yaml` `.toml` `.ini` 等 | — 不产生依赖边 |

**关键设计**：`classifyLangCategory` 与 `detectLang` **分开**。

- `detectLang` 回答「这个文件**能不能**参与 import 图」（能扫就返回语言）
- `classifyLangCategory` 回答「这个文件属于**哪一类**语言」（覆盖所有文件）

后者必须覆盖**扫不了的文件** —— 否则报告里就没法说
「377 个 C++ 文件没能验证」。

**特殊文件名优先于扩展名**：`CMakeLists.txt` 的扩展名是 `.txt`（文档类），
但它其实是构建脚本。判扩展名会把它归错类。

**`ScanResult` 与 `ArchitectureReport` 新增 `coverage` 字段**：

```ts
export interface LangCoverage {
  /** 每种语言类别的文件数 */
  counts: Record<LangCategory, number>;
  /** 能参与依赖验证的语言类别 */
  verifiable: LangCategory[];
  /** 参与了 import 图的文件数 */
  verifiedFiles: number;
  /** 属于「代码类」但无法参与验证的文件数 */
  unverifiableCodeFiles: number;
  /** 不产生模块依赖边的文件数 */
  nonCodeFiles: number;
  /** 总文件数 */
  totalFiles: number;
}
```

**为什么把「代码类但验不了」与「不产生依赖边」分开**：

前者是「**没有判据**」，必须显式报出来；
后者是**正常的**（构建脚本本来就不产生模块依赖），
混进「验不了」里会稀释掉真正重要的信息。

**改了什么契约**：这是**内部接口**变更（`ScanResult` / `ArchitectureReport` 是
core/ 内部的 TypeScript 类型，不是 `contracts/schemas/` 里的 JSON Schema），
所以不需要走契约 ADR。但 `arch check --json` 的**输出形状**变了 ——
多了一个 `report.coverage` 字段。
JSON 输出是给调用方用的，属于事实上的接口，
所以这个变更在本文里明确记下。

**实现中踩的坑**：`Object.keys(LANG_CATEGORY_KEYS)` 给的是**数组的索引**
（`"0"`..`"9"`），不是元素值 —— 用错了会往 `counts` 里塞一堆假键，
报告里也会出现一堆看不懂的类别。要遍历数组**本身**。

这个坑已被 `tests/arch-lang-coverage.test.ts` 守住。

#### 方案 B：补 C/C++ 的 `#include` 解析

C/C++ 的依赖表达是 `#include "..."` / `#include <...>`，
语义上接近「相对路径」与「系统头」。

**需要**：
- `detectLang` 加 `'cpp'`（`.c` / `.cc` / `.cpp` / `.cxx` / `.h` / `.hpp`）
- `parseImports` 加 C++ 分支：抓 `#include`
- `resolveRelative` 支持 C++ 的头文件查找路径
- **必须排除系统头**（`<stdio.h>` 之类）—— 它们不属于本项目的模块

**改动量**：中（新增一个语言的解析分支 + 头文件路径解析）

**风险**：
- C++ 的 include 路径语义复杂（`#include <foo>` 可能来自多个搜索路径）
- 宏条件编译（`#ifdef _WIN32`）会让解析结果依赖构建配置
- 模板 / 内联函数不会产生 include 边，但会产生**隐式依赖**（声明与定义分离）

**价值**：让 C++ 项目真正有判据。

#### 方案 C：把「架构验证」抽象成可插拔的语言适配器

把 `detectLang` / `parseImports` / `resolveRelative` 抽成一组接口，
每种语言一个适配器。项目配置里声明用哪种。

**改动量**：大（core/ 的接口重构 + 契约变更 → 必须走 ADR）

**价值**：解决根本问题 —— 语言支持不该是硬编码的。

### 4.4 建议

**先做方案 A**，理由：

1. **成本与收益比最高**。A 改动量最小，但直接解决「假装有结论」这个问题。
2. **B 的收益依赖用户群**。目前实战演练的对象是 C++ 项目，
   但 zelto 自身的生态是 TS/JS。B 是一次针对单个语言的投入，
   而「可插拔」才是长期解。
3. **A 是 B / C 的前置**。无论最终支持哪些语言，
   「哪些文件没被验证」这件事都该被报告出来。
4. **A 的改动量最小**。core/ 的内部类型变了（`ScanResult` /
   `ArchitectureReport` 加了 `coverage`），但实现逻辑没动 ——
   符合「开发 zelto 自身时的例外」。

**方案 B / C 需要单独开 ADR** —— C 改的是 core/ 的内部接口，
且 B 要处理的条件编译语义需要真实的 C++ 项目验证。

### 4.5 一个更根本的问题（不在本 ADR 范围）

架构扫描的价值前提是「**模块归属是设计上说清楚的**」。
C++ 项目里 `src/engine/src/` 与 `src/engine/include/` 的边界、
第三方目录的边界，往往**本来就没有被明确声明过**。

也就是说：即使补齐了 C++ 的 import 解析，
如果设计里的模块划分没跟上，扫描出来的图也是噪声。

**这条更值得先做** —— 但它是「项目怎么用 zelto」的问题，
不是「zelto 怎么实现」的问题，属于文档与实践范畴。

---

## 5. D-12：编码守卫的误伤

### 5.1 现象

全量测试时编码守卫报错：

```
[zelto] 编码检查失败：1 个文件疑似乱码污染。
  tests\write-set-coverage.test.ts:293  U+6B22
```

但那个文件**完全干净** —— 它是我上一轮刚写的测试文件，
第 293 行是：

```ts
const paths = parseMentionedPaths('这个功能应该很快，用户会喜欢这个体验。');
```

`U+6B22` 是「**欢**」。

### 5.2 根因：特征字表里混进了常用字

`scripts/check-encoding.mjs` 的 `MOJIBAKE_MARKERS` 是一组
「GBK 误解码的高置信特征字符」。名单里有 `欢`（U+6B22）。

它**确实**是误解码产物 —— 把「喜欢」按 GBK 误解码会得到 `U+9354 U+6D43 U+7BD0`
一类的字。但 `欢` **本身就是常用汉字**（喜欢 / 欢迎 / 欢乐）。

名单的原始推导标准是「污染语料中频次 >= 200、干净语料中出现 <= 2 次」——
那个「干净语料」是仓库当时的语料，不含「喜欢」这个组合。
**语料一换，判据就失效了。**

### 5.3 为什么误伤比漏检更严重

编码守卫是**最后一道防线** —— 其它工具坏了它还能拦住，
它自己坏了就是没人拦。

而一个开始报假警的检测器会**迅速失去可信度**：
人看到它对着干净文件报错，第一反应是「这玩意儿不可靠」，
然后就绕过它 —— 那它对**真污染**也失效了。

**漏检一个污染**：人写坏了一个文件，编译期报错，能查出来。
**误伤一次**：人开始不信这个守卫，之后所有真污染都放过。

后者更糟。

### 5.4 决策

**（a）把 `欢` 移出特征字表，并写明入选标准。**

新标准（两条都要满足）：

1. 在 GBK 误解码语料里出现频次 >= 20 —— 得是**典型**的误解码产物
2. **本身不是常用汉字** —— 常用字会误伤正常文本

第 2 条是这次事故的直接教训。

**（b）守卫不查自己。**

守卫源码里**必然**含有特征字（它们是数据，写在 `MOJIBAKE_MARKERS` 里）——
守卫会把自己判成污染。这是自指的必然，不是缺陷。

```js
// 跳过守卫自己 —— 它的特征字是数据，不是污染
if (rel === SELF) continue;
```

跳过自己不会削弱守卫：它对**其它**所有文件的判据一字未改。

**（c）给守卫自己写回归测试。**

`tests/encoding-checker.test.ts` 守住四件事：

1. 特征字表非空
2. **特征字表里没有常用汉字** —— 拿一份高频字清单逐个查
3. 特征字表**仍然包含**典型的误解码产物 —— 防止「修过头」
4. 干净的正常中文不会命中；误解码文本确实会命中

第 3 条是关键：**只测「不误伤」不够**，
还得测「还抓得住」—— 否则最省事的修法是**清空名单**，
守卫就彻底瞎了，而所有测试还都是绿的。

### 5.5 约束核对

| 约束 | 核对 |
|---|---|
| **C3** 判定确定性 | 名单是硬编码常量，判据只读文件字节 |
| **C2** core/ 零依赖 | `scripts/` 不在 core/ 内，且只用 Node 内置 |

### 5.6 回归测试

- `tests/encoding-checker.test.ts` —— 5 条用例

---

## 6. 影响

### 6.1 合并（D-11）

- 合并在「工作区脏」时**中止并退出 1**，不再报假成功
- `MergeExecutionResult` 新增 `abortReason` 字段（可选，不破坏既有调用方）
- 合并在「0 slices 被合入」时报警告并退出 1
- 显式 id 的合并路径在有副作用之前检查分支存在性

### 6.2 架构扫描（§4 方案 A）

- `ScanResult` 与 `ArchitectureReport` 新增 `coverage` 字段
- `arch check` 输出新增「扫描覆盖」段落
- `arch check --json` 的 `report` 里新增 `coverage`
- 新增 `classifyLangCategory` / `isVerifiableLang` 两个导出

### 6.3 编码守卫（D-12）

- `MOJIBAKE_MARKERS` 移除 `欢`（U+6B22），并写明入选标准
- 守卫跳过自身文件

### 6.4 测试

新增四个测试文件，共 24 条用例：

| 文件 | 用例数 | 守住什么 |
|---|---|---|
| `tests/merge-false-success.test.ts` | 4 | D-11 假成功 |
| `tests/merge-path-drift.test.ts` | 5 | 两条合并路径的判据对齐 |
| `tests/arch-lang-coverage.test.ts` | 8 | §4 方案 A |
| `tests/encoding-checker.test.ts` | 5 | D-12 编码守卫误伤 |

修改两个既有测试文件（补 `coverage` 字段）。

---

## 7. 遗留

- §4 方案 B（C++ include 解析）待单独 ADR
- §4 方案 C（可插拔语言适配器）待单独 ADR
- §4.5 的「模块归属要先说清楚」是实践问题，需要文档跟进
- 演练记录（`docs/` 下的 dogfooding 记录）待更新本轮 D-11 / D-12

---

## 8. 给后续的三条经验

### 8.1 「工具报告成功」比「工具报错」更需要审计

报错是显性的 —— 人会看见。假成功是隐性的 —— 人会**基于它继续行动**。

所以凡是能返回「成功」的路径，都值得问一句：
**「成功」的定义是什么？有没有一种情况是「什么都没做」但被算作成功？**

### 8.2 判据不能依赖单一标志位

D-11 的修复加了两道：`aborted: true` + `merged.length === 0` 兜底。
第二道是刻意加的 —— 第一道依赖调用方正确设置标志位，
第二道依赖**结果本身**（没有切片被合进去）。

**如果两个判据都指向同一件事，那么其中一个一定会在某处漏掉。**

### 8.3 检测器的误伤成本 ≥ 漏检成本

一个报假警的检测器会被绕过，从而对真问题也失效。

所以：特征字表这类「凭经验攒出来的名单」，
要有**双向**的回归测试 —— 既测「不误伤」，也测「还抓得住」。
只测前者，最省事的修法就是清空名单。
