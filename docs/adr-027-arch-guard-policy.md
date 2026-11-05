# ADR-027: 架构护栏 policy 可配置（G-4/A）—— 硬偏离做成规则

**状态**: 已实现（四处执行点全部接通）
**日期**: 2026-11-05
**作者**: 系统架构
**关联约束**: C1, C2, C3, C4, C5
**关联文档**: `docs/zelto-项目目标.md`（§6 D3、§6.1）, `docs/zelto-技术架构.md`（§8.1）,
`src/core/arch/report.ts`, `src/core/policy/types.ts`, `contracts/schemas/policy.json`

---

## 1. 摘要

`zelto arch check`（G-4/B）已经能列出七类偏离，但它只是一份报告：`--strict`
对所有硬偏离一视同仁地返回 1，没有「哪类要拦、哪类只看」的配置能力。
不同项目的容忍度不同（一份原型里 `unmapped_file` 遍地都是，硬拦等于没法用），
所以「拦不拦、拦哪类」必须是项目自己的策略，而不是 zelto 写死的行为。

本提案把**六类硬偏离**做成 `policy.yaml` 里可选的 `arch:` 段，
每类配一个沿用现有语义的动作（`deny` / `ask` / `allow`）：

```yaml
arch:
  - kind: undeclared_dependency
    action: deny
    basis: "policy.yaml#arch-undeclared"
  - kind: unmapped_file
    action: ask
    basis: "policy.yaml#arch-unmapped"
    guidance: "原型阶段先只看，交付前再收紧为 deny。"
```

软偏离（`unverifiable_dependency`）**不可配、永不拦**——目标模块没有源文件，
本来就无从验证，配了也是噪声。

执行点有四处：`zelto arch check --strict`（整图结论直接定退出码）、
`version deliver`（整图结论作为交付门）、`batch` 准入与单片 `gate`
（只看与本片写集相关的偏离，无关模块的漂移不拦干净切片，切片级过滤见 §3.7）。
不带 `--strict` 的 `arch check` 永远是纯报告（退出码 0），不受配置影响。

---

## 2. 动机

### 2.1 现状：`--strict` 只有一档

`buildArchitectureReport()` 的 `ok` 定义是「没有任何硬偏离」
（`SOFT_DEVIATIONS = { unverifiable_dependency }`），`--strict` 在 `!ok` 时返回 1。
六类硬偏离（未声明依赖 / 缺失依赖 / 未知模块 / 归属歧义 / 无归属文件 / 依赖成环）
在退出码面前完全等价：一个漏网的 `loose.ts`（`unmapped_file`）和一个真正的
依赖成环（`cycle`）拦下来的力度一样。

### 2.2 为什么不是「给 `--strict` 加 `--tolerate <kind>` 参数」

命令行参数是**每次调用的人的决定**，策略是**项目的决定**。
护栏的意义在于「项目定一次，到处都这么执行」：CI 里跑的 `arch check --strict`
和人本地跑的应该是同一套标准。参数每次都能不一样，标准就立不住。
而且参数不进 `policy/lock.json` 的哈希锚点，事后审计说不清「当时按什么标准拦的」。

### 2.3 为什么不是「逐写拦截 import」

`hook` 的逐写判定看到的是「一次写一个文件」，而模块依赖是**事后整图**：
`a.ts` 里多一行 `import '../db'` 是否越界，要等全图扫完、归属算完才知道。
逐写时没有图，只能做保守拒绝（误拦正常开发）或放行（等于没拦）。
架构护栏天然是「图出来之后再判」，执行点只能是报告消费处，不能是写时。

---

## 3. 决策

### 3.1 硬 / 软划分（沿用现有 `ok` 定义，不改）

| 类别 | 包含 | 可配 | 行为 |
|---|---|---|---|
| 硬偏离（6 类） | `undeclared_dependency`、`missing_dependency`、`unknown_module`、`ambiguous_module`、`unmapped_file`、`cycle` | ✅ | 默认 `deny`（即现状）；可逐类改 `ask` / `allow` |
| 软偏离（1 类） | `unverifiable_dependency` | ❌ | 永不计入结论，只报告 |

`report.ts` 的 `SOFT_DEVIATIONS` 与 `ok` 定义**不动**——G-4/B 的报告语义是基线，
护栏只是在它上面多一层「按项目策略重算结论」，不改报告本身的内容。

### 3.2 动作语义（复用 `Decision`，不新增枚举）

| 动作 | 含义 | `--strict` 下 |
|---|---|---|
| `deny` | 该类出现即不一致 | 计入失败，退出码 1 |
| `ask` | 该类出现即待人确认 | 只报告（标注待确认），退出码 0 |
| `allow` | 该类忽略 | 不计入结论（报告里仍列出，证据不丢） |

报告内容永远完整——`allow` 只是不计入结论，不删除条目。
「证据齐全、结论可配」：审计时看得到全貌，拦人时只按项目定的标准。

### 3.3 契约变更

`contracts/schemas/policy.json` 加可选顶层 `arch`：

