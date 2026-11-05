# zelto 开工包

> 版本: v0.3.0 · 最后更新: 2026-11-04
> 项目定位与目标见 `docs/zelto-项目目标.md`

---

## 1. 快速上手

### 1.1 前提

- Node.js ≥ 22
- pnpm ≥ 9

### 1.2 安装

```bash
git clone <repo-url>
cd zelto
pnpm install
pnpm build
pnpm test
```

期望输出：

```
ℹ tests 982
ℹ suites 204
ℹ pass 980
ℹ fail 0
ℹ skipped 2
```

### 1.3 全局安装（可选）

```bash
pnpm link --global
zelto help
```

---

## 2. 完整主线：一个人 + 一组 agent 做中大型项目

这是 zelto 的**主用法**。单切片流程（§3）是小项目或调试时用的。

主线就是驾驶舱的三段：**规划**（人主导）→ **高速并行**（zelto 主导）→ **拉闸**（人接手）。

```
想做一个东西
   │
   ├─ ① zelto require "用自然语言说清需求"
   ├─ ② zelto require confirm <id>          ← 人点头
   │
   ├─ ③ zelto design <req-id>               ← 生成设计 + 模块划分
   ├─ ④ zelto design confirm <id>           ← 人点头
   │
   ├─ ⑤ zelto plan <design-id>              ← 生成版本计划 + 切片划分
   ├─ ⑥ zelto plan confirm <id>             ← 人点头，同时写出 specs/slices/*.md
   │
   ├─ ⑦ zelto version start v1              ← 并行拉起 N 个 agent 高速开发
   │      （各自隔离 worktree + 写集守卫；出错的当场拦下）
   │
   ├─ ⑧ zelto sign <slice-id> --approve     ← 逐片签字（只改状态，不碰主干）
   │      zelto inbox                       ← 看还有哪些待签
   │
   ├─ ⑨ zelto merge [<slice-id> ...]         ← 显式合并（不带 id = 全部待合切片）
   │      zelto merge plan <slice-id>       ← 先看合并计划
   │
   └─ ⑩ zelto version deliver v1            ← 前置条件 + 主仓版本级验收
```

**每一次 `confirm` 都是人点头**，未确认不往下走。
**自动化止步于「待签字」** —— `version start --auto` 已被移除。
**签字 ≠ 合并** —— 签字只改状态，合入主干必须显式跑 `zelto merge`（ADR-018）。

### 2.1 规划段的四件事

规划层是整个驾驶舱的入口，也是最需要人把关的一段：

| 阶段 | 命令 | 产出 |
|---|---|---|
| 方案设计 | `zelto design` | 设计草案 + **模块划分**（模块名 / 文件 / 依赖） |
| 版本规划 | `zelto plan` | 版本计划（版本顺序 + 每版挂哪些切片） |
| 模块划分 | 同上，写进 `modules[].dependencies` | 可被后续校验的模块边界 |
| 切片设置 | `zelto plan confirm` | `specs/slices/*.md` + 切片文件的写集与追溯字段 |

**每一级都是「生成草案 → 人 `confirm` → 才往下走」。**
LLM 产出永远只是草稿（C7），zelto 不替人做决定。

### 2.1 开工前的批次预检

正式开跑前，先看一眼这批切片能不能一起开工：

```bash
zelto batch <slice-id...> --depends-on a=b
# 输出：准入审核结果 + 执行阶段（依赖分层 + 写集冲突降级）+ 工件冲突
```

它只查不跑，判定逻辑在 `core/sched/batch.ts`（确定性，不调模型、不触网）。

**它排出的阶段就是开跑时会用的阶段**——`version start` 与 `run --parallel`
消费的是同一份计划（`src/cli/commands/execution-plan.ts`），不会「预检说能开、实际跑不了」。
阶段之间串行、阶段之内并行；写集重叠的切片自动降级为串行，不整批 abort。

### 2.2 中途出问题时

```bash
zelto ask                       # agent 有问题在等你回答
zelto answer <qid> "回答内容"     # 回答后续跑

zelto stall                     # 哪些切片停机了、什么类别
zelto resume <id>               # 恢复（--skip / --abandon 也行）

zelto version start v1 --retry-failed   # 处理完之后重跑版本
```

---

## 3. 单切片流程（小项目 / 调试）

### 2.1 创建切片

