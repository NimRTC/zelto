# ADR-139：提问回路的续跑段必须重新装运行时守卫

**状态**：已决（2026-11-28）· 已落地（提交 `2aeb18d`）
**日期**：2026-11-28
**相关**：ADR-013（提问回路）、ADR-014（运行时写集守卫）、ADR-129/130（运行身份）、C1/C4/C9

**背景来源**：用 zelto 开发 zelto 的实测（2026-11-28，探针切片 `probe-claude-smoke`）。

## 背景

C9 写的是「**写集预约运行时强制** —— 以 PreToolUse 钩子逐写判定为主、运行后 git 审计兜底」。
「为主」的意思是：**agent 写的每一个文件，都应该当场被判定一次**，
而不是等它跑完再拿 git 审计去数。

zelto 的正常运行路径（`zelto run`）确实是这样：

```ts
// src/cli/commands/core-slice.ts
activeGuard = await installRuntimeGuard({ sliceId: id, writes: bundle.writes, ... });
//   → 取写集预约 + 装 PreToolUse 钩子 + 拍 D-29 基线快照
// ... agent 跑 ...
// finally: await guard.release();   ← 撤钩子 + 释放预约
```

**但提问回路的续跑段没有这一步。**

实测时间线（探针切片 `probe-claude-smoke`，2026-11-28 00:32–00:34）：

```
00:32:28  run.started            ← 装守卫、装钩子
00:32:41  policy.decision ×3     ← 首轮判定正常（hook 在工作）
00:33:18  stall.classified       ← agent 提问，切片挂起
00:33:18  reservation.released  ← ★ 守卫释放、钩子撤掉
00:33:30  run.resumed            ← ★ 续跑 —— 守卫没重新装
00:34:05  run.finished           ← agent 在这段里写了 docs/probe.md
```

**续跑段（00:33:30 → 00:34:05）一条 `policy.decision` 都没有** ——
钩子已经撤掉了，agent 在这段时间里写的文件**没有经过任何运行时逐写判定**。

原因在 `src/cli/commands/question.ts`：

```ts
// src/cli/commands/question.ts:311
const resumed = await adapter.resume(record.zeltoSessionId, answerText, ...);
const exitCode = await adapter.waitForExit(newSessionId);
// ... 收尾：记账 → 门禁 → 签字请求
```

**整条续跑路径上没有 `installRuntimeGuard`，也没有 `guard.release()`。**
守卫是在 `core-slice.ts` 的 `finally` 里释放的 —— 提问挂起时
`zelto run` 正常退出，`finally` 跑掉，钩子被撤掉了。
然后 `zelto answer` 是**另一个进程**，它根本不知道要重新装。

### 为什么这是洞，不只是「少一层保险」

C9 的两道防线是**主次关系**：

| 防线 | 时机 | 能拦住什么 |
|---|---|---|
| **PreToolUse 钩子**（主） | agent 每次写文件**之前** | 当场拒绝，agent 立刻收到拒绝理由并能改道 |
| 运行后 git 审计（次） | agent 跑完之后 | 事后数出越界文件，**拦不住已经写出去的东西** |

少掉主防线之后，续跑段只剩事后审计 —— 而事后审计的后果是：
**越界的文件已经写进 worktree 了**。补救手段是撤销提交，
不是「当场拦下」。这就是「主」和「次」的区别。

更要紧的是**可追溯性**：续跑段的写入在事件流里没有 `policy.decision`，
于是事后审计时无法回答「这次写入当时被判成什么」——
追溯链在这一段是断的（C4：事件是追溯的唯一证据载体）。

### 提问回路为什么会走到续跑

提问回路（ADR-013）不是罕见路径 —— agent 在规格不全、信息不足时
**主动停下问人**是设计里的正常行为（ADR-013 §3.6）：
「切片在 `agent_question` 停机类上挂起，不跑门禁、不进签字流程」，
人回答后**在同一个 agent 会话里续跑**。

也就是说：**任何一次「agent 问了问题」的切片，都必然经过续跑段。**
一个经常提问的项目（规格写得不够细的时候），等于**经常性地**
在无守卫状态下运行 agent。

## 决策

### 决策一：`zelto answer` 的续跑前重新装守卫

