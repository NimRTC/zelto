# zelto 场景功能地图

> 版本: v0.3.0 · 最后更新: 2026-11-04（文档同步至代码当前状态）
> 项目定位与目标见 `docs/zelto-项目目标.md`

---

## 1. 项目定位

zelto 是一个 **AI 编程驾驶舱**（AI Programming Cockpit），不是 AI 编程助手。

**它是「一个人 + 一组 agent」做中大型项目时的驾驶舱**：不写业务代码，
但管住从想法到主干的整个过程——

```
人做规划（方案设计 → 版本规划 → 模块划分 → 切片设置）
   ↓  规划确认完
zelto 控制并行 agent 进入高速开发（隔离 worktree + 写集守卫 + 门禁）
   ↓  出错时
拉闸 —— 越界当场拦下、卡住会来问人，人被交还控制权
   ↓  验收通过
逐片签字 → 显式合并 → 版本交付 → 下一个版本
```

它的底层职责是**保证 agent 的每一行代码都能追溯到一条人批准的规格，且没有走出边界**——
这条追溯链是规划可校验、并行不打架、出错能定责的共同底座，
也是 zelto 区别于其它 AI 编程工具的本质特征。

它服务的是**一个人 + 一组 agent** 的中大型项目生产：
人做规划（方案设计、版本规划、模块划分、切片设置），zelto 把这些规划切成可并行的作业、
拉起 agent、在 agent 写文件的那一刻实时校验边界与追溯，出错时拉闸交回控制权。

完整目标、现状差距与待决策项见 `docs/zelto-项目目标.md`。

### 1.1 三个角色

| 角色 | 是谁 | 做什么 |
|---|---|---|
| **主用户** | 开发者 | 定意图、做设计、划分模块、排版本、确认切片、审契约、签字、显式合并 |
| **执行者** | agent（如 Claude Code） | 由 zelto 拉起，无人值守实现切片 |
| **看守者** | **zelto** | 校验追溯、并行编排、隔离执行、门禁验收、分类停机、记录事件、派发作业 |

**zelto 的自动化止步于「待签字」** —— 签字必须由人行使（AGENTS.md 禁区）。
签字之后合入主干也要人显式发起（`zelto merge`，ADR-018）。

### 1.2 核心理念

- **约束优先于功能**：宁可少一个功能，也不许破一条不变量
- **追溯性**：每行代码 → 测试 → 契约 → 规格 → 人批准的意图（**zelto 区别于其它 AI 编程工具的本质特征**）
- **append-only 审计**：每个动作都记录为不可变事件
- **确定性判定**：所有策略判定（policy/gate/sched）不调用模型、不触网
- **签字 ≠ 合并**：签字只改状态，合入主干由人显式跑 `zelto merge`（ADR-018）——
  批准与动作分开，追溯链才不会在合并这一步断掉

---

## 2. 核心流程

### 2.1 切片全生命周期

```
人（开发者）                   agent（Claude Code）              zelto（看守者）
    │                               │                              │
    │  ① 创建切片意图                │                              │
    │───────────────────────────────│─────────────────────────────►│ draft
    │                               │                              │
    │  ② 澄清规格                    │                              │
    │◄──────────────────────────────│──────────────────────────────│ clarifying
    │  回答问题                      │                              │
    │───────────────────────────────│─────────────────────────────►│
    │                               │                              │
    │  ③ 门禁① 检查                  │                              │
    │                               │                              │► check
    │                               │                              │
    │  ④ 冻结基线                    │                              │
    │───────────────────────────────│─────────────────────────────►│ frozen
    │                               │                              │
    │  ⑤ 并行准入 + 约束分发          │                              │
    │                               │                              │► sched.admit
    │                               │                              │
    │  ⑥ 无人值守执行                 │                              │
    │                               │◄──── 拉起 agent ────────────│ running
    │                               │     (带约束包)                │
    │                               │                              │
    │  ⑦ 门禁② 验收测试               │                              │
    │                               │                              │► gate
    │                               │                              │
    │  ⑧ 人签字                     │                              │
    │◄──────────────────────────────│──────────────────────────────│ sign.pending
    │  审批/拒绝                    │                              │
    │───────────────────────────────│─────────────────────────────►│ completed/abandoned
    │                               │                              │
    │  ⑨ 人显式合并                 │                              │
    │◄──────────────────────────────│──────────────────────────────│ merge.*
    │  zelto merge                  │  提交产物 → 合并计划 → 执行
```

