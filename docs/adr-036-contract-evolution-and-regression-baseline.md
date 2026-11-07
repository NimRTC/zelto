# ADR-036: 契约演进检查 + 跨版本回归基线

**状态**: 已实施
**日期**: 2026-11-08
**作者**: 系统架构
**关联约束**: C1, C2, C3, C4
**关联文档**: `docs/zelto-项目目标.md`（§6.1 G-4 剩余项）,
`docs/adr-027-arch-guard-policy.md`, `docs/zelto-技术架构.md`

---

## 1. 摘要

G-4「防垃圾代码的机制缺位」还剩两样东西：

| 需要的能力 | 现状（本次之前） |
|---|---|
| 契约演进检查 | `contracts/schemas/` 只在 zelto 内部用；`ContractRegistry` 能校验「一份数据符不符合**当前** schema」，但回答不了「上一版的 schema 放到这一版还成不成立」 |
| 跨版本回归基线 | 版本级验收只跑 `gate.commands`，只得到一个「过 / 不过」；没有「这个版本把上个版本的哪些行为弄坏了」的对比 |

本次定案并实施：

- **契约演进检查**：给定旧契约与新契约，算出变化里哪些是破坏性的，并分清
  破坏的方向（写入方 / 读取方）；基线存在 `.zelto/contracts/baseline.json`，
  由人显式更新；
- **跨版本回归基线**：版本交付时记录「哪些用例是绿的」，与上一个已交付版本
  对比，检出「用例消失 / 退化成空壳 / 直接变红」三类回归。

两个能力都接在**版本交付**（`zelto version deliver`）这一层 ——
交付是版本对外生效的边界，契约破坏与行为退化留到交付之后才发现，代价已经出去了。

---

## 2. 为什么现在做

项目目标 §6.1 把这两项列为 G-4 的剩余缺口。补齐它们的理由不是「功能更全」，
而是**两个已有的闸门都存在盲区**：

- 架构护栏（ADR-027）看的是**模块依赖方向**，看不见「接口字段被改了」；
- 版本级验收看的是**这一版的测试绿不绿**，看不见「上个版本验证过的东西
  这一版还在不在」。

具体到本项目自己：ADR-032 给追溯加了硬闸门（要求规格声明需求出处），
ADR-033 改了门禁②的跑法（从全项目命令改成切片级验收），
ADR-034 改了规格生成路径 —— 这三条都改过**契约面**
（`contracts/schemas/slice.json`、`slice-v2.json` 等）。
改契约面这件事，当时**没有任何东西会发现它改坏了**。
这次补的正是这个洞。

---

## 3. 设计

### 3.1 契约演进：两个方向

契约描述的是「会被写进磁盘、会被别的程序读」的东西。所以破坏性有两个方向：

| 方向 | 含义 | 后果 |
|---|---|---|
| **writer 破坏** | 新契约不再接受旧数据 | 旧版本写出来的文件读不进来了 |
| **reader 破坏** | 新契约产出的数据旧程序读不懂 | 升级后下游炸了 |

只报一个方向等于只检查了一半。两边都报。

### 3.2 判定口径

统一到一条规则上：**收窄 = writer 破坏，放宽 = reader 破坏**。

收窄（新契约比旧契约更严）：

- 新增必填字段
- type 收窄（新类型集合 ⊂ 旧类型集合）
- enum 删除取值 / 新增 enum 约束
- `additionalProperties` 收紧为 `false`
- 新增或抬高下界（`minimum` / `minLength`）
- 新增或收紧上界（`maximum` / `maxLength`）
- 新增或改 `pattern`
- 新增 `items` 约束
- 删除 property 声明 **且** 新契约 `additionalProperties === false`
  （删除声明本身是放宽 —— 旧数据带着这个字段仍然合法，除非新契约封闭）

放宽（新契约比旧契约更松）：

- 取消必填
- type 放宽
- enum 新增取值 / 移除 enum 约束
- `additionalProperties` 放宽
- 降低或移除下界
- 抬高或移除上界
- 移除 `pattern`
- 移除 `items` 约束
- 新增**可选** property **且** 旧契约 `additionalProperties === false`
  （旧程序禁止额外字段，读不懂新数据）

