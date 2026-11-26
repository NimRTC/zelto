# ADR-118：规格符合性检查与领域词汇表 —— 补上「出处说了什么，代码真的做了」

> **原编号 ADR-057**。与 `docs/adr/adr-057-abandoned-slice-does-not-block-version-delivery.md`
> 同号（两份是不同的决定），按 ADR-116 决策一改号为 118。
> 历史上 `ADR-057` 的引用混指两份：`zelto spec-check` / `zelto glossary` 及其
> `spec.*` 事件见 `src/core/events/stream.ts` 的接线，属本文件；「放弃的切片
> 不阻塞交付」属 057。

**状态**: 部分实现（§5 已落地），§6 待决策
**日期**: 2026-11-22
**作者**: 系统架构
**关联约束**: C1, C2, C3, C4, C5, C7
**关联文档**: `docs/zelto-项目目标.md`,
`docs/zelto-场景功能地图.md`,
`docs/adr-023-planning-review-experience.md`,
`docs/adr-032-trace-judgment-enforcement.md`,
`docs/adr-036-contract-evolution-and-regression-baseline.md`

---

## 1. 摘要

zelto 的追溯链保证「这段代码**有出处**」——追溯项非空、契约与测试落到具体文件。
但它回答不了另一个问题：

> **出处说了「要做什么」，代码真的做了吗？**

门禁②跑验收测试，**测试通过 ≠ 实现忠实于规格**。规格里没写、代码里多出来的
（范围蔓延）现在没人查；规格里写了、代码里没做的，现在也没人查。

同时，zelto 的追溯链全是**结构化产物**：

```
需求 → 设计 → 版本计划 → 版本 → 切片 → 规格 → 测试 → 代码
```

每一环都是结构，没有一处是**语言**。于是 agent 之间最容易出的岔子不是
「没按规格写」，而是「各自造词」—— 同一个概念两个 agent 各叫一个名字，
追溯链查不出来（追溯判的是「有没有出处」，不是「出处说的是不是同一件事」）。

本 ADR 补两样东西：

1. **规格符合性检查**（§5）—— 「改动 vs 规格」的确定性判定，补上 Spec 轴
2. **领域词汇表**（§5）—— 项目的共享语言，让人和 agent 用同一套词说话

另加一条**提案**（§6）：规划层的结构化追问 —— 让「人对草稿点头」变成
可追溯的追问记录。

**不**改变追溯链的结构，**不**改写集守卫的语义，**不**新增判定闸门。

---

## 2. 动机

### 2.1 缺口在哪

| 事实 | 位置 | 影响 |
|---|---|---|
| 追溯只判「追溯项非空 + 契约/测试落到具体文件」 | `src/core/trace/judgment.ts` `judgeTrace` | 追溯成立**不等于**实现忠实于规格 |
| 追溯引用由规格正文**原样物化** | `src/core/spec/trace-extract.ts` `materializeRequirements` | 每行验收标准都成了一条追溯引用 —— 但**说的是不是人真正想要的**，追溯判定不知道 |
| 门禁②只跑验收测试 | `src/core/gate/executor.ts` | 测试绿了不等于规格被忠实实现；规格没要求的东西也不拦 |
| 追溯链里没有「语言」这一层 | `.zelto/` 目录布局 | agent 各自造词，术语漂移无人查 |
| `arch check` 只比设计模块图 vs 实际 import 图 | `src/core/arch/report.ts` | 不看「这次改动有没有超出规格」 |

### 2.2 外部参考

mattpocock 开源了一套 agent skills（`github.com/mattpocock/skills`，MIT），
其中 `code-review` 的**双轴分离**设计与本 ADR 直接相关：

> - Code that follows every standard but implements the wrong thing →
>   **Standards pass, Spec fail.**
> - Code that does exactly what the issue asked but breaks the project's
>   conventions → **Spec pass, Standards fail.**
>
> Reporting them separately stops one axis from masking the other.

**借鉴它的形态，不借鉴它的信任模型。** 他的两轴都是「两个 LLM subagent 并行判」，
结论是模型的判断 —— 对 zelto 来说这违反 C7（LLM 产出只作草稿）与
C3（判定必须确定性），不能进闸门。

zelto 已有更强的 Standards 轴（`arch check` + `policy.yaml` 的 `arch:` 段，
ADR-027，六类硬偏离四处执行点）。**缺的只是 Spec 轴。**

本 ADR 的做法：把「规格说了什么」与「代码里有什么」都变成**可比对的结构**，
再用确定性规则比对。同一份输入永远给同一个结论，可复现、可进事件流、可当闸门。