### 2.2 状态机

```
                  ┌──────────────────────────────────────┐
                  │              draft                   │
                  └──┬──────────────┬──────────────┬──────┘
                     │              │              │
               CLARIFY_START     FREEZE         ABANDON
                     │              │              │
                     ▼              ▼              ▼
              ┌──────────┐   ┌──────────┐   ┌──────────┐
              │clarifying│   │  frozen  │   │abandoned │
              └─────┬────┘   └────┬─────┘   └──────────┘
                    │             │
              CLARIFY_        RUN_START
              CONVERGED          │
                    │            ▼
                    ▼     ┌──────────┐
                 draft    │ running  │
                          └────┬─────┘
                               │
                          RUN_FINISH
                               │
                               ▼
                          ┌──────────┐
                          │  frozen  │ ◄── 可多次 run
                          └────┬─────┘
                               │
                           GATE_PASS
                               │
                               ▼
                          ┌──────────┐
                          │completed │ ──► SIGN_APPROVE → done
                          └──────────┘     SIGN_REJECT → abandoned
```

### 2.3 9 种事件

| 事件 | 从 | 到 |
|---|---|---|
| CLARIFY_START | draft | clarifying |
| CLARIFY_CONVERGED | clarifying | draft |
| FREEZE | draft | frozen |
| RUN_START | frozen, completed | running |
| RUN_FINISH | running | frozen |
| GATE_PASS | frozen | completed |
| SIGN_APPROVE | completed | completed |
| SIGN_REJECT | completed | abandoned |
| ABANDON | draft, clarifying, frozen, running, completed | abandoned |

### 2.4 版本级流程（规划 → 并行 → 交付）

切片是一条链，**版本是一条链的集合**。版本层复用切片层的执行语义（ADR-017），
只在两端加东西：前面是规划确认，后面是交付验收。

```
人（开发者）              zelto（规划 + 闸门）              agent 群
    │
    │ ① 需求               require <文字>            ──► 需求草案
    │ ② 确认需求            require confirm <id>
    │
    │ ③ 设计 + 模块划分      design <req-id>           ──► 设计草案（含 modules）
    │ ④ 确认设计            design confirm <id>
    │
    │ ⑤ 版本规划 + 切片划分  plan <design-id>          ──► 版本计划（含 slices）
    │ ⑥ 确认计划            plan confirm <id>         ──► 写出 specs/slices/*.md
    │
    │ ⑦ 启动版本            version start <ver>       ──► 并行拉起 N 个 agent
    │                                          ◄─────────  各自隔离 worktree 跑
    │                                          ◄─────────  实时写集守卫（C9）
    │
    │ ⑧ 逐片签字            sign <id> --approve       ──► 只改状态，不碰主干
    │                                                        签字 ≠ 合并（ADR-018）
    │
    │ ⑨ 显式合并            merge [id...]             ──► 提交 worktree 产物
    │                                                        → 合并计划 → 执行 → 清理
    │
    │ ⑩ 版本交付            version deliver <ver>     ──► 前置条件 + 版本级验收
    │                                             ──► version.accepted / version.delivered
    │
    ▼ 下一个版本
```

**规划层的每一次 `confirm` 都是人点头**，未确认不往下走。
**执行层的自动化止步于「待签字」** —— `version start --auto` 已被移除（AGENTS.md 禁区）。

### 2.5 并行执行语义（`run --parallel` 与 `version start` 共用）

两个入口走**同一条**执行路径 `executeSlicesByPhase()`（`src/cli/commands/parallel-executor.ts`），
执行前先由 `buildExecutionPlan()`（`src/cli/commands/execution-plan.ts`）排出阶段：