```json
"arch": {
  "type": "array",
  "items": {
    "type": "object",
    "required": ["kind", "action", "basis"],
    "properties": {
      "kind": { "enum": ["missing_dependency", "undeclared_dependency", "ambiguous_module", "unmapped_file", "unknown_module", "cycle"] },
      "action": { "enum": ["allow", "deny", "ask"] },
      "basis": { "type": "string" },
      "guidance": { "type": "string" }
    }
  }
}
```

`src/core/policy/types.ts` 同步加：

```typescript
export type ArchDeviationKind =
  | 'missing_dependency' | 'undeclared_dependency' | 'ambiguous_module'
  | 'unmapped_file' | 'unknown_module' | 'cycle';

export interface ArchGuardRule {
  kind: ArchDeviationKind;
  action: Decision;
  basis: string;
  guidance?: string;
}

export interface PolicyConfig {
  rules: PolicyRule[];
  protected?: string[];
  arch?: ArchGuardRule[];
}
```

校验规则（`core/policy/validator.ts`）：`kind` 非法、重复 `kind`、
缺 `basis` 均为错误；`arch` 缺席即默认（§3.4）。

### 3.4 默认行为（完全兼容现状）

没有 `arch:` 段时，所有六类硬偏离视为 `deny`——等价于今天的 `--strict`。
已有项目不改任何文件，行为零变化。

### 3.5 执行点（四处，全已接通）

- `zelto arch check --strict`：扫图 → 出报告 → 用 `arch:` 配置重算结论 →
  有 `deny` 类偏离则退出码 1，否则 0。`--json` 输出里多带一份按配置算出的
  `guard` 结论（报告原文不动）。
- 不带 `--strict`：纯报告，退出码恒 0，不读配置。
- `zelto version deliver`：整图结论作为交付门 —— 扫主仓、读主仓的设计与
  policy，有 `deny` 类偏离则交付验收失败（状态保持 `in_progress`）。
  无确认设计时跳过（老项目无感）；`ask` 只提示不拦。
- `zelto batch` 准入：整图只扫一次，逐片按写集过滤（语义见 §3.7）——
  `deny` 转 `error`（阻断开工，`code: arch_guard_blocked`），
  `ask` 转 `warning`（只提示，不阻断，`code: arch_guard_confirm`）。
  无确认设计时整段跳过。`batch` 是只读命令，不写事件。
- `zelto gate`（含 `run` 后的自动门禁）：与 `batch` 同一口径的切片级结论，
  设计与策略读主仓、源码扫门禁实际跑的目录（worktree 优先）。
  `deny` 拦（退出码 1，不进门禁、不改状态），`ask` 只提示。
  `--dry-run` 与 `--only` 时不拦（不是完整门禁）。

### 3.6 判定与呈现分层（学 ADR-025）

新增 `src/core/arch/guard.ts`，纯函数：

```typescript
export function judgeArchGuard(
  report: ArchitectureReport,
  guard?: ArchGuardRule[],
): { perKind: Array<{ kind, action, count, blocked }>; blocked: boolean };
```

`report.ts` 不动（只报告），`guard.ts` 只算结论（C3），
`architecture.ts` 只做翻译（退出码 + 输出）。三层各干各的。
`batch` / `gate` / `deliver` 共用 `cli/commands/arch-guard.ts` 的接线层
（`loadWholeGraphGuard` 只读文件，不写状态，C1）。

### 3.7 切片级过滤（batch / gate 只看与本片写集相关的偏离）

整图结论直接拦 `deliver` 没问题——交付验的是整体。但 `batch` 准入与单片
`gate` 拦的是「这一片能不能动」：A 模块的漂移不该拦住只碰 B 模块的干净切片，
否则并行开发会被无关的红灯卡死。所以切片级先按写集过滤、再按 `arch:` 定级
（`judgeSliceArchGuard`：过滤与定级一次完成，返回过滤后的偏离供展示）。

相关性规则（`isDeviationRelevantToSlice`）：

- `unmapped_file`：`to` 即文件路径，落在写集内才相关
- `ambiguous_module`：`detail` 里引用的文件落在写集内才相关
- `cycle`：环上任一模块与写集相交即相关
- 边类（未声明 / 缺失 / 无法验证）：`from` 或 `to` 任一端是相关模块即相关
- `unknown_module`：`to` 在设计里不存在，只能看 `from` 端
- 软偏离与未知 kind：永不相关（本来就不拦）

「相关模块」指 `filePatterns` 与写集有交集的模块。过滤返回新数组，不改原报告。

---

## 4. 实现位置

