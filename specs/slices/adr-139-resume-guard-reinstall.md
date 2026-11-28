# Slice: adr-139-resume-guard-reinstall

## 目的

实施 ADR-139（`docs/adr/adr-139-resume-guard-reinstall.md`）：
**提问回路的续跑段必须重新装运行时守卫**（C9 的主防线 —— PreToolUse 钩子逐写判定）。

现在的洞：`zelto run` 在 `finally` 里释放守卫并撤掉钩子；
`zelto answer` 是**另一个进程**，直接 `adapter.resume()`，**不装守卫** ——
于是续跑段 agent 写的文件**没有经过任何运行时逐写判定**。

## 背景：这一片修的是「续跑段 agent 在没人看着的情况下改文件」

### 实测时间线（探针切片 `probe-claude-smoke`，2026-11-28 00:32–00:34）

```
00:32:28  run.started            ← 装守卫、装钩子
00:32:41  policy.decision ×3     ← 首轮判定正常
00:33:18  stall.classified       ← agent 提问，切片挂起
00:33:18  reservation.released  ← ★ 守卫释放、钩子撤掉
00:33:30  run.resumed            ← ★ 续跑 —— 守卫没重新装
00:34:05  run.finished           ← agent 在这段里写了探针文档
```

**续跑段一条 `policy.decision` 都没有。**

### 为什么少掉的是「主防线」，不是「少一层保险」

| 防线 | 时机 | 能拦住什么 |
|---|---|---|
| **PreToolUse 钩子**（主） | agent 每次写文件**之前** | 当场拒绝，agent 立刻拿到拒绝理由并能改道 |
| 运行后 git 审计（次） | agent 跑完之后 | 事后数出越界文件，**拦不住已经写出去的东西** |

少掉主防线 = 续跑段只剩事后审计 —— 越界文件**已经写进 worktree 了**，
补救是撤销提交，不是「当场拦下」。

更要紧的是**追溯性**：续跑段的写入在事件流里没有 `policy.decision`，
事后无法回答「这次写入当时被判成什么」—— 追溯链在这一段是断的（C4）。

### 这不是罕见路径

提问回路（ADR-013）是设计里的正常行为：agent 在规格不全时**主动停下问人**。
**任何一次「agent 问了问题」的切片，都必然经过续跑段。**
一个经常提问的项目 = 经常性地在无守卫状态下运行 agent。

## 范围

要改的：

- `src/cli/commands/question.ts` —— 续跑前装守卫（`installResumeGuard`），
  续跑结束后释放；**装不上就拒绝续跑**（fail closed）；续跑后跑写集审计
- `src/cli/commands/resume-guard.ts`（**新增**）—— 续跑段的守卫装法
- `src/cli/commands/shared.ts` —— `zeltoOwnedPaths` 从 `parallel-executor.ts` 搬来
  （见「导入环」一节）
- `src/cli/commands/parallel-executor.ts` —— `zeltoOwnedPaths` 改为 re-export
- `tests/adr-139-resume-guard.test.ts`（**新增**）—— 续跑段的守卫生命周期用例
- `tests/acceptance/adr-139-resume-guard-reinstall/acceptance.test.cjs`（**新增**）——
  端到端验收

只读参考（**不得修改**）：

- 只读 `docs/adr/adr-139-resume-guard-reinstall.md` —— 本片的规则真源。
- 只读 `src/cli/commands/core-slice.ts` —— 正常运行路径的守卫装法
  （**本片不改它**；它的守卫生命周期本来就对）。
- 只读 `src/cli/commands/runtime-guard.ts` —— 守卫的实现
  （**本片不改它**；本片只是**调用**它）。
- 只读 `src/hook/**` —— 判定内核（**本片不改它**）。
- 只读 `AGENTS.md` —— 项目约定。

## 一个实施时才发现的坑：导入环

装守卫要传「托管文件清单」（`zeltoOwnedPaths`）——
而它住在 `parallel-executor.ts`，**那个文件 import 了 `question.ts`**
（并行路径要检测提问）。

于是 `question.ts` → `parallel-executor.ts` → `question.ts` 成环。

**解法**：把 `zeltoOwnedPaths` 搬到 `shared.ts` ——
它不 import 任何 CLI 命令文件，所以谁都能 import。
`parallel-executor.ts` 保留 re-export，既有调用点不用改，
**判定仍然只有一份**。

**为什么不能省这一步**：没有托管文件清单，续跑段的审计会把
**zelto 自己写进 worktree 的文件**（规格副本、约束包镜像）
算成 agent 的越界写入 —— D-60 的同一个坑。

## 需求

- 无（本片没有关联的需求条目；验收口径见下）。

## 验收标准

1. **续跑段必须有写集预约** ——
   验证方式：单测断言续跑前预约文件（`.zelto/locks/` 下按切片 id 命名的那个）
   生效（`releasedAt` 为空）。
   > **为什么这条不能省**：预约是 C9 的**判据来源** ——
   > hook 读的就是它。没有预约，hook 只能「无从判定」。

2. **续跑段必须有 PreToolUse 钩子** ——
   验证方式：单测断言续跑期间 worktree 里有 zelto 装的那条 `PreToolUse`。
   只读 `.claude/settings.local.json` —— 该文件由守卫**代装**，agent 不改它。
   > **为什么这条不能省**：钩子才是「主防线」本身。预约只是判据来源，
   > 没人问就没人判。

