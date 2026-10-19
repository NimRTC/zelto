# Slice: cli-summary-audit

## 目的
增强 `zelto summary` 命令，集成 AuditTrail 和 MetricsCollector，提供更丰富的项目概况。

## 范围
- `src/cli/commands.ts` — summary 命令集成审计和度量信息

## 验收标准
1. summary 输出包含每个切片的最新事件摘要
2. summary 输出包含整体 rework rate
3. summary 输出包含 cycle time 统计
4. summary 输出包含 stall 统计
5. 切片数为零时优雅降级（不崩溃）
6. 现有测试全部通过

## 风险
- 低风险：只读增强，不修改数据