| 内容 | 位置 |
|---|---|
| 护栏类型 | `src/core/policy/types.ts` — `ArchDeviationKind` / `ArchGuardRule`，`PolicyConfig.arch?` |
| 护栏判定（纯函数） | `src/core/arch/guard.ts` — `judgeArchGuard()` 整图结论、`judgeSliceArchGuard()` 切片级（先过滤再定级）、`buildArchRelaxSnippet()` 可复制放开片段 |
| 接线层（唯一碰文件处） | `src/cli/commands/arch-guard.ts` — `loadWholeGraphGuard()`（找确认设计→扫图→出报告→定级）、`sliceGuardForWrites()`、`sliceGuardIssue()`、`checkSliceGateGuard()`、`describeGuardKinds()` |
| policy 解析 | `src/core/policy/yaml.ts` — 容忍并解析顶层 `arch:` |
| policy 校验 | `src/core/policy/validator.ts` — `kind` 枚举 / 去重 / `basis` 必填；顶层键白名单加 `arch` |
| hook 解析 | `src/hook/pretool.ts` — `parsePolicyRules()` 忽略 `arch:`（逐写路径不受影响，见 §2.3） |
| 命令接入 | `src/cli/commands/architecture.ts` — `--strict` 用护栏结论算退出码，`--json` 附 `guard`，放开片段按已配规则重算；`ai-pipeline.ts`（`version deliver` 整图门）、`batch.ts`（准入）、`gate-sign.ts` + `run-support.ts`（单片门禁） |
| 策略加载 | `src/cli/commands/shared.ts` — `loadPolicyConfig(root?)`，接线层按 `designRoot` 读主仓策略（gate 扫 worktree 时不丢 ask/allow 配置） |
| schema 真源 | `contracts/schemas/policy.json` — 可选 `arch` 数组 |
| 判定测试 | `tests/arch-guard.test.ts`（`judgeArchGuard` 直测：默认全 deny、逐类 ask/allow、重复 kind 报错；切片过滤；接线层；校验层） |
| 命令测试 | `tests/architecture.test.ts`（带 `arch:` 配置的 `--strict` / `--json` 行为） |

`policy/lock.json` 格式不变——哈希本来就是对整个 `policy.yaml` 内容算的，
`arch:` 段自动进锚点，事后可审计「当时按什么标准拦的」（C5）。

---

## 5. 约束合规检查

| 约束 | 检查 | 合规 |
|---|---|---|
| **C1** | 不新增状态位置；`arch:` 活在 `policy.yaml` 里，随现有文件读写 | ✅ |
| **C2** | `core/arch/guard.ts` 只用 Node 内置，不 import `adapters/` | ✅ |
| **C3** | `judgeArchGuard` 纯计算：输入报告 + 配置，输出结论；不调模型、不触网 | ✅ |
| **C4** | 不新增事件类型（`arch check` / `batch` 保持只读，退出码即信号；`gate` / `deliver` 走它们已有的事件路径） | ✅ |
| **C5** | 护栏只给偏离定级，不授予任何写权限，与保护域正交；策略改动照旧受 `lock.json` 锚点约束 | ✅ |
| **C7** | 不涉及任何 LLM 产出 | ✅ |

禁区检查：未新增自动批准、自动合并、自动改规格；`allow` 只是不计入结论，
报告证据仍在，人随时可查。

---

## 6. 后果

**好的**

- 项目能按自己的阶段定标准：原型期 `unmapped_file: ask`，交付前收紧为 `deny`。
- 标准进 `policy.yaml`、进哈希锚点，CI 与本地同一套，事后可审计。
- 默认行为零变化，老项目无感。

**代价与边界**

- policy schema 变了（加可选段）——这是契约变更，故有此 ADR；只加可选字段，不破坏现有文件。
- `validator.ts` 的顶层键白名单（`rules` / `protected`）要加 `arch`，否则合法文件被误报。
- `hook` 的独立解析器要同步容忍新段（只忽略，不消费）——两处解析器并存是已知现状（ADR-014 备注），本次只做最小同步。

**明确不做**

- 不做逐写 import 拦截（见 §2.3）。
- 不做自动修设计 / 自动加依赖声明（自动改规格，禁区）。

---

## 7. 验收标准

1. 无 `arch:` 段时 `--strict` 行为与现状完全一致（默认全 deny）。
2. `unmapped_file: ask` 时，有无归属文件但无其它硬偏离 → `--strict` 退出码 0，且输出标注待确认。
3. `cycle: allow` 时，有环 → `--strict` 退出码 0，但报告里环的条目仍在。
4. `kind` 非法 / 重复 / 缺 `basis` → `zelto policy validate` 报错。
5. `judgeArchGuard` 同输入必得同输出（确定性，直测守住）。
6. `--json` 输出含 `guard` 结论，且原 `report` 字段原样保留。

---

## 8. 待决策（已定）

- **Q1（已定：默认 `deny` 不变）**：`unmapped_file` 默认保持 `deny`（沿现状，
  fail closed）。原型期噪声不靠改默认解决，靠三样省力的显式放开：
  报告里给出可复制的 `arch:` 片段、文档给原型期预设（`unmapped_file: ask`）、
  每次放开进 `policy.yaml` 受 `lock.json` 审计。等 Phase 1 跑出真实样本，
  若 `unmapped` 噪声确实主导，再提案调默认。
- **Q2（已定：三处都接）**：`arch check --strict`（整图结论直接定退出码）、
  `version deliver`（整图结论作为交付门）、`batch` 与单片 `gate`
  （只看与本片写集相关的偏离，无关模块的漂移不拦干净切片）做全，
  不留尾巴。切片级过滤语义见 §3.7。