| 阶段 | 内容 | 失败处理 |
|---|---|---|
| ① 准入 | 切片必须 frozen 且有 frozenHash | 整批 abort |
| ② 写集解析 | 从规格「范围」章节解析生效写集 | 只读，不改状态 |
| ③ 排阶段 | 依赖拓扑分层 + 同阶段写集重叠降级为串行 | 依赖成环 → 整批 abort（`coord.cycle_detected`） |
| ④ 隔离与守卫 | 建 worktree + 取写集预约 + 装 PreToolUse 钩子 | 整批 abort |
| ⑤ 拉起 agent | 阶段内并行启动，逐个等待退出，失败按配置重试 | 逐片重试 |
| ⑥ 收尾 | 写集审计 → 状态回写 → 门禁② → 签名请求 | 越界不进 gate |

**阶段之间串行，阶段之内并行**：同阶段切片互不冲突才并行；
写集重叠的切片自动拆成先后两个阶段，批次继续跑（不整批 abort）。
某个阶段没过（失守 / 停机 / 提问），**后面的阶段不启动**——
依赖没满足就跑下去，跑出来的多半也是错的。

主仓工作树全程不被切换分支、也不被 agent 写入。详见 `docs/adr-017-version-level-orchestration.md`、
`docs/adr-019-phased-execution.md`（阶段怎么排、怎么降级）。

### 2.6 拉闸（`zelto halt`）—— 人能主动喊停

批次跑起来之后，人是在看到某个 agent 跑偏的那一刻才想喊停。
`zelto halt` 把这件事变成一条正经通道：

```
人喊停（另一个终端）        zelto halt --reason "跑偏了"
   ↓  写暂停请求（文件）      .zelto/halts/<scope>.json
批次在安全点读到            ① 拉起前：不再开新 agent
   ↓                        ② 等待时：adapter.stop() 停掉这个 agent
现场保留                    ③ 阶段间：后续阶段不启动
   ↓
人处理完                    zelto halt --clear → 重跑批次
```

被拉闸的切片结局标成 `halted`（不是失败）：不进门禁、不发签名请求、不触发重试；
worktree 与写集预约都保留，**现场交回给人**。

被拉闸的切片会**回退到 `frozen`** 并标记 `stall.class = 'human_halt'` ——
不回退的话它永远卡在 `running`，而准入只认 `frozen`，「处理完继续」这条路就断了。
人处理完走 `zelto resume <id>` → `zelto run <id>`。

批次进程崩了 / 被 Ctrl-C 杀了的时候（没人喊停，但切片卡在 `running`），
用 `zelto halt --rollback` 强制回退。判定是确定性的：
状态是 `running`，且持有写集预约的进程已经死了。详见 `docs/adr-020-halt.md`。

---

## 3. 功能清单

### 3.1 核心模块

