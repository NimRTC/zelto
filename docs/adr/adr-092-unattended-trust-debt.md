# ADR-092：无人值守可信度的三处债务 —— 断言覆盖、runs 口径、冻结边界

**状态**: 已实施
**日期**: 2026-11-19
**作者**: 系统架构
**关联约束**: C1, C3, C4, C5, C9
**关联文档**: `src/cli/commands/slice-spec.ts`, `src/core/spec/skeleton.ts`,
`src/core/slice/store.ts`, `src/cli/commands/run-finish.ts`,
`src/cli/commands/core-slice.ts`, `src/cli/commands/parallel-executor.ts`,
`src/cli/commands/supervisor.ts`, `src/cli/commands/question.ts`,
`src/core/lifecycle/freeze.ts`, `src/cli/commands/slice-detail.ts`,
`src/cli/commands/gate-sign.ts`, `contracts/schemas/slice.json`,
`contracts/schemas/slice-v2.json`
**关联 ADR**: ADR-034（骨架生成）、ADR-041（运行账本 / `runs`）、
ADR-045（门禁命令随包下发）、ADR-046（骨架落在写集里）、ADR-051（本片专属门禁命令）、
ADR-070（静默失败守卫）、ADR-074（活进程看门狗）、ADR-082（写后读回验证）

---

## 1. 摘要

「放手用」（无人值守并行开发）的可信度，全押在两句话上：

1. **门禁②的绿灯，等于真的通过**；
2. **北极星指标（无人值守完成率）能被 `runs` 这本账如实度量**。

连续三轮评审里躺着三处债务，各自从不同角度拆掉其中一句：

| # | 债务 | 拆掉的是 | 位置 |
|---|---|---|---|
| ① | 验收断言可被 `spec confirm` 静默覆盖（硬编码 `force: true`） | 第 1 句：绿灯的**含义**失真 | `slice-spec.ts:411` |
| ② | `runs` 记账口径前台 / 并行不一致 | 第 2 句：账本的**口径**不可比 | `parallel-executor.ts:661` vs `core-slice.ts:2148` |
| ③ | 冻结只冻规格，不冻 `writes` / `gateCommands` | 两者：被批准的**边界**可事后偷改 | `freeze.ts:196` + `slice-detail.ts:190` |

**决策**：

- **①** `spec confirm` 重建骨架时**不再无条件覆盖**。骨架已存在且含真断言 → 默认**保全**（不覆盖）；
  人显式 `--force` 才覆盖；切片处于 `frozen` 时要求先 `--refreeze`。
- **②** `runs` 口径统一为「**每次 agent 进程结束 = 一条**」，无论前台、并行、续跑、看门狗收走、
  后台监督进程。记录增加 `phase` 字段标明出处。前台原先「只在整轮结束记一条、中间重试不记」
  改为与并行一致。
- **③** 冻结时把 `writes` 与 `spec.gateCommands` 的**规范化摘要**一并写入冻结快照
  （`spec.boundaryHash`）。**终态**（`completed` / `abandoned`，即已签字）的切片不许用
  `zelto set` 改边界 —— 那才是「签字后脱钩」的真实危险点。`frozen` 下改边界是既有的
  越界恢复路径，允许，但重算摘要 + 留事件。`zelto check` / `show` 同时比边界摘要，
  漂移即刻可见。

---

## 2. 问题与判据

### 2.1 ① 验收断言被静默覆盖

`zelto spec confirm` 在写完正式规格后，会按新规格**重建**验收骨架：

```ts
const skeleton = writeAcceptanceSkeleton(slice.acceptance?.dir, draft, id, process.cwd(), {
  force: true,
});
```

`writeAcceptanceSkeleton` 在 `force` 为真时**无条件覆盖**目标文件 —— 于是：

1. 切片已 frozen，agent 把骨架里的 `test.todo` 换成了真断言；
2. 人（或任何流程）改一版规格草稿 → `zelto spec confirm <id>`；
3. 骨架被**整文件**写回「全 `test.todo`」，上轮的真断言**无声消失**；
4. 此时重跑门禁，若门禁的验收校验偶有缝隙，绿灯就亮在一个**从未断言过任何东西**的文件上。

