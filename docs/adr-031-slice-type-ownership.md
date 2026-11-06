# ADR-031: SliceType 归位 core/slice

**状态**: 已实施
**日期**: 2026-11-06
**作者**: 系统架构
**关联约束**: C2, C3, C4, C5, C7
**关联文档**: `docs/adr-030-baseline-rebuild-and-arch-policy.md`, `docs/adr-027-arch-guard-policy.md`,
`policy/policy.yaml`, `policy/lock.json`, `scripts/rebuild-baseline-design.mjs`,
`.zelto/design/prj-1793970231984.json`

---

## 1. 摘要

ADR-030 §8 留下一个待人拍板的遗留项：**`SliceType` 该住在哪**。

它是**切片的分类**（`code` / `docs` / `config` / `refactor`），却定义在 `core/gate/types.ts`。
于是 `core/slice` 反过来依赖 `core/gate`，模块图上出现一条 `gate ↔ slice` 的环，
`policy.yaml` 里为此开了一条 `cycle: ask` 的临时豁免。

本次定案：

- `SliceType` 的**定义**移到 `core/slice/kind.ts`——它分类的是切片，不是门禁；
- `core/gate/types.ts` 保留 **re-export**，现有 import 路径不破；
- `detectSliceType` **留在 gate**——「按写集判定切片类型」是门禁侧选 profile 的逻辑；
- 结果：`core/slice` 不再依赖 `core/gate`，**环消失**，`policy.yaml` 的 `cycle: ask` 豁免可以删掉，
  回到默认 `deny`（fail closed）。

新基线设计 `prj-1793970231984`（supersedes `prj-1793964817452`），
`zelto arch check` 的偏离从 1 条降到 **0 条**。

---

## 2. 为什么现在做

ADR-030 把 `cycle: ask` 定为**临时豁免**，并在 `policy.yaml` 注释里写死了收紧条件：

> 收紧条件：`SliceType` 的归属定下来、`slice` 不再依赖 `gate` 之后，把这条改回 `deny`。

豁免留着不收，护栏就等于「不配所以不拦」——这正是 ADR-027 想避免的状态。
把遗留项做掉、豁免收回，护栏才是真的在守。

---

## 3. 决策

### 3.1 归属：`core/slice/kind.ts`

新文件 `src/core/slice/kind.ts`，只导出 `SliceType` 类型，**零 import**。

**为什么单独一个文件，而不是塞进 `core/slice/types.ts`**：

`core/slice/types.ts` 需要 `core/slice/store.ts` 的 `SliceSpec` / `SliceData`，
而 `store.ts` 又要用 `SliceType`——放在一起就形成**文件级互引环**
（类型级互引也是环）。单独一个零依赖文件，两边各引各的，谁都不成环。

**为什么不是「保持原样、只改模块声明」**：那等于让设计去迁就一个画歪了的边界。
`SliceType` 语义上属于 slice 域，gate 只是消费者——这是 ADR-030 §4 已经得出的结论，
本次只是把它落到代码上。

### 3.2 gate 侧：保留 re-export，不动 `detectSliceType`

```typescript
// src/core/gate/types.ts
import type { SliceType } from '../slice/kind.js';
export type { SliceType };
```

- **re-export 而不是删掉导出**：`core/gate` 仍需 `SliceType` 来给不同类型挑 profile，
  外部 import 路径不变——这次改的是**归属**，不是**契约**；
- **`detectSliceType` 留在 gate**：它读写集路径、判断该跑哪套门禁命令，
  是门禁逻辑，不是切片的定义。切片领域不需要知道「怎么按路径猜类型」。

于是 core 内部依赖方向变成单向：`gate → slice`（门禁消费切片数据与类型），
不再有 `slice → gate`。**环消失。**

### 3.3 基线重建