| 模块 | 文件 | 功能 |
|---|---|---|
| **Policy Engine** | `src/core/policy/engine.ts` | 策略规则匹配、保护域、路径逃逸检测、锚点校验 |
| **Slice State Machine** | `src/core/slice/state.ts` | 6 状态状态机，9 事件转换 |
| **Slice Store** | `src/core/slice/store.ts` | 切片文件持久化（`.zelto/slices/<id>.json`） |
| **Event Stream** | `src/core/events/stream.ts` | 57 种事件的 append-only JSONL 流 |
| **Gate Executor** | `src/core/gate/executor.ts` | Shell 命令执行器（门禁②） |
| **Sign Manager** | `src/core/gate/sign.ts` | 签名请求、审批/拒绝工作流 |
| **Stall Classifier** | `src/core/stall/classifier.ts` | 9 类停机分类 |
| **Scheduler** | `src/core/sched/engine.ts` | 并行准入、写集冲突检测、约束分发 |
| **Clarify Engine** | `src/core/clarify/engine.ts` | 5 类结构化问题生成、自动回答 |
| **Budget Collector** | `src/core/budget/collector.ts` | 预算跟踪（getSpent, getLimit, isExhausted） |
| **Metrics Collector** | `src/core/metrics/collector.ts` | rework rate、cycle time、stall counts |
| **Audit Trail** | `src/core/audit/trail.ts` | 57 种事件摘要、可读审计报告 |
| **Spec Executor** | `src/core/spec/SpecMdExecutor.ts` | Markdown 规格文件自校验（parse/validate/runChecklists） |
| **Spec Format** | `src/core/spec/format.ts` | 规格章节契约唯一真源（概念 + 双语别名，ADR-016） |
| **Hook** | `src/hook/index.ts` | 独立可执行判定进程 |
| **PreToolUse Hook** | `src/hook/pretool.ts` | agent 写文件时的逐写判定（C9 运行时强制） |
| **Worktree Manager** | `src/core/worktree/manager.ts` | 并行切片的物理隔离（ADR-011） |
| **Runtime Guard** | `src/cli/commands/runtime-guard.ts` | 写集预约 + 钩子安装 + 运行后越界审计（ADR-014） |
| **Parallel Executor** | `src/cli/commands/parallel-executor.ts` | 唯一的并行执行实现（ADR-017），按阶段串行推进 |
| **Execution Plan** | `src/cli/commands/execution-plan.ts` | 排阶段与执行计划的唯一 CLI 入口（只查与要跑共用） |
| **Question Protocol** | `src/core/question/protocol.ts` | agent 提问挂起与回答续跑（ADR-013） |
| **Halt Store** | `src/core/halt/store.ts` | 拉闸请求的文件化存储（ADR-020） |
| **Batch Review** | `src/core/sched/batch.ts` | 批次准入审核、依赖分层、写集冲突降级、工件冲突 |
| **Dependency Graph** | `src/core/sched/depgraph.ts` | 切片依赖图与环检测 |
| **Merge Orchestration** | `src/core/sched/merge.ts` | 合并计划与冲突可见（ADR-012） |
| **Requirements Store** | `src/core/requirements/store.ts` | 需求文档持久化与状态 |
| **Design Store** | `src/core/design/store.ts` | 设计文档与模块划分持久化 |
| **Version Store** | `src/core/version/store.ts` | 版本计划持久化与版本状态 |
| **Draft Review** | `src/core/review/` | 草稿评审：摘要 + 行级 diff + 决策点抽取 + 修订快照（ADR-023） |
| **Project Scanner** | `src/core/project/scanner.ts` | 既有项目扫描，生成项目地图 |
| **Architecture Scan** | `src/core/arch/` | 架构偏离检查：设计模块图 vs 实际 import 图；只读报告（G-4/B）+ policy 可配置护栏 `arch:`（G-4/A，ADR-027） |
| **Ports** | `src/core/ports/index.ts` | SessionPort / BudgetPort / EventSinkPort / HarnessMetaPort |

### 3.2 CLI 命令

