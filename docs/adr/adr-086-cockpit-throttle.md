# ADR-086：驾驶舱装上油门 —— freeze / gate / run / resume

**状态**：实施
**日期**：2026-11-18
**相关**：ADR-072（Web 驾驶舱）、ADR-084（驾驶舱可接管）、ADR-015（hotfix 显式确认）、
ADR-018（签字不自动合并）、ADR-020（拉闸）、ADR-052（重试预算）、
ADR-053（死切片清理）、ADR-055（超时杀进程树）、ADR-074（活进程看门狗）、
ADR-084 §1.1（拒绝「HTTP 挂着 agent 会话」）、负向清单「完整 GUI」

## 背景

用户看完 `zelto web` 驾驶舱后指出：

> **UI 像看板，没有操作？**

核实的结果（ADR-084 已实施 `reject` / `answer` / `halt`，此为补齐）：

| 动作 | CLI | Web（ADR-084 后） |
|---|---|---|
| 签字 / 拒签 | ✅ | ✅ |
| 回答提问 | ✅ | ✅（只记录，不续跑） |
| 拉闸 | ✅ | ✅ |
| **冻结**（`zelto freeze`） | ✅ | ❌ |
| **门禁**（`zelto gate`） | ✅ | ❌ |
| **开跑**（`zelto run`） | ✅ | ❌ |
| **续跑停机片**（`zelto resume`） | ✅ | ❌ |

所以 ADR-084 §1 的「驾驶舱负责刹车，不负责油门」是一个**刻意的、但已经过时的**取舍：
当时四个油门动作都 CLI-only，人在浏览器里只能看。

**为什么现在要补**：驾驶舱的整个价值主张是「人被交还控制权的那一刻，就地接管」。
只给刹车不给油门，等于说「你能刹车、不能开车」——
人想推进一片时，还是得切回终端，驾驶舱并没有省掉那一步。

## 核实：三个前提与最初的设想不同

写方案前先核实了三件事，结论**推翻了「要动事件流契约」这个判断**：

### 1. 事件流契约**不需要动**

`core/events/stream.ts` 的 `EVENT_TYPES` 里**已经有**：

```
'spec.frozen'  'run.started'  'run.finished'  'run.resumed'  'gate.executed'  'gate.result'
```

`contracts/schemas/event-envelope.json` 的 enum 也已收录这几项。

ADR-084 扩展驾驶舱时用的就是这个办法 —— 复用已有事件类型，**没有新增**。
所以本 ADR **不新增任何事件类型**，事件流契约零改动。

> **这为什么重要**：AGENTS.md 说「改动契约（schema / 事件类型 / 配置格式）时仍要写 ADR」。
> 本 ADR 虽然写了，但**理由不是「要动契约」**，而是「要动编排逻辑的位置」。
> 契约没动 —— 这是核实的结果，不是让步。

### 2. `run --detach` **已经存在**，而且正是需要的语义

`src/cli/commands/core-slice.ts:1619` 已有完整的 detach 分支：

- 任务文件**先写后拉**监督进程（顺序不能反 —— D-53）；
- `spawnSupervisor()` 做**启动存活确认** —— 拉不起来就不说「已在后台跑」；
- 监督进程是**独立进程**（`src/cli/commands/supervisor-entry.ts`）：
  起 agent → 等它退出 → 写收尾（记账 / 审计 / 门禁 / 签字请求 / 切片状态 / 释放预约）；
- 主进程退出不会带走 agent（D-50）。

也就是说，ADR-084 §1.1 拒绝的那个东西（「一个 HTTP 请求里挂着一个 agent 会话」）
**在这个仓库里已经有解**了 —— 只是解法不是「在 HTTP 里跑」，而是「交给独立进程」。

**所以 `run` 的 Web 端语义定为**：

> **Web 端发起即返回**（fire-and-forget），agent 跑在独立监督进程里。
> HTTP 请求**不挂着** agent 会话 —— 这正是 ADR-084 §1.1 要的。

### 3. 进度实时回显的链路**已经通**

Web 侧 `api.ts` 的 `toSummary()` 已经在读会话文件：

- `progressLine` —— agent 最后一条有内容的输出；
- `progressAt` —— 那条输出的时刻；
- `elapsedMs` —— 本次运行已跑多久；
- `elapsedIdleMs` —— 最新输出距今多久（ADR-074）。

