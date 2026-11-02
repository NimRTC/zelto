# Slice: acceptance-sign-transitions

## 目的
为已完成的 `sign-command` 切片编写端到端验收测试，验证 `zelto sign`（approve/reject）和 `zelto inbox` 命令在临时目录中的完整行为。

由于 sign request 在 gate 通过后自动创建，验收测试直接创建 sign request JSON 文件来模拟 gate 完成的状态，以保持测试聚焦且不依赖完整 gate 链条。

## 范围
- `tests/acceptance/sign-command/` — 新建验收测试脚本

## 验收标准
1. 验收测试手动创建 sign request 文件，验证 `zelto sign <id> --approve` 输出批准信息
2. 验收测试验证 `zelto sign <id> --reject` 输出拒绝信息
3. 验收测试验证 `zelto inbox --list` 列出待签请求
4. 验收测试验证 approve 后切片状态变更（completed）
5. 验收测试使用独立临时目录

## 不包含
- 其他切片的验收测试
- 修改任何源文件或已有测试
- gate 完整链条的集成（在 agent-execution 切片中覆盖）

## 风险
- 无
