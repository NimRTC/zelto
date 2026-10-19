# Slice: admit-acceptance-tests

## 目的
为 `zelto admit` 命令添加验收测试，确保准入检查在真实文件系统环境下按规格工作。

## 范围
- `tests/acceptance/admit-command/admit.test.ts` — 验收测试文件
- 不修改任何 CLI 代码或核心逻辑

## 验收标准
1. frozen 切片调用 `zelto admit` 输出 "Admitted"
2. draft 切片调用 `zelto admit` 输出 "Blocked"
3. 写集冲突时输出冲突信息
4. 非重叠写集通过准入
5. `--json` 输出合法 JSON

## 风险
- 低风险：仅新增测试文件，不影响现有功能