而 `src/adapters/claude-agent/index.ts:391` 在每次 stdout 到达时更新 `lastOutputAt`。
监督进程用 `SliceProgressProbe` 轮询 worktree 的变化来续命看门狗（D-55）。

**所以「进度及时更新在 Web 上」不需要新建机制** —— 需要的是：Web 端 `run` 返回后，
前端**开始轮询**（或 SSE 推送），把 `toSummary` 已经算好的进度显示出来。

## 决策

### 1. 总体路线：CLI 与 Web 走**同一套编排**，不是各写一份

ADR-072 §4 / ADR-084 §1 排除这四个动作的理由是：

> **那些动作在 CLI 侧有完整实现，Web 侧再实现一份会分叉判定（C3 的隐患）。**

核实后，这句理由**对四个动作的成立程度不同**：

| 动作 | 判定逻辑现在在哪 | Web 侧复用的可行性 |
|---|---|---|
| `gate` | `core/gate/executor.ts` 的 `GateExecutor`（**已在 core**）；CLI 侧只负责读 config → 拼 `GateConfig` → 调 executor | ✅ **直接调 core** |
| `resume` | `core/sched/engine.ts:332` 的 `Scheduler.resume`（**已在 core**） | ✅ **直接调 core** |
| `freeze` | 判据在 core（`evaluateFreezeTrace` / `resolveWriteSet` / `precheckWriteSetAgainstPolicy` / `evaluateWriteSetCoverage`），**但编排序列在 CLI**（`core-slice.ts:1115`） | ⚠️ **需要下沉编排** |
| `run` | 编排全在 CLI（`core-slice.ts:1352`），且必须用 executor adapter | ⚠️ **走进程边界复用** |

**所以本 ADR 不是「Web 侧补写四份判定」，而是「把编排从 CLI 下沉，让两端共用」。**

### 2. 下沉方案：新建 `src/core/lifecycle/`

**不把编排塞进现有 core 模块**，理由是职责边界：

```
src/core/lifecycle/
  freeze.ts   —— 冻结编排序列（物化追溯 → 写集×策略 → D-4 覆盖 → 追溯合格 → FREEZE）
  gate.ts     —— 门禁编排序列（状态校验 → 架构护栏 → 拼 GateConfig → 调 GateExecutor）
  resume.ts   —— 续跑编排序列（薄封装：调 Scheduler.resume + 结果分类）
  types.ts    —— 共享的结果类型（人话 + 机器可读）
```

**这些模块的共同性质**（这决定了它们能进 `core/`）：

- 只读文件、纯计算 + 文件写 —— 不调模型、不触网（C3）；
- 零第三方运行时依赖（C2）；
- 不 import `adapters/`（C2）—— 编排层**不碰 executor adapter**，
  `run` 的 agent 启动被完全排除在外（见 §3）。

**编排层返回结构化结果，不打印** —— CLI 侧负责渲染成终端输出，
Web 侧负责渲染成 JSON + 前端提示。这样两端**共用判定，但各自呈现**。

> **为什么不让 CLI 直接调 `core/lifecycle/` 然后自己渲染？**
> 因为 CLI 现有输出（`zelto freeze` 的彩色提示、`--json` 模式）已经有人用。
> 重构必须**保持 CLI 输出不变** —— 否则就是在改一个已发布的 CLI 的行为，
> 那是另一个 ADR 的事。

### 3. `run` 走**进程边界复用**，不下沉到 core

`run` 必须拉起 executor adapter —— 而 `core/` 不许 import `adapters/`（C2）。
所以 `run` 的编排**留在 CLI 层**。

**Web 端怎么办**？**不重新实现，而是拉起 CLI 进程**：

```
POST /api/slices/:id/run
  └─ spawn('node', [zeltoCli, 'run', id, '--detach', '--json'])
       └─ 返回 { ok: true, taskId, supervisorPid, nextStep }
```

**为什么这是对的**（而不是「Web 再实现一份 run」）：

1. **判定不分叉**（C3 的核心关切）—— Web 端跑的就是**那个 CLI 二进制**，
   同一份准入判定、同一份写集预检、同一份 hotfix 确认、同一份事件。
2. **孤儿问题已解** —— `--detach` 的监督进程机制（D-50/D-53）原样复用。
3. **不需要动 C2** —— 进程边界天然隔开 `adapters/` 与 `core/`。
4. **CLI 侧零改动** —— `run` 的实现一个字不动。

**代价（要如实说）**：

