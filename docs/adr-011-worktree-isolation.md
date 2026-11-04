# ADR-011: 并行切片的工作树隔离（worktree isolation）

**状态**: 提案
**日期**: 2026-11-03
**作者**: 系统架构
**关联切片**: `parallel-worktree-isolation`
**关联约束**: C1, C2, C3, C4, C6, C7, C9
**关联文档**: `docs/zelto-并行自治计划.md`, `docs/zelto-技术架构.md`

---

## 1. 摘要

为每个切片建立独立的 git worktree（固定路径 `.zelto/worktrees/<sliceId>`，分支 `slice/<sliceId>`），
让 `zelto run` / `zelto run --parallel` 的执行目录与主仓库工作树彻底分开；
同时把写集回退链改为「切片写集 → 规格「范围」解析 → 默认探测」。

本 ADR 涉及两处需要显式记录的变更：**事件流新增两个事件类型**（触及
`contracts/schemas/event-envelope.json`），以及 **agent 适配器的工作目录从主仓库改为 worktree**。

---

## 2. 动机

现状（`docs/zelto-并行自治计划.md` §2 基线）：

| 事实 | 位置 | 影响 |
|---|---|---|
| 单切片 `run` 在主仓库 `git checkout -b slice/<id>` | `src/cli/commands/core-slice.ts:840` | 把用户当前分支切走 |
| 并行 `run` 依次在主仓库建分支再切回 main | `src/cli/commands/core-slice.ts:1133` | 所有 agent 共享同一工作目录，互相覆盖 |
| 空写集一律回退 `detectDefaultWrites()`（如 `src/**`） | `src/cli/commands/core-slice.ts:41` | 写集相同 → 必然两两冲突 |
| 门禁在主仓库 cwd 执行 | `src/cli/commands/core-slice.ts:1407` | 校验的不是 agent 改的那份代码 |
| `zelto diff` 在主仓库比对 | `src/cli/commands/diff.ts:31` | 看不到隔离目录里的改动 |
| adapter 工厂写死 `cwd: process.cwd()` | `src/cli/commands/shared.ts:704` | 没有地方能指定隔离目录 |

结论：并行执行当前不可用，且单切片执行会污染用户工作树。修复方式是执行目录隔离，而不是在
同一目录里做更聪明的冲突检测。

---

## 3. 设计

### 3.1 目录与分支

```
<repo>/.zelto/worktrees/<sliceId>/     ← worktree 工作目录（.zelto/ 已在 .gitignore 中）
    分支：slice/<sliceId>
```

- 分支在 worktree 内创建，主仓库当前分支不切换。
- worktree 的 git 元数据由 git 自己写在 `.git/worktrees/`，不额外造状态存储（C1）。

### 3.2 上下文同步

worktree 是干净检出，缺少三类上下文，创建后按需同步：

| 内容 | 方式 | 原因 |
|---|---|---|
| 规格文件 `specs/slices/<id>.md` | 复制主仓库当前版本 | 规格可能尚未提交，agent 必须看到冻结后的那一版 |
| 验收测试目录 `tests/acceptance/<id>/` | 复制主仓库当前版本 | 同上，验收测试常与规格同期编写 |
| `node_modules` | 平台连接（Windows `junction` / POSIX `dir`） | 门禁命令需要依赖；每次重装代价过高且易与锁文件漂移 |

同步失败必须报错并中止执行，不能静默跳过——门禁在缺依赖的目录里跑只会给出误导性结果。

### 3.3 写集回退链

```
slice.writes（非空）  →  直接使用
slice.writes（空）    →  解析规格「## 范围」中的反引号路径 → 写回 slice 文件
仍为空               →  detectDefaultWrites()（保留原有兜底）
```

解析出的写集必须写回 `.zelto/slices/<id>.json`，否则准入冲突检测（`Scheduler.checkConflicts`）
仍会拿空写集判断，等于没修。

### 3.4 事件流新增类型

worktree 的创建与移除是「每个动作写一条事件」（C4）覆盖范围内的动作，因此新增两个事件类型：