两侧都判不了兼容的（type 一改一增、`pattern` 换了内容）按 **writer 破坏**处理 ——
宁可误报，不许漏报。

不认识的 JSON Schema 关键字（如 `anyOf`）**不做猜测**，按「未变更」处理。

### 3.3 基线是人签字，不是自动化

基线 = 一份「人确认过的契约集合」，落在 `.zelto/contracts/baseline.json`。

更新基线由**显式命令** `zelto contract baseline` 完成，不自动发生。
理由：更新基线等于签字接受这次变化。自动化会把破坏也一起签掉，
那道闸门就白设了。

没有基线时 `zelto contract check` **不做判断**（退出码 0），并明确提示
「没有可对比的对象」—— 「还没确认过」与「一切正常」必须分开说。
老项目（没用过这个功能）因此无感。

### 3.4 跨版本回归基线

版本级验收跑完只得到「过 / 不过」。但「过」掩盖了一个更隐蔽的坏法：
**agent 把证明某个行为的用例删了，或者改成 `test.todo(...)`**。
整片测试仍然绿，验收仍然过，而那个行为其实已经没人验证了。

做法：

1. 版本交付时，从验收输出里解析 TAP，拿到「哪条用例、什么状态」；
2. 写进 `.zelto/regression/<planId>/<version>.json`（版本标签在不同计划里会
   重名，所以按计划分目录）；
3. 与**上一个已交付且有基线**的版本对比，检出四类差异：

| 类别 | 含义 |
|---|---|
| `regressed` | 上版本通过，本版本失败 —— 直接的行为损坏 |
| `degraded` | 上版本通过，本版本变成 todo / skip —— 用例还在，但没人跑了 |
| `missing` | 上版本通过，本版本没有这条用例 —— 用例被删了，行为没人验证 |
| `fixed` | 上版本失败或空壳，本版本通过 —— 修好了 |

只有「上版本是 pass」的用例才可能进前三类。上版本本来就是红的用例在新版本里
消失，不算回归。

### 3.5 解析口径：读不出就不判

TAP 解析只认测试运行器**明确写出来**的东西。读不出用例列表时返回
`known: false`，调用方放弃本次回归判断并显式说明「不猜别的运行器格式」
（与 ADR-033 的验收统计同一条原则）。

### 3.6 阻断语义

| 情况 | 交付 | 处理 |
|---|---|---|
| 检出契约破坏（任何方向） | **阻断** | 确认可以接受后 `zelto contract baseline` 更新基线，再重新交付 |
| 检出回归 | **阻断** | 修好回归，或显式 `zelto version deliver <ver> --accept-regression` |
| 没有基线 / 读不出 TAP | 不阻断 | 显式说明「本次不判断」 |

阻断的两处都留了**人的出口**：契约那边是「更新基线」，回归那边是
`--accept-regression`。与 ADR-015（hotfix 必须 `--yes` 显式确认）同一条思路 ——
把决策权交回给人，而不是让工具替人接受。

---

## 4. 落点

| 文件 | 职责 |
|---|---|
| `src/core/contracts/evolution.ts` | 演进判定引擎（纯函数，C3） |
| `src/core/contracts/baseline.ts` | 契约基线存取（文件态，C1；临时文件 + rename） |
| `src/core/regression/tap.ts` | TAP 解析与合并（纯函数，C3） |
| `src/core/regression/baseline.ts` | 版本回归基线存取（文件态，C1） |
| `src/core/regression/compare.ts` | 两份基线的差集（纯函数，C3） |
| `src/cli/commands/contract.ts` | `zelto contract check / baseline / status` |
| `src/cli/commands/ai-pipeline.ts` | `version deliver` 的两个前置检查 + 回归基线记录 |
| `src/core/events/stream.ts` | 新事件类型 4 个 |
| `src/core/audit/trail.ts` | 新事件的人话摘要 |

