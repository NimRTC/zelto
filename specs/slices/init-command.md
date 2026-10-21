# Slice: init-command

## 目的
添加 `zelto init` 命令，初始化 `.zelto/` 运行时目录结构。

## 范围
- `src/cli/commands.ts` — 新增 `init` 命令
- `.zelto/` — 运行时目录（运行时创建，不入 git）

## 验收标准
1. `zelto init` 创建 `.zelto/slices/` `.zelto/events/` `.zelto/locks/` + 默认 config.yaml
2. 已存在时跳过，不覆盖已有文件
3. 输出清晰的状态信息
4. 全部 204+ 测试通过

## 风险
- 无。纯文件操作。
