# Slice: executor-adapter-interface

## 目的
定义 `ExecutorAdapter` 接口并在 `src/adapters/` 下实现第一个适配器 `ClaudeAgentAdapter`，将现有的 `spawn(agentName, ...)` 逻辑封装到适配器中。

这是 executor adapters 系列的第一个切片，只做接口定义和第一个实现，不重构 CLI 调用方（那是 slice 2）。

## 范围
- `src/core/ports/executor.ts` — 新建 `ExecutorAdapter` 接口
- `src/core/ports/index.ts` — re-export executor types
- `src/adapters/claude-agent/index.ts` — 新建 ClaudeAgentAdapter 实现
- `tests/executor-adapter.test.ts` — 适配器单元测试

## 验收标准
1. `ExecutorAdapter` 接口定义 `start()` / `resume()` / `stop()` / `events()` 方法
2. `ExecutorAdapter` 包含 `readonly name: string` 和 `readonly metadata: AdapterMeta` 字段
3. `ClaudeAgentAdapter` 实现通过 `spawn('npx claude-code', ...)` 启动 agent 子进程
4. `ClaudeAgentAdapter.start()` 返回 `{ sessionId: string }`
5. `ClaudeAgentAdapter` 在子进程退出时标记 session 结束
6. 单元测试验证适配器能 spawn 一个 echo 命令替代真实 agent
7. `core/` 不依赖 `adapters/`（C6 约束）

## 不包含
- 重构 CLI `run` 命令（下一个切片）
- 其他适配器（如 Copilot、Cursor）
- 修改任何已有接口或命令

## 风险
- Windows 上 spawn 行为与 POSIX 不同（shell: true 已处理）
- 子进程生命周期管理需要小心（超时、僵尸进程）
