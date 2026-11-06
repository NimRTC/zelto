# ADR-029: 设计文档的模块声明以正文为真源

**状态**: 已实现
**日期**: 2026-11-06
**作者**: 系统架构
**关联约束**: C2, C3, C5, C7
**关联文档**: `docs/adr-027-arch-guard-policy.md`, `docs/zelto-技术架构.md`,
`src/core/design/parse.ts`, `src/core/design/derive.ts`, `src/core/arch/resolve.ts`

---

## 1. 摘要

设计文档里有两份「模块声明」：

- `body` —— 人读的那份 Markdown 正文，**真源**
- `modules` —— 给判定用的结构化副本，**派生**

过去 `modules` 是在生成时解析一次就存进文件的。解析口径一改，存量文档里的
`modules` 就成了旧口径的产物——正文明明写得清楚，结构化副本里却冒出
「无]（作为核心层」这种不存在的依赖名。

本提案把口径收敛成一句话：**判定时一律从正文重新推导，`modules` 只是给人看的快照。**

同时修三处让报告变成噪声的地方：

1. **解析层**（`core/design/parse.ts`）：占位词、括号注释、散文尾巴一律剥掉；
2. **依赖名解析**（`core/arch/resolve.ts`）：设计里写路径（`src/core/ports`）时，
   按「该路径下的文件归谁」解析到模块，而不是一律报「未知模块」；
3. **统一口径**：架构检查、切片归属、追溯图、草稿评审读模块声明时，
   全部走 `deriveModules()`，不再各读各的。

效果（对本仓当前基线设计 `prj-1793947716547`，实测数据）：

| | 偏离总数 | 构成 |
|---|---|---|
| 修复前（旧基线设计 `prj-1792663276438`） | 213 | 缺失依赖 24、未声明 22、无归属文件 164、无法验证 2、依赖成环 2 |
| 修复后（同上，设计不动） | 213 | 同上量级（差异来自解析口径） |
| 修复后（当前基线设计 `prj-1793947716547`） | **2** | 缺失依赖 1、未声明依赖 1 |

**剩下的 2 条是真信号**——详见 §5。

> 注：旧基线的 164 条「文件无归属」里，157 条是**父模块 glob 写窄了**
> （`src/cli/*.ts` 而非 `src/cli/**/*.ts`），不是粒度太细造成的。
> 改对 glob 后降到 7 条。详见 §4.2.2。

---

## 2. 动机

### 2.1 现象：报告全是噪声，没人看

修复前 `zelto arch check` 在本仓报出 213 条偏离，其中 164 条是「文件无归属」，
24 条是「缺失依赖」。逐条看，绝大多数是解析口径问题，不是架构问题：

| 噪声来源 | 例子 | 实际含义 |
|---|---|---|
| 散文被当成依赖名 | `无]（作为核心层，被其他模块依赖）` | 本意是「无依赖」 |
| 路径被当成模块名 | `src/core/ports` | 本意是「依赖 src/core 里的 ports」 |
| 存量的 `modules` 是旧口径产物 | `无]（作为核心层` | 解析口径改过，正文没改 |
| 正则吞掉最后一个模块 | `### 优先级保证` 消失 | 前瞻在文末失配 |

### 2.2 为什么这是「追溯链」问题，不只是「报告好不好看」

AGENTS.md 的核心主张是「agent 的每一行代码都能追溯到一条人批准的规格」。

架构报告是这个链条的**证据面**：它回答「代码现在的结构，是不是当初批准的那份」。
一份 213 条、其中 99% 是噪声的报告，等于没有证据面——

- 审查的人不会逐条看，于是偏离进主干没人发现；
- 护栏（ADR-027）按偏离种类定级，噪声占多数时，真偏离被淹没；
- 「可追溯」退化成「有一个 JSON 文件存着当时的样子」。

**报告的噪声率直接决定追溯链有没有被使用。** 这不是美观问题。

### 2.3 为什么不能让每个调用方各修各的

修「解析口径」有四个地方可以修：

| 位置 | 修法 |
|---|---|
| `llm/generators/design.ts` | 生成时解析得更细 |
| `llm/generators/project-design.ts` | 同上 |
| `core/design/store.ts` | 读的时候重新解析 |
| 各调用点 | 各自过滤 |

每处单修都成立，但它们会漂移——正是 ADR-028 记录过的「多套解析器」问题
（那次是 policy.yaml，这次是设计正文）。

