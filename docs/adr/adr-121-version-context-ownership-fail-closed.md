# ADR-121：版本工作目录里的归属解析不许兜底合主干

**状态**：实施
**日期**：2026-11-26
**相关**：ADR-056（版本是一等分支）、ADR-067（单片基点跟版本分支）、ADR-033（不知道 ≠ 成立）、ADR-114（分支可见性）、C1、C3、C4、C9

## 背景

ADR-056 让版本成为 git 的一等分支：`version/<label>` + 集成目录 `.zelto/version-worktrees/<label>/`。切片从版本目录出发，产物也合回那里 —— 主干由 `zelto version ship` 显式合入。

**实测 nimrtc-v14（2026-11-26）发现这条链子是断的。**

`resolveSliceOwnership`（`core/version/branch.ts`）按四级回退解析「这片合进哪儿」：

1. `--target` 显式指定
2. 版本计划成员扫描 —— 读 `.zelto/versions/`
3. 规格 frontmatter 的 `version:` 字段
4. **兜底：合入主干当前分支**

第 2 级读的是**当前目录**下的 `.zelto/versions/`。而版本工作目录里的那个目录是**空的** —— 版本计划从不复制进 worktree：

```
$ dir .zelto/version-worktrees/{v1,v2,v3,v4}/.zelto/versions
（四个都是 0 个文件）
```

于是第 2 级落空、第 3 级也没写 `version:`，**第 4 级兜底生效**。

### 证据

事件流是铁证 —— 同一个计划里的切片，合并目标取决于「merge 从哪个目录跑的」：

| 切片 | merge 跑的目录 | `merge.planned` 的 `target` |
|---|---|---|
| `v1-device-policy` / `v1-audio-p2` / `v1-n5-turn-server` | 仓库根（那儿有计划文件） | `version/v1` ✅ |
| `v1-audio-device-engine` / `v1-call-state-surface` / `v1-ice-recovery` / `v1-install-tree-module-closure` / `v1-install-tree-video-deps` / `v1-macos-install-proof` / `v1-path-change-report` / `v1-sdk-sample` / `v1-turn-credentials` / `v1-turn-tls-trust` / `v1-video-render-engine` / `v6-writeset-slice-boundary` | v3 worktree（那儿计划是空的） | **`main`** ❌ |

**12 个切片走了兜底**（v3 worktree 的 `.zelto/events/` 里 `merge.completed` 且 `target=main` 的共 12 条）。

### 实际后果：**错的是「标签」，不是「落点」

这一点必须说清楚，否则会得出过头的结论。

兜底解析出的 `kind: 'main'` 会让 `resolveTarget(null)` 取 `dir = process.cwd()` —— 而 `process.cwd()` 就是**版本工作目录**，它检出的分支正是 `version/<label>`。所以：

- **落点其实是对的**：12 个切片的产物全都落在了 `version/v3` 分支上（实测 `git merge-base --is-ancestor` 全部为真）。
- **错的是事件里记的 `target`**：写的是 `main`，而实际分支是 `version/v3`。

实测印证（`nimrtc-v14`，2026-11-26）：

```
8abb815a  origin/main=False  version/v3=True  version/v1=False
85f142c9  origin/main=False  version/v3=True  version/v1=False
18775f73  origin/main=False  version/v3=True  version/v1=False
b4aa77ec  origin/main=False  version/v3=True  version/v1=False
657941be  origin/main=False  version/v3=True  version/v1=False
3529b44a  origin/main=False  version/v3=True  version/v1=False
c40dd463  origin/main=False  version/v3=True  version/v1=False
```

**所以主干并没有被污染** —— `origin/main` 上一个切片提交都没有。这一点比原判断乐观。

### 但它仍然是真缺陷，有三条独立的伤害

1. **事件流说谎**（C4 的追溯价值受损）。`merge.completed` 记 `target=main`，而分支是 `version/v3`。事后审计「这版做完了没有」时，按 `target` 查会得出「合进主干了」的假结论 —— 而事实上它在版本分支上。

2. **版本归属被跳过**。走兜底 = 跳过第 2 级「计划成员扫描」与第 3 级「规格 frontmatter」。计划里 **v1 的 10 个切片有 7 个从未被合进 `version/v1`**（实测：`version/v1` 只含 `v1-device-policy` / `v1-audio-p2` / `v1-n5-turn-server` 三片；`v1-ice-recovery` / `v1-turn-credentials` / `v1-sdk-sample` / `v1-path-change-report` / `v1-macos-install-proof` / `v1-install-tree-video-deps` / `v1-install-tree-module-closure` 七片只在 `version/v3` 上）。这七片在计划里属于 **v1**，却落在 **v3** 的分支上。

3. **版本状态同步被跳过**。走兜底时不合出版本状态更新（ADR-056 §3.3 的版本整合与 `version.integrated` 事件），并且绕过了 `version/v1` 这一层。

一句话：**代码没丢、落点没错，但「哪片属于哪一版」这条追溯链断了** —— 计划说 v1，分支说 v3，事件说 main。三方对不上。

### 为什么它特别坏

这个缺陷**不报错、不留痕、两边都说「正常」**：

- 事件流写 `target=main` —— 看起来合并成功了
- 计划里版本状态写 `integrated` —— 看起来这版做完了
- 代码确实在版本分支上 —— 产出没丢

但 `version/v1` 分支上**一个 `Merge slice` 提交都没有**（tip 停在 `628df8c9`，`origin/main...version/v1` = ahead 8 / behind 41）。

也就是说 ADR-056 的核心承诺 ——「切片产物合进**它所属版本**的分支，主干由 ship 显式合入」—— **被静默绕过了一部分**。「这一版做完了」这句话，在 `version/v1` 上没有分支依据。

## 决策

