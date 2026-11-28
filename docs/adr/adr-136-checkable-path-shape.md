# ADR-136：路径值先过「形状判据」，不是路径的东西不许进入判定流程

**状态**：已决（2026-11-27）· 待落地
**日期**：2026-11-27
**相关**：ADR-133（ACP 执行器）、ADR-134（符号链接感知 containment）、ADR-135（unknown 传播）、C3/C9

**背景来源**：ADR-133 补记的「T3 值得学的三处」第三条。

## 背景

判定内核拿到的「写入目标」最终是一个**字符串**。zelto 现在的做法是
「按候选字段名找，找到第一个非空字符串就用」：

```ts
// src/hook/acp.ts:158
function pickPath(input: Record<string, unknown>): string | undefined {
  for (const key of ['path', 'file_path', 'filePath', 'target_file',
                     'absolute_path', 'relative_workspace_path', 'filename']) {
    const v = input[key];
    if (typeof v === 'string' && v) return v;    // ← 只看「是非空字符串」
  }
  ...
}
```

**只检查「是不是非空字符串」，不检查「它是不是一个路径」。**

于是这些值会被当成路径塞进判定流程：

| 值 | 实际是什么 | 词法归一化后的下场 |
|---|---|---|
| `~/../../etc/passwd` | agent 的 home 展开 | 取决于当前平台，`~` 被当普通目录名 |
| `file:///etc/passwd` | URL | `file:` / `etc` / `passwd` 变成三段目录 |
| `C:\Windows\x` | Windows 盘符路径 | 在 POSIX 上被当相对路径 |
| `a\0b` | 含 NUL 字节 | NUL 在路径里非法，fs 调用会抛 `ERR_INVALID_ARG_VALUE` |
| `   ` | 纯空白 | 归一化后变成 `.` 或 worktree 根 |
| `''` | 空串 | 某些路径里被当 cwd |

**两个具体后果**：

1. **判定结果取决于归一化技巧，而不是「这个值根本不是合法路径」**。
   `file:///etc/passwd` 经过 `resolve()` + `relative()` 会变成
   `<worktree>/file:/etc/passwd` —— 落在 worktree 内、可能落在写集内 → **放行**。
   而 agent 真正要写的是 `/etc/passwd`。

2. **NUL 字节会让判定流程抛异常**。路径里含 `\0` 时，
   `fs` 的调用（ADR-134 引入的 realpath 就会撞上这个）会抛
   `ERR_INVALID_ARG_VALUE` —— 判定层崩掉，而不是 fail closed。

### 参照实现：T3 Code 的 `acpCheckablePath()`

T3（`pingdotgg/t3code`，MIT）的
`packages/provider-acp/src/server/clientPolicy.ts` 对「什么算一个可检查的路径」
有明确判据：

```ts
/**
 * The path as given when policy can resolve it the way the agent will. Blank strings, non-strings
 * and NUL bytes name no file. A relative path that starts with `~`, has a URL scheme or drive
 * prefix, or uses backslashes on a POSIX host may mean another file to the agent than it does
 * when joined to the working directory.
 */
function acpCheckablePath(value: unknown): string | undefined {
  if (typeof value !== "string" || value.trim().length === 0 || value.includes("\0")) {
    return undefined;
  }
  if (NodePath.isAbsolute(value)) return value;
  if (value.startsWith("~") || /^[A-Za-z][A-Za-z0-9+.-]*:/.test(value)) return undefined;
  if (NodePath.sep === "/" && value.includes("\\")) return undefined;
  return value;
}
```

**拒绝的四类**：

1. **空串 / 纯空白 / 非字符串 / 含 NUL 字节** —— 这些**不指任何文件**；
2. **`~` 开头** —— `~` 的展开规则各 agent 不同（`~` vs `~/` vs Windows 的
   `~\`），zelto 猜不出 agent 会展开成什么 → **不敢判**；
3. **带 URL scheme 或盘符前缀**（`file://`、`http://`、`C:`）——
   不是本地路径，或者本地路径但用了别的分隔符；
4. **POSIX 主机上的反斜杠** —— `a\b` 与 `a/b` 在 POSIX 上含义不同。

**注释里的核心论证**：

> may mean another file to the agent than it does when joined to the working directory

—— 「**对 agent 来说可能指另一个文件**，比拼起来之后指的文件不同」。
这句话是整条规则的根据：**判定的对象必须是「agent 真正会写的那个文件」**，
而不是「一个我们能归一化的字符串」。

## 决策

### 决策一：新增 `isCheckablePath()`，作为路径进入判定流程的**前置闸门**

**位置**：`src/hook/paths.ts`（与 ADR-134 的 `canonicalizeForContainment()` 同文件）。

**判定规则的形状**（比 T3 略宽，因为 zelto 面对的平台更杂）：

