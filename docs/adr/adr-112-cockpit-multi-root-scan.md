# ADR-112：驾驶舱按「根」扫描 —— 版本工作树里的切片不许看不见

**状态**：实施
**日期**：2026-11-25
**相关**：ADR-056（版本分支 + 版本集成目录）、ADR-072（驾驶舱只读）、ADR-081（驾驶舱不许静默丢片）、ADR-111（基线 vs 开发分开口径）、C1、C3

## 背景

驾驶舱（`zelto web`）的概况页显示「8 个切片都完成了」，可实际进度远不是这样。

实测（nimrtc-v14，2026-11-25）：

| 位置 | 切片数 | 内容 |
|---|---|---|
| `.zelto/slices/`（仓库根） | 8 | 3 片基线 + 5 片开发（v1.0–v2 时代的活） |
| `.zelto/version-worktrees/v3/.zelto/slices/` | **15** | **v1.4 这一版真正的开发进度** |

驾驶舱上看到的是第一行，第二行一片都看不见 —— 而那 15 片里有 2 片正卡在
`frozen`（`v1-install-tree-module-closure` / `v6-writeset-slice-boundary`），
待人签字。

## 根因

`zelto web` 的 `repoRoot` 是 `process.cwd()`，而 `WebApi` 的全部 store 都直接
从 **同一个** `.zelto/` 构造：

```ts
this.store  = new SliceStore(join(zeltoDir, 'slices'));
this.events = new EventStream(join(zeltoDir, 'events'));
this.signs  = new SignManager(zeltoDir, this.events, this.store);
```

ADR-056 把版本变成 git 的**一等分支**之后，每个版本有自己独立的集成目录
`.zelto/version-worktrees/<label>/`，那里的 `.zelto/` 是一份**完整的**
zelto 状态（切片、事件、签字请求、规格、验收目录全在）。切片在版本目录里跑、
在那里冻结、在那里过门禁、在那里被签字 —— 状态**只落在那个目录里**。

于是驾驶舱看的是「仓库根那份」而不是「版本目录那份」，
两者是不同的东西，而界面**没有任何话说这一点**。

## 为什么这是真问题，不只是显示口味

这与 ADR-081 / ADR-111 是同一个形状：**「算错」比「查不到」更容易被忽略**。

- 一片卡在版本目录里等人签字，驾驶舱不显示 → **人没事可做**，
  而它恰恰是需要人的那一刻（ADR-084 的整个出发点）；
- 人看到「8 片全完成」，以为是这版的全部 → 基于错误事实做决定；
- 驾驶舱最该起作用的场景（版本在跑、切片在等）恰好是它**看不到**的场景。

「看不见」比「看不到」更严重：前者连「少了东西」这件事本身都不说。

## 决策

### 决策一：驾驶舱按**根**（root）扫描，不止一个根

一个「根」= 一个装着 `.zelto/` 的目录。驾驶舱扫描：

1. **仓库根**（`repoRoot`）—— 永远有，`scope = 'root'`；
2. **每个版本集成目录** `.zelto/version-worktrees/<label>/` ——
   只要它有 `.zelto/slices/` 或 `.zelto/events/`，`scope = 'version'`，
   并带上 `label`。

**不扫切片执行目录**（`.zelto/worktrees/<sliceId>/`）：
那里的 `.zelto/slices/` 只是**建 worktree 时同步进去的基线快照**
（实测：`v1-install-tree-module-closure` 的 worktree 里只有那 3 片基线），
真正的状态在版本目录 —— 扫进去只会制造三份一样的假副本。

### 决策二：同一片出现在多个根时，合并成**一行**，状态取「最近写过」

实测重叠：`v0-cmake` / `v0-src-log` / `v1-cmake` 三片基线同时存在于
根、v1、v2、v3 四个根（版本目录是从根复制出来的）。

若不合并，同一切片会在列表里出现 4 次，而人无法判断该信哪个。

合并判据：**`updatedAt` 较晚的那份胜出**（同一时刻 → 根优先，保证确定性）。
胜出的那份决定这一行的 `state` / `liveness` / 成本 / 活性；
但**所有出现过的根都记在这一行上**（`roots: string[]`）——
「这片在哪些地方有记录」是事实，不因合并而消失。

### 决策三：**写操作与详情**一律按「这片真正所在的那个根」路由

读可以合并，写不能含糊：

- `zelto sign` / `gate` / `freeze` / `resume` / `answer` / `run` 都要落到
  **这片真正所在的那个 `.zelto/`**；
- 落到错的根 = 「签字请求不存在」或者更糟 —— 签了根上那份过期副本；
- 详情页（追溯链、事件流、审计、签字四项）必须读同一个根，
  否则「详情里说的」和「列表里看的」不是同一份事实。

