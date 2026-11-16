# ADR-068：策略护栏的可编辑面 —— `arch:` 段编辑器 + `validate --update` 一体化入口

**状态**: 已实施
**日期**: 2026-11-16
**作者**: 系统架构
**关联约束**: C3, C5
**关联文档**: `src/cli/policy/index.ts`（子命令路由）,
`src/cli/policy/commands/arch.command.ts`（新增）,
`src/cli/policy/handlers/arch.handler.ts`（新增）,
`src/cli/policy/commands/validate.command.ts`,
`src/core/policy/yaml-writer.ts`,
`src/core/policy/lock.ts`

---

## 1. 摘要

第一轮演练（D-23）暴露了两条策略治理面的遗留：

1. **`zelto policy` 没有 `arch:` 段的编辑器** ——
   `policy add` / `edit` / `remove` 只管 `rules:` 段。
   要改架构护栏只能手改 YAML，改完还得记得跑 `policy lock --update`。
2. **`zelto policy validate` 报锚点失配时退出码仍是 0** ——
   锚点失配是「策略被改过而锚点没动」（C5 的核心意图），
   但它只是一条 warning。

本 ADR 把这两件事一起做掉 —— 它们是**同一条用户旅程**的两半：

```
改策略 → 改完锚点没跟上 → validate 说「失配了」但退出码 0
     → 人不知道该跑什么 → 要么忘了改锚，要么改了不知道
```

**决策**（用户确认）：

- **D1**：新增 `zelto policy arch` 子命令组（`list` / `add` / `edit` / `remove`），
  管 `arch:` 段。
- **D2**：`zelto policy validate --update` 提供**一体化入口** ——
  validate 发现锚点失配时，当场重锚（而不是让人另跑 `policy lock --update`）。
- **D3**：**普通 `validate` 的退出码口径不变**（仍是 0）——
  但**失配时 `validate --update` 会重锚并退出 0**，
  而**不带 `--update` 的 validate 在失配时退出码仍为 0**，
  保留「判与报分开」的边界。

> **D3 的口径澄清**：用户选了「一体化入口」，不是「升级成 error」。
> 所以 `validate` 的退出码**不因为失配而变** ——
> 否则接管既有项目时（策略是人自己的）每次都要先改锚，
> 「失配 = 可检出的改动」会退化成「每次改策略先走一遍仪式」。
> 一体化入口解决的是「**改完不知道还要跑什么**」这个真问题，
> 而不是把 warning 变成 error。

---

## 2. 背景：为什么这两条必须一起做

### 2.1 `arch:` 段的现状

`policy.yaml` 的顶层结构：

```yaml
rules:      # 路径 → 动作的判定规则
protected:  # 保护域（C5，硬编码兜底）
arch:       # 架构护栏：偏离种类的处置（deny / ask / allow）
```

`arch:` 段的每条规则形如：

```yaml
arch:
  - kind: cycle          # 偏离种类（六类硬偏离之一）
    action: ask          # deny 拦停 / ask 待人确认 / allow 不计
    basis: "ADR-025"     # 依据
    guidance: "..."      # 给人的提示
```

`policy add` / `edit` / `remove` 的语义全是**针对 `rules:` 段的**：
`ruleId` 是 `rules:` 里的 `id`，`--path` / `--action` / `--basis`
对 `arch:` 段一条都不适用。

所以要改 `arch:` 只能手改 YAML。**这不是「不方便」，是「容易出错」** ——
手改完忘了改锚点，锚点失配，而 validate 不告诉你（退出码 0）。

### 2.2 锚点失配的现状

`checkPolicyAnchor` 已经能判失配，`zelto policy lock` 已经能改锚，
但**两者是两条独立的命令**，中间没有任何提示告诉人「你该跑 lock --update」。

`validate` 里确实有这条提示：

```ts
const anchorWarning = anchor.mismatch
  ? `策略锚点失配：锚点记的是 ${anchor.locked}，当前 policy.yaml 是 ${anchor.current}。` +
    `策略被改过而锚点没动 —— 确认改动是有意的，跑 zelto policy lock --update 改锚。`
  : null;
```

但它**只是一个 warning 字符串**，然后退出码 0。
在 CI 里（`zelto policy validate` 作为门禁）这一条直接被吞掉。

---

## 3. 发现的第三个缺陷：D-30（`policy edit` / `remove` 抹掉 `arch:` 段）

写这个 ADR 的过程中做了一次现状验证，发现了一个**更严重的问题**：

```console
$ cat policy/policy.yaml
rules:
  - id: keep-me
    match: { path: "src/**" }
    action: allow
    basis: "policy.yaml#keep-me"

arch:
  - kind: cycle
    action: ask
    basis: "ADR-025"

$ zelto policy remove keep-me
✓ Rule "keep-me" removed.

$ cat policy/policy.yaml
rules:
```

**`arch:` 段整个消失了。**

### 3.1 根因

