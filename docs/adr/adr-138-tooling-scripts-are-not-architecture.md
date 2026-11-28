# ADR-138：工具脚本不构成架构耦合，不报「文件无归属」

**状态**: 已接受
**日期**: 2026-11-28
**作者**: 系统架构
**关联约束**: C3, C4, C6
**关联文档**: `src/core/arch/scan.ts`, `src/core/arch/tooling-files.ts`,
`src/core/arch/test-files.ts`
**关联 ADR**: ADR-027（架构护栏）、ADR-066（测试依赖不是架构耦合）、
ADR-073（无模块归属的测试文件不报偏离）、ADR-065（vendor 边界）

---

## 1. 摘要

架构扫描把**工具脚本**（`tools/`、`scripts/` 下的 Python / JS 等）也算进
「模块归属」判定，于是报出「文件无归属」（`unmapped_file`）。

后果是**自锁**：任何一片要改工具脚本的切片，都会被
「这个工具脚本无归属」这条偏离拦住 —— 而这条偏离的成因是
**扫描器的归属模型覆盖不到工具目录**，不是那片切片真的违反了架构。

真实证据（nimrtc-v14 靶子项目，v1-transport-manager-tick 切片，2026-11-28）：

```console
$ zelto gate v1-transport-manager-tick
  Arch:     ❌ 架构护栏拦截：文件无归属×1（deny）—— 修好或改 policy.yaml 的 arch 段后再跑门禁
```

被拦的那 1 条偏离是：

```
unmapped_file  tools/check_engine_layering.py
  文件 "tools/check_engine_layering.py" 不在任何模块的负责范围里
```

而那片切片的产物本身**完全正确**：build 与 2516 个 ctest 用例全绿、
10 条验收标准全过、agent 的产物一行不多一行不少。

**决策**：工具脚本**不参与模块归属判定**，因此不报「文件无归属」。
判据与 ADR-066（测试文件）、ADR-065（vendor 代码）同一路子 ——
**不是这个项目的架构的东西，就不是这个项目的架构偏离。**

---

## 2. 背景

### 2.1 缺陷：工具脚本让切片自锁

nimrtc-v14 的确认设计 `dsg-1795166053036` 声明了 49 个模块，
文件范围覆盖 `src/**` 与 `examples/**`（`deriveModules` 的实测结果）。
**`tools/` 与 `scripts/` 都不在任何模块的范围内** —— 设计里没有它们，
因为它们不是架构的一部分，是开发工具。

但扫描器把仓库里所有「能读懂的源文件」都拿去判归属：

| 类别 | 判定 | 结果 |
|---|---|---|
| `tools/check_engine_layering.py` | `.py` → `detectLang` 返回 `python` → 进 `scanned` | 无模块认领 → **报偏离** |
| `scripts/api_freeze_scan.js` | `.js` → 返回 `ts` → 进 `scanned` | 无模块认领 → **报偏离** |
| `README.md` | `detectLang` 返回 `null` → **不进 `scanned`** | 不报偏离 |
| `CMakeLists.txt` | 同上 → 不进 `scanned` | 不报偏离 |

**关键不对称**：文档与构建脚本因为「扫描器读不懂」而天然躲过了归属判定，
而工具脚本恰好是 Python / JS —— **扫描器读得懂，于是它成了唯一被拦的一类**。

这个不对称是纯粹的巧合，不是设计：

- `tools/` 有 **76** 个文件无归属
- `scripts/` 有 **15** 个文件无归属
- 合计 **91 / 108** 条无归属偏离来自工具脚本

### 2.2 为什么「读得懂」反而更糟

工具脚本与测试文件有一个共同点：**它们在架构图之外，但它们是真实的生产投入**。

ADR-066 判测试文件「不构成架构耦合」，理由是「测试引用被测对象是测试的本职」。
工具脚本的理由是同一个：**一个检查脚本 import 项目的模块，是这个脚本的本职**
（`tools/check_engine_layering.py` 要读 `src/engine/src/**` 才能检查分层）。

判据应该是「**这个东西是不是这个项目的架构的一部分**」，
而不是「**扫描器能不能读懂它**」。

后者只是实现细节的泄漏。ADR-065 处理 vendor 代码时已经明确了这个立场：
引入的外部代码不是这个项目的架构 —— 哪怕扫描器读得懂它。

### 2.3 与 ADR-073 的同源性

ADR-073 修过一个几乎一模一样的坑：

> zelto 自己生成的验收骨架 `tests/acceptance/<id>/acceptance.test.cjs`
> 不存在于任何设计模块的文件范围里，于是被架构护栏判成 `unmapped_file`（默认 deny）
> → `zelto gate` 直接 blocked。
> **修这个触发的切片自己也过不去（自锁）。**

当时的结论是「zelto 自己生成的东西不该让切片过不去」，
处置是把**测试文件**整体排除出 `unmapped` 判定。

