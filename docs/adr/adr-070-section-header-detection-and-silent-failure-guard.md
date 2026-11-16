# ADR-070：段标题判据与「静默失败」防线 —— BOM 打穿 policy.yaml 的段识别

**状态**: 已实施
**日期**: 2026-11-16
**作者**: 系统架构
**关联约束**: C3, C5
**关联缺陷**: D-31（第三轮端到端复验新发现）
**关联文档**: `src/core/policy/section-editor.ts`,
`src/cli/policy/handlers/rules.handler.ts`,
`src/cli/policy/handlers/arch.handler.ts`,
`tests/policy-arch-editor.test.ts`

---

## 1. 摘要

ADR-068 引入了 `core/policy/section-editor.ts`（policy.yaml 的分段文本编辑），
并在第三轮端到端复验时**当场发现了它自己的缺陷**：

> **带 BOM（U+FEFF）的 `policy.yaml` 上，`policy edit` / `policy remove` /
> `policy arch edit` / `policy arch remove` 全部报告成功，
> 但文件一个字节都没变。**

根因是段标题判据：

```ts
// 修复前
if (lines[i].trim() === header && lines[i].length === header.length) {
```

JS 的 `trim()` 会把 BOM 当空白去掉（U+FEFF 属于 WhiteSpace），
所以 `trim() === 'rules:'` **成立**；但 `lines[i].length` 比标题多 1，
长度判据**不成立** → **整段找不到**。

**决策**：

- **D1**：段标题判据改为「**去掉 BOM 后的整行 == 标题**」。
  不再用长度相等（它排除缩进标题的能力可以用「整行相等」实现，
  而且更严）。
- **D2**：所有**编辑路径**在动手前先确认段存在（`hasSection`），
  段缺失就**报错**，绝不报告成功。
- **D3**：BOM **保留不抹** —— 编辑不改文件的编码标记。

---

## 2. 背景：D-31 是怎么发现的

写完 ADR-068 后做端到端复验。复验脚本在 PowerShell 里用
`Set-Content -Encoding UTF8` 造 `policy.yaml` —— **Windows PowerShell 5.1 的
`UTF8` 就是「带 BOM 的 UTF-8」**。

第一次复验的现象：

```console
$ zelto policy edit other --action deny
✓ Rule "other" updated.
  action: deny

$ cat policy/policy.yaml
rules:
  - id: keep-me
    ...
  - id: other
    action: allow      # ← 没变！
```

第一反应是「我的测试文件有问题」。把文件换成无 BOM 后，一切正常。

**但那不是测试问题 —— 那是真缺陷。** 因为：

1. **BOM 在 Windows 上极常见**：PowerShell 5.1 的 `Set-Content -Encoding UTF8`、
   记事本「另存为 UTF-8」、部分 IDE 默认设置。
2. **真实项目会踩到**：人手写的 `policy.yaml` 用什么编辑器保存，
   工具管不着。
3. **失败方式极其隐蔽**：命令报告成功，文件没变。
   人以为改完了，下一次 `policy validate` 却说锚点失配
   —— 而失配明明「没发生过」。

---

## 3. 为什么「长度相等」这个判据会被打穿

原判据：

```ts
lines[i].trim() === header && lines[i].length === header.length
```

两个条件各司其职：

| 条件 | 排除什么 |
|---|---|
| `trim() === header` | 内容不是这个段 |
| `length === header.length` | **缩进过的** `rules:`（它属于某条目，不是顶层段标题） |

第二个条件的本意是排除缩进。但它同时排除了一切**多出字符**的行 ——
包括 BOM。

```yaml
\uFEFFrules:        ← length = 7, header.length = 6  → 不匹配
  - id: x
```

`trim()` 的行为是关键：ECMAScript 的 `trim()` 移除的 WhiteSpace 包含
U+FEFF（ZERO WIDTH NO-BREAK SPACE，历史上是 UTF-8 BOM 的字节序标记）。
所以 `'\uFEFFrules:'.trim() === 'rules:'` 为 `true`，
而 `'\uFEFFrules:'.length === 6` 为 `false`。

**同一个字符，两个判据给出相反的答案。**

### 3.1 为什么不改用 `line.trim() === header`

那样更简单，但会丢掉「排除缩进标题」的能力：

```yaml
rules:
  - id: x
    match:
      path: "src/**"
    rules:        ← 缩进的，不是顶层段标题
```

虽然 `rules:` 出现在条目里不太可能，但它一旦出现就会**把段边界算错** ——
后面整段都会被当成本段的内容。

### 3.2 判据：**去 BOM 后的整行 == 标题**

```ts
function isSectionHeaderLine(line: string, header: string): boolean {
  const stripped = line.replace(/^\uFEFF/, '').replace(/\s+$/, '');
  return stripped === header;
}
```

- 「整行相等」= 不允许任何前导空白 → 天然排除缩进标题。
- 「去 BOM」= 修掉 BOM。
- 「去行尾空白」= 顺带容错 `rules:   `（YAML 允许，原判据会漏）。

**比原判据更严，不是更松** —— 原判据能匹配的，这一版都能匹配；
原判据匹配不到的（带 BOM / 带行尾空白），这一版能匹配。

---

## 4. D2：静默失败防线

修好判据之后，还有一个更一般的隐患：

