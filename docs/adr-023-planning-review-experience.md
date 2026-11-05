# ADR-023: 规划确认体验 —— 摘要 + diff + 只看决策点

**状态**: 已实现
**日期**: 2026-11-05
**作者**: 系统架构
**关联约束**: C1, C3, C4, C6, C7
**关联文档**: `AGENTS.md`, `docs/zelto-项目目标.md`（§6 G-5、§7 D3）,
`docs/adr-012-parallel-coordination.md`（排期与判定的分离）

---

## 1. 摘要

`require` / `design` / `plan` 三条命令的产物是**一整篇 markdown**。
人想确认一个切片规划，只能把整篇通读一遍 —— 于是人会绕过 zelto 直接开写，
驾驶舱就废了。这是 `docs/zelto-项目目标.md` §6 里的 **G-5**，
也是「比 Cursor 方便高效」这条目标（G6）的前置条件。

本 ADR 把「确认一份规划」从「读全文」改成「读三样东西」：

| 现在的做法 | 本 ADR 之后 |
|---|---|
| 通读整篇 markdown | **摘要**：一屏看完这版是什么 |
| 不知道 refine 改了什么 | **diff**：相对上一版改了哪几行 |
| 不知道哪里需要自己拍板 | **决策点**：验收标准 / 模块 / 依赖 / 版本 / 切片 |

新增命令：`zelto require show <id>` / `zelto design show <id>` / `zelto plan show <id>`
（`--diff` 显示差异，`--no-diff` 关闭，`--full` 附正文全文）。

**契约变更**：新增事件类型 `draft.created` / `draft.revised` / `draft.confirmed`。

---

## 2. 动机

### 2.1 现状

| 事实 | 位置 | 影响 |
|---|---|---|
| 草稿只输出标题 + 验收标准，没有摘要与差异 | `src/cli/commands/ai-pipeline.ts` | 人看不出「这版 vs 上版」的区别 |
| refine 是**就地覆盖**，旧稿被顶掉 | `src/cli/commands/ai-pipeline.ts` | 没有可对的历史，diff 无从谈起 |
| 规划草稿的改动**不留痕** | 事件流里只有 `spec.*` / 切片级事件 | 「这一版规划是谁改的」查不到 |
| 没有「拍板点」的概念 | 全工程 | 人只能靠通读来找要决定的地方 |

### 2.2 为什么不是「让人自己写 diff」

工具可以只提供 `--diff` 让用户自己看行号变化，但**行级差异不等于决策级差异**：
改了 200 行正文，可能只是措辞；新增一条验收标准，才是真正要拍板的事。
所以必须有一层「决策点」的抽取，把文本变化翻译成「哪些决定变了」。

### 2.3 为什么不是「让模型总结一下」

`llm/` 的产出永远只能是被覆盖的草稿，不参与任何判定（C7）。
让模型去总结「这版改了什么」，等于把判定交给了不可复现的东西 ——
同样的草稿两次总结结果不同，追溯链就断了。

本 ADR 的做法是**确定性抽取**：验收标准、模块、依赖边、版本、切片
都是从结构化字段里直接读出来的，规则写在 `src/core/review/decision-points.ts`，
谁都能看懂它为什么这么抽。判定部分不调模型、不触网（C3）。

---

## 3. 决策

### 3.1 三个组成部分

| 组成 | 落在哪 | 说明 |
|---|---|---|
| **摘要** | `core/review/review.ts` | 决策点总数与分类统计、验收标准数 / 模块数 / 版本与切片数、差异行数、修订份数 |
| **diff** | `core/review/diff.ts` | 行级 LCS diff，输出真实行号的 unified diff（`@@ -a,b +c,d @@`） |
| **决策点** | `core/review/decision-points.ts` | 按草稿种类从结构化字段抽取，稳定 id，跨版本可对齐 |

### 3.2 决策点的种类

| 草稿 | 决策点 |
|---|---|
| 需求 | 每条验收标准（`acceptance`）+ 每个规格章节标题（`section`） |
| 设计 | 每个模块（`module`）+ 每条模块依赖边（`dependency`） |
| 版本计划 | 每个版本（`version`）+ 每个切片（`slice`） |

章节标题算决策点，是因为**结构是拍板的东西，正文不是**：
「有哪些章节」决定了这版规格覆盖了哪些方面；章节里的话术不用逐字读。

