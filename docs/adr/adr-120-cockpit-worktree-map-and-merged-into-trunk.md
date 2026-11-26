# ADR-120 驾驶舱执行目录脉络：列出所有工作区、标出「已并入主干」、版本行按计划补片

- 状态：已采纳
- 日期：2026-11-26
- 关联：ADR-056（版本分支）、ADR-112（驾驶舱按根扫描）、ADR-114（分支可见性）

## 背景

驾驶舱（`zelto web`）在 ADR-112 之后能看见「仓库根 + 每个
`.zelto/version-worktrees/<label>/`」，但看不清**同一个仓库在盘上有几份检出**。
实测 nimrtc-v14（2026-11-26）盘上同时躺着：

```
D:/MyOpen/nimrtc-v14                       ← 仓库根（人在的地方，feat/v14-turn-tls）
D:/MyOpen/_wt_v14_docs                     ← git 额外工作区（不是 zelto 建的）
.zelto/version-worktrees/v1..v4            ← 版本集成目录
.zelto/worktrees/<sliceId>/                ← 切片执行目录（zelto run 建的）
```

人在 `_wt_v14_*` 里做的改动，驾驶舱一个字也不提；四条版本战线一视同仁地列出来，
人会把「4 条版本战线」读成「4 个版本在并行」，而真实在飞的只有 v4；
v4 的三条冻结切片状态落在仓库根（label 未改），`scope|label` 分组里 v4 一行都落不到，
版本行显示「0 片」，与计划里的三片对不上。

## 决策

**一、`discoverWorktrees`（`src/core/project/worktree-map.ts`）把工作区分成四类**：

| 种类 | 判据 | label |
|---|---|---|
| `root` | 仓库根（`zelto web` 的 cwd） | null |
| `version` | `.zelto/version-worktrees/<label>/` 存在且有 `.zelto` 状态 | 版本 label |
| `slice` | `.zelto/worktrees/<sliceId>/` 目录存在（`zelto run` 建的） | 切片 id |
| `extra` | `git worktree list --porcelain` 里、不属于上面两类、也不在 `.zelto/` 底下 | null |

切片执行目录里的 `.zelto/slices/` 是**基线快照**，不当状态用；它的状态按 id
从它真正的根借来（ADR-112 决策三：读可以合并，写不能含糊）。

**二、`mergedIntoTrunk`（只对 `version` 有意义）是一个 git 事实**：
HEAD 是主干 HEAD 的祖先（`git merge-base --is-ancestor`）。
主干锚点：本地 `main`/`master`，再退到远端 `origin|ghssh|github/main(master)`
—— 实测 nimrtc-v14 没有本地 main（人在 `feat/v14-turn-tls` 上开发），
只认本地 refs 会一条都判不出。问不出来 = `null`（不知道），不许说成「未合并」。
**它不是版本交付状态判定**（那归 `zelto version status`）。

**三、版本目录没有登记成 git worktree 时，就地探测**：
`git worktree list` 里没有的 `.zelto/version-worktrees/<label>/`（普通检出目录），
仍用 `symbolic-ref` + `rev-parse` 问出分支 / HEAD。实测 v3 的工作区
建完、合完就被 `worktree remove` 了，状态目录留在主干检出里 —— 不探测就永远「不知道」。

**四、版本行的切片按计划补齐**：版本目录自己的 `.zelto/slices/` 是基线快照
（实测 v4 只有 v0/v1 三片），而 v4 真正要跑的三片状态在仓库根（label 未改）。
`/api/worktrees` 把计划（`.zelto/versions/*.json` 的 `versions[].slices[].id`）
点名的切片按 id 补进这条版本战线（已在 `scope|label` 分组里的不重复）。

**五、git 调用纪律**：`discoverWorktrees` 只做**同步** git 调用，且只在
「工作区数量 × 一次祖先判定」这个量级；`readGitWorktrees`（一次
`worktree list --porcelain`）用**异步 spawn**，避免卡住事件循环（ADR-114 的教训）。

## 影响

- 驾驶舱总览 / 切片页多一节「执行目录脉络」：种类、路径、分支 / HEAD、本目录状态、
  本片位置、状态分布；版本战线带「已并入主干 / 有未合并提交」标记。
- `/api/worktrees` 返回 `mergedIntoTrunk` 与按计划补片的版本行；无 git 事实时全为 `null`。
- `readGitWorktrees` 从 `core/project/branch-evidence.ts` 搬到 `core/project/worktree-map.ts`
  （它属于「执行目录脉络」的事实来源；`core/project/index.ts` 继续导出，调用方不变）。
- 纯事实呈现：不改任何判定、不写任何状态文件（C3、C1 不变）。
