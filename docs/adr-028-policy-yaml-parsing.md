# ADR-028: 策略 YAML 解析语义修正——引号风格与行内键序

**状态**: 已实现
**日期**: 2026-11-06
**作者**: 系统架构
**关联约束**: C3, C5, C9
**关联文档**: `docs/zelto-技术架构.md`（§5 决策流程）, `src/core/policy/yaml.ts`,
`src/hook/index.ts`, `contracts/schemas/policy.json`

---

## 1. 摘要

`policy.yaml` 由两套手写解析器读取：`core/policy/yaml.ts`（提交时判定、CLI）
与 `hook/index.ts`（运行时逐写判定）。两者都只剥离**双引号**，
且行内 `match: { ... }` 靠**正则按位置**解析。

后果是：一条用单引号写的 `deny` 规则会被解析成带引号的字面量
（`'secrets/**'` 而非 `secrets/**`），glob 永不匹配，于是被更宽的 `allow` 规则捕获——
**策略写得越严，反而越容易被绕过**。这与 C9「写集预约运行时强制、判定确定」
和 C3「判定必须确定性」的精神相悖。

本提案把解析语义收敛到两条明确规则：

1. **引号风格无关**：单引号、双引号、无引号三种写法等价；
2. **行内键序无关**：`match: { operation: ..., path: ... }` 与
   `match: { path: ..., operation: ... }` 等价。

并加测试守住 **core 解析器与 hook 解析器对同一输入产出同一结果**。

---

## 2. 动机

### 2.1 现象：deny 规则被静默绕过

复现（`allow` 一切 + `deny` 子路径）：

| `deny` 规则写法 | hook 判定 | 预期 |
|---|---|---|
| `path: "secrets/**"` | `deny` | `deny` |
| `path: 'secrets/**'` | **`allow`** | `deny` ← fail-open |

`core/policy/yaml.ts` 与 `hook/index.ts` 的解析结果一致地错：

```
双引号: [["allow-all-write","**","allow"],["deny-secret","secrets/**","deny"]]
单引号: [["allow-all-write","**","allow"],["deny-secret","'secrets/**'","deny"]]
```

`'secrets/**'` 是个字面量字符串，与任何真实路径都不匹配，于是 `deny` 规则被跳过，
匹配到了 `path: "**"` 的 `allow`。

### 2.2 为什么这是 fail-open 而不是 fail-closed

zelto 的默认取向是 fail closed：判定不出来就拒绝（`pretool.ts` 中预约缺失、
`ask` 规则在非交互下、判定异常，一律 `deny`）。但**规则被静默跳过**走的是另一条路：

- 一条本该拦住写入的 `deny` 规则消失 → 写入被放行 → **越界写入成功**。

这是「判定规则少了一条」而不是「判定不出来」，两者语义完全不同。
C3 要求判定是确定性的：同一份 `policy.yaml` 换个引号风格就得出相反结论，
这本身就是不确定。

### 2.3 为什么现在才暴露

仓库自带的 `policy/policy.yaml` 全用双引号，所以**仓库自身不受影响**。
但 `policy.yaml` 是**用户可写的公开配置**（`contracts/schemas/policy.json`），
单引号是 YAML 里最常见引号风格之一，用户按直觉写就会踩到。
「本仓库恰好没踩到」不是「没问题」。

### 2.4 行内写法的第二个脆弱点

行内 `match:` 用正则按位置解析，`path` 必须写在前面：

```26:31:src/core/policy/yaml.ts
 * 支持两种写法：
 * - 行内：`match: { path: "src/**", operation: "write" }`
 * - 分行：`match:` 下面缩进写 `path:` / `operation:`
 *
 * `match` 必须把 `path` 写在前面 —— 行内写法靠正则按位置解析，
 * 写成 `{ operation: ..., path: ... }` 会被忽略。
```

实测：

| 写法 | 解析出的 `match` |
|---|---|
| `match: { path: "src/**", operation: "write" }` | `{"path":"src/**","operation":"write"}` |
| `match: { operation: "write", path: "src/**" }` | **`{}`** ← 规则被跳过 |
| `match: { path: 'src/**' }` | **`{}`** ← 规则被跳过 |

