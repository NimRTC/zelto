# ADR-057：被放弃的切片不阻塞版本交付

**状态**: 已实施
**日期**: 2026-11-15
**作者**: 系统架构
**关联约束**: C1, C4
**关联文档**: `docs/adr/adr-056-version-level-branches.md`（§3.4 `version deliver` 重写）,
`src/cli/commands/ai-pipeline.ts`（`version deliver` 前置条件判据）

---

## 1. 摘要

**一个切片被 `zelto abandon` 废弃之后，它所属的版本就再也交付不了了。**

`version deliver` 的前置条件判据要求版本里的每个切片状态都是
`completed`。`abandoned` 不算。于是：**版本里的切片只要有一片被放弃，
整个版本就永久卡住**，而 zelto 没有提供任何出口。

## 2. 问题

### 2.1 触发路径

2026-11-15 的实战演练（对 `nimrtc-zelto` 跑完整切片生命周期）里踩到了。

版本计划 `plan-1794700304594` 的 v1 含两个切片：

- `v1-rtp-packetizer-core` —— 建 RTP 打包集中层
- `v1-adapter-layer` —— 把 `engine_media.cpp` 的打包调用点适配到集中层

`v1-adapter-layer` 的规格草稿是 `version start` 时 LLM 自动生成的
（从未经人确认），内容是幻觉 —— 描述了「媒体文件加载 / 播放暂停 /
音量控制」这类 nimrtc（实时音视频通信库）根本不存在的功能。

于是这片被 `zelto abandon` 废弃。**结果**：

```
❌ 验收前置条件不满足：
   - v1-adapter-layer：状态是 abandoned，还没到「已完成」
```

### 2.2 为什么没有出口

三条路都堵死：

| 尝试 | 结果 |
|---|---|
| 恢复切片状态 | 状态机里 `abandoned: {}` —— 终态不可离开，无转换 |
| 重建切片 | `zelto create v1-adapter-layer` → 「Slice already exists」—— ID 不可复用 |
| 从版本里移除切片 | `zelto plan` 只有 `add-version`，不能删切片 / 改归属 |

**这是一条死路**：切片废弃 → 版本永久阻塞 → 而 zelto 不提供任何解除阻塞的
正规命令。

### 2.3 判据本身就不自洽

同一份代码里，对「版本里的切片是否已了结」有两套定义：

- `src/core/report/report-analyzer.ts`（版本进度统计）：
  `sd?.state === 'completed' || sd?.state === 'abandoned'` —— **abandoned 算了**
- `src/cli/commands/ai-pipeline.ts`（`version deliver` 前置条件）：
  `data.state !== 'completed'` —— **abandoned 不算**

报表说这个版本「这两片都了结了」，交付说「没完」。**判据漏了一处，
不是设计意图分歧。**

## 3. 决策

### 3.1 abandoned 不阻塞交付，但要显式列出来

`version deliver` 的前置条件判据改为：

- `completed` —— 照旧要求产物已合入版本分支
- `abandoned` —— **不阻塞**，但在交付输出里显式列出是哪几片

不静默吞掉是硬要求：版本交付是「这一版到底少了什么」的结论，
被放弃的片必须出现在结论里，否则交付记录与事实不符。

### 3.2 为什么不是「让 abandoned 可以复活」

给状态机加 `abandoned → draft` 转换看起来更通用，但有三个问题：

1. **abandoned 是终态**（`isTerminalState` 判 completed / abandoned）。
   让它可复活，等于把终态重新打开 —— 所有按终态做的假设都要重审。
2. **废弃的语义是「这片不作废了」**。复活它让人重新写一遍规格，
   与「换个 ID 重建」相比没有额外收益。
3. 真正缺的不是「复活」，是「**这一版可以在有缺口的情况下交付**」。

### 3.3 为什么不改版本计划

版本计划是**人确认过的规划**（`zelto plan confirm`）。废弃一片真实存在的
切片之后，计划与现实的差异应当由**新版本**来消化，而不是回头改老计划 ——
否则「确认过的计划」就不再可信。

## 4. 约束核对

| 约束 | 核对 |
|---|---|
| **C1** 状态只在文件里 | 判据只读切片状态文件，未引入内存状态或数据库 |
| **C3** 判定确定性 | 判据只看状态字符串，不调模型、不触网 |
| **C4** append-only 事件 | 未改事件类型；abandoned 切片既有的 `slice.state.changed` 事件已在流里 |

## 5. 影响

- `version deliver` 在版本含 abandoned 切片时**由失败变为通过**，并输出
  `⚠️ 本版本有 N 个切片被放弃（不阻塞交付）` + 切片清单。
- 版本计划里出现幻觉切片时，人可以废弃它并继续交付，
  不再需要「为了交付而把幻觉规格跑完」。
- 遗留问题：**`zelto plan` 仍不能删切片 / 改切片归属**。
  本 ADR 只解开了交付的阻塞，没给规划侧开口子。规划侧的正解是
  「新增版本消化差异」，但 `plan add-version` 目前靠 LLM 自动生成切片，
  容易再产生幻觉规格 —— 这需要单独一条 ADR。