`zelto answer` 在调用 `adapter.resume()` **之前**装一次守卫，
在续跑结束后释放。

```ts
// src/cli/commands/question.ts
const guard = await installRuntimeGuard({
  sliceId,
  writes: slice.writes,
  worktree: existingWorktreePath(sliceId) ?? null,
  projectRoot: process.cwd(),
  baseCommit: slice.baseCommit ?? null,
  managedPaths: zeltoOwnedPaths(worktree, slice),
  specIntegrity: buildSpecIntegrity(worktree, slice),
  harness: harnessForAdapter(adapterType),
  writeGuard: writeGuardForAdapter(adapterType),
});

try {
  const resumed = await adapter.resume(...);
  ...
} finally {
  await guard.release();
}
```

**为什么不是「第一次跑时装着，挂起时不撤」**：

挂起是**跨进程**的（`zelto run` 退出 → 人思考 → `zelto answer` 启动）。
钩子留在盘上跨越这段时间，会出现两个问题：

1. **预约悬空** —— `.zelto/locks/<sliceId>.json` 一直占着写集，
   别的切片撞写集冲突（ADR-014 的并发保护）；
2. **钩子在 agent 不跑的时候仍挂着** —— 期间任何碰巧读到
   `.claude/settings.local.json` 的进程都会走一遍判定。

所以「挂起时撤、续跑时重装」是对的 —— 只是**重装那一步漏了**。

### 决策二：装守卫失败 → 拒绝续跑（fail closed）

装守卫失败（写集预约拿不到、钩子装不上）时，
**不能续跑**：

```ts
try {
  guard = await installRuntimeGuard({...});
} catch (err) {
  console.error(`❌ 无法取得写集预约: ${msg}`);
  console.error(`   agent 不能在无守卫状态下续跑 —— 默认拒绝。`);
  return 1;
}
```

**为什么 fail closed**：C9 写的是「**预约缺失时 fail closed（一律拒绝）**」。
续跑段缺守卫 = 预约缺失 = 按 C9 的口径就该拒绝。

**为什么不降级成「只跑事后审计」**：那正是这个 ADR 要修的现状。
「拿不到判据就放行」= 让 agent 在没人看着的时候改文件。

### 决策三：释放时机 —— 续跑结束后释放，不管续跑成功还是失败

`finally` 里释放，和 `core-slice.ts` 的 `finally` 一致。
失败路径（agent 续跑后退出码非 0）也要释放 ——
不然预约悬空，下一片撞冲突。

**一个例外**：续跑后 agent **又提了新问题**（`detectQuestion` 命中）时，
切片**再次挂起**。这时守卫也要释放（决策一的同一理由：挂起是跨进程的）。
所以释放点必须在「续跑结束」之后，而不是「门禁之前」。

### 决策三之二：续跑段也要跑事后审计（`enforceWriteSet`）

装上守卫只是补回「主防线」。**「次防线」在续跑段同样是缺的** ——
`question.ts` 现在直接调 `autoGateAfterRun()`，
**没有调 `enforceWriteSet()`**。

对比正常路径（`run-finish.ts` 的 `finishRun`）：

```
记账 → enforceWriteSet（审计）→ 提问检测 → 状态迁移 → 门禁 → 签字
```

续跑路径（`question.ts`）：

```
记账 → ❌没有审计 → 提问检测 → 状态迁移 → 门禁 → 签字
```

**为什么这一条不能省**：

1. **审计能抓到钩子抓不到的东西**。钩子拦的是「agent 通过工具写文件」；
   agent 用 `git checkout`、`node -e "fs.writeFileSync(...)"`、
   或者子进程写文件，都绕过钩子。审计是唯一兜住这些的防线。
2. **审计是「边界未知」的唯一出口**。`auditWorktreeWrites` 读不到 git 状态时
   返回 `error` —— 那是 fail closed 的信号（ADR-014 / D-61）。
   没有审计，续跑段的边界就永远是「未知但没人说」。
3. **门禁不应该在一段没审计过的运行之后放行**。门禁②跑的是验收测试，
   它不看写集 —— 越界的文件不会让验收失败，只会被**合进主干**。

