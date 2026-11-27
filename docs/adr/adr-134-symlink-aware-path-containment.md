# ADR-134：路径 containment 必须符号链接感知（词法归一化可被 junction 绕过）

**状态**：已决（2026-11-27）· 待落地
**日期**：2026-11-27
**相关**：ADR-133（ACP 执行器）、ADR-083（多 harness 判定内核）、C2/C3/C9

**背景来源**：ADR-133 补记的「T3 值得学的三处」第一条。

## 背景

C9 的主闸门是**写集预约**：agent 每次写文件前，判定内核要确认「这个路径在本次切片的
写集内、且不在保护域、且没逃出隔离目录」。这条判定链的第一个环节是
`relativizeTarget()`（`src/hook/pretool.ts:114`）—— 把写入目标解析成
「相对 worktree 的路径」，解析不出来（逃出去了）就拒绝。

它做的是**纯词法**归一化：

```ts
export function relativizeTarget(target: string, worktreeRoot: string): string | null {
  const abs = isAbsolute(target) ? resolve(target) : resolve(worktreeRoot, target);
  const rel = toPosix(relative(resolve(worktreeRoot), abs));
  if (rel === '') return null;
  if (rel.startsWith('../') || rel === '..') return null;
  return rel;
}
```

**词法归一化看不见符号链接。**

### 实测的漏洞（Windows，2026-11-27）

构造：worktree 内有一个 junction 指向 worktree 外。

```
worktree = D:\MyOpen\zelto-symlink-test\wt
target   = D:\MyOpen\zelto-symlink-test\wt\escape\secret.txt
（wt\escape 是指向 D:\MyOpen\zelto-outside 的 junction）

zelto 现在的判定：
  relativizeTarget -> escape/secret.txt
  判定 -> 在 worktree 内，放行        ← 越界

realpath 感知（参照实现）：
  canonical -> D:\MyOpen\zelto-outside\secret.txt
  判定 -> 已逃出 worktree，拒绝        ← 正确
```

**为什么这不只是「越界」**：`escape/secret.txt` 的**词法路径**看起来在 worktree 内，
所以第 3 步「写集预约检查」也拿 `escape/secret.txt` 去比对 —— 它**同样落在写集里**
（比如写集是 `**` 或 `wt/**`）。于是：

1. 「逃出隔离目录」检查 —— **漏**（本该拒）
2. 「在写集内」检查 —— **误判为真**（本该拒）
3. 「不在保护域」检查 —— 保护域是按词法路径判的，**漏**

**三条检查同时失效** —— agent 只要在 worktree 里建一个指向外部的
junction/symlink，就能写到任意位置，而 C9 的主闸门看不到。

### 影响面比 ACP 大

`relativizeTarget()` **不是** ACP 专有的 —— 它在 `src/hook/pretool.ts` 里，
是 **hook 路线的共用判定内核**（ADR-083）。也就是说：

| 路线 | 当前判定点 | 受影响 |
|---|---|---|
| `claude-agent` / `claude-agent-sdk` | `.claude/` 的 `PreToolUse` hook | ✅ |
| `cursor-agent` | `.cursor/` 的 `preToolUse` hook | ✅ |
| `acp` | `session/request_permission` | ✅ |
| `codex` 等 | hook | ✅ |

**所以这不是「ACP 路线补个洞」，是主判定内核的洞** —— 三条路线一起漏。

### 参照实现：T3 Code 的做法

T3（`pingdotgg/t3code`，MIT）的
`packages/provider-acp/src/server/clientPolicy.ts` 里有 `acpCanonicalPathForContainment()`：

```ts
// Canonicalize existing ancestors for symlink-aware checks of new paths; fail closed on errors.
function acpCanonicalPathForContainment(path: string): string | undefined {
  // realpath must resolve symlinks before ..; lexical normalization can hide traversal.
  let candidate = path;
  const missingSuffix: Array<string> = [];

  while (true) {
    try {
      return NodePath.resolve(NodeFS.realpathSync.native(candidate), ...missingSuffix);
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException | undefined)?.code !== "ENOENT") {
        return undefined;
      }
    }
    try {
      NodeFS.lstatSync(candidate);
      return undefined;
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException | undefined)?.code !== "ENOENT") {
        return undefined;
      }
    }
    const parent = NodePath.dirname(candidate);
    if (parent === candidate) return undefined;
    missingSuffix.unshift(NodePath.basename(candidate));
    candidate = parent;
  }
}
```

**三个要点**：

1. **先 realpath 再判包含** —— 词法 `..` 归一化会掩盖符号链接逃逸；
2. **只解析已存在的祖先** —— 目标文件本身可能还不存在（新建文件），
   所以逐级向上找到第一个存在的祖先，对它做 realpath，再把不存在的后缀接回去；
3. **失败即拒绝（fail closed）** —— realpath 抛非 `ENOENT` 错误（比如 `EACCES`
   权限不足、`ELOOP` 循环链接）就返回 `undefined`，调用方一律当「不可信」处理。

## 决策

### 决策一：新增 `canonicalizeForContainment()`，放在 hook 判定层

**位置**：`src/hook/paths.ts`（**新增**）—— 放在 hook 层而不是 `core/`，因为：

- `core/` 零第三方运行时依赖（C2），这里只用 Node 内置 `fs`/`path`，不冲突；
- 但**路径判定必须留在各自的 hook 层**（ADR-133 已决：不合并为共享模块，
  `core/` 保持 C2 纯洁）；
- hook 必须能**单独编译分发**（不依赖 core 的其余部分）—— 所以放 `src/hook/`。

**为什么不直接改 `relativizeTarget()`**：`relativizeTarget()` 是**词法**工具，
它的语义就是「词法上相对谁」—— 用途不止 containment（还有事件的路径归一）。
把 realpath 塞进去会改变它的语义。所以：