### 3.3 跨版本对齐

决策点带**稳定 id**（`ac-1`、`mod-exporter`、`dep-exporter-db`、`ver-v1`、`slice-s-1`）。
两版之间按 id 对齐：

- id 只在新版出现 → `added`
- id 只在旧版出现 → `removed`
- id 两边都有但文案不同 → `changed`
- 文案相同 → `unchanged`

### 3.4 修订快照：让 diff 有得可对

refine 是就地覆盖，所以**覆盖之前**先把旧稿快照一份，落在
`.zelto/revisions/<kind>/<id>/<时间戳>.json`。

快照是 append-only 的：只增不改，删了就是删了证据（C1）。
时间戳文件名保证同一毫秒内多次快照也不互相覆盖。

### 3.5 草稿也要留痕

新增三个事件类型：

| 事件 | 什么时候写 | 归属键 |
|---|---|---|
| `draft.created` | 需求 / 设计 / 计划生成落盘 | `draft-<kind>-<id>` |
| `draft.revised` | refine / add-version 覆盖之前 | `draft-<kind>-<id>` |
| `draft.confirmed` | 人确认草稿 | `draft-<kind>-<id>` |

归属键沿用版本级的做法（`version-<label>`）：草稿不是切片，但同样要能查。

### 3.6 入口路径

`zelto pipeline status` 末尾列出**待确认的草稿**，并给出下一步命令：
先 `show` 看决策点，再 `confirm`。入口不能让人猜命令。

---

## 4. 实现

### 4.1 新增文件

```
src/core/review/
  types.ts            事实类型与评审结论类型
  diff.ts             行级 LCS diff + unified diff 渲染
  decision-points.ts  决策点抽取（确定性）
  render.ts           草稿 → 可 diff 的稳定文本
  revisions.ts        修订快照存储（只在文件里）
  review.ts           buildDraftReview —— 纯函数
src/cli/commands/draft-review.ts   渲染与 show 子命令
```

### 4.2 契约变更

`contracts/schemas/event-envelope.json` 的 `type` 枚举新增三个值；
`src/core/events/stream.ts` 的 `EventType` 同步新增。

### 4.3 顺带修的健壮性问题

Windows 编辑器写文件常带 BOM，导致 frontmatter / JSON 解析失败。
`RequirementStore` / `DesignStore` / `VersionStore` / `RevisionStore`
读取时统一剥掉 BOM；`show` 读文件失败时给可读错误而不是抛栈。

---

## 5. 不变量自查

| 约束 | 怎么守住的 |
|---|---|
| **C1** 状态只在文件里 | 修订快照是 `.zelto/revisions/**` 下的 JSON 文件；评审结论是纯函数产物，不落盘 |
| **C2/C6** `core/` 不依赖 SDK 与 `adapters/` | `core/review/` 只用 Node 内置（`node:fs` / `node:path`），不 import `adapters/`、不 import `llm/` |
| **C3** 判定确定性 | diff 与决策点抽取全是确定性计算，不调模型、不触网 |
| **C4** 每个动作写事件 | 草稿的创建 / 修改 / 确认各写一条事件 |
| **C7** llm 产出只是草稿 | 评审只**读**草稿，不参与任何判定，也不自动 confirm |

---

## 6. 后果

### 6.1 好的

- 规划确认从「读全文」变成「读决策点」，G-5 落地
- refine 的改动看得见，人敢 refine
- 规划改动进事件流，追溯链从规格延伸到规划层

### 6.2 代价与边界

- **决策点的粒度是规则定的**，不是模型判的。
  换句话说：验收标准改了就是决策点变了，正文里某句话改了不一定是。
  这是刻意的 —— 宁可漏报也不要把判定交给模型。
- 快照会占磁盘。每份快照是完整事实的 JSON，规格很长时一份几 KB；
  目前不做清理策略（保留证据优先）。
- `show` 不自动 confirm。看完还是要人显式 `confirm`（与 ADR-018 同一原则）。

### 6.3 不做什么

- 不自动 confirm、不自动批准 —— 签字仍然只在人手里
- 不让模型参与决策点抽取
- 不改写规格正文 —— 规划文本仍然由 `llm/` 生成、被人覆盖
- 不做 GUI —— 只出终端视图
