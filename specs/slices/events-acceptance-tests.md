# Slice: events-acceptance-tests

## 目的
为 `zelto events` 命令添加验收测试，确保事件流查看在真实环境下按规格工作。

## 范围
- `tests/acceptance/events-command/events.test.ts` — 验收测试文件
- 不修改任何 CLI 代码或核心逻辑

## 验收标准
1. 有事件的切片列出所有事件（时间、类型、actor）
2. `--tail N` 只显示最近 N 条
3. `--json` 输出合法 JSON 格式
4. 不存在的切片输出友好错误信息
5. 无事件的切片显示空列表

## 风险
- 低风险：仅新增测试文件
