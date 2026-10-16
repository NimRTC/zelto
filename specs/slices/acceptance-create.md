# Slice: acceptance-create

## 目的
为已完成的 `create-command` 切片编写端到端验收测试，验证 `zelto create` 命令在临时目录中的完整行为。
验收测试放在 `tests/acceptance/create-command/` 目录下。

## 范围
- `tests/acceptance/create-command/` — 新建验收测试脚本

## 验收标准
1. 验收测试 spawn `zelto create my-slice`，验证 `.zelto/slices/my-slice.json` 被创建，状态为 `draft`
2. 验收测试验证 `zelto create` 带 `--title` 参数时使用自定义标题
3. 验收测试验证 `zelto create` 不提供 `--title` 时使用 ID 作为标题
4. 验收测试验证重复创建已存在的切片时报错
5. 验收测试验证 `zelto create` 输出清晰的成功信息（含 ID、Title、State、Next）
6. 验收测试使用 `node --test` 运行
7. 验收测试使用独立临时目录

## 不包含
- 其他切片的验收测试
- 修改任何源文件或已有测试

## 风险
- 验收测试需要 `dist/cli/index.js` 已编译
- 切片 JSON 内容结构可能随 SliceStore.create() 变化