**根因是「谁是真源」没有回答。** 只要真源没定，每处修都是局部补丁。

### 2.4 为什么不是「把 `modules` 字段删掉」

`modules` 有实际用途：

- `zelto trace` 的依赖图要按模块名建边；
- `batch` 要按模块的 `filePatterns` 把切片归到模块；
- 人看 `zelto project design` 的输出时想看模块清单。

删字段是契约变更，且让「正文解析失败时没有兜底」。本提案保留字段、
但**明确它的地位是快照而非真源**，并给出统一入口。

---

## 3. 决策

### 3.1 真源与派生：`deriveModules()`

```typescript
// src/core/design/derive.ts
export function deriveModules(doc: Pick<DesignDoc, 'body' | 'modules'>): DesignModule[] {
  const parsed = doc.body ? parseDesignModules(doc.body) : [];
  if (parsed.length > 0) return parsed;
  return doc.modules ?? [];
}
```

规则只有两条：

1. **正文能解析出模块 → 用推导结果**（永远是当前口径）；
2. **正文解析不出模块 → 退回存的 `modules`**（正文被裁剪过、或格式不是设计模板）。

第 2 条是兜底，不是妥协：正文被裁剪的设计文档仍要能参与检查。

### 3.2 所有读模块声明的地方都走这一处

| 调用点 | 改动 |
|---|---|
| `cli/commands/architecture.ts`（`arch check`） | `design.modules` → `deriveModules(design)` |
| `cli/commands/arch-guard.ts`（`batch` / `gate` / `deliver` 护栏） | 同上 |
| `cli/commands/batch-facts.ts`（切片→模块归属） | 同上 |
| `cli/commands/trace/data.ts`（追溯依赖图） | 同上 |
| `cli/commands/draft-review.ts`（草稿评审） | 同上 |
| `core/design/store.ts`（`list()` 的 `moduleCount`） | 同上 |
| `cli/commands/ai-pipeline.ts`（生成 / 精修设计后存盘） | 存的是推导结果 |
| `cli/commands/panoramic-project.ts`（项目基线设计） | 同上 |

**存盘时写推导结果**——这样 `modules` 快照至少与当前口径一致，
而不是「生成那一刻的口径」。

### 3.3 解析层：只做形状清理，不改语义

`core/design/parse.ts` 的规则：

| 规则 | 例子 |
|---|---|
| 方括号里的是列表，方括号后面是说明 | `[无]（作为核心层）` → 空 |
| 条目尾部的括号注释丢掉 | `src/core（核心层）` → `src/core` |
| 剥掉包裹的引号 / 反引号 | `` `src/core/ports` `` → `src/core/ports` |
| 「无」类占位词当成空 | `无` / `无依赖` / `none` / `n/a` / `-` |
| markdown 链接只留可读部分 | `[根命令模块](#2-根命令模块)` → `根命令模块` |

**「什么算空」只有一份定义**：`core/text/normalize.ts` 的 `isEmptyToken()`。
它原先住在 `core/arch/normalize.ts`，`core/design/parse.ts` 要用就得反向依赖
`core/arch/`——方向别扭。搬到中立的 `core/text/` 后，
解析层与判定层用同一份定义，不会各说各话。

`core/arch/normalize.ts` 保留 re-export，现有 import 路径不用改。

### 3.4 解析用逐行扫描，不用大正则

原来的正则 `### (.+?)\n([\s\S]*?)(?=\n### |\n## |$)` **会丢掉最后一个模块**：

文末那一节既没有下一个 `###` 也没有 `##`，前瞻的 `\n### ` 已经吃掉了换行，
下一轮匹配从换行处起步，找不到 `### `。实测某份存量设计存了 7 个模块，
重新解析只得 6 个。

逐行扫描没有这个问题，附带还处理了代码围栏：``` 里的 `###` 是注释，不是模块声明。

### 3.5 依赖名解析：路径按「归属」解析

设计里写的依赖名有两类：

1. **模块名**：`src/core` —— 设计里确实有这个模块；
2. **路径**：`src/core/ports` —— 设计里没有这个模块，
   但它指的是某个模块内部的一块。

第 2 类以前一律被报成「依赖指向不存在的模块」——那是噪声，不是证据。

`core/arch/resolve.ts` 的规则（确定性，只读文件扫出来的归属结果）：

