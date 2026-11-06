# ADR-030: 基线设计重建与架构护栏落地

**状态**: 已实现
**日期**: 2026-11-06
**作者**: 系统架构
**关联约束**: C1, C2, C3, C4, C5, C7
**关联文档**: `docs/adr-029-design-body-as-module-source.md`, `docs/adr-027-arch-guard-policy.md`,
`policy/policy.yaml`, `policy/lock.json`, `scripts/rebuild-baseline-design.mjs`,
`.zelto/design/prj-1793964817452.json`

---

## 1. 摘要

ADR-029 把架构报告的噪声从 213 条降到 2 条，并在 §9 留下三个待人拍板的问题。本次一并定下：

| 问题 | 决策 |
|---|---|
| **Q1 模块粒度** | 两层：顶层目录 + 5 个 `core` 子模块（`gate` / `policy` / `sched` / `slice` / `events`），共 19 个模块 |
| **Q3 两条真偏离** | 两条都**改设计**（不改代码）：`src/hook` 去掉 `src/core` 依赖；`tests` 补 `src/llm` |
| **Q2 strict 策略** | `policy.yaml` 加 `arch:` 段，只把 `cycle` 一类放开成 `ask`，其余保持默认 `deny` |

结果：新基线设计 `prj-1793964817452`（supersedes `prj-1793947716547`），
`zelto arch check` 只剩 **1 条偏离**——`src/core/gate` ↔ `src/core/slice` 依赖成环；
`zelto arch check --strict` 退出码 0（该条按 `ask` 处理，只标注不拦）。

同时更正 ADR-029 的一处说法：那个「环」不是**真实代码环**（§4）。

---

## 2. 为什么现在做

ADR-029 的 2 条偏离只是**顶层粒度**下能看到的全部。顶层粒度有两个盲区：

1. **看不见 core 内部的边界**——`core/gate` ↔ `core/slice` 的互相引用被 `src/core`
   一个模块整个盖住，报告里看不出 core 内部谁依赖谁；
2. **看不出声明的宽窄**——`src/core` 一个模块管着 75 个文件、20 多个子目录，
   「它依赖谁」只能给出 `src/core` 这种粗粒度答案，声明写宽了写窄了都查不出来。

粒度是因，偏离是果，策略配置是果的果——ADR-029 §9 Q2 已经点明这个顺序：
**粒度定完、基线重建、偏离重算之后，Q2 的具体配置才能定。**

---

## 3. 决策

### 3.1 Q1：两层粒度，5 个 core 子模块

模块集 = 原 14 个顶层模块 + 5 个 `core` 子模块 = **19 个**。

选这 5 个的判据是 ADR-029 §4.2.3 的那条：**与 `core` 内其它模块之间存在实际 import 边**。
实测边（来自 zelto 自己的扫描）：

| 子模块 | 出边（到别的子模块） | 入边来源 |
|---|---|---|
| `src/core/gate` | → `src/core/events`, → `src/core/slice` | `src/core/slice` |
| `src/core/policy` | （无） | `src/core/sched` |
| `src/core/sched` | → `src/core/events`, → `src/core/policy`, → `src/core/slice` | `src/core` |
| `src/core/slice` | → `src/core/gate` | `src/core`、`gate`、`sched` |
| `src/core/events` | （无） | `src/core`、`gate`、`sched` |

写法上两条硬约束（ADR-029 §4.2）：

1. 父模块 `src/core` 的依赖声明写成**纯列表**，不能带 `[无]（作为核心层…）` 这类占位前缀
   ——带前缀会把整行解析成只有一个条目，兄弟之间的边全变成「未声明依赖」；
2. 每个子目录显式列为模块，文件范围写成 `src/core/<name>/**/*.ts`。

子模块自己的依赖声明与实际 import 边**逐条对齐**——不多写（多写就是「缺失依赖」），
不少写（少写就是「未声明依赖」）。

`src/adapters` 的声明保持 `src/core/ports`, `src/core/events` 不动：
`src/core/ports` 按 ADR-029 §3.5 的归属解析规则落到 `src/core` 这一片，
人读起来仍然知道「adapters 只用 core 的 ports 与 events 两块」。

### 3.2 Q3：两条偏离都改设计，不改代码

| 偏离 | 处置 | 依据 |
|---|---|---|
| `src/hook` 声明依赖 `src/core`，代码里没有 | **改设计**：删掉这条依赖 | `src/hook/` 按 AGENTS.md 是**可独立编译**的判定进程。实测它的 import 只有 `node:*` 内置模块与同目录的 `./protected.js`——设计写的 `src/core` 从来就不成立。约定与设计冲突时，约定优先 |
| `tests` → `src/llm` 未声明 | **改设计**：补上这条依赖 | `tests/annotate.test.ts`、`tests/llm-generators.test.ts` 确实 import 了 `src/llm`。改测试去绕开它不成立——测试本来就该覆盖 `llm/` |