`src/cli/policy/handlers/remove.handler.ts` 与 `edit.handler.ts` 调的是：

```ts
writePolicyYaml(policyPath, updatedRules, headerComment);
```

而 `writePolicyYaml` 的签名是：

```ts
export function writePolicyYaml(
  filePath: string,
  rules: RuleData[],
  headerComment?: string,     // ← 没有 arch 参数
): void {
  const content = serializeRulesToYaml(rules, headerComment);
  writeFileSync(filePath, content, 'utf-8');
}
```

`serializeRulesToYaml` **有** `arch` 第三个参数，`writePolicyYaml` **没有**。
于是所有走 `writePolicyYaml` 的路径（`policy edit` / `policy remove`）
**丢掉整个 `arch:` 段**。

`policy add` 走的是另一条路径（`appendRuleToYaml`，在
`commands/add.command.ts` 里自己做字符串插入），所以它**侥幸没丢**。

### 3.2 为什么这是「严重」而不是「中」

`arch:` 段是**架构护栏的判定依据**。丢掉它的后果：

- 护栏**从 deny 退回默认**（`judgeArchGuard` 缺 `arch:` 时全按 deny）——
  反而更严，但这靠的是「缺配置 = 全拦」的巧合，不是人的设计
- 更要命的是**人已经明确写下的 `action: ask`（已知例外）没了** ——
  ADR-025 承认的那两条环会重新被拦停，
  而人根本不知道自己写过这条豁免

**护栏的「已知例外」被一个跟护栏毫无关系的命令静默抹掉。**

### 3.3 D-30 的处置（本 ADR 内修）

`writePolicyYaml` 加 `arch` 参数，所有调用点传当前配置里的 `arch`。
这一条**必须先修**，否则新建的 `arch:` 编辑器也会踩同一个坑。

---

## 4. 决策

### 4.1 D1：`zelto policy arch` 子命令组

```
zelto policy arch list [--json]
zelto policy arch add <kind> --action <action> --basis <basis> [--guidance <text>]
zelto policy arch edit <kind> [--action <action>] [--basis <basis>] [--guidance <text>]
zelto policy arch remove <kind> [--json]
```

**为什么是独立的 `arch` 子命令组，而不是扩到 `policy add/edit`**：

`rules:` 段的标识是**任意的 `id`**（`allow-src-ts`），
`arch:` 段的标识是**固定的 `kind`**（六类硬偏离之一，ADR-027）。

两者标识空间完全不同 —— 塞进同一个命令里，就得在参数层面区分
「`<rule-id>` 还是 `<kind>`」，靠「查表看它存不存在」来猜。
分成两个子命令组，**每个命令的参数空间是单一的**。

**为什么 `arch:` 段的标识是 `kind` 而不是新造一个 `id`**：

`kind` 已经是 `validateArchGuardRule` 与 `judgeArchGuard` 的主键，
重复造 `id` 会引入「两个标识指向同一条规则」的漂移。
另外 `kind` 重复即错误（validator 里有 `E_DUPLICATE`），
这正好等于「一类偏离只能有一条护栏规则」—— 语义正确。

**可配的六类**（`HARD_DEVIATION_KINDS`）：

```
undeclared_dependency / missing_dependency / unknown_module
ambiguous_module / unmapped_file / cycle
```

软偏离 `unverifiable_dependency` 不可配（永不计结论），
空模块 `empty_module` 与条件依赖 `conditional_dependency` 是软偏离 —— 都不在可配范围。

### 4.2 D2：`validate --update` 一体化入口

```
zelto policy validate [--json]           # 现状：报失配，退出码 0
zelto policy validate --update [--json]  # 新增：报失配 → 当场重锚 → 退出码 0
```

`--update` 的语义：

1. 先做完整 validate（策略文件本身合法吗）
2. 策略本身不合法 → **退出码 1，不重锚**（不能给一个坏策略改锚）
3. 策略合法 + 锚点失配 → **重锚**，输出「已重锚」，退出码 0
4. 策略合法 + 锚点一致 → 什么都不做，退出码 0

**为什么重锚算「成功」**：重锚是**人的决定**（承认这次策略改动是有意的），
`--update` 就是人做出这个决定的显式动作。做完之后状态是一致的，
应该退出 0。

**为什么策略不合法时不重锚**：给一个语法都过不了的策略改锚，
等于让「锚点一致」这个判据变成「锚点盖住了坏策略」——
锚点的意义是「记录当时按什么标准拦的」，坏策略没有「标准」可言。

### 4.3 D3：`arch` 段的操作**不自动改锚**

`policy arch add` 改的是策略文件 → 锚点必然失配。

**要不要顺手改锚？** 不改。理由与 `policy add/edit/remove` 一致：
**改锚是人的决定**（C5）。自动改锚等于让「锚点失配」永远检测不到任何东西 ——
它只在「人没跑 lock --update」时才有意义。

但**必须给出明确的下一步**：

```
✓ arch 规则 "cycle" 已添加。
  当前策略锚点已失配 —— 跑 zelto policy validate --update 重锚。
```