```
不是路径，当且仅当：
  1. 不是字符串                       → 不是路径
  2. trim 后为空                       → 不是路径
  3. 含 NUL 字节（\0）                 → 不是路径
  4. 以 '~' 开头                       → 不是路径（展开规则猜不出）
  5. 含 URL scheme（^[A-Za-z][A-Za-z0-9+.-]*:）且不是 Windows 盘符 → 不是路径
  6. 在 POSIX 主机上含反斜杠            → 不是路径
```

**与 T3 的差异（要写清楚）**：T3 的第 5 条把**所有** `scheme:` 前缀都拒了，
包括 Windows 盘符 `C:`。zelto 是**跨平台**的（Windows 上 `C:\foo` 是正常路径），
所以第 5 条要排除**盘符**形态（`^[A-Za-z]:[\\/]`）。

**为什么 `~` 一律拒**：zelto 不做 tilde 展开（那需要知道 agent 的 home 目录，
而 agent 可能与 zelto 进程不同用户、不同 HOME）。**不做就不猜** ——
猜错了 = 判错文件 = 越界。

### 决策二：形状判据**先于**一切路径处理

顺序固定：

```
agent 给的原始值
  → 形状判据（isCheckablePath）        ← 不通过 = 不是路径，直接出局
  → 提取（rawInput / content / locations / title）
  → 归一化（relativizeTarget，词法）
  → canonical 化（ADR-134，符号链接感知）
  → 判定（保护域 / 写集 / 逃逸）
```

**形状判据在最前面** —— 因为它回答的是「**这是不是一条路径**」，
而后面的步骤回答的是「**这条路径在哪**」。顺序反了就会出现
「把 `file:///etc/passwd` 归一化成 `<worktree>/file:/etc/passwd` 再判它安不安全」。

### 决策三：形状不通过 = **该来源不可用**，不等于「判定通过」

**这是本 ADR 最容易做错的地方。**

形状判据不通过时，**不是**「这个路径安全，放行」，也**不是**「立刻拒绝」，
而是：**这个来源不提供写目标**。

- 若该来源是**唯一**的写目标来源 → 落到 ADR-135 的语义：
  「读到的写目标为空」 vs 「读不全」要分清：
  - 值**存在**但**形状不对** → 这是一个**形状非法**的写目标 → **unknown** → 拒绝；
  - 值**根本不存在**（字段没有）→ 这才是「没有写目标」。
- 所以形状不通过要**上报为 unknown**（ADR-135 的 `'unknown'`），
  而不是静默地变成 `undefined`。

**为什么不能静默忽略**：一个 agent 故意传 `file:///etc/passwd`，
zelto 静默忽略它 → 判据里没有它 → 放行 → agent 写了 `/etc/passwd`。
**这正是「不认识 ≠ 放行」（ADR-083 §2）。**

### 决策四：形状判据**共用**，不只 ACP

`isCheckablePath()` 放在 `src/hook/paths.ts`，
**三条 hook 路线共用**（Claude Code / Cursor / Codex 的路径提取也过这道闸门）。

理由与 ADR-134 一样：`harness.ts` 的 `pickPath()` 也是「取第一个非空字符串」，
同样不过滤 `~` / URL scheme / NUL。**修一条漏两条**不是可接受的现状。

### 决策四之一：形状闸门放在**判定内核**，不在各路线的提取层

**闸门的位置**：`judgeWriteTargets()` —— 所有路线最终都过它
（ACP 的 `judgeAcpPermission()` 与 hook 的 `runPreTool()` 都调它）。

**为什么不在提取层过滤**（这是实测纠正的一个前提）：

> ~~hook 路线判不出写目标时本来就是**拒绝**（ADR-083 §2）~~

**这句话是错的**（实测 2026-11-27）：`judgeWriteTargets([])` 返回
`{ decision: 'allow', basis: 'hook:no-target' }` —— **空目标是放行**，
不是拒绝（且有既有测试断言这个行为：`tests/hook/pretool.test.ts`
「allows when there are no targets to judge」）。

所以「在提取层把形状非法的值过滤掉」会**制造一个新的绕过**：

```
Write 的 file_path = "file:///etc/passwd"
  → 提取层过滤掉（形状非法）
  → 提取结果 = []
  → judgeWriteTargets([]) = allow      ← 放行！
```

**这正是 ADR-136 要堵的洞，被「过滤」这个动作亲手放开了。**
静默过滤 = 把「可能有写目标」当成「没有写目标」= ADR-083 §2 说的
「不认识 ≠ 放行」的反面。

### 决策四之二：形状非法 → **拒绝**，用新的 basis

在判定内核里，形状非法的写目标**直接拒绝**：

```
basis: 'hook:malformed-path'
ruleId: 'hook:malformed-path'
reason: 写入目标 "<原值>" 不是合法路径（<具体哪一条>），默认拒绝。
```

