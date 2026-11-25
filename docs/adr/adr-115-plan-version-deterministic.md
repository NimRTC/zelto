# ADR-115：从钉死的切片清单确定性建版本（`zelto plan version`）

**状态**：实施
**日期**：2026-11-25
**相关**：ADR-063（设计补丁：确定性修正不改别处）、ADR-110（版本计划双写）、ADR-114（计划对照）、C1、C3、C4

## 背景

nimrtc-v14 的 v1.4 收尾要把 13 个待做项补进**已确认**的计划，分波规则是「写哪个文件」（用户 2026-11-25 定）：模块内 → engine.hpp → CI/样例。每一波的切片清单、写集、依赖都是从 git 现场**逐项核实**出来的，可以逐字钉死。

既有两条路都走不通：

1. `zelto plan add-version <plan> <描述>` 走 LLM **生成**一整版 —— 版本号、依赖、写集都由模型编，要逐条核对；而且一次只能建一个版本。13 项 × 3 波要调三次，每次都要核对它编出来的写集是否与现场一致。
2. 手改 `.zelto/versions/<id>.json` —— 追溯链上的谎言（C4：文件变了、事件流里没有记录），而且只写真源会让被跟踪副本（`versions/`，ADR-110 决策六）与真源分叉。

`zelto plan patch` 是确定性的，但它**只改已存在的**切片/字段，不能加整版。

## 决策

新增 `core/version/create.ts` 的 `createVersion(plan, spec)` 与 CLI `zelto plan version`：

```
zelto plan version <plan-id> <v> --description <text> [--depends-on <v>] \
  [--slice <id> --slice-title <t> --slice-module <m> --write <p>...]...
```

- 调用方给出**全部**字段；函数只做**校验**与**归一化**，不猜、不补、不改别的版本；
- **不改入参**，返回新计划（与 `applyPlanPatch` 同口径）；
- 计划必须已 `confirmed`（未确认的计划用 `plan patch` 或重新确认）；
- 落盘走 `VersionStore.save`（真源 + 被跟踪副本双写），并写 `draft.revised` 事件，事件里带每个切片的写集与规格路径 —— 「这一版的边界是谁、什么时候、按什么钉下的」事后可查。

校验（全部确定性，C3）：

| 情形 | 结果 |
|---|---|
| label 非法（与 `isValidVersionLabel` 同口径） | 拒绝 |
| 版本已存在 | 拒绝（改已有版本用 `plan patch`） |
| 依赖不在计划里 / label 非法 | 拒绝（否则 `version start` 会因依赖未 integrated 而拦下） |
| 依赖成环（新版本参与的环） | 拒绝 |
| 切片 id 非法 / 本版内重复 / **计划内全局重复** | 拒绝（同一 id 两版 → `AmbiguousOwnershipError`） |
| 空版本 | 拒绝 |

写集归一化：去空白、反斜杠转正斜杠、去重；规格路径缺省 `specs/slices/<id>.md`。

## 与既有命令的分工

| 命令 | 用途 | 是否经 LLM |
|---|---|---|
| `plan <design-id>` / `plan add-version` | 探索：从设计/描述**生成**一版 | ✅ |
| `plan patch` | 修正已确认计划里**已存在**的切片/字段 | ❌ |
| **`plan version`** | 把**钉死的整版**加进已确认计划 | ❌ |

## 不做（边界）

- 不生成规格草稿（那是 `zelto spec draft`，要人确认后才冻结 —— ADR-034 的口径不变）；
- 不改版本状态（新版本一律 `planned`，由 `version start` 推进）；
- 不删版本（删整版仍是 `plan patch --remove-slice` 逐片删或另议）。

## 顺手修复

`zelto plan patch` 原来只 `atomicWriteText` 写 `.zelto/versions/<id>.json` 真源 —— 修完计划，CI 读到的 `versions/` 副本仍是旧的（ADR-110 缺陷四的同一个形状）。改为走 `VersionStore.save`（双写 + 读回验证）。

## 不变量核查

- **C1**：无新增状态；只多写一个已有的跟踪副本；
- **C2**：`core/version/create.ts` 只用 Node 内置，import 同目录模块；
- **C3**：纯计算，不调模型、不触网；
- **C4**：每次加版本写 `draft.revised`；失败不写盘；
- **C5 / C9**：无影响。

## 验收标准

1. `createVersion` 六类校验逐条有单测；
2. `zelto plan version` 落盘双写 + `draft.revised` 事件（`tests/plan-version-deterministic.test.ts`）；
3. 重复加同一版本 → 非零退出、计划不变；
4. 实测：nimrtc-v14 计划里用它建出 v4 / v5 / v6 三版（9 片），`version start v4` 顺利建出 `version/v4` 分支与集成目录。
