# ADR-017: 版本级编排与交付语义

**状态**: 已实现
**日期**: 2026-11-04
**作者**: 系统架构
**关联约束**: C1, C3, C4, C7, C9
**关联文档**: `docs/zelto-项目目标.md`, `docs/zelto-场景功能地图.md`, `docs/adr-011-worktree-isolation.md`, `docs/adr-014-runtime-policy-enforcement.md`

---

## 1. 摘要

此前 zelto 的编排单位只有**切片**：一个切片从澄清到签字是一条完整的链。
但一个人做中大型项目时，真正需要并行的是**一批切片**——它们属于同一个版本、
共享同一份设计，彼此之间有依赖关系。

没有版本级编排时，会出现三处断裂：

1. **并行语义有两份实现**：`zelto run --parallel` 自己一套，`zelto version start` 自己一套。
   两份迟早漂移——版本层一旦漏掉写集预约守卫，就会出现
   「并行 agent 在主仓互相覆盖」这种最伤可控性的事故（违反 C9）。
2. **版本级动作无处留痕**：版本不是切片，但版本级动作同样要写事件（C4）。
   事件流按切片分目录，版本动作要么没地方写，要么混进某个切片的流里。
3. **交付判据缺失**：「这个版本算不算做完」没有定义。
   切片全部签字 ≠ 版本可交付——合入主干后整体能不能过验收，是另一件事。

本 ADR 定义版本级编排与交付的语义：版本层复用切片层的执行路径、
版本级动作有独立的事件键、版本交付有两道判据（前置条件 + 版本级验收）。

---

## 2. 动机

### 2.1 现状

| 事实 | 位置 | 影响 |
|---|---|---|
| `run --parallel` 与 `version start` 各有一套并行执行逻辑 | `core-slice.ts` / `ai-pipeline.ts` | 两份实现会漂移；版本层可能漏掉守卫 |
| 事件流按切片分目录 | `core/events/stream.ts` | 版本级动作无合法落点 |
| 交付判据只有「切片是否 completed」 | `version deliver` 改动前 | 合入主干后整体不过验收，没人拦得住 |
| `version start --auto` 曾打算自动推进版本 | 已移除 | 与 AGENTS.md 禁区「一键批准 / 自动合并」抵触 |

### 2.2 为什么版本层必须复用切片层

版本级并行和单切片并行要满足**同一套**隔离与约束机制：

- 每个切片一份隔离 worktree（ADR-011）
- 每个切片一份写集预约 + PreToolUse 钩子（ADR-014，C9）
- 一次门禁②、一次签名请求

这两份实现各写一遍，版本层迟早会漏掉其中一条。
漏掉 worktree 隔离 → agent 互相覆盖；
漏掉写集预约 → agent 越界写入无人拦。

**抽出来共用一份**（`src/cli/commands/parallel-executor.ts`），
让版本层只是在上面加一层「准备切片」和「结果解读」。

---

## 3. 设计

### 3.1 单一执行路径

`executeSlicesParallel()` 是唯一的并行执行实现：

```
src/cli/commands/parallel-executor.ts
  └─ executeSlicesParallel(options) → ParallelExecutionResult

调用方：
  ├─ zelto run --parallel <id...>      （core-slice.ts）
  └─ zelto version start <ver>          （ai-pipeline.ts）
```

执行语义（六阶段）：

| 阶段 | 内容 | 失败处理 |
|---|---|---|
| ① 准入 | 切片必须 frozen 且有 frozenHash | 整批 abort |
| ② 写集解析 | 从规格「范围」解析生效写集 | 只读，不改状态 |
| ③ 冲突检测 | 跨切片写集不得重叠 | 整批 abort |
| ④ 隔离与守卫 | 建 worktree + 取写集预约 + 装钩子 | 整批 abort |
| ⑤ 拉起 agent | 并行启动，逐个等待退出，失败按配置重试 | 逐片重试 |
| ⑥ 收尾 | 写集审计 → 状态回写 → 门禁② → 签名请求 | 越界不进 gate |

**主仓工作树全程不被切换分支、也不被 agent 写入。**

### 3.2 版本级事件键

事件流按切片分目录（`.zelto/events/<sliceId>/events.jsonl`）。
版本不是切片，所以用 `version-<label>` 当归属键：

```typescript
function versionEventKey(versionLabel: string): string {
  return `version-${versionLabel}`;
}
```

这个键不与任何切片 id 冲突（切片 id 不以 `version-` 开头），
所以版本事件可以落在同一个事件流机制里，不需要新的存储格式（C1）。

新增两种事件类型：

| 事件 | 何时写 | 载荷 |
|---|---|---|
| `version.accepted` | 版本级验收通过 | `{ version, commands: [{ name, passed }] }` |
| `version.delivered` | 版本状态推进到 delivered | `{ version, slices }` |

两者都写进 `contracts/schemas/event-envelope.json` 的 enum——
契约与实现不允许不一致。

### 3.3 版本交付的两道判据

`zelto version deliver <ver>` 分两步，两步都过才算交付：

**第一步：前置条件（确定性，只读磁盘与 git）**

- 版本内每个切片的状态必须是 `completed`
- 每个切片的 `slice/<id>` 分支必须已合入当前 HEAD

「合入主干」由**显式的 `zelto merge`** 完成（ADR-018）。zelto 不自己合，
但它会检查这件事是否真的发生了——分支没进 HEAD，版本就不可交付。

**第二步：版本级验收（确定性，跑项目自己的门禁命令）**

在**主仓**跑 `.zelto/config.yaml` 里 `gate.commands` 配的命令：

