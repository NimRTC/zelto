# ADR-063：设计文档的确定性修正（`zelto design patch`）

**状态**: 已实施
**日期**: 2026-11-15
**作者**: 系统架构
**关联约束**: C1, C3, C4
**关联文档**: `src/core/design/patch.ts`（修正逻辑）,
`src/cli/commands/design-patch.ts`（命令）,
`src/core/design/parse.ts`（字段解析，本 ADR 复用它）
**前置**: ADR-062 §8（实施中发现的流程缺口）

---

## 1. 摘要

ADR-062 实施时发现一个流程缺口：

**工具能报出设计的问题，但没有修正设计的路径。**

本 ADR 补上这条路径：`zelto design patch` —— 走**确定性文本替换**，
不经 LLM，改完仍要人确认。

---

## 2. 问题

### 2.1 演练里踩到的

ADR-062 装到真实项目上，第一次跑就报出：

```
● 模块无文件    src/dtls → src/dtls
  模块 "src/dtls" 声明了文件路径，但一个文件都没匹配上
  （src/dtls/*、src/dtls/**/*）—— 路径写错了，或目录还不存在
```

想改路径，跑 `zelto design refine`：

```
{
  "error": {
    "code": "INVALID_STATE",
    "message": "Design \"prj-1792993843912\" is already confirmed. Can only refine draft designs."
  }
}
```

**改不了。**

`design refine` 只接受 `draft`。而设计一旦确认，就进入下游流程
（切规格、签字、合并），**没有回头的路**。

### 2.2 `supersedes` 字段预留了但没人用

`DesignDoc` 里有个 `supersedes: string | null` —— 显然是给
「新版取代旧版」准备的。但全仓库搜下来：

```
src/cli/commands/ai-pipeline.ts:365:    supersedes: null,
src/cli/commands/ai-pipeline.ts:546:    supersedes: null,
src/cli/commands/panoramic-project.ts:451:      supersedes: null,
```

**永远是 `null`，没有任何命令设置它。**

机制预留了，实现没跟上。

### 2.3 手改 JSON 的坑

绕过工具直接改 JSON 能改，但有个**隐蔽的不一致**：

设计文档里有两份模块声明：

| | 是什么 | 谁在用 |
|---|---|---|
| `body` | 人读的 Markdown 正文 | **真源** —— 判定一律从它推导 |
| `modules` | 结构化副本 | **缓存快照** —— 给人看的 |

`core/design/derive.ts` 明确写着「判定不依赖 `modules`」。

**只改 `body` 不改 `modules`** → 报告里显示的模块信息是旧的，
跟实际判定不一致。**只改 `modules` 不改 `body`** → 判定用的还是旧的，
改了等于没改。

演练时我就是**两处都改**才对的 —— 但这要求人知道这件事，
而且记得改两处。手改 JSON 不该有这种陷阱。

---

## 3. 决策

### 3.1 走确定性替换，**不经 LLM**

`design refine` 走 LLM 重新生成整份正文 —— 那是**创作**。
本命令做的是**修正**：把一个字段的值换掉。

**为什么不让 LLM 做**：

LLM 会「顺手」改别的东西。修正一个路径，结果它重写了整个职责描述 ——
那不是修正，是**未授权的创作**。

而**创作需要人从头重新确认**（ADR-018 的签字精神）。
一个「修正路径」的命令，却导致整份设计要重新确认 —— 这违背了命令的意图。

**更实际的顾虑**：这里的修改是**确定性的文本替换**（找到 `### src/dtls` 段，
替换其中的 `**文件路径**` 行）。走 LLM 反而有**把别的东西改坏**的风险，
而且每次结果可能不同 —— 违反 C3。

**所以**：只做**人明确指定的那一处改动**，改完仍要人确认。

### 3.2 命令形态

```
zelto design patch <id> --module <name> --path <glob> [--dep <module>] [--yes]
```

- `--module` 可以给多次，每个模块拿**它自己之后、下一个 `--module` 之前**的
  `--path` / `--dep`
- `--path` 可以给多次，也可以用逗号分隔（`--path "a/*, a/**/*"`）
- 只传 `--path` 就只改文件路径；只传 `--dep` 就只改依赖模块
- **没传的字段一律不动**

**不改没传的字段**是硬要求 —— 「只改明确指定的那一处」。

### 3.3 正文与 modules 两处同步

`applyPatch` 在改完正文后**重新推导** `modules`：

```ts
modules: deriveModules({ body: newBody, modules: [] }),
```

用 `modules: []` 强制走「从正文推导」的路径 —— **不会**退回到旧快照。

**这是 §2.3 那个陷阱的根治**：调用方不需要知道有两份，只改正文即可，
`modules` 自动跟上。

### 3.4 改的是已确认的设计 → 必须人确认

改已确认的设计是**治理动作**，不是普通编辑。所以：

- **TTY 下**：交互确认（`应用这些修正？[y/N]`）
- **非 TTY 下**：拒绝，要求加 `--yes`（不静默跳过）
- `--yes`：跳过交互（供脚本用）

事件流记 `draft.revised`，payload 带**完整的 before/after**：

```json
{
  "module": "src/dtls",
  "field": "filePatterns",
  "before": ["src/dtls/*", "src/dtls/**/*"],
  "after": ["src/modules/dtls/*", "src/modules/dtls/**/*"]
}
```