`handleConfirm` 里也没有任何 frozen 状态检查 —— 冻结后依然可以重 confirm，把断言抹掉。

**为什么这是最要命的一条**：无人值守的最高假设就是「绿灯 = 真的通过」。
这条能被不经意的 `confirm` 抹掉，等于把整条信任链悬空。

### 2.2 ② runs 记账口径不一致

**并行**：`recordRun` 写在重试循环**内**，每次 agent 进程结束都记一条；
注释明说「记录的是跑过几次」。

**前台**：`recordRun` 写在重试循环**外**，只在整轮结束（含所有重试）后记一条**最终结论**；
中间失败尝试**根本不进 `runs`**。

结果：同一条切片，前台重试 3 次落 **1 条**，并行重试 3 次落 **3 条**。
北极星指标「无人值守完成率」的所有解释变量（单次成功率、平均尝试次数、重试次数）
在这两条路径上**口径不同 → 不可比 → 防退化约束的基线漂移**。

`runs` 本身只有 `{at, ok, exitCode}`，**没有任何字段说清「这是整轮结论，还是单次尝试」
「走的是哪条路径」**，事后无法还原口径。

### 2.3 ③ 冻结只冻规格不冻边界

`freezeSlice` 冻结时只写 `spec.frozenHash` / `spec.frozenAt`：

```ts
const specHash = hashSpecFile(specPath);
slice.spec.frozenHash = specHash ?? `sha256:${Date.now()}`;
```

哈希只覆盖 `specs/slices/<id>.md` 的内容。而 `writes` 和 `spec.gateCommands` 都不是
规格文件的子串 —— 它们是切片 JSON 里的字段。`zelto set` 对这两个字段**完全不看 `slice.state`**。

后果：

- **`writes` 被偷改**：写集守卫（C9）用运行时读出的 `slice.writes`，与冻结时的
  策略预检、D-4 覆盖校验**脱钩**。`zelto check` 的哈希对比（只看规格文件）**不会报警**。
- **`gateCommands` 被偷改**：门禁② 用 `slice.spec.gateCommands`。冻结后人把命令换成
  `echo ok` 之类，签字校验与判定边界脱钩 —— 绿灯仍亮，但验的已不是冻结时那套。
  事件流里记的是 `spec.drafted / action: 'slice.set'`，事后很难看出「冻结后门禁边界被改」。

---

## 3. 决策

### 3.1 ① confirm 不再静默覆盖已实现的验收断言

**判据**：骨架文件已存在，且**不是一个纯 todo 骨架**（即含真断言，或已被人/agent 编辑过）。

**行为**（`zelto spec confirm <id>`）：

| 情形 | 行为 |
|---|---|
| 骨架不存在 | 正常生成，输出中提及 |
| 骨架存在且为**纯 todo**（尚未被实现） | 覆盖重建（此时覆盖无损失），输出中提及 |
| 骨架存在且**含真断言**，未传 `--force` | **拒绝覆盖**，保留原文件，提示 `zelto spec skeleton <id> --force` 或 `zelto spec confirm <id> --force` |
| 骨架存在且含真断言，传了 `--force` | **覆盖**，输出中明确告警「已覆盖含真断言的验收骨架」，并留事件 |
| 切片处于 `frozen`，未传 `--refreeze`（或等价） | **拒绝** — 冻结后要改规格，先 `zelto freeze <id> --refreeze`，让整套校验重跑 |

**为什么用「纯 todo 形态」当判据**：这正是 `core/project/managed-acceptance.ts` 的
`isPureTodoSkeleton` 已经在用的判据（ADR-034 / ADR-046）。复用它，而不是另编一套
「含不含断言」的正则 —— 两套判据必然漂移。

**为什么默认保全，而不是默认覆盖**：ADR-075 §3.3 已经确立「zelto 不替人改断言」。
断言是人/agent 的劳动产物、是绿灯的含义。默认覆盖等于「悄悄改验证语义」——
这个方向必须先经人。

