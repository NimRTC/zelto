# `zelto why` 用户指南

## 用途

`zelto why <path|[slice-id]>` 解释“这个路径能不能写、为什么”：
把策略判定结论、命中的规则依据、归属切片与预约写集、修复建议一次说清。
只读命令，不写任何状态、不追加事件，适合在动手前先问一句。

## 输出说明

路径模式输出六行：

- 结论：`allow` / `deny` / `ask`（默认 `operation=write`，agent 上下文）。
- 规则：命中的 `ruleId` + `basis`（如 `allow-src-ts` + 规则依据文本）。
- 依据：规则自带的 `guidance`（与修复建议不同时才单列）。
- 保护域 / 托管规格：是否为保护域、是否为 zelto 托管的规格文件。
- 归属：哪些切片的写集覆盖该路径（生效预约优先，切片写集兜底）。
- 建议：下一步做什么（加 allow 规则、确认归属切片、改路径等）。

切片模式（`zelto why <slice-id>`）输出切片状态、写集、预约、规格冻结情况。
`--json` 供 web 与脚本消费，字段与文本输出一一对应
（`decision/ruleId/basis/owners/suggestion`）。

## 示例

```sh
# 默认看写判定：策略放行 + 归属切片 + 建议
zelto why src/foo.ts

# 读操作换个口径
zelto why src/foo.ts --operation read

# 保护域：agent 上下文 deny（人可直接改）
zelto why policy/policy.yaml

# 托管规格文件：提交时刻放行
zelto why specs/slices/new.md

# 切片模式 + JSON（给脚本消费）
zelto why v3-why-command --json
```

未知 id 或无参数时不崩溃：给一句引导（如“没有该切片，按路径解释”或用法），退出码 0。
