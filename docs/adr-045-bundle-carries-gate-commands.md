# ADR-045：约束包要带上门禁命令原文

- 状态：已接受
- 日期：2026-11-11
- 决策者：zelto（维护者）
- 影响范围：`src/core/sched/engine.ts`、`src/core/sched/types.ts`、`src/cli/commands/run-support.ts`、`src/cli/commands/core-slice.ts`、`src/cli/commands/parallel-executor.ts`

## 背景

agent 跑完 → 门禁② 在 agent 留下的现场上跑。这是 zelto 的设计：
门禁验的是「agent 的产物」，不是「工程的健康状况」。

但 zelto 只把**写集**、**保护域**、**策略规则**装进约束包（bundle），
**没有把门禁命令装进去**。于是 agent 只能靠猜：

- 猜用哪个构建系统、哪个生成器；
- 猜构建目录叫什么；
- 猜要跑哪些命令才算「验证过」。

## 现场

nimrtc-zelto 的 `v1-exception-handling` 切片（2026-11-11）：

1. agent 在 worktree 里用**默认生成器**（NMake Makefiles / Ninja）
   配置了 `build/`，并编译通过、测试全绿（18 个 gtest 用例通过）；
2. agent 退出，zelto 自动跑门禁②；
3. 门禁的 `configure` 步骤用 `config.yaml` 里写的
   `cmake -S . -B build -G "Visual Studio 17 2022" -A x64` 重新配置
   **同一个** `build/` 目录；
4. CMake 报错：

```
CMake Error: Error: generator platform: x64
Does not match the platform used previously:
Either remove the CMakeCache.txt file and CMakeFiles directory or choose a different binary directory.
```

5. 门禁判 failed。

## 为什么这是个真问题

**失败的报错指向「环境不对」，不指向「产物不对」。**

agent 的产物其实是对的 —— 门禁的 `build` 步骤（exit 0）和 `test` 步骤（exit 0）
都过了，只有 `configure` 因为生成器不匹配挂了。人看到的是「门禁没过」，
要重新跑一轮 agent 才能定位到真因；而 agent 重跑时**很可能再配一次**，
于是循环复现。

这不是 agent 的错：它拿到的指令里根本没有「门禁会用什么命令」这条信息。
**指令缺信息，不能指望 agent 猜对。**

## 决策

**把门禁命令原文装进约束包，并在 agent 指令里明确写出。**

具体做法：

1. `ConstraintBundle` 增加 `gateCommands?: GateCommandSummary[]`（ADR-045）；
2. `Scheduler.buildConstraints` 增加第三个参数 `gateCommands`；
3. CLI 在三处调用点（`zelto run`、`zelto start` 的 dry-run、并行执行器）
   通过 `gateCommandsForSlice(slice.writes)` 求出本片实际会跑的命令
   —— **与 `GateExecutor.selectCommands` 同一口径**：
   按切片类型查 `config.gate.profiles`，查不到用 `config.gate.commands`；
4. 指令里新增一节：

```
## How the gate will verify your work
The gate runs these commands, in this order, in this directory:

- `configure`: `cmake -S . -B build -G "Visual Studio 17 2022" -A x64 ...`
- `build`: `cmake --build build --config Debug --target test_net_feedback_test`
- `test`: `ctest --test-dir build -C Debug -R net_feedback --output-on-failure`

Use the **same** commands to verify your implementation. Do not reconfigure
the build tree with a different generator or a different binary directory —
the gate reuses the tree you leave behind, and a mismatched configuration
makes the gate fail for reasons that have nothing to do with your code.
```

### 为什么不直接让门禁「重新配置」

门禁**复用** agent 留下的构建树是刻意的：重头配置+全量构建要十分钟量级，
而增量构建只要几秒。让门禁清空重来，代价与收益完全不成比例。

而且「清空重来」会掩盖另一类问题：如果 agent 的产物让配置阶段就过不去
（比如新增的 CMakeLists 写错了），门禁应该**报出来**，而不是悄悄清掉现场。

所以修的是**信息不对称**，不是门禁的行为。

### 这不是判定

`gateCommands` 只是**事实陈述**（门禁会用哪套命令），不参与任何判定：

- 不影响准入（`admit`）；
- 不影响追溯判定；
- 不影响写集判定。

agent 仍然可以跑别的命令 —— 它只是**知道**门禁会用哪一套。
「知道」和「必须」是两回事，前者不构成约束。

## 后果

- **正面**：agent 用与门禁相同的命令验证自己的产物。门禁在 agent 留下的
  现场上跑，两边看到的是同一份配置。
- **正面**：门禁失败时，报错指向真因的概率显著上升 ——
  「configure 挂了」从此意味着「工程配置真的有问题」，而不是
  「agent 和门禁用了不同的生成器」。
- **代价**：约束包多了一个字段，指令多了十来行。
- **代价**：如果项目配置了多套 profile，指令里给的是**本片那一套**
  （按切片类型选），仍然是准确的。

## 关联

- ADR-033：门禁② 跑切片级验收测试
- ADR-034：验收测试骨架（`test.todo` 不算验证）
- ADR-044：隔离 worktree 必须初始化 git submodule
