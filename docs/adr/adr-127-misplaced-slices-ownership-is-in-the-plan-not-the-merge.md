# ADR-127 归属错位的 7 片不是「合错了分支」，是**计划归属写错了** —— 按实情修计划，不重写历史

- 状态：Accepted（2026-11-26，人拍板：修计划，不重写历史）
- 日期：2026-11-26
- 关联：ADR-121（版本上下文归属 fail-closed）、ADR-110（版本计划双写）、ADR-115（计划修正走确定性流程）、ADR-056（版本分支归属）、ADR-077（v5/v6 计划与树对齐）

## 背景

ADR-121 修好了「归属解析 fail closed」这个**机制**，并把历史遗留记为「**不重写历史**，
实情记在文档对照表里（fix-forward）」。

它同时留下一件明确**没做**的事：

> **不搬移那 7 个切片**。它们现在在 `version/v3` 上，计划说它们属于 v1。
> 要改的话正解是「重新按归属合进 `version/v1`」，但那要在版本分支上重做合并
> （涉及 spec 冲突），且 `version/v1` 与 `version/v3` 已分叉 104 个提交
> —— 收益不抵风险。**留作后续决定，本次只修机制 + 记录实情。**

本文是那个「后续决定」。

## 实测（nimrtc-v14，2026-11-26）

### 一、错位的 7 片

计划说它们属于 `v1`，`merge` 事件记的 `target` 是 `main`，产物实际落在 `version/v3`：

| 切片 | 计划归属 | 事件 target | 实际落点 | 自身规格写的归属 |
|---|---|---|---|---|
| `v1-ice-recovery` | v1 | `main` | `version/v3` | **`version/v3`** |
| `v1-turn-credentials` | v1 | `main` | `version/v3` | **`version/v3`** |
| `v1-path-change-report` | v1 | `main` | `version/v3` | **`version/v3`** |
| `v1-sdk-sample` | v1 | `main` | `version/v3` | **`version/v3`** |
| `v1-macos-install-proof` | v1 | `main` | `version/v3` | **`version/v3`** |
| `v1-install-tree-video-deps` | v1 | `main` | `version/v3` | **`version/v3`** |
| `v1-install-tree-module-closure` | v1 | `main` | `version/v3` | **`version/v3`** |

**关键事实：7 片的**冻结规格**（`specs/slices/<id>.md`，人确认过的产物）自己
就写明「归属：`version/v3`」，而且每一片都给出了**为什么必须在 v3**：

- `v1-ice-recovery`：「N3 要改 `EngineConfig`、`Stats`、公开头 —— `engine.hpp`
  正是 D1/D2/D6 都写过的那个文件。N3 与它们撞同一片区域，**必须顺序做**。」
  前置：「D6（`59b09f02`）已经在 `version/v3` 上」。
- `v1-turn-credentials`：前置「N3（`8abb815a`）已在 `version/v3` 上 —— N7 的
  『重连时重新咨询凭据』依赖 N3 的重连状态机」。
- `v1-path-change-report`：前置「N3 与 N7 已进 `version/v3` —— 本片要读 N3 的
  重连点，且 `engine_transport.cpp` 的 `execute_ice_recovery_restart()` 已被 N7 改过」。
- `v1-sdk-sample`：前置「N3 / N7 / N8 / N9 / D7 已合入 `version/v3`。N6 的样例
  **用** D7 的 call-state、N7 的凭据提供者、N8 的重协商 —— 三者缺一，样例就写不出来」。

也就是说：**人签字的规格说的是 v3，计划说的是 v1**。计划是那个 outlier。

### 二、计划里 v1 的**描述**本身就排除了这 7 片

计划对 v1 的描述：

> `v1: Wave 1 — N5 参考 TURN 部署 / D3+D4 默认设备策略与热插拔 / D5 音频 P2。
> 都不碰 engine 头文件，也不碰 CI，可与 v1.3 收尾并行。`

逐项对：`v1-n5-turn-server`（N5）、`v1-device-policy`（D3+D4）、
`v1-audio-p2`（D5）—— **恰好就是 v1 分支上有的那 3 片**。

而那 7 片**全部要改 `engine.hpp`**（公开面）、多数还碰 CI ——
直接违反 v1 自己写的「都不碰 engine 头文件，也不碰 CI」。

所以 v1 的条目是**超填**的：它的描述、它的规格、它的分支产物**三者一致**，
只有切片清单多塞了 7 片。

### 三、「重新按归属合进 `version/v1`」在技术上**不成立**