**为什么 frozen 要 `--refreeze`**：冻结意味着这套规格与边界已被人批准。改规格 = 改契约，
要走 `--refreeze` 重走追溯物化、策略预检、D-4 覆盖 —— 与 ADR-037 的先例一致。

### 3.2 ② runs 口径统一：「每次 agent 进程结束 = 一条」

**新口径（唯一口径）**：**agent 进程每结束一次，`runs` 追加一条**。
无论成功、失败、被提问挂起、越界回退、看门狗收走、续跑（`zelto answer`）。

**为什么选这个口径，而不是「每轮记一条」**：

- 北极星是「无人值守**完成率**」，它的解释变量是「跑了几次、几次成功、平均几次出活」。
  这些只有按「单次进程」记才能算 —— 按整轮记会把中间失败吞掉；
- 并行路径已是这个口径，且注释写得清楚 —— 改少的一边，风险最小；
- 看门狗收走那一轮、续跑、监督进程收尾，本来就都是「一次 agent 进程结束」。

**记录形态扩为**：

```ts
interface SliceRun {
  at: string;
  ok: boolean;
  exitCode: number | null;
  /** 这次运行出自哪条路径（ADR-092）。老记录缺省按 'foreground' 归一。 */
  phase?: 'foreground' | 'parallel' | 'resume' | 'watchdog' | 'supervisor';
  /** 在本轮（同一会话/重试族）里是第几次尝试，从 1 开始（可选，缺省 1）。 */
  attempt?: number;
}
```

`phase` / `attempt` 都是**可选**：老状态文件没有它们，`normalizeRuns` 按缺省补齐，
不伪造语义。新写入必须带上正确的值。

**调用点统一**（按 3.2 口径逐个对齐）：

| 调用点 | 现状 | 改为 |
|---|---|---|
| 前台单片（`core-slice.ts` 主循环） | 循环外记 **1 条**（最终结论） | **循环内每次进程结束记 1 条**，`attempt = 第几次`，phase 按是否经 watchdog |
| 前台单片（看门狗 `:370`） | 记 1 条 `{ok:false, exitCode:null}` + 标记 log | 记 1 条 `{ok:false, exitCode:null, phase:'watchdog'}`（保持既有语义） |
| 并行（`parallel-executor.ts:661`） | 循环内每次 1 条 | 补上 `phase:'parallel'` + `attempt` |
| 续跑（`question.ts:239`） | 记 1 条 | 补 `phase:'resume'` |
| 后台监督（`supervisor.ts → finishRun`） | 在 `finishRun` 内记 1 条 | 补 `phase:'supervisor'`（supervisor 手里只有最终 exitCode，不伪造中间尝试） |
| 前台单片走 `finishRun` | `alreadyRecorded: true`（外部已记） | 保留 `alreadyRecorded`，避免重复记账 |

> **关键不可破坏的性质**：**一次进程结束只能有一条记录**。
> 看门狗收走的那一轮在 watchdog 里记过，主循环**不再记第二次**（延用 `watchdogRecorded`）。
> 每个调用点只有一个「记账责任方」。

**指标口径的统一**：本文档只统一**记账口径**，不改指标实现。指标若要区分「整轮的成功」
与「单次尝试的成功」，可自行在 `phase + attempt` 上聚合。`runs` 不再携带「整轮结论」——
那是事件流里 `run.aborted` / `run.finished` 的事，账本只记单次进程事实。

### 3.3 ③ 冻结边界要包含 `writes` 与 `gateCommands`

**新增字段**（`SliceSpec`）：

```ts
interface SliceSpec {
  // ...
  /** 冻结时 writes + gateCommands 的规范化摘要（ADR-092）。 */
  boundaryHash: string | null;
}
```

**计算口径**（`core/lifecycle/freeze.ts` 落一份纯函数，C2/C3 合规）：

1. `writes` 排序 + 去重 + 统一正斜杠，join `\n`；
2. `gateCommands` 按**原顺序**取 `{name, run}`（顺序是语义 — ADR-045），
   每项拼 `<name>\u0000<run>`，项之间 `\n`；