- 跑在主仓 = 验的是真实的主干代码，而不是某个 worktree 里的中间态
- 命令取自项目自己的配置 = 用项目自己的验收口径
- 超时按 `gate.timeoutSec`，超时算失败

任何一条不通过 → 版本状态保持 `in_progress`，不写 `version.accepted`，不推进到 `delivered`。

**为什么必须有这一步**：切片各自过门禁只保证「每片按规格做了」。
两个切片各自对、合起来不对（接口不一致、集成缺口）是很常见的情况，
而这种问题只有在合入主干之后跑整体验收才暴露得出来。

### 3.4 签字与合并是两步

版本级的分工是：

```
gate 通过 → 自动发起签名请求 → 人签字 → 显式合并 → 版本交付
                                    ↑          ↑
                        这一步必须是人做的  这一步也必须是人显式做的
```

签字回答的是「这份改动可以不可以合入主线」，合并回答的是「现在就合」。
两件事语义不同，所以是两个动作（ADR-018 详细论证了为什么不能合成一步）。

`zelto version start --auto`（自动推进版本、免签字）已移除，
调用即报 `INVALID_ARGS`，并提示逐个签字：

```
zelto version start --auto 已移除：签字必须由人行使（AGENTS.md 禁区：一键批准 / 自动合并）。
   请逐个签字：zelto sign <slice-id> --approve
```

理由：AGENTS.md 禁区明列「一键批准 / 自动合并」。
把签字从流程里拿掉，等于让「高速并行」以放弃可控性为代价——
那不是 zelto 要的东西。

### 3.5 `version start` 的三个阶段

```
Phase 1  准备切片
         建切片文件 → 写规格 → 冻结（规格哈希 + 时间戳 + spec.frozen 事件）
         已完成的切片跳过；状态非法的切片直接报错退出

Phase 2  并行执行
         走 executeSlicesParallel —— 与 run --parallel 同一条路径

Phase 3  结果解读
         全部通过 → 打印逐片签字命令，等人签字
         有失败/停机 → 版本状态保持 in_progress，提示 --retry-failed
```

`--retry-failed` 只对 `in_progress` 状态的版本有效，
用来在人工处理完失败切片后重跑该版本。

---

## 4. 契约变更

| 变更 | 位置 | 说明 |
|---|---|---|
| 新增事件类型 `version.accepted` | `core/events/stream.ts`、`contracts/schemas/event-envelope.json` | 版本级验收通过 |
| 新增事件类型 `version.delivered` | 同上 | 版本已交付 |
| 审计摘要新增两条 | `core/audit/trail.ts` | 版本事件可在 `zelto audit` 里读 |
| `version start` 复用 `executeSlicesParallel` | `src/cli/commands/parallel-executor.ts`（新文件） | 单一并行实现 |
| `version start` 拒绝 `--auto` | `src/cli/commands/ai-pipeline.ts` | 签字必须由人行使 |
| `version deliver` 增加版本级验收 | 同上 | 主仓跑 `gate.commands` |
| 版本状态新增 `integrated` 中间态 | `core/version/types.ts` | `in_progress → integrated → delivered` |

**切片文件格式、规格文件格式、policy 格式均未变化。**
变的是 zelto 怎么编排一个版本、以及怎么定义「交付」。

---

## 5. 约束合规检查

| 约束 | 检查 | 合规 |
|---|---|---|
| **C1** | 版本状态在 `.zelto/versions/` 文件里；版本事件走同一个 append-only 事件流，无新存储 | ✅ |
| **C3** | 准入、冲突、预算、版本级验收都是确定性判定，不调模型、不触网 | ✅ |
| **C4** | 版本级动作写 `version.accepted` / `version.delivered` | ✅ |
| **C7** | `llm/` 只参与需求/设计/计划的**草案**生成，不参与任何判定；`version start` 全部走确定性路径 | ✅ |
| **C9** | 版本层复用切片层的写集预约 + 钩子，越界写入照常被拦 | ✅ |

---

## 6. 替代方案

### 方案 A：版本层另写一套并行执行

**放弃理由**：两份实现必然漂移。版本层漏掉 worktree 隔离或写集预约，
后果是并行 agent 在主仓互相覆盖——这是最伤可控性的一类事故。

### 方案 B：把版本做成切片的特例（一个大切片）

**放弃理由**：版本的切片之间有依赖，需要阶段化并行；
把它塞进一个切片，依赖关系就丢了，只能全串行或全并行。

### 方案 C：版本级事件混进某个切片的流

**放弃理由**：事件流按切片分目录是既定格式（C1 的文件化状态）。
版本动作没有切片归属，硬塞进某个切片会污染那个切片的追溯链。

### 方案 D：交付只看「切片是否全部 completed」

**放弃理由**：切片各自过门禁 ≠ 合起来能跑。
只看切片状态，集成缺口要到人工集成时才发现，那时已经过了签字环节。

### 方案 E：保留 `version start --auto`（自动推进版本）

**放弃理由**：与 AGENTS.md 禁区「一键批准 / 自动合并」抵触。
并行是为了更快，不是为了少一个人做判断。

---

## 7. 决定

1. 抽出 `executeSlicesParallel()` 作为**唯一**的并行执行实现，
   `run --parallel` 与 `version start` 共用
2. 版本级事件用 `version-<label>` 作归属键，新增 `version.accepted` / `version.delivered` 两种事件
3. `version deliver` 分两步：前置条件（切片完成 + 分支已合入）+ 版本级验收（主仓跑 `gate.commands`）
4. 版本状态新增 `integrated` 中间态：`in_progress → integrated → delivered`
5. `version start --auto` 移除，签字必须由人行使
6. `version start --retry-failed` 用于人工处理完失败切片后重跑版本
