# ADR-081：驾驶舱列表不许静默丢片，度量报告不许读四遍

**状态**：实施
**日期**：2026-11-18
**相关**：ADR-056（版本与切片是追溯锚点）、C4（事件与状态是追溯链）、§11.35（「绿灯」测的是哪份代码）

## 背景

驾驶舱（`zelto web`）自查时发现两件事：

1. **磁盘上 130 个切片文件，Web 列表只显示 113 个**；
2. 首屏要等近 300ms，而页面每 5 秒轮询一次度量端点。

两件事**都不是独立现象** —— 它们的根因是同一句话：

> **「一片坏掉」的处理方式，同时决定了「少片」能不能被看见，和「慢」有多慢。**

## 病灶一：17 片静默消失

少的 17 个不是坏了 —— 它们是**已完成交付**的切片
（`agent-timeout`、`ai-pipeline-*`、`hotfix-mode`、`parallel-flag` …）。

状态文件里的 `stall` 字段写成了 `null`，而不是 `{class: null, …}` ——
那是**停机分类落地之前**的写法。

失效链条：

```
store.read() 里 slice.stall.class
  → stall 为 null 时抛 Cannot read properties of null (reading 'class')
  → listSlices() 的 try/catch 把这一片静默吞掉
  → 文件在磁盘上、切片已交付，但人看的列表里查不到
```

**严重性在于「静默」**：切片的「存在」本身是追溯链的一环 ——
它消失了，人就查不到它了，而且**没有任何报错提示少了 17 片**。

> 这与 §11.33 的形状相同：**「查不到」比「算错」更难发现**。
> 算错会跟别的证据打架；查不到没人跟它打架。

### 修法（两半）

**① 归一化**（`core/slice/store.ts`）

`stall: null` 的语义就是「这片没停机」——
翻译成 `{class: null, autoResolved: 0, gateRetries: 0}` 是**如实**，不是编造
（`class: null` 也正是 `create()` 里的默认值）。

**读时 + 写时都归一化** = 闭环：老文件进来一次就变成正统写法，
之后不再产生新的坏文件。

**② 留痕**（`adapters/web/api.ts`）

即使将来又出现读不出的片，也**不许静默** —— 记一笔到 stderr：

```
[zelto web] 跳过状态文件读不出的切片：<id>
```

不是给用户看的横幅，是给排查的人留的线索。

> 「不让一片坏的挡住整个列表」这条**保留** ——
> 跳过是对的，静默是错的。

## 病灶二：每片的事件被读了四遍

`generateReport` 里每片要算三个指标（`rework_rate` / `cycle_time` / `stall_counts`），
而每个指标自己 `events.read(id)` —— 于是同一片的事件被读了**四遍**
（循环里一次 + 三个指标各一次）。

这个端点是驾驶舱「度量」页的数据源，而驾驶舱**每 5 秒轮询一次**。

### 修法：读一次，算三次

拆出三个**纯函数**（`reworkRateFrom` / `cycleTimeFrom` / `stallCountsFrom`），
`generateReport` 读一次事件流、三个指标复用同一份。

并发读所有片的事件流：一片读不出来不影响别的片。

### 为什么不用 `Promise.all(ids.map(...))` 一把梭

一把梭会让**一片坏导致整个报告都没了** —— 那比原来更糟。
所以是「并发读 + 逐片降级」。

## 实测（130 片，本机实测）

| | 优化前 | 优化后 | 提升 |
|---|---|---|---|
| `listSlices` | 51–80ms | 15–27ms | **约 3 倍** |
| `generateReport` | 96–113ms | 6–11ms | **约 15 倍** |

**结论没变**（这是重点）—— 优化前后同一份事件流算出**同样的**指标值，
由 `tests/metrics-read-once.test.ts` 钉住：

- 报告里的 `rework_rate` / `cycle_time` / `stall_counts`
  与单指标接口 `reworkRate()` / `cycleTime()` / `stallCounts()`
  的**值与 dimensions 完全相等**；
- `rework_rate` 为 `null` 时报告里**不得**有它；
- `eventCount` / `sliceCount` 不受影响。

而且「只读一次」这件事本身也被钉住（用计数版事件流断言读次数 == 片数）。

## 影响面

- `src/core/slice/store.ts`：新增 `normalizeStall()`，读时 + 写时归一化
- `src/adapters/web/api.ts`：`listSlices()` 改并发读；跳过时记 stderr
- `src/core/metrics/collector.ts`：三个指标拆成纯函数；报告改「读一次算三次」
- `tests/stall-null-normalization.test.ts`（8 条，新增）
- `tests/metrics-read-once.test.ts`（5 条，新增）
- `tests/web-list-slices-not-silently-dropped.test.ts`（3 条，新增）

## 不变量核查

- **C1**（状态只在文件里）：无影响 —— 归一化改的是**读出来**的内存对象；
  写时归一化会把正统写法落回文件（这是**修复**，不是新增状态位置）。
- **C2**（core 零第三方依赖）：无影响。
- **C3**（判定确定性）：**加强** —— 纯函数拆分不引入随机/时间依赖。
  注意 `MetricSnapshot.timestamp` 仍是 `new Date()` —— 那是**元数据**，
  不是判据（判据是 `value` 与 `dimensions`）。
- **C4**（append-only 事件流）：无影响 —— 只读事件，不改。
- **C5**（保护域外部化）：无影响。
- **C9**（写集预约运行时强制）：无影响。

## 验收标准

1. ✅ `stall: null` 的切片**读得出来**，且归一化成正统写法；
2. ✅ 写出去的文件里 `stall` 不再是 `null`（闭环）；
3. ✅ `listSlices()` 跳过读不出的片时**有 stderr 痕迹**；
4. ✅ 其余片照常列出（一片坏不挡住整个列表）；
5. ✅ `generateReport` 与单指标接口的结论**完全一致**；
6. ✅ 读次数 == 片数（读放大消除）；
7. ✅ `npm test` 全绿（2420 用例，0 失败）。

## 关联缺陷

- §11.33：「查不到」比「算错」更难发现 —— 同形状。
- §11.35：「绿灯」本身也是需要被复核的断言 ——
  本 ADR 修的是「绿灯覆盖的东西是不是真的在那儿」。

## 参考

- `docs/zelto-实战演练记录-20261116.md` §11.36