3. 拼接结果：`writesPart + "\n--\n" + gatePart`，`hashContent()` 取摘要
   （与 `frozenHash` 同前缀 `sha256:`，避免真假哈希分叉，参见 ADR-075 §2）。

`gateCommands` 为空 vs 未设置，在摘要里**视为同一**（都等于用项目级命令）。
这是为了让「未曾设过本片专属命令」与「清掉本片专属命令」不产生假漂移。

**写入路径**：

- `freezeSlice` 在 §6 写 `spec.frozenHash` 的同时写 `spec.boundaryHash = computeBoundaryHash(slice)`。
- `REFREEZE` 时同时清空 `boundaryHash`（与 `frozenHash` 一致）。
- 老状态文件读出来缺 `boundaryHash` 时按 `null`，不伪造。

**防护路径**：

- **`zelto set`**：当切片是**终态**（`completed` / `abandoned`）且 `field ∈ {'writes', 'spec.gateCommands'}` 时
  **硬拒**。这是「签字之后偷改边界」的唯一真实危险点 —— 签字的凭据就是当时的边界，
  签字即 completed，所以终态改边界就是脱钩。
  - **`frozen` 下允许改边界**：越界退回 frozen 后**扩写集重跑**是既有的官方恢复路径
    （`tests/acceptance/write-set-recovery` 固化了它）。frozen 的切片尚未签字，此时改边界
    不造成「签字与边界脱钩」——门禁与签字都会重新基于改后的边界。改完**重算
    `boundaryHash`** 并写一条 `spec.checked`（`phase: 'set-boundary'`）事件留痕，不静默。
- **`zelto check` / `show`**：同时比 `boundaryHash`。
  边界漂移（比如有人手改 JSON 绕过 `set`）显示 `⚠️ boundary changed`，与规格 `⚠️ changed` 并列。
- **`zelto freeze --refreeze`** 依旧会重算整套校验与边界摘要。

> 初稿曾写「frozen 下一律硬拒 set 边界」，实施时被验收测试
> `write-set-recovery` 推翻：它固化的正是「越界退 frozen → set 扩写集 → 重跑」这条恢复路径。
> 该路径合理（frozen 未签字），硬拒会切断恢复。定案改为「终态硬拒 + frozen 允许但留痕」。

**为什么不把它并进 `frozenHash`**：`frozenHash` 的语义是「**规格文件**内容摘要」，
它的值要能被人拿去 `sha256` 一比就知道规格有没有被改。把边界混进去，这个语义就混了。
分开两个哈希：一个回答「规格改了没」，一个回答「门禁边界改了没」。

**frozen 切片的老数据**（没有 `boundaryHash`）怎么办？
`check` 遇到 `boundaryHash === null` 且 `state === 'frozen'` → 显示 `⬜ boundary not pinned`，
**不判 mismatch**，也**不强行补写**（那是 refreeze 的事）。这样老仓不会一升级就全线报警。

---

## 4. 约束合规检查

| 约束 | 检查 | 合规 |
|---|---|---|
| **C1** | 只改文件内容（`spec.boundaryHash`、`runs[*].phase/attempt`） | ✅ |
| **C2** | `core/lifecycle/freeze.ts` 新增的哈希函数只用 `node:crypto`（via `hashContent`），零第三方依赖，不 import `adapters/` | ✅ |
| **C3** | 边界哈希纯计算 / 读文件，不调模型、不触网 | ✅ |
| **C4** | `spec.frozen` 事件补 `boundaryHash`；`spec.confirmed` 事件带「骨架是否被覆盖」标记。都是 append-only | ✅ |
| **C5** | 保护域未动，策略锚点未动 | ✅ |
| **C9** | 写集预约不受影响；运行前写集仍来自 `resolveWriteSet`，但 **frozen 下的写集只能经 refreeze 修改** —— 这反而是对 C9 的更硬保护 | ✅ |

**禁区检查**：
- 未新增自动合并、自动批准、自动改规格；
- **未新增「自动改写验收断言」** —— 恰恰相反，把已有的隐式覆盖路径关掉；
- 未新增常驻 daemon；
- 未改 `tests/acceptance/**`。

