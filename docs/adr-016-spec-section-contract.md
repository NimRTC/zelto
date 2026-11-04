# ADR-016: 规格章节契约（双语别名表与必备章节收敛）

**状态**: 已实现
**日期**: 2026-11-04
**作者**: 系统架构
**关联约束**: C3, C7
**关联文档**: `AGENTS.md`, `docs/zelto-技术架构.md`, `docs/adr-015-hotfix-explicit-confirmation.md`

---

## 1. 摘要

规格（spec）是一份 Markdown 文件，zelto 要读它、校验它、从中解析写集与验收标准。
但「一份规格该有哪些章节」这件事，此前没有唯一答案：

- `core/spec/deterministic/validator.ts` 硬编码了 **9 个英文必备章节**
  （`Title` / `Summary` / `Motivation` / `Design` / `API / Interface Changes` /
  `Data Model Changes` / `Migration Plan` / `Testing Strategy` / `Acceptance Criteria`）
- `core/spec/semantic/analyzer.ts` 另有一套正则，直接匹配 `## Design`、`## Testing Strategy`
- `core/spec/lint.ts` 存在，但只是个永远返回 `passed: true` 的空壳
- 而仓库里 **75 份规格** 实际写的是另一套：`## 目的` / `## 验收标准` / `## 范围` …

结果是：规格引擎对自己仓库里的规格**大面积报缺章节**，
而且缺的都是「Motivation」「Migration Plan」这类**并非人人写的**章节。
换句话说，校验器在制造噪声，而噪声掩盖了真正的问题。

本 ADR 把章节契约收敛成**一张表**（`core/spec/format.ts`）：
按「概念 + 别名」描述，中英文标题等价；必备章节只留**每个规格都必须有**的两个。

---

## 2. 动机

### 2.1 现状

| 事实 | 位置 | 影响 |
|---|---|---|
| 9 个英文章节被当成必备 | `core/spec/deterministic/validator.ts`（改动前） | 中文规格一律报「缺 8 个章节」 |
| 缺 3 个以上算 error | 同上 | error 意味着门禁可能挡住人 |
| 语义分析器用正则单独匹配章节 | `core/spec/semantic/analyzer.ts`（改动前） | 第二套章节认识方式，与第一套不一致 |
| `lint.ts` 是空壳 | `core/spec/lint.ts` | 看着像有 lint，实际没有规则 |
| 仓库里三种规格写法并存 | `specs/slices/*.md`、模板、创建模板 | 无法用一套章节表覆盖 |

三种规格写法：

| 来源 | Summary 章节 | Acceptance Criteria 章节 |
|---|---|---|
| zelto 生成的模板（`cli/commands/shared.ts`） | `## 目的` | `## 验收标准` |
| 从既有规格创建切片的模板（`cli/commands/core-slice.ts`） | `## Summary` | `## Acceptance Criteria` |
| 仓库现存 75 份规格 | `## 目的` | `## 验收标准` |

三套都**只有 Summary 和 Acceptance Criteria 是稳定存在的**。
其余的（范围 / 设计 / 风险 / 测试策略）时有时无。

### 2.2 为什么不能简单放宽

一种省事的做法是「把必备章节检查整个删掉」。但那样规格就退化成一张白纸——
「这份规格写全了没有」再也无人回答。

另一个省事的做法是「要求所有章节都用中文」。但 `zelto create --from-spec` 走的是英文模板，
一刀切会打断这条路径。

---

## 3. 设计

### 3.1 章节契约表

新增 `core/spec/format.ts`，是「规格该有哪些章节」的唯一真源：

```typescript
export interface SectionSpec {
  concept: string;      // 概念名——报告里用它指代这一节
  aliases: string[];    // 可接受的标题（不含 `##` 前缀）
  required: boolean;    // 是否为必备章节
}

export const SPEC_SECTIONS: SectionSpec[] = [
  { concept: 'Summary',             aliases: ['Summary', 'Purpose', '目的'],                 required: true },
  { concept: 'Acceptance Criteria', aliases: ['Acceptance Criteria', 'Acceptance', '验收标准'], required: true },
  { concept: 'Scope',               aliases: ['Scope', 'Range', '范围'],                     required: false },
  { concept: 'Design',              aliases: ['Design', '设计'],                              required: false },
  { concept: 'API / Interface Changes', aliases: ['API / Interface Changes', 'API Changes', 'API', '接口变更'], required: false },
  { concept: 'Risk',                aliases: ['Risk', 'Risks', '风险'],                      required: false },
  { concept: 'Testing Strategy',    aliases: ['Testing Strategy', 'Testing', '测试策略', '测试计划'], required: false },
];
```

**必备章节只有两个**：Summary 与 Acceptance Criteria。
理由见 §2.1——它们在三种规格写法里都出现，是真正的「没写完」的信号。
其余章节降级为建议项。

**别名表是双语等价的**：`## 目的` 与 `## Summary` 命中同一个概念。
这与 `core/spec/scope.ts` 的既有做法一致——那里也是
`/范围|scope|range/i` 这样中英文一起认。

### 3.2 章节正文的提取

`extractSection(content, spec)` 返回章节正文，章节不存在时返回 `null`：

