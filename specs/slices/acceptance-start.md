# Slice: acceptance-start

## 目的
为已完成的 `start-command` 切片编写端到端验收测试，验证 `zelto start` 一键流程（create → check → freeze → run）在临时目录中的完整行为。

由于 `zelto start` 会 spawn agent 子进程，验收测试将 agent 命令设为 `echo` 以避免拉起真实 agent。

## 范围
- `tests/acceptance/start-command/` — 新建验收测试脚本

## 验收标准
1. 验收测试创建 `.zelto/config.yaml` 将 agent.command 设为 `echo`，然后 spawn `zelto start new-slice`，验证从 create 到 agent 执行的完整流程
2. 验收测试验证已存在的 draft 切片执行 `zelto start` 跳过 create 阶段
3. 验收测试验证输出包含各阶段状态信息
4. 验收测试验证切片最终进入 `running` 状态
5. 验收测试使用独立临时目录

## 不包含
- 其他切片的验收测试
- 修改任何源文件或已有测试

## 风险
- 无
