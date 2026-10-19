# Slice: budget-port

## 目的
实现 BudgetPort 接口，提供基于文件的预算跟踪能力。

## 范围
- `src/core/budget/` — 新目录
  - `src/core/budget/collector.ts` — BudgetCollector 实现
  - `src/core/budget/index.ts` — 导出
- `src/core/ports/index.ts` — 不修改（接口已定义）

## 验收标准
1. `getSpent(sliceId)` 从事件流统计 `llm.called` 和 `budget.spent` 事件的 cost 总和
2. `getLimit(sliceId)` 从 `.zelto/config.yaml` 读取预算上限，有默认值
3. `isExhausted(sliceId)` 正确判断是否超限
4. 无事件的新切片返回 0
5. 所有操作不依赖外部包（只用 Node 内置）

## 风险
- 低风险：新模块，不修改现有代码