两处都改 —— 一处让解析**能成功**，一处让它**不许瞎猜**。

### 决策一：版本计划复制进版本工作目录

`version start` 建工作目录时，把计划文件复制到 `<worktree>/.zelto/versions/`。

为什么复制而不是「解析时回头去仓库根找」：

- 计划文件是**这一版的真源**（ADR-056）；仓库根那份是建版时的副本。版本目录后来会独立演化（有自己的分支与提交），根目录那份会落后。
- 归属解析读的是**当前目录**下的 `.zelto/versions/` —— 这是 ADR-056 定的目录约定，解析器照它读是对的；错的是目录里没东西。

复制的是**整个计划文件**，不是这一版的片段 —— 归属解析要知道「这个切片属于哪个版本」，而切片可能跨版本被引用。

复制失败**不阻塞** `version start`：副本是派生的，缺了它会让后续 merge 停下 —— 那可以在 merge 那一刻说清楚，不该在这里把整个 `version start` 拦死。

### 决策二：版本上下文里解析不出归属 → 停下

`resolveSliceOwnership` 新增 `versionContext` 选项。在版本上下文里，第 4 级兜底**不再生效**，改为抛 `UnresolvedOwnershipError`。

**判据是 git 事实**：当前检出的分支是 `version/<label>`。

不看目录路径 —— worktree 可能被人挪过、也可能被 `git worktree` 登记在别处；「当前在哪个版本分支上」比路径可靠。

为什么兜底本身不是错的：老项目没有版本计划，需要一个「合哪儿都能跑」的默认（ADR-056 §3.2 的向后兼容承诺）。错的是它在**版本上下文**里也生效 —— 人明明站在版本工作目录里、这个版本分支明明存在，切片却合去了主干。

「不知道」不等于「合主干」（ADR-033 的同一原则）。

### 决策三：显式 `--target` 反查不到版本 → 仍然用它

旧实现在这里也兜底成「合主干」。那是**不听指令** —— 人明确说了「合 version/v3」，zelto 却把切片合去了别处。

现在：分支名本身是权威的。label 从 `version/<label>` 反推，`planId` 留空（「这个分支属于哪份计划」确实不知道，但「合哪儿」是明确的，不该因此改主意）。

### 决策四：显式合主干仍然显式

`--target main` / `--target HEAD` 仍然合主干 —— 人明确要求的，不是猜的。

### 决策五：基点解析同样不许兜底

ADR-067 让单片的基点跟着归属版本分支走。归属解析在版本上下文里 fail closed 之后，基点解析**不能**再退回主干 HEAD —— 那会让 agent 在错误的基础上重写代码。基点错到主干，比停下来更坏。

所以 `resolveSliceBaseCommit` 也接受 `versionContext`，解析不出归属时**抛错**，不退回 HEAD。

## 影响面

这不是 nimrtc-v14 特有的 —— **任何在版本工作目录里跑 merge 的项目都中招**。只要版本计划没被复制进 worktree（默认都不复制），归属解析就落空。

修好之后：

- 版本分支里跑的 merge 会解析出**正确的版本归属**（合进它所属的版本分支，而不是碰巧合进当前分支）✅
- 老项目（不在版本上下文）行为不变 ✅
- 显式 `--target` 行为不变（且更可靠）✅

## 不做（边界）

- **不重写历史**。已投错的 12 个切片不重放 —— 重写主干/版本分支历史的风险远大于收益。实情记在文档对照表里（fix-forward）。
- **不搬移那 7 个切片**。它们现在在 `version/v3` 上，计划说它们属于 v1。要改的话正解是「重新按归属合进 `version/v1`」，但那要在版本分支上重做合并（涉及 spec 冲突），且 `version/v1` 与 `version/v3` 已分叉 104 个提交 —— 收益不抵风险。**留作后续决定，本次只修机制 + 记录实情。**
- 不动 `VersionSlice.state` 的回写。那是另一个问题（计划里的片级状态从不更新），且 ADR-114 已明确把「计划态」与「盘上事实」分开呈现。
- 不给 `.zelto/slices/` 进版本控制。切片状态文件仍只在盘上（ADR-114 的 `onBranch` 三态已经如实呈现这件事）。

## 不变量核查

- **C1**：无新增状态位置。计划副本仍落在 `.zelto/`（版本工作目录内），与既有约定一致。
- **C2/C6**：`core/version/branch.ts` 只用 Node 内置；不 import `adapters/`。
- **C3**：判据是 git 事实（分支名）+ 文件读（计划目录），纯确定性，不调模型、不触网。
- **C4**：解析失败**不改状态、不写盘** —— 事件流里不会有「合并完成」，只有 CLI 的错误输出。
- **C5 / C9**：无影响。

## 验收标准

1. `resolveSliceOwnership` 在 `versionContext: true` 且解析不出归属时抛 `UnresolvedOwnershipError`，不再返回 `{kind:'main'}`；
2. `versionContext: false`（老项目）行为不变 —— 仍然兜底合主干；
3. 显式 `--target version/<label>` 在反查不到计划时**仍然用那个分支**，不兜底成主干；
4. `version start` 之后，`<worktree>/.zelto/versions/<plan-id>.json` 存在且内容与仓库根那份一致；
5. 在版本工作目录里跑 `zelto merge <不在计划里的片>` → 明确报错停下，**不**合进主干；
6. `tests/adr-121-version-context-ownership.test.ts` 全绿、`npm run lint` 通过。

## 编号说明

本文初稿编号为 116（被 `docs/adr/adr-116-adr-single-home-and-no-drift.md` 占用），后改为 120（又被同日「驾驶舱执行目录脉络」占用），最终定为 **121**。

按 ADR-116「每号只有一个家」的规定，同号两份是不同的决定 —— 编号不能重。
