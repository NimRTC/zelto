# ADR-047：worktree 里的 submodule 必须对齐到主仓记录的指针

- 状态：已接受
- 日期：2026-11-11
- 决策者：zelto（维护者）
- 影响范围：`src/core/worktree/manager.ts`

## 背景

ADR-044 让 worktree 创建时自动初始化 submodule。但初始化本身会引入一个新的
**假阳性越界**：worktree 里 submodule 检出的 commit 与主仓记录的不一致，
`git status` 报 `M src/third_party/xxx`，审计把它算成「agent 越界改了 vendor」。

agent 根本没碰它 —— 那差异是 zelto 自己同步 submodule 时带进来的。

## 现场

nimrtc-zelto 的 `v1-exception-handling` 切片（2026-11-11）第二轮运行结束时，
zelto 报：

```
Slice "v1-exception-handling" 写集越界 — 未进 gate
  - src/third_party/libopus/src（不在写集内）
  - tests/acceptance/v1-exception-handling/acceptance.test.cjs（zelto 托管的文件被改动 — 门禁可能已被绕过）
切片已退回 frozen：扩写集后重跑 zelto run v1-exception-handling
```

两条都是误报。第二条是 ADR-046 引入的（验收骨架进了写集，
但 `zeltoOwnedPaths` 还把它当成「zelto 托管的文件」），第一条是本 ADR 要解决的。

### 第一条的具体成因

主仓 `src/third_party/libopus/src` 的状态：

| 位置 | commit |
|---|---|
| 主仓 index 记录的 gitlink | `22244de5`（v1.6.1） |
| 主仓工作区里 submodule 实际检出 | `22244de5`（一致） |
| **ADR-044 实现克隆的源** | `a8b2545e`（heads/main） |

第三行是错的。ADR-044 的实现把克隆源指向
`<主仓>/.git/modules/<name>/` —— 那是 git 的**标准共享布局**。
但 nimrtc-zelto 的 libopus 用的是**独立嵌套克隆**：`<主仓>/<path>/.git`
是一个**目录**，不是指向 `.git/modules/` 的文件。

于是：

1. `<主仓>/.git/modules/src/third_party/libopus/src` **不存在** →
   ADR-044 把它记为 `skipped`；
2. worktree 里那个目录要么是空的，要么内容来自别处；
3. 即使内容在，commit 也是从别处来的，不是主仓记录的那个。

## 决策

**同步 submodule 之后，把每个 submodule 显式检出到 worktree index 里记录的指针。**

分两步：

### 第一步：找对克隆源（ADR-044 的补正）

`syncSubmodules` 找克隆源时按优先级找三处：

1. `<主仓>/<path>/.git` 是**目录** → 独立嵌套克隆，就用它自己；
2. `<主仓>/.git/modules/<name>/` → git 的标准共享布局（按 name）；
3. `<主仓>/.git/modules/<path>/` → 兜底（历史上有工具按 path 放）。

第 1 和第 2/3 种布局是**互斥**的：`.git` 指向 module git 目录时，
module git 目录就在 `.git/modules/` 下；`.git` 本身就是目录时，
`.git/modules/` 下**没有**对应目录。原来只找 2/3，独立嵌套克隆就漏了。

### 第二步：检出到记录的指针

`alignSubmodulesToMainRepo` 遍历所有 submodule：

1. 从 **worktree 自己的 index** 读出 gitlink 记的 commit（`git ls-files -s`）；
   worktree 是从主仓同一个 commit 建出来的，所以它 index 里记的
   就是主仓要的那一个 —— 比「主仓工作区当前在哪个 commit」更准
   （主仓工作区可能被人工切过）；
2. 读 worktree 里那个 submodule 当前实际的 HEAD；
3. 不一致就 `git checkout --force <记录的 commit>`。

### 为什么不能靠 `git submodule update` 自己搞定

`git submodule update --init` 的语义本来就是「检出到 index 里记录的 commit」。
问题出在**克隆那一步**：当克隆源是共享 module git 目录时，
`git clone <该目录>` 会把**该目录当前的 HEAD** 克隆成新仓库的 HEAD。
共享目录的 HEAD 会被别的操作改过（nimrtc-zelto 上就是 `a8b2545e`）。

显式检出把结果钉死在「index 记的指针」上，不依赖任何目录的 HEAD 状态。

## 后果

- **正面**：worktree 里 submodule 的 commit 与主仓记录**逐个一致**，
  `git status` 对 `src/third_party/**` 干净，审计不会把 zelto 自己的
  同步动作算成 agent 越界。
- **正面**：独立嵌套克隆的工程（`.git` 是目录的那种）也能正确同步，
  不再被记为 `skipped`。
- **代价**：多一次 `git checkout --force` per submodule（毫秒级）。
- **代价**：检出失败时**不静默** —— 留在原处，`git status` 会显示差异，
  审计会报出来。宁可是误报，也不要静默放过。

## 验证

nimrtc-zelto 上实测：新建 worktree 后 7 个 submodule 全部初始化成功
（`initialized` 7 个、`skipped` 0 个），且 `git status --short src/third_party/`
**为空** —— 与主仓零漂移。

## 关联

- ADR-044：隔离 worktree 必须初始化 git submodule
- ADR-046：验收骨架必须进写集