| 情况 | 结果 |
|---|---|
| 名字正好是某个模块 | 就是它 |
| 路径，且该路径下的文件全部只属于同一个模块 | 那个模块 |
| 路径下的文件分属多个模块 | 判不了，保留原名（由报告层报未知模块） |
| 该路径下没有文件 | 保留原名 |

用「实际归属」而不是「名字猜」：一个模块叫 `core`，它管的文件在 `lib/core/` 下，
那么依赖写 `lib/core` 就该解析到它。

---

### 3.6 契约变更

**`contracts/schemas/` 不动。** `DesignDoc.modules` 的 schema 类型没变
（`string[]` 的文件范围、`string[]` 的依赖），变的是**它的语义地位**：
从「真源」变成「快照」。

这是一个语义变更而非结构变更，故在此明确记录，而不是静默改掉。

事件类型不变（本次不新增任何事件）。`policy.yaml` 格式不变。

---

## 4. 实现位置

| 内容 | 位置 |
|---|---|
| 模块声明推导（统一入口） | `src/core/design/derive.ts` — `deriveModules()` |
| 正文解析 | `src/core/design/parse.ts` — `parseDesignModules()` / `parseFieldList()` |
| 「空」占位词 / 剥引号的公共定义 | `src/core/text/normalize.ts` — `isEmptyToken()` / `stripWrappingQuotes()`（`core/arch/normalize.ts` re-export） |
| 依赖名解析 | `src/core/arch/resolve.ts` — `resolveDependencyNames()` |
| 报告接入解析 | `src/core/arch/report.ts` — 声明边先解析再比对 |
| 生成器复用同一解析 | `src/llm/generators/design.ts`、`src/llm/generators/project-design.ts` |
| 判定测试 | `tests/design-parse.test.ts`、`tests/design-derive.test.ts`、`tests/arch-resolve.test.ts` |

### 4.1 顺带修掉的三处结构问题

这三处不在本 ADR 的主线上，但它们挡着「一条依赖方向单向」的收敛，
且都是纯结构问题、无语义变更，故一并处理：

| 问题 | 修法 |
|---|---|
| `llm/generators/*` 从 `adapters/llm/types.js` 取 `LlmAdapter` —— `core/` 之外的代码反向依赖适配器 | 改为从 `core/ports/llm.js` 取（端口在 core，实现在 adapters）；`adapters/llm/types.ts` 变成 re-export |
| `core/stall/types.ts` ↔ `core/stall/classifier.ts` 互相 import 类型，成环 | 类型真源收到 `types.ts`，`classifier.ts` 单向依赖它；`core/stall/index.ts` 改为从真源导出 |
| `cli/commands/question.ts` → `core-slice.ts` → `question.ts` 的动态 import 环 | `question.ts` 直接从 `run-support.ts` 取 `autoGateAfterRun`（`core-slice.ts` 仍 re-export，外部 import 路径不变） |

三者都不改契约：端口接口的类型没变，stall 的导出名没变，
`autoGateAfterRun` 的签名没变。

---

### 4.2 使用设计文档时的两个必知细节

这两条都是实测踩到的、不知道就会踩的坑。它们不是新规则，
而是 §3.1 与 §3.3 两条已有规则**叠加使用**时的必然后果。

### 4.2.1 父模块的依赖声明必须写成纯列表

「子目录模块不声明兄弟依赖、由父模块统一承担」这条规则要生效，
**父模块的依赖声明必须是一个纯列表**，不能带 `[无]` 之类的占位前缀。

反例（父模块 `src/core`）：

```
- **依赖模块**：[无]（作为核心层，被其他模块依赖）, `src/core/events`, `src/core/gate`
```

按 §3.3 的规则「方括号里的是列表，方括号后面的是说明」，
这一行会被解析成**只有 `无` 一个条目**——方括号后面的
`` `src/core/events` ``、`` `src/core/gate` `` 全被当作说明丢掉。

后果：父模块的 scope 不包含任何子模块，兄弟之间的 import 边
（`src/core/gate` → `src/core/events`）就变成跨模块边，
**每多一个子目录就凭空多出一条「未声明依赖」**。

正例：

```
- **依赖模块**：`src/core/events`, `src/core/gate`
```

实测：4 个子目录、带占位前缀的写法产生 4 条「未声明依赖」；
同样的 4 个子目录、纯列表写法产生 0 条。

### 4.2.2 每个子目录都要显式列为模块

