# ADR-041: 配置块标量解析 + 切片记账回写（`runs` / `baseCommit` / 终态清账）

**状态**: 已实施
**日期**: 2026-11-10
**作者**: 系统架构
**关联约束**: C1, C3, C4, C5, C7
**关联文档**: `docs/adr-038-takeover-gates.md`, `docs/adr-039-takeover-followups.md`,
`docs/adr-040-policy-legacy-migration.md`,
`src/cli/commands/config-blocks.ts`, `src/cli/commands/shared.ts`,
`src/core/slice/store.ts`

---

## 1. 摘要

把 zelto 接在真实项目（nimrtc-zelto）上跑门禁时，暴露出两个互不相干、
但同样属于「**记账与解析没对上现实**」的问题：

| # | 缺口 | 症状 | 本次处置 |
|---|---|---|---|
| 1 | **配置里的块标量被吞成字面量** | `run: >` 被读成命令 `">"`。门禁执行 `>` 立即失败，报错却指向 cmake 配置失败，与真正原因（配置解析）完全无关 | 配置解析支持 YAML 块标量（`>` / `\|`） |
| 2 | **切片的三处记账没回写** | `runs` 永远是空数组、`baseCommit` 全为 `null`、切片的终态还留着 stall 分类 | 运行/门禁/签字时把事实写回切片状态 |
| 3 | **澄清轮次读的是那个死字段**（§3.1.3，随 2 一并暴露） | 轮次号是从 `runs.length` 推的 —— 而 `runs` 永远空。人澄清三轮，zelto 还在问第一轮的问题，两轮澄清撞同一个问题 ID | 澄清轮次另立 `clarifyRounds` 字段 |

两处是同一件事的两个面：**zelto 记下来的东西，必须和实际发生的事一致**。
块标量是「读进来的东西和文件里写的不一致」；三处记账是「记下来的和实际发生的不一致」。

### 1.1 契约变更

这次动了切片状态文件的结构，契约（`contracts/schemas/slice.json`、
`slice-v2.json`）同步更新：

| 字段 | 变更前 | 变更后 |
|---|---|---|
| `runs` | `array<string>`（从未被写入过） | `array<{ at, ok, exitCode }>` |
| `clarifyRounds` | 无 | `integer`（单调递增的澄清轮次） |

老状态文件不需要迁移：`runs` 此前永远是空数组，`clarifyRounds` 缺失时读出来按 0 算
（`SliceStore.read` 统一归一化，不在各处散着做兜底）。

---

## 2. 问题一：块标量被吞

### 2.1 现象

nimrtc-zelto 的 `.zelto/config.yaml` 是这样写的（YAML 的惯用写法）：

```yaml
gate:
  commands:
    - name: configure
      run: >
        cmake -S . -B build -G "Visual Studio 17 2022" -A x64
        -DNIMRTC_BUILD_TESTS=ON
```

zelto 的解析器是逐行的，只认 `run: <一行>`。于是 `run: >` 被读成字面量 `">"`，
后面几行内容**原样留在文件里没人看**。门禁拿到的命令就是 `>`：

```
configure  exit 1  stderr: 命令语法不正确
```

人看到的是「cmake 配置失败」，实际上是**配置解析把整条命令吞掉了**。

### 2.2 为什么这个 bug 特别难查

三条原因叠在一起：

1. **失败点在下游，报错在上游**。真正出错的地方（解析）没有报错，
   报错发生在几层之后的执行器。
2. **报错内容误导**。执行器报的是 `>` 的语法错误，但人只会去查 cmake。
3. **修复前的那次改动掩盖了它**。ADR-040 修好了策略侧（根级构建清单规则），
   门禁却仍然红 —— 红的原因不在策略，在配置解析。
   **一个 bug 被另一个 bug 挡住时，修好上层不会让下层显形。**

### 2.3 决策

**支持块标量，但只支持块标量 —— 不引入完整 YAML 解析器。**

引入完整 YAML 库要付出：第三方依赖（`core/` 零依赖的约束虽然只约束 `core/`，
但 CLI 侧引入 YAML 库会让 `policy/policy.yaml` 的解析也面临两套解析器）、
以及行为差异（YAML 的类型推断、锚点、流式结构……）。

