# Slice: adr-134-symlink-containment

## 目的

实施 ADR-134（`docs/adr/adr-134-symlink-aware-path-containment.md`）：
让路径 containment 判定**符号链接感知** —— 先 `realpath` 解析真实落点，
再判「是否在 worktree 内 / 是否在写集内 / 是否在保护域」。

修掉一个**实测可复现的越界漏洞**：agent 在 worktree 内建一个指向外部的
junction/symlink，就能写到任意位置，而 C9 的主闸门看不到。

## 背景：这一片修的是「主判定内核的洞」，不是 ACP 的洞

### 实测漏洞（Windows，2026-11-27）

```
worktree = D:\MyOpen\zelto-symlink-test\wt
target   = D:\MyOpen\zelto-symlink-test\wt\escape\secret.txt
（wt\escape 是指向 D:\MyOpen\zelto-outside 的 junction）

zelto 现在的判定（relativizeTarget，纯词法）：
  -> escape/secret.txt
  -> 「在 worktree 内」-> 放行          ← 越界
```

**为什么三条检查同时失效**：`escape/secret.txt` 的**词法路径**看起来在 worktree 内，
所以「逃出隔离目录」检查漏了，**而写集检查拿同一个词法路径去比对**
——它也落在写集内，于是「在写集内」误判为真。保护域同理。

### 影响面比 ACP 大

`relativizeTarget()` 在 `src/hook/pretool.ts` 里，是 **hook 路线的共用判定内核**
（ADR-083）。Claude Code / Cursor / Codex / ACP **四条路线全中**。

**所以这不是「ACP 补个洞」，是主判定内核的洞** —— 必须修在 `src/hook/`。

## 范围

要改的：

- `src/hook/paths.ts`（**新增**）—— `canonicalizeForContainment()` + 祖先缓存
- `src/hook/pretool.ts` —— containment 三条检查改用 canonical 路径
- `src/hook/acp.ts` —— ACP 提取出的路径走同一套 canonical 判定
- `tests/hook/paths.test.ts`（**新增**）
- `tests/hook/pretool.test.ts`

只读参考（**不得修改**）：

- 只读 `docs/adr/adr-134-symlink-aware-path-containment.md` —— 本片的规则真源。
- 只读 `docs/adr/adr-133-acp-executor-and-permission-as-write-guard.md`
  —— 「T3 值得学的三处」的来源。

## 需求

- 无（本片没有关联的需求条目；验收口径见下）。

## 验收标准

1. **junction 指向 worktree 外 → 拒绝** ——
   验证方式：单测构造 junction（Windows）或 symlink（POSIX），
   断言 `judgeWriteTargets()` 返回 deny，
   且 `ruleId === 'protected:0a'`（与既有越界判定同一口径）。

2. **junction 指向外部但词法上在写集内 → 仍然拒绝**（**本片的核心用例**）——
   验证方式：单测里写集给 `**`（词法上必然「在写集内」），
   断言仍然 deny。
   > **为什么这条不能省**：只修「逃逸检查」是不够的 ——
   > 词法路径落在写集内会让写集检查误判为真。**三条检查必须统一用 canonical 路径。**

3. **正常写集内路径 → 放行**（行为不变的证明）——
   验证方式：现有 hook 单测全绿；新增一条「普通相对路径放行」的用例。

4. **新建文件（目标不存在）→ 放行** ——
   验证方式：单测用一个**不存在**的目标路径（父目录存在），
   断言放行。
   > **为什么这条不能省**：canonicalize 要逐级向上找第一个**存在的**祖先。
   > 如果实现成「目标必须存在才放行」，新建文件会被全部误拒 —— 那等于把功能改废了。

5. **realpath 失败 → 拒绝**（fail closed）——
   验证方式：单测构造 realpath 抛非 ENOENT 的场景
   （如 `ELOOP` 循环链接，或权限不足的目录），
   断言 deny，且 reason 里含「无法解析真实路径」之类的说明。

6. **三条检查统一用 canonical 路径** ——
   验证方式：断言 `src/hook/pretool.ts` 里 containment 判定段
   **只**用 canonical 相对路径，**不再**直接用 `relativizeTarget()` 的词法结果。

7. **判定层不含第三方依赖**（C2）——
   验证方式：`src/hook/paths.ts` 只 import `node:fs` / `node:path`；
   断言 `src/core/arch/imports.ts` 的白名单之外没有新增依赖。

8. **`npm test` 全绿、`npm run lint` 通过。**

9. **不越界** —— 改动只在写集内；
    `docs/adr/adr-134-*.md` 的规则正文不得改动
   （ADR 已定稿，实施阶段只许照着做，不许顺手改规则）。
    验证方式：`git status --porcelain` 断言改动路径全部落在写集内。

## 关键实现要点（规格里已定，实施时不要重新发明）

### canonicalize 的形状

```
canonicalizeForContainment(target, worktreeRoot) -> string | null
  返回：相对 worktree 的 canonical 路径（posix 分隔符）
        null = 逃逸 / 无法解析（两种都拒绝，但 reason 要能区分）
```

**算法（逐级向上找第一个存在的祖先）**：

```
candidate = target
missingSuffix = []
loop:
  try: return resolve(realpathSync.native(candidate), ...missingSuffix)
  catch e:
    if e.code !== 'ENOENT': return null      // 非「不存在」→ 失败即拒
  // candidate 不存在 → 看它的父目录
  parent = dirname(candidate)
  if parent === candidate: return null        // 到根了还没找到存在的祖先
  missingSuffix.unshift(basename(candidate))
  candidate = parent
```

**为什么这样**：
- 目标文件本身可能还不存在（新建文件）→ 只能 realpath 它的**父目录**；
- 逐级向上让代价是 O(深度) 而不是 O(全路径)；
- `ENOENT` = 「这一级不存在，往上找」；**其它错误一律拒绝**。

### 失败即拒绝（不要 fallback 到词法）

`realpath` 失败时**不猜** —— 不许 fallback 到词法路径。
理由：词法路径**已被实测证明可被绕过**（本片背景）。
「解析不了就按词法算」= 把刚补上的洞重新打开。

**但 reason 要能区分两种 null**：
- 逃逸（解析出来了，但不在 worktree 内）；
- 无法解析（realpath 失败）。
审计要能看出这两种不是一回事。

### 祖先缓存的生命周期

- 缓存**只在单次 `judgeWriteTargets()` 调用内**有效；
- 键 = 目录绝对路径，值 = 该目录的 realpath；
- 判定结束即失效，**不跨调用缓存**。
  > **为什么**：跨调用缓存会引入「目录在中途被换成 symlink」的时序问题 ——
  > 判定时看到的是旧的真值，写入时目录已经变了。

### 不改 `relativizeTarget()` 的语义

`relativizeTarget()` 是**词法**工具，语义是「词法上相对谁」——
它的用途不止 containment（事件路径归一也在用）。
把 realpath 塞进去会改变它的语义，造成「词法相对路径」与「真实相对路径」
在别处混用 —— 那比漏判更难查。

所以：**新增** `canonicalizeForContainment()`，**不改** `relativizeTarget()`。

## 边界（规格里已定，实施时不要越界）

- **不改**保护域清单（ADR-083，硬编码，不可被策略覆盖）；
- **不改**写集匹配规则（`pathInWriteSet()` 的 glob/目录语义）；
- **不改**事件流格式（C4）；
- **不动** `core/`（C2 保持；路径判定留在 hook 层，ADR-133 已决）；
- **不引入**第三方依赖（只用 Node 内置）。
