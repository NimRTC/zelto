# Slice: abandon-command

## 目的
添加 `zelto abandon <id>` 命令，将任意非 abandoned 状态的切片标记为废弃（abandoned）。同时发射 `slice.state.changed` 事件。

## 范围
- `src/cli/commands.ts` — 新增 `abandon` 命令处理器

## 验收标准
1. `zelto abandon <id>` 将切片 transition 到 abandoned
2. 对已 abandoned 的切片报错（"already abandoned"）
3. 对不存在的切片报错
4. 发射 `slice.state.changed` 事件记录状态变更
5. 已有测试全部通过（204+）
6. 新增 4+ 测试覆盖 abandon 的各种场景

## 设计

### 命令用法
```
zelto abandon <id>          # 标记切片为废弃
zelto abandon <id> --force  # 即使已 abandoned 也重新标记（但当前已禁止）
```

### 流程
1. 读取 slice，检查 state
2. 如果已经是 abandoned，报错退出
3. 调用 `store.transit(id, 'ABANDON')`
4. 输出确认信息
5. 发射事件

### 输出示例
```
zelto abandon test-003 — ✅ Slice abandoned
  Previous state: frozen
  Now: abandoned
```