两条都改设计、不改代码：第一条是设计写错了，第二条是设计漏写了。
「改代码让设计变对」是倒因为果——设计是**人批准的规格**，它错了就改设计，
不是改代码去迎合一份写错的规格。

### 3.3 Q2：`arch:` 段只放开 `cycle`

```yaml
arch:
  - kind: cycle
    action: ask
    basis: "policy.yaml#arch-cycle"
    guidance: "core/gate <-> core/slice 是类型级互引；SliceType 归属定下来后可收紧为 deny。"
```

**为什么只放开这一类**：重建之后其余五类硬偏离全部归零（缺失依赖 0、未声明依赖 0、
未知模块 0、归属歧义 0、无归属文件 0），没有别的需要放开。
未列出的类别保持默认 `deny`（fail closed），收紧条件写在注释里。

`ask` 而不是 `allow`：证据留在报告里（条目照常列出），但不拦人——
这正是 ADR-027 §3.2 给 `ask` 的定位。

**收紧条件**（写在 `policy.yaml` 注释里，事后可查）：
`SliceType` 的归属定下来、`slice` 不再依赖 `gate` 之后，把这条改回 `deny`（或直接删掉，
回到默认 deny）。

### 3.4 锚点重算（C5）

`policy.yaml` 改了内容，锚点必须跟着重算，否则审计时「当时按什么标准拦的」说不清。

- 口径按 ADR-027 §4：**`policy.yaml` 全文的 sha256**；
- 新锚点：`sha256:0191547f9768d688faec3f09754f1f5716af7a4485f11d06ce1e5b1a45bee7b4`；
- `lockedBy` 从 `system` 改成 `human`——这次是策略改动，由人拍板。

顺带记一笔：改之前的锚点（`sha256:2a30463e…`）与当时 `policy.yaml` 的内容哈希
（`sha256:c9ad1442…`）**对不上**，是脚手架期留下的占位值，从来没对过。
本次按 ADR-027 的口径重算，锚点从此是真的。

---

## 4. 一处必须更正的说法

ADR-029 §4.3 与 §9 把 `gate` ↔ `slice` 称作「**真实的代码环**」。**这句话是错的**，本次实测纠正：

- **文件级没有环**：`src/core/gate/types.ts` 一个 import 都没有（只有 `interface` 与函数声明）；
- **模块级有环**：`core/gate/executor.ts`、`core/gate/sign.ts` import `core/slice/store.ts`；
  `core/slice/store.ts`、`core/slice/types.ts` import `core/gate/types.ts`（只为 `SliceType` 这个类型）；
- 所以这是**模块粒度的产物**——把一组「只有类型级互引」的文件聚成一个模块之后，
  图上就出现了环。

这个区别直接决定处置方式：**文件级环要改代码**（真循环依赖），
**模块级环要先问「模块边界画对了吗」**。

`SliceType`（`'code' | 'docs' | 'config' | 'refactor'`）是**切片的分类**，
语义上属于 `slice`，却定义在 `gate`——这正是边界画歪了的信号：
`gate`（门禁执行）不该是切片类型定义的家。处置见 §7。

---

## 5. 实施

| 内容 | 位置 |
|---|---|
| 基线重建脚本（确定性改写 + 自带报告，可重跑） | `scripts/rebuild-baseline-design.mjs` |
| 新基线设计 | `.zelto/design/prj-1793964817452.json`（supersedes `prj-1793947716547`） |
| 事件（C4） | `.zelto/events/draft-design-prj-1793964817452/events.jsonl`：`draft.created`（actor `zelto`）+ `draft.confirmed`（actor `human`） |
| 护栏配置 | `policy/policy.yaml` 的 `arch:` 段 |
| 锚点 | `policy/lock.json` |

旧基线 `prj-1793947716547` 标为 `superseded`，与 `zelto project design` 的顶替语义一致
（`pickDefaultDesign` 靠 `requirementId === '__project__'` + `status === 'confirmed'` 认基线，
两份都 confirmed 会让「最新基线」说不清）。

重建脚本只做**确定性改写**：读旧正文 → 逐条带断言的替换 → 用 zelto 自己的判定路径
（`parse` → `derive` → `scan` → `report`）验一遍 → 写盘 + 追加事件。
每条替换都要求**恰好命中一次**，命中 0 次或多次直接报错退出。

---

## 6. 约束合规检查