### 2.3 借鉴与不借鉴

| 外部做法 | 借鉴? | 理由 |
|---|---|---|
| Spec 轴与 Standards 轴分离，不互相掩盖 | ✅ | zelto 的 Standards 轴已存在，Spec 轴是真空 |
| 双轴用**并行 subagent** 跑 | ❌ | 违反 C3/C7；zelto 改用确定性判定 |
| 领域词汇表（`GLOSSARY.md`）+ ADR 同步维护 | ✅ | zelto 的追溯链缺「语言」层 |
| `implement-spec` 用 subagent 并行 + 各自 merge | ❌ | zelto 有更强的版本（写集预约 + 阶段编排），且他靠 agent 自觉 —— zelto 明确拒绝这个信任模型 |
| ticket 用 `ready-for-agent` label 表示「可执行」 | ❌ | zelto 的「可执行」是 `frozen` 状态 + 追溯判定，不是 label |
| `/retro` 建议给 reviewer agent 加规则 | ❌ | zelto 的规则要去 `policy.yaml` + 锚点，不能由 agent 运行时改（C5/C8） |

---

## 3. 关键决策

### D1：Spec 轴做成**确定性**判定，不做 LLM 判定 —— 采纳

**决策**：规格符合性由纯计算得出，判定逻辑住在 `core/spec-conformance/`。

**理由**：

- C3 规定 `core/policy/`、`core/gate/`、`core/sched/` 不得调用模型、不得触网。
  符合性检查要能进闸门，就必须确定性。
- C7 规定 `llm/` 只产草稿。一个靠模型判断的「符合性」进不了门禁，
  只能当参考 —— 那它的价值就退回到「另一个 review 工具」，不值得新增。

**代价**：抽象要求（「解析器应当健壮」）无法用字面比对核实。
这被显式建模为第三种结论 `unknown`，**不混进 `missing`**（见 D3）。

### D2：三类结论 —— implemented / missing / unknown —— 采纳

**决策**：判定分三类，不合并成两分。

**理由**：`missing` 会影响退出码（1 = 有规格要求没做）。把「判不了」算成
「没做」，会让抽象规格永远红 —— 那是闸门误报，会逼人去改规格
（AGENTS.md：「遇到不确定时停下来问」）。

「证据不足」与「证据为负」是两回事，必须分开 —— 与 ADR-059 的
`unknown` 三态同哲学。

### D3：证据的定义要保守 —— 采纳

**决策**：一条要求算 `implemented`，当且仅当满足其一：

1. **路径证据** —— 改动里动过这条要求提到的路径（前缀关系也算）；
2. **符号证据** —— 改动过、且**当前内容里出现了**这条要求提到的标识符。

拿不到证据且要求**没有任何锚点**（既无路径也无标识符）→ `unknown`，
不判 `missing`。

**理由**：把没实现的算成 `implemented` 是漏报（更严重）；
把实现了的算成 `missing` 是误报（挡人）。**宁严勿宽**说的是判定不能松，
但也不能因为判据局限就冤枉人。

### D3.1：锚点分三类，且必须区分「标识符」与「自然语言」—— 采纳

**决策**：反引号片段按三类认：

| 形态 | 例子 | 算不算锚点 |
|---|---|---|
| 路径 | `` `src/core/foo.ts` `` | ✅ 路径证据 |
| 标识符 | `` `SliceStore` `` | ✅ 符号证据 |
| 命令 | `` `zelto policy edit foo --action deny` `` | ✅ 抽出命令里的标识符当符号证据 |
| **自然语言短语** | `` `不变量必须成立` `` | ❌ **不是锚点** |

符号匹配用**词边界**（`(?<![\w])sym(?![\w])`），不用裸子串。

**理由**：

- **命令形态**：规格里大量要求写成「`zelto policy edit foo --action deny`
  将规则 action 改为 deny」。这类要求的可核对锚点是命令里的标识符
  （`policy` / `edit` / `action` / `deny`），不是整条命令字符串。
  不认这类会让它们全判成「判不了」，而它们其实是**可以核对**的。
  旗标名（`--action`）**不算**锚点 —— 代码里写的是 `action`，不是 `--action`。
- **自然语言短语**：拿 `不变量必须成立` 去代码里做字面比对必然对不上 ——
  那不是证据，是噪声。把它当锚点会让这类要求永远判「未实现」，是闸门误报。