行内写法解析失败时**静默产生空 `match`**，而空 `match` 在 `evaluatePolicy` 里
「两个条件都不存在 → 匹配任何路径」或「都被跳过」，取决于调用点——
这本身就是不确定来源。

### 2.5 为什么多套解析器并存

`hook/` 是**可独立编译的判定进程**（AGENTS.md 目录约定），
不能 import `core/`（否则 hook 就得拖上整个 core 的编译产物）。
所以解析器有多份实现，是**有意为之**，不是疏忽。

但「有意复制」不等于「可以漂移」。架构文档 §5 决策流程第 4 步写的是
「策略规则匹配（与 core/ 相同逻辑）」——**文档承诺的一致性，现在没有测试守着**。

---

## 3. 决策

### 3.1 引号风格无关

`stripSurroundingQuotes()` 扩展为同时剥离单引号与双引号：

```typescript
export function stripSurroundingQuotes(s: string): string {
  if (s.length >= 2) {
    const first = s[0];
    const last = s[s.length - 1];
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
      return s.slice(1, -1);
    }
  }
  return s;
}
```

只剥**成对包裹**的引号，内部引号保留
（`"npx claude-code"` → `npx claude-code`；`"it's"` → `it's`）。
不成对（`'src/**`）不动。

**影响面**：这个函数还被 `cli/commands/shared.ts` 的配置解析用
（`agent.run` / `agent.adapter` / `llm.*` 等字段）。单引号此前会原样留在命令里
（`tests/acceptance/runtime-guard/runtime-guard.test.ts:27` 的注释已记录此事实）。
修复后单引号配置也能正常工作——**这是同向修复，不引入新行为差异**。

### 3.2 行内 `match` 改为按键值对解析

不再用「按位置」的正则，改为：把 `{ ... }` 内部按 `,` 切分，
每段按第一个 `:` 切成键值对，键值都过 `stripSurroundingQuotes()`。

由此：

- 键序无关（`operation` 在前也在后都一样）；
- 引号风格无关（单/双/无引号都一样）；
- 只写 `path` 或只写 `operation` 都正常（原来也支持，只是键序敏感）。

**不做的**：不引入完整的 YAML 解析库。
`core/` 零第三方运行时依赖是 C2 的硬约束，写死手写解析器是**被约束逼出来的选择**，
不是偷懒。

### 3.3 三套解析器的一致性由测试守住

hook 不能 import core，所以**代码层面无法合并**。
改为加一条**一致性测试**：对同一批 `policy.yaml` 样本，
断言 `core/policy/yaml.ts`、`hook/index.ts`（经由真实 hook 进程）、
`hook/pretool.ts` 解析出的规则**完全相等**。

这是「不合并代码，但锁死语义」的可行解——把 ADR-027 §6 里那句
「两处解析器并存是已知现状」升级为**有测试守护的现状**。

### 3.4 默认行为不变

只影响**当前解析失败的写法**（单引号、键序颠倒的行内 `match`）——
这些写法今天要么被静默跳过（规则失效），要么行为本就不确定。
原本用双引号、键序正确的文件，解析结果**逐字节不变**。

---

## 4. 实现位置

| 内容 | 位置 |
|---|---|
| 引号剥离 | `src/core/policy/yaml.ts` — `stripSurroundingQuotes()` 同时处理单/双引号 |
| 行内 `match` | `src/core/policy/yaml.ts` — `parsePolicyYaml()` 的行内分支改为按键值对解析 |
| hook 同步 | `src/hook/index.ts` — `parsePolicyYaml()` 同步同样的两处修正 |
| pretool 同步 | `src/hook/pretool.ts` — `parsePolicyRules()` 同步同样的两处修正（此前也只认双引号、键序敏感） |
| 一致性测试 | `tests/policy-parser-parity.test.ts` — 同一批样本断言 core / hook / pretool 三套解析器结果相等；并直接断言 deny 规则不被静默跳过 |

三处解析器**代码层面无法合并**（hook 必须可独立编译），语义靠等价性测试锁住。

