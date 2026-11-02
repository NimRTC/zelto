# Slice: acceptance-clarify

## 目的
为已完成的 `clarify-command` 切片编写端到端验收测试，验证 `zelto clarify` 命令在临时目录中的完整行为。

## 范围
- `tests/acceptance/clarify-command/` — 新建验收测试脚本

## 验收标准
1. 验收测试创建 draft 切片后执行 `zelto clarify <id> --auto`，验证输出包含问题列表和自动回答信息
2. 验收测试验证 `clarify --auto` 后切片状态变为 `frozen`
3. 验收测试验证 `clarify --dry-run` 只列出问题不改变状态
4. 验收测试验证对非 draft/clarifying 状态的切片（如 frozen）拒绝 clarify
5. 验收测试使用独立临时目录

## 不包含
- 其他切片的验收测试
- 修改任何源文件或已有测试

## 风险
- 无
