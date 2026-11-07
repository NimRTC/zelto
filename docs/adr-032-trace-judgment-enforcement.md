# ADR-032: 追溯判定接入冻结准入 + 门禁①退出码

**状态**: 已实施
**日期**: 2026-11-07
**作者**: 系统架构
**关联约束**: C1, C3, C4, C7
**关联文档**: `docs/adr-025-trace-judgment-single-source.md`, `docs/adr-016-spec-section-contract.md`,
`docs/zelto-项目目标.md` §3.1, `src/core/trace/judgment.ts`, `src/core/trace/severity.ts`,
`src/core/spec/trace-extract.ts`

---

## 1. 摘要

zelto 的立身之本是「agent 的每一行代码都能追溯到一条人批准的规格」。
但追溯判据 `judgeTrace()`（ADR-025 定的唯一真源）此前**没有挂在任何真正开跑之前的路径上**：

- `zelto freeze` 只算哈希、写 `spec.frozen`、转状态，从不查追溯；
- `zelto version start` 直接设 `frozenHash` 然后转 `FREEZE`，同样绕过；
- `Scheduler.admit()` 只查状态、冻结哈希、写集冲突，不查追溯。

结果：`version start` 创建的切片追溯全空（`slice/store.ts` 的默认值），
照样冻结、跑 agent、过门禁②、进签字队列。**承诺在主路径上没有被强制。**

本次定案：

1. **追溯准入成为硬闸门**：`freeze`、`version start`、`Scheduler.admit()` 三处都调同一套判据，
   追溯不合格 → 拒绝冻结 / 不予准入，并写事件留痕；
2. **严重分级**：需求追溯为空 = 阻断；契约 / 测试追溯为空 = 只提示（ADR-025 §4 已说明理由）；
3. **追溯引用的来源**：人显式声明 > 规格「验收标准 / 需求」章节物化 > 空（阻断）；
   新增 `zelto create|start --requirement <ref>` 作为「没有规格时人唯一能声明出处的入口」；
4. **门禁① 的退出码**：文本模式与 `--json` 模式对齐——有问题返回 1；
   同时把规格引擎（`validateDeterministic` / `analyzeSemantic`）接进 `check`，
   让「必须有验收标准章节」「不许有 TBD」这些判据第一次真正在真实流程里执行。

---

## 2. 为什么现在做

`docs/zelto-项目目标.md` §3.1 写的是「门禁① 拒绝冻结」。
但代码里门禁①是**建议**——`zelto check` 在文本模式下永远返回退出码 0，
规格引擎的完整判据器只有测试引用、CLI 里没有任何调用点。
承诺写在文档里、判定没接进流程，这正是 ADR-027 之后要避免的那种「配了但不拦」。

而且这条不补上，后面几件事都无从谈起：
规格生成器（ADR-034）产出的规格要有意义，前提是「追溯为空 = 不许跑」；
门禁②的切片级验收（ADR-033）要能说清「这片验证过」，前提是「这片有出处」。

---

## 3. 决策

### 3.1 追溯准入的三个入口

| 入口 | 位置 | 不合格时 |
|---|---|---|
| 冻结 | `src/cli/commands/core-slice.ts`（`zelto freeze`） | 拒绝冻结，退出码 1，打印缺哪条 + 怎么补 |
| 版本流水线冻结 | `src/cli/commands/ai-pipeline.ts`（`zelto version start`） | `BLOCKED`，退出码 1 |
| 调度准入 | `src/core/sched/engine.ts`（`Scheduler.admit()`） | `decision: 'blocked'`，写 `sched.blocked` 事件 |

三处都调 `core/trace` 的判据，**判定语义只有一处**（ADR-025 §2.2 说的腐化机制：
每个调用方各写一份「够不够追溯」，判定就会漂移）。调用方只负责把违例翻译成自己的呈现形式。

`Scheduler.admit()` 属 `core/sched/`：判据是纯计算、不调模型、不触网，合规（C3）。

### 3.2 严重分级：`core/trace/severity.ts`

ADR-025 定义了「什么算不合格」，但没定「不合格之后怎么办」。
本次补上这一层，同样收成唯一真源：

- `no_requirements` → **blocking**：需求追溯为空 = 这段代码没有出处，追溯链从根上断了。不许冻结、不许开跑。
- `no_contracts` / `no_tests` → **advisory**：只提示、写事件，不阻断。

**为什么契约与测试不硬拦**：这两条在很多切片上本就没有对应物（本片不改接口、本片不新增测试）。
工具无法可靠判定，硬拦只会逼人写假引用——假引用让追溯链「看起来完整而实际不是」，比缺失更有毒。
判定不合格的**分级**与判据本身一样属于判定，所以也放在 `core/trace/` 里，不允许各调用方自己分级。

### 3.3 追溯引用的来源与优先级

`src/core/spec/trace-extract.ts` 把「人写规格」与「切片要填 `trace.requirements`」之间的
确定对应关系抽成共享实现（`create --from-spec` 早就在做同样的事）：

1. **已声明优先**：人显式写下的 `slice.trace.requirements` 原样保留；
2. **规格物化**：没声明 → 从规格正文的「## 验收标准」章节取条目；
   该章节为空时退到「## 需求」章节（编号列表 `1. x` 与无序列表 `- x` 都认）；
3. **都没有** → 追溯为空 → 阻断。

物化结果会写回切片（`slice.trace.requirements`），所以追溯链里存的是**规格正文里的原文**，
不是指针，也不是工具编造的一句话。`spec.frozen` 事件同时记 `materializedRequirements`
与 `traceSource`（`spec` / `declared`），事后能看出这条出处是人写的还是从规格读出来的。

