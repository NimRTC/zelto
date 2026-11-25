# Slice: v2-tag-namespace

## 目的
治理 Git Tag 命名空间，消除 `v1/v2/v3` 这类裸版本 tag 与 0.7.x 计划版本的歧义：新规则为计划-版本二级 `plan-<semver>/v<n>`（如 `plan-0.7.1/v1`），存量裸 tag `v1/v2/v3` 重命名迁移到新命名空间并在 `scripts/tag-map.json` 保留旧名到新名映射，`v0.3.0` 等 semver tag 不动。`scripts/tag-namespace.mjs` 只做校验（列出非法 tag + 非零退出），不自动改 tag。

## 范围
要改的（这些是 agent 会去改的文件）：
- `scripts/tag-namespace.mjs`
- `scripts/tag-map.json`
- `docs/tag-namespace.md`
- `tests/acceptance/v2-tag-namespace/acceptance.test.cjs`

只读参考（**不得修改**，agent 只许读）：
- 只读 `package.json` —— 仅作版本参照，校验新 tag 中的 `<semver>` 是否与当前版本一致。

## 需求
无（本片没有关联的需求条目；验收口径由人于 2026-11-24 口述确认：命名规则=计划-版本二级，存量 v1/v2/v3 重命名迁移+保留映射，脚本只校验不自动改）。

## 验收标准
1. 命名规则文档化：`docs/tag-namespace.md` 存在且写明新规则为 `plan-<semver>/v<n>`（如 `plan-0.7.1/v1`），并说明 `v1/v2/v3` 裸 tag 为非法、须迁移；验证方式：打开该文档，确认规则示例与非法说明都在。
2. 存量映射完整：`scripts/tag-map.json` 包含 `v1/v2/v3` 三条旧名到新名的映射（如 `v1` → `plan-0.7.1/v1`），值为合法新命名空间 tag；验证方式：解析 JSON，断言三键都存在且值匹配 `^plan-\d+\.\d+\.\d+/v\d+$`。
3. 校验脚本可用：`node scripts/tag-namespace.mjs` 在存在非法 tag（如 `v1`）时列出非法 tag 且退出码非零，全部合法时退出码为 0；验证方式：沙箱造两个 tag 列表分别运行，断言退出码与输出。
4. semver tag 不受影响：`v0.3.0` 等 `^v\d+\.\d+\.\d+$` 视为合法，不在非法清单里；验证方式：校验脚本对该类 tag 不报错。
5. 不越界：改动只在写集内；验证方式：执行 `git status --porcelain`，改动路径全部落在写集四条内，`package.json` 无改动。

## 风险
- 存量 `v1/v2/v3` 若已被外部引用，重命名后旧引用失效。应对：只在文档与映射里声明新名，不删除远端旧 tag（删 tag 是人的手动动作），脚本只校验不自动改。
- 新 tag 中的 `<semver>` 与 `package.json` 版本可能漂移。应对：脚本区分"版本号不一致"与"命名非法"两种错误，输出可读信息。
- `scripts/tag-map.json` 格式若不统一会导致校验脚本解析失败。应对：固定为 `{ "<old>": "<new>" }` 扁平映射，脚本先校验 JSON 合法性。