> **两套解析器判据不一致时，编辑路径会静默失败。**
>
> `parsePolicyYaml`（core/policy/yaml.ts）用 `trim()` —— BOM 安全。
> `findSection`（core/policy/section-editor.ts）用长度 —— BOM 不安全。
>
> 当两者对同一份文件给出不同答案时：
> 「规则存在（解析器说的）」但「段找不到（编辑器说的）」
> → `removeSectionEntry` 原样返回 → 文件没变
> → **命令照样返回 `success: true`**。

这不是 BOM 专属的问题 —— 任何让两套判据分叉的输入都会踩到。
所以加一道**结构性防线**：

```ts
// 编辑前先确认段在
if (!hasSection(yaml, 'rules')) {
  return {
    success: false,
    message: `Cannot locate the "rules:" section in policy/policy.yaml — ...`,
  };
}
```

覆盖三条编辑路径：

| 路径 | 函数 | 段缺失时 |
|---|---|---|
| `policy remove` | `removePolicyRule` | 报错，不写盘 |
| `policy edit` | `editPolicyRule` | 报错，不写盘 |
| `policy arch edit` | `editArchGuard` | 报错，不写盘 |
| `policy arch remove` | `removeArchGuard` | 报错，不写盘 |

### 4.1 为什么不是「core 层抛异常」

也可以让 `removeSectionEntry` 在段缺失时抛。
但**抛异常是错的默认**：`appendToSection` 的语义是「段不存在就创建」，
那是**新增**路径的正常行为，不是错误。

判据放在 **handler 层**（命令语义层）更准确：
「这个命令要求段必须存在，找不到就是命令做不成」——
是命令层的事，不是编辑原语的事。

### 4.2 错误信息为什么提「BOM」

错误信息里点名 BOM，是因为它是**最可能的原因**。
不点名的话，人会以为策略文件坏了，去检查规则内容 —— 而规则内容完全没问题。

---

## 5. D3：BOM 保留不抹

编辑之后文件**仍然带 BOM**。

理由：

- **工具没有资格改文件的编码标记**。人用带 BOM 的编辑器保存，
  那是人的选择。BOM 在 UTF-8 里是**有意义的**（它是 BOM 本身的定义），
  只在「这文件是 UTF-8」的判断上有用，但抹掉它没有任何收益。
- **抹掉会造成一次额外的 diff**：文件本来带 BOM，工具改完后不带 ——
  下次改动的 diff 会莫名多一行。
- 仓库里的既有惯例也是**读时容错、写时不动**：
  `core/design/store.ts`、`core/version/branch.ts` 都是
  `content.replace(/^\uFEFF/, '')`（读时去掉，解析用），
  写回时原样写。

---

## 6. 影响面

### 6.1 改动

| 文件 | 改动 |
|---|---|
| `src/core/policy/section-editor.ts` | 新增 `isSectionHeaderLine` / `hasSection`；`findSection` 改用新判据 |
| `src/cli/policy/handlers/rules.handler.ts` | `remove` / `edit` 加段存在性检查 |
| `src/cli/policy/handlers/arch.handler.ts` | `arch edit` / `arch remove` 加段存在性检查 |

### 6.2 不变量

**C1（状态只在文件里）**：不涉及。
**C2（core 零依赖）**：新代码只用 Node 内置的字符串方法。
**C3（判定确定性）**：纯字符串判定，无随机、无时间、无网络。
**C5（锚点外部化）**：本 ADR **不自动改锚** —— 改锚仍是人的决定。
  与 ADR-068 §4.3 一致：编辑命令只**告诉人**下一步跑
  `zelto policy validate --update`。

### 6.3 兼容性

- 判据是**放宽**方向的（多匹配一些行），不会让原本能编辑的文件变得不能编辑。
- 原判据能匹配的行，新判据全部能匹配（去 BOM + 去行尾空白后整行相等
  ⟺ 原来 trim 后相等且长度相等）。
- 新增的 `hasSection` 是**新导出**，不改变任何既有签名。

---

## 7. 回归测试

`tests/policy-arch-editor.test.ts` 新增 D-31 一组（9 条）：

| 用例 | 断言 |
|---|---|
| `policy edit` 真的改了文件 | 文件含 `action: deny` |
| `policy remove` 真的删掉了规则 | 文件不含 `id: keep-me` |
| `policy arch edit` 真的改了文件 | 文件含 `action: deny` |
| `policy arch remove` 真的删掉了护栏规则 | 文件不含 `kind: cycle` |
| `policy arch list` 能读出带 BOM 的段 | 输出含 `cycle` |
| `policy arch add` 不产生重复段 | `arch:` 只出现 1 次 |
| `policy remove` 不抹掉带 BOM 的 `arch:` 段 | 文件含 `kind: cycle` |
| BOM 不会被写回时丢掉 | 文件仍以 BOM 开头 |
| 段缺失时报错而不是报告成功 | 退出码 ≠ 0 |

**关键断言**：前四条断言的是「**文件真的变了**」，不是「命令没报错」。

> 这是 D-30 与 D-31 的共同教训：
> **「命令成功」不等于「事情做成了」。**
> 测试断言必须落在**副作用**上，不能落在**返回值**上。

---

## 8. 遗留

- **「静默失败」防线目前只覆盖 policy 编辑路径**。
  其它「写文件然后报告成功」的路径（如 `slice-detail` 的 `set`）
  还没有同构的防线。是否统一提取成一个 `writeOrFail` 原语，
  留待后续 ADR 判断 —— 涉及面比本 ADR 大，不宜顺手做。
- **BOM 之外的编码问题**（GBK 误解码）由 `scripts/check-encoding.mjs`
  兜底，那是**事后**检出；本 ADR 是**事前**不踩。
