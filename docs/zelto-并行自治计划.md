# zelto 并行自治计划

> 版本: v0.1 · 生成: 2026-11-03 · 状态: **待签字（未冻结）**
> 上游讨论：能否让一个人独立完成一个大项目——手工并发 3~4 个 agent 时协调成本高，
> 且 agent 经常中途停下来等人回答，拖慢节奏。

本文件是**跨切片的计划**，不是切片规格。每个条目落地前必须单独在 `specs/slices/<id>.md`
写规格、走 `zelto check` / `zelto freeze` / 门禁 / 签字，然后才动代码。

---

## 1. 目标与非目标

### 目标

1. 让 `zelto run --parallel` 真正安全：多个 agent 物理隔离、互不覆盖、互不误判冲突。
2. 让 agent 的"停下来等人"变成可观测、可分流、可自动续跑的事件，而不是一次静默的成功退出。
3. 把"每行代码可追溯到人批准的规格"这条不变量，从**提交时校验**前移到**agent 运行时校验**。

### 非目标（对照 AGENTS.md 负向清单）

- 不做完整 GUI、不做一键批准、不做常驻 daemon。
- 不自动改规格、不重造 agent 编排引擎、不做路由自动学习。
- 不把"人工签字"这一环去掉：`gate → sign` 保留，自动化止步于"待签字"。

---

## 2. 现状基线（带代码位置）

| 事实 | 位置 | 影响 |
|---|---|---|
| 单切片 `run` 在主仓库执行 `git checkout -b slice/<id>` | `src/cli/commands/core-slice.ts:840` | 把用户当前分支切走 |
| 并行 `run` 为每个切片在主仓库 `git checkout -b`，随后切回 main | `src/cli/commands/core-slice.ts:1133` | 所有 agent 共享同一工作目录，互相覆盖 |
| 空写集一律回退到 `detectDefaultWrites()`（如 `src/**`） | `src/cli/commands/core-slice.ts:41`、调用点 `:777`、`:1078` | 所有切片写集相同 → 必然两两冲突 |
| 写集冲突检测按目录前缀粗判 | `src/core/sched/engine.ts:194`、`:216` | `src/**` 与 `src/a/**` 判为冲突（可接受），但反向的误杀来自上一行的回退 |
| 门禁在主仓库 cwd 执行 | `src/cli/commands/core-slice.ts:1407`、`src/core/gate/executor.ts:76` | 校验的不是 agent 改的那份代码 |
| `zelto diff` 在主仓库比对 `baseCommit..HEAD` | `src/cli/commands/diff.ts:31` | 看不到隔离目录里的未提交改动 |
| 签字通过后 `git merge --ff-only` + `git branch -d` + 自动 push | `src/cli/commands/gate-sign.ts:288`、`:380` | 第二个并行分支必然 ff 失败；与负向清单"自动合并"抵触（见 §6） |
| 停机分类器有 6 类，但调用点只用 `type: 'test_failure'` | `src/core/stall/classifier.ts:34` vs `src/cli/commands/core-slice.ts:1462` | `permission_prompt` / `plan_gate` / `cognitive_stuck` 永远不会被判定出来 |
| `isAutoResolvable` 把 `environment_failure` 视为可自动解决 | `src/core/stall/classifier.ts:28` | 所有非零退出都被当成环境故障重试，掩盖真实原因 |
| agent 以 `--permission-mode bypassPermissions` 启动 | `src/adapters/claude-agent/index.ts:213` | 运行期没有权限拦截点 |
| `zelto-hook` 只安装为 git `pre-commit` / `pre-push` | `src/cli/commands/info-help.ts:623` | **agent 写文件期间完全不过策略**，C9 只在提交那一刻才生效 |
| adapter 能力声明 `resume: false` / `events: false` | `src/adapters/claude-agent/index.ts:91` | 无法把追问注入回同一个会话 |
| adapter 工厂写死 `cwd: process.cwd()` | `src/cli/commands/shared.ts:704`、`:715`、`:723` | 没有地方能指定隔离目录 |
| 事件类型里 `policy.decision` 已定义但无写入点 | `src/core/events/stream.ts` | 运行时判定无审计留痕 |
| `budget.spent` / `merge.completed` / `merge.stale_base` 已定义未见写入点 | 同上 | 成本与合并过程不可追溯 |

---

## 3. 待解决问题

### P0 —— 让并行跑得起来（对应"手工协调 3~4 个 agent 很难"）

- **P0-1** 并行 agent 共享主工作目录 → 互相覆盖，且把用户分支切走。
- **P0-2** 空写集回退成 `src/**` → 真并行也判为冲突，并行入口形同虚设。
- **P0-3** 门禁/diff 不在 agent 实际工作的目录里跑 → 通过的门禁不代表真实产物。

### P1 —— 让 agent 不必停下来等人（对应"agent 有时自动停下来等待"）

