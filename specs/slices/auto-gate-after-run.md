# Slice: auto-gate-after-run

## 目的
让 `zelto run` 在 agent 执行完成后自动执行门禁②（gate）验收，并在验收通过后自动创建签名请求，实现从"拉 agent"到"等签字"的完整闭环。同时在 agent 异常退出时自动分类 stall。

## 范围
- `src/cli/commands.ts` — 修改 `run` 和 `start` 命令

## 验收标准
1. `zelto run <id>` 在 agent 成功退出（exit 0）后自动执行 `gate` 命令序列
2. gate 全部通过后自动推进状态到 `completed` 并创建 sign request
3. gate 失败时打印失败详情，提示用户手动重试 `zelto gate <id>`
4. agent 异常退出（非 0）时自动调用 `classifyStall` 分类停机原因
5. stall 分类结果写入切片并记录事件
6. `zelto start <id>` 同样具备以上行为

## 不包含
- 实时 hook 拦截 agent 工具调用（需 SDK 集成）
- 重构 CLI 代码去重
- 修改任何已有接口或测试

## 风险
- gate 可能耗时较长（pnpm test 约 47s），用户需要等待
- 自动 sign request 创建后如果用户不想签，需要手动 `zelto sign --reject`