也就是说：**编辑命令不重锚，但必须告诉人下一步是什么。**
这正是本次要修的那个体验问题（原来没人知道该跑什么）。

---

## 5. 变更清单

| 文件 | 变更 |
|---|---|
| `src/core/policy/yaml-writer.ts` | `writePolicyYaml` 增加 `arch` 参数（**D-30 修复**） |
| `src/cli/policy/handlers/remove.handler.ts` | 传 `arch` 进去 |
| `src/cli/policy/handlers/edit.handler.ts` | 传 `arch` 进去 |
| `src/cli/policy/handlers/arch.handler.ts` | **新增** —— `arch:` 段的增删改查业务逻辑 |
| `src/cli/policy/commands/arch.command.ts` | **新增** —— `zelto policy arch` 子命令组 |
| `src/cli/policy/commands/validate.command.ts` | 支持 `--update`（一体化重锚入口） |
| `src/cli/policy/index.ts` | 路由 `arch` 子命令组 + `validate --update` |
| `tests/policy-arch-editor.test.ts` | **新增** —— 回归测试 |
| `docs/adr/adr-068-policy-arch-editor-and-validate-update.md` | 本文 |

---

## 6. 验证

### 6.1 单元测试

1. `policy arch add` → `arch:` 段多一条，**且 `rules:` 段不变**
2. `policy arch add` 重复 kind → 拒绝（`E_DUPLICATE`）
3. `policy arch edit` → 只改指定字段
4. `policy arch remove` → 该条消失
5. **`policy edit` / `policy remove` 之后 `arch:` 段仍在**（D-30 回归）
6. `policy arch add` 之后锚点失配 → 提示下一步是 `validate --update`
7. `validate --update` → 锚点重锚，退出码 0
8. `validate --update` 在策略本身非法时 → **不重锚**，退出码 1
9. `validate`（不带 `--update`）→ 失配仍报出来，退出码仍为 0（D3 口径不变）

### 6.2 端到端（nimrtc-zelto）

真实项目里有 `arch:` 段（`cycle: ask`，ADR-025 承认的两条环）。
用它验证：

```console
$ zelto policy arch list
$ zelto policy arch edit cycle --guidance "新的说明"
$ zelto policy validate          # → 报失配，退出码 0
$ zelto policy validate --update # → 重锚，退出码 0
```

### 6.3 回归

`npm test` 全绿 + `npx biome check` 干净。

---

## 7. 教训

### 7.1 「便捷入口」和「门禁语义」是两件事

第一轮把「锚点失配」记成「要不要升级成 error」，
用户在第二轮直接选了「**一体化入口**」—— 而不是 error。

这两个选项解决的是**不同的问题**：

| | 升级成 error | 一体化入口 |
|---|---|---|
| 解决 | 「CI 门禁看不见失配」 | 「人改完策略不知道还要跑什么」 |
| 代价 | 接管既有项目每次都要先改锚 | 门禁仍然看不见失配 |

**用户遇到的真实问题是后者** —— 「改完不知道还要跑什么」是每次都遇到的，
「CI 看不见失配」是偶尔遇到的。

而**代价**这一栏反过来：error 的代价是每次都遇到（仪式），
一体化入口的代价只是偶尔（CI 需要门禁时另用 `policy lock`，退出码 1）。

**选项的排列顺序影响了选择** —— 把 error 放在前面，
人会以为那是「更严格 = 更好」的默认选项。

### 7.2 修一个功能，先验证现状

写 `arch` 编辑器时顺手跑了一次现状验证，发现 `policy edit` / `remove`
**早就在抹掉 `arch:` 段**。

这件事跟本次要做的功能**毫无关系** —— 但它是**同一个文件**里的同一个函数
（`writePolicyYaml` 少传一个参数）。

如果没做这次验证：
- 新的 `arch` 编辑器会踩同一个坑（写了 `arch:` 段 → 下次 `policy edit` 抹掉）
- 而这个 bug 已经**存在了多久**、**影响了谁**，都不会有人知道

**「写新功能时顺手验证现状」是成本最低的缺陷发现方式** ——
因为你要动那些文件 anyway。

### 7.3 「另一个命令的副作用」是最容易被忘的护栏

`arch:` 段是架构护栏的判定依据，而它会被 `policy edit`（一个**看起来无关**的命令）
静默抹掉。

**护栏不是「配置」，护栏是「判定依据」。**
凡是承载判定依据的东西，被别的命令改坏时，后果都比「配置被改坏」严重。

---

## 8. 关联

- ADR-027（架构护栏可配偏离种类）—— `arch:` 段的来源
- ADR-040 §3.3（废弃段 `anchors:` 的处置）—— 「认它、忽略它、报出来」的先例
- C5（保护域与锚点外部化）—— 「改锚是人的决定」的依据
- D-23（第一轮演练暴露的两条策略治理面遗留）—— 本 ADR 的来源
