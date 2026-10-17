# Slice: acceptance-agent-execution

## 目的
为已完成的 `agent-execution` 切片编写端到端验收测试，验证 `zelto run` 命令能正确拉起 agent 子进程、传递约束包、记录执行结果。
验收测试放在 `tests/acceptance/agent-execution/` 目录下，采用 spawn CLI 子进程的方式运行，使用 `echo` 作为 mock agent。

## 范围
- `tests/acceptance/agent-execution/` — 新建验收测试脚本

## 验收标准
1. 验收测试创建 `.zelto/config.yaml` 将 agent.command 设为 `echo`，然后 spawn `zelto run <id>`，验证 agent 被拉起并退出
2. 验收测试验证 agent 退出后切片 transition 到 `frozen`（`RUN_FINISH`）
3. 验收测试验证约束包 JSON 文件被创建（环境变量 `ZELTO_BUNDLE`）
4. 验收测试验证 agent 非零退出时记录事件并报错
5. 验收测试验证 `zelto run --dry-run` 模拟准入检查（不实际执行）
6. 验收测试使用 `node --test` 运行，输出符合 TAP 格式
7. 验收测试使用独立的临时目录运行，不影响项目工作目录

## 不包含
- 其他切片的验收测试
- 修改任何已存在的源文件或测试文件

## 风险
- 验收测试需要 `dist/cli/index.js` 已编译（依赖 `pnpm build`）
- Windows 路径分隔符与 POSIX 不同，需确保跨平台兼容