- **P1-1** agent 以问题收尾（"该返回 404 还是 422？"）时，zelto 视为成功退出，问题被吞掉。
- **P1-2** 停机分类器形同虚设，6 类里只有 1 类真正被触发。
- **P1-3** adapter 不支持 resume，问答之后无法接回原会话。

### P2 —— 把不变量前移

- **P2-1** 策略判定只在 git 提交时发生，agent 运行期无拦截（与 C9 的意图有差距）。
- **P2-2** 并行合并策略缺失：ff-only 串行合并必然在第二个分支失败。
- **P2-3** 关键事件无写入点，事后无法回答"当时是谁、依据什么、判定成什么"。

---

## 4. 切片清单

### 切片 A：`parallel-worktree-isolation` —— 并行隔离与精确写集

**目标**：每个切片在独立 git worktree 中执行；写集为空时从规格「范围」解析；门禁与 diff 在同一目录完成。

- **范围**
  - 新增 `src/core/worktree/`（`core/` 只用 Node 内置）：创建 / 查询 / 移除 worktree，路径固定 `.zelto/worktrees/<sliceId>`。
  - `src/cli/commands/core-slice.ts`：`run` 与 `runParallel` 不再在主仓库切分支；每个切片在自己的 worktree 内建分支 `slice/<id>`。
  - `src/cli/commands/shared.ts:704` `createExecutorAdapter` 增加 `cwd` 参数（目前写死 `process.cwd()`）。
  - 写集回退链改为：`slice.writes` → 规格 `## 范围` 解析 → `detectDefaultWrites()`，并把解析到的写集写回切片文件。
  - `src/cli/commands/core-slice.ts:1407` `autoGateAfterRun` 与 `src/cli/commands/diff.ts` 改为以 worktree 为工作目录。
  - worktree 内的上下文同步：规格文件、验收测试目录、`node_modules`（链接共享）按需复制/软链。
- **不变量自查**：C1（worktree 元数据写在 `.zelto/` 与 `.git/worktrees/`，不引入数据库）；C2/C6（`core/worktree` 只用内置模块、不依赖 adapters）；C3（判定不含模型调用）；C4（创建/移除 worktree 各写一条事件）。
- **验收标准**
  1. 两个写集不相交的切片 `zelto run --parallel` 能同时启动，且各自改动互不可见。
  2. 执行期间主仓库的当前分支不发生切换，工作树不出现 agent 的未提交改动。
  3. 空写集切片从规格「范围」得到写集并写回 `.zelto/slices/<id>.json`。
  4. 门禁在该切片的 worktree 内执行，失败信息指向该 worktree 的产物。
  5. `zelto diff <id>` 能看到 worktree 内尚未提交的改动。
  6. worktree 移除失败时给出明确提示，不吞异常。
- **依赖**：无（可独立开工）。
- **风险**：worktree 缺 `node_modules` / 构建产物 → 门禁命令跑不起来；Windows 路径与符号链接权限需验证。

### 切片 B：`agent-question-loop` —— 提问回路与停机自动续跑

**目标**：agent 的提问不再被吞成"成功退出"，而是变成有分类、有去向、有续跑的事件。

- **范围**
  - 新增 `src/core/question/`：待答问题队列（状态文件落在 `.zelto/questions/`），问题分类 `spec_gap` / `choice` / `blocker`，严重度 `blocking` / `non_blocking`。
  - 修正 `src/cli/commands/core-slice.ts:1462` `handleAgentFailure` 与 `src/core/stall/classifier.ts:34` 的脱节：把 adapter 实际拿到的信号（退出码、最后一条消息、尝试次数）喂给分类器，让 6 类真正可判定。
  - `src/adapters/claude-agent/index.ts` 能力声明改为 `resume: true` 并实现 `resume(sessionId, patch)`：把答案注入回同一会话继续。
  - `zelto ask` / `zelto answer` 命令：列出待答问题、提交答案、触发续跑。
  - 非阻塞问题不打断并行批次，只入队 + 写事件；阻塞问题才挂起该切片，其余切片继续。
- **不变量自查**：C3（分类判定确定性，模型只能给建议不能参与判定）；C4（每个问题、每条答案都是事件）；C7（LLM 产出只作草稿）。
- **验收标准**
  1. agent 以问题收尾时，zelto 记录一条问题事件并把切片标为"待答"，而不是"运行成功"。
  2. `zelto answer <qid> <text>` 后，同一会话被续跑，无需重新 `run`。
  3. 阻塞型问题挂起单个切片，同批次其他切片不受影响。
  4. 分类器 6 类各有至少一条单元测试触发路径。
- **依赖**：切片 A（续跑需要稳定的隔离目录与会话标识）。
- **风险**：adapter 的 resume 语义由 Claude Code CLI 决定，非交互 `--print` 模式下的续跑能力需先做最小验证；验证不通过则退化为"重跑该切片"并写明差异。

