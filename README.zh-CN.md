# zelto — AI 编程驾驶舱

[English](README.md) | 简体中文

**Let machines watch the machines.**

[![CI](https://github.com/NimRTC/zelto/actions/workflows/ci.yml/badge.svg)](https://github.com/NimRTC/zelto/actions/workflows/ci.yml)
[![Node](https://img.shields.io/badge/node-%3E%3D22-brightgreen)](https://nodejs.org)
[![TypeScript](https://img.shields.io/badge/typescript-7-blue)](https://www.typescriptlang.org)
[![License](https://img.shields.io/badge/license-MIT-green)](LICENSE)

> **Status: v0.5.0 — pre-1.0.** CLI flags, config schema, and event format may change
> without migration. Pin a commit if you need stability.

zelto 是一个 **AI 编程驾驶舱**（AI Programming Cockpit），不是 AI 编程助手。

它的职责不是写代码，而是**保证 agent 的每一行代码都能追溯到一条人批准的规格，且没有走出边界**。

---

## 架构总览

```
                    ┌─────────────────┐
                    │    人 (开发者)    │
                    │  定意图 · 签字   │
                    └────────┬────────┘
                             │
              ┌──────────────┼──────────────┐
              ▼              ▼              ▼
       ┌──────────┐  ┌──────────┐  ┌──────────┐
       │ clarify  │  │   sign   │  │  inbox   │
       │ 澄清规格  │  │  审批/拒  │  │  待签队列 │
       └────┬─────┘  └──────────┘  └──────────┘
            │
       ┌────▼─────┐     ┌──────────┐     ┌──────────┐
       │  slice   │────►│  sched   │────►│   gate   │
       │ 状态机    │     │ 并行准入  │     │  门禁执行  │
       └──────────┘     └──────────┘     └──────────┘
            │
       ┌────▼─────┐     ┌──────────┐     ┌──────────┐
       │  policy  │     │  stall   │     │  metrics │
       │ 策略引擎  │     │ 停机分类  │     │  度量收集  │
       └──────────┘     └──────────┘     └──────────┘

       ┌──────────┐     ┌──────────┐     ┌──────────┐
       │  events  │     │  audit   │     │   hook   │
       │ 事件流    │     │ 审计追踪  │     │ 判定进程  │
       └──────────┘     └──────────┘     └──────────┘
```

## 核心流程

```
clarify（澄清规格）→ draft + 验收骨架 → check（门禁①）→ freeze
  → plan → run（无人值守）→ gate（门禁②）→ sign（人签字）
```

## 定位

| 角色 | 是谁 | 做什么 |
|---|---|---|
| **主用户** | 开发者 | 定意图、定架构、回答澄清问题、审契约、签字 |
| **执行者** | agent (Claude Code) | 由 zelto 拉起，无人值守实现切片 |
| **看守者** | **zelto** | 校验追溯、分类停机、执行门禁、记录事件、分派任务 |

## 核心特性

- **切片状态机** — 6 状态（draft → clarifying → frozen → running → completed → abandoned），9 事件，文件持久化
- **策略引擎** — 规则匹配 + 保护域硬编码 + 路径逃逸检测 + 锚点校验，纯确定性
- **门禁执行** — 双门禁：① 确定性检查（freeze 前）② 验收测试（run 后），支持重试
- **并行准入** — 写集冲突检测，保证切片不会互相踩踏
- **停机分类** — 9 类停机（权限确认、环境失败、上下文耗尽、认知卡壳、计划门禁、预算耗尽、门禁重试、agent 提问、人工拉闸）
- **签名管理** — 审批/拒绝/撤销工作流，待签队列（签字只改状态，合并需显式跑 `zelto merge`）
- **事件流** — 52 种事件的 append-only JSONL 日志
- **草稿评审** — `require/design/plan show <id>` 给出摘要、决策点（新增/移除/变更）与相对上一版的 diff；refine 前自动留快照（ADR-023）
- **审计追踪** — 覆盖主要事件摘要，可读文本报告
- **度量收集** — rework rate、cycle time、stall counts
- **澄清引擎** — 按缺失项生成结构化问题（需求追溯、契约、验收测试、写集、验收依据），支持自动回答
- **独立 hook** — 可独立编译的策略判定进程，零依赖，可用于 git hooks / CI 门禁
- **架构约束** — `core/` 零第三方运行时依赖，纯 Node 内置

## 快速开始

```bash
# 安装
pnpm install
pnpm build

# 运行测试
pnpm test

# 全局安装（可选）
pnpm link --global
zelto help
zelto-hook < input.json

# CLI 命令（常用；完整 57 个命令以 `zelto help` 为准）
zelto slices          # 列出所有切片
zelto next            # 推荐下一步动作
zelto check <id>      # 门禁① 确定性检查
zelto freeze <id>     # 冻结切片基线
zelto run <id>        # 执行切片（含并行准入检查）
zelto gate <id>       # 门禁② 验收测试
zelto inbox           # 待签名队列
zelto sign <id> --approve  # 审批（--reject 拒绝，--revoke 撤销）
zelto halt            # 拉闸暂停，交回控制权
zelto merge           # 合并已签字的切片（显式动作）
```

LLM 通路（clarify / spec 草稿，可选）需要密钥。建议走环境变量，不落文件：

```bash
export ZELTO_LLM_API_KEY=sk-...   # 或 DEEPSEEK_API_KEY；都没有时回退到 .zelto/config.yaml 的 llm.apiKey
```

只有密钥走环境变量；`baseUrl` / `model` / `pricing` 仍留在 `.zelto/config.yaml`，
这样项目配置才是可复现的（ADR-022）。

也可以在配置文件里直接引用环境变量，密钥彻底不落盘（ADR-026）：

```yaml
llm:
  provider: deepseek
  apiKey: "${NIMRTC_LLM_API_KEY}"
```

`${NIMRTC_LLM_API_KEY}` 会被替换为同名环境变量的值。变量没设置时，
zelto 视作「没有密钥」并给出警告 —— 绝不会把 `${...}` 字面量当密钥发出去。

## 开发

```bash
pnpm dev              # 监听模式编译
pnpm test             # 运行全部测试（含验收测试）
pnpm test:quick       # 跳过重编，直接跑测试
pnpm test:watch       # 监听模式跑测试
pnpm lint             # 代码检查（biome）
pnpm format           # 自动格式化
pnpm clean            # 清理构建产物
```

## 技术栈

| 层 | 技术 |
|---|---|
| 语言 | TypeScript 7, strict: true |
| 运行时 | Node 22, ESM |
| 测试 | `node --test`（零测试框架依赖） |
| 格式化/Lint | Biome |
| 包管理 | pnpm 9 |
| 运行时依赖 | `core/` 零第三方依赖（仅 Node 内置）；整包另含 CLI/adapter 依赖 |

## 架构约束

| 约束 | 说明 |
|---|---|
| **C1** | 状态只在文件里 — 无数据库、无内存状态 |
| **C2** | `core/` 不依赖任何 SDK、不依赖 `adapters/` |
| **C3** | 判定必须确定性 — `core/policy/` 与 `core/gate/` 不得调用模型、不得触网 |
| **C4** | 每个动作写 append-only 事件流 |
| **C5/C8** | 保护域硬编码，不可被策略规则覆盖 |
| **C6** | 依赖单向向下 — `core/` 不得 import `adapters/` |
| **C7** | `llm/` 产出永远只能是草稿或建议，不参与任何判定 |
| **C9** | 写集预约由 hook 在运行时强制执行 |

## 项目结构

```
zelto/
├── src/
│   ├── core/
│   │   ├── policy/     策略引擎（规则匹配·保护域·锚点校验）
│   │   ├── slice/      切片状态机（6 状态·文件持久化）
│   │   ├── events/     append-only 事件流（52 种事件）
│   │   ├── gate/       门禁执行器 + 签名管理器
│   │   ├── stall/      停机分类器（9 类）
│   │   ├── sched/      并行准入 + 约束分发
│   │   ├── clarify/    对话引擎（按缺失项生成结构化问题）
│   │   ├── metrics/    度量收集
│   │   ├── audit/      审计追踪
│   │   ├── halt/       拉闸暂停 + 交回控制权
│   │   ├── review/     草稿评审（摘要 + diff + 决策点）
│   │   ├── ports/      端口接口定义
│   │   └── …          其余 core 模块（artifacts/budget/contracts/design/project/requirements/route/spec/version/worktree 等）详见 src/core/
│   ├── cli/            CLI 命令实现（57 个命令，以 `zelto help` 为准）
│   ├── hook/           独立可执行判定进程
│   └── adapters/       执行器适配器（默认 claude-agent，claude-agent-sdk 可选）
├── contracts/schemas/  JSON Schema 真源（13 个）
├── policy/             policy.yaml + lock.json
├── tests/              单元测试 + 验收测试
└── .zelto/             运行时状态（slices/ events/ locks/ halts/ worktrees/ 等，详见目录）
```

## 许可

[MIT](LICENSE)