`core/slice` 的依赖声明从 `src/core/gate` 改为 `[无]`，`src/core` 的父级声明同步去掉 `src/core/gate`，
依赖关系图同步更新。新基线 `prj-1793970231984`，旧基线 `prj-1793964817452` 标 `superseded`。

重建走的是 `scripts/rebuild-baseline-design.mjs --plan adr-031`：
只做**确定性改写**（逐条带断言的字符串替换），再用 zelto 自己的判定路径
（`parse` → `derive` → `scan` → `report`）验一遍，命中 0 次或多次直接报错退出。

### 3.4 护栏收紧

删掉 `policy.yaml` 里的 `arch:` 段，回到**默认全 `deny`**。

理由不是「环不见了所以这条没用了」，而是：**现在没有任何一类偏离需要开口子**。
重建后六类硬偏离全部为 0，保留一条无用的 `ask` 规则只会让下一个人误以为护栏是软的。

`policy.yaml` 内容变了 → 锚点按「全文 sha256」重算（口径同 ADR-027 / ADR-030 §3.4）。

---

## 4. 约束合规检查

| 约束 | 检查 | 合规 |
|---|---|---|
| **C2** | `core/slice/kind.ts` 零 import；`core/gate` 仍零第三方依赖、仍不 import `adapters/` | ✅ |
| **C3** | 判定路径不变：类型定义是纯类型声明，不调模型、不触网 | ✅ |
| **C4** | 基线重建写了 `draft.created` / `draft.confirmed` 两条事件（append-only，未改旧事件） | ✅ |
| **C5** | `PROTECTED_PATTERNS` 未动；锚点按「policy.yaml 全文 sha256」重算并记明口径与批准人 | ✅ |
| **C7** | 全程不涉及模型产出；新设计正文是**已批准基线**的确定性改写 | ✅ |

禁区检查：未新增自动批准、自动合并、自动改规格；未新增事件类型；
护栏只**收紧**不放松。

---

## 5. 后果

**好的**

- 架构偏离从 1 条降到 **0 条**，报告第一次全绿；
- `cycle: ask` 豁免撤销，护栏回到 fail closed 的默认姿态；
- `core` 内部依赖方向单向化：`gate → slice`；
- 归属与语义对齐：切片的分类住在 slice 域。

**代价与边界**

- `core/gate/types.ts` 多了一处 re-export——刻意保留，换取 import 路径不破；
- 本次仍然只是**「zelto 检 zelto 自己」**：能验证归属改动后偏离确实归零，
  不能独立验证判定逻辑本身是对的（ADR-029 §4.3.1 的效力边界）；
- `core/slice/kind.ts` 的注释里提到 `core/gate`——那是文字说明，不是依赖边，不进 import 图。

**明确不做**

- 不动 `detectSliceType` 的实现；
- 不新增事件类型表达「依赖方向调整」；
- 不借这次改动去重构 `core/gate` 或 `core/sched` 的其它边界。

---

## 6. 验收标准

1. `zelto arch check` 对新基线输出 **0 条偏离**，退出码 0
2. `zelto arch check --strict` 退出码 0（无任何豁免）
3. `policy.yaml` 不再含 `arch:` 段，`zelto policy validate` 通过
4. `policy/lock.json` 的 `hash` 等于当前 `policy.yaml` 全文 sha256
5. 旧基线 `prj-1793964817452` 状态为 `superseded`，新基线为唯一 confirmed 的 `__project__` 设计
6. `.zelto/events/draft-design-prj-1793970231984/events.jsonl` 里有 `draft.created` → `draft.confirmed`
7. `npm run build` / `npm run lint` / `npm test` 全绿

---

## 7. 关联 ADR 的状态更新

- **ADR-030** §8 的遗留项（「`SliceType` 该住在哪」）由本文定案；
  §3.3 里 `cycle: ask` 的收紧条件已满足，豁免按该条撤销。
- **ADR-027** `arch:` 段机制不变——本次是**收回豁免**，机制本身第一次以「全 deny」的形态生效。