| 命令 | 用途 | 对应流程阶段 |
|---|---|---|
| `zelto init [--with-examples]` | 初始化 `.zelto/` 运行时目录 | 通用 |
| `zelto config [get\|set] [key] [value]` | 查看/修改配置。`zelto config` 显示当前配置；`config get` 默认遮蔽密钥，`--raw` 才输出真值 | 通用 |
| `zelto slices [--active] [--json]` | 列出所有切片 | 通用 |
| `zelto slice <id> [--json]` | 查看切片详情 | 通用 |
| `zelto create <id> [--json]` | 创建新切片 | create |
| `zelto next` | 推荐下一步动作 | 通用 |
| `zelto check <id> [--json]` | 门禁① 确定性检查 | freeze 前 |
| `zelto clarify <id> [--auto] [--dry-run]` | 澄清切片规格 | clarify |
| `zelto freeze <id> [--json]` | 冻结切片基线 | freeze |
| `zelto start <id> [--yes] [--agent <name>]` | 一键执行：create→check→freeze→run | run |
| `zelto run <id> [--dry-run] [--agent <name>] [--json]` | 执行切片（含并行准入） | run |
| `zelto run --parallel <id...>` | 并行执行多个切片（隔离 + 写集守卫 + 门禁 + 签字请求） | run |
| `zelto run --hotfix <id> --yes` | 跳过门禁② 的紧急修复路径（需显式确认，ADR-015） | run |
| `zelto admit <id> [--json]` | 准入检查 | run 前 |
| `zelto gate <id> [--dry-run] [--retry <N>] [--spec-md] [--json]` | 门禁② 验收测试 | gate |
| `zelto gate --spec-md` | 批量校验所有新格式规格文件 | gate |
| `zelto inbox` | 待签名队列 | sign 前 |
| `zelto sign <id> --approve [--json]` | 审批切片 | sign |
| `zelto sign <id> --reject [--json]` | 拒绝切片 | sign |
| `zelto abandon <id>` | 废弃切片 | 通用 |
| `zelto events <id> [--json] [--tail <N>]` | 查看切片事件流 | 通用 |
| `zelto summary` | 项目概况 | 通用 |
| `zelto help [<cmd>]` | 帮助 / 查看特定命令帮助 | 通用 |
| `zelto stall [id] [--auto-resolved]` | 列出 stalled slices / 查看详情 | 通用 |
| `zelto resume <id> [--skip\|--abandon]` | 恢复 stalled slice | run |
| `zelto require <text>` | 用自然语言创建需求文档 | AI pipeline |
| `zelto require list` | 列出所有需求 | AI pipeline |
| `zelto require confirm <id>` | 确认需求 | AI pipeline |
| `zelto require refine <id> <txt>` | 多轮迭代修改需求草案 | AI pipeline |
| `zelto design <req-id>` | 从需求生成设计文档 | AI pipeline |
| `zelto design list` | 列出所有设计 | AI pipeline |
| `zelto design confirm <id>` | 确认设计 | AI pipeline |
| `zelto design refine <id> <txt>` | 多轮迭代修改设计草案 | AI pipeline |
| `zelto plan <design-id>` | 从设计生成版本计划 | AI pipeline |
| `zelto plan confirm <id>` | 确认计划并创建切片规格 | AI pipeline |
| `zelto plan add-version <id> <d>` | 追加新版本到已有计划 | AI pipeline |
| `zelto version status` | 显示版本计划状态 | AI pipeline |
| `zelto version start <ver> [--plan <id>] [--retry-failed]` | 执行版本切片（agent 并行；`--auto` 已移除，签字必须由人行使） | AI pipeline |
| `zelto version deliver <ver> [--plan <id>]` | 版本交付：前置条件 + 主仓版本级验收（ADR-017） | AI pipeline |
| `zelto pipeline status` | 全链一览：需求→设计→计划→版本→切片 | 全景 |
| `zelto trace <req-id> [--json\|--graph\|--timeline]` | 追溯需求到下游全链路 | 全景 |
| `zelto impact <req-id>` | 变更影响分析 | 全景 |
| `zelto audit <slice-id> [--json]` | 查看切片审计追踪 | 全景 |
| `zelto diff <slice-id> [--stat] [--json]` | 查看切片变更差异 | 全景 |
| `zelto snapshot` | 捕获项目状态快照 | 全景 |
| `zelto snapshot list [--json]` | 列出已保存快照 | 全景 |
| `zelto snapshot show <id>` | 查看快照详情 | 全景 |
| `zelto policy list [--json]` | 列出策略规则 | 策略 |
| `zelto policy show <id> [--json]` | 查看单个策略规则 | 策略 |
| `zelto policy check <path> [--json]` | 检查路径是否被策略允许 | 策略 |
| `zelto policy validate [--json]` | 验证策略 YAML 格式 | 策略 |
| `zelto policy add <id> --path <p> --action <a> --basis <b>` | 添加策略规则 | 策略 |
| `zelto policy remove <id> [--json]` | 删除策略规则 | 策略 |
| `zelto policy edit <id> [--path <p>] [--action <a>] ...` | 编辑已有策略规则 | 策略 |
| `zelto completion bash\|zsh\|fish` | 生成 shell 补全脚本 | 通用 |
| `zelto status [--watch] [--json]` | 查看 agent 会话状态 | 通用 |
| `zelto spec-md validate <slice-id>` | 验证切片规格文件结构 | 规格 |
| `zelto spec-md run <slice-id>` | 执行规格文件 checklist | 规格 |
| `zelto slice-status [id] [--json]` | 查看切片运行状态详情 | 通用 |
| `zelto ss [id] [--json]` | slice-status 别名 | 通用 |
| `zelto patch-content` | 补丁内容管理 | 通用 |
| `zelto ask [--slice <id>] [--json]` | 列出待回答的 agent 提问 | 运行时 |
| `zelto answer <qid> "<text>"` | 回答 agent 提问并恢复切片 | 运行时 |
| `zelto halt [--scope <s>] [--reason <r>]` | 拉闸：暂停正在跑的批次（`--list` 查看，`--clear` 解除，`--rollback` 回退卡死的切片） | 运行时 |
| `zelto report [--format markdown\|json]` | 生成状态报告 | 治理 |
| `zelto set <id> --field <f> --value <v>` | 设置切片的可写字段 | 通用 |
| `zelto reservation list\|active\|show\|release\|reap` | 写集预约的查看与释放 | 治理 |
| `zelto merge [plan] [<id...>] [--strategy <s>] [--dry-run] [--push]` | 显式合并已签字的切片（不带 id = 全部已批准且未合入） | 治理 |
| `zelto hook --install\|--uninstall\|--status` | 安装 / 卸载 git hooks | 治理 |
| `zelto project scan\|init\|design\|slice\|status` | 接管既有项目 | 接管 |
| `zelto depgraph <id...> [--depends-on <id>=<dep>]` | 查看切片之间的依赖图 | 全景 |
| `zelto artifact check <id...>` | 检测切片之间的工件级冲突 | 全景 |
| `zelto batch <id...> [--depends-on ...]` | 审核这批切片能否一起开工，并排出执行阶段 | 全景 |
| `zelto dashboard [--watch] [--open]` | 生成项目看板 HTML | 全景 |
| `zelto tasks` / `zelto task-status <id>` / `zelto wait <id>` | 后台任务查看与等待 | 通用 |
| `zelto suggest` | 项目全貌与建议动作 | 通用 |
| `zelto require\|design\|plan show <id> [--diff] [--full]` | 草稿评审：摘要 + 决策点 + 与上一版的差异（ADR-023） | 规划 |
| `zelto arch check [--design <id>] [--root <dir>] [--strict] [--json]` | 架构偏离检查：设计模块图 vs 实际 import 图（纯报告；`--strict` 按 `policy.yaml` 的 `arch:` 段定级，`deny` 类偏离时退出码 1，ADR-027） | 治理 |
| `zelto contract [check\|baseline\|status] [--json]` | 契约演进检查：当前契约 vs 人工确认的基线，分清写入方 / 读取方破坏（ADR-036）；`baseline` 是人签字接受这次变化 | 治理 |