**怎么改**：续跑段结束时调 `enforceWriteSet(sliceId, guard)`，
判据与 `finishRun` 完全一致（同一个函数，同一份实现）。
判成越界 → 不进门禁（`enforceWriteSet` 已经把切片退回 frozen 并写了事件）。

**为什么不直接复用 `finishRun`**：`finishRun` 的记账、状态迁移、
花费结算、门禁、签字与 `question.ts` 现在做的事**有重叠但不完全一样**
（`question.ts` 有 `run.resumed` 的身份处理、有「又提问了」的分支、
失败路径的停机分类也不同）。
把 `question.ts` 整体改写成 `finishRun` 的调用 = 改的是**整条收尾流水线**，
远超本片范围，且会动到提问回路的身份语义（ADR-130）。
**本片只补审计这一道** —— 用同一个 `enforceWriteSet`，其余照旧。

### 决策四：写集从切片记录取，不从 bundle 取

`core-slice.ts` 用的是 `bundle.writes`（起跑时从规格解析出来的写集）。
续跑时没有 bundle 了 —— 用**切片记录里的 `writes`**：

```ts
const slice = await store.read(sliceId);
const writes = slice.writes;
```

**为什么不用 bundle**：bundle 是起跑时的快照，续跑是**另一个进程**，
读 bundle 会引入「快照与当前记录不一致」的可能。
切片记录里的 `writes` 是**冻结时钉住**的（freeze 钉住写集），
它才是「这片允许写什么」的权威。

### 决策五：基线快照必须重拍

`installRuntimeGuard` 会拍 D-29 基线快照（运行开始时 worktree 就已经脏的路径）。
续跑段必须**重拍**，不能沿用首轮的快照。

**为什么**：首轮跑完时 agent 可能已经写了 `docs/probe.md`，
那个文件在续跑开始时**已经是脏的** —— 但它是**首轮的产出**，不是续跑的。
不重拍的话，续跑段的审计会把首轮的产出算成「基线脏」排除掉，
于是**续跑段真正越界写的东西反而被当成预置脏排除**了。

重拍的口径与首轮一致：「此刻 worktree 已经脏的路径」——
续跑段越界写的东西在续跑开始时还不脏，所以不会被误排除。

### 决策六：事件流里要能看出「续跑段有守卫」

`installRuntimeGuard` 会写一条 `reservation.acquired` 事件，
`release()` 会写一条 `reservation.released`。这两条落在**续跑**的时段里，
于是追溯链能看出「续跑段是有守卫的」。

**为什么要显式留痕**：这个 ADR 修的正是「续跑段没守卫」，
如果修完之后事件流里看不出差别，下一个人没法验证这个修复有没有生效。
`reservation.acquired` / `reservation.released` 成对出现在 `run.resumed`
之后，就是证据。

## 被否决的方案

1. **挂起时不撤钩子**（让守卫跨进程存活）：
   预约悬空 → 别的切片撞写集冲突；钩子在 agent 不跑的时候仍挂着。
   决策一的同一段话。
2. **装守卫失败时降级续跑（只靠事后审计）**：
   决策二。拿不到判据就放行 = C9 的 fail closed 被绕开。
3. **把守卫的安装/释放抽成一个「会话」对象，两处共用**：
   听起来更干净，但 `core-slice.ts` 的守卫生命周期与**整轮运行**绑定
   （含重试、含 detach 移交），`question.ts` 的守卫生命周期与**一次续跑**绑定。
   两者的边界不同，抽公共抽象会得到一个「生命周期可配置」的守卫 ——
   那正是容易漏分支的地方（ADR-083 里「同一个结论两处产出」的同形状坑）。
   **两处各写一遍，但参数来源只有一处**（切片记录的 `writes`）。
   决策七的同一段话。
4. **在 `question.ts` 里直接 import `parallel-executor.ts` 的 `zeltoOwnedPaths`**：
   成环（`parallel-executor.ts` import 了 `question.ts`）。
   决策七把它搬到了 `shared.ts`。

## 影响面