实际需要的只有两件事：

- `>` 折叠：多行折成一行 —— shell 命令用这个；
- `|` 字面：多行保留 —— 多行文本用这个。

所以实现是一个**局部的块标量读取器**（`src/cli/commands/config-blocks.ts`），
边界写清楚：

| 边界 | 判定 | 理由 |
|---|---|---|
| 块的结束 | 第一个缩进 **≤ 所属键缩进** 的非空行 | YAML 规则 |
| 块的基准缩进 | 第一行非空内容的缩进 | 公共前缀 |
| 块内的 `#` | **是内容，不是注释** | YAML 语义如此 |
| 块内空行 | 保留（折叠时折成换行） | YAML 语义如此 |
| 值的末尾空白 | 去掉 | 配置里的值是「一条命令 / 一段文本」，末尾换行留着会让门禁比对命令时对不上 |

**折叠后必须不含换行** —— 这是硬要求。门禁把命令交给 shell 执行，
值里带换行就意味着「一条命令」变成了「多条命令」，执行语义完全不同。

### 2.4 游标必须能推进

原解析器是 `for (const line of lines)` —— **拿不到下标**，就没法「吃掉若干行」。
改成索引式循环：

```js
for (let i = 0; i < lines.length; i++) {
  const line = lines[i];
  ...
  i = block.nextIndex - 1;   // 块已消费，下一轮 for 的 i++ 落到下一行
}
```

块消费之后，游标必须精确落在块之后的**下一行**。落早了会重复处理块尾那行
（可能被当成新的键），落晚了会漏掉一行。

这一处是本次实现里最容易出错的地方，所以有专门的用例覆盖
（「块之后的同层键照常解析」）。

### 2.5 覆盖范围

块标量在四个位置都可能出现，都支持：

| 位置 | 键 | 用途 |
|---|---|---|
| `gate.commands[]` | `run` | 门禁命令 |
| `gate.acceptance` | `command` | 切片级验收命令 |
| `agent` | `command` | agent 启动命令 |
| `targetProject.gate.commands[]` | `run` | 目标项目的门禁命令 |

---

## 3. 问题二：三处记账没回写

在 nimrtc-zelto 上跑完一整轮切片后，`.zelto/slices/*.json` 里三处字段
和实际发生的事对不上：

### 3.1 `runs` 是死字段

`SliceData.runs` 在类型里存在、在状态文件里落盘，但**从来没有被写入过**
（全仓库没有任何 `runs.push`）。它的唯一读者是澄清轮次计算：

```js
const round = (current.runs?.length ?? 0) + 1;
```

于是澄清轮次永远是第 1 轮 —— 人澄清了三轮，zelto 仍然以为是第一轮。

**为什么它是问题**：`runs` 记的是「这片跑过几次」。agent 每次运行都会发
`run.started` / `run.finished` 事件（C4），但事件流是**事件流**，切片状态是
**切片状态** —— 两套账本。同一个事实记在两处，其中一处永远是空的，
人查切片状态时得到的是假信息。

**处置**：每次运行结束（无论成功失败）往 `runs` 里追加一条运行记录。

#### 3.1.1 运行记录长什么样

```typescript
interface SliceRun {
  at: string;            // 运行结束时刻（ISO 8601）
  ok: boolean;           // agent 进程是否正常退出（退出码 0）
  exitCode: number | null; // 被信号打断时为 null
}
```

**「一次运行」的边界 = agent 进程结束一次**。成功、失败、被提问挂起、
越界回退 —— 都算一次运行。门禁、签字、合并**不算**运行：它们不是 agent 的执行。

`ok` 只表达 agent 进程自己的退出结果。越界（写集违规）**不翻转**这个标志 ——
越界是另一次判定的事实，记在 `run.aborted` 事件里；在运行记录里再表达一遍
只会让人把两件事混起来（「跑成功了但越界」到底算什么？答案：agent 跑成功了，
越界另有其事）。

#### 3.1.2 记在哪几个点

| 位置 | 记什么 |
|---|---|
| `zelto run <id>` 前台跑 | agent 进程退出后记一次（重试算多次） |
| `zelto start <id>` 自带的运行 | 同上 |
| `zelto run --detach` 后台监视器 | 后台进程退出后记一次 |
| `zelto run --parallel` / `zelto version start` | 每片各记一次（重试各记一次） |
| `zelto answer <id>` 续跑 | 续跑是一次新的 agent 运行，记一次 |

