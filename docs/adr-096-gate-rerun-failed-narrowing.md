# ADR-096：门禁失败重跑按失败用例收窄（`--rerun-failed` 修正确认 + 内部重试复用）

## 状态

**已接受并实现**（2026-11-23）—— 实测数据见「背景」，实现见「影响面」

## 背景

ZD-027（门禁失败精准提取）已在 nimrtc-v14 上落地，但配套的 `--rerun-failed`
开关在**真实项目上是不工作的**。本 ADR 记录两个已实测确认的缺陷，
以及把它们修好的方案。

### 实测数据（nimrtc-v14，`.zelto/events` 全量统计）

| 门禁命令 | 次数 | 总耗时 | 占比 |
| --- | --- | --- | --- |
| `test` | 15 | 4055s | **90%** |
| `build` | 15 | 439s | 10% |

门禁墙钟合计 4494s（约 1.25 小时），**九成在 `test` 上**。

更刺眼的是重试：6 次 `gate.retry`，**全部是全量重跑**：

```
RETRY slice=v1-device-policy        cmd=test   attempt=1/1 prevExit=8
RETRY slice=v1-device-policy        cmd=test   attempt=1/1 prevExit=8
RETRY slice=v1-device-policy        cmd=test   attempt=1/1 prevExit=8
RETRY slice=v3-n4-d6-connectivity   cmd=build  attempt=1/1 prevExit=1
RETRY slice=v3-n4-d6-connectivity   cmd=test   attempt=1/1 prevExit=8
RETRY slice=v3-n4-d6-connectivity   cmd=test   attempt=1/1 prevExit=8
```

`v1-device-policy` 一片光 `test` 就花了 1254.6s（5 次全量）。其中 3 次是
**纯浪费**：失败原因是确定性的（同样的用例、同样的断言），重跑 2333 个用例
只为了再次确认同一个失败。每次约 270s，合计约 810s。

### 缺陷一：`isCtestCommand` 认不出被 `cmd /c` 包起来的 ctest

nimrtc 的门禁命令是：

```yaml
- name: test
  run: cmd /c "ctest --test-dir build --output-on-failure -C Debug --timeout 120"
```

现实现用 `/(?:^|[\s&|;(])ctest(?:$|[\s&|;)])/` 判定。实测：

```
false | cmd /c "ctest --test-dir build --output-on-failure -C Debug --timeout 120"
true  | ctest --test-dir build
true  | cmd /c ctest --test-dir build
```

**`cmd /c "ctest ..."` 判为 false** —— 收窄逻辑对 nimrtc 直接失效。
也就是说：`--rerun-failed` 恰好在它被开发出来的那个项目上不工作。

成因：`ctest` 前面是 `"`，不在字符类 `[\s&|;(]` 里。

### 缺陷二：`-R` 的正则里 `|` 在 Windows cmd 下是管道符

`buildCtestRerunFilter` 生成 `^(?:A|B)$`。Windows 上 `cmd` 把 `|` 当管道符。
实测（`spawn(shell:true)`，与 executor 一致）：

```
"echo ^(?:A|B)$"                  => exit 255, 'B)$' 不是内部或外部命令
"cmd /c \"echo ^(?:A|B)$\""      => exit 255, 'B)$' 不是内部或外部命令
"cmd /c \"echo \"^(?:A|B)$\"\""  => exit 255
```

即：**命令直接跑不起来**，门禁报的是一个与被测代码毫不相干的错。

### 缺陷三：`-R` 参数在 `cmd /c "..."` 里引号嵌套不可靠

`cmd /c "ctest -R "^(?:A|B)$" ..."` 的引号配对由 cmd 自己的规则决定，
实测输出为 `"^(?:A|B)$"`（引号被吃进参数值）。可靠性不足。

### 缺陷四：`ctest --tests-from-file` 有假绿陷阱（已实测）

```
ctest --tests-from-file <不存在的名字>  → exit 0, stderr: "No tests were found!!!"
ctest --tests-from-file <空文件>        → exit 0, stderr: "No tests were found!!!"
```

**没匹配到任何用例时 ctest 退出码是 0** —— 这是 ADR-033 记录过的同一类坑
（退出码 0 不等于「验过了」）。若直接照搬，收窄逻辑会在「过滤条件写错」时
让门禁**假绿**。

## 决策

### 决策一：过滤用 `--tests-from-file`，不用 `-R` 正则

CTest 有两个可选机制：

