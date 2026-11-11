# ADR-046：验收骨架必须进写集

- 状态：已接受
- 日期：2026-11-11
- 决策者：zelto（维护者）
- 影响范围：`src/core/spec/skeleton.ts`、`src/cli/commands/slice-spec.ts`、`src/core/sched/engine.ts`

## 背景

zelto 有两件互相打架的事：

1. **ADR-034**：`zelto spec draft` 按规格里的验收标准生成验收测试骨架，
   骨架里每条用例是 `test.todo(...)` —— **占位**，不是断言。
2. **ADR-033 的 `verifyAcceptanceRanTests`**：门禁②解析验收测试的
   TAP 输出，如果一条用例都没真正跑过（`pass: 0`，全是 todo/skip），
   门禁判 failed，理由是「todo 与 skip 不算验证」。

第二条是故意的：它防止「骨架文件存在 → 门禁能找到目标 → 退出码 0 →
假绿」这条路。todo 不算验证。

于是就有了 ADR-034 自己注释里写的那句话：**「todo 必须被替换成实际断言，
不能留着当『已验证』」**。

## 现场

nimrtc-zelto 的 `v1-exception-handling` 切片（2026-11-11）：

1. `zelto spec draft` 生成了 `tests/acceptance/v1-exception-handling/acceptance.test.cjs`，
   4 条 `test.todo`；
2. 切片的**写集**是：

```
src/modules/net_feedback/CMakeLists.txt
src/modules/net_feedback/include/nimrtc/net_feedback/safety_check.hpp
src/modules/net_feedback/src/safety_check.cpp
src/modules/net_feedback/tests/CMakeLists.txt
src/modules/net_feedback/tests/test_safety_check.cpp
```

   —— **验收骨架不在里面**；
3. agent 在 worktree 里实现了全部功能，18 个 gtest 用例通过；
4. 门禁②跑验收测试 → 4 条 todo，`pass: 0` → 判 failed。

agent 做错了什么？**什么都没做错。** 它被明确告知
「You may only modify these paths」，而验收骨架不在其中。
运行时 hook 也会拦住它去改 —— 那是 hook 正常工作。

## 缺陷

**zelto 自己造了一个自己都不许改的东西。**

- 生成骨架的是 zelto；
- 要求把它改成真断言的也是 zelto（门禁②）；
- 但不许改的是 zelto（写集 + hook）。

三段合起来的效果是：**任何用 `zelto spec draft` 走完全流程的切片，
都必然过不了门禁②** —— 除非人手工 `zelto set --field writes` 把它加进去。

这不是 agent 的能力问题，是**契约自相矛盾**：写集少了一项，
而门禁要求那一项必须有实质内容。

## 决策

**生成验收骨架时，把它加进本片的写集。**

具体做法：

1. `skeleton.ts` 导出 `acceptanceSkeletonTarget(acceptanceDir, root)` ——
   求出骨架文件在仓库根下的相对路径（目录形态 → `<dir>/acceptance.test.cjs`；
   文件形态 → 那个文件本身）；
2. `zelto spec draft` 生成骨架后，把这个路径加进 `slice.writes`
   （已存在则不动 —— 写集是「人批准的边界」，这里只**补一个**）；
3. 约束包的指令里明确写出要求：

```
The acceptance file `tests/acceptance/v1-exception-handling/acceptance.test.cjs`
contains only `test.todo` placeholders.
**Replace every `test.todo` with a real assertion** that actually checks
the behaviour described in its name. The gate rejects an acceptance file
where no test really ran — todos and skips do not count as verification.
```

第 3 步是必要的：**「在写集里」不等于「会去改」**。
agent 完全可以写完实现、把骨架原样留着 —— 然后门禁②照样判 failed。
指令得说清楚。

## 后果

- **正面**：`zelto spec draft` 走完的切片，agent 能合法地（hook 不拦）
  也被明确要求地（指令说了）把 todo 改成断言。门禁②的「真跑过用例」
  要求第一次变得可达。
- **正面**：写集的语义更完整 —— 「agent 为这片要动的所有文件」，
  本来就该包含验收测试。
- **代价**：写集多一个文件，`zelto diff` / 写集预约的范围相应变大。
- **代价**：切片一旦冻结，写集就定了；骨架路径在冻结前就已确定
  （`slice.acceptance.dir` 在 `create` 时就定了），所以不会出现
  「冻结后才发现少一项」的情况。

### 不在本次范围内

- **不自动把 `test.todo` 变成断言**。断言是对实现行为的判断 ——
  只有 agent（看了实现）写得出来，或者人写得出来。zelto 只能保证
  「有地方写」。
- **不改门禁②的 `verifyAcceptanceRanTests`**。它是对的：todo 不算验证。

## 关联

- ADR-033：门禁② 跑切片级验收测试
- ADR-034：验收测试骨架（`test.todo` 不算验证）
- ADR-042：写集判定分层
- ADR-045：约束包要带上门禁命令原文