#### 3.1.3 澄清轮次不能再读 `runs`

澄清轮次号会进澄清问题 ID（`<slice>-<category>-<round>`）——
轮次不单调递增，两轮澄清会撞同一个问题 ID，把上一轮的答案张冠李戴。

所以澄清轮次另立一个字段 `clarifyRounds`（单调递增，每次澄清 +1），
不再从 `runs.length` 推。`runs` 记「跑过几次」，`clarifyRounds` 记「澄清过几轮」，
两件事各记各的 —— **用同一个字段记两件事，迟早会算出错的数**。

### 3.2 `baseCommit` 全为 null

`baseCommit` 是切片的**基点 commit** —— 建 worktree 分支时的主干位置。
它的读者是合并守卫：

```js
export function isStaleBase(baseCommit: string | null, repoRoot: string): boolean
```

`baseCommit` 为 null 时，`isStaleBase` 直接返回 false —— **判据形同虚设**，
「基点漂移就拦合并」这条保护从来没生效过。

而 worktree 管理器其实**知道**基点：`ensureWorktree` 返回
`WorktreeInfo.baseCommit`，只是没人把它写回切片状态。

**处置**：建 worktree 时把基点写进切片状态（`baseCommit` 从此不再是 null）。

落点在 `ensureWorktree`（`src/cli/commands/shared.ts`）：worktree 建好后，
若切片状态里还没有基点，就把 `info.baseCommit` 写进去；**已经有基点的不覆盖** ——
基点是「这片从哪儿长出来的」，主干后来往前走不该改写它（改了，合并守卫就会
拿新位置当基点，漂移判据又形同虚设）。

### 3.3 终态还留着 stall 分类

nimrtc-zelto 上 `v1-net-feedback-core` 门禁通过、切片转 `completed`，
但状态文件里 `stall.class` 仍是 `"gate_retry"`。

**为什么它是问题**：stall 的语义是「这片现在卡住了，需要人介入」。
一片已经 `completed` 的切片带着 stall 分类，人看状态就得出错误结论
（「它卡着」），而它其实早就通了 —— 中间还隔了 `gateRetries: 1` 这个数字，
更让人以为「还有 1 次重试没跑」。

**处置**：切片进入终态（`completed` / `abandoned`）时清掉 stall 分类。

落点在 `SliceStore.transit` —— **状态机出来的每一次转换**都过这一道。
不放在「门禁通过」这一处，是因为终态有两条路（门禁通过、签字批准），
外加 `abandon`；放在调用点上迟早会漏一条。转换到非终态时不动停机分类
（还在跑就还可能卡着）。

**老切片怎么办**：清账规则落地之前写的状态文件里，终态切片本来就带着停机分类
（nimrtc-zelto 的 `v1-net-feedback-core` 就是原样）。这些文件不会自己好转，
所以 `SliceStore.read` 在读到「终态 + 带停机分类」时顺手归正并写回 ——
人查状态既看返回值也直接看文件，两边都得是对的。写失败不阻断读
（只读目录、权限不足等场景下，内存里的值已经是正的）。

### 3.4 一起处置的理由

三处都是同一句话：**「zelto 记下来的东西，必须和实际发生的事一致」**。

分开做要改三处代码、测三处；合在一起做有一个共同的落点：
**切片状态是唯一真源的那一处 —— 从状态机里出来的每一次转换，
都要把对应的事实写回状态文件。**

（澄清轮次是第 1 处的连带修正：`runs` 一旦有了真实含义，
「拿它当澄清轮次」就不再成立 —— 那是两件事。）

---

## 4. 不变式核对

