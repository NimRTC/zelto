# AGENTS.md — zelto

## 这个项目是什么

zelto 是一个 **AI 编程驾驶舱**：它不写一行代码、不替你签字，
只保证「agent 的每一行代码都能追溯到一条人批准的规格，且没有走出边界」。

它是「一个人 + 一组 agent」做中大型项目时的驾驶舱，管住从想法到主干的整个过程：

```
人做规划（方案设计 → 版本规划 → 模块划分 → 切片设置）
   ↓  规划确认完
zelto 控制并行 agent 进入高速开发（隔离 worktree + 写集守卫 + 门禁）
   ↓  出错时
拉闸 —— 越界当场拦下、卡住会来问人，人被交还控制权
   ↓  验收通过
逐片签字 → 显式合并 → 版本交付 → 下一个版本
```

**可追溯是 zelto 区别于其它 AI 编程工具的本质特征，不能因为功能变多而丢掉。**
其它工具靠「把上下文喂给模型」让模型写对；zelto 靠「把上下文变成可判定的约束」，
让越界在发生的那一刻就暴露。这条追溯链同时是三段的底座：
规划层的约束因此可校验、并行因此不打架、出错因此能定责。
完整目标见 `docs/zelto-项目目标.md`。

**约束优先于功能。** 宁可少一个功能，也不许破一条不变量。

## 硬约束（改任何代码前先读，改完自查）

> 有效约束为 7 条，保留 C1–C9 编号以兼容历史引用。
> 其中 C6 是 C2 的依赖方向分面，C8 是 C5 的具体落地分面——新文档优先引用 C2 / C5。

**C1** 状态只在文件里——无数据库、无内存状态、无常驻 daemon；状态变更只经文件读写，崩溃可恢复、事后可审计
**C2** `core/` 核心纯洁性——零第三方运行时依赖（只用 Node 内置），且不得 import `adapters/`（依赖单向向下；原 C6 并入本条）
**C3** 判定必须确定性——`core/policy/`、`core/gate/`、`core/sched/` 不得调用模型、不得触网；判定只读文件、纯计算
**C4** 每个动作写 append-only 事件流——只追加、不改不删；事件是追溯的唯一证据载体
**C5** 保护域与锚点外部化——保护域硬编码、不可被任何策略规则覆盖；策略哈希锚点存于 `policy/lock.json`，独立于策略本身（原 C8 并入本条）
**C6** 同 C2 的依赖方向部分（兼容别名，内容见 C2）——`core/` 不得 import `adapters/`
**C7** `llm/` 只产草稿——产出永远是可被覆盖的建议，不参与任何判定；进下游须经人 `confirm`
**C8** 同 C5（兼容别名，内容见 C5）——保护域不可被策略自身覆盖；策略锚点外部化
**C9** 写集预约运行时强制——以 PreToolUse 钩子逐写判定为主、运行后 git 审计兜底；预约缺失时 fail closed（一律拒绝）

## 技术栈与约定

- TypeScript + Node 22，ESM，`strict: true`
- `core/` 零第三方运行时依赖（只用 Node 内置）
- 测试用内置 `node --test`
- 提交信息：Conventional Commits，并带 `Refs-Slice: <id>` trailer
- 格式化与 lint 由 biome 处理

**测试前必须先构建。** 验收测试（`tests/acceptance/**`）是启动 `dist/cli/index.js`
这个真实 CLI 进程的，而单元测试跑的是 `dist-test/`。所以改完 `src/` 之后，
必须先 `npm run build`（或直接用 `npm test`，它已经会先构建），
否则验收测试会拿旧二进制去跑，出现"改了代码却还是旧行为"的假象。

## 目录

```
src/
  core/        切片状态机·规格校验·policy·gate·stall·artifacts·events
  adapters/    executor 适配器（v1 只有 claude-agent-sdk）
  llm/         通路 B（仅 clarify/spec/stall 可依赖）
  cli/         命令实现（与界面共用同一接口）
  hook/        可独立编译的判定进程
contracts/schemas/   JSON Schema 真源
policy/              policy.yaml + fixtures/ + lock.json
tests/acceptance/    验收测试骨架
.zelto/             slices/ events/ locks/ config.yaml
```

## 禁区（违反则 PR 直接打回）

- 不许给 `core/` 加任何 npm 依赖
- 不许在 `core/policy/`、`core/gate/`、`core/sched/` 里 import `llm/` 或发起网络请求
- 不许把状态写进 `.git` 之外的位置
- 不许绕过 policy 判定直接执行工具调用
- 不许改动 `tests/acceptance/**`（除非对应切片规格一起改并重新 freeze）
- 不许"顺手"实现负向清单里的东西：完整 GUI、一键批准、常驻 daemon、自动改规格、自动合并、重造 agent 编排引擎、路由自动学习

**签字不自动合并**（ADR-018）：`zelto sign --approve` 只改状态，不碰主干。
合并必须显式跑 `zelto merge`。签字后自动合并、把 `--push` 挂在签字上，
都属于违反禁区——与负向清单里的「自动合并」直接冲突。

**hotfix 必须显式确认**（ADR-015）：`zelto run --hotfix` 跳过门禁②，
所以必须配 `--yes`，否则拒绝执行（退出码 1）。hotfix 只跳过门禁②，
写集预约、越界审计、保护域、事件流全部照常。

## 遇到不确定时

**停下来问，不要自己选。** 具体地：

- 规格里没写的行为 → 问，不许按"更合理"的直觉补全
- 需要改 schema / 加依赖 / 动不变量 → 停下来，写 ADR 提案
- 发现文档里有"建议值""待验证"字样 → 按原样提问，不许填默认

## 开发 zelto 自身时的例外

**开发 zelto 这个工具本身时，不强制走切片流程。** 具体地：

- 切片可以切得粗一些：几个相关改动合并成一个切片，或直接不开切片
- 可以在不 freeze、不签字的情况下直接改代码——只要改完能跑通测试、lint 通过
- 不要求"做完即停等签字"，可以连续做下去

**但硬约束 C1–C9（有效 7 条，C6 并入 C2、C8 并入 C5）永远不破**，与是否走切片无关：

- `core/` 依旧零第三方依赖、不 import `adapters/`
- `core/policy/`、`core/gate/`、`core/sched/` 依旧不调模型、不触网
- 状态依旧只落在文件里
- 判定依旧确定性
- 每个动作依旧写 append-only 事件
- 写集预约依旧运行时强制（hook 逐写判定为主、审计兜底，缺预约 fail closed）

**改动契约（schema / 事件类型 / 配置格式）时仍要写 ADR**——这条与切片流程无关，
因为契约变化会影响其他切片与已有实现。

需要改 schema / 加依赖 / 动不变量 → 停下来，写 ADR 提案（此条始终适用）。

## 文档

- **项目目标**（定位、目标、差距、待决策）：`docs/zelto-项目目标.md`
- 需求与场景：`docs/zelto-场景功能地图.md`
- 架构与不变量：`docs/zelto-技术架构.md`
- 开工包：`docs/zelto-开工包.md`
- 并行自治路线：`docs/zelto-并行自治计划.md`
- 本切片规格：`specs/slices/<id>.md`
- 相关契约：`contracts/schemas/<name>.json`
