# Slice: parallel-worktree-isolation

## 目的

让 `zelto run` 与 `zelto run --parallel` 真正做到物理隔离：每个切片在独立的 git worktree
中执行，主仓库工作树不被切分支、不出现 agent 的未提交改动；写集为空时从规格「范围」解析；
门禁与 diff 在该切片的 worktree 内完成。

对应计划条目：`docs/zelto-并行自治计划.md` §4 切片 A。

## 范围

- `src/core/worktree/`（新建，仅用 Node 内置）：
  - `manager.ts` — 创建 / 查询 / 移除 worktree，路径固定 `.zelto/worktrees/<sliceId>`，
    分支 `slice/<sliceId>`；提供上下文同步（规格文件、验收测试目录、`node_modules` 连接）。
  - `index.ts` — 导出。
- `src/core/spec/scope.ts`（新建）— 解析规格 `## 范围` 中的反引号路径，供写集回退使用；
  `src/core/spec/index.ts` 导出该函数。
- `src/cli/commands/shared.ts` — `createExecutorAdapter` 增加 `cwd` 参数（当前写死 `process.cwd()`）。
- `src/cli/commands/core-slice.ts`：
  - `run` 与 `runParallel` 不再在主仓库 `git checkout`；每个切片在自己的 worktree 内建立分支。
  - 写集回退链改为：`slice.writes` → 规格「范围」解析 → `detectDefaultWrites()`，
    并把解析到的写集写回 `.zelto/slices/<id>.json`。
  - `autoGateAfterRun` 在该切片的 worktree 内执行门禁。
  - `abandon` 移除该切片的 worktree。
- `src/cli/commands/gate-sign.ts` — `zelto gate <id>` 在 worktree 内执行；
  签字通过后若存在 worktree，则在该 worktree 内提交切片改动，再由主仓库合并分支。
- `src/cli/commands/diff.ts` — `zelto diff <id>` 在 worktree 内比对，可看到未提交改动。
- `src/core/events/stream.ts` — 新增事件类型 `worktree.created` / `worktree.removed`。
- `contracts/schemas/event-envelope.json` — 同步新增两个事件类型枚举值。
- `src/core/audit/trail.ts` — 新增事件的审计摘要。

## 验收标准

1. 两个写集不相交的切片 `zelto run --parallel` 能同时启动，且各自改动互不可见。
2. 执行期间主仓库的当前分支不发生切换，主工作树不出现 agent 的未提交改动。
3. 空写集切片从规格「范围」得到写集并写回 `.zelto/slices/<id>.json`。
4. 门禁在该切片的 worktree 内执行，失败信息指向该 worktree 的产物。
5. `zelto diff <id>` 能看到 worktree 内尚未提交的改动。
6. worktree 移除失败时给出明确提示，不吞异常。

## 不包含

- 并行分支的合并排序与冲突处理（见计划切片 C `parallel-merge-strategy`）。
- agent 提问回路与续跑（计划切片 B）。
- 运行时策略强制（计划切片 D）。
- 任何 GUI、常驻 daemon、自动批准、自动合并策略的重新设计。

## 约束自查

- **C1** 状态只在文件里：worktree 元数据由 git 自身（`.git/worktrees/`）与 `.zelto/` 承担，
  不引入数据库。
- **C2 / C6** `src/core/worktree/` 只用 Node 内置模块，不 import `adapters/`。
- **C3** 判定确定性：worktree 创建/移除与写集解析均为纯本地操作，不调模型、不触网。
- **C4** 创建与移除 worktree 各写一条 append-only 事件。
- **C5 / C8** 不改保护域与策略规则。
- **C7** LLM 产出不参与任何判定。
- **C9** 写集预约仍由 `Scheduler.admit()` 执行，不绕过。

## 风险

- worktree 缺 `node_modules` / 构建产物会导致门禁命令跑不起来 → 用连接（junction/符号链接）
  共享主仓库的 `node_modules`。
- Windows 与 POSIX 的连接创建方式不同 → 按平台选择 `junction` / `dir`。
- `git worktree` 子命令在旧版 git 不可用 → 创建失败时给出明确错误，不静默降级。
- 合同 schema 变更（事件枚举）→ 见 `docs/adr-011-worktree-isolation.md`。