| 机制 | 形式 | Windows 安全 | 假绿风险 |
| --- | --- | --- | --- |
| `-R <regex>` | 命令行内嵌正则 | ✗ `\|` 被当管道符 | 无 |
| `--tests-from-file <f>` | 文件里逐行列**精确**用例名 | ✓ 无正则元字符 | ✗ 无匹配时 exit 0 |

选 `--tests-from-file`：用例名是**精确串**（`Suite.Test`），本来就不需要正则；
用精确串就彻底避开 `|` `(` `)` `.` 等全部元字符 —— Windows 上没有引号陷阱。

**代价是要处理假绿**，见决策二。

### 决策二：过滤结果必须自证「跑到了用例」

沿用 ADR-033 的思路：退出码 0 不等于「验过了」。

收窄后的 ctest 跑完，检查输出里是否真的出现了被筛选用例：

- 输出包含 `No tests were found!!!` → 视为**失败**（筛选用例名对不上），
  并在错误里说清楚「过滤条件与实际用例名不匹配」。
- 输出里**看不到任何**被筛选用例名 → 同样视为**失败**。

理由：宁可门禁红（人来看一眼），也不要门禁绿但其实什么都没跑。

**这条只对「收窄后的那一轮」生效**，且只在**退出码为 0** 时检查 ——
退出码非 0 的失败本来就红，不需要额外判定。

### 决策三：写入的用例清单文件是**临时文件**，跑完删掉

清单文件写在**门禁工作目录**（worktree 根）下的一个固定名临时文件，
例如 `.zelto-gate-tests-<sliceId>.txt`。

- 位置固定 → 命令行里只需要一个相对路径，不用处理 Windows 路径里的空格/引号；
- 名字带 sliceId → 多个切片并行跑门禁不会互相覆盖；
- 跑完删掉 → 不留垃圾。

**为什么不用系统临时目录**：系统临时目录在 Windows 上路径深、含用户目录名，
且 `--test-dir` 与临时目录不在同一卷时 CTest 的行为有差异；
放在工作目录里路径最短、最可预测。

### 决策四：门禁**内部重试**自动复用「只重跑失败用例」

这是本次 ADR 收益最大的一条。

现状（`core/gate/executor.ts` 的 `runWithRetry`）：重试跑的是**完全相同的命令**。
对 `test` 命令而言，就是再跑一遍全部 2333 个用例。

改为：**重试时，如果上一轮失败且能识别出失败用例**，把命令收窄成
「只跑那些失败用例」。

为什么这不是「少验了」：重试的语义是「再试一次，看是不是偶发」。
- 全量重试：验证的是「这 2333 个用例整体的状态」；
- 收窄重试：验证的是「上次失败的那几个用例现在还失败吗」。

对「测试失败」这一失败原因，后者才是重试该回答的问题。
而且第一轮**已经全量跑过了** —— 全量覆盖没有丢，只是把重试的边际成本降下来。

**收窄重试跑通后，是否还要再全量跑一次？** 不。收窄重试通过 ⇒ 上一轮的
失败用例现在都过了 ⇒ 结合第一轮的全量通过，结论成立。

**收窄不可用时怎么办？** 退回全量重试（原有行为）。宁可慢，不漏验。

### 决策五：`isCtestCommand` 的判定放宽

改为在整条命令里找 `ctest` 这个**词元**（含扩展名，如 `ctest.exe`），
并卡住前后边界：

- **前置边界**必须是命令分隔符（空白、引号、`=`、`&`、`;`、`|`、`(`）或串首；
- **前置是路径分隔符**时，整条路径必须指向 ctest **工具** ——
  判据是**扩展名**：`exe` / `cmd` / `bat` / `com` / `sh` 算工具，
  `cjs` / `js` / `py` 算脚本（是别的工具的参数，不是 ctest）；
  没扩展名也算工具（POSIX 的 `/usr/bin/ctest` 就是无扩展名的）；
- **后置边界**必须是分隔符或串尾（挡住 `ctester`）。

判定只看「这条命令里有没有 ctest 工具」，不改命令本身 —— 收窄仍然是**追加**
`--tests-from-file`，人显式写了过滤参数时**不叠加**。

**为什么不用简单的 `\bctest\b`**：那样会把 `node "/tmp/ctest.cjs"` 里的
`ctest.cjs` 也认成 ctest 工具，于是收窄参数会被插进别人的文件名里 ——
把命令改坏比不改更糟。