### 3.3 独立 Hook

`zelto-hook` 可独立编译、零依赖的策略判定进程，可集成到：

- **git hooks**（pre-commit / pre-push）
- **CI 门禁**
- **编辑器扩展**（保存时校验）
- **agent 工具调用拦截**（实时判定）

协议：stdin 读 HookInput，stdout 写 HookOutput（见 `contracts/schemas/hook-io.json`）。

---

## 4. 停机分类

| 类 | 触发条件 | 是否自动恢复 |
|---|---|---|
| permission_prompt | hook 返回 ask | ✅ |
| environment_failure | 构建/测试连续失败 | ✅ |
| context_exhaustion | max_turns 耗尽 | ✅ |
| cognitive_stuck | 同种失败 ≥ 3 次 | ❌ |
| plan_gate | agent 请求计划审批 | ❌ |
| budget_exhausted | 预算超限 | ❌ |
| gate_retry | 门禁重试耗尽 | ❌ |
| agent_question | agent 提问，等人回答（ADR-013） | ❌ |
| human_halt | 人工拉闸，等人处理现场（ADR-020） | ❌ |

`human_halt` 是拉闸回退后打上的停机标记 —— 它不可自动恢复，
因为人喊停要的就是「停下来等人」（ADR-020 §3.5）。

