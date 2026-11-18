# ADR-085：发布流水线的发布状态提交要能写回主干

**状态**：实施
**日期**：2026-11-18
**相关**：ADR-078（版本 tag 记录取自 git 事实）、D-63（文档与现实不一致）、
D-73（发布状态的真源）、`release-status.json`

## 背景

zelto 0.6.0 是第一次真正发布到 npm。发布本身**成功**了，但紧接着暴露了
发布流水线里的两个真 bug —— 而它们凑在一起的后果是：

> **包已经在 npm 上了，但仓库里的 `release-status.json` 还写着 `published: false`。**

而 `release-status.json` 是发布状态的**真源**（D-73），README 与 CHANGELOG 的
发布措辞都以它为准。于是发布流水线「成功」跑完了，文档却仍然说「尚未发布到 npm」
—— 跟 D-63 是同一个形状：**声明与现实不一致，而文档是错的那个。**

### 现象

流水线日志：

```
publish  更新发布状态并提交  fatal: unable to access 'https://github.com/NimRTC/zelto/':
                                The requested URL returned error: 403
publish  更新发布状态并提交  ⚠️  推送失败 —— 请手动把 published 置为 true
```

注意那行 `|| echo "⚠️ 推送失败"` —— **推送失败被吞掉了，流水线仍然 exit 0**。
所以从流水线的视角看，这次发布「全绿」；从仓库的视角看，`published` 还是 `false`。

### 两个根因

**根因 A：workflow 没有写权限。**

```yaml
permissions:
  contents: read      # ← 只读
  id-token: write
```

`contents: read` 意味着 GITHUB_TOKEN 不能推任何东西。而那一步的**设计意图**
就是提交 `release-status.json` 回去 —— 权限和设计直接矛盾。

**根因 B：tag 触发时 checkout 出来是 detached HEAD。**

`push: tags` 触发时，`actions/checkout` 把工作区检出到 tag 指向的 commit，
处于 detached HEAD 状态 —— 没有分支可推。即使给了写权限，`git push` 也会以
`fatal: You are not currently on a branch` 失败。

而且这里还藏着一个更隐蔽的问题：**即使修好了 A 和 B，用 detached HEAD 的
commit 当基仍然可能是非快进推送** —— tag 打完之后 `main` 又前进了的话，
`git push origin HEAD:main` 会被拒。所以基必须是**远端分支的尖端**，
不是 tag 的 commit。

## 决策

### 1. `contents: write`

```yaml
permissions:
  contents: write
  id-token: write
```

`id-token: write`（npm provenance）保留原样。

### 2. 提交落到目标分支，且以远端尖端为基

```bash
BRANCH="${GITHUB_REF_TYPE == 'tag' && echo main || echo ${GITHUB_REF_NAME}}"
git fetch --no-tags origin "$BRANCH"
git checkout -B "$BRANCH" "origin/$BRANCH"
git add release-status.json
git commit -m "chore(release): 标记 v${PKG} 已发布到 npm" || echo "（无改动，跳过）"
git push origin "HEAD:${BRANCH}" || {
  echo "::error::推送 release-status.json 失败 —— published 状态需手动置为 true"
  exit 1
}
```

三个要点：

- **`fetch` + `origin/$BRANCH` 为基** —— 保证快进，不被 tag 之后的提交卡住。
- **`--no-tags`** —— 避免把所有 tag 拉下来（`fetch-depth: 0` 已经拉过 tag 了，
  这里再拉一次是浪费，而且 `git fetch origin main` 默认会带 tag）。
- **推送失败 → exit 1** —— 不再吞掉。**发布状态没写回去，发布就不算完成。**

### 3. 推不上去就不算成功

这是本 ADR 最核心的一条。之前那行 `|| echo "⚠️ 推送失败"` 让流水线在
「包发出去了但状态没落盘」的情况下仍然报绿 —— 那是在**撒谎**。

现在推送失败会让整条流水线红。这符合 C4（事件/状态必须落盘且可审计）
在发布场景下的延伸：**状态没落盘 = 事情没做完。**

## 为什么不在流水线外手动补

也可以手动改 `release-status.json` 然后 commit。但那治不了下次的发布 ——
下次照样 403、照样 detached HEAD、照样绿灯撒谎。**修流水线，不修这一次。**

## 影响

- **发布状态会真正自动落盘** —— 从此 README / CHANGELOG 不需要人工同步发布状态。
- **发布失败会更容易被发现** —— 这是有意的。之前是「绿但状态没落盘」，
  现在是「红，且明确告诉你 published 需要手动置 true」。
- **第一次发布 0.6.0 的状态是手工补的** —— 因为这个 bug 是在这次发布中
  才发现的，改 workflow 已经晚于那次发布。后续版本不再有这个窗口。

## 验证

- `permissions` 改为 `contents: write`。
- `git checkout -B "$BRANCH" "origin/$BRANCH"` 在 tag 触发路径下可执行。
- `git push origin "HEAD:${BRANCH}"` 失败时 `exit 1`。
- 下一个版本发布时 `release-status.json` 应由流水线自动提交，
  且 `published: true` / `npmVersion` 与实际发布版本一致。