**为什么不复用 `'unknown'`（ADR-135 的三态）**：
`'unknown'` 的语义是「**读不全** —— 可能还有别的写目标」（判据不完整）；
而形状非法是「**读到了**，但它不是路径」（判据完整，结论是「非法」）。
两者都拒绝，但**理由不同，事件里要能区分** —— 否则事后审计分不清
「载荷读不出来」与「载荷里有畸形路径」，前者是 agent/适配器的问题，
后者更可能是**故意试探**。

**ACP 路线额外多一层**：ACP 的提取层已经知道「这个字段存在但形状非法」
（`pickPathChecked()` 返回 `malformed`），所以它在提取阶段就返回
`'unknown'`（ADR-135 决策三的口径）。这是**上游更严格**，不是矛盾 ——
ACP 的载荷形状更杂，提取层能分辨「字段不存在」与「字段畸形」，
判定内核则拿不到这个区别（它只看到字符串）。

**hook 路线只有判定内核这一层**：提取层已经把值原样传下来了，
所以形状判定只能发生在判定内核。两条路线的最终效果一致
（都拒绝，理由都写明「不是合法路径」）。

## 被否决的方案

1. **把形状判据塞进 `relativizeTarget()`**：
   `relativizeTarget()` 是**词法**工具，且它的返回值语义是
   「相对路径或 null（逃逸）」。混入「不是路径」会让调用方分不清
   「逃逸了」和「这不是路径」—— 两种都要拒绝，但**理由不同**，
   事件里要能区分。ADR-133 已经定过「拒绝要在事件里留完整证据」。
2. **对形状非法的值做 tilde 展开 / URL 解析后再判**：
   那是在**替 agent 猜**它的意图。zelto 的立场是
   「规格里没写的行为 → 停下来问，不许按『更合理』的直觉补全」（AGENTS.md）。
   `~` 展开规则、URL 语义都不是 zelto 说了算的。
3. **只加 NUL 字节检查，其它不管**：
   NUL 是**崩溃**风险（必须修），但 `file:///etc/passwd` 是**越界**风险
   （更严重）。只修崩溃不修越界 = 修了小的漏了大的。
4. **在 adapter 层过滤**：
   过滤必须发生在**判定内核的入口**（hook 层），
   否则每条路线各写一遍、各漏一遍 —— 这正是 ADR-083 要防的
   「同一个结论两处产出」。
5. **在各路线的提取层把形状非法的值过滤掉**：
   实测证明这是**制造新绕过**（见决策四之一）：hook 路线的空目标是**放行**，
   过滤掉畸形路径 = 「提取结果为空」= **放行**。
   静默过滤把「可能有写目标」当成「没有写目标」，正是本 ADR 要堵的洞。

## 影响面

| 文件 | 改动 |
|---|---|
| `src/hook/paths.ts`（**新增**，与 ADR-134 同文件） | `isCheckablePath()` |
| `src/hook/pretool.ts` | **判定内核**加形状闸门：形状非法的写目标 → 拒绝（`hook:malformed-path`）。三条路线共用这一处 |
| `src/hook/acp.ts` | 路径提取的每个来源过形状判据；形状非法 → unknown（ADR-135）—— 提取层更严格，不与内核矛盾 |
| `tests/hook/paths.test.ts`（**新增**） | 形状判据单测（含 Windows 盘符、POSIX 反斜杠、URL scheme、NUL、`~`） |
| `tests/hook/paths.test.ts` | 判定内核的形状闸门用例（hook 路线：畸形路径 → 拒绝，不放行） |
| `tests/hook/acp.test.ts` | 形状非法 → unknown 的用例 |

**不涉及**：保护域清单、写集匹配规则、事件格式、`core/`（C2 保持）。
**不改** `src/hook/harness.ts` —— 提取层过滤会制造绕过（见决策四之一）。

## 验收标准

1. `~/../../etc/passwd` → 不是路径 → 不进入判定（ACP 路线 → unknown → 拒绝）；
2. `file:///etc/passwd` → 不是路径 → 同上；
3. 含 `\0` 的值 → 不是路径 → 同上，且**判定流程不抛异常**；
4. 纯空白 / 空串 → 不是路径；
5. Windows 盘符 `C:\foo\bar`（在 Windows 上）→ **是**路径，正常判定；
6. POSIX 主机上的 `a\b` → 不是路径；
7. 正常的相对路径 `src/a.ts`、绝对路径 → 是路径，行为不变；
8. 形状非法的值**不能**被静默忽略成「没有写目标」
   （ACP 路线必须是 unknown → 拒绝）；
9. **hook 路线**：形状非法的写目标 → 判定内核**拒绝**
   （`hook:malformed-path`），**不得**因为提取层过滤掉而变成
   「空目标 → 放行」；
10. **宽写集不放松**：写集为 `**` 时，`file:///etc/passwd` 仍然被拒绝
    （实测：不加形状闸门时它归一化成 `<worktree>/file:/etc/passwd`
    落在写集内 → **放行**）。
