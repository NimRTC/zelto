# zelto — AI Programming Cockpit

**Let machines watch the machines.**

[![CI](https://github.com/NimRTC/zelto/actions/workflows/ci.yml/badge.svg)](https://github.com/NimRTC/zelto/actions/workflows/ci.yml)
[![Node](https://img.shields.io/badge/node-%3E%3D22-brightgreen)](https://nodejs.org)
[![TypeScript](https://img.shields.io/badge/typescript-7-blue)](https://www.typescriptlang.org)
[![License](https://img.shields.io/badge/license-MIT-green)](LICENSE)

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

- **切片状态机** — 6 状态（draft → clarifying → frozen → admitted → running → done），9 事件，文件持久化
- **策略引擎** — 规则匹配 + 保护域硬编码 + 路径逃逸检测 + 锚点校验，纯确定性
- **门禁执行** — 双门禁：① 确定性检查（freeze 前）② 验收测试（run 后），支持重试
- **并行准入** — 写集冲突检测，保证切片不会互相踩踏
- **停机分类** — 6 类停机（权限提示、上下文耗尽、预算超限、认知卡住等）
- **签名管理** — 审批/拒绝工作流，待签队列
- **事件流** — 29 种事件的 append-only JSONL 日志
- **审计追踪** — 30 种事件摘要，可读文本报告
- **度量收集** — rework rate、cycle time、stall counts
- **澄清引擎** — 5 类结构化问题（路径、操作、约束、验收、风险），自动回答
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

# CLI 命令
zelto slices          # 列出所有切片
zelto next            # 推荐下一步动作
zelto check <id>      # 门禁① 确定性检查
zelto freeze <id>     # 冻结切片基线
zelto run <id>        # 执行切片（含并行准入检查）
zelto gate <id>       # 门禁② 验收测试
zelto inbox           # 待签名队列
zelto sign <id>       # 审批/拒绝
```

## 开发

```bash
pnpm dev              # 监听模式编译
pnpm test             # 运行测试（62 tests, 15 suites）
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
| 运行时依赖 | **零**（`core/` 仅用 Node 内置模块） |

## 架构约束

| 约束 | 说明 |
|---|---|
| **C1** | 状态只在文件里 — 无数据库、无内存状态 |
| **C2** | `core/` 不依赖任何 SDK、不依赖 `adapters/` |
| **C3** | 判定必须确定性 — policy/gate/sched 不得调用模型、不得触网 |
| **C4** | 每个动作写 append-only 事件流 |
| **C5/C8** | 保护域硬编码，不可被策略规则覆盖 |
| **C6** | 依赖单向向下 — `core/` 不得 import `adapters/` |
| **C7** | `llm/` 产出永远只能是草稿或建议，不参与任何判定 |
| **C9** | 写集预约由 sched 在运行时强制执行 |

## 项目结构

```
zelto/
├── src/
│   ├── core/
│   │   ├── policy/     策略引擎（规则匹配·保护域·锚点校验）
│   │   ├── slice/      切片状态机（6 状态·文件持久化）
│   │   ├── events/     append-only 事件流（29 种事件）
│   │   ├── gate/       门禁执行器 + 签名管理器
│   │   ├── stall/      停机分类器（6 类）
│   │   ├── sched/      并行准入 + 约束分发
│   │   ├── clarify/    对话引擎（5 类结构化问题）
│   │   ├── metrics/    度量收集
│   │   ├── audit/      审计追踪
│   │   └── ports/      端口接口定义
│   ├── cli/            CLI 命令实现（10 个命令）
│   ├── hook/           独立可执行判定进程
│   └── adapters/       执行器适配器（预留）
├── contracts/schemas/  JSON Schema 真源（6 个）
├── policy/             policy.yaml + lock.json
├── tests/              验收测试
└── .zelto/             运行时状态（slices/ events/ locks/ config.yaml）
```

## 许可

MIT
