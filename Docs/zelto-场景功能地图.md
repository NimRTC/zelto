# zelto 场景功能地图

> 版本: v0.1.0 · 最后更新: 2026-10-15

---

## 1. 项目定位

zelto 是一个 **AI 编程驾驶舱**（AI Programming Cockpit），不是 AI 编程助手。

它的职责不是写代码，而是**保证 agent 的每一行代码都能追溯到一条人批准的规格，且没有走出边界**。

### 1.1 三个角色

| 角色 | 是谁 | 做什么 |
|---|---|---|
| **主用户** | 开发者 | 定意图、定架构、回答澄清问题、审契约、签字 |
| **执行者** | agent（如 Claude Code） | 由 zelto 拉起，无人值守实现切片 |
| **看守者** | **zelto** | 校验追溯、分类停机、执行门禁、记录事件、分派任务 |

### 1.2 核心理念

- **约束优先于功能**：宁可少一个功能，也不许破一条不变量
- **追溯性**：每行代码 → 测试 → 契约 → 规格 → 人批准的意图
- **append-only 审计**：每个动作都记录为不可变事件
- **确定性判定**：所有策略判定（policy/gate/sched）不调用模型、不触网

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

---

## 3. 功能清单

### 3.1 核心模块

| 模块 | 文件 | 功能 |
|---|---|---|
| **Policy Engine** | `src/core/policy/engine.ts` | 策略规则匹配、保护域、路径逃逸检测、锚点校验 |
| **Slice State Machine** | `src/core/slice/state.ts` | 6 状态状态机，9 事件转换 |
| **Slice Store** | `src/core/slice/store.ts` | 切片文件持久化（`.zelto/slices/<id>.json`） |
| **Event Stream** | `src/core/events/stream.ts` | 29 种事件的 append-only JSONL 流 |
| **Gate Executor** | `src/core/gate/executor.ts` | Shell 命令执行器（门禁②） |
| **Sign Manager** | `src/core/gate/sign.ts` | 签名请求、审批/拒绝工作流 |
| **Stall Classifier** | `src/core/stall/classifier.ts` | 6 类停机分类 |
| **Scheduler** | `src/core/sched/engine.ts` | 并行准入、写集冲突检测、约束分发 |
| **Clarify Engine** | `src/core/clarify/engine.ts` | 5 类结构化问题生成、自动回答 |
| **Metrics Collector** | `src/core/metrics/collector.ts` | rework rate、cycle time、stall counts |
| **Audit Trail** | `src/core/audit/trail.ts` | 30 种事件摘要、可读审计报告 |
| **Hook** | `src/hook/index.ts` | 独立可执行判定进程 |
| **Ports** | `src/core/ports/index.ts` | SessionPort / BudgetPort / EventSinkPort / HarnessMetaPort |

### 3.2 CLI 命令

| 命令 | 用途 | 对应流程阶段 |
|---|---|---|
| `zelto slices` | 列出所有切片 | 通用 |
| `zelto next` | 推荐下一步动作 | 通用 |
| `zelto check <id>` | 门禁① 确定性检查 | freeze 前 |
| `zelto freeze <id>` | 冻结切片基线 | freeze |
| `zelto run <id>` | 执行切片（含并行准入） | run |
| `zelto run <id> --dry-run` | 模拟准入检查 | run 前 |
| `zelto gate <id>` | 门禁② 验收测试 | gate |
| `zelto inbox` | 待签名队列 | sign 前 |
| `zelto sign <id> --approve` | 审批切片 | sign |
| `zelto sign <id> --reject` | 拒绝切片 | sign |
| `zelto help` | 帮助 | 通用 |

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

---

## 5. 事件类型（29 种）

