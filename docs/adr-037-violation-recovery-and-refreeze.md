# ADR-037: 越界恢复路径 —— 切片退回 frozen + 规格重新冻结

**状态**: 已实施
**日期**: 2026-11-08
**作者**: 系统架构
**关联约束**: C1, C3, C4, C9
**关联文档**: `docs/adr-014-runtime-policy-enforcement.md`,
`docs/zelto-技术架构.md`（§5.2 状态机）

---

## 1. 摘要

在干净仓库里跑完整流程（`init → create → check → freeze → run → gate → sign → merge`）
时发现：**写集越界之后，切片会永久卡死**，人救不回来。

具体表现：

| 命令 | 越界后的行为 |
|---|---|
| `zelto run <id>` | `Cannot run: Slice is in state "running"` |
| `zelto merge <id>` | 不收它（没签字） |
| `zelto resume <id>` | `Slice "..." is not stalled` |
| `zelto next` | 报成 "Monitor execution" —— 它根本没在跑 |

唯一出路是 `zelto abandon` —— 整个切片作废，规格得重写。

也就是说：**越界一次，切片就废了**。而越界最常见的原因是**写集划窄了**
（agent 需要动一个没写进写集的文件），人扩一下写集就该能重跑。

顺着这条线还查出第二个死结：规格冻结之后人改了规格（比如扩写集），
`zelto check` 报 "hash mismatch"，`zelto freeze` 报 "cannot freeze" ——
两条命令互相堵死，同样救不回来。

本次定案并实施两条恢复路径：

- **越界退回 `frozen`**：越界时切片退回 `frozen`（可重跑），人扩写集后直接重跑；
- **`zelto freeze --refreeze`**：人确认新规格后重新冻结，重置哈希并重新物化追溯。

---

## 2. 为什么越界要退回 frozen 而不是别的

### 2.1 状态机里已经有这条退路

`src/core/slice/state.ts` 原本就有：

```
running --RUN_FINISH--> frozen
```

`RUN_FINISH` 的语义是「这一轮跑完了，回到可以再跑的状态」。越界之后
agent **确实跑完了**（进程退出了），只是这一轮**不算数**（门禁没跑、签字没发）。
所以 `RUN_FINISH` 正是语义正确的转换 —— 不必新增状态、不必新增转换。

### 2.2 为什么不能留在 running

留在 `running` 就是上面那张表 —— 四条路全堵死。zelto 的设计立场是
「出错时拉闸，把人交还控制权」，而不是「让人只能从头再来」。
退回 frozen 才是**交还控制权**的形态：人决定是扩写集重跑，还是放弃。

### 2.3 为什么不是自动重试

自动重试的前提是「同样的输入会得到不同的结果」。越界不是 agent 的错，
是边界划错了 —— 重试还是越界。所以**不自动重试**，也不自动放宽写集
（放宽写集是人的决定，agent 自己放宽等于自己批准自己）。

### 2.4 为什么不是 abandoned

`abandoned` 是终态（状态机里 `abandoned: {}`，没有任何出边）。用它等于判死刑。
越界是可恢复的，不该用它。

---

## 3. 为什么需要 --refreeze

规格冻结之后，人改规格是**正常业务动作**，最常见的两种：

1. 扩写集（越界之后）；
2. 改验收标准（agent 干完之后发现规格写得不够准）。

冻结的意义是「这一版的规格是确定的，agent 拿到的是同一份东西」，
不是「规格从此不能改」。改了就重新冻结一次 —— 哈希重置、追溯重新物化、
门禁①重新过一遍。人确认新规格这个动作由 `--refreeze` 显式表达。

### 3.1 状态机新增 REFREEZE 转换

```
frozen --REFREEZE--> draft
```

回到 `draft` 而不是直接回 `frozen`：中间要重新过门禁①（追溯判定）
并重新物化追溯 —— 规格改了，「需求条目」也可能跟着变，
旧规格物化出来的追溯对新规格不一定成立。

### 3.2 只有 frozen 能重新冻结

`running` / `completed` / `abandoned` 的规格同样可能被人改，但那些状态里
可能已经有 agent 的产物、或者已经合进主干了 —— 改规格的语义完全不同
（那属于 `panoramic-project` 说的「需要重新规划」），不在本 ADR 范围内。
所以 `--refreeze` 只接受 `frozen`，其余状态明确报错。

---

## 4. 影响面

| 文件 | 变更 |
|---|---|
| `src/core/slice/state.ts` | 新增 `REFREEZE` 事件与 `frozen → draft` 转换（**契约变更**） |
| `src/cli/commands/run-support.ts` | 新增 `handleWriteSetViolation`（退回 frozen + 写事件） |
| `src/cli/commands/runtime-guard.ts` | 越界时调用 `handleWriteSetViolation` |
| `src/cli/commands/core-slice.ts` | `freeze` 支持 `--refreeze`；越界提示改为「已退回 frozen」 |
| `src/cli/commands/parallel-executor.ts` | 去掉重复的 `run.aborted` 事件（append-only 流里重复条目会误导） |

事件类型没有新增 —— `run.aborted` 已在契约里（`src/core/events/stream.ts`），
`slice.state.changed` 也在。所以这次唯一的契约变更是状态机的 `REFREEZE`。

---

## 5. 不变量自查

| 约束 | 是否破 | 说明 |
|---|---|---|
| C1 状态只在文件里 | 否 | 退回 frozen 仍是写切片文件；预约与事件仍在 `.zelto/` |
| C3 判定确定性 | 否 | 越界判定与追溯物化都是纯计算，没调模型、没触网 |
| C4 append-only 事件 | 否 | `run.aborted` 是追加；顺带去掉了并行执行器里的重复写入 |
| C9 写集运行时强制 | 否 | **判定逻辑一字未改** —— 越界照样拦、照样不进 gate、照样不发签字请求 |
| 签字不自动合并 | 否 | 本次没有碰签字与合并的语义 |

C9 值得单独说一句：本次改的是**越界之后怎么恢复**，不是**越界要不要拦**。
拦的行为（PreToolUse 逐写判定、运行后审计兜底、缺预约 fail closed）完全没动，
有 `tests/hook/pretool.test.ts` 与 `tests/write-set-parity.test.ts` 守着。

---

## 6. 回归测试

| 测试 | 守住什么 |
|---|---|
| `tests/acceptance/write-set-recovery.test.ts` | 越界后退回 frozen、可重跑、事件留痕、扩写集后走完门禁 |
| `tests/acceptance/refreeze.test.ts` | 漂移可见、`freeze` 提示 `--refreeze`、重置哈希、追溯重新物化 |

两条都是跑真实 CLI 进程（`dist/cli/index.js`）的验收测试 —— 单元测试测不到
「人看到什么、能不能救回来」。