**契约不变**：`contracts/schemas/policy.json` 不动。
schema 从未约束引号风格，本次是把实现修正到 YAML 的一般语义，
**不是新增能力**，属于「实现与契约本来就不一致」的纠正。
`policy/lock.json` 格式不变（哈希照旧对整个 `policy.yaml` 内容算）。

---

## 5. 约束合规检查

| 约束 | 检查 | 合规 |
|---|---|---|
| **C1** | 不新增状态位置；改的是纯解析函数 | ✅ |
| **C2** | `core/policy/yaml.ts` 仍只用 Node 内置（实际连内置都不用）；`hook/` 仍零 import core | ✅ |
| **C3** | 判定改为「同一份 YAML 必得同一结论」，比现状更确定；仍不调模型、不触网 | ✅ |
| **C4** | 不新增事件类型 | ✅ |
| **C5** | 保护域与锚点逻辑完全未动；deny 规则恢复生效是**收紧**不是放松 | ✅ |
| **C7** | 不涉及 LLM | ✅ |
| **C9** | 运行时逐写判定的规则集不再被静默削弱，fail-closed 取向更完整 | ✅ |

禁区检查：未新增自动批准、自动合并、自动改规格；本次改动**只可能让判定更严**。

---

## 6. 后果

**好的**

- 单引号写的 `deny` 规则恢复生效，消除一条 fail-open 路径。
- 行内 `match` 键序自由，用户不必记住「path 必须写在前面」。
- 两套解析器的一致性从此有测试守护，漂移会被 CI 拦下。
- `src/hook/pretool.ts` 此前只认双引号、只认「path 在前」的键序，
  是**第三条 fail-open 路径**（运行时逐写判定用的就是它）。本次一并修正。

**代价与边界**

- `stripSurroundingQuotes()` 是共享函数，配置解析（`shared.ts`）的行为随之改变：
  单引号包裹的 `agent.run` 等字段从此正确剥离引号。**这是修复**，但属于行为变化，
  故在此明确记录。
- 仍有**第三份解析器副本**在 `src/hook/pretool.ts`（`parsePolicyRules()`）。
  本次已同步到与 core / hook 完全一致（单双引号等价 + 键序无关 + 跳过 `arch:` 段），
  并由 `tests/policy-parser-parity.test.ts` 的等价性断言守住。
  但「三份副本」这个结构本身没有消除——彻底收敛仍受限于 hook 的独立编译要求，
  留待后续。

**明确不做**

- 不引入 YAML 库（C2 禁止 `core/` 加第三方依赖）。
- 不改 `policy.json` schema（本次是纠正实现，不是扩契约）。
- 不做「解析失败时报错而非静默跳过」的严格模式——那是另一次契约变更，另开 ADR。

---

## 7. 验收标准

1. `path: 'secrets/**'` 的 `deny` 规则，在「allow 一切 + deny 子路径」策略下判定为 `deny`。
2. `path: "secrets/**"` 的行为与修复前完全一致（无回归）。
3. 行内 `match: { operation: "write", path: "src/**" }` 解析出完整 `match`，不再为空。
4. core / hook / hook pretool 三套解析器对全部样本产出**逐字段相等**的规则集。
5. `npm run build` / `npm run lint` / `npm test` 全绿。
6. 原有双引号策略文件的解析结果**逐字节不变**。

---

## 8. 待决策（已定）

- **Q1（已定：解析语义向 YAML 一般规则靠拢，不扩契约）**：
  单引号在 YAML 里就是字符串定界符，实现此前只认双引号是**实现缺陷**，
  修正是对齐契约而非扩展契约，故不改 `policy.json`。
- **Q2（已定：不引入 YAML 库）**：
  `core/` 零第三方依赖是硬约束（C2），手写解析器是被约束逼出来的选择。
  若日后确需完整 YAML 语义，路径是**把解析器移到 `adapters/`** 并由 core 注入，
  而不是给 core 加依赖——但那是一次架构级提案，不在本次范围。
- **Q3（已定：一致性用测试锁，不合并代码）**：
  hook 必须可独立编译（AGENTS.md），代码层面无法合并；
  用等价性测试锁死语义是当前约束下的可行解。
