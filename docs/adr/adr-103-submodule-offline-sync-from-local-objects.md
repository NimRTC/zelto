# ADR-103: 子模块同步 —— 「本地有 objects 就离线同步」，而不是「主仓工作树没了就跳过」

**状态**: 已实现（2026-11-23）
**日期**: 2026-11-23
**作者**: 系统架构
**关联约束**: C1, C2, C3, C4
**关联文档**: `docs/adr-044-submodule-init.md`,
`docs/adr-047-submodule-align-to-main-repo.md`,
`docs/adr-095-worktree-build-prerequisites.md`,
`docs/实战缺陷记录-nimrtc-v14.md`

---

## 1. 摘要

zelto 建 worktree 时同步子模块。旧判据是「主仓里那个 submodule 的**工作树**
没了 → 跳过」，留下一个**空 vendor 目录**，门禁②的 build 阶段才炸
（报错是「找不到头文件」，跟真正的原因毫无关系）。

实测证明：**删掉工作树并不影响对象库** —— objects 一直都在
`.git/modules/<name>/objects/` 里。

本 ADR 把判据改成：**本地有 objects 就离线同步**（不触网），
**真的一无所有才跳过**（并留痕）。

同时修掉一个配套的定位 bug：子模块的 git 目录**不能**假设在
`<repoRoot>/.git/modules/` —— 在**版本工作目录**里，`.git` 是**文件**
（`gitdir: <common>/.git/worktrees/<name>`），那个路径压根不存在。

---

## 2. 动机

### 2.1 现场 A：版本工作目录里的子模块整个没同步（ZD-0xx，2026-11-23）

在版本工作目录（`.zelto/version-worktrees/v3`）里跑 `zelto run` 时：

- `repoRoot` 是一个**链接 worktree**，它的 `.git` 是**文件**；
- 于是「子模块的 git 目录 = `<repoRoot>/.git/modules/...`」这条老路径
  **不存在** → `syncSubmodules` 静默跳过全部 14 个子模块；
- 随后 `alignSubmodulesToMainRepo` 在**空目录**里跑 `git cat-file -e` →
  git **向上**找到顶层仓库 → 报「没有 commit ac01707f」——
  而那个 commit **确实存在**在子模块自己的对象库里。

于是：worktree 建出来是**坏的**，报错指向一个**存在的** commit。

### 2.2 现场 B：旧判据的前提是错的

`tests/core/worktree/manager.test.ts` 里有一条老用例：
「skips submodules that are not populated in the main repo (no network fetch)」，
理由写着「删掉主仓里的 submodule 工作树 —— 它不再是『本地已有 objects』」。

**实测（2026-11-23）**：删掉工作树后，

- `.git/modules/vendor/lib/objects/` **还在**；
- `git cat-file -e <pinned>` 失败，但原因是
  `fatal: cannot chdir to '../../../../vendor/lib'` ——
  module git 目录里的 `core.worktree` 指向**被删掉**的工作树；
- 把 `GIT_WORK_TREE` 指到一个有效目录 → **同一个 commit 立刻答得对**。

所以「不再是本地已有 objects」这个前提**不成立**。
老用例的**意图**（不触网）是对的，但**结论**（跳过）比实际需要差一档。

---

## 3. 决策

### 3.1 判据改成「本地有没有 objects」

| 主仓里那个 submodule 的形态 | 处理 |
|---|---|
| `.git` 是**文件**（指向 module git 目录） | 离线同步 |
| `.git` 是**目录**（独立嵌套克隆） | 离线同步 |
| **没有** `.git`，但**有内容**（源码当普通文件提交） | 直接拷贝内容 |
| **没有** `.git`，**没有内容**，但**有 module git 目录** | **离线同步**（新） |
| **没有** `.git`，**没有内容**，**也没有** module git 目录 | 跳过 + **留痕**（新） |

### 3.2 module git 目录的定位：问 git 自己

不能假设 `<repoRoot>/.git/modules/`。新增三个探测（`src/core/worktree/manager.ts`）：

1. `gitCommonDir()` —— `git rev-parse --path-format=absolute --git-common-dir`。
   在链接 worktree 里它指向**共享**的 `.git`（子模块对象库在那儿）。
2. `gitDirOf(path)` —— `git rev-parse --path-format=absolute --absolute-git-dir`。
   worktree **自己**那个 git 目录（`.git/worktrees/<name>`）——
   它的 `modules/` 下住着**这个 worktree 专属**的子模块对象库。
3. `resolveGitLinkPointer(gitLink)` —— 读子模块工作树里那个 `.git` **文件**
   的 `gitdir:` 指针（相对路径按 `.git` 文件所在目录解析）。

找的顺序：`.git` 是目录 → `.git` 是文件（读指针）→
`<commonDir>/modules/` → `<gitDir>/modules/` → `<repoRoot>/.git/modules/`。

### 3.3 「在哪个目录里问 commit」也要分清

`git cat-file -e <sha>` 在哪个目录里跑，结果**完全不同**：

- module git 目录里有 `core.worktree`（**相对**路径）→
  git 会 chdir 到那个路径 → 路径不存在就**整条命令失败**；
- 空目录（没 `.git`）→ git **向上**找到顶层仓库 → 答的是**顶层仓库**的答案。

所以：设 `GIT_WORK_TREE` 指到一个**有效**目录
（`GIT_WORK_TREE` 会**覆盖** `core.worktree`），
问的对象库才有意义。

### 3.4 跳过时必须留痕（D-73）

「真的一无所有 → 跳过」这条路**必须**记进 `submoduleFailures`：
少了哪个 vendor、为什么少，是人唯一能据此修环境的线索。
不留痕的话，「vendor 没同步上」直到门禁报「找不到头文件」才显形。

---

## 4. 后果

### 4.1 正面

- worktree 里的 vendor **被填上**（离线、来自本地 objects），
  而不是留一个空目录让门禁②在几千行编译输出里报「找不到头文件」。
- 判据落在**对象库**上 —— 那才是「能不能离线检出」的真判据。
- 跳过时留痕 —— 「缺什么」当场可见。

### 4.2 需要接受的代价

- 同步会**多花时间**（原来跳过的现在要检出）。
  但那段时间本来就要在门禁②的 build 阶段以更贵的方式还回来。
- 同步可能**失败**（本地 objects 缺那个 commit）——
  那时记成 skipped + 留痕，不触网。

---

## 5. 判据的可测形式

`tests/core/worktree/manager.test.ts`：

1. 「populates submodules offline from local objects even when the main repo working tree is gone」
   —— 删掉主仓工作树 → **同步成功**，vendor 内容在（老用例的「跳过」被替换）。
2. 「skips a submodule whose local objects are genuinely gone (never touches the network）」
   —— 连 `.git/modules/...` 一起删 → 跳过 + **留痕**。
3. 原有 25 条全部保持通过。

---

## 6. 与 ADR-095 的关系

ADR-095 立的规矩是「本地缺 commit → **当场报错**，别静默」，
以及「生成物清单 → 产物重新生成」。

本 ADR 是它的**前置**：没有这一步，worktree 里的 vendor 干脆是空的，
连「缺 commit」的报错都发不出来（空目录里问 commit 会问错对象库）。

---

## 版本追溯

| 字段 | 值 |
| --- | --- |
| 所属版本号 | v0.7.0 |
| 关联 ADR 编号 | ADR-103 |
| 提交哈希 | e90949c3db9a9024024cb27bf56620bf05990286 |
| 验证方式 | [git show --stat e90949c3db9a9024024cb27bf56620bf05990286 抽查 + 人工复核] |
