# ADR-077：清理含 submodule 的 worktree 必须用 `--force` —— 判据落在 `.gitmodules` 上

**状态**：实施
**日期**：2026-11-18
**相关**：ADR-044（submodule 同步）、ADR-056（版本工作目录）、ADR-067/D-65（worktree remove 重试）、D6-C（tag 与分支是追溯锚点）

## 背景

`zelto version cleanup <label>` 报：

```
移除版本工作目录失败: .zelto\version-worktrees\v5:
fatal: working trees containing submodules cannot be moved or removed
```

实测（nimrtc-zelto v5，2026-11-18）。git 版本 2.49.0.windows.1。

git **硬拒**移除含 submodule 的 worktree —— 子模块的 gitlink 归属与
worktree 生命周期冲突，git 不愿替你收拾。人只能自己去敲
`git worktree remove --force`。

zelto 之前把「`--force` 只在使用者显式要求时才加」当成了一条洁癖规则，
结果**清理一个工作目录**被「里面有 submodule」这种纯技术细节卡住。

## 关键实测

用最小仓库（主仓 + 一个本地 submodule）逐一验证：

| 做法 | 结果 |
|------|------|
| `git worktree remove <wt>`（worktree 含 submodule） | ❌ `fatal: working trees containing submodules cannot be moved or removed` |
| 先 `git submodule deinit -f --all`，再 `git worktree remove <wt>` | ❌ **仍然硬拒** |
| `git worktree remove --force <wt>` | ✅ 成功 |

`deinit` **不解这个问题** —— git 的硬拒看的是 submodule 的**登记**
（`.git/modules/` 与 index 里的 gitlink），不是工作区里有没有内容。
清空工作区后登记还在，于是照旧硬拒。

`--force` 成功之后，后果也是干净的：

- worktree 目录被删掉
- git 侧的 worktree 登记被清掉（`.git/worktrees/` 消失）
- **分支保留**（`refs/heads/<branch>` 还在）
- **主仓的 submodule 完全不受影响**：`.gitmodules` 一字未改、
  submodule 的工作区内容还在、主仓 `git status` 干净
- `.git/modules/` 里的 submodule 仓库（objects）保留 —— 别的 worktree
  还要用

## 决策

### 判据：`worktree 自己有没有 .gitmodules`

`needsForceForSubmodules(worktreePath)` = `existsSync(worktreePath + '/.gitmodules')`。

为什么不用其它判据：

- **不用「主仓有没有 submodule」**：主仓有不等于这个 worktree 有 ——
  worktree 检出的是某个 commit，那个 commit 可能还没有 submodule。
- **不用「目录里有没有 submodule 工作区」**：submodule 可能没初始化
  （目录是空的），但 `.gitmodules` 仍在 —— 而 git 的硬拒看的是登记，
  不是工作区内容。判据必须落在**登记**上。
- **不用「`.git/modules/` 下有没有东西」**：那是**主仓共享**的
  submodule 仓库目录，任何一个 worktree 用过就一直在 ——
  用它当判据会让**所有** worktree 都被判成「含 submodule」，
  等于无条件 `--force`。

`.gitmodules` 存在 = 该 commit 登记了至少一个 submodule = git 会硬拒。
这是与 git 判据**严格对齐**的检查。

### 行为：自动加 `--force`，不要求人显式要求

`removeVersionWorktree()` / `remove()` 里：

```
if (options.force || this.needsForceForSubmodules(target)) args.push('--force');
```

理由：

- **清理工作目录不是危险操作**。它的语义是「这个工作目录不要了」——
  里面的内容（包括 submodule 的工作区）本来就要随它一起消失。
- **人显式要求 `--force` 的场景是「有未提交改动我也认了」**。
  submodule 那条拒绝跟「未提交改动」不是一回事 ——
  它是 git 的技术洁癖，不是「数据可能丢失」的警告。
- 让人记住「有 submodule 的仓库要加 `--force`」是把 git 的实现细节
  泄漏成人的负担。而且 `--force` 在这里**不丢任何东西** ——
  实测证明主仓的 submodule 登记与内容都不受影响。

不加 `--force` 时的行为保持不变（不越权）：无 submodule 的 worktree
不会被擅自加 `--force`。

### 不用 `deinit` 方案

`git submodule deinit -f --all` 看着像正解，实测证明它**不解这个问题**
（见上表）。而且它有额外代价：会清空 submodule 的工作区内容 ——
虽然那些内容反正也要随 worktree 一起消失，但多一步就多一个
「万一失败留下半吊子状态」的面。既然 `--force` 一条命令就够且后果已验证，
就不引入 `deinit`。

## 影响面

- `src/core/worktree/manager.ts`
  - 新增 `needsForceForSubmodules(worktreePath): boolean`
  - `removeVersionWorktree()` 与 `remove()` 按判据自动加 `--force`
- `tests/d72-worktree-submodule-cleanup.test.ts` —— 5 条用例（新增）

## 不变量核查

- **C1**（状态只在文件里）：无影响 —— 只改了 git 命令的参数。
- **C2**（core 零第三方依赖）：无影响 —— 只用 Node 内置的 `existsSync`。
- **C3**（判定确定性）：`existsSync(.gitmodules)` 是纯文件系统判定，
  同一棵树上结果恒定。
- **C4**（append-only 事件流）：无影响 —— cleanup 本来就不写事件。
- **C5**（保护域外部化）：无影响。
- **C9**（写集预约运行时强制）：无影响 —— 本改动只影响**清理**路径，
  不放宽任何写判定。
- **D6-C**（分支与 tag 是追溯锚点）：**加强** —— 实测确认 `--force`
  移除**不删分支**，锚点仍在。

## 遗留

无。（若未来 git 改变这条硬拒语义，判据 `.gitmodules` 仍然成立：
有登记就会被拒。）
