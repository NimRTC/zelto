# ADR-014: 运行时策略强制（写集预约由 hook 执行）

**状态**: 已实现
**日期**: 2026-11-04
**作者**: 系统架构
**关联约束**: C1, C2, C3, C4, C5, C6, C7, C8, C9
**关联文档**: `docs/adr-011-worktree-isolation.md`, `docs/adr-012-parallel-coordination.md`, `AGENTS.md`

---

## 1. 摘要

本 ADR 把 C9（切片的写集预约必须由 hook 在运行时强制执行）从**声明**变成**事实**。

在此之前，写集只用于两件事：准入时判断切片之间会不会撞车、合并时判断工件冲突。
「这个切片只允许写这些路径」从来只是一句承诺——agent 想写哪就写哪，
门禁看到的是提交之后的成品，不是过程。

本 ADR 引入三层强制：

1. **写集预约**（`.zelto/locks/<sliceId>.json`）——agent 运行期间存在的**运行时凭据**
2. **PreToolUse 钩子**——每写一个文件之前判定一次，越界当场拒绝
3. **运行后审计**——拿 git 的真实改动再对一次写集，兜住静态分析漏掉的写

---

## 2. 动机

### 2.1 现状

| 事实 | 位置 | 影响 |
|---|---|---|
| 写集只在准入/合并时被读 | `src/core/sched/engine.ts`、`src/core/sched/merge.ts` | 运行期间没有任何一处检查 agent 写了什么 |
| `zelto-hook` 只在 git pre-commit / pre-push 触发 | `src/cli/commands/hook-install.ts` | 拦住的是**提交**，不是**写入**——agent 可以随便写，只是不能提交 |
| 没有写集预约的概念 | — | 「这个切片只允许写这些路径」没有任何运行时载体 |
| C9 写在 `AGENTS.md` 里 | `AGENTS.md` 硬约束 | 约束无实现，等于没有约束 |

### 2.2 典型场景

```
场景：切片 S 的写集是 src/core/sched/**。
→ agent 在 worktree 里顺手改了 src/core/policy/engine.ts。
→ 没有人在运行期拦它 —— 写集只是一句说明。
→ 门禁跑的是「测试是否通过」，而越界的改动可能让测试通过。
→ 人签字，合并，然后发现策略引擎被改过了。
```

更糟的情况：agent 改了 hook 的配置文件，门禁从此不再触发。

---

## 3. 设计

### 3.1 写集预约（运行时凭据）

预约是「切片只允许写自己 writes 内路径」这件事在运行期间的载体（C1：只在文件里）：

```typescript
interface WriteReservation {
  sliceId: string;
  writes: string[];        // 允许写入的路径（glob / 目录前缀）
  worktree: string | null; // agent 实际工作的目录
  projectRoot: string;     // 主仓库根：policy / 预约 / 事件流都在这里
  acquiredAt: string;
  releasedAt: string | null; // null = 仍然有效
  pid: number;             // 持有预约的进程 —— 用来识别崩溃遗留的僵尸预约
}
```

落在 `.zelto/locks/<sliceId>.json`。

**没有预约就没有写集约束，因此预约缺失时一律拒绝（fail closed）。**
这条比「缺了就放行」重要：漏判一次的代价（越界写进版本库）远大于误判一次的代价。

`pid` 的用途是**僵尸预约的识别**：zelto 崩了以后预约会留在盘上，
下一个切片就取不到预约。`zelto reservation reap` 按 pid 判定进程是否还活着，
死了就把预约释放掉（`process.kill(pid, 0)`，EPERM 视为存活）。

### 3.2 PreToolUse 钩子（过程强制）

Claude Code 在每次工具调用**之前**触发 `PreToolUse` 钩子。zelto 把自己的判定
进程挂上去：

```jsonc
// <worktree>/.claude/settings.local.json
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "Write|Edit|MultiEdit|NotebookEdit|Bash",
        "hooks": [
          { "type": "command", "command": "node <zelto>/dist/hook/index.js pretool --project-root <repo> --worktree <wt> --slice <id> --zelto-pretool" }
        ]
      }
    ]
  }
}
```

钩子读 stdin 上的 `{tool_name, tool_input, cwd, session_id}`，按 C3 的确定性规则判定，
往 stdout 写 Claude Code 契约里的 `permissionDecision`。

**判定顺序（约束优先）：**

| 顺序 | 检查 | 拒绝时 basis |
|---|---|---|
| 1 | 路径逃逸（写到 worktree 之外） | `AGENTS.md#禁区` |
| 2 | 保护域（`policy/**`、`.zelto/**`、`AGENTS.md`、`.cursor/rules/**`） | `AGENTS.md#禁区` |
| 3 | 写集预约（切片只能写自己 writes 内的路径） | `slice:<id>#writes` |
| 4 | `policy/policy.yaml` 规则 | 规则自身的 basis |

顺序不可换：保护域在写集之前，因为**保护域不可被策略规则覆盖**（C5/C8）；
写集在 policy 之前，因为写集是**切片级**的硬边界，比策略更窄。

