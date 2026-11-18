# 交接：清掉实战演练遗留的 5 条 zelto 缺陷

**日期**：2026-11-18
**来源**：`docs/zelto-实战演练记录-20261116.md` §8「第三轮遗留状态」的「仍然遗留」清单
**任务**：把这 5 条全部修掉，每条都要有回归测试；改契约的写 ADR

---

## 背景（必读）

这 5 条是**在真实项目（nimrtc-zelto）上跑出来的**，不是理论推演。

演练记录里反复出现同一个教训，已经复发至少 4 次：

> **「每条路径都接上了」不等于「每条路径都接全了」。**
> **「这一层改好了」被当成「这件事改好了」。**

D-55（进展喂了两条路，第三条漏了）、D-64（回退路径补了，空壳清理路径没补）、
D-69（判据不能只靠一根绳）都是这个形态。

**所以这次的核心要求是：修完一条，必须去真实项目上复验一遍**，
而不是「单元测试绿了就算完」。

---

## 遗留 1：Java / Kotlin 依赖解析缺失（中等）

**现状**：`src/core/arch/imports.ts` 里有 Java/Kotlin 的**语言分类**，
但**没有 import 解析器**：

```ts
// imports.ts:95
java: 'java', kt: 'java', kts: 'java',   // ← 只分类，不解析
```

`parseImports()`（imports.ts:210）没有 `java` 分支，
`scan.ts` 里也没有 `file.lang === 'java'` 的分支。

**要做的**：
- 加 `parseJavaImports()`：`import a.b.C;` / `import static a.b.C;` /
  `import a.b.*;` / `import a.b.C as D;`
- Kotlin：`import a.b.C` / `import a.b.C as D`
- 在 `scan.ts` 里加 `java` 分支：解析出包路径 → 落到 `src/main/java/<pkg>/<Class>.java`
  或 `src/<pkg>/<Class>.kt`（Gradle / Maven 两种布局都要认）
- `isVerifiableLang()` / `isCodeLangCategory()`（imports.ts:169 / 189）
  **已经包含 `java`** —— 改完后这里才真正说得通

**注意**：Java/Kotlin 的依赖关系判据比 Go/Rust 复杂（包 → 目录 → 类文件）。
判不准时**宁可漏边也不要判错边** —— 判错边会产生假的「环」。

**测试**：`tests/` 下新增用例，覆盖 import 解析 + 模块归属 + 至少一个真实目录布局。

---

## 遗留 2：Go 的文件名构建约束（低，但影响覆盖率口径）

**现状**：Go 有平台后缀（`_linux.go` / `_windows.go` / `_darwin.go`）
和测试后缀（`_test.go`）。现在**完全没处理**。

**要做的**：
- 识别 `_test.go` → 归类为**测试文件**，不参与模块依赖边
  （对照 `src/core/arch/test-files.ts` 现有的测试文件识别逻辑）
- 平台后缀（`_linux.go` 等）→ 决定**该文件在哪些平台参与构建**。
  同一个包在不同平台可能有不同实现 → 依赖边要按「所有平台都成立」算，
  否则会误报环。

**注意**：这一条**只影响覆盖率口径与依赖边的精度**，不影响依赖关系本身。
所以它**不应该改变现有模块图的连通性判定**——除非确实存在平台专属的实现分歧。

**测试**：`_test.go` 不产生依赖边；`_linux.go` 与 `_windows.go` 同包不误报环。

---

## 遗留 3：Rust 的 `super::` / `self::` 层级解析（低，判不准时漏边）

**现状**：`classifyRustSpecifier()`（imports.ts:638）把 `super::` / `self::`
归类为 `relative`，但 **`resolveRustImport()`（scan.ts:444）只处理 `crate::`**：

```ts
// scan.ts:464
if (!specifier.startsWith('crate::')) return null;   // ← super:: / self:: 直接漏掉
```

**要做的**：实现 `super::` / `self::` 的层级解析：
- `self::sibling` → **当前文件所在模块**下的 `sibling`
  （`src/foo/mod.rs` 里的 `self::bar` → `src/foo/bar.rs`）
- `super::parent` → **上一级模块**
  （`src/foo/bar.rs` 里的 `super::baz` → `src/foo/baz.rs`）
- Rust 的模块层级 ≠ 目录层级：`mod.rs` 代表目录，`foo.rs` + `foo/` 是同一模块的两种布局，
  两种都要认

**注意**：这是**漏边**类缺陷（少报边），不会误报。但漏边会让真实的架构违规
（「A 依赖 B，B 又依赖 A」）被放过 —— 所以值得修。

**测试**：`self::` / `super::` 各至少一条；两种布局（`foo.rs` vs `foo/mod.rs`）都要覆盖。

---

## 遗留 4：「静默失败」防线只覆盖了 policy 编辑路径（严重）

**这是 5 条里唯一还在持续产生新病灶的**，其余 4 条是特定语言的解析盲区，
影响面局限。

**现状**：ADR-070 为 policy 编辑路径建了防线 ——
`src/core/policy/section-editor.ts` 提供 `hasSection()` / `findSectionEntry()`，
调用方**先确认段/条目在**，再动手。

但**其它「写文件然后报告成功」的路径没有同构防线**。
典型例子（D-31 的原始病灶）：

```ts
// section-editor.ts:291 —— 找不到就原样返回
export function removeSectionEntry(...): string {
  const entry = findSectionEntry(yaml, section, keyName, id);
  if (!entry) return yaml;        // ← 文件没变，但调用方照样 return success: true
  ...
}
```

**要做的**（这是本次的核心任务）：
1. **盘点**：全仓搜索「写文件 + 报告成功」的路径，列出清单。
   重点看 `src/cli/commands/` 下所有改状态文件的命令：
   `set` / `patch` / `plan patch` / `design patch` / `config` / `slice spec` 等。
