# ADR-025: 追溯判据单一真源 —— `core/trace`

**状态**: 已实现
**日期**: 2026-11-05
**作者**: 系统架构
**关联约束**: C2, C3, C4
**关联文档**: `AGENTS.md`, `docs/zelto-项目目标.md`（§3.1）,
`docs/zelto-技术架构.md`, `src/core/trace/judgment.ts`

---

## 1. 摘要

「这个切片有没有可追溯的出处」此前有三份实现，三份语义还不一样：

| 位置 | 需求 | 契约 | 测试 | 豁免的作用 |
|---|---|---|---|---|
| `core/spec/deterministic/validator.ts` | 查 | 不查 | 不查 | 豁免全部三条 |
| `src/cli/commands/core-slice.ts`（`zelto check`） | 查 | 查 | 查 | 只豁免契约 |
| `core/sched/batch.ts`（`zelto batch`） | 查 | 查 | 查 | 只豁免契约 |

同一个切片走三条路能得出三种结论。追溯链就是这样腐化的——判定一旦分散，
就没有一处能说清「凭什么这个切片算合格」。

本 ADR 把追溯判据收敛到**一个纯函数**：`core/trace/judgment.ts` 的 `judgeTrace()`。
三处调用方都调它，只负责把结论翻译成各自的呈现形式（严重级别、退出码、文案）。

判定语义（三条追溯各自独立，豁免整体生效）：

1. 需求（requirements）不得为空——证明代码出处
2. 契约（contracts）不得为空——证明接口边界
3. 测试（tests）不得为空——证明可验证

豁免（`traceWaiver`）：非空理由字符串即**整体豁免这三条**，语义是
「本片不参与追溯」，所以必须写明理由（`docs/zelto-项目目标.md` §3.1）。

---

## 2. 动机

### 2.1 现状

三份实现散在三个模块里，各自硬编码「哪几条要查、豁免能免哪几条」：

- `validator.ts` 是规格校验路径，只看需求一条，且豁免能免它；
- `zelto check` 是门禁①，三条都查，但豁免只免契约；
- `reviewBatch` 是批量审核，三条都查，豁免也只免契约。

于是：

- 一个有豁免但没需求引用的切片，`zelto check` 会拦它，`zelto batch` 也会拦它，
  而规格校验一声不吭；
- 一个缺契约引用的切片，`validator` 放行，另两处拦截；
- 豁免到底能免什么，取决于从哪个模块进来。

### 2.2 为什么不是「各自保持现状、只补文档」

追溯判据是**判定**，不是展示。判定分散意味着同一个事实有多份真相，
而「多份真相」正是追溯链腐化的机制本身。补文档不解决问题：
三份语义仍然会各自漂移。

### 2.3 为什么不是「合并成一个更大的检查器」

门禁①、批量审核、规格校验的**呈现**本来就不同：严重级别不同（error vs warning）、
退出码不同、文案不同。这些差异是合理的，不该被抹平。

所以拆成两层：**判据一层**（唯一），**呈现一层**（各表）。
判据层是纯函数，只读数字、不调模型、不触网（C3）。

---

## 3. 决策

### 3.1 判据层 — `src/core/trace/judgment.ts`

```typescript
export interface TraceCounts {
  requirements: number;
  contracts: number;
  tests: number;
}

export type TraceViolationCode = 'no_requirements' | 'no_contracts' | 'no_tests';

export interface TraceViolation {
  code: TraceViolationCode;
  message: string;  // 中文说明（审核文案用）
  short: string;    // 英文短句（CLI 逐行提示用）
}

export interface TraceJudgment {
  waived: boolean;
  waiverReason: string | null;
  violations: TraceViolation[];  // 固定顺序：需求 → 契约 → 测试
  ok: boolean;
}

export function judgeTrace(input: TraceJudgmentInput): TraceJudgment;
export function traceCountsOf(trace: {
  requirements: string[]; contracts: string[]; tests: string[];
}): TraceCounts;
```

约束：

- 确定性纯函数：同输入必得同输出（C3）。
- `core/` 零第三方依赖、不 import `adapters/`（C2）。
- 豁免理由为 `null` / 空串 / 纯空白，一律视为**未豁免**——豁免必须写明理由。
- 违反项按需求→契约→测试的固定顺序输出，便于跨调用方对账。

### 3.2 呈现层 — 三处调用方