父模块的 glob（如 `src/core/**/*.ts`）在**归属**上是递归的，
但「父模块声明依赖子模块」这条**依赖边**要成立，
子目录必须自己作为一个模块出现在设计里。

否则该子目录的文件落到父模块名下，而父模块不会 import 它们，
于是「父模块依赖这个子目录」成为一条永远匹配不到实际边的**缺失依赖**。

实测：`src/core/artifacts`、`src/core/ports`、`src/core/report`、
`src/core/spec` 这四个子目录没有任何 core 内部 import 边
（它们的 import 全指向 core 之外），把它们列为子模块后，
父模块对它们的依赖声明会各产生一条「缺失依赖」。

**推论**：一个子目录若与父目录内的其它模块没有任何 import 边，
就不该列为子模块——它没有独立的边界可言。

### 4.2.3 这两条合起来的可操作判据

给定一组候选子目录：

1. 每个子目录都显式列为模块，glob 写成 `<name>/**/*.ts`；
2. 父模块的依赖声明写成这些子目录的纯列表；
3. **只列有实际内部 import 边的子目录**——判据是该子目录与父目录内
   其它模块之间至少存在一条 import 边。

按此判据，`src/core/arch` 有 3 条出边（→ `policy`、`sched`、`text`），
`src/core/text` 只有 1 个文件、只被 `arch` 与 `design` 依赖，
属于「有边但太小」，是否列入由粒度取舍决定（见 §9 Q1）。

---

### 4.3 粒度实测数据（2026-11-06）

用 `zelto arch check --design <变体>` 实测四种粒度，
数据来自 zelto 自己的代码路径（`core/arch/scan.ts` → `report.ts` → `guard.ts`）：

| 变体 | 子目录数 | 缺失依赖 | 未声明依赖 | 依赖成环 | 总偏离 |
|---|---|---|---|---|---|
| 当前基线 `prj-1793947716547` | 0 | 1 | 1 | 0 | **2** |
| 4 子目录，父模块依赖带 `[无]` 前缀 | 4 | 1 | 4 | 0 | 5 |
| 4 子目录，父模块依赖为纯列表 | 4 | 1 | 1 | 0 | **2** |
| 10 子目录，父模块依赖为纯列表 | 10 | 5 | 1 | 2 | **8** |

结论：

- **4 个子目录与当前基线等价**（2 条偏离），多出的粒度不产生额外噪声；
- **10 个子目录会多出 5 条「缺失依赖」**（§4.2.2 的结构性错配）
  与 **2 条「依赖成环」**（`src/core/gate` ↔ `src/core/slice`——**模块粒度**的成环，
  文件级并没有环，详见 ADR-030 §4 的更正）；
- 那 2 条成环**是真信号**——顶层粒度看不见，因为两者都归在 `src/core` 名下。

### 4.3.1 实测方法与它的效力边界

**判定路径**：全部走 zelto 自己的代码——
`core/design/parse.ts` → `core/design/derive.ts` → `core/arch/scan.ts`
→ `core/arch/resolve.ts` → `core/arch/report.ts` → `core/arch/guard.ts`。
变体设计通过改 `.zelto/design/<id>.json` 的 `body` 字段构造
（**改 `modules` 字段无效**——正文才是真源，§3.1）。

**交叉校验**：另外写了一份独立实现的 import 图统计脚本，
与 `scanArchitecture` 的结果对照：

```
zelto 自己算的边数 : 30
独立脚本算的边数    : 30
只在独立脚本里（zelto 漏了）: 无
只在 zelto 里（脚本漏了）    : 无
```

两套独立实现结论一致，说明 `scanArchitecture` 没有系统性漏边。

**效力边界**：这是**用 zelto 检查 zelto 自己**（self-hosting）。
它能验证「粒度改动对报告的影响」，但**不能独立验证 zelto 判定逻辑本身是对的**
——如果 `scan.ts` 或 `report.ts` 的判定口径本身有错，这套数据会一致地错。
独立脚本的交叉校验只覆盖了「import 边有没有漏」这一项，
没有覆盖「偏离分类与定级是否正确」。

---


---

## 5. 剩下的 2 条偏离是真信号

修复后当前基线设计只剩 2 条：

| 偏离 | 内容 | 是不是噪声 |
|---|---|---|
| 缺失依赖 | `src/hook` 声明依赖 `src/core`，代码里没有 | **不是噪声** |
| 未声明依赖 | `tests` → `src/llm`，代码里有 import，设计里没写 | **不是噪声** |