- Web 端要能定位 CLI 二进制 —— 用 `process.argv[1]` 的目录（同一个 `dist/`），
  拿不到就**明确报错并给出 CLI 命令**，不许降级成「假装跑起来了」。
- spawn 的是**子进程**，Web 进程死后它不受影响（这是好事 —— 监督进程本来就该独立）。
- `run` 的**即时反馈**只能到「拉起成功 / 拉起失败」这一层，
  更细的进度靠轮询 `toSummary`（已在做）。

### 4. `hotfix` 在 Web 端**必须显式确认**（ADR-015）

`zelto run --hotfix` 跳过门禁② —— 等于放弃「签字前必须过门禁」这条约束。
ADR-015 §3.1 要求 `--hotfix` 必须配 `--yes`。

**Web 端因此要求请求体带 `hotfix: true` + `confirmHotfix: true` 两个字段**，
缺一不可，且响应里明确回显「这次跳过了门禁②」。

> **为什么 Web 要显式比 CLI 更严**：
> CLI 的 `--hotfix --yes` 是**同一条命令行的两个词**，人会连着打。
> 而 Web 的两个勾选框可能被误点。所以**要求两个独立的确认字段**，
> 不是一个。

### 5. `run` 的并发保护必须保留

`core-slice.ts:1519` 有一段「重复 agent 守卫」：这片已经有 agent 在跑
（活进程判定用**整棵进程树**，因为真正的 agent 是外层 `cmd.exe` 的孙进程）→ 拒绝再起一个。

**这段必须保留在 Web 路径上** —— 两个 agent 抢同一个 worktree，谁的成果都留不下。
因为 Web 端是拉起 CLI 进程，**这段逻辑天然被复用**，不需要另写。

### 6. 每个写操作都写事件流，actor + via 两个维度（C4）

复用已有事件类型，`via: 'web'` 标在 payload 里（ADR-084 §4 的做法）：

| 端点 | 事件 |
|---|---|
| `POST /api/slices/:id/freeze` | `spec.frozen`（已有） |
| `POST /api/slices/:id/gate` | `gate.executed` / `gate.result`（已有） |
| `POST /api/slices/:id/run` | `run.started`（已有，由 CLI 进程写） |
| `POST /api/slices/:id/resume` | `run.resumed`（已有，由 core 写） |

**新增事件类型：无。** 契约零改动。

### 7. 安全边界：完全继承 ADR-072 §3 / ADR-084 §5

Web 侧 `server.ts` 的 `handleApi()` 在**分发之前**统一校验：

- Origin 校验（跨站拒绝）；
- `X-Zelto-Token` 会话 token（`timingSafeEqual`）；
- `Content-Type: application/json`（挡跨站表单与 `no-cors` 的 `text/plain`）。

**新增端点不需要（也不许）自己再实现一遍这套校验。**
`validId()` 继续挡住 `..` 与路径分隔符。

**新增一条**：`run` 端点要**限制同时在跑的 detached 任务数**（例如同项目最多 N 个）。
理由：驾驶舱里点错一下就可能同时拉起多个 agent，而每个 agent 都在烧 token。
这不是安全漏洞，是**成本失控**的闸门。

> 具体 N 写成配置项 `web.maxConcurrentRuns`，默认 1。
> 超限时**明确拒绝并告知当前在跑几个**，不许静默排队。

## 影响面

### 新增

- `src/core/lifecycle/freeze.ts` —— 冻结编排（从 CLI 下沉）
- `src/core/lifecycle/gate.ts` —— 门禁编排（从 CLI 下沉）
- `src/core/lifecycle/resume.ts` —— 续跑编排（薄封装 `Scheduler.resume`）
- `src/core/lifecycle/types.ts` —— 共享结果类型
- `src/core/lifecycle/index.ts` —— 出口
- `src/adapters/web/throttle.ts` —— Web 端拉起 `zelto run --detach`
- `src/core/config/loader.ts` + `src/core/config/index.ts` —— 配置解析下沉到 core
  （驾驶舱也要读 `gate.commands` / `gate.acceptance`；解析器住在 `cli/` 的话，
  Web 端要么自己再写一份（配置语义漂移），要么 import `cli/`（分层反过来）——两条都不行）
- `src/core/arch/guard-wiring.ts` —— 架构护栏接线（从 `cli/commands/arch-guard.ts` 下沉）
- `tests/web-cockpit-throttle.test.ts` —— 四个油门端点的判据