ADR-121 猜的是「重做合并会撞 spec 冲突」。实测比那更硬：**合出来的树编不过**。

在临时 worktree 上把 7 片按原提交链 cherry-pick 到 `version/v1`（冲突全取 theirs），
共 10 处冲突、7 片全部落地，结果：

- `src/engine/CMakeLists.txt` 引用了 `engine_connectivity_profile.cpp` 与
  `engine_audio_device_pump.cpp` —— 这两个文件**在新的 v1 树里不存在**
  （它们属于 v3 的 D6/D1）。**构建直接断。**
- 7 片的验收：`v1-install-tree-video-deps` / `v1-install-tree-module-closure` 通过（15 pass）；
  其余 5 片失败（`v1-ice-recovery` / `v1-turn-credentials` / `v1-path-change-report` /
  `v1-sdk-sample` 7 fail，`v1-macos-install-proof` exit=179）。
- 「取 theirs」把 v3 其它片的代码**夹带**进了 v1：`on_call_state`（D7，v3 的片）
  从 0 处变 2 处、`ice_failure_reason`（D6）0→1、`audio_source_name`（D1）0→1 ——
  **引用的符号在，定义它的文件不在**。
- 版本依赖链断：`v2.baseCommit = 628df8c9` = **旧** v1 的 tip。v1 一旦前移，
  `version/v1 ⊆ version/v2` 不再成立（实测：新 v1 ⊄ v2 / ⊄ v3 / ⊄ v4）。

根因：这 7 片的**前置切片**（D1 / D2 / D6 / D7 / N3 / N7）全在 v3 上。
它们在 v3 上不是「碰巧」，是规格写明的**顺序依赖**。

## 决策

### 一、错的不是合并，是**计划归属**

ADR-121 当时的推测（重新合进 v1）方向反了。事实是：

- **合并是对的**：7 片的规格逐片声明归属 v3，并给出依赖理由；
  人签字的是那些规格。
- **计划是错的**：v1 的清单超填了 7 片，且那 7 片违反 v1 自己的描述。

按 ADR-121「不重写历史」的原则，处置是 **fix-forward 修计划**，不动 git 历史。

### 二、处置：把 7 片的归属从 `v1` 移到 `v3`

走 `zelto plan patch`（ADR-115 决策：**手改状态文件是追溯链上的谎言**，
修正必须走确定性流程并写 `draft.revised` 事件，C4）。

**先补工具**：当时 `plan patch` 只有「从 A 移除 + 往 B 添加」两条路，
而这两条合起来是**有损**的 —— remove + add 会**重建**切片对象，
把一切 CLI 没显式建模的字段弄丢。实测 nimrtc-v14 那 7 片的 `note` 里写着
「ADR-031；version/v3 8abb815a」—— **那正是「这片归哪一版、依据是哪个 ADR」的人写下的凭据**，
也正是「归属依据」在计划里的唯一可查记录。丢掉它，这次修正就只剩「工具说搬了」，
没有「凭什么」。

所以给 `plan patch` 补了一条**原样搬**的通道（ADR-127 的工具侧配套）：

```
zelto plan patch <plan-id> --version <目标版本> --move-slice <片 id> --from <源版本> [--yes]
```

- `--move-slice <id> --from <version>`：把片**原样**搬到目标版本 —— 字段一个不改，
  只换它所属的版本。写集 / 标题 / 模块 / 规格路径 / `state` / `note` 全部保留。
- `--slice-note <text>`：单独修正备注（不想搬、只想改备注时用）。
- `--slice-state <s>`：单独修正计划态。

**为什么不能只靠 remove + add**（两条路各有各的坏处）：

| | remove + add | `--move-slice` |
|---|---|---|
| 未建模字段（`note`） | **丢** | 保留 |
| 边界（写集/标题/模块/规格路径） | 要**全部重打一遍**，漏一项就静默改了片的边界 | 一个字不改 |
| 审计痕迹 | 两条 `removed` + `added`，看不出是「搬」 | 一条 `moved`，before/after 写明「从哪到哪」 |

ADR-063 的原则是「**只改人明确指定的那一处**」—— remove + add 要求人把片的边界
整个重述一遍，每一处重述都是一次「可能打错」的机会。`--move-slice` 把这个风险消掉。

配套的 `--slice-state` 是必需的另一半：`--add-slice` 固定写 `state: 'draft'`，
若搬进来的 7 片被写成 draft，驾驶舱上会出现「分支上有产物 ✓ / 计划 draft」的自相矛盾。
**这不是「让工具自动同步计划态」** —— 计划态的修正必须由人显式指定，
每次都写 `draft.revised` 事件留痕（C4）。

