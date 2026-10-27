# Slice: policy-edit-command

## 目的
新增 `zelto policy edit <id> [--path <p>] [--action <a>] [--basis <b>] [--guidance <g>] [--priority <n>] [--description <d>]` 命令，支持修改已有策略规则的部分字段。

## 范围
- `src/cli/policy/commands/edit.command.ts` — 新建 edit 命令模块
- `src/cli/policy/index.ts` — 注册 edit 子命令
- `src/cli/commands/shared.ts` — 可能不需要修改（复用现有 YAML 解析）
- `tests/acceptance/policy-edit/policy-edit.test.ts` — 验收测试

## 验收标准
1. `zelto policy edit existing-rule --action deny` 将规则 action 改为 deny
2. `zelto policy edit existing-rule --path "new/**" --basis "new-basis"` 同时修改多个字段
3. `zelto policy edit nonexistent-rule --action allow` 报错 "Rule not found"
4. 不指定任何 --flag 时显示 usage 提示
5. 修改后 `zelto policy list` 正确显示更新后的规则
6. 修改后 `zelto policy validate` 仍然通过

## 不包含
- 批量编辑
- 交互式编辑
- 修改 policy.yaml 格式（保持与 add/remove 一致的 YAML 处理）

## 风险
- YAML 原地编辑需要精确的行定位——复用 add.command.ts 中的 YAML 解析逻辑
- 需要处理 match 对象的修改（path 和 operation 是嵌套字段）
