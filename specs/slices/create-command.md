# Slice: create-command

## 目的
添加 `zelto create <id> [--title <title>]` 命令，通过 CLI 创建切片，替代手动写 JSON。

## 范围
- `src/cli/commands.ts` — 新增 `create` 命令
- 使用 `SliceStore.create()` + `SliceStore.write()` 写入 `.zelto/slices/<id>.json`

## 验收标准
1. `zelto create my-slice` 创建 `.zelto/slices/my-slice.json`，状态为 `draft`
2. 可选 `--title "..."` 参数；未提供时使用 ID 作为标题
3. 切片已存在时报错退出（不覆盖）
4. 自动触发 `spec.drafted` 事件
5. 输出清晰的成功信息
6. 全部 204+ 测试通过

## 风险
- 无。纯文件操作，使用已有的 SliceStore API。
