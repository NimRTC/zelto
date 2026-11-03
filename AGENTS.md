# AGENTS.md — zelto

## 这个项目是什么

zelto 是一个 **AI 编程驾驶舱**：它不写一行代码、不替你签字，
只保证「agent 的每一行代码都能追溯到一条人批准的规格，且没有走出边界」。

**约束优先于功能。** 宁可少一个功能，也不许破一条不变量。

## 硬约束（改任何代码前先读，改完自查）

**C1** 状态只在文件里——禁止引入数据库、禁止把状态放进内存或服务
**C2** `core/` 不依赖任何 SDK、不依赖 `adapters/`
**C3** 判定必须确定性——`core/policy/` 与 `core/gate/` 不得调用模型、不得触网
**C4** 每个动作写 append-only 事件流
**C5** 约束自身在被管辖范围之外——保护域不可被策略规则覆盖，锚点外部化
**C6** 依赖方向单向向下——`core/` 不得 import `adapters/`
**C7** `llm/` 的产出永远只能是被覆盖的草稿或建议，不参与任何判定
**C8** 保护域不可被策略自身覆盖；策略锚点外部化
**C9** 切片的写集预约必须由 hook 在运行时强制执行

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
- 不许在 `core/policy/`、`core/gate/` 里 import `llm/` 或发起网络请求
- 不许把状态写进 `.git` 之外的位置
- 不许绕过 policy 判定直接执行工具调用
- 不许改动 `tests/acceptance/**`（除非对应切片规格一起改并重新 freeze）
- 不许"顺手"实现负向清单里的东西：完整 GUI、一键批准、常驻 daemon、自动改规格、自动合并、重造 agent 编排引擎、路由自动学习

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

**但硬约束 C1–C9 永远不破**，与是否走切片无关：

- `core/` 依旧零第三方依赖、不 import `adapters/`
- `core/policy/`、`core/gate/` 依旧不调模型、不触网
- 状态依旧只落在文件里
- 判定依旧确定性
- 每个动作依旧写 append-only 事件
- 写集预约依旧由 hook 在运行时强制

**改动契约（schema / 事件类型 / 配置格式）时仍要写 ADR**——这条与切片流程无关，
因为契约变化会影响其他切片与已有实现。

需要改 schema / 加依赖 / 动不变量 → 停下来，写 ADR 提案（此条始终适用）。

## 文档

- 需求与场景：`docs/zelto-场景功能地图.md`
- 架构与不变量：`docs/zelto-技术架构.md`
- 开工包：`docs/zelto-开工包.md`
- 本切片规格：`specs/slices/<id>.md`
- 相关契约：`contracts/schemas/<name>.json`