2. **提取原语**：在 `src/core/` 下建一个统一的写入口
   （建议 `src/core/io/atomic-write.ts`），它保证：
   - **写完必须验证**（读回来比对，或用「预期内容 + 实际内容」断言）
   - **写失败必须抛错**，不吞异常
   - **写成功必须有可核对的凭据**（返回值带 hash / 字节数）
3. **接入**：把盘点出来的路径逐个切到新原语上。
4. **对每条路径加一条回归测试**：
   「文件没被改动时，命令必须报错退出码 ≠ 0，而不是报告成功」

**这是唯一一条需要改 `core/` 公共接口的** —— 注意 C2（core 零第三方依赖）、
C3（纯计算/文件读写，不触网不调模型）、C6（core 不 import adapters/）。

**强烈建议写 ADR**（**ADR-082 或更后**，编号开工前再确认）：这是契约层面的改动，
影响其他切片与已有实现。

**关键判据**（沿用 D-31 的教训）：
> 「报告成功」必须能被**独立证据**复核 —— 读回文件比对内容，
> 而不是「我调用了 writeFileSync 所以成功了」。

---

## 遗留 5：合并清理报错措辞（低）

**现状**：`src/cli/commands/merge-runner.ts` 的 `cleanupMergedSlices()`
（约 596–638 行）已经**修正过一次**（D-40），现在的判据是对的：

```ts
const merged = upstream
  ? isMergedIntoRef(sliceBranch, `refs/heads/${upstream}`, dir)
  : isMergedIntoHead(sliceBranch, dir);

if (!merged) {
  console.log(`  ℹ️  Could not delete branch "${sliceBranch}": it still has changes not merged into ${upstream ?? 'HEAD'}.`);
```

但**两处措辞仍然混着两种情况**：

1. **判据没过**（`!merged`）vs **git 拒绝删**（catch 分支）：
   - 前者是「分支上还有未合入的内容」—— **真需要人处理**
   - 后者是「git 说不行，但原因不明」—— 可能是 worktree 还占着、可能被别的进程锁住
   现在两者的提示长得几乎一样，人分不出「要我去合」还是「要我去查锁」。

2. **措辞本身**：`it still has changes not merged into X` 这个描述在
   **版本分支场景**下不准确 —— 分支**已经**合进 `version/vN` 了，
   只是判据查的是别的地方。这时应该说「已合入目标分支，但删不掉」，
   而不是「还有未合入的内容」（后者是假话，正是 D-62/D-63 那个形态）。

**要做的**：
- 把两种失败**分开措辞**：
  - 判据没过 → 「分支 `<name>` 上还有未合入 `<target>` 的内容 —— 先合，或确认后手动 `git branch -D`」
  - git 拒绝 → 「分支已合入 `<target>`，但 git 拒绝删除（原因：<git 原话>）—— 通常是 worktree 还没释放；确认后手动 `git branch -D`」
- 中文输出与英文输出**都要改**（现在两条提示是英文的，而项目其它地方是中文）。

**测试**：两条路径各一条用例，断言提示文本能区分。

---

## 通用要求

### 硬约束（C1–C9，永远不破）

- `core/` 零第三方运行时依赖（只用 Node 内置）
- `core/` 不得 import `adapters/`
- `core/policy/`、`core/gate/`、`core/sched/` 不调模型、不触网
- 状态只落在文件里
- 判定必须确定性
- 每个动作写 append-only 事件
- 写集预约运行时强制

### 开发 zelto 自身时（AGENTS.md 例外条款）

这 5 条**不强制走切片流程** —— 可以直接改代码，
但必须：**跑通测试、lint 通过**。

改契约（schema / 事件类型 / 配置格式 / core 公共接口）**仍要写 ADR**。

### 测试纪律

- 单元测试：`npm test`（**注意**：`npm test` 现在会自己构建 `dist/`，
  见 ADR-080；并发跑 `npm run build` 和 `npm test` 会打掉 `dist/`）
- 格式与 lint：`npm run lint`（biome）
- 编码：`npm run check:encoding`
- **每修一条，必须去 nimrtc-zelto 上复验一遍**（真实项目）

### 提交规范

Conventional Commits + `Refs-Slice: <id>` trailer。

缺陷编号：演练记录里 D-73 / D-74 已用，**D-75 起可用**。
但 `git log --all --oneline | grep "D-7"` 里只有 D-70 / D-71 / D-73 / D-74，
**开工前再确认一次**（并行会话可能也在占号）。

ADR 编号：**ADR-081 已被并行会话占用**（`adr-081-dashboard-list-and-metrics-read-amplification.md`），
**ADR-082 起可用**。开工前 `ls docs/adr/ | grep adr-08` 再确认一次。

---

## 现场资料

| 位置 | 内容 |
|---|---|
| `D:\MyOpen\Zelto` | zelto 仓库本体 |
| `D:\MyOpen\nimrtc-zelto` | 真实项目（复验用） |
| `D:\MyOpen\Zelto\docs\zelto-实战演练记录-20261116.md` | 演练全过程 + 缺陷目录 |
| `D:\MyOpen\Zelto\docs\adr\` | 现有 ADR（ADR-069 依赖解析 / ADR-070 静默失败 / ADR-080 构建） |

**注意**：`D:\MyOpen\Zelto` 里可能有**并行会话**在跑 ADR-080
（`scripts/build.mjs` / `build-lock.mjs` / `test.mjs` / `docs/adr/adr-080-*.md`）。
开工前先 `git status` 看清楚，**不要覆盖别人的在途改动**。
`npm test` 期间不要并发跑 `npm run build`（会互相打掉 `dist/`）。