### 新增事件类型

- `contract.evolution_checked` —— 检查了哪些契约、几处破坏
- `contract.baseline_updated` —— 人更新了基线（记下契约清单与原清单）
- `version.regression_recorded` —— 记录了某版本的回归基线
- `version.regression_detected` —— 检出回归（含是否被显式接受）

---

## 5. 不变式核对

| 约束 | 核对 |
|---|---|
| C1 状态只在文件里 | 基线与回归基线都落 `.zelto/` 下；无内存状态、无 daemon |
| C2 `core/` 零第三方依赖 | 演进引擎、TAP 解析、对比全是纯函数；只用 Node 内置 |
| C3 判定确定性 | 演进判定、回归对比都是纯计算，不调模型、不触网 |
| C4 append-only 事件流 | 四类新动作都写事件；基线文件是「当前值」不是事件流，符合 ADR-018 的边界 |
| C5 保护域不覆盖 | 本次不涉及保护域与锚点 |

`core/` 未 import `adapters/`，`core/policy|gate|sched` 未新增任何依赖。

---

## 6. 边界与不做的事

- **不做**「自动改契约」「自动更新基线」「自动批准破坏」—— 基线更新必须是人的动作。
- **不做**跨仓库的契约扫描（只扫本仓 `contracts/schemas/`）；接管第三方项目时
  可把该项目的契约目录放进 `contracts/schemas/` 后使用。
- **不做**非 JSON Schema 的契约格式（OpenAPI / protobuf）—— 先把 JSON Schema 这一种做对。
- **不做**「行为回归」的全部形态。当前只覆盖「验收用例的通过状态」，
  不覆盖运行时性能、输出格式等行为面。

---

## 7. 兼容性

无破坏性变更：

- 新增命令 `zelto contract`，新事件类型 4 个；
- `version deliver` 新增两个前置检查 —— **有基线且检出破坏时才阻断**，
  没有基线的项目行为不变；
- `version deliver` 新增 `--accept-regression` 旗标（缺省不阻断）。

---

## 8. 实施记录

1. **演进引擎**（`core/contracts/evolution.ts`）：纯函数 `diffSchemas(baseline, current)`，
   返回变化集合（`kind` / `path` / `direction` / `breaking` / 中文 `message`）；
   附 `countBreaking` / `hasBreaking` / `renderChanges`。
2. **基线存储**（`core/contracts/baseline.ts`）：`ContractBaselineStore`，
   `.zelto/contracts/baseline.json`；读坏了的基线按「没有基线」处理，不静默覆盖。
3. **TAP 解析**（`core/regression/tap.ts`）：`parseTapResults` / `mergeTapResults`；
   多段输出合并时同名用例取**更差**的状态（fail > todo > skip > pass）。
4. **回归基线与对比**（`core/regression/baseline.ts`、`compare.ts`）。
5. **CLI**（`cli/commands/contract.ts`）：`check` / `baseline` / `status`，
   `--json` 走格式化器的结构化输出。
6. **交付接线**（`cli/commands/ai-pipeline.ts`）：
   - `version deliver` 第二步之后：契约演进检查 → 有破坏则阻断；
   - 版本级验收通过之后：记录回归基线 → 与上一个已交付版本对比 →
     有回归则阻断（除非 `--accept-regression`）。
7. **测试**：`tests/contracts-evolution.test.ts`（判定口径）、
   `tests/contract-regression.test.ts`（存储与对比）、
   `tests/contract-cli.test.ts`（真实 CLI 进程端到端）。

---

## 9. 验收标准

- `zelto contract check` 在没有基线时不判断、退出码 0；
- 建基线后改坏契约，`zelto contract check` 退出码 1 并说清破坏方向；
- `zelto contract baseline` 之后重新检查通过；
- `version deliver` 在检出契约破坏时保持 `in_progress` 并给出修复路径；
- `version deliver` 在检出回归时保持 `in_progress`，
  `--accept-regression` 可显式放行并留事件；
- 全部测试通过、lint 通过。
