# Slice: sign-transitions

## 目的
Sign approve/reject 现在只改 lock file，不更新 slice 状态机。批准后 slice 应自动 transition 到 "completed"，拒绝后回到 "frozen"。

## 范围
- `src/core/slice/state.ts` — 补全 frozen → SIGN_APPROVE → completed 和 completed → SIGN_REJECT → frozen 两条路径（事件类型已存在）
- `src/core/gate/sign.ts` — 注入 SliceStore；approve() 后调用 store.transit(SIGN_APPROVE)，reject() 后调用 store.transit(SIGN_REJECT)
- `tests/sign-manager.test.ts` — 新增 3+ 测试覆盖状态变更

## 验收标准
1. `signManager.approve()` 后 slice 状态变为 "completed"
2. `signManager.reject()` 后 slice 状态变为 "abandoned"
3. 事件 `sign.approved` / `sign.rejected` 正确记录
4. 已有测试全部通过（204+）
5. 新增 3+ 测试覆盖 approve/reject 的状态变更

## 状态机变更
补全以下路径（事件类型已定义，但未在状态机中启用）：
```
frozen → SIGN_APPROVE → completed
completed → SIGN_REJECT → abandoned    (拒绝后废弃，不回到 frozen)
```

## 风险
- SignManager 当前不持有 SliceStore 引用，需注入
- 需避免循环 transition（approve + reject 交替时）
- 拒绝后 slice 进入 abandoned（不是 frozen），因为 reject 意味着不通过