- **词边界**：裸子串会让 `action` 匹配到 `transaction`、`deny` 匹配到 `denyAll`
  —— 那是**假证据**，会把没实现的算成实现了。
  边界用 `\w` 而不是 `[\w$]`：JS 标识符可以带 `$` 前缀（`$scope`），
  `$` 不是边界，否则「`scope` 应当被支持」会因为代码写成 `$scope` 而找不到证据。

### D4：范围蔓延只报告、不拦 —— 采纳

**决策**：改动里出现规格没点名的文件 → 报成 `scopeCreep`，**不影响退出码**。

**理由**：真正的硬边界由**写集守卫**管（C9，运行时逐写判定、越界当场拒）。
这一层若也拦，会与 C9 重复且更弱 —— 规格写得简略时 agent 顺手改了同模块的
另一个文件是常事，那是正常工程，不是越界。

这一层的价值是**指出来给人看**：「这次改动有两处规格没点名，你确认下」。

### D5：词汇表落在 `.zelto/glossary.json` —— 采纳

**决策**：词表存在 `.zelto/glossary.json`，由人维护（`zelto glossary add/remove`）。

**理由**：

- `.zelto/**` 在**保护域**里（C5），agent 改不了它 —— 词表因此是人的资产，
  不是 agent 随手改的产物。
- 状态只在文件里（C1）。
- 不动 `contracts/schemas/` 的任何契约 —— 词表不是 zelto 的契约，
  是**单个项目**的资产。放项目里而不是放 zelto 里，是对的。

### D6：词汇表检查只做**字面比对** —— 采纳

**决策**：`zelto glossary check` 只做字面比对（词表里的词有没有出现、
受控术语有没有被别名绕过）。不做语义理解。

**理由**：C3 要求判定确定性。语义判断要么调模型（违反 C7），
要么引入启发式算法（输入变了结论就变）。

「词表里没有的候选术语」是**候选**，不是定论 —— 命令会明说这一点。
判据是启发式的（反引号标识符 + 驼峰词），报出来给人看。

---

## 4. 被否决的方案

### 4.1 「Spec 轴用 LLM 判」

**否决**。违反 C3/C7，结论不可复现，进不了闸门。

mattpocock 的原版就是这么做的 —— 他那边成立是因为他的两轴结论本来就只是
「给人看的参考」。zelto 要的是能当闸门的东西。

### 4.2 「把符合性检查接进门禁②，作为阻断项」

**否决**（本轮）。规格符合性检查目前是**独立命令** `zelto spec-check`，
不接进门禁②。

**理由**：接进门禁②意味着「规格要求的没做 → 门禁②不过 → 不能签字」。
但 `missing` 的判据是**证据缺失**，不是**证据为负**（D3）——
在 `unknown` / `missing` 的边界还没被真实项目验证之前，
把它设成阻断闸门，误报会直接挡住人干活。

**留待 §6 一起决策**：等它在几个真实切片上跑过、误报率可接受之后，
再决定要不要进闸禁②。

### 4.3 「词汇表进 `contracts/schemas/`」

**否决**。词表是**单个项目**的资产，不是 zelto 的契约。
放 `contracts/` 会让每个使用 zelto 的项目都得维护一份 schema 之外的东西，
且 `contract check` 的基线语义（人签字接受契约变化）用不上它。

### 4.4 「直接抄 mattpocock 的 `GLOSSARY.md` 约定与 skill」

**否决**。他的词表是给**人和模型读**的 markdown；zelto 的词表要能被
**校验**（`zelto glossary check`），所以是 JSON + 确定性检查。

抄约定、抄机制，不抄格式。

---

## 5. 已实现（§5）

### 5.1 规格符合性检查（Spec 轴）

**新增** `src/core/spec-conformance/`：

| 文件 | 职责 |
|---|---|
| `conformance.ts` | 判定逻辑：从规格提取要求 → 找证据 → 三类结论 + 范围蔓延 |
| `collect.ts` | 改动事实收集：跑 `git diff --numstat` + `git ls-files --others` |
| `index.ts` | 导出 |

**新增** `src/cli/commands/spec-check.ts` —— `zelto spec-check <slice-id>`。

**判定流程**：

```
规格正文 ──extractRequirements──> 要求列表（带锚点）
                                      │
改动文件 ──collectChangedFiles───────┤
                                      ├──> 逐条找证据 ──> implemented / missing / unknown
文件内容 ──readFileContents──────────┘
                 │
                 └──> 规格没点名的改动 ──> scopeCreep（只报告）
```

**退出码**：0 = 没有 `missing`；1 = 有 `missing`。
`scopeCreep` 与 `unknown` 只报告，不影响退出码（D4）。