第一条：设计说 hook 依赖 core，但 `src/hook/` 是**可独立编译**的判定进程
（AGENTS.md 目录约定），按设计就不该 import core。这是**设计与实现不一致**，
要么改设计，要么改实现——不能靠解析口径把它抹平。

第二条：`tests/annotate.test.ts`、`tests/llm-generators.test.ts` 确实 import 了
`src/llm`，设计的 `tests` 模块没写这条依赖。

**这两条正是架构报告存在的意义**：它们是「代码实际结构 ≠ 批准的设计」的证据，
指向真实的、可讨论的决策（hook 到底该不该依赖 core）。

---

## 6. 约束合规检查

| 约束 | 检查 | 合规 |
|---|---|---|
| **C1** | 不新增状态位置；改动全是纯函数与只读派生 | ✅ |
| **C2** | `core/design/`、`core/arch/`、`core/text/` 只用 Node 内置，不 import `adapters/` | ✅ |
| **C3** | 全部是确定性纯计算（文本解析 + 集合运算），不调模型、不触网 | ✅ |
| **C4** | 不新增事件类型 | ✅ |
| **C5** | 保护域与策略锚点完全未动 | ✅ |
| **C7** | `llm/generators/` 只是复用解析函数，产出仍是草稿，需人 confirm | ✅ |
| **C9** | 写集预约与逐写判定完全未动 | ✅ |

禁区检查：未新增自动批准、自动合并、自动改规格；
「从正文重新推导」是**读**设计，不是**改**设计。

---

## 7. 后果

**好的**

- 模块声明只有一份口径，解析层与判定层不会各说各话。
- 报告噪声从 99% 降到 0：剩下的偏离条条可讨论。
- 改了解析口径，存量设计立刻受益——不用重新生成设计。
- 「正文是真源」这条写进了代码注释与 ADR，不再靠默契。

**代价与边界**

- 每次读设计都要重新解析正文（一次线性扫描 + 正则匹配）。
  设计文档都是几十 KB 量级，代价可忽略；真要担心，可以加缓存，
  但缓存会引入「缓存与正文不同步」的新问题，得不偿失。
- `DesignSummary.moduleCount` 的语义随之改变（从「存了几个」变成「推导出几个」）。
  存量数据两者一致（实测 6 份设计全部一致），所以这是修正而非破坏。
- **写设计文档时多了两条硬约束**（§4.2）：父模块的依赖声明必须是纯列表；
  每个子目录都要显式列为模块。这两条不写下来，写设计的人会反复踩。
- **粒度不是免费的**：从顶层粒度加到 4 个关键子目录，偏离数不变（2 条）；
  加到 10 个则涨到 8 条——多出的 5 条「缺失依赖」是声明与现实的结构性错配
  （父模块包含子目录 ≠ 父模块 import 子目录），不是工具的 bug。

**明确不做**

- 不删 `modules` 字段（它是快照，给人看）。
- 不让解析层「猜」模块名（比如把 `1. 主程序模块` 和 `主程序模块` 当同一个）——
  那是语义推断，会引入新的不确定性。
- 不自动修设计。报告指出的偏离由人决定怎么处置。

---

## 8. 验收标准

1. `parseDesignModules` 的口径由 `tests/design-parse.test.ts` 守住
   （占位词、括号注释、散文尾巴、最后一个模块、代码围栏）。
2. `deriveModules` 的真源规则与幂等性由 `tests/design-derive.test.ts` 守住。
3. `resolveDependencyNames` 的归属解析由 `tests/arch-resolve.test.ts` 守住。
4. 所有读模块声明的调用点都走 `deriveModules()`——不再有裸读 `design.modules` 的判定路径。
5. `npm run build` / `npm run lint` / `npm test` 全绿。
6. `zelto arch check` 对当前基线设计输出 2 条偏离，且条条是真实证据。

**达成情况**（2026-11-06）：1–6 全部达成。
`npm test` 1233 项通过 / 0 失败；`npm run build` 与 `npm run lint` 无输出（干净）。
`zelto arch check` 对基线设计 `prj-1793947716547` 输出 2 条偏离，
即 §5 列的那两条（`src/hook` 缺失依赖、`tests` → `src/llm` 未声明依赖）。

---

## 9. 待决策（已定案）