本 ADR 是同一条判据的延伸：**工具脚本**也是「不属于这个项目架构的东西」，
同样不该让它把改工具的切片锁死。

### 2.4 为什么此前没炸

因为**没有切片改过工具脚本**。整个 nimrtc-v14 历史上，
只有两个切片的写集碰过 `tools/` 或 `scripts/`：

| 切片 | 写集 | 结局 |
|---|---|---|
| `v1-transport-manager-collaborator` | `tools/check_engine_layering.py` | **abandoned** |
| `v1-transport-manager-tick` | `tools/check_engine_layering.py` | 本次被拦 |

第一个切片被放弃了 —— 所以这个坑一直躺着，直到 A4b6 撞上。

---

## 3. 决策

### 3.1 决策 1：工具脚本不参与模块归属判定

`scanArchitecture` 计算 `unmapped` 时，排除**工具脚本**：

```ts
const unmapped = scanned
  .filter((f) => f.module === null && !f.isTest && !isToolingFile(f.path))
  .map((f) => f.path);
```

### 3.2 决策 2：判据是**确定性目录约定**，不靠内容猜测

与 ADR-066 的测试文件识别同一路子：靠**路径**判定，不看文件内容。

工具脚本目录名（路径的**第一段**等于约定名即算）：

```
tools
scripts
```

**为什么只看第一段**：`src/engine/tools/` 这种嵌套位置不是「仓库的工具目录」，
而是某个模块内部的子目录 —— 它理应被那个模块认领。
只看顶层约定名，既覆盖了主流布局（`tools/` `scripts/` 都在仓库根），
又不会把模块内部的同名目录误排除。

**为什么不看内容**：看「这个文件是不是脚本」会误判 ——
`src/foo/scripts/run.py` 可能是真正的生产脚本。
内容猜测还会随文件演化而漂移（一个脚本加了 `import` 就变成「像代码了」）。

### 3.3 决策 3：工具脚本**不产生依赖边**

一个检查脚本读项目的模块，是这个脚本的**本职**（与测试同理）：

- `tools/check_engine_layering.py` 要读 `src/engine/src/**` 才能检查分层
- `scripts/api_freeze_scan.js` 要扫 `src/**` 的 API

这类引用**不是架构耦合** —— 它不构成「模块 A 依赖模块 B」。

多数项目里工具目录不被任何模块认领，脚本自身 owner 为 null，
那时边自然不会产生。但**若设计真的声明了 `tools/**` 模块**，
脚本就会拿到 owner 并产生边 —— 那是**假边**，
会伪造成「未声明依赖」甚至假环。所以这里显式排除：

```ts
if (isTestFile(path)) continue;      // ADR-066
if (isToolingFile(path)) continue;    // ADR-138
```

### 3.4 决策 4：工具脚本**单独计数**，不混进语言分母

与 ADR-066（测试）/ ADR-065（vendor）完全一致：
排除的是「架构偏离判定」，不是「文件存在」这个事实。

工具脚本仍是仓库的一部分，报告必须能说清「多少文件没参与验证」。
所以 `LangCoverage` 新增 `toolingFiles` 字段，报告里单独一行报：

```
开发工具脚本
  · 91 个工具脚本不参与架构检查 —— 脚本读取被操作对象是脚本的本职，不是架构耦合。
```

**分母同步扣除**（`checkedTotal`）：否则「已验证 47/138 个文件」这个数字
会把 91 个工具脚本算进「没验过」，让覆盖率失真。

### 3.5 决策 5：**不**引入配置开关

与 ADR-066 决策 2 的否决理由相同：留一个「关掉护栏」的旋钮，
只会让人有理由把它关掉。

「工具脚本不是架构的一部分」是**普遍规律**，不是项目特例 ——
几乎每个仓库都有 `tools/` 或 `scripts/`，而几乎没有任何设计文档
会为它们单开一个模块。

---

## 4. 被否决的方案

### 方案 A：给 `policy.yaml` 的 `arch:` 段加 `unmapped_file: ask`

**否决。** 那不是修复，是**放弃护栏**。

护栏拦的「文件无归属」在**生产代码**上是真问题（有人写了个
`src/orphan/foo.cpp` 谁都不认领，那是设计漏了）。把它整体降级成
`ask`，等于让真问题也不再拦。

而且 ADR-066 决策 2 已经明确否决过这条路的同款：
「留一个开关只会让人有理由把它关掉」。

### 方案 B：给设计补一个「工具链」模块，认领 `tools/**` 与 `scripts/**`

**否决。** 它把**项目的**负担转嫁给**每个使用 zelto 的项目**：
你用了 zelto，就得在自己的设计文档里给工具目录写一个模块。

而这个模块是**假的** —— 工具脚本不是架构模块，它没有「依赖」，
没有「被依赖」，不参与任何模块图。声明它只会给报告添一个
「0 个依赖边、0 条被依赖边」的噪声模块。