**事件**：`spec.conformance_checked`（新事件类型，已进契约 enum 与审计摘要表）。

### 5.2 领域词汇表

**新增** `src/core/glossary/`：

| 文件 | 职责 |
|---|---|
| `glossary.ts` | 词表类型、解析/渲染、使用检查（字面比对） |
| `store.ts` | 存储：读/写/增删术语（状态只在文件里，C1） |
| `index.ts` | 导出 |

**新增** `src/cli/commands/glossary.ts` —— `zelto glossary <subcommand>`：

| 子命令 | 做什么 |
|---|---|
| `show` | 看词表 |
| `add <term> --meaning "..." [--alias <a>] [--controlled]` | 加/更新一个术语 |
| `remove <term>` | 删一个术语 |
| `check [slice-id]` | 检查规格正文对词表的使用 |

**事件**：`glossary.updated`、`glossary.usage_checked`。

### 5.3 不变量自查

| 约束 | 自查 |
|---|---|
| **C1** 状态只在文件里 | 词表落 `.zelto/glossary.json`；符合性检查**不写任何状态**（只读 git + 只读规格） |
| **C2** core 零第三方依赖 | `core/spec-conformance/` 与 `core/glossary/` 只用 Node 内置（`node:child_process` / `node:fs` / `node:path`） |
| **C3** 判定确定性 | 全部纯计算：字面比对 + 前缀关系；同一输入永远同一结论 |
| **C4** append-only 事件 | 两个新命令各写一条事件；`spec.conformance_checked` / `glossary.updated` / `glossary.usage_checked` 已进 `EVENT_TYPES` 与契约 enum |
| **C5/C8** 保护域 | 词表在 `.zelto/`（保护域内，agent 改不了）；符合性检查**只读**，不改任何文件 |
| **C7** LLM 只产草稿 | 本 ADR 引入的两样东西**完全不调模型** |

### 5.4 验收标准

1. `zelto spec-check <id>` 报出「已实现 / 未实现 / 判不了」三类计数与逐条结论；
2. 规格里提到但改动里没有的路径报成 `missing`，退出码 1；
3. 改动里有、规格没点名的文件报成 `scopeCreep`，但**退出码仍为 0**；
4. 要求里没有任何锚点时判 `unknown` 而**不是** `missing`；
5. `zelto glossary add` / `show` / `remove` / `check` 四条路径可用；
6. 受控术语经别名出现时报出「受控术语被绕过」；
7. 词表缺失时 `check` 明确说「尚未建立词汇表」，不静默当作「一切正常」；
8. 三方对账不变式（`tests/event-contract-parity.test.ts`）通过 ——
   事件类型总数 64 与文档一致。

### 5.5 测试分层

| 层 | 位置 | 验什么 |
|---|---|---|
| 单元 | `tests/core/spec-conformance/`、`tests/core/glossary/` | core 里的判定逻辑对不对（喂假的改动清单） |
| 验收 | `tests/acceptance/spec-check-command/`、`tests/acceptance/glossary-command/` | 命令接上去之后行为对不对（跑**真实 CLI 进程** + **真 git 仓库**） |

验收层不可省：git 那一层（`git diff --numstat` + `git ls-files --others`）
单元测试**够不到** —— 它只能靠真仓库验。

### 5.6 验收测试查出来的真问题

写验收测试时抓到三个**单元测试抓不到**的缺陷 —— 都是「命令接上去之后」才暴露的：

| 缺陷 | 症状 | 修法 |
|---|---|---|
| **旗标被当成切片 id** | `zelto glossary check --json` 把 `--json` 当切片 id 去读 → **未捕获的 ENOENT 崩成 stack trace** | 参数一律取「第一个非旗标参数」；切片读不到时明确报 NOT_FOUND，不冒泡异常 |
| **zelto 自己的托管文件被算成范围蔓延** | 每次检查都报 `.zelto/slices/*.json`、规格副本 —— **假阳性** | 判定时排除托管路径（**全部切片**的，不只是当前切片） |
| 托管路径只算当前切片 | 工作区里别的切片的托管文件照样被报成蔓延 | 逐片读自己的 `spec.path` / `acceptance.dir` |

**「报假阳性的检查等于没检查」** —— 人会习惯性忽略。这条不是单元测试能发现的：
单元测试喂的是假的改动清单，看不出哪些文件是 zelto 自己放的。

---

## 6. 待人决策（不自行拍板）

### D7：规划层的结构化追问 —— 要不要做，做成什么形态