| 调用方 | 呈现 | 豁免时的行为 |
|---|---|---|
| `core/spec/deterministic/validator.ts` | `category: 'trace'`、`severity: 'warning'`，每个违反项一条 issue | 无 issue |
| `src/cli/commands/core-slice.ts`（`zelto check`） | 逐行 `violation.short`，计入 `spec.checked` 事件与退出码 | 不报追溯问题 |
| `core/sched/batch.ts`（`reviewBatch`） | 每条违反项一个 `error` 级 issue，`code` 直接用 `violation.code` | 不报追溯问题 |

三者都只做**翻译**，不再各自判断「够不够追溯」。

### 3.3 行为变化（有意为之）

统一后有两处与旧行为不同，都是往「更一致」的方向走：

1. **豁免现在整体生效**。旧的门禁①与批量审核里，豁免只免契约；
   现在豁免免掉全部三条。这与豁免的本意（「本片不参与追溯」）一致，
   也让「有豁免的基线切片」在三条路径上得出同一个结论。
2. **规格校验现在也报契约与测试的缺失**。旧版只报需求缺失；
   现在三条缺哪条报哪条（仍是 warning 级，不阻断）。

`BatchMember.traceWaiver` 的类型随之从 `boolean` 改为 `string | null`，
以便把**豁免理由**一路带到判定层（原来是「有没有豁免」的二值信息，
丢掉了理由，理由才是豁免的凭据）。`slice.json` 的契约本来就声明
`traceWaiver` 为 `["string","null"]`，无需改 schema。

---

## 4. 实现位置

| 内容 | 位置 |
|---|---|
| 判据纯函数 | `src/core/trace/judgment.ts` |
| 模块出口 | `src/core/trace/index.ts` |
| 规格校验接入 | `src/core/spec/deterministic/validator.ts`（`checkTraceConsistency`） |
| 门禁①接入 | `src/cli/commands/core-slice.ts`（`zelto check`） |
| 批量审核接入 | `src/core/sched/batch.ts`（`reviewBatch`） |
| 事实读取（豁免理由） | `src/cli/commands/batch-facts.ts`（`traceWaiver` 传原始字符串） |
| 判定测试 | `tests/core/trace/judgment.test.ts` |
| 语义回归测试 | `tests/batch-review.test.ts`、`tests/spec-engine.test.ts` |

`DeterministicCheck.check` 的返回类型由 `SpecIssue | null` 改为 `SpecIssue[]`——
一次检查可以报出多条问题（追溯三条各缺一条就是三条），否则只能报第一条、
把另外两条丢掉。

---

## 5. 约束合规检查

| 约束 | 检查 | 合规 |
|---|---|---|
| **C1** | 判据是纯函数，不落盘、不持状态 | ✅ |
| **C2** | `core/trace` 只用 Node 内置（零依赖），不 import `adapters/` | ✅ |
| **C3** | 只读数字、纯计算，无模型无网络 | ✅ |
| **C4** | 判据本身不写事件；门禁①仍按原路径追加 `spec.checked` | ✅ |
| **C7** | 判据不涉及任何 LLM 产出 | ✅ |

禁区检查：未新增自动批准、自动合并、自动改规格行为；
豁免仍须人工写明理由，不自动生成。

---

## 6. 后果

**好的**

- 「凭什么算合格」只有一个地方能回答：`src/core/trace/judgment.ts`。
- 三条路径对同一个切片给出同一个结论，追溯链不再因入口不同而腐化。
- 新增第四条追溯检查路径时，只需调 `judgeTrace`，不再复制判据。

**代价与边界**

- 豁免语义变宽（整体免三条），旧切片里「只靠豁免免契约」的写法现在也免需求与测试。
  这是有意的：豁免的本意就是「本片不参与追溯」。
- `BatchMember` 的 `traceWaiver` 类型变了，外部构造该结构的调用方需同步改
  （仓库内只有 `batch-facts.ts` 与测试）。

**明确不做**

- 不让判据层写事件、不让判据层决定退出码——那些是呈现层的事。
- 不新增「部分豁免」（只免契约不免需求）这种语义——豁免要么整体要么没有。

---

## 7. 验收标准

1. `judgeTrace` 的判定与豁免语义由 `tests/core/trace/judgment.test.ts` 守住。
2. 缺需求、缺契约、缺测试分别被报出，顺序固定为需求→契约→测试。
3. 豁免理由非空时三条都不报；理由为空串或纯空白时照常报。
4. `reviewBatch` 的 issue `code` 与 `judgeTrace` 的 `violation.code` 一致。
5. `zelto check` 输出的追溯提示文案来自 `violation.short`。
6. 三处调用方不再出现「`trace.X.length === 0`」这类就地判定。