---

## 5. 事件类型（57 种）

事件类型是**契约**：`contracts/schemas/event-envelope.json` 的 enum 是真源，
`core/events/stream.ts` 与 `core/audit/trail.ts` 必须与它一致。

三者的对齐由三层强制，不再靠人记着：

1. `core/events/stream.ts` 的 `EVENT_TYPES` 是运行时数组，`EventType` 联合类型派生自它；
2. `core/audit/trail.ts` 的摘要表键类型是 `Record<EventType, ...>` ——
   少写一种事件摘要就**编译不过**，审计不会退化成 `Event: <type>`；
3. `tests/event-contract-parity.test.ts` 在测试期把三方对账（并核对本文档的数量）。

| 类别 | 事件 |
|---|---|
| 切片 | `slice.state.changed`, `slice.baseline_registered`, `slice.drift_detected`, `slice.hotfix` |
| 规格 | `spec.drafted`, `spec.checked`, `spec.frozen` |
| 澄清 | `clarify.question`, `clarify.answer` |
| 运行 | `run.started`, `run.resumed`, `run.stalled`, `run.finished`, `run.aborted` |
| 策略 | `policy.decision`, `policy.anchor_mismatch`, `policy.violation` |
| 预约 | `reservation.acquired`, `reservation.released` |
| 门禁 | `gate.executed`, `gate.result`, `gate.retry` |
| 停机 | `stall.classified` |
| 提问 | `question.raised`, `question.answered` |
| 资源 | `budget.spent`, `llm.called` |
| 队列 | `queue.enqueued`, `queue.dequeued` |
| 签名 | `sign.requested`, `sign.approved`, `sign.rejected`, `sign.revoked` |
| 拉闸 | `batch.halted` |
| 合并 | `merge.completed`, `merge.planned`, `merge.phase_complete`, `merge.conflict`, `merge.stale_base` |
| 调度 | `sched.admitted`, `sched.blocked` |
| 隔离 | `worktree.created`, `worktree.removed` |
| 协调 | `coord.dep_added`, `coord.phase_ready`, `coord.phase_complete`, `coord.cycle_detected` |
| 工件 | `artifact.conflict_detected` |
| 版本 | `version.accepted`, `version.delivered`, `version.regression_recorded`, `version.regression_detected` |
| 草稿 | `draft.created`, `draft.revised`, `draft.confirmed` |
| 契约 | `contract.evolution_checked`, `contract.baseline_updated` |

**版本级事件**用 `version-<label>` 作归属键（版本不是切片，事件流按切片分目录），
见 `docs/adr-017-version-level-orchestration.md`。

**草稿级事件**用 `draft-<kind>-<id>` 作归属键（需求 / 设计 / 版本计划都不是切片），
见 `docs/adr-023-planning-review-experience.md`。

---

## 6. 不变量（硬约束）

有效约束为 7 条，保留 C1–C9 编号以兼容历史引用（C6 并入 C2，C8 并入 C5；新文档优先引用 C2 / C5）。

| ID | 约束 | 说明 |
|---|---|---|
| C1 | 状态只在文件里 | 无数据库、无内存状态、无常驻 daemon；状态变更只经文件读写 |
| C2 | `core/` 核心纯洁性 | 零第三方运行时依赖（只用 Node 内置），且不得 import `adapters/` |
| C3 | 判定确定性 | policy/gate/sched 无模型无网络；只读文件、纯计算 |
| C4 | append-only 事件流 | 每个动作都记录；事件是追溯的唯一证据载体 |
| C5 | 保护域与锚点外部化 | 保护域硬编码、不可被策略规则覆盖；锚点存于 `policy/lock.json` |
| C7 | llm 不参与判定 | 产出仅为草稿/建议；进下游须经人 `confirm` |
| C9 | 写集预约强制 | 以 hook 逐写判定为主、运行后 git 审计兜底；预约缺失 fail closed |

---

## 7. 目录结构