**`ask` 视为拒绝。** policy.yaml 里的 `ask` 规则要求人工确认，但 zelto 的运行是
非交互的——没有人能应答。非交互场景下「等确认」等于「永远不写」，
所以判定为拒绝并把原因写进事件流。

**判定不了就拒绝。** 输入解析失败、策略文件缺失、预约缺失——一律 deny。

**Bash 的写目标是静态分析。** 钩子解析命令里的重定向目标和已知写文件命令
（`touch`/`rm`/`mv`/`cp`/`mkdir`/`tee`/`sed -i`/`git apply` …）。
抽不出目标就不拦。任意解释器里的写（`node -e "fs.writeFileSync(...)"`）
静态分析得不出来——那正是 §3.3 兜底的原因。

### 3.3 运行后审计（兜底）

钩子能拦「声明出来的写」和「静态可见的 shell 写目标」，但拦不住
`node -e "fs.writeFileSync(...)"` 这类任意解释器里的写。

运行结束后，zelto 拿 git 的真实改动再对一次写集：

- `git status --porcelain --untracked-files=all` —— 未提交的工作区改动
- `git diff --name-only <base>..HEAD` —— 已提交的改动（基点 = 建分支时的 commit）

落在写集之外的改动 = 越界 = **不进 gate②、不自动生成签字请求**，
并写一条 `policy.violation` 事件。人来看。

**托管文件单独校验。** zelto 自己写进 worktree 的文件不计入越界，
但它们的**内容**必须原样：agent 改掉 hook 设置就等于关掉了门禁，
改了规格副本等于自动改规格。所以运行前记下哈希，运行后比对——
对不上就是篡改，同样记 `policy.violation`。

托管文件有三类：

| 文件 | 来源 | 篡改的后果 |
|---|---|---|
| `.claude/settings.local.json` | `installClaudeCodeHook` 写入 | 门禁被关掉 |
| 规格副本（`specs/slices/<id>.md`） | `syncContext` 从主仓库复制 | 自动改规格（AGENTS.md 禁区） |
| 验收目录副本（`tests/acceptance/<id>/**`） | `syncContext` 从主仓库复制 | 改验收标准 |

验收目录是目录，登记托管文件时要展开成里面每一个文件——
`core/sched/audit.ts` 的 `listFilesUnder` 干这件事。

**这些副本必须登记成托管文件，否则每次运行都会被自己的文件拦下。**
worktree 是从 baseCommit 检出的，规格与验收测试通常还没提交，
`syncContext` 把它们复制进去后就是未跟踪文件——审计阶段会被算成 agent 的越界写入。

### 3.4 生命周期

```
zelto run <id>
  ├─ 建 worktree（ADR-011）
  ├─ 取写集预约          → .zelto/locks/<id>.json     [reservation.acquired]
  ├─ 装 PreToolUse 钩子   → <worktree>/.claude/settings.local.json
  ├─ 起 agent
  │    └─ agent 每写一个文件 → hook 判定 → 写 policy.decision 事件
  ├─ agent 退出
  ├─ 写集审计            → git 真实改动 vs 写集        [policy.violation]
  ├─ 越界 → 不进 gate，等人处理
  └─ 释放预约 + 撤钩子                                     [reservation.released]
```

**钩子装在 worktree 里，不装在主仓库里。** Claude Code 只读当前工作目录下的
`.claude/settings.local.json`；但它读到的预约和策略仍在主仓库——
命令行里显式给了 `--project-root`。运行结束时 zelto 把钩子撤掉，
并把运行前的设置原文还原回去。

**没有 worktree 就不审计。** 不在 git 仓库里时隔离本身就不存在，
拿主仓库的 `git status` 去比对写集只会得到一堆假阳性。这种情况下不假装审计过。

### 3.5 并行批次

并行批次里每个切片一份预约、一份钩子。互不干扰：预约文件按切片 id 分开，
钩子装在各自的 worktree 里。批次结束时统一释放。

跨切片的写集冲突仍在**准入阶段**判定（`scheduler.checkConflicts`）——
那是静态判定，比运行期拦截早，也更省事。运行期强制不是准入的替代品，
是准入漏掉时的第二道防线。

---

## 4. 契约变更

| 变更 | 位置 | 说明 |
|---|---|---|
| 新增事件类型 `reservation.acquired` | `src/core/events/stream.ts`、`contracts/schemas/event-envelope.json` | 纯追加，不改已有取值 |
| 新增事件类型 `reservation.released` | 同上 | 同上 |
| 新增事件类型 `policy.violation` | 同上 | 同上 |
| 新增命令 `zelto reservation` | `src/cli/commands/reservation.ts` | list / active / show / release / reap |
| 新增模块 `src/core/sched/reservation.ts` | — | 预约的存取与僵尸清理 |
| 新增模块 `src/core/sched/audit.ts` | — | 运行后写集审计 |
| 新增模块 `src/hook/pretool.ts` | — | PreToolUse 判定进程 |
| 新增模块 `src/cli/commands/runtime-guard.ts` | — | 预约 + 钩子 + 审计 + 释放的编排 |
| 新增验收测试 | `tests/acceptance/runtime-guard/runtime-guard.test.ts` | 起真实 CLI 进程 + 假 agent，验四件事：钩子放行写集内 / 拦下写集外、绕过钩子的写由审计兜住、zelto 自己的文件不算越界、预约用完就释放 |