- 标题匹配用 `headingMatches()`，大小写不敏感
- 章节边界：遇到**同级或更高级**的标题即结束；更低级（子标题）仍属于本节
- 章节存在但正文为空 → 返回空字符串（与「不存在」区分开——
  这两件事的严重程度不同：缺章节是 warning，空章节是 error）

### 3.3 缺章节的严重程度

改动前：缺 3 个以上算 error，缺 1~3 个算 warning。

改动后：**一律 warning**。

理由：`error` 意味着门禁会挡住人。既然必备章节已经收敛到两个真正的必备项，
剩下的都是「写得更完整更好」的提示，不该挡人。

`Acceptance Criteria` 章节**存在但为空**仍是 `error`——
那说明这份规格承诺了验收标准却没写，是真问题。

### 3.4 语义分析器复用同一张表

`core/spec/semantic/analyzer.ts` 改动前用 `/^## Design\s*\n([\s\S]*?)(?=\n## |$)/` 这类正则
各自匹配章节。现在改用 `sectionByConcept('Design')` + `extractSection()`。

语义上有一处**刻意的区分**：

| 情况 | 改动前 | 改动后 |
|---|---|---|
| 没有「设计」章节 | warning（"empty or missing"） | **info** |
| 有「设计」章节但为空 | warning | warning |

理由：zelto 自己生成的规格模板就不含「设计」这一节。
把「压根没写」判成 warning，等于让每份规格都挂一条没用的提醒——
和 §2.1 里那个「9 个必备章节」是同一类噪声。
但**写了却是空的**是真问题，保持 warning。

### 3.5 删掉空壳 lint

`core/spec/lint.ts` 整个删除。它从来没有规则（`ruleCount: 0`，注释里自称
"Stub implementation — no rules applied"），却让人以为「规格 lint」这件事已经有人管了。

留着它的成本是：有人以为加规则应该往那里加。
删掉之后，「规格章节」这件事的真源只有 `format.ts` 一个。

---

## 4. 契约变更

| 变更 | 位置 | 说明 |
|---|---|---|
| 新增「规格章节」契约（概念 + 别名 + 是否必备） | `core/spec/format.ts`（新文件） | 纯新增，不改已有文件格式 |
| 必备章节从 9 个英文章节改为 2 个概念（Summary / Acceptance Criteria） | `core/spec/deterministic/validator.ts` | 判定依据变了，但**规格文件本身不需要改** |
| 缺章节一律 warning（不再有 error 级） | 同上 | 门禁行为变松 |
| 语义分析器改用章节表 | `core/spec/semantic/analyzer.ts` | 判定口径统一 |
| 删除 `lintSpec` / `SpecLintResult` / `SpecLintSeverity` | `core/spec/lint.ts`（删除） | 空壳，无调用方 |
| `SpecIssue` 增加 `check?: string` | `core/core/spec/types.ts` | 报告里区分「阻断项」与「提示项」 |
| `zelto check` 报出规格引擎的提示项 | `src/cli/commands/core-slice.ts` | 提示不参与阻断 |

**规格文件格式本身没有变化**——现有的 75 份规格一个字都不用改。
变的是 zelto 怎么读它们。

---

## 5. 约束合规检查

| 约束 | 检查 | 合规 |
|---|---|---|
| **C1** | 章节表是纯常量，判定无状态 | ✅ |
| **C3** | 章节匹配是字符串比较与正则，不调模型、不触网 | ✅ |
| **C7** | 章节表是人工定义的常量表，不由模型生成 | ✅ |

---

## 6. 替代方案

### 方案 A：把 9 个英文章节都加中文别名，保留为必备

**放弃理由**：仍然把「时有时无」的章节（Motivation / Migration Plan）当必备。
仓库里 75 份规格一份都没写这两节——把它们当必备，
等于让每一份规格都报缺章节。噪声不是信号。

### 方案 B：删掉章节检查，规格不再校验结构

**放弃理由**：「这份规格写全了没有」是 zelto 存在意义的一部分。
删掉之后，规格退化成自由文本，追溯链的起点就没有约束了。

### 方案 C：只支持中文标题，英文模板改成中文

**放弃理由**：打断 `create --from-spec` 的既有路径，
且把「中英文等价」这件已经做到的事（`core/spec/scope.ts`）倒退回去。

### 方案 D：保留 `lint.ts`，把章节规则补进去

**放弃理由**：`lint.ts` 的定位是「通用 lint 框架」，与「章节契约」是两个东西。
把章节规则塞进去，等于让 lint 框架同时承担契约定义——
而章节契约需要被多个调用方（确定性校验、语义分析、CLI 报告）共享，
塞在一个自称「stub」的模块里只会让人找错地方。

---

## 7. 决定

1. 新增 `core/spec/format.ts` 作为规格章节契约的唯一真源，
   按「概念 + 别名（双语等价）+ 是否必备」描述
2. 必备章节收敛为 **Summary** 与 **Acceptance Criteria** 两个概念
3. 章节缺失一律 **warning**；`Acceptance Criteria` 存在但为空仍是 **error**
4. 语义分析器复用同一张章节表；
   「设计」章节**缺失**降为 info，**为空**保持 warning
5. 删除 `core/spec/lint.ts`（空壳，无调用方）
6. `SpecIssue` 增加 `check` 字段，报告方据此区分阻断项与提示项；
   `zelto check` 报出提示项但**不参与阻断**——
   规格引擎加一条规则，不该让所有既有切片突然过不了门禁①