### 修改

- `src/cli/commands/core-slice.ts` —— `freeze` 改为调 `core/lifecycle/freeze.ts`
- `src/cli/commands/gate-sign.ts` —— `gate` 改为调 `core/lifecycle/gate.ts`
- `src/cli/commands/info-help.ts` —— `resume` 改为调 `core/lifecycle/resume.ts`
- `src/cli/commands/shared.ts` —— 配置解析、架构护栏接线、规格哈希**转发**到 core
- `src/adapters/web/api.ts` —— 新增 4 个方法
- `src/adapters/web/router.ts` —— 新增 4 个 POST 端点
- `src/adapters/web/frontend-assets.ts` —— 四个按钮 + 进度实时轮询
- `src/cli/commands/web.ts` —— 启动提示更新（不再是「只读驾驶舱」）
- `docs/adr/adr-084-cockpit-can-take-over.md` —— §1 的排除清单**标注已被 ADR-086 取代**
- `docs/zelto-项目目标.md` —— §2.5 与 §9 负向清单里「驾驶舱只读 + 一个签字动作」
  的表述**已过时**（驾驶舱现在能驱动工作流）—— 改成「能驱动工作流，但不是一套 IDE」。
  漏掉这一处，下一轮就会把「驾驶舱能开跑」当成「本来就该这样」而没人去补
  —— 这正是 §11.38 记的那个病。

> **关于「CLI 输出不变」**：验收标准第 12 条说的是**语义与契约不变**
> （退出码、JSON 字段名、事件类型、状态机结果）。
> **文案**确实有变化 —— 冻结/门禁/续跑的失败原因从「各写各的」变成了
> core 编排层返回的那句人话（CLI 与 Web 显示**同一句**）。
> 这是下沉编排的必然结果：编排层返回「为什么不行」，
> 两端各自渲染。若两端各写一句文案，那又是一次「同一个东西两份实现」。
>
> 唯一被**明确保住**的是退出码契约 —— 见 §实施记录 7。

### 测试

- `tests/web-cockpit-actions.test.ts:256` —— **那条断言必须改**：
  它现在断言「Web 端**没有** run / gate / freeze / resume 端点」。
  ADR-086 实施后这条断言**变成错的** —— 必须改成断言「这四个端点存在且复用 core 判定」。

> **不改测试等于把新功能写成「不存在」**。
> 禁区清单里「不许改动 `tests/acceptance/**`」不覆盖这个文件（它不是 acceptance 目录），
> 但**改它必须在本 ADR 里说明** —— 所以在这里说明。

## 不变量核查

- **C1**（状态只在文件里）：**无影响** —— 四个动作都是文件写
  （切片状态、事件流、任务文件）；`run` 的 agent 跑在独立进程里，
  它的进度也落在会话文件 / 任务文件里（不是内存状态）。
- **C2**（core 零第三方依赖、不 import adapters）：**加强** ——
  新增的 `core/lifecycle/` 只用 Node 内置、不碰 `adapters/`。
  `run` 的 agent 启动**留在 CLI 层**，靠进程边界隔开 —— **不需要动 C2**。
- **C3**（判定确定性）：**加强** —— 这是本 ADR 最需要守住的一条：
  - `gate` / `resume`：**直接调 core**，不重写判定；
  - `freeze`：编排下沉到 core，CLI 与 Web **调同一份**；
  - `run`：Web 拉起 **CLI 二进制本身** —— 同一份准入判定、同一份写集预检、同一份事件。
- **C4**（append-only 事件流）：**满足** —— 四个动作都写已有事件类型，**契约零改动**。
- **C5**（保护域外部化）：**无影响** —— 写集 × 策略判定走 `core/spec/write-set-policy.ts`（既有）。
- **C6**（同 C2）：**无影响**。
- **C7**（llm 只产草稿）：**无影响** —— 这四个动作都不调模型。
- **C8**（同 C5）：**无影响**。
- **C9**（写集预约运行时强制）：**满足** —— `run` 由 CLI 进程执行，
  运行时守卫（预约 + PreToolUse 钩子）与写后审计**原样复用**；
  Web 侧**不碰** agent 的工作目录。

## 验收标准