（这次落地时，7 片的写集同时按「合并提交实际带进 `version/v3` 的文件」逐片对账改正了 ——
那是另一件事，见文末「落地」一节。）

### 三、修正后计划与分支事实**完全对齐**

实测（用 `Refs-Slice:` trailer 逐片核对每个版本分支）：

| 版本 | 修正前：计划归属 | 产物在分支上 | 修正后：计划归属 | 产物在分支上 |
|---|---|---|---|---|
| v1 | 10 | **3**（7 片不在） | 3 | **3** ✅ |
| v2 | 1 | 1 | 1 | 1 ✅ |
| v3 | 5 | 5 | 12 | **12** ✅ |
| v4 | 3 | 3 | 3 | 3 ✅ |

修正前只有 v2/v3/v4 是对齐的，v1 差 7 片；修正后**四个版本全部 100% 对齐**。

### 四、`merge` 事件里的 `target: main` 是**另一个问题**，不在本次处置范围

12 个 `target=main` 的事件（7 片 + v3 的 5 片）是 ADR-121 修机制之前的**历史**
—— 机制已修（`9918be3`），那之后新合的都记对了（`v1-rtcp-processor-collaborator`
记的是 `version/v3`）。

历史事件**不改**（append-only，C4）。追溯链上它们是「当时确实这么合的」的记录，
不是谎言 —— 谎言是**计划**说的归属。

### 五、`version/v1` 的分支本身不动

v1 分支保留现在这 3 片。它的描述、它的产物、它的规格**本来就一致**
—— 要改的只是计划里多出来的那 7 条待办。

## 影响面

- 只动**计划**（`.zelto/versions/<id>.json` 真源 + `versions/` 跟踪副本，
  ADR-110 双写），不动任何 git 分支、提交、tag。
- C1（状态在文件）、C4（append-only 事件）、C5（保护域不动）不破。
- 驾驶舱的「产物证据」（ADR-126）会立刻从
  `v1: 3/10` 变成 `v1: 3/3` —— 错位不再需要人去脑补。

## 未决项

1. **v3 的 `description` 也不完整** —— 它写的是「Wave 3 — N4 连通性诊断 + D6
   连通性 profile」，而它名下的 12 片远不止这两项。是否要一并改描述？
   （描述是给人读的，措辞由人定。）**尚未改** —— 按本文原则措辞由人定。
2. **计划里 `state` 从不更新** —— ADR-121 已明确「计划态」与「盘上事实」分开呈现。
   本次是例外：搬进来的 7 片**已做完**，若按 `--add-slice` 的默认写成 `draft`，
   驾驶舱会出现「分支上有产物 ✓ / 计划 draft」的自相矛盾。因此给 `plan patch`
   补了 `--slice-state`，只用于「按实情修正计划」这一条通道，**不是**要工具去自动
   同步计划态（那仍然是 ADR-121 的「不再耦合」）。
3. **7 片是否还需要在 v1 上「重做」** —— 本文的结论是**不需要**：
   它们的规格声明了归属 v3，v3 也在 `version/v1` 的下游链上（v1 ⊆ v2 ⊆ v3），
   最终交付时 v1 的内容会随版本链进入主干。**不需要重复实现。**

## 落地（2026-11-26）

已在 nimrtc-v14 执行，计划与分支事实对齐：

| 版本 | 修正前 | 修正后 |
|---|---|---|
| v1 | 10 片（7 片不在分支上） | 3 片 |
| v2 | 1 片 | 1 片 |
| v3 | 5 片 | 12 片（7 片并入，`state: completed`） |
| v4 | 3 片 | 3 片 |

- 计划真源修正走 `draft.revised` 事件（`draft-plan-plan-1795166129234`，35 条
  `before/after`），append-only、可审计（C4）。
- 7 片的 `note`（归属依据，如「ADR-031；version/v3 8abb815a」）原样保留，
  并各自追加一句「ADR-127：计划归属由 v1 修正为 v3」。
- **写集同时改正**：计划里的写集是**当初填的名义值**，与「合并提交实际带进
  `version/v3` 的文件」逐片核对后不一致（ZD-059 第 3 点）。以合并提交为准：

