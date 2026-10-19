# Slice: events-command

## 目的
新增 `zelto events <id>` 命令，用于查看切片的事件流，将事件流从文件系统暴露到 CLI。

## 范围
- `src/cli/commands.ts` — 新增 events 命令
- `tests/events-command.test.ts` — 测试

## 验收标准
1. `zelto events <id>` 列出该切片的所有事件（时间、类型、actor）
2. `zelto events <id> --json` 输出原始 JSON 格式
3. `zelto events <id> --tail N` 只显示最近 N 条
4. 不存在的切片 ID 给出友好错误
5. 无事件的切片显示空列表

## 风险
- 低风险：只读操作，不修改任何状态