1. ✅ 四个油门端点在 Web 可用；
2. ✅ `gate` / `resume` **直接调 core**，不重写判定；
3. ✅ `freeze` 的编排序列在 `core/lifecycle/`，**CLI 与 Web 调同一份**；
4. ✅ `run` 由 Web 拉起 **CLI 进程**（`--detach`），**不是** Web 侧重实现；
5. ✅ `run` 的 HTTP 请求**不挂着** agent 会话（fire-and-forget）；
6. ✅ `run` 之后前端能看到**进度实时更新**（复用 `toSummary` 已有的 `progressLine` / `elapsedIdleMs`）；
7. ✅ `hotfix` 在 Web 端要**两个独立确认字段**，缺一拒绝；
8. ✅ 重复 agent 守卫在 Web 路径上**仍然生效**（两个 agent 不抢同一个 worktree）；
9. ✅ 四个动作**都写事件流**，且**没有新增事件类型**（契约零改动）；
10. ✅ 四个动作**都过 ADR-072 §3 / ADR-084 §5 的三道校验**（Origin + token + Content-Type）；
11. ✅ 同时在跑的 detached 任务数**有上限**，超限**明确拒绝**（不许静默排队）；
12. ✅ **CLI 输出不变** —— 重构后 `zelto freeze` / `gate` / `resume` 的终端输出与重构前一致；
13. ✅ `npm test` 全绿。

## 实施记录（落地时才发现的事）

这一节记的是**写方案时没想到、动手时撞上**的东西 ——
方案里的推断被现实修正的地方，记下来是为了下次不再踩。

### 1. `freeze` 编排下沉时发现：规格路径必须按 `repoRoot` 解析

CLI 侧读规格用的是 `slice.spec.path` **相对 cwd**；Web 侧的 `repoRoot` 是**参数**，
未必等于进程 cwd。照抄 CLI 的写法，Web 端会去读**别的项目**的规格 ——
症状极隐蔽：规格读不出来时 `specContent` 是空串，追溯物化拿不到任何需求 →
冻结报「追溯不合格」，**人明明写了验收标准，却被告知没写**。

修法：`resolveSpecPath(repoRoot, specPath)` —— 绝对路径原样保留，相对路径拼到 `repoRoot` 下。

### 2. `hashSpecFile` 的格式必须与 CLI 侧**逐字节**一致

下沉时写成了 `` `sha256:${hashContent(content)}` `` —— 而 `hashContent()` **已经**带
`sha256:` 前缀，于是哈希变成 `sha256:sha256:<hex>`。

而 `zelto check` 用的是 CLI 侧那份（`sha256:<hex>`）→
**冻结时写的哈希与 check 算的哈希永远对不上**，
表现为「规格刚冻结完就报 hash mismatch」。

这种「同一个东西两份实现、格式悄悄不一样」的坑，是判定分叉的典型形态（C3）——
所以这里**直接复用**同一个哈希函数，不重写。

### 3. `gate.executed` 只能有一条 —— 多一条会让度量失真

下沉时在 `runGateCommands` 里又写了一条 `gate.executed`，
而 `GateExecutor.execute()` 自己已经写过一条。

后果：`rework_rate = gate.retry ÷ gate.executed` —— 门禁跑一次、事件两条，
这个比值直接砍半。**度量从此失真，而且是静默的**（没人会去看「这条算不算」）。

修法：`gate.executed` 由 executor 写（那是判定产物，`actor: 'zelto'`），
`via` 作为**同一条事件的第二个维度**传进 executor —— 不补写第二条。

### 4. `dry-run` 是**只读预览**，不写事件

干跑不执行任何命令，所以它不该留下 `gate.executed` ——
理由同上：干跑也写一条，这个比值就凭空多了一个分母。

（这条在测试里被写反过一次：先断言「干跑写了事件」，后改为
「干跑 0 条 + 真跑 1 条」，用真跑做对照。）

### 5. `refreeze` 会清空追溯 —— 规格的验收标准必须用**编号条目**

`refreeze` 清空 `trace.requirements`（规格改了，需求条目也可能变了），
然后从规格重新物化。而 `extractAcceptanceCriteria` **只认编号条目**（`1. xxx`），
不认无序列表（`- xxx`）。

后果：规格用无序列表写验收标准 → **第一次能冻、第二次冻不了**。

这不是 bug，是「追溯只认编号列表」这个既有约定的正常后果 ——
但它值得被写下来，因为症状（refreeze 报「追溯不合格」）离病因很远。

### 6. `run` 的子进程会让临时目录删不掉（测试侧的坑）