3. **续跑段的判定要进事件流** ——
   验证方式：端到端验收 —— 续跑期间 agent 写文件，事件流里出现
   `policy.decision`（且落在 `run.resumed` 之后）。
   > **为什么这条不能省**：这是「修复有没有生效」的**唯一外部证据**。
   > 没有它，修复了也没人看得见。

4. **装守卫失败 → 拒绝续跑** ——
   验证方式：单测让 `installRuntimeGuard` 失败（拿不到预约），
   断言 `zelto answer` 返回非 0，且**没有调用 `adapter.resume`**。
   > **为什么这条不能省**：C9 明写「**预约缺失时 fail closed（一律拒绝）**」。
   > 降级成「只跑事后审计」= 拿不到判据就放行 = C9 被绕开。

5. **续跑结束必须释放** ——
   验证方式：单测覆盖三种结局（成功 / 失败退出码非 0 / 又提了新问题），
   断言三种都释放了（锁文件被释放、钩子被撤掉）。
   > **为什么这条不能省**：预约悬空 → 别的切片撞写集冲突；
   > 钩子留在盘上 → 跨进程期间它仍在生效（不该它在的时候它在）。

6. **基线快照重拍** ——
   验证方式：单测断言续跑段的基线快照是**续跑开始时**的脏文件，
   不是首轮的。
   > **为什么这条不能省**：不重拍的话，首轮写出的文件在续跑开始时
   > **已经是脏的** → 会被当成「预置脏」排除 → **续跑段真正越界写的
   > 东西反而被排除掉**。

7. **续跑段必须跑写集审计** ——
   验证方式：单测断言续跑结束后调了 `enforceWriteSet`；
   判成越界时**不进 gate**、切片退回 frozen。
   > **为什么这条不能省**：钩子只拦「agent 通过工具写文件」；
   > `git checkout` / `node -e "fs.writeFileSync(...)"` / 子进程写文件
   > 都绕过钩子 —— **审计是唯一兜住这些的防线**。
   > 而且门禁②跑的是验收测试，它不看写集：越界文件不会让验收失败，
   > 只会**被合进主干**。

8. **写集从切片记录取，不从 bundle 取** ——
   验证方式：单测断言装守卫时用的 `writes` 来自切片记录的 `writes`。
   > **为什么这条不能省**：bundle 是起跑时的快照，续跑是**另一个进程**；
   > 切片记录里的 `writes` 才是冻结时钉住的权威。

9. **`npm test` 全绿、`npm run lint` 通过。**

10. **不越界** —— 改动只在写集内；
    `docs/adr/adr-139-*.md` 的规则正文不得改动。
    验证方式：`git status --porcelain` 断言改动路径全部落在写集内。

## 关键实现要点（规格里已定，实施时不要重新发明）

### 装在哪：续跑前，释放于续跑后

```
zelto answer
  → 装守卫（installRuntimeGuard）        ← 本片新增
  → adapter.resume(...)                  ← agent 在守卫下跑
  → adapter.waitForExit(...)
  → 释放守卫（finally）                   ← 本片新增
  → 收尾：记账 → 门禁 → 签字请求
```

**释放点必须在「续跑结束」之后，而不是「门禁之前」** ——
续跑后 agent 又提了新问题时，切片**再次挂起**，
这时守卫也要释放（挂起是跨进程的，见下）。

### 写集：`slice.writes`，不是 bundle.writes

续跑时没有 bundle（那是起跑进程的快照）。用**切片记录里的 `writes`** ——
它是冻结时钉住的，才是「这片允许写什么」的权威。

### 基线快照：`installRuntimeGuard` 内部会重拍

`installRuntimeGuard` 每次调用都重拍 D-29 基线快照 ——
续跑时调用它，就自然是「续跑开始时的脏文件」。
**不需要**（也不应该）把它做成一个可选参数。

### 装不上 → 拒绝，不降级

```ts
try {
  guard = await installRuntimeGuard({...});
} catch (err) {
  console.error(`❌ 无法取得写集预约: ${msg}`);
  console.error(`   agent 不能在无守卫状态下续跑 —— 默认拒绝。`);
  return 1;
}
```

## 一个自查提醒（实施时不要按直觉走）

**「`zelto run` 已经装过守卫了，续跑不用再装」** —— 这是错的。

`zelto run` 的守卫在它的 `finally` 里释放了（只读
`src/cli/commands/core-slice.ts` 的 `finally`），
提问挂起时 `zelto run` **正常退出** → `finally` 跑掉 → 钩子被撤掉。
`zelto answer` 是**另一个进程**。

实测证据：探针切片的事件流里，`reservation.released`（00:33:18）
**早于** `run.resumed`（00:33:30）—— 守卫在续跑开始前就没了。

## 边界（规格里已定，实施时不要越界）

- **不改**写集匹配规则；
- **不改**hook 判定内核（`src/hook/**`）；
- **不改**事件流格式（C4）；
- **不动** `core/`（C2 保持）；
- **不引入**第三方依赖（只用 Node 内置）；
- **不改** `src/cli/commands/core-slice.ts` —— 它的守卫生命周期本来就对。