### 方案 C：把工具脚本当成 vendor 代码（ADR-065 路子）

**否决。** vendor 是**引入的外部代码**，工具脚本是**本项目自己写的**。
vendor 的内部结构不是本项目的设计决策；工具脚本恰恰**是**本项目的代码。

把两者混为一谈，会让报告说「本项目有 91 个 vendor 文件」—— 那是假话。

### 方案 D：只在**切片级过滤**时排除，整图报告仍报

**否决。** 那样整图报告仍会说「文件无归属×108」，
其中 91 条是噪音 —— 淹没真正该修的那几条。

ADR-027 §3.7 的切片级过滤解决的是「**别的模块**的漂移不该拦我这片」，
而这里的问题是「**这些文件根本不是架构的一部分**」——
是判定本身错了，不该靠过滤打补丁。

### 方案 E：只排除 `.py` / `.js`，保留「读得懂的语言」都报

**否决。** 那是把当前的不对称固化下来。`tools/foo.cpp` 同样是工具脚本，
同样不该报。

---

## 5. 影响

### 对 zelto

| 内容 | 位置 |
|---|---|
| 工具脚本识别 | `src/core/arch/tooling-files.ts` —— `isToolingFile()` / `partitionToolingFiles()` |
| 接入扫描 | `src/core/arch/scan.ts` —— `unmapped` 排除 + 依赖边排除 + 覆盖统计 |
| 覆盖统计字段 | `src/core/arch/types.ts` —— `LangCoverage.toolingFiles` |
| 报告展示 | `src/cli/commands/architecture.ts` —— 「开发工具脚本」一行 + 分母扣除 |
| 导出 | `src/core/arch/index.ts` —— 供测试与报告层引用 |

**契约变更**：无 `contracts/schemas/` 改动 ——
这不是事件类型、不是配置格式、不是 schema。

但 `LangCoverage` 是 `core/arch` 的**内部类型**（CLI 报告层的输入），
新增 `toolingFiles` 字段属于内部结构调整，不是对外契约。

**`policy.yaml`**：护栏配置不动，锚点（`policy/lock.json`）不动。

### 对使用 zelto 的项目

- 改工具脚本的切片不再自锁
- 整图报告的「文件无归属」数字回归真实（只剩真正无归属的生产代码）
- 工具脚本仍计入文件数与覆盖统计 —— 报告不骗人

### 回归风险

**生产代码的无归属仍要报。** 本 ADR 只排除顶层 `tools/` `scripts/` 下的文件；
`src/` 下任何无归属的文件照旧报偏离。这条由单元测试双向锁定。

---

## 6. 不变量自查

| 约束 | 满足方式 |
|---|---|
| C1 | 不新增状态位置；判定是纯计算，读文件得出结论 |
| C2 | `core/arch/tooling-files.ts` 只用 Node 内置，不 import `adapters/` |
| C3 | 判定是纯路径前缀匹配，不调模型、不触网、确定性 |
| C4 | 不新增事件类型（`arch check` / `gate` 保持只读，退出码即信号） |
| C6 | `core/arch/` 内，不 import `adapters/`；`adapters/` 单向下依赖 `core/` |
| C7 | 不涉及 LLM 产出 |

禁区检查：未新增自动批准、自动合并、自动改规格；
未在 `core/policy/`、`core/gate/`、`core/sched/` 引入任何新判定口径。

---

## 7. 追溯

- 实战证据：nimrtc-v14 `v1-transport-manager-tick`（2026-11-28），
  门禁被「文件无归属×1（deny）」拦下，被拦文件 `tools/check_engine_layering.py`
- 关联 ADR：ADR-027（架构护栏）、ADR-066（测试依赖）、ADR-073（验收骨架自锁）、
  ADR-065（vendor 边界）

### 实施验证（2026-11-28）

| 项 | 结果 |
|---|---|
| zelto 单元测试 | 3716 通过 / 0 失败（新增 `tests/arch-tooling-files.test.ts` 10 条全过） |
| biome lint | `src/` `tests/` 全绿 |
| 类型检查 | `tsc --noEmit`（src）与 `tsc -p tsconfig.test.json` 均 0 错误 |
| nimrtc-v14 arch check | `unmapped_file` 由 108 → 17；`tools/check_engine_layering.py` 已消失 |
| nimrtc-v14 gate | `v1-transport-manager-tick` 门禁通过（build + ctest 全量 + 验收 10 条） |
| 签字与合并 | 已签字、已合入 `version/v5`（commit `598c46e9`） |

**残留的 17 条 `unmapped_file`** 全是真正无归属的**生产/互操作**代码
（`interop/**` 12 个 + `src/log/src/log.cpp` 等），与本 ADR 无关 ——
它们该被设计认领，不该被工具脚本的处置顺带吞掉。