| 约束 | 核对 | 合规 |
|---|---|---|
| **C1** 状态只在文件里 | 块标量解析是纯函数（无新增状态）；`runs` / `baseCommit` / `clarifyRounds` / `stall` 全部写进 `.zelto/slices/<id>.json`。未新增内存状态或常驻进程 | ✅ |
| **C2** `core/` 零第三方依赖 | 新增 `cli/commands/config-blocks.ts` 只用 Node 内置字符串操作；`core/slice/store.ts` 的改动只用 Node 内置；未新增任何 npm 依赖 | ✅ |
| **C3** 判定必须确定性 | 块边界、基准缩进、折叠/字面展开全是字符串与缩进比较，不调模型、不触网；记账落点只读文件、纯计算 | ✅ |
| **C4** append-only 事件流 | 事件流机制未动；本次是**把事实补写进切片状态文件**（状态本来就有这些字段，只是没填），不是往事件流里塞新东西 | ✅ |
| **C5** 保护域与锚点外部化 | 块标量解析只读 `.zelto/config.yaml`，不写它；策略锚点机制未动 | ✅ |
| **C7** llm 只产草稿 | 全程无模型参与 | ✅ |

禁区检查：未新增自动批准、自动合并、自动改规格、自动改锚点。

---

## 5. 验证方式

### 5.1 单元测试

新增 `tests/config-block-scalar.test.ts`（12 个用例）：

- 折叠标量折成一条单行命令（含 CMake 多行参数的实例）；
- 折叠后不含换行（可交给 shell 执行）；
- `>-` 与 `>` 结果一致；
- 块内的 `#` 是内容不是注释；
- 块之后的同层键照常解析（**游标推进正确性**）；
- 字面标量 `|` 保留换行、`|-` 去掉末尾换行；
- `acceptance.command` / `agent.command` / `targetProject.gate` 三处也支持；
- 单行写法回归：`run: "..."` 照常剥引号；不以 `>`/`|` 开头的值不被误判。

### 5.2 记账回写的单元测试

新增 `tests/slice-ledger.test.ts`（8 个用例）：

- `recordRun` 追加一条运行记录（时间戳 + `ok` + 退出码）；
- 失败（退出码 1）与被信号打断（`exitCode: null`）各记一条；
- 老状态文件（`runs` 是字符串数组、没有 `clarifyRounds`）读出来是空值而不是崩；
- 澄清轮次单调递增（1 → 2 → 3）；
- 转 `completed` / `abandoned` 时清掉 `stall.class`；
- 转非终态时**不动**停机分类；
- 老状态文件里终态带着停机分类 → 读的时候自愈（返回值与文件都归正）。

新增 `tests/slice-base-commit.test.ts`（2 个用例，跑真实 git 仓库）：

- 建完 worktree 后 `baseCommit` 不再是 null，且等于建 worktree 时的主干位置；
- 已有 `baseCommit` 时不被覆盖（主干往前走一步也不改写基点）。

### 5.3 真实项目复验（nimrtc-zelto）

改完解析器后重跑同一条门禁：

```
zelto gate v1-net-feedback-core
  ✔ configure (30674ms, exit 0)      ← 之前是 exit 1（命令是 ">"）
  ✔ build     (2741ms,  exit 0)
  ✔ test      (1548ms,  exit 0)
  Result: ✔ Gate passed (34969ms)
```

`configure` 从「秒失败」变成「真跑了 30 秒并通过」—— 这就是修复的直接证据。
随后 `zelto sign --approve` + `zelto merge` 走通，切片产物进了主干。

### 5.4 全量回归

`npm test`：1510 项全部通过（`npm test` 会先 build，验收测试跑的是新二进制）。
`biome check src/ tests/` 干净。

---

## 6. 遗留（需人拍板）

**块标量要不要支持更完整的 YAML 子集**（引号转义、多行流式标量 `|` 带缩进指示符、
锚点与别名）。当前实现刻意只做块标量，因为需求只到块标量为止；
真要扩，就该引入 YAML 库并同时统一 `policy.yaml` 的解析 —— 那是另一次决策。

**`runs` 记什么粒度**。现在记的是「运行了几次 + 什么时候 + 成没成」。
要不要把成本（ADR-035 已有的 `budget.spent`）与门禁结果也并进 `runs`，
让「一次运行」在切片状态里就是一个完整条目 —— 也是另一次决策。

**`clarifyRounds` 该不该进事件流**。现在轮次只落在切片状态文件里，
事件流里只有 `clarify.question` / `clarify.answer`（按问题记，不按轮次记）。
若要「轮次」本身也可追溯，得再定一个事件类型 —— 属于契约变更，另一次决策。