**为什么不是简单的「前面有引号就行」**：那样 `C:/cmake/bin/ctest.exe`
（ctest 在 PATH 里的绝对路径上，是真实场景）就认不出来了。

### 决策六：`--rerun-failed` 与内部重试复用同一套纯逻辑

`core/gate/diagnostics.ts` 里已经有 `narrowCommandsToFailedTests`（纯计算）。
本次把它升级成两种后端：

- `narrowCtestCommandByRegex`（现有 `-R` 形态）—— **保留但不再默认**，
  因为它在 Windows 上不可靠；
- `narrowCtestCommandByFile`（新，`--tests-from-file` 形态）—— 默认使用。

两者都在识别不出时返回 null，调用方退回全量。

## 影响面

1. `core/gate/diagnostics.ts` —— 新增 `--tests-from-file` 形态的收窄逻辑
   （`narrowCtestCommandByFile` / `narrowCommandsToFailedTestsByFile`）；
   新增 `verifyNarrowedTestsRan`（假绿安全阀）；
   `isCtestCommand` 放宽为「词元 + 路径形态按扩展名判」。
   旧的 `-R` 形态保留（POSIX 兼容），不再默认使用。
2. `core/gate/executor.ts` —— `runWithRetry` 内部重试接入收窄；
   新增 `buildRetryNarrowing` / `removeNarrowingManifest`。
3. `core/lifecycle/gate.ts` —— `--rerun-failed` 走清单文件形态；
   清单清理用 `try/finally` 覆盖**所有**出口
   （dry-run / 护栏拦截 / 护栏待确认 / 正常跑完）。
4. `core/gate/types.ts` —— 无需改动（`GateResult` 字段已由 ZD-027 引入）。

**不改契约**：`config.yaml` 的形状不变，事件类型不变（只在既有 payload
里多加 `narrowedToTests` / `narrowedManifest` 两个字段），`.zelto/` 布局不变。
清单文件是**临时产物**（跑完即删），不是持久状态。

## 后果

- nimrtc 的 6 次重试，从 6 × 270s 降到 6 × ~5s（只跑失败用例），
  预计省约 **1590s（约 26 分钟）**。
- `--rerun-failed` 从「在 nimrtc 上不工作」变成可用。
- 假绿风险被决策二堵住：筛选用例名对不上时门禁红，不绿。

## 验证记录

- 全量测试：3057/3057 通过（基线 3033 + 新增 24 项）。
- 新增测试：`tests/adr096-gate-rerun-narrowing.test.ts`（23 项，含 2 项端到端）、
  `tests/zd027-gate-failure-diagnostics.test.ts` 新增 3 项（executor 级）。
- 端到端用 nimrtc 的**真实命令形态**验证过：
  `cmd /c "ctest.cmd --tests-from-file .zelto-gate-tests-<id>-0.txt --test-dir build ..."`
  —— 收窄参数正确落在 `cmd /c` 的引号内，真跑能跑通。

## 备选方案

**用 CTest 原生的 `--rerun-failed`。** 否决：它依赖
`Testing/Temporary/LastTestsFailed.log`，而该文件由**上一次 ctest 运行**写入，
在「门禁第一次跑」「换了 build 目录」「worktree 里 build 树是新的」等场景下
不存在或过期（nimrtc 实测报 `Problem reading file: .../Testing/Temporary/`）。
zelto 自己已经抽出了失败用例名，不该再引入一个隐式状态源。

**继续用 `-R` 但转义 `|`（写成 `\|`）。** 否决：cmd 的转义规则在嵌套引号里
不可靠（实测 `echo "A^|B"` 才work），且用例名里的 `.` `(` `)` 仍需各自转义，
组合起来又是一套要维护的转义规则 —— 正是 ADR-051 否决「复制一份必然发散的
规则」时说的那类东西。精确串没有这个问题。

**按写集推导受影响用例，只跑相关模块的用例。** 否决（作为本次范围）：
推导规则藏在项目的 CMake 宏里（nimrtc 的 `nimrtc_add_test` 做了
`string(REPLACE "/tests/" "_test_")`），工具复制一份就是复制一份必然发散的规则；
猜错了会让门禁**少跑**用例（比多跑危险得多）。ADR-051 已就同类问题做过否决。
若要推进，应作为独立议题：**由项目侧显式声明**「模块 → 用例」的映射，
而不是工具猜。
