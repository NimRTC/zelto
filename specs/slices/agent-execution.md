# Slice: agent-execution

## 目的
让 `zelto run` 真正拉起 agent 进程执行切片，而非仅做准入检查。
支持可配置的 agent 命令，传递约束包，记录执行结果。

## 范围
- `src/cli/commands.ts` — 修改 `run` 命令，添加 agent 执行逻辑
- `.zelto/config.yaml` — 添加 `agent.command` 配置项

## 验收标准
1. `zelto run <id>` 在准入后 spawn agent 子进程
2. agent 命令可通过 `.zelto/config.yaml` 的 `agent.command` 配置
3. 约束包以 JSON 文件形式传递给 agent（文件路径在环境变量 `ZELTO_BUNDLE`）
4. agent 退出后自动 transition 到 frozen（`RUN_FINISH`）
5. agent 非零退出时记录事件并报错
6. 全部 204+ 测试通过

## 风险
- agent 进程可能长时间运行 — 需后台执行
- agent 可能不存在（`npx claude-code` 未安装）— 需优雅报错
