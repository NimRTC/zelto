# Slice: v1-contracts-schemas

## 目的
在 `contracts/schemas/event-envelope.json` 中新增可选字段 `prevHash` 与 `hash`，为事件哈希链审计提供 Schema 承载能力，同时保持对历史存量事件的完全兼容（可选字段不破坏旧数据）。

## 范围
要改的（这些是 agent 会去改的文件）：
- `contracts/schemas/event-envelope.json`

只读参考（不得修改，agent 只许读）：
- 无

## 需求
无

## 验收标准
1. 在 `contracts/schemas/event-envelope.json` 的 `properties` 中新增 `prevHash` 与 `hash` 两个可选字段，且 `required` 数组不包含这两个字段；验证方式：读取该 schema 文件，检查 `properties` 中包含 `prevHash` 与 `hash`，并检查 `required` 中无二者。
2. 不带 `prevHash`/`hash` 字段的存量事件 envelope 仍通过该 schema 校验；验证方式：使用该 schema 校验一个仅含旧版必填字段的事件样例，校验结果应为通过。
3. 本切片变更仅涉及 `contracts/schemas/event-envelope.json`，未修改 `hook-io.json`，也未新增其他 schema 文件；验证方式：检查版本控制变更列表，确认改动文件集合仅包含该路径。

## 风险
- 当前无关联需求条目，`prevHash`/`hash` 的具体类型、长度与语义待需求补齐后确认；应对：先按设计上下文中的可选字段要求实现，需求补充后立即校准。
- 若在实现时误将新字段加入 `required`，会破坏历史存量事件的兼容性；应对：验收标准第 1、2 条显式校验 `required` 不含新字段，并以旧样例做回归校验。
- 变更范围可能意外扩散到其他 schema 文件；应对：依靠写集边界约束，验收标准第 3 条核对变更文件列表。