所以 `SliceSummary` / `SliceDetail` 都带上 `scope` + `label`
（根为 `null`），路由就靠这两个字段，**不靠 id 猜**。

### 决策四：驾驶舱只**发现**根，不**判定**根

根发现是纯文件系统事实（这个目录里有没有 `.zelto/slices`），
落在 `core/`（`discoverCockpitRoots`），不调模型、不触网（C3）。

它**不**问「这个版本计划里有没有它」「这个分支存在不存在」——
那些是版本制度的判定，归 CLI。驾驶舱只要「盘上有几份状态」。

## 修法

### ① core：`src/core/project/cockpit-roots.ts`（新增）

```ts
export type CockpitScope = 'root' | 'version';
export interface CockpitRoot {
  scope: CockpitScope;
  /** 版本 label（scope === 'version' 时） */
  label: string | null;
  /** 根目录绝对路径（里面有 .zelto/） */
  dir: string;
}
export function discoverCockpitRoots(repoRoot: string): CockpitRoot[];
```

判据全部可证伪：目录存在 + 有 `.zelto/slices` 或 `.zelto/events`。
排序稳定（`root` 在前，版本按 label 字典序）—— 同一棵树两次扫描结论一致。

### ② Web：`WebApi` 按根建 store（`SliceWorkspace`）

```ts
interface SliceWorkspace {
  root: CockpitRoot;
  store: SliceStore;
  events: EventStream;
  signs: SignManager;
  audit: AuditTrail;
  budget: BudgetCollector;
  worktrees: WorktreeManager;   // 切片 worktree 仍按 repoRoot 解析
  readSlice / readEvents / exists
}
```

- `listSlices()` 扫所有 workspace，**并行**，按决策二合并；
- `getSlice(id, scope?, label?)` / `signRequests` / `approveSign` / `rejectSign`
  / `gate` / `freeze` / `resume` / `answer` / `run` / `events` / `audit`
  都按 `scope + label` 选 workspace；
- 不传 `scope` 时按「合并后的归属」解析（向后兼容 —— 老调用方不传也照常工作）。

### ③ 前端：按根分组显示

- 概况页的卡片仍是全量口径（合并后），另加一行「扫描的根」清单，
  **说清哪些根被扫了**（看不见的根本身就是信息）；
- 切片列表分两张表：**仓库根** / **版本工作树（每个 label 一节）**，
  每一行的 `state` 来自它真正所在的那份。

### ④ 契约变化（C1 不变）

`/api/slices` 每行新增 `scope` / `label` / `roots`；
`/api/slices/:id?scope=&label=` 与各 POST 端点接受这两个参数。

## 不做（边界）

- **不做**多项目驾驶舱（那是「一个端口看多个 repo」，另一件事）；
- **不做**版本目录里的**需求 / 设计 / 版本计划**的分散读取 ——
  那些仍读仓库根（版本目录里的 `design/` 等是同步副本，不是真源）；
- **不做**根发现「猜」：没有 `.zelto/slices` 的版本目录不列；
- **不做**合并时丢掉「不在当前根的那份」的证据 —— `roots` 字段保留全部。

## 不变量核查

- **C1**（状态只在文件里）：无影响 —— 只多读了几个目录；
- **C2**（core 零第三方依赖）：无影响 —— `cockpit-roots.ts` 只 import `node:fs` / `node:path`；
- **C3**（判定确定性）：**加强** —— 根发现是纯文件事实，排序稳定；
- **C4**（append-only 事件流）：无影响 —— 写操作**落回各自的根**，不跨根写；
- **C5**（保护域外部化）：无影响；
- **C9**（写集预约运行时强制）：无影响 —— 路由只换「哪个 `.zelto/`」，
  预约与审计原样复用。

## 验收标准

1. 根上有 3 片、版本目录有 5 片（其中 1 片重叠）→ 列表显示 7 行，
   重叠那行 `roots` 含两个根；
2. 重叠片的 `state` 取 `updatedAt` 较晚的那份（同刻取根）；
3. `getSlice(id, 'version', 'v3')` 读到的是版本目录那份；
4. 签字 / 门禁 / 冻结 / 续跑落到 `scope+label` 指定的根；
5. 版本目录没有 `.zelto/slices` 时不出现在根清单里；
6. 同一棵树两次 `discoverCockpitRoots` 结果一致（确定性与顺序）；
7. nimrtc-v14 现场：`zelto web` 能看到 v3 的 15 片（含 2 片 frozen）；
8. `npm test` 全绿、`npm run lint` 通过。

## 参考

- `src/core/worktree/manager.ts`（`VERSION_WORKTREE_BASE_DIR`）
- `src/core/version/branch.ts`（版本 label 的白名单与清洗）
- `src/adapters/web/api.ts`（现状：单根）