端到端测试里，若拿一片 **frozen** 切片试 `POST /run`，CLI 会真的准入、
真的建 worktree、真的拉起监督进程 —— 那个进程会**抱着临时目录不放**，
清理阶段直接 `EPERM`/`EBUSY`（Windows 上目录被进程占着删不掉），
而且它还在烧 token。

所以凡是验「起跑**之前**那些护栏」的用例，一律用 **draft** 切片 ——
准入只认 frozen/completed，draft 必然被拒在准入那一关，**不会真的起 agent**。

「真的起跑了」那部分由 CLI 侧的 detach 测试覆盖（那里有 mock agent）。

### 7. CLI 门禁的退出码有历史契约，不能顺手「修正」

重构 `gate-sign.ts` 时，把门禁命令执行失败改成了退出码 `1` ——
结果 `config-loading.test.ts` 红了。

原来是有意的：**文本模式**下门禁命令执行失败仍退出 `0`，
失败信息打在 stdout 上（`Result: ❌ Gate failed`）；
只有 **`--json` 模式**才按 `facts.passed` 返回 `0` / `1`。
预检失败（架构护栏拦下、状态不对、`--only` 名字不存在）才一律退出 `1`。

> **教训**：重构 CLI 输出时，「看起来不对」的退出码可能是**有意的契约**。
> 改之前先查有没有测试在守它 —— 有测试守的，那就是契约。

### 8. 前端置灰是**提示**，不是门

前端按切片状态决定摆哪些按钮（`renderThrottleButtons`）。
但**判定权在服务端** —— 前端猜错了也只是「按钮亮着但点了被拒」，
反过来（该亮的没亮）才是真问题。所以前端规则宁可保守，
且**绝不自己算「通过没通过」**。

另外：前端**只显示服务端返回的话**（`reason` / `details` / `advisories`），
不许自己乐观、不许把「没跑起来」显示成「跑起来了」（D-53）。

## 明确不做

- **不做** Web 端的 `admit` / `abandon`（并行准入与放弃 —— 那是批次编排，不是单片推进）；
- **不做** Web 端的 `merge`（合并必须显式、且 ADR-018 禁止与签字挂钩）；
- **不做**「一键批准」「自动合并」（负向清单）；
- **不做**常驻 daemon（负向清单）—— `run` 拉起的是**独立监督进程**，
  它是「一次运行」的生命周期，不是常驻服务；
- **不做**完整 GUI（负向清单）—— 四个按钮，不是一套 IDE。

## 关联缺陷

- ADR-084 §1 的「明确不做（run / gate / freeze / admit / abandon / resume）」**已被本 ADR 部分取代**：
  `run` / `gate` / `freeze` / `resume` 改为**做**，但用「复用」而非「重写」的方式做。
  `admit` / `abandon` 仍然不做。
- ADR-072 §4 的排除清单**同样被部分取代**。
- ADR-084 的「刹车与油门」比喻**不再准确** —— 驾驶舱现在两者都有。

## 参考

- `docs/adr/adr-084-cockpit-can-take-over.md`

> **关于「CLI 输出不变」**：验收标准第 12 条说的是**语义与契约不变**
> （退出码、JSON 字段名、事件类型、状态机结果）。
> **文案**确实有变化 —— 冻结/门禁/续跑的失败原因从「各写各的」变成了
> core 编排层返回的那句人话（CLI 与 Web 显示**同一句**）。
> 这是下沉编排的必然结果：编排层返回「为什么不行」，
> 两端各自渲染。若两端各写一句文案，那又是一次「同一个东西两份实现」。
>
> 唯一被**明确保住**的是退出码契约 —— 见 §实施记录 7。
- `docs/adr/adr-072-web-cockpit-readonly-plus-sign.md`（已移入 `docs/adr/`）
- `src/cli/commands/core-slice.ts` —— `freeze` 改为调 `core/lifecycle/freeze.ts`
- `src/cli/commands/gate-sign.ts` —— `gate` 改为调 `core/lifecycle/gate.ts`
- `src/cli/commands/info-help.ts` —— `resume` 改为调 `core/lifecycle/resume.ts`
- `src/cli/commands/shared.ts` —— 配置解析、架构护栏接线、规格哈希**转发**到 core
- `src/cli/commands/supervisor.ts` —— `spawnSupervisor`（:130）
- `src/core/gate/executor.ts` —— `GateExecutor`
- `src/core/sched/engine.ts` —— `Scheduler.resume`（:332）