| 类别 | 事件 |
|---|---|
| 切片 | `slice.state.changed`, `slice.drift_detected` |
| 规格 | `spec.drafted`, `spec.checked`, `spec.frozen` |
| 澄清 | `clarify.question`, `clarify.answer` |
| 运行 | `run.started`, `run.resumed`, `run.stalled`, `run.finished`, `run.aborted` |
| 策略 | `policy.decision`, `policy.anchor_mismatch` |
| 门禁 | `gate.executed`, `gate.result`, `gate.retry` |
| 停机 | `stall.classified` |
| 资源 | `budget.spent`, `llm.called` |
| 队列 | `queue.enqueued`, `queue.dequeued` |
| 签名 | `sign.requested`, `sign.approved`, `sign.rejected` |
| 合并 | `merge.completed`, `merge.stale_base` |
| 调度 | `sched.admitted`, `sched.blocked` |

---

## 6. 不变量（硬约束）

| ID | 约束 | 说明 |
|---|---|---|
| C1 | 状态只在文件里 | 无数据库、无内存状态 |
| C2 | `core/` 零 SDK 依赖 | 只用 Node 内置 |
| C3 | 判定确定性 | policy/gate/sched 无模型无网络 |
| C4 | append-only 事件流 | 每个动作都记录 |
| C5/C8 | 保护域硬编码 | 不可被策略规则覆盖 |
| C6 | 依赖单向向下 | `core/` 不 import `adapters/` |
| C7 | llm 不参与判定 | 产出仅为草稿/建议 |
| C9 | 写集预约强制 | sched 运行时强制执行 |

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
│   │   ├── sched/         并行准入 + 约束分发
│   │   ├── clarify/       澄清引擎
│   │   ├── metrics/       度量收集
│   │   ├── audit/         审计追踪
│   │   └── ports/         端口接口定义
│   ├── cli/               CLI 命令实现
│   ├── hook/              独立可执行判定进程
│   └── adapters/          执行器适配器（预留）
├── contracts/schemas/     JSON Schema 真源（6 个）
├── policy/                policy.yaml + lock.json
├── tests/                 测试
│   ├── acceptance/        验收测试（预留）
│   ├── policy-engine.test.ts
│   ├── slice-state.test.ts
│   ├── stall-classifier.test.ts
│   ├── sign-manager.test.ts
│   ├── gate-executor.test.ts
│   ├── scheduler.test.ts
│   ├── clarify-engine.test.ts
│   ├── metrics-collector.test.ts
│   ├── audit-trail.test.ts
│   └── hook-executable.test.ts
└── .zelto/                运行时状态
    ├── slices/            切片文件
    ├── events/            事件日志
    ├── locks/             签名请求
    └── config.yaml        项目配置
```

---

## 附录 A：测试清单

| 测试文件 | 测试数 | 覆盖模块 |
|---|---|---|
| `tests/policy-engine.test.ts` | 13 | PolicyEngine, matchPath, checkAnchor, hashPolicy |
| `tests/slice-state.test.ts` | 5 | SliceState 状态机 |
| `tests/stall-classifier.test.ts` | 5 | StallClassifier |
| `tests/sign-manager.test.ts` | 7 | SignManager |
| `tests/gate-executor.test.ts` | 3 | GateExecutor |
| `tests/scheduler.test.ts` | 6 | Scheduler |
| `tests/clarify-engine.test.ts` | 5 | ClarifyEngine |
| `tests/metrics-collector.test.ts` | 5 | MetricsCollector |
| `tests/audit-trail.test.ts` | 5 | AuditTrail |
| `tests/hook-executable.test.ts` | 7 | Hook 可执行体 |
| **总计** | **62** | **15 suites** |

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
pnpm build          # 编译（tsc）
pnpm dev            # 监听模式
pnpm test           # 编译 + 运行测试（62 tests, 15 suites）
pnpm test:quick     # 跳过编译直接跑测试
pnpm test:watch     # 监听模式跑测试
pnpm lint           # Biome 检查
pnpm format         # Biome 格式化
pnpm clean          # 清理 dist dist-test
pnpm link --global  # 全局安装 CLI
```