| 文件 | 改动 |
|---|---|
| `src/cli/commands/question.ts` | 续跑前装守卫、结束后释放；装不上就拒绝续跑；续跑后跑写集审计 |
| `src/cli/commands/resume-guard.ts`（**新增**） | 续跑段的守卫装法（参数与判定口径集中在一处） |
| `src/cli/commands/shared.ts` | `zeltoOwnedPaths` 从 `parallel-executor.ts` 搬来（见决策七） |
| `src/cli/commands/parallel-executor.ts` | `zeltoOwnedPaths` 改为 re-export（判定仍在 `shared.ts`） |
| `tests/adr-139-resume-guard.test.ts`（**新增**） | 续跑段的守卫生命周期用例 |
| `tests/acceptance/adr-139-resume-guard-reinstall/acceptance.test.cjs`（**新增**） | 端到端验收：续跑段有 `policy.decision` |

**不涉及**：写集匹配规则、hook 判定内核、事件格式、`core/`（C2 保持）。
**不改** `src/cli/commands/core-slice.ts` —— 它的守卫生命周期本来就对。

### 决策七：`zeltoOwnedPaths` 搬到 `shared.ts`（实施时发现的导入环）

装守卫要传「托管文件清单」，而它住在 `parallel-executor.ts` ——
**那个文件 import 了 `question.ts`**（并行路径要检测提问）。

于是 `question.ts` → `parallel-executor.ts` → `question.ts` 成环，
`question.ts` 拿不到托管文件清单 —— 而没有它，续跑段的审计会把
**zelto 自己写进 worktree 的文件**（规格副本、约束包镜像）算成 agent 的越界写入
（D-60 的同一个坑）。

**解法**：把 `zeltoOwnedPaths` 搬到 `shared.ts`。
`shared.ts` 不 import 任何 CLI 命令文件（只 import `core/` 与 `adapters/`），
所以它谁都能 import。环被打断，判定仍然只有**一份**
（`parallel-executor.ts` 保留 re-export，既有调用点不用改）。

**为什么不抽一个「守卫会话」抽象**（已被否决的方案三）：
`core-slice.ts` 的守卫生命周期与**整轮运行**绑定（含重试、含 detach 移交），
`question.ts` 的守卫生命周期与**一次续跑**绑定。
抽公共抽象会得到一个「生命周期可配置」的守卫 ——
那正是容易漏分支的地方（ADR-083 里「同一个结论两处产出」的同形状坑）。
**两处各写一遍，但参数来源只有一处**（切片记录的 `writes`）。

## 验收标准

1. **续跑段必须有写集预约** —— `zelto answer` 续跑前装守卫，
   `.zelto/locks/<sliceId>.json` 生效。
2. **续跑段必须有 PreToolUse 钩子** —— 续跑期间 agent 写文件会被判定。
3. **续跑段的判定要进事件流** —— 续跑期间写文件产生 `policy.decision` 事件。
4. **装守卫失败 → 拒绝续跑** —— 不降级成「无守卫续跑」。
5. **续跑结束必须释放** —— 成功、失败、又提问三种结局都要释放。
6. **基线快照重拍** —— 续跑段越界写的东西不会被当成「预置脏」排除。
7. **续跑段必须跑写集审计** —— 续跑结束后调 `enforceWriteSet`；
   判成越界 → 不进门禁、切片退回 frozen。
8. **现有 hook 单测全绿、`npm test` 全绿、`npm run lint` 通过。**
9. **不越界** —— 改动只在写集内。

## 一个自查提醒（实施时不要按直觉走）

**「`zelto run` 已经装过守卫了，续跑不用再装」** —— 这是错的。

`zelto run` 的守卫在它的 `finally` 里释放了（`core-slice.ts:2205`），
提问挂起时 `zelto run` **正常退出** → `finally` 跑掉 → 钩子被撤掉。
`zelto answer` 是**另一个进程**。

实测证据：探针切片的事件流里，`reservation.released`（00:33:18）
**早于** `run.resumed`（00:33:30）—— 守卫在续跑开始前就没了。

---

## 版本追溯

| 字段 | 值 |
| --- | --- |
| 所属版本号 | v0.7.1 |
| 关联 ADR 编号 | ADR-139 |
| 提交哈希 | 2aeb18dd22e4543efe48ade1dd6b6adac87e8244 |
| 验证方式 | [tests/adr-139-resume-guard.test.ts 8 个用例全绿 + npm test 全绿 + npm run lint 通过 + 人工复核] |