| 切片 | 合并依据 | 计划原写集 | 实际（修正后） |
|---|---|---|---|
| `v1-ice-recovery` | `8abb815a` | 3 条 | 15 个文件 |
| `v1-turn-credentials` | `3529b44a` | 2 条 | 12 个文件 |
| `v1-path-change-report` | `b4aa77ec` | 2 条 | 12 个文件 |
| `v1-sdk-sample` | `657941be` | 4 条 | 10 个文件（去掉与 macos 重复的 `ci.yml`） |
| `v1-macos-install-proof` | `18775f73` | 4 条 | 5 个文件 |
| `v1-install-tree-video-deps` | `85f142c9` | 3 条 | 6 个文件 |
| `v1-install-tree-module-closure` | `01b5aabd` | 3 条 | 6 个文件 |

  其中原写集里的 `docs/api/public_headers.manifest`（macos）在版本分支上**不存在**，
  `docs/api/engine_api.md`（video-deps / module-closure）在这两片的合并提交里**没被改过**
  —— 这正是「计划写着的东西没人去对账」的症状，工具层缺口另立 ADR 处理。

## 工具侧落地（zelto 仓库）

| 文件 | 改动 |
|---|---|
| `src/core/version/types.ts` | `VersionSlice` 增加 `note?: string`（备注是「归属依据」的可查凭据，必须能被建模） |
| `src/core/version/patch.ts` | `VersionPatch` 增加 `moveSlices`；`SlicePatch` 增加 `state` / `note`；实现**原样搬** |
| `src/cli/commands/plan-patch.ts` | `--move-slice <id> --from <version>` / `--slice-state <s>` / `--slice-note <text>` |
| `tests/plan-patch.test.ts` | 搬片单测 6 例（字段原样保留 / 不改入参 / 源版本缺失 / 片缺失 / 目标同名拒绝 / note 独立修正） |
| `tests/adr-127-plan-patch-state.test.ts` | E2E：`--move-slice` 走真 CLI，验 `note` 等字段一个不丢 |

**不变式**：

- C1（状态只在文件）不破 —— 计划仍只落在 `.zelto/versions/` + `versions/` 副本。
- C3（判定确定性）不破 —— `applyPlanPatch` 仍是纯计算，不调模型、不触网。
- C4（append-only 事件）不破 —— 每次搬都写 `draft.revised` 事件，含
  `field: 'moved'`、before/after（「从哪版到哪版」）。
- C2（`core/` 零第三方依赖、不 import `adapters/`）不破 —— 改动只在既有模块内。

### 顺带暴露并修掉的展示面缺陷（ZD-060）

修完归属后打开驾驶舱，发现**同一份计划出现了两次**：

```
plan-1795166129234（仓库根）       v1 = 3 片 / v3 = 12 片   ← 已按规格归属修正
plan-1795166129234（版本目录 v5）  v1 = 10 片 / v3 = 5 片   ← 修正前的旧副本
```

同一个 plan id，两套内容，**并排显示**。

根因：`planCoverage` 把「仓库根 + 每个版本目录」读到的计划**各自当成一个独立计划**
报出来，违反了 ADR-112 早就写明的边界 ——「**不做**版本目录里的需求 / 设计 / 版本计划的
分散读取；那些仍读仓库根（版本目录里的 `design/` 等是**同步副本**，不是真源）」。
ADR-110 的双写决定了副本可能过时（它是在分支切出来那刻同步的），于是真源与旧副本并排。

人看着只会以为「计划有两套，该信哪套」—— 而真相是「其中一套是旧的」。
这恰好在本文修的**正是**「计划说 v1 有 10 片、实际只有 3 片」这件事之后最刺眼：
修的答案和旧的错误答案**并排摆出来**。

修法：按 plan id 去重，**仓库根那份优先**；版本目录副本让位。
保留「计划只存在于版本目录（从没同步回根）」时的兜底展示 —— 看不见它比看见旧副本更糟。
详见 `docs/实战缺陷记录-nimrtc-v14.md` 的 ZD-060。

修完后的驾驶舱读数（nimrtc-v14 实测）：

| 版本 | 计划片数 | 盘上有片 | 盘上完成 | 本版分支有产物 | 随祖先版本并入 |
|---|---|---|---|---|---|
| v1 | 3 | 3 | 3 | **3** ✅ | 0 |
| v2 | 1 | 1 | 1 | **1** ✅ | 0 |
| v3 | 12 | 12 | 12 | **12** ✅ | 0 |
| v4 | 3 | 3 | 3 | 0 | **3** ✅ |
| v5 | 1 | 1 | 0（还在跑） | 0 | 0 |

**每一版的产物证据都 100% 对得上** —— 驾驶舱不再需要人替它做「哪个是真的」这个判断。