- **新增** `canonicalizeForContainment(path, worktreeRoot)` —— 符号链接感知的解析；
- `relativizeTarget()` **保持原样**（词法），但 containment 判断**改用**新函数。

### 决策二：containment 判断改用 canonical 路径，**三条检查全部**

顺序不变（逃逸 → 保护域 → 写集），但**每一条都基于 canonical 路径**：

1. **逃逸检查**：`canonicalizeForContainment(target, worktreeRoot)` 返回 `null`
   → 判为逃逸 → 拒绝（`basis: 'AGENTS.md#禁区'`，`ruleId: 'protected:0a'`）。
2. **保护域检查**：用 canonical 相对路径判（保护域是硬编码的，见 ADR-083）。
3. **写集预约检查**：用 canonical 相对路径判。

**为什么三条都要用 canonical**：只改第 1 条不够 —— 上面的实测显示，
junction 指向的外部路径**词法上仍在写集内**，所以第 3 条会误判为真。
**只有三条统一用 canonical 相对路径，junction 才无处可藏。**

### 决策三：canonical 化失败 = 拒绝（fail closed）

`realpath` 失败（非 ENOENT）时**不猜**：

- 返回 `null` → 判定为「逃逸 / 不可信」→ 拒绝；
- 事件里记 `ruleId: 'protected:0a'`、`basis: 'AGENTS.md#禁区'`，
  reason 明确写「无法解析真实路径（可能是符号链接或权限问题），默认拒绝」。

**为什么不 fallback 到词法路径**：词法路径**已被证明可被绕过**（本文的实测）。
「解析不了就按词法算」= 把刚补上的洞重新打开。

### 决策四：**性能** —— realpath 只在必要时做

`realpathSync` 是**同步 syscall**，每次写都做会拖慢判定。缓解：

- **只在 containment 判定里做**，不在 hot path 的其它地方做；
- **逐级向上找到第一个存在的祖先**（T3 的做法）——
  新建文件（目标不存在）只需 realpath 它的父目录，代价是 O(深度) 而非 O(全路径)；
- **祖先缓存**：同一个 worktree 内，父目录的 realpath 结果在**一次判定批次**内缓存
  （键 = 目录绝对路径）。典型场景下多个写目标共享同一父目录 → 只 realpath 一次。

**缓存的生命周期**：单次 `judgeWriteTargets()` 调用内 —— 判定结束即失效，
不跨调用缓存（跨调用缓存会引入「目录在中途被换成 symlink」的时序问题）。

### 决策五：**不**改变保护域与写集的语义

本 ADR 只改「**怎么解析路径**」，不改「**路径该怎么判**」：

- 保护域清单**不动**（ADR-083，硬编码，不可被策略覆盖）；
- 写集匹配规则**不动**（`pathInWriteSet()` 的 glob/目录语义不变）；
- 事件流格式**不动**（C4）。

## 被否决的方案

1. **只在 ACP 路线补 realpath**：
   `relativizeTarget()` 是 hook 路线共用的 —— 只补 ACP 会让
   Claude Code / Cursor / Codex 三条路线**继续漏**。而那三条是当前主力路线。
2. **把 realpath 直接塞进 `relativizeTarget()`**：
   改变该函数的词法语义，而它的用途不止 containment（事件路径归一也在用）。
   语义漂移会让「词法相对路径」和「真实相对路径」在别处混用 —— 比漏判更难查。
3. **realpath 失败时 fallback 到词法路径**：
   等于把本文补上的洞重新打开。「解析不了」必须等于「拒绝」。
4. **用 `fs.realpath` 的异步版本**：
   判定层是**同步**的（`judgeWriteTargets()` 是纯函数，C3）。
   改成异步会把它拖出「纯计算」的形状，得不偿失。
5. **把 canonicalize 放进 `core/pathspec/`**：
   `core/` 的路径判定是给「计划/写集解析」用的，那里的路径**都是**配置里写的
   规范路径（不是 agent 现场给的），不需要 realpath —— 而且 `core/` 要保持
   可独立使用、不依赖文件系统状态。把 realpath 加进 `core/` 会让 `core/` 的
   判定**依赖磁盘状态**，违反 C3 的「判定只读文件、纯计算」的 spirit。

## 影响面

| 文件 | 改动 |
|---|---|
| `src/hook/paths.ts`（**新增**） | `canonicalizeForContainment()` + 祖先缓存 |
| `src/hook/pretool.ts` | containment 三条检查改用 canonical 路径 |
| `src/hook/acp.ts` | ACP 路径提取后走同一套 canonical 判定（不改提取逻辑） |
| `tests/hook/paths.test.ts`（**新增**） | canonicalize 的单测（含 junction / symlink / 不存在路径 / 失败关闭） |
| `tests/hook/pretool.test.ts` | 补「junction 指向外部 → 拒绝」的回归用例 |

**不涉及**：`core/policy/`、`core/gate/`、`core/sched/` 的判定逻辑（C3 不变）、
保护域清单、写集匹配规则、事件格式。

## 验收标准

1. worktree 内 junction 指向外部 → **拒绝**，事件里有 `ruleId: 'protected:0a'`；
2. junction 指向外部**但词法上在写集内** → 仍然**拒绝**（这是本 ADR 的核心用例）；
3. 正常写集内路径 → **放行**（行为不变）；
4. 新建文件（目标不存在）→ realpath 父目录后放行（不因「文件不存在」而误拒）；
5. realpath 失败（权限 / 循环链接）→ **拒绝**，reason 说明原因；
6. 现有 hook 单测全绿（行为不变的证明）；
7. 三条 hook 路线共用同一实现（`src/hook/` 一处，core 不动）。
