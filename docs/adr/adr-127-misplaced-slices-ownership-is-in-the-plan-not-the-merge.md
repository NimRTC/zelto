# ADR-127 归属错位的 7 片不是「合错了分支」，是**计划归属写错了** —— 按实情修计划，不重写历史

- 状态：Proposed（结论已由实测确定，处置方案待人拍板）
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
修正必须走确定性流程并写 `draft.revised` 事件，C4）：

```
zelto plan patch plan-1795166129234 --version v1 --remove-slice <7 片>
zelto plan patch plan-1795166129234 --version v3 --add-slice <片> \
    --slice-title <t> --slice-module <m> --slice-spec <path> --write <p>...
```

（写集与规格路径按原值原样搬过去 —— 改写集是另一件事，不在本次范围。）

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
   （描述是给人读的，措辞由人定。）
2. **计划里 `state` 从不更新**（一直是 `draft`）—— ADR-121 已明确
   「计划态」与「盘上事实」分开呈现，不在本次范围。
3. **7 片是否还需要在 v1 上「重做」** —— 本文的结论是**不需要**：
   它们的规格声明了归属 v3，v3 也在 `version/v1` 的下游链上（v1 ⊆ v2 ⊆ v3），
   最终交付时 v1 的内容会随版本链进入主干。**不需要重复实现。**