### 切片 C：`parallel-merge-strategy` —— 受控的并行合并

**目标**：多个并行切片签字后能安全汇入主分支，冲突可见、失败可回滚。

- **范围**
  - 替代 `src/cli/commands/gate-sign.ts:288` 的 `git merge --ff-only` 串行合并：按 base commit 拓扑排序分批合并，冲突时停下并报告冲突文件，而不是删分支。
  - 合并结果写 `merge.completed` / `merge.stale_base` 事件（类型已存在，见 §2）。
  - 明确"自动 push"与负向清单"自动合并"的关系（见 §6 问项 1），按结论实现。
- **不变量自查**：C1（合并状态只落文件与 git）；C4（合并事件可追溯）。
- **验收标准**
  1. 两个并行切片签字后依次合入主分支，第二个不会因 ff-only 失败。
  2. 真冲突时合并停下，输出冲突文件清单，主分支保持可构建状态。
  3. 每次合并产生 `merge.completed` 事件，含切片 id 与 merge commit。
- **依赖**：切片 A（合并源在 worktree/分支上）。
- **风险**：触碰负向清单边界，须先有 ADR。

### 切片 D：`runtime-policy-enforcement` —— 运行时策略强制（与 C9 对齐）

**目标**：agent 写文件的那一刻就过策略判定，而不是等到提交。

- **范围**
  - 新增 `src/hook/` 的运行时接入方式：在 Claude Code 的工具调用前置钩子中调用 `zelto-hook`，输入含路径、操作、切片 id。
  - 写集预约在运行时强制：切片只能写自己 `writes` 内的路径，越界直接 deny 并给出 basis。
  - 每次判定写 `policy.decision` 事件（类型已存在）。
- **不变量自查**：C5/C8（保护域判定在策略规则之前，不受规则覆盖）；C9（写集预约由 hook 在运行时强制）。
- **验收标准**
  1. agent 写切片写集外的路径时被拒，且拒绝原因可查（事件 + basis）。
  2. 保护域（`policy/**`、`.zelto/**`、`AGENTS.md`）在任何规则组合下均被拒。
  3. 判定全程不触网、不调模型。
- **依赖**：切片 A（需要把切片 id 传给运行时）、切片 B（拒绝信息可回流给 agent）。
- **风险**：接入方式依赖 Claude Code 的钩子契约；契约不支持时需退化方案并写 ADR。

---

## 5. 顺序与里程碑

```
M1  A（并行隔离 + 精确写集）   ← 解除"并行跑不起来"
      ↓
M2  B（提问回路 + 停机续跑）   ← 解除"agent 停下来等"
      ↓
M3  C（受控合并）  与  D（运行时策略）可并行
```

每个里程碑结束时跑一次完整回归：`pnpm build` + `pnpm test` + 至少一条并行路径的验收测试。

---

## 6. 待人决策（不自行拍板）

1. **签字后是否自动合并、自动 push？** 负向清单写明"自动合并"不在做，但现存的 `autoMergeSlice` 已在做（`gate-sign.ts:288`）。二者必须择一，需要一份 ADR 说明现状与目标。
2. **非阻塞问题是否允许 agent 自行决定？** 例如规格只给了 A/B 两个候选时，能否按"选更保守者"自动继续。这会触及 C7，需要明确"允许自动决定"的清单从哪来。
3. **阻塞问题是否允许在问题未答时让 agent 用临时假设继续？** 允许则违反"每行代码可追溯到已批准规格"的初衷，不允许则并行批次可能被一个切片拖住。
4. **`node_modules` / 构建产物在 worktree 中如何共享？** 软链、junction、还是每次重装，影响跨平台一致性与门禁可靠性。

---

## 7. 附录：代码位置索引

- 并行入口：`src/cli/commands/core-slice.ts:1030` `runParallel`
- 单切片入口：同文件 `:738` `run` 注册
- 写集回退：同文件 `:41` `detectDefaultWrites`
- 冲突检测：`src/core/sched/engine.ts:194` `checkConflicts`、`:216` `pathsOverlap`
- 停机分类：`src/core/stall/classifier.ts:28`、`:34`
- 停机处理：`src/cli/commands/core-slice.ts:1462` `handleAgentFailure`
- adapter 工厂：`src/cli/commands/shared.ts:704` `createExecutorAdapter`
- CLI adapter：`src/adapters/claude-agent/index.ts`
- SDK adapter：`src/adapters/claude-agent-sdk/index.ts`
- 门禁执行：`src/core/gate/executor.ts:76`
- 门禁触发：`src/cli/commands/core-slice.ts:1407` `autoGateAfterRun`
- 合并：`src/cli/commands/gate-sign.ts:288` `autoMergeSlice`
- diff：`src/cli/commands/diff.ts`
- hook 安装：`src/cli/commands/info-help.ts:623`
- 事件类型：`src/core/events/stream.ts`