```bash
# 手动创建切片文件
cat > .zelto/slices/my-first-slice.json << 'EOF'
{
  "id": "my-first-slice",
  "title": "第一个切片",
  "state": "draft",
  "spec": { "path": "specs/slices/my-first-slice.md", "frozenHash": null, "frozenAt": null },
  "acceptance": { "dir": "tests/acceptance/my-first-slice/", "frozenHash": null, "oracleSrc": null },
  "baseCommit": null,
  "drift": { "detected": false, "reason": null, "at": null },
  "trace": { "requirements": ["R1: 系统能...", "R2: ..."], "contracts": [], "tests": [] },
  "traceWaiver": null,
  "writes": ["src/**/*.ts"],
  "runs": [],
  "stall": { "class": null, "autoResolved": 0, "gateRetries": 0 },
  "createdAt": "2026-10-15T00:00:00.000Z",
  "updatedAt": "2026-10-15T00:00:00.000Z"
}
EOF
```

### 2.2 查看切片

```bash
zelto slices
# 输出:
#   my-first-slice       draft            第一个切片
```

### 2.3 门禁① 检查

```bash
zelto check my-first-slice
# 输出:
#   Slice:   第一个切片
#   State:   draft
#   Issues:  没有契约, 没有测试
#   Result:  修复问题后冻结
```

### 2.4 冻结

```bash
zelto freeze my-first-slice
# 输出:
#   ✅ Slice frozen at 2026-10-15T00:00:00.000Z
```

### 2.5 模拟执行

```bash
zelto run my-first-slice --dry-run
# 输出:
#   ✅ Would admit (dry-run)
#   Write-set: src/**/*.ts
#   Instructions: 13 lines
```

### 2.6 执行

```bash
zelto run my-first-slice
# 输出:
#   ✅ Admitted and starting execution...
```

### 2.7 门禁② 验收

```bash
zelto gate my-first-slice
# 输出:
#   ✅ Gate passed
#   Next: zelto sign my-first-slice --approve
```

### 2.8 签字

```bash
zelto inbox
# 查看待签队列

zelto sign my-first-slice --approve
# 输出:
#   ✅ Approved
```

---

## 3. 核心概念

### 3.1 切片（Slice）

切片是 zelto 的基本工作单元。一个切片描述一个**有边界、可独立验证**的改动。

**切片三要素**:
1. **规格（Spec）** — 描述要做什么、怎么做
2. **写集（Write-set）** — 列出要修改的文件路径
3. **追溯（Trace）** — 关联到需求、契约、测试

### 3.2 门禁（Gate）

两道门禁确保代码质量：

| 门禁 | 时机 | 做什么 |
|---|---|---|
| **门禁① (check)** | freeze 前 | 追溯完整性检查、规格存在性、漂移检测 |
| **门禁② (gate)** | run 后 | 运行验收测试（`pnpm test`、`pnpm lint`），支持重试 |

### 3.3 策略（Policy）

策略规则定义 agent 可以做什么、不可以做什么。存储在 `policy/policy.yaml`。

```yaml
rules:
  - id: allow-src-ts
    match: { path: "src/**/*.ts", operation: "write" }
    action: allow
    basis: "policy.yaml#allow-src-ts"
```

**判定结果**: `allow`（允许）、`deny`（拒绝）、`ask`（需要人确认）。

### 3.4 Hook

`zelto-hook` 是一个可独立运行的可执行文件，用于在 git hooks、CI 或编辑器中实时拦截越界操作。

```bash
echo '{"path":"src/foo.ts","operation":"write","harness":"git"}' | zelto-hook
# {"decision":"allow","decision_id":"hook-...","basis":"policy.yaml#allow-src-ts",...}
```

---

## 4. 开发指南

### 4.1 目录结构速览

```
zelto/
├── src/
│   ├── core/              核心逻辑
│   │   ├── policy/        策略引擎
│   │   ├── slice/         切片状态机 + 文件持久化
│   │   ├── events/        事件流
│   │   ├── gate/          门禁 + 签名
│   │   ├── stall/         停机分类
│   │   ├── sched/         调度 + 约束
│   │   ├── clarify/       澄清引擎
│   │   ├── budget/        预算跟踪
│   │   ├── metrics/       度量收集
│   │   ├── audit/         审计追踪
│   │   ├── ports/         端口接口
│   │   └── spec/          规格引擎
│   │   ├── artifacts/     制品管理
│   │   ├── contracts/     契约管理
│   │   ├── route/         路由
│   │   └── spec/          规格引擎
│   ├── cli/               CLI 实现（40+ 个命令）
│   ├── hook/              独立 hook
│   └── adapters/          适配器（claude-agent）
├── contracts/schemas/     JSON Schema（6 个）
├── policy/                策略文件
├── tests/                 测试文件（44 个单元 + 19 验收 suites → 662 tests）
└── .zelto/                运行时状态
```

### 4.2 日常开发命令