| 事件 | 触发点 | 关键 payload |
|---|---|---|
| `worktree.created` | worktree 创建成功 | `path`、`branch`、`baseCommit` |
| `worktree.removed` | worktree 移除成功 | `path`、`branch` |

`contracts/schemas/event-envelope.json` 的 `type` 枚举同步增加这两个值（纯追加，不改已有取值）。
审计摘要 `src/core/audit/trail.ts` 同步增加。

### 3.5 门禁与 diff 的执行目录

- `autoGateAfterRun` 与 `zelto gate <id>`：若该切片存在 worktree，则 `GateExecutor` 的
  `projectRoot` 指向 worktree，命令在该目录下执行。
- `zelto diff <id>`：若存在 worktree，则在 worktree 内比对 `base..工作区`，
  因此能看到尚未提交的改动。

### 3.6 签字后的提交与合并

worktree 里的改动在主仓库工作树中不可见，因此签字通过后：
1. 在 worktree 内按写集范围 `git add` 并提交（提交信息带 `Refs-Slice: <id>` trailer）；
2. 主仓库执行 `git merge --ff-only slice/<id>`；
3. 合并成功后移除 worktree。

`--ff-only` 的串行合并在多分支并行时仍会失败，这属于计划切片 C `parallel-merge-strategy`
的范围，本切片不改动合并策略，只保证单切片路径在隔离目录下依然走得通。

> **已被 ADR-018 更新**：本节描述的「签字通过后自动提交并合并」不再是现在的行为。
> 签字只改状态；提交 worktree 产物、生成合并计划、执行合并、清理 worktree，
> 全部由显式的 `zelto merge` 完成。见 `docs/adr-018-no-auto-merge-on-sign.md`。

---

## 4. 约束合规性检查

| 约束 | 检查 | 合规 |
|---|---|---|
| **C1** | worktree 元数据由 git 与 `.zelto/` 文件承担，无数据库 | ✅ |
| **C2** | `src/core/worktree/` 只用 `node:child_process` / `node:fs` / `node:path` | ✅ |
| **C3** | 创建/移除/写集解析均为本地确定性操作，无模型、无网络 | ✅ |
| **C4** | `worktree.created` / `worktree.removed` 各写一条事件 | ✅ |
| **C5/C8** | 未改动保护域与策略锚点 | ✅ |
| **C6** | `core/` 不 import `adapters/` | ✅ |
| **C7** | LLM 不参与写集或目录判定 | ✅ |
| **C9** | 准入仍走 `Scheduler.admit()` | ✅ |

---

## 5. 替代方案

### 方案 A：只在主仓库内做更细的冲突检测

**放弃理由**：无法回答「两个 agent 同时改同一个文件时谁赢」，也无法避免用户工作树被污染；
并行执行的物理隔离是前提。

### 方案 B：每个切片复制一份完整仓库目录（非 worktree）

**放弃理由**：成本高（每个切片一份 `node_modules`），且丢失 git 的分支/提交语义，
后续合并仍要手工搬运。worktree 是 git 原生机制，零额外状态。

### 方案 C：worktree 内不共享 `node_modules`，每个 worktree 各自安装

**放弃理由**：安装耗时随切片数线性增长，且 `pnpm install` 可能改动锁文件；
共享连接成本恒定，且不触碰依赖清单。

### 方案 D：用容器隔离

**放弃理由**：超出本项目定位（本地 CLI 工具），引入额外运行时依赖，违反 `core/` 零依赖精神。

---

## 6. 决定

采用 **方案 B 的反面：git worktree + 上下文同步**。

1. worktree 路径固定 `.zelto/worktrees/<sliceId>`，分支 `slice/<sliceId>`；
2. 规格与验收测试复制、`node_modules` 连接；
3. 写集回退链为「切片写集 → 规格范围 → 默认探测」，并写回切片文件；
4. 事件流新增 `worktree.created` / `worktree.removed`，合同枚举同步追加；
5. 门禁与 diff 在 worktree 内执行；签字后在 worktree 内提交，主仓库 ff 合并，成功后移除 worktree。