**ADR 契约影响的迁移成本**：

- 老切片 JSON 的 `runs[*]` 缺 `phase/attempt` → `normalizeRuns` 兜底（不伪造）；
- 老切片 `spec.boundaryHash` 缺 → `null`；
- 无新增事件类型（仅扩字段）；
- 无新增命令。

---

## 5. 后果

**好的**

- ① **绿灯的含义重获锚定**：`confirm` 不再能无声抹掉真断言；要覆盖必须显式 `--force`，
  且 frozen 下必须先 `--refreeze`。
- ② **账本口径统一**：北极星指标的解释变量在前后台可比；单次成功率、平均尝试次数
  在任意一条路径下都能算出来。
- ③ **门禁边界成为冻结语义的一部分**：签字之后（终态）的边界不可再改，
  要改只能开新切片 —— 追责点清晰。

**代价与边界**

- `spec confirm` 的既有脚本若依赖「confirm 顺手重建骨架」的旧行为，会看到新的拒绝行为
  —— 迁移方式：显式加 `--force`（或先未 frozen）。
- `runs` 条数会变多（尤其是重试多的切片）—— 这是**如实**记录，不是冗余。
  指标侧要把「整轮」当派生统计量，不要再拿 `runs.length` 当「轮数」。
- 既有 `runs` 老记录缺 `phase` → 统计时按 `foreground` 兜底。**历史数据不回溯**，
  也不会因此报错 —— 口径从本 ADR 起统一。

**明确不做**

- 不自动把历史 `runs` 补成新口径；
- 不把 `runs` 改造成「轮次表」（那是另一个维度，事件流已有）；
- 不把边界摘要并进 `frozenHash`；
- 不在 `zelto set` 之外开新命令来改边界（refreeze 就是唯一合法路径）。

---

## 6. 验收标准

1. ✅ `zelto spec confirm` 在骨架含真断言且未 `--force` 时，**保留原文件**并报「未覆盖」，
   退出码非 0（与既有 `SKELETON` / `NO_CHANGE` 的失败语义一致）。
2. ✅ `zelto spec confirm` 在切片 `frozen` 且未 `--refreeze` 时拒绝。
3. ✅ `zelto spec confirm --force` 在骨架含真断言时覆盖，并写事件标记 `overwritten: true`。
4. ✅ 前台单片重试 3 次失败 → `runs.length === 3`（与并行一致），每条带 `phase`、`attempt`。
5. ✅ watchog 收走那一轮只记 1 条（不重复记），`phase === 'watchdog'`。
6. ✅ `zelto freeze` 之后：`slice.spec.boundaryHash` 是 `sha256:*` 且与推导值一致。
7. ✅ `zelto set <id> --field writes|spec.gateCommands` 在**终态**（completed / abandoned）下拒绝；
   在 `frozen` 下允许，且改后重算 `boundaryHash` + 写 `spec.checked`（`phase: 'set-boundary'`）。
8. ✅ `zelto freeze --refreeze` 后，`boundaryHash` 重建为新值。
9. ✅ 老切片（无 `boundaryHash`）在 `check` / `show` 下显示「未钉边界」，不误报。
10. ✅ `npm test` 全绿；`npm run lint` 通过。

---

## 7. 关联 ADR / 文档的状态更新

- **ADR-041**（运行账本 / `runs`）**扩写** —— 口径改为「每次进程一条」，新增 `phase`/`attempt`；
- **ADR-034 / ADR-046**（骨架生成 / 骨架进写集）**补充约束** —— 骨架被覆盖时不再无条件；
- **ADR-045 / ADR-051**（门禁命令）**补充约束** —— 本片专属命令纳入冻结边界摘要；
- **ADR-070**（静默失败守卫）**扩写** —— 「静默覆盖真断言」「静默改门禁边界」都属于静默失败族；
- **ADR-074**（看门狗）**补充** —— 收走那一轮的记录带上 `phase: 'watchdog'`；
- **ADR-082**（写后读回验证）**不变** —— `spec.frozen` / `spec.confirmed` 事件都在写后留有验证语义。