```bash
pnpm build          # 编译
pnpm dev            # 监听模式编译
pnpm test           # 编译 + 全量测试
pnpm test:quick     # 跳过编译跑全量测试
pnpm test:unit      # 编译 + 纯单元测试（最快反馈，~1.8s）
pnpm test:acceptance # 仅验收测试
pnpm test:watch     # 监听模式测试
pnpm lint           # Biome 检查
pnpm format         # 自动格式化
pnpm clean          # 清理
```

### 4.3 添加新模块

1. 在 `src/core/` 下创建目录 + index.ts
2. 实现纯函数/类（零第三方依赖）
3. 在 `tests/` 下添加 `.test.ts`
4. 用 `node --test` 测试
5. 如需暴露到 CLI：在 `src/cli/commands.ts` 注册命令

### 4.4 测试规范

- 使用 `node:test`（`describe`, `it`, `before`, `after`）
- 使用 `node:assert/strict`
- 测试文件命名：`tests/<module>.test.ts`
- Hook 集成测试：spawn 子进程 + stdin/stdout

### 4.5 策略规则语法

```yaml
rules:
  - id: <唯一标识>
    match:
      path: "<glob 模式>"
      operation: "read" | "write" | "execute"
    action: "allow" | "deny" | "ask"
    basis: "<依据来源>"
    guidance: "<给 agent 的指引>"  # 可选
    priority: <数字>               # 可选，越大越优先
```

---

## 5. 配置参考

### 5.1 `.zelto/config.yaml`

```yaml
gate:
  commands:
    - name: test
      run: pnpm test
    - name: lint
      run: pnpm lint
  timeoutSec: 120
  retry:
    max: 2

# LLM 通路（可选）。密钥建议走环境变量，不落文件（ADR-022）：
#   export ZELTO_LLM_API_KEY=sk-...
llm:
  provider: deepseek
  baseUrl: https://api.deepseek.com/v1
  model: deepseek-chat
```

也可以在配置文件里引用环境变量（ADR-026）——密钥彻底不落盘：

```yaml
llm:
  provider: deepseek
  apiKey: "${NIMRTC_LLM_API_KEY}"
  baseUrl: https://api.deepseek.com/v1
  model: deepseek-chat
```

`${NIMRTC_LLM_API_KEY}` 会被替换为同名环境变量的值。变量没设置时，
zelto 视作「没有密钥」并给出警告 —— **绝不会把 `${...}` 字面量当密钥发出去**。

只支持整值引用：`"${FOO}"` 可以，`"prefix-${FOO}"` 不展开（保持原样）。

**密钥来源优先级**（ADR-022）：

| 优先级 | 来源 | 说明 |
|---|---|---|
| 1 | `ZELTO_LLM_API_KEY` | zelto 专用，不与其它工具抢 |
| 2 | `DEEPSEEK_API_KEY` | 生态通用命名 |
| 3 | `llm.apiKey`（配置文件） | 回退路径，存量用户不用改 |

配置里的 `${VAR}` 引用展开后落在第 3 级 —— 环境变量里的
`ZELTO_LLM_API_KEY` 仍然赢过它。

`llm.baseUrl` / `llm.model` / `llm.pricing` 是配置不是密钥，**不读环境变量**，
留在文件里才能保证项目可复现。

没有 key 不是错误 —— 通路 B（clarify / spec / stall）本来就可选，
相关命令只是会报 `LLM_NOT_CONFIGURED`。

### 5.2 `policy/policy.yaml`

```yaml
rules:
  - id: allow-src-ts
    match: { path: "src/**/*.ts", operation: "write" }
    action: allow
    basis: "policy.yaml#allow-src-ts"

  - id: allow-read-all
    match: { path: "**", operation: "read" }
    action: allow
    basis: "policy.yaml#allow-read-all"
    priority: 0

  - id: deny-acceptance-direct
    match: { path: "tests/acceptance/**", operation: "write" }
    action: deny
    basis: "AGENTS.md#禁区-5"
    guidance: "Acceptance tests are frozen with the spec."
```

### 5.3 `policy/lock.json`

```json
{
  "hash": "sha256:2a30463e9bd3f61d5269f91a07a5dc9ea31f261bb225f837d4d8db1d9c6f758e",
  "commit": null,
  "lockedAt": "2026-10-15T00:00:00.000Z",
  "lockedBy": "system"
}
```

---

## 6. 集成指南

### 6.1 Git Hook 集成

```bash
# .git/hooks/pre-commit
#!/bin/sh
echo '{"path":"'"$1"'","operation":"write","harness":"git"}' | zelto-hook
```

### 6.2 CI 集成

GitHub Actions（`.github/workflows/ci.yml`）:

```yaml
steps:
  - uses: actions/checkout@v4
  - uses: pnpm/action-setup@v4
  - uses: actions/setup-node@v4
  - run: pnpm install --frozen-lockfile
  - run: pnpm build
  - run: pnpm test
  - run: pnpm lint
```

### 6.3 Agent 集成

zelto 可拉起 agent 执行切片，约束包（ConstraintBundle）包含：

- 规格路径和 frozen hash
- 写集（允许修改的文件）
- 保护路径（禁止修改）
- 策略规则
- 验收测试目录
- 执行指令

---

## 7. 架构约束速查

有效约束 7 条，C1–C9 编号保留作兼容（C6 并入 C2，C8 并入 C5）。

| ID | 约束 | 检查方式 |
|---|---|---|
| C1 | 状态只在文件里 | 无数据库依赖，无全局变量状态；状态变更只经文件读写 |
| C2 | core/ 核心纯洁性 | `package.json` 无 dependencies；无 `core/` import `adapters/` |
| C3 | 判定确定性 | policy/gate/sched 无 import llm，无 fetch；只读文件、纯计算 |
| C4 | append-only | EventStream 只用 appendFile |
| C5 | 保护域与锚点外部化 | PROTECTED_PATTERNS 硬编码；lock.json 存储策略哈希 |
| C7 | llm 不判定 | llm/ 目录独立，不被判定模块引用；进下游须人 confirm |
| C9 | 写集预约强制 | Scheduler.admit 检查冲突；运行时 hook 逐写判定 + 审计兜底，缺预约 fail closed |

---

## 8. 故障排除

### 8.1 测试失败

```bash
# 确保先编译
pnpm build
pnpm test

# 或者跳过编译直接跑
pnpm test:quick
```

### 8.2 编译错误

```bash
# 清理后重试
pnpm clean
pnpm build
```

### 8.3 CLI 找不到

```bash
# 确保全局链接
pnpm link --global
# 或直接使用
node dist/cli/index.js help
```

### 8.4 Hook 拒绝操作

```bash
# 检查策略规则
cat policy/policy.yaml

# 检查路径是否在保护域
# 保护域: policy/**, .zelto/**, AGENTS.md, .cursor/rules/**, zelto-hook

# 测试 hook
echo '{"path":"<your-path>","operation":"write","harness":"test"}' | node dist/hook/index.js
```

---

## 附录 A：文件模板

### 切片规格模板 (`specs/slices/<id>.md`)

```markdown
# Slice: <id>

## 目的
<!-- 一句话描述这个切片要做什么 -->

## 范围
<!-- 列出要修改的文件 -->

## 验收标准
<!-- 如何验证实现正确 -->

## 风险
<!-- 潜在风险和回退方案 -->
```

### 切片 JSON 模板

```json
{
  "id": "<slice-id>",
  "title": "<可读标题>",
  "state": "draft",
  "spec": { "path": "specs/slices/<id>.md", "frozenHash": null, "frozenAt": null },
  "acceptance": { "dir": "tests/acceptance/<id>/", "frozenHash": null, "oracleSrc": null },
  "baseCommit": null,
  "drift": { "detected": false, "reason": null, "at": null },
  "trace": { "requirements": [], "contracts": [], "tests": [] },
  "traceWaiver": null,
  "writes": [],
  "runs": [],
  "stall": { "class": null, "autoResolved": 0, "gateRetries": 0 },
  "createdAt": "<ISO-8601>",
  "updatedAt": "<ISO-8601>"
}
```

## 附录 B：术语表

| 术语 | 英文 | 说明 |
|---|---|---|
| 切片 | Slice | 有边界、可独立验证的改动单元 |
| 规格 | Spec | 描述切片要做什么的文档 |
| 写集 | Write-set | 切片允许修改的文件路径列表 |
| 门禁 | Gate | 质量检查关卡 |
| 策略 | Policy | 定义 agent 行为边界的规则集 |
| Hook | Hook | 独立的策略判定可执行体 |
| 停机 | Stall | agent 执行受阻时的分类 |
| 追溯 | Trace | 代码到需求的可追溯性链接 |
| 锚点 | Anchor | 策略文件的哈希锁定 |
| 保护域 | Protected domain | 硬编码的不可修改路径 |

## 附录 C：性能指标

| 操作 | 耗时 |
|---|---|
| `pnpm build` | ~2.4s |
| `pnpm test:unit` (482 tests) | ~1.8s（含编译） |
| `pnpm test` (676+ tests, 208 files) | ~60s（含编译 + 验收） |
| CLI 冷启动（`zelto help`） | ~300ms |
| Hook 单次判定 | ~100ms（含 Node 启动），< 10ms（纯判定） |
| SliceStore.read | < 5ms |
| EventStream.append | < 5ms |