**为什么用已有的 `draft.revised`**：契约里已经有了这个事件类型
（`contracts/schemas/event-envelope.json`），`refine` 也在用。
语义完全吻合（「设计被修订了」）。**不需要新增事件类型 → 不需要改契约。**

### 3.5 字段找不到时**不新增**

`replaceField` 找不到 `**文件路径**` 行时返回 `false`，命令报 `NO_CHANGE`。

**为什么不新增一行**：

1. 放哪？字段顺序是「职责 / 文件路径 / 依赖模块」，塞到末尾就不对了
2. 找不到字段说明**这个模块的正文格式不符合模板** —— 这时应该让人知道，
   而不是硬塞一行进去

### 3.6 字段解析复用 `parse.ts`

多行列表写法里，条目可能带反引号（`` `src/a.cpp` ``）、方括号（`[a, b]`）、
括号说明（`a（说明）`）。这些清理规则**已经在 `parse.ts` 的 `parseFieldList` 里**。

本 ADR 最初自己实现了一遍（`splitFieldValue`）—— 结果与 `parse.ts` 不一致
（没剥反引号），测试直接抓到。

**改成直接调 `parseFieldList`** —— 单一实源。

> **教训：解析规则已经存在时，不要重写。**
> 重写的那一遍总会漏掉某些规则，而漏掉的地方会**静默地**产生不一致。

---

## 4. 实现要点

### 4.1 模块段落的定位

`findModuleSections` 扫出每个 `### <名字>` 段落的行范围：

- `##` 级别的标题结束当前段落（模块声明只在 `###` 之下）
- 代码围栏（```）里的 `###` 不算标题

与 `parse.ts` 的 `parseDesignModules` 保持一致。

### 4.2 多行列表的整块替换

多行写法：

```
- **文件路径**:
  - `src/dtls/*`
  - `src/dtls/**/*`
```

替换时必须**整块换掉**（标签行 + 所有连续列表项），
否则旧列表项会残留：

```
- **文件路径**：src/modules/dtls/*, src/modules/dtls/**/*
  - `src/dtls/*`          ← 残留，乱
  - `src/dtls/**/*`       ← 残留，乱
```

### 4.3 一个坑：`*/` 会提前结束块注释

写这个文件时踩到的：

```ts
/**
 * 字段行长这样：`- **文件路径**：src/core/*, src/core/**/*`
 */
```

`src/core/**/*` 里的连续星号加斜杠会**提前结束这段块注释** ——
后面的 `` ` `` 变成了代码，TS 报 `Unexpected "*"`。

**解法**：注释里写 glob 时把星号转义掉（`{@/*}`）。

> 这个坑很隐蔽 —— 报错位置（行 162）离真正的原因（星号加斜杠）很远，
> 而且**报错行号指向注释内部**，看起来像注释写错了语法。
>
> 值得记住：**在 JSDoc 里写 glob 模式时，星号是危险的**。

---

## 5. 验证

### 5.1 单元测试（12 条）

`tests/design-patch.test.ts`：

- 单行字段写法：替换文件路径 / 替换依赖 / 清空依赖 / 找不到模块
- **只改指定模块** —— 其它模块与职责一个字都不动
- 多行列表写法：整块替换 / 旧列表项不残留 / 改完能正常解析
- 正文与 modules 一致（含「故意给过时快照」的场景）
- 原文档不被修改（返回新文档）
- 确定性（同输入两次结果相同）

### 5.2 真实项目端到端

在 nimrtc-zelto 上：

1. 故意把 `src/dtls` 的路径改回错的
2. `arch check` 报出：`src/dtls 0 个文件` + `模块无文件` 偏离
3. `zelto design patch prj-... --module src/dtls --path "src/modules/dtls/*, src/modules/dtls/**/*" --yes`
4. `arch check` 恢复：`src/dtls 21 个文件（19 代码）`，实际依赖 `src/core, src/plugins, src/third_party`
5. `模块无文件` 偏离消失，总偏离数回到 26
6. `body` 与 `modules` 两处都改了
7. 事件流里 `draft.revised` 带完整 before/after

**闭环成立**：工具报错 → 命令修 → 工具确认修好了。

---

## 6. 约束核对

| 约束 | 核对 |
|---|---|
| **C1** 状态只在文件里 | 设计文档仍在 `.zelto/design/<id>.json`，无新状态 |
| **C3** 判定确定性 | 纯文本替换，无模型、无网络；同输入同输出 |
| **C4** append-only 事件 | 每次修正写 `draft.revised`（已有事件类型，未改契约） |
| **C2** core/ 零依赖 | `core/design/patch.ts` 只 import 同目录的 `derive.js` / `parse.js` / `types.js` |

---

## 7. 遗留

- **`supersedes` 字段仍然没人用** —— 本 ADR 用「原地修正 + 事件留痕」替代了
  「新版取代旧版」。原地修正更简单（下游引用的是设计 id，不用改引用），
  但**失去了「新旧两版都在」的审计视图**。将来若需要，可以加 `design history`。
- **修正范围仅限模块的「文件路径」与「依赖模块」** ——
  「职责」是**创作性**内容，不该由这个命令改。
  要改职责，用 `design refine`（走 LLM + 人重新确认）。
- **`--yes` 跳过了人确认** —— 有脚本化需求，但代价是「改已确认的设计」这动作
  可以在无人值守下发生。将来若要更严，可以要求 `--yes` 额外带一个理由，
  记进事件 payload。
