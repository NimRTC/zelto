# ADR-088：标识符拼路径时不能逃出 base —— 两层防护

**状态**：实施
**日期**：2026-11-19
**相关**：ADR-072 §3（Web 端路径穿越）、ADR-014（运行时策略强制）、
ADR-056（版本分支与工作目录）、C1（状态只在文件里）

## 背景

zelto 到处把**标识符**拼进路径：

| 标识符 | 进哪 |
|---|---|
| 切片 id | `.zelto/slices/<id>.json` |
| | `specs/slices/<id>.md` |
| | `tests/acceptance/<id>/` |
| | `.zelto/worktrees/<id>/` |
| 版本 label | `.zelto/version-worktrees/<label>/` |

`join()` 会把 `..` **归一化掉**：

```
join('.zelto/worktrees', '../../evil')  →  '<repo>/evil'
join('.zelto/slices',    '../evil.json') →  '<repo>/.zelto/evil.json'
```

后果不是「目录建歪了」，而是**写与删落在仓库根之外**：
worktree 被建到仓库外，验收目录被建到仓库外，
而 `rmSync(dest, { recursive: true, force: true })` **会删到仓库外**。

### 之前为什么没出事

切片 id 在 CLI 入口有白名单（`/^[a-zA-Z0-9_-]+$/`），版本 label **没有** ——
同一个缺陷家族里唯一还开着口的地方。

但「CLI 入口有白名单」这个说法**只覆盖了一条路**：

- 标识符**从 LLM 产出读进来**（版本计划里的 label 与切片 id）
  —— 那条路**不经过命令行的白名单**；
- 标识符**从分支名反查**（`zelto merge --target version/<label>`）
  —— 那是从 git 的引用名反推的，更不受任何白名单约束。

也就是说：白名单在**入口**挡住了「人手敲错」，但挡不住「数据里带的」。

## 决策：两层防护，缺一不可

### 第 1 层：白名单 —— 在入口就说清「你该写什么」

- `core/slice/store.ts` 的 `checkSliceId` / `isValidSliceId`
- `core/version/branch.ts` 的 `checkVersionLabel` / `isValidVersionLabel`

**切片 id 不允许点，版本 label 允许** —— 因为版本 label 会进 **git 分支名**
与 **tag**（`v1.2.3` 这种带点的写法在 git 里完全合法且常见），
但 `.` 与 `..` 必须**单独拒掉**（它们在字符上合法，语义上是路径结构符号）。

白名单的**唯一实源放在 `core/`**，不是为了好看，而是因为：

> 从 LLM 产出或版本计划读进来的 id，**不经过 CLI**。
> 判据住在 `cli/` 的话，core 侧要么自己再写一份（口径漂移），
> 要么 import `cli/`（分层反过来）。两条都不行。

而 CLI 侧原来的白名单**散在三处**（`create` / `slice create` / `slice-detail`），
各写一份 —— 「什么算合法 id」不该有多个口径。

### 第 2 层：包含性 —— 即使白名单漏了，路径也逃不出去

`core/io/path-safe.ts` 的 `resolveWithin(base, identifier)`：

- 拼接用 `join`（保持 base 原本的形态，`/repo` 就还是 `/repo`）
- 判定用 `resolve`（归一化之后才谈得上「在不在里面」）
- 判据用 `relative` 而**不是字符串前缀** ——
  前缀判据会把 `C:\repo-evil` 误判成 `C:\repo` 的子目录
  （`'C:\repo-evil'.startsWith('C:\repo')` 为真）——
  这正是「看起来在 base 里、其实在隔壁目录」的经典形状

逃逸的两种形态都拦：

- `rel` 以 `..` 开头 → 真的出去了
- `rel` 是绝对路径 → 换了盘符/根（Windows 上 `relative` 跨盘返回绝对路径）

**逃逸时当场抛错**（`PathEscapeError`）—— 读不到就报错，
而不是去仓库根上找一个同名的文件。

### 两层的关系