| 约束 | 检查 | 合规 |
|---|---|---|
| **C1** | 状态仍在文件里：设计在 `.zelto/design/*.json`，事件在 `.zelto/events/*/events.jsonl`，锚点在 `policy/lock.json`；未新增内存状态或常驻进程 | ✅ |
| **C2** | 重建脚本在 `scripts/`（不进 `core/`），只 import `dist/` 里的既有模块；`core/` 未改 | ✅ |
| **C3** | 重建与校验全程确定性：正文改写是字符串替换，判定走既有的纯计算路径，不调模型、不触网 | ✅ |
| **C4** | 本次基线重建写了 `draft.created` / `draft.confirmed` 两条事件（append-only，未改旧事件） | ✅ |
| **C5** | 保护域与 `PROTECTED_PATTERNS` 完全未动；策略锚点按「policy.yaml 全文 sha256」重算并记明口径与批准人 | ✅ |
| **C7** | 全程不涉及模型产出；新设计正文是对**已批准基线**的确定性改写，不是新生成的规格 | ✅ |
| **C9** | 写集预约与逐写判定完全未动；`src/hook` 的解析逻辑未改，只改了设计里的依赖声明 | ✅ |

禁区检查：未新增自动批准、自动合并、自动改规格。
设计正文的改动是**人拍板的产物**（本次三个待决问题一次定完），且改了内容、留了事件、
旧版本标 superseded——**不是**「自动改规格」。

---

## 7. 后果

**好的**

- 报告从 2 条偏离降到 1 条，且剩下这 1 条条条可讨论；
- `core` 内部的依赖形状第一次看得见（谁依赖谁、依赖是不是声明了）；
- 护栏有了一条**明确的、可审计的**标准：`--strict` 现在能过，且不是因为「没配所以不拦」，
  而是因为按 `arch:` 段算下来确实只有一条 `ask`；
- 锚点从「从来没对过的占位值」变成真值。

**代价与边界**

- 设计模块数从 14 涨到 19，写设计时要多守两条规则（父模块纯列表、子目录显式列模块）——
  这两条已写进 ADR-029 §4.2 与本文 §3.1；
- 本次是**用 zelto 检查 zelto 自己**：能验证「粒度改动对报告的影响」，
  不能独立验证判定逻辑本身是对的（同 ADR-029 §4.3.1 的效力边界）；
- `cycle: ask` 是**临时豁免**，不是终点。它的存在本身就是 §7 遗留项的提醒。

**明确不做**

- 不改 `SliceType` 的归属（那是代码改动，需另一次拍板，见 §8）；
- 不新增事件类型表达「设计被顶替」；
- 不把 `ask` 当成「已处置」——条目一直在报告里。

---

## 8. 遗留（需人拍板）

**`SliceType` 该住在哪。** 它现在是切片的分类，却定义在 `core/gate/types.ts`，
于是 `core/slice` 反过来依赖 `core/gate`，成环。

建议：`SliceType` 移到 `core/slice/types.ts`（它本来就是切片的分类），
`core/gate/types.ts` 保留 re-export 兼容现有 import 路径，
`detectSliceType` 留在 gate（它是门禁逻辑）。改完 `slice` 不再依赖 `gate`，环消失，
`policy.yaml` 里那条 `cycle: ask` 就可以删掉，回到默认 `deny`。

这是一次代码改动（触及 `core/slice` 与 `core/gate` 的边界），
按 AGENTS.md「遇到不确定时停下来问，不要自己选」，本次**没有动**，留给下一次决定

> **已解决（2026-11-06）**：由 ADR-031 定案。落点与本节建议有一处不同——
> SliceType 移到了新文件 core/slice/kind.ts 而非 core/slice/types.ts，
> 因为后者会与 store.ts 形成文件级互引环（详见 ADR-031 §3.1）。
> gate 侧保留 re-export、detectSliceType 留在 gate，与本节建议一致。
> 环已消失，policy.yaml 的 cycle: ask 豁免已撤销。。

---

## 9. 验收标准

1. `zelto arch check` 对新基线输出 1 条偏离，且是 `src/core/gate` ↔ `src/core/slice` 的成环。
2. `zelto arch check --strict` 退出码 0，输出把该条标为「待人确认（不拦，只标注）」。
3. `zelto policy validate` 通过。
4. 旧基线 `prj-1793947716547` 状态为 `superseded`，新基线为唯一 confirmed 的 `__project__` 设计。
5. `.zelto/events/draft-design-prj-1793964817452/events.jsonl` 里有 `draft.created` 与 `draft.confirmed`。
6. `npm run build` / `npm run lint` / `npm test` 全绿。

**达成情况**（2026-11-06）：1–6 全部达成。实测 `zelto arch check` 输出 1 条偏离
（依赖成环），`--strict` 退出码 0，`zelto policy validate` PASSED。

---

## 10. 关联 ADR 的状态更新

- **ADR-029** §9 的 Q1 / Q2 / Q3 三个待决项，由本文定案；
  §4.3 与 §9 里「真实代码环」的表述已按本文 §4 更正。
- **ADR-027** 的 `arch:` 段机制不变，本次只是**用上了它**（第一次在本仓配）。
