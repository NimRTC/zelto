# Slice: shell-completion

## 目的
改进 `zelto completion bash/zsh/fish` 命令，补全缺失的命令列表和子命令补全。

## 范围
- `src/cli/commands/completion.ts` — 更新命令列表和子命令补全

## 验收标准
1. `zelto completion bash` 输出包含所有命令（含 policy, audit, snapshot）
2. `zelto completion zsh` 输出包含子命令补全（如 policy→list/check/validate/add/remove/edit）
3. `zelto completion fish` 输出包含子命令补全
4. 输出为合法的 shell 补全脚本

## 不包含
- 动态补全（从运行时注册的命令自动生成）
- 文件路径补全
