# Slice: clarify-command

## 目的
添加 `zelto clarify <id>` 命令，让用户在切片 draft 阶段通过问答补齐 trace 信息（requirements、contracts、tests、writes、oracle），然后自动 transition 到 frozen。

## 范围
- `src/cli/commands.ts` — 新增 `clarify` 命令处理器
- `src/core/slice/store.ts` — 可能需暴露 `update()` 方法用于批量更新 slice 字段
- `.zelto/config.yaml` — 可选：添加 `clarify.autoFreeze` 配置（默认 true）

## 验收标准
1. `zelto clarify <id>` 对 draft/clarifying 状态的切片生成问题列表
2. 交互式问答：用户逐个回答问题，或全部使用默认值（--auto）
3. 回答后自动更新 slice 的 trace、writes、acceptance.oracleSrc 字段
4. 完成后自动 transition 到 frozen（`CLARIFY_CONVERGED` → `draft` → `FREEZE` → `frozen`）
5. 非交互模式 `--auto` 使用默认值自动回答全部问题
6. 对已 frozen/completed 的切片报错
7. 已有测试全部通过（85+）

## 设计

### 命令用法
```
zelto clarify <id>              # 交互式问答
zelto clarify <id> --auto        # 自动用默认值回答
zelto clarify <id> --dry-run     # 只显示问题，不应用
```

### 流程
1. 读取 slice，检查 state（必须是 draft 或 clarifying）
2. 调用 `ClarifyEngine.generateQuestions()` 生成问题
3. 如果 converged（无问题），直接提示并退出
4. 交互模式：逐题显示，等待用户输入（或回车使用默认值）
5. `--auto` 模式：自动使用 `q.default` 回答
6. 调用 `engine.applyAnswers()` 更新 slice 数据
7. 写回 slice 文件
8. 发射 `clarify.answer` 事件
9. 如果 `--auto` 或所有问题已回答：CLARIFY_CONVERGED → FREEZE

### 交互式问答 UI
```
zelto clarify test-003

Slice: test-003 (draft)

1/4: Which requirements does slice "test-003" trace to?
  Candidates: Feature spec document, ADR, User story, Bug report
  Default: Feature spec document
  > Feature spec document

2/4: Which contracts does "test-003" need to define?
  Candidates: Input/output schema, Hook I/O contract, Event envelope, None needed
  Default: Input/output schema
  > (回车使用默认)

✅ All questions answered. Freezing slice...
✅ Slice frozen at 2026-10-16T...
```

## 风险
- 交互式 readline 在非 TTY 环境需要回退到 `--auto` 模式
- 问题 ID 解析依赖命名约定（`<id>-<category>-<round>`），需保持稳定
