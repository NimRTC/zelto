# zelto 开工包

> 版本: v0.1.0 · 最后更新: 2026-10-15

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
ℹ tests 62
ℹ suites 15
ℹ pass 62
ℹ fail 0
```

### 1.3 全局安装（可选）

```bash
pnpm link --global
zelto help
```

---

## 2. 第一个切片

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
│   │   ├── metrics/       度量收集
│   │   ├── audit/         审计追踪
│   │   └── ports/         端口接口
│   ├── cli/               CLI 实现
│   ├── hook/              独立 hook
│   └── adapters/          适配器（预留）
├── contracts/schemas/     JSON Schema（6 个）
├── policy/                策略文件
├── tests/                 测试文件（10 个）
└── .zelto/                运行时状态
```

### 4.2 日常开发命令

```bash
pnpm build          # 编译
pnpm dev            # 监听模式编译
pnpm test           # 编译 + 测试
pnpm test:quick     # 快速测试（跳过编译）
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
```

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

| ID | 约束 | 检查方式 |
|---|---|---|
| C1 | 状态只在文件里 | 无数据库依赖，无全局变量状态 |
| C2 | core/ 无 SDK | `package.json` 无 dependencies |
| C3 | 判定确定性 | policy/gate/sched 无 import llm，无 fetch |
| C4 | append-only | EventStream 只用 appendFile |
| C5 | 保护域不可覆盖 | PROTECTED_PATTERNS 硬编码 |
| C6 | 依赖单向向下 | tsconfig 路径映射只 core → 外部 |
| C7 | llm 不判定 | llm/ 目录独立，不被判定模块引用 |
| C8 | 锚点外部化 | lock.json 存储策略哈希 |
| C9 | 写集预约强制 | Scheduler.admit 检查冲突 |

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
| `pnpm build` | ~2s |
| `pnpm test` (62 tests) | ~500ms |
| Hook 单次判定 | < 10ms |
| SliceStore.read | < 5ms |
| EventStream.append | < 5ms |
