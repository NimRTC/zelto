# Slice: event-types-complete

## 目的
补齐 EventType 联合类型，使其包含需求文档中定义的全部 29 种事件类型，确保类型定义与文档对齐。

## 范围
- `src/core/events/stream.ts` — EventType 联合类型中添加缺失的事件类型
- 不修改任何事件发射代码，仅类型定义

## 验收标准
1. EventType 包含全部 29 种事件类型
2. 现有测试全部通过，无需修改
3. 编译无错误

## 风险
- 极低风险：仅类型定义变更，不影响运行时行为