新增 CLI 入口 `--requirement`（`zelto create` / `zelto start` 均可，可重复给多条）：
人没有规格可解析时，这是他唯一能声明「这段代码为什么存在」的地方。

**豁免语义不变**（ADR-025 §3.1）：`slice.traceWaiver` 非空即整体豁免三条，
但必须写明理由（非空、非纯空白）。基线切片（`baseline === true`）不参与追溯链，不阻断。

### 3.4 门禁①的退出码与规格引擎接线

`zelto check`：

- 文本模式与 `--json` 模式**一致**：有问题返回 1，没问题返回 0。
  以前文本模式永远返回 0，作为门禁①没法被脚本或 hook 串联——那是 bug，不是语义。
  已完成 / 已放弃的切片仍然返回 0。
- 接入 `validateDeterministic`（确定性判据）：error 级 → 阻断项，warning / info 级 → 提示项。
  「追溯」与「哈希」两类由追溯判定与哈希比对负责，这里跳过，避免同一件事报两遍。
- 接入 `analyzeSemantic`（语义启发式）：**只作提示，不影响退出码**（C7：语义分析不参与判定，
  产出是给人审阅的报告）。
- `--json` 输出保持向后兼容（`sliceId` / `state` / `passed` / `issues` / `traces` / `advisories` 都在）。

### 3.5 验收路径缺失：提示级而非阻断级

`check` 以前把「验收测试路径不存在」列为阻断项。改为提示级：

- 验收测试跑不跑得通是**门禁②**的事（ADR-033 把切片级验收接进门禁②）；
- 门禁①只管「追溯到没追溯」与「规格写没写清楚」。
- 门禁①与门禁②各管一段，签字才有意义；一个门禁里塞两件事，等于两件都半吊子。

---

## 4. 被否决的方案

**方案一：追溯判定继续只当建议（现状）。**
否决理由：文档写「门禁① 拒绝冻结」，代码里门禁①不拒绝。承诺与实现不一致时，
工具的护栏就只是装饰。

**方案二：契约 / 测试追溯也硬拦。**
否决理由：见 §3.2。多数切片本就没有契约或新增测试，硬拦只会生产假引用。
假引用比缺失更有毒——它让「追溯链完整」这个信号失去意义。

**方案三：用切片标题充当需求追溯（`trace.requirements = [title]`）。**
否决理由：标题是人写的，但它是**一句话意图**，不是「人批准的规格」。
把它当出处，闸门就形同虚设——任何标题都能过闸门。
所以 `start` 写的占位规格**故意留空验收标准**，宁可让人被拦住，也不制造看着完整的空链。

**方案四：给占位规格自动写一条默认验收标准（「1. 完成 XXX」）。**
否决理由：同上——那句话会物化成本片的需求追溯，于是「追溯合格」变成 zelto 替人批准的需求。
另外 ADR-034 落地后，规格由 LLM 生成草稿、人确认，本来就不需要工具代填。

**方案五：新增事件类型（如 `trace.blocked`）。**
否决理由：事件类型是契约面，每加一个都要同步 schema、审计摘要、文档。
本次复用既有的 `spec.checked`（冻结准入判定）、`sched.blocked`（调度准入），
只在既有事件的 payload 上补字段——契约面不变大。

---

## 5. 影响与迁移

**破坏性变更（这是本次的主要代价，明说）**：

1. **没有需求追溯的切片不能冻结、不能被准入。**
   既有工作流（`zelto create` 后直接 `zelto freeze`）会开始失败。补法三选一：
   - 在规格里写「## 验收标准」（编号条目）→ 冻结准入会自动物化；
   - 建切片时给 `--requirement "<需求引用>"`；
   - 确实不参与追溯，写豁免理由：`zelto set <id> --field traceWaiver --value "<理由>"`。
2. **`zelto check` 的退出码变了**：有问题 = 1。依赖「check 永远返回 0」的脚本需要改。
3. **`zelto start` 在没有追溯出处时不再自动冻结**，会停下来告诉人怎么补。
4. **既有测试里「建切片 → 冻结 → 跑」的老套路全部需要声明追溯**，
   这些用例改的是测试的**准备动作**（补一句 `--requirement`），断言的语义没变。

**契约面变化**：

- `spec.frozen` 事件 payload 新增 `materializedRequirements`（数字）与 `traceSource`
  （`'spec'` / `'declared'`）——只新增字段，不改既有字段；
- CLI 新增 `--requirement`（可重复）；
- 规格章节契约新增**非必备**概念 `Requirements`（别名 `Requirement` / `需求`），
  用于「先列需求、再列验收标准」的那种规格写法。缺它不构成规格缺陷。

**没有改的东西**：`slice.json` 的 schema 没变（`trace.requirements` 本来就是字符串数组）、
事件类型集合没变、`policy.yaml` 没变、`contracts/schemas/` 没变。

---

## 6. 验证方式

- 新增单元测试 `tests/core/trace/freeze-enforcement.test.ts`：
  追溯为空时冻结被拒、有豁免时放行、规格物化出追溯、声明优先于物化、
  `Scheduler.admit()` 拦截追溯不合格的切片、`check` 文本模式退出码语义、
  契约 / 测试追溯为空只提示不阻断。
- 全量测试 `pnpm test` 全绿（1233 个用例），`pnpm lint` 无错。
- 手工核对：`zelto create x --title "试试"` 后 `zelto freeze x` 应被拒绝并给出补法；
  `zelto create x --title "试试" --requirement "R1: 试试"` 后 `zelto freeze x` 应成功。