**`src/hook/pretool.ts` 刻意不 import `core/` 的其余部分**——hook 必须能被单独
编译分发（它跑在 agent 进程里，依赖越少越可靠）。`pathInWriteSet` 因此在
`core/sched/paths.ts` 与 `src/hook/pretool.ts` 各有一份，两份规则相同、
由测试对齐。

对齐点落在 `tests/write-set-parity.test.ts`：它把 pattern × path 的组合矩阵
跑一遍，逐个比较两边的结论，任何一处不一致就红。

**glob 语义只有一套：`core/policy/engine.ts` 的 `matchPath`。**
`core/sched/paths.ts` 的 `pathMatches` 现在直接委托给它，不再自己翻译 glob。
理由：policy.yaml 的规则匹配用的就是它。写集若另立一套，
`src/**/*.ts` 在「规则层」与「写集层」会得出不同答案——准入层会漏判
「两个切片都写 `src/a.ts`」这种冲突，运行时层却放行，审计层又判它越界，
三层互相打架。

具体语义：`双星号 + 斜杠` 匹配**零层或多层**目录（`src/**/*.ts` 覆盖 `src/a.ts`），
`裸双星号` 匹配任意层级（含斜杠），`单星号` 匹配单层内任意字符。
`src/hook/pretool.ts` 与 `src/hook/index.ts` 各自保持一份同样的翻译规则，
它们之间的一致性同样由测试保证。

---

## 5. 约束合规检查

| 约束 | 检查 | 合规 |
|---|---|---|
| **C1** | 预约落在 `.zelto/locks/*.json`；审计只读 git，不写状态 | ✅ |
| **C2 / C6** | `src/core/sched/` 与 `src/hook/` 只用 Node 内置模块，不 import `adapters/`（`core/sched/paths.ts` import 的是 `core/policy/engine.js`，仍在 `core/` 之内，依赖方向仍然向下） | ✅ |
| **C3** | 判定是路径匹配与查表，无模型、无网络 | ✅ |
| **C4** | 取/放预约、每次 hook 判定、审计结论都写 append-only 事件 | ✅ |
| **C5 / C8** | 保护域在写集与 policy 之前判定，策略规则改不动它 | ✅ |
| **C7** | agent 的输出一律不参与判定；`ask` 规则一律按拒绝处理 | ✅ |
| **C9** | 写集预约由 hook 在运行时强制执行，缺失预约 fail closed | ✅ |

---

## 6. 替代方案

### 方案 A：只用 git pre-commit 钩子

**放弃理由**：拦住的是提交，不是写入。agent 在运行期可以自由写，
只是最后提交不了。约束要生效在**动作发生的那一刻**，不是事后。

### 方案 B：用操作系统沙箱（容器 / seccomp / Landlock）

**放弃理由**：需要特权进程或平台特定能力，zelto 要跨平台跑。
真正的隔离不是 zelto 这个层该做的事——ADR-011 的 worktree 隔离已经解决了
「agent 改不到主仓库」这一层，剩下的「agent 别乱改别的文件」用 hook 足够。

### 方案 C：让 agent 自己声明写了什么，zelto 检查声明

**放弃理由**：等于让被监督者自己报告。没有强制执行点的自我声明没有约束力。

### 方案 D：把预约放在内存里

**放弃理由**：违反 C1。hook 是独立进程，读不到主进程的内存。

---

## 7. 决定

1. 写集预约落在 `.zelto/locks/<sliceId>.json`，含 `pid` 以识别僵尸预约
2. **预约缺失 = 拒绝写入**（fail closed）
3. PreToolUse 钩子装在 agent 实际工作的目录（worktree）里，判定顺序为
   路径逃逸 → 保护域 → 写集 → policy.yaml
4. policy 的 `ask` 规则在非交互运行下按拒绝处理
5. 运行后拿 git 真实改动再对一次写集；越界则不进 gate②、不自动签字
6. zelto 托管的文件单独校验内容哈希，改动即视为篡改
7. 新增 `zelto reservation` 命令，供人查看与释放预约
8. 审计与判定都**不覆盖**准入阶段的跨切片冲突检查——两者是两道防线，不是一道
9. 写集匹配与策略规则匹配共用同一套 glob 语义（`core/policy/engine.ts` 的
   `matchPath`），准入层、运行时层、审计层三者对同一个路径必须给出同一个答案；
   hook 那侧的独立副本由 `tests/write-set-parity.test.ts` 对齐
