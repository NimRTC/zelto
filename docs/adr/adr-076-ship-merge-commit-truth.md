# ADR-076：ship 的 mergeCommit 必须是「本次合并产生的」—— 空操作时记 null

**状态**：实施
**日期**：2026-11-18
**相关**：ADR-056（版本分支）、ADR-071（空操作合并）、D-63（ship 事件说真话）、D-70（分叉诊断）

---

## 背景

`zelto version ship` 把版本分支合入主仓当前分支，然后在合入目标上打 tag、
写 `version.delivered` 事件。

合并有两种结果：

1. **产生了新提交** —— 正常情况；
2. **没产生新提交（空操作）** —— `git merge` 报 "Already up to date"，
   HEAD 一动不动。ADR-071 引入的空操作路径就是为这种情况准备的
   （切片的产物已经被带进目标分支，不必再合一次）。

**问题**：ship 的事件与 tag 记的 `mergeCommit` 是 `rev-parse HEAD` ——
**不管这次合并有没有动过 HEAD**。

---

## 病灶（实测 nimrtc-zelto，2026-11-17）

```
v4 delivered at 22:27:04  mergeCommit=5e6e0abc  （Ship version version/v4）
v1 delivered at 22:35:26  mergeCommit=5e6e0abc  ← 同一个提交！
```

v1 的 ship 走的是**空操作**路径（它的产物早已在分支上了），
所以 HEAD 没有动，停在 v4 ship 留下的 5e6e0abc。

于是：

- tag `v1` 和 tag `v4` 指向**同一个提交**；
- `git merge-base --is-ancestor v1 main` 返回假 ——
  追溯链说「v1 在主干里」，git 说没在；
- 人查「v1 到底合到哪了」，得到一个**别的版本**的提交号。

**假完成比不完成更坏** —— 它让人以为可以往下走。

C4 说「事件是追溯的唯一证据载体」。这里事件说了假话，
而 git 说了真话 —— **两个证据打架，人只能靠猜**。

---

## 决策

### D1：mergeCommit 只在**本次合并真的产生了提交**时才有值

合并前后 HEAD 没变 → 空操作 → `mergeCommit` 记 **null**。

事件里 `mergeCommit: null` 是**真话**；
写一个别人的提交是假话。

### D2：tag 的锚点按「产生了提交 / 空操作」分两种

tag 的语义（D6-C）是「**这个版本整体长什么样**」的不可变锚点。

- **产生了新提交** → 钉在那个新提交上（它只属于这一版）。
- **空操作** → 钉在**版本分支的 tip**（`version/vN`）上。

为什么不是目标分支当前位置（HEAD）：
HEAD 可能是**别的版本** ship 留下的提交 —— 那正是 v1 的病灶。
版本分支的 tip 是这一版的产物汇聚点，**每个版本各不相同**，
内容正好是「这一版整体长什么样」。

### D3：版本分支内容不在目标分支上时**不打 tag**

没有诚实的锚点就不打 —— 打一个指向别的提交的 tag 比没有 tag 更坏：
`git merge-base --is-ancestor <tag> main` 会说假话。

### D4：事件增加两个字段

| 字段 | 含义 |
|------|------|
| `anchorCommit` | tag 打在哪个提交上（空操作时 = 版本分支 tip） |
| `noop` | 本次合并是空操作（没产生新提交） |

`mergeCommit` 的语义因此更明确了：**「本次 ship 产生的提交」**，
而不是「合入后 HEAD 在哪」。

---

## 影响

| 文件 | 改动 |
|------|------|
| `src/cli/commands/version-ship.ts` | `shipBranch` 返回 `anchorCommit` / `noop` / `mergeCommitProduced`；tag 与事件改用锚点 |
| `tests/d71-noop-merge-commit-truth.test.ts` | 6 条用例（新增） |
事件契约变化（`version.delivered` payload 增字段）→ 按 AGENTS.md 的要求记录此 ADR。

---

## 验证

- 空操作合并 → `mergeCommit` 是 `null`，`noop` 是 `true`；
- 空操作合并 → tag 打在版本分支 tip 上，与别的版本不撞车；
- 正常合并 → `mergeCommit` 仍是那个新提交（不能被改坏）；
- 两次连续 ship → 第二个不能把第一个的提交记成自己的。