```
zelto/
├── src/
│   ├── core/              核心逻辑（零第三方运行时依赖）
│   │   ├── policy/        策略引擎
│   │   ├── slice/         切片状态机
│   │   ├── events/        append-only 事件流
│   │   ├── gate/          门禁执行器 + 签名管理
│   │   ├── stall/         停机分类器
│   │   ├── sched/         并行准入 + 约束分发 + 批次审核 + 依赖图 + 合并编排
│   │   ├── worktree/      并行隔离（worktree 管理）
│   │   ├── question/      agent 提问挂起协议
│   │   ├── clarify/       澄清引擎
│   │   ├── budget/        预算跟踪
│   │   ├── metrics/       度量收集
│   │   ├── audit/         审计追踪
│   │   ├── ports/         端口接口定义
│   │   ├── spec/          规格引擎（SpecMdExecutor + 章节契约）
│   │   ├── requirements/  需求文档存储
│   │   ├── design/        设计文档 + 模块划分存储
│   │   ├── version/       版本计划 + 版本状态存储
│   │   ├── project/       既有项目扫描与治理初始化
│   │   ├── arch/          架构偏离检查（设计模块图 vs 实际 import 图，只读报告）
│   │   └── contracts/     契约注册表
│   ├── cli/               CLI 命令实现（59 个命令）
│   ├── hook/              独立可执行判定进程（+ PreToolUse 钩子）
│   ├── llm/               AI 流水线草案生成（仅产出草稿，不参与判定）
│   └── adapters/          执行器适配器（claude-agent / claude-agent-sdk）
├── contracts/schemas/     JSON Schema 真源（6 个）
├── policy/                policy.yaml + lock.json
├── docs/                  目标 / 场景地图 / 技术架构 / 开工包 / ADR
├── tests/                 测试
│   ├── acceptance/        验收测试（24 个文件）
│   │   ├── e2e-full-cycle/  端到端全生命周期测试
│   │   ├── events-command/  事件命令验收测试
│   │   ├── admit-command/   准入命令验收测试
│   │   ├── event-emission/  事件发射验收测试
│   │   ├── batch-command/   批次审核验收测试
│   │   └── ...
│   ├── *.test.ts          单元测试（72 个文件）
│   └── ...
└── .zelto/                运行时状态
    ├── slices/            切片文件
    ├── events/            事件日志
    ├── locks/             签名请求 + 写集预约
    ├── worktrees/         并行切片的隔离工作目录
    └── config.yaml        项目配置
```

---

## 附录 A：测试清单

| 类别 | 测试数 | 文件数 |
|------|--------|--------|
| 单元测试 | 943 | 81 |
| 验收测试 | 154 | 25 |
| **总计** | **1097（1097 pass / 0 fail）** | **106** |

> 数据由测试运行器实时统计，运行 `npm test` 验证。最后一次全量验证：2026-11-05，
> 1097 tests / 226 suites / 0 fail。

---

## 附录 B：JSON Schema 清单

| Schema | 文件 | 用途 |
|---|---|---|
| hook-io.json | `contracts/schemas/hook-io.json` | Hook 输入输出协议 |
| event-envelope.json | `contracts/schemas/event-envelope.json` | 事件信封格式 |
| slice.json | `contracts/schemas/slice.json` | 切片持久化格式 |
| policy.json | `contracts/schemas/policy.json` | 策略配置格式 |
| clarify.json | `contracts/schemas/clarify.json` | 澄清引擎数据契约 |
| metrics-def.json | `contracts/schemas/metrics-def.json` | 度量定义格式 |

---

## 附录 C：开发命令

```bash
pnpm build          # 编译（tsc, ~2.4s）
pnpm dev            # 监听模式
pnpm test           # 编译 + 全量测试（96 文件, 976 tests）
pnpm test:quick     # 跳过编译直接跑全量测试
pnpm test:unit      # 编译 + 仅运行纯单元测试
pnpm test:acceptance # 仅运行验收测试
pnpm test:watch     # 监听模式跑测试
pnpm lint           # Biome 检查
pnpm format         # Biome 格式化
pnpm clean          # 清理 dist dist-test
pnpm link --global  # 全局安装 CLI
```