> **2026-11-06 定案**：本节三个待决项（Q1 粒度 / Q2 strict 策略 / Q3 两条偏离处置）
> 已由 `docs/adr-030-baseline-rebuild-and-arch-policy.md` 一并定下：
> 粒度 = 顶层 + 5 个 core 子模块；两条偏离都**改设计**；`policy.yaml` 的 `arch:` 段
> 只把 `cycle` 放开成 `ask`。以下保留原始讨论，结论以 ADR-030 为准。
>
> **2026-11-06 再次更新**：ADR-031 把 SliceType 归位到 core/slice/kind.ts 之后，
> core/slice 不再依赖 core/gate，环已消失、基线重建后偏离归零，
> 那条 cycle: ask 豁免按 ADR-030 §3.3 的收紧条件撤销 —— policy.yaml 回到默认全 deny。

### Q1（模块粒度）

**问题**：当前基线设计用**顶层目录**当模块（`src/core`、`src/cli`，共 14 个）；
旧基线设计用**子目录**当模块（`src/core/audit`、`src/core/budget`，共 29 个）。

**已知数据**（§4.3 实测，zelto 自己的代码路径跑出来的）：

| 粒度 | 总偏离 | 说明 |
|---|---|---|
| 纯顶层（现基线） | 2 | `src/core` 内部边界看不见 |
| 4 子目录 + 父模块纯列表声明 | 2 | 与现基线等价，不增噪声 |
| 10 子目录 | 8 | 多 5 条缺失依赖 + 2 条成环 |

**建议**：在顶层之上增加**少量关键子目录**（`src/core/gate`、`src/core/policy`、
`src/core/sched`、`src/core/slice`、`src/core/events`），即两层粒度。
选这几个的理由是它们是 C2/C3/C5/C9 不变量与门禁逻辑的所在地；
其中 `src/core/slice` 值得列入，因为 `core/gate` ↔ `core/slice` 存在**模块粒度**的成环，
顶层粒度看不见它（文件级并没有环——更正见 ADR-030 §4）。

**仍需人定的两点**：

1. **子目录清单**：上述 5 个，还是别的组合？
   判据见 §4.2.3——只列「与父目录内其它模块有实际 import 边」的子目录。
   边数最多的是 `src/core/report`（6 条出边）与 `src/core/sched`（6 条出边）。
2. **`gate ↔ slice` 的环要不要暴露**：暴露则报告多一条「依赖成环」待处置，
   不暴露（不选 `slice`）则报告更干净但看不见真问题。
   这是「设计与实现哪个该改」的判断，属人的决定。

**粒度选择是人的决定，不是工具的默认值。**

### Q2（strict policy 配置）

ADR-027 定了「无 `arch:` 段时全部 `deny`」。
本仓 `policy/policy.yaml` 目前**没有 `arch:` 段**，所以 `zelto arch check --strict`
会被这 2 条真实偏离拦住（退出码 1）。

**建议**：配 `arch:` 段，把 `missing_dependency` 与 `undeclared_dependency`
设为 `ask`（待人确认、不拦人、证据仍在报告里），并写明收紧条件——
待 §5 那两条各自有了结论、基线重建后改回 `deny`。

**注意顺序**：Q1 是因，Q2 是果。粒度定完、基线重建、偏离重算之后，
Q2 的具体配置才能定。现在配等于给一个即将变化的偏离集合写死配置。

**是否配、怎么配，是项目策略决定，留待人定。**

### Q3（两条真偏离的处置）

§5 列的两条偏离指向两个具体决策，都不是配置能解决的：

| 偏离 | 事实 | 待定 |
|---|---|---|
| `src/hook` 缺失依赖 `src/core` | `src/hook/` 按 AGENTS.md 是**可独立编译**的判定进程，不 import core 才符合约定 | 改设计（去掉这条依赖声明）还是改约定？ |
| `tests` → `src/llm` 未声明 | `tests/annotate.test.ts`、`tests/llm-generators.test.ts` 确实 import 了 `src/llm` | 在设计里补这条依赖，还是改测试？ |

**这两条不能靠解析口径抹平**——它们是真实证据，指针（指向）
真实的、可讨论的决策。

**定案结果**（ADR-030 §3.2）：两条都改设计。`src/hook` 按 AGENTS.md 是可独立编译的
判定进程，实测只 import `node:*` 与同目录的 `protected.js`，设计里的 `src/core` 依赖删掉；
`tests` 补上 `src/llm` 依赖（`tests/annotate.test.ts`、`tests/llm-generators.test.ts` 确实 import 了）。