**背景**：规划层（`require` / `design` / `plan`）现在是「LLM 生成草稿 → 人 confirm」。
人 confirm 时看到的是从草稿生成的摘要与决策点清单（ADR-023）——
**如果草稿方向本身就偏了，人在摘要层面看不出来**，因为摘要是从草稿生成的，
草稿偏了摘要也偏。

这是 zelto 承认的最硬的缺口（G-5/G-6：入口体验重 → 人绕过 zelto 直接开写
→ 驾驶舱废掉）。

外部参考：mattpocock 的 `grill-with-docs`（`grilling` + `domain-modeling`
两个 skill 组合）是「反复追问直到设计树的每个分支都被走完」的机制，
并同步维护词汇表与 ADR。

**候选方案**：

- **A**：在 `require/design/plan` 生成草稿后、`confirm` 之前，加一个**结构化追问环节**，
  追问结果物化成 `decisionPoints`（`src/core/review/types.ts` 已有该类型），
  每轮追问与答案各写一条 `clarify.question` / `clarify.answer` 事件。
- **B**：只做 §5.2 的词汇表（已实现），不引入追问环节。
- **C**：把追问做成一个**独立命令**（如 `zelto grill <id>`），不接进 `confirm` 流程。

**A 的理由**：他的 grilling 是纯对话、答案不留痕；zelto 可以让每次追问都成对
写事件 —— **这是他做不到的，因为他没有事件流**。

**A 的代价**：改 `require/design/plan` 的流程与 `decisionPoints` 的结构，
要改契约（ADR）。且追问体验本身要调 —— 追问太多会烦人，太少没意义。

**建议**：先按 B 现状跑一段，把词汇表用起来，观察「agent 各自造词」是不是
真问题；确认是，再按 A 做（追问环节的价值需要真实痛点支撑）。

### D8：符合性检查要不要进闸禁②

见 §4.2。等 `zelto spec-check` 在几个真实切片上跑过、误报率可接受后再定。

**现在不做**是安全的：`zelto spec-check` 是独立命令，人可以主动跑，
也可以接进 CI。门禁②的阻断语义要稳。

---

## 7. 影响面

| 文件 | 变更 |
|---|---|
| `src/core/spec-conformance/` | 新增 |
| `src/core/glossary/` | 新增 |
| `src/cli/commands/spec-check.ts` | 新增 |
| `src/cli/commands/glossary.ts` | 新增 |
| `src/cli/commands/index.ts` | 注册两个新命令 |
| `src/cli/commands/catalog.ts` | 目录加两行（help 与补全自动跟上） |
| `src/core/events/stream.ts` | `EVENT_TYPES` 加 3 种 |
| `contracts/schemas/event-envelope.json` | enum 加 3 个 |
| `src/core/audit/trail.ts` | 审计摘要加 3 条 |
| `docs/zelto-场景功能地图.md` | 事件类型 61 → 64；命令表加两行 |
| `docs/zelto-技术架构.md` | 事件类型数量 61 → 64 |
| `docs/zelto-项目目标.md` | 事件类型数量 61 → 64 |
| `README.zh-CN.md` | 事件类型数量 61 → 64 |
| `tests/core/spec-conformance/` | 新增单元测试 |
| `tests/core/glossary/` | 新增单元测试 |
| `tests/acceptance/spec-check-command/` | 新增验收测试（真 CLI + 真 git 仓库） |
| `tests/acceptance/glossary-command/` | 新增验收测试（真 CLI 进程） |

**未改动**：`src/core/trace/`、`src/core/policy/`、`src/core/gate/`、
`src/core/sched/`、`src/core/slice/`、`contracts/schemas/` 里的其它契约、
`policy/`、`src/hook/`。

---

## 8. 教训

**「有出处」与「出处说的是不是同一件事」是两件事。**

追溯链查的是「这段代码有没有出处」，而符合性查的是「出处说了什么，代码做了没有」。
前者是**存在性**判定，后者是**一致性**判定。追溯链成立，不代表实现忠实。

**借鉴外部做法时，要连它的信任模型一起审视。**

mattpocock 的双轴 review 设计很好，但它是「两个 LLM subagent 并行判」——
结论是模型的判断。他那边成立是因为结论只当参考；zelto 要的是能进闸门的东西，
所以只能重做成确定性判定。**形态可借鉴，信任模型不可借鉴。**

**判据的局限要显式建模，不要藏进「通过 / 不通过」。**

「证据缺失」与「证据为负」分开成 `unknown` 与 `missing`，是为了不冤枉人。
同理，git 读不到时返回「读不到」而不是「没改动」——
与 ADR-059 的 `unknown` 三态同源。
