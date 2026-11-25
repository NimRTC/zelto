# ADR-114：驾驶舱的分支可见性与计划对照 —— 「完成」分三个口径说

**状态**：实施
**日期**：2026-11-25
**相关**：ADR-110（版本计划双写）、ADR-112（驾驶舱按根扫描）、ADR-111（基线 vs 开发分开口径）、ADR-081（驾驶舱不许静默丢片）、C1、C3、C4

## 背景

用户在驾驶舱上问的是「**这一版还差什么**」。ADR-112 之后驾驶舱能看到版本集成目录里的切片了，但三件事仍然说不到一起：

实测（nimrtc-v14，2026-11-25，同一个仓库、同一天，三个口径）：

| 口径 | 事实 | 来源 |
|---|---|---|
| 版本计划 | 16 项全是 `draft` | `.zelto/versions/plan-1795166129234.json` |
| 盘上 | v3 目录里 15 片全是 `completed` | `.zelto/version-worktrees/v3/.zelto/slices/` |
| 版本分支 | `git ls-tree version/v3 .zelto/slices/` 只有 **3 片**基线 | `version/v3` 分支 |

`.zelto/` 整体在 `.gitignore` 里 —— 「切片状态」这件事默认只在**那台机器**上存在。驾驶舱原来只显示盘上的 `state`，于是「15 片全完成」这句话说的是磁盘，**不是分支**：另外 12 片的「完成」没有任何进版本分支的证据，换台机器、换一个 worktree 就查不到。

同时，版本计划里的状态与盘上状态**从没有并排出现过**：计划里全 draft、盘上全 completed，界面只说后者。

## 决策

### 决策一：切片行带「分支证据」三态

`onBranch`：

- `true` —— 这一片的状态文件**被所属根的 git 跟踪、且与 HEAD 一致**；同时给出 `committedState`（提交里那份的 state，用于和盘上对照）；
- `false` —— 只在盘上（未跟踪，或与 HEAD 不一致）；
- `null` —— 拿不到 git 证据（目录不是 git 仓库）。**「不知道」不许说成「不在」**（ADR-081 口径）。

判据**按这一行事实所在的根**问 git（ADR-112 决策三的精神：读可以合并，读证据也不能跨根拿）。同一根内按路径缓存。

判据是**纯 git 事实**（C3）：`ls-files --error-unmatch` + `diff --quiet HEAD -- <path>` + `show HEAD:<path>`，不触网、不调模型。

### 决策二：`/api/plan-coverage` —— 计划 / 盘上 / 分支分开数，不合成

每份计划 × 每个版本给出：

```
counts: { planned, onDisk, completed, onBranch }
```

以及逐片的 `plannedState` / `onDisk` / `actualState` / `onBranch` / `committedState`。

**不给「完成度」百分比**：把三个口径压成一个数会抹掉最关键的信息 —— 「盘上 10 片全 completed 且分支跟踪 0 片」和「计划 10 片里 7 片在分支上完成」是两种完全不同的处境，合成成 70% 与 100% 之后就分不出来了。

版本计划从哪读：仓库根 + 每个版本目录的 `.zelto/versions/`。版本目录里有计划的**优先按它自己的读**（版本目录里的计划是那一版的真源；仓库根那份是建版时的副本）。

### 决策三：`zelto plan version` —— 从钉死的切片清单确定性建版本

既有两条路都走不通时（实测 nimrtc v1.4.x 补齐 13 项，按「写哪个文件」分三波）：

- `zelto plan add-version` 走 LLM 生成一整版 —— 写集是模型编的、要逐条核对，且一次只能建一个版本；
- 手改 `.zelto/versions/<id>.json` —— 追溯链上的谎言（C4）。

新增 `core/version/create.ts` 的 `createVersion(plan, spec)`：版本号 / 依赖 / 描述 / 切片清单 / 写集全部由调用方给出，只做**校验**（label 与 `isValidVersionLabel` 同口径、重复版本、依赖缺失、依赖成环、切片 id 全局唯一、空版本）与**归一化**（写集去重 + 正斜杠、缺省 `specs/slices/<id>.md`）。CLI 是 `zelto plan version <plan> <v> --description … --depends-on … --slice <id> --slice-title … --write …`，落盘走 `VersionStore.save`（双写，ADR-110 决策六）并写 `draft.revised` 事件（C4）。

## 修法

1. `src/core/project/branch-evidence.ts`（新增）—— `annotateBranchEvidence` + 可注入的 `GitProbe`；
2. `src/core/version/create.ts`（新增）—— `createVersion`；
3. `src/adapters/web/api.ts` —— `SliceSummary` 增 `onBranch` / `committedState`；`listSlices` / `getSlice` 之后统一标注；新增 `planCoverage()`；
4. `src/adapters/web/router.ts` —— `GET /api/plan-coverage`；
5. 前端 —— 总览加「版本计划」（每版一行：计划片数 / 盘上有片 / 盘上完成 / 分支上完成 + 「N 片仅在盘上」徽标）；切片列表加「计划」「分支证据」两列；详情页加分支证据一行；
6. `src/cli/commands/plan-patch.ts` —— 顺手修一处 ADR-110 双写缺口：`plan patch` 原来只写 `.zelto/versions/` 真源，被跟踪副本不更新；改走 `VersionStore.save`。

## 不做（边界）

- **不判「计划过期」**：计划里 draft、盘上 completed 只并排呈现，是否回填计划由人决定（改计划要写事件，归 CLI）；
- **不自动把状态文件提交进分支**：驾驶舱只读（ADR-072）；「提交切片状态」是一次显式动作，不是看板的副作用；
- **不把 `onBranch` 混进签名/门禁判定**：它是展示证据，不进 `evaluateSignChecks`；
- **不扫切片执行目录里的 `.zelto/slices/`**：理由同 ADR-112（那是同步副本）。

## 不变量核查

- **C1**（状态只在文件里）：无影响 —— 只多读 git；
- **C2**（core 零第三方依赖）：无影响 —— 只用 `node:child_process` / `node:fs` / `node:path`；
- **C3**（判定确定性）：加强 —— git 查询与计划读取都是确定性只读，排序稳定；
- **C4**（append-only 事件流）：`plan version` 与 `plan patch` 都写 `draft.revised`；驾驶舱不写任何东西；
- **C5 / C9**：无影响。

## 验收标准

1. `annotateBranchEvidence` 三态齐全，按行的 `scope+label` 问对应根；
2. `/api/plan-coverage` 对每个版本给出 `planned / onDisk / completed / onBranch` 四个计数，逐片给出计划与盘上状态；
3. nimrtc-v14 现场：总览出现 v1–v6 六版对照，v3 的「分支上完成」显著小于「盘上完成」；
4. `zelto plan version` 建整版 → 真源与 `versions/` 副本同时更新 + `draft.revised` 事件；
5. 非 git 目录的行 `onBranch === null`（不是 false）；
6. `tests/plan-version-deterministic.test.ts`、`tests/web-branch-evidence.test.ts`、`tests/web-multi-root-cockpit.test.ts` 全绿、`npm run lint` 通过。