第 2 层不依赖第 1 层，第 1 层也不依赖第 2 层 —— 这是有意的：

- 白名单给出**可操作的报错**（「label 只能是什么形状」）；
- 包含性给出**兜底的硬保证**（不管标识符从哪来，路径逃不出去）。

只有白名单会漏（数据来源可以绕过入口）；
只有包含性会让人看不懂（知道路径逃了，但不知道该写什么）。

## 影响面

### 新增

- `src/core/io/path-safe.ts` —— `resolveWithin` / `isWithin` / `PathEscapeError`
- `tests/path-escape-guard.test.ts` —— 两层防护的判据

### 修改

- `src/core/slice/store.ts` —— `checkSliceId` / `isValidSliceId`；
  `path()` 改用 `resolveWithin`；`exists()` 不再抛错
- `src/core/version/branch.ts` —— `checkVersionLabel` / `isValidVersionLabel`
- `src/core/worktree/manager.ts` —— `pathFor` / `versionPathFor` 改用 `resolveWithin`
- `src/cli/commands/shared.ts` —— `validateVersionLabelArg` / `validateSliceIdArg`
- `src/cli/commands/core-slice.ts` / `slice-detail.ts` —— 用 `checkSliceId` 取代各自的正则
- `src/cli/commands/version-adopt.ts` / `version-ship.ts` / `merge.ts` / `ai-pipeline.ts` ——
  版本 label 走 `validateVersionLabelArg`
- `src/cli/commands/ai-pipeline.ts` —— **计划确认前**校验计划里的 label 与切片 id

### 计划确认前的校验为什么重要

`zelto plan confirm` 是**人签字的时刻** —— 此刻拒掉，
比跑到 `version start` 才炸清楚得多。而且计划里的 id **可能来自 LLM 产出**，
那条路不经过命令行白名单。

报错要说清「哪个标识符不合法」，让人能直接改计划。

## 不变量核查

- **C1**（状态只在文件里）：**无影响** —— 本 ADR 只是加了两道路径判据。
- **C2**（core 零第三方依赖、不 import adapters）：**满足** ——
  `path-safe.ts` 只用 `node:path`。
- **C3**（判定确定性）：**加强** —— 路径逃逸是纯路径计算，不调模型、不触网。
- **C4**（append-only 事件流）：**无影响**。
- **C5**（保护域外部化）：**无影响** —— 保护域判定在策略引擎里，未动。
- **C9**（写集预约运行时强制）：**无影响**。

## 验收标准

1. ✅ `resolveWithin` 拦住 `..` 前缀与跨盘绝对路径两种逃逸形态；
2. ✅ 前缀判据的陷阱：`C:\repo-evil` 不被当成 `C:\repo` 的子目录；
3. ✅ 版本 label 白名单：允许 `v1.2.3`，拒绝 `..` / `.` / 含分隔符 / 空格；
4. ✅ `WorktreeManager.versionPathFor` —— 逃逸时抛错，**不建目录**；
5. ✅ `WorktreeManager.pathFor` —— 同样不逃逸；
6. ✅ `SliceStore` —— 切片文件路径不逃出 `.zelto/slices/`；
7. ✅ 谓词方法（`exists` / `versionExists`）—— 不抛错，返回 false；
8. ✅ 存量数据不受影响（真实项目里的 label 全都合法）；
9. ✅ `npm test` 全绿。

## 关联缺陷

- ADR-072 §3 只说了「路径参数过滤，不把 id 拼进文件路径前先校验」——
  但那一条只覆盖了 **Web 端的路径参数**，没覆盖
  「从 LLM 产出 / 从分支名反查」这两条路。本 ADR 补上。
- 与 ADR-086 / ADR-087 **无耦合** —— 这三条是独立的三件事，
  恰好在同一个工作区里。

## 参考

- `src/core/io/path-safe.ts`
- `tests/path-escape-guard.test.ts`
- ADR-072 §3（Web 端的路径参数过滤）
