# Slice: acceptance-abandon

## 目的
为已完成的 `abandon-command` 切片编写端到端验收测试，验证 `zelto abandon` 命令在临时目录中的完整行为。

## 范围
- `tests/acceptance/abandon-command/` — 新建验收测试脚本

## 验收标准
1. 验收测试 spawn `zelto create` + `zelto abandon <id>`，验证切片状态变为 `abandoned`
2. 验收测试验证 `zelto abandon` 输出包含前状态和当前状态
3. 验收测试验证重复 abandon 已废弃切片时报错
4. 验收测试验证 abandon 不存在的切片时报错
5. 验收测试从 `draft`、`frozen` 等不同状态 abandon 均成功
6. 验收测试使用独立临时目录

## 不包含
- 其他切片的验收测试
- 修改任何源文件或已有测试

## 风险
- 无
