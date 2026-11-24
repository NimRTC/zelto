# ADR-097：门禁作用域 —— 按写集收窄「构建什么、跑哪些用例」

## 状态

已接受（2026-11-23）

## 背景

### 战场数据（nimrtc-v14 实测）

ZD-028 已把「门禁重试是全量重跑」量化了：门禁墙钟 4494s（1.25 小时），
其中 `test` 命令 4055s（**90%**），`build` 命令 439s（10%）。

但那只是**重试**的账。**第一轮**同样是全量的：

| 切片 | 门禁次数 | 每次用例数 | 每次耗时 |
| --- | --- | --- | --- |
| v1-device-policy | 5 | 2333 | ~270s |
| v3-n4-d6-connectivity | 3 | 2387 | ~290s |

而这些切片的**写集**是什么？

```
v1-device-policy:
  src/modules/video_capture/**
  src/modules/audio_device/**
  src/engine/**
  src/plugins/include/nimrtc/plugins/capture_device_events.hpp
  src/plugins/include/nimrtc/plugins/video_capture.hpp
  examples/remote-desktop/**
  docs/api/engine_api.md
  docs/api/public_headers.manifest
  tests/acceptance/v1-device-policy/acceptance.test.cjs
  tests/test_api_classification.cpp

v2-ice:
  src/modules/ice/**
  src/modules/sdp/**
  src/plugins/include/nimrtc/plugins/ice_transport.hpp
  tests/acceptance/v2-ice/acceptance.test.cjs
  tests/test_api_classification.cpp
  docs/api/public_headers.manifest
  CHANGELOG.md
```

`v2-ice` 只碰了 ice 与 sdp 两个模块，却要跑**全部 2387 个用例** ——
其中 audio、video、webrtc、dtls 的用例**一个都没被这次改动影响**。

### 这不是「门禁太慢」，是「门禁没在说该说的话」

更严重的后果不是时间，是**信号被稀释**。

2337 个用例跑完，输出里混着 2337 个用例的通过/失败记录。agent 拿到门禁
反馈时，要自己在 400KB 的输出里找「哪个用例跟我有关」。ZD-027 抽出了失败
用例清单，缓解了「失败时找不到」的问题，但**没有解决「跑了一堆跟我无关的
用例」** —— 那 2300 个无关用例的通过记录，是纯噪声。

而且它制造了一个危险的错觉：**门禁跑的是全量，所以门禁过了就是「整个
项目都好了」**。当门禁改为只跑相关用例时，这个错觉会消失 —— 而这正是
我们要的：**门禁过了应该意味着「我这片的改动是好的」，不是「整个项目
碰巧没坏」**。

### 已有机制为什么不够

三条已有的路都走不通：

1. **`spec.gateCommands`（ADR-051）** —— 让人**手写**本片的门禁命令。
   有效，但要求人知道 CMake 目标名（`nimrtc_add_test` 宏会做
   `string(REPLACE "/tests/" "_test_")` 再拼源文件名，猜不出来），
   而且**每片都要写一遍**。写错目标名 = 门禁构建**别的**目标，
   报一个跟本片无关的错（实战演练记录里踩过：`test_engine_dtmf_test`
   不存在，因为 `nimrtc_add_engine_test` 不加 `_test` 后缀）。
   能不能让工具从写集推出目标名？ADR-051 已明确否决：推导规则藏在项目的
   CMake 宏里，工具复制一份就是复制一份必然发散的规则。

2. **`--rerun-failed`（ZD-027 / ADR-096）** —— 只在**已经失败过**之后
   收窄。它救的是「重试的边际成本」，救不了「第一轮就跑全量」。

3. **CTest `-R` 正则** —— CTest 的用例名（如
   `src_modules_ice_tests_test_ice_test.IceCandidateBuild`）与**源文件
   路径**之间没有可推导的对应关系（gtest_discover_tests 把 `Suite.Case`
   拼在前面，名字里没有路径）。而且 ADR-096 已实测确认：Windows 上 `cmd`
   把 `|` 当管道符，正则会把命令打崩。

## 决策

### 决策一：作用域由**项目侧显式声明**，工具只做匹配

新增配置段 `gate.scope`：

```yaml
gate:
  scope:
    # 规则：写集路径模式 → 作用域标签
    rules:
      - match: "src/modules/ice/**"
        labels: ["ice"]
      - match: "src/modules/sdp/**"
        labels: ["sdp"]
      - match: "src/modules/video_capture/**"
        labels: ["video_capture"]
      - match: "src/engine/**"
        labels: ["engine"]
      - match: "tests/test_api_classification.cpp"
        labels: ["api_classification"]
    # 兜底：一条写集都没命中任何规则时怎么办
    fallback: full
```

**为什么由人声明，而不是工具推导**：

- 推导规则（模块 → 目标名 / 标签）**本来就在项目里**（CMake 宏、
  标签约定）。工具去猜 = 复制一份必然发散的规则（ADR-051 的教训）。
- 「这片改动影响哪些用例」**是一个判断**，不是一次计算。
  `src/engine/**` 影响哪些用例？引擎改动可能影响所有模块的用例 ——
  这取决于引擎的依赖图，工具读不出来，也不该读。
- 人声明的规则**可以审计**（在 config.yaml 里，有 diff、有 review），
  工具推导的规则**不可审计**（藏在代码里，跟着 CMake 宏漂移）。

**工具做什么**：把切片的写集**按规则匹配**成标签集合，用标签去收窄
门禁命令。**工具不做什么**：不推导目标名、不推断依赖、不猜。

### 决策二：作用域以 **CTest 标签**为唯一落点

CTest 原生支持标签：`add_test(NAME X ...)` + `set_tests_properties(X
PROPERTIES LABELS "ice")`。而 `ctest --show-only=json-v1` 会把**用例名 +
标签**一起吐出来（已实测，见「技术验证」）。

于是收窄机制完全复用 ADR-096 已有的 `--tests-from-file` 清单文件 ——
**同一套机制、同一个坑（Windows 管道符）、同一个假绿防线**。

标签匹配用 `-L`（精确标签）还是 `-R`（名字正则）？用 **`-L`**：

- `-L` 是精确匹配标签，没有正则元字符 → **没有 Windows 管道符问题**；
- `-L` 是 CTest 的**一等概念**，不依赖用例名的命名约定
  （nimrtc 的用例名里根本没有模块路径）。

但 `-L` 有个限制：**一个标签匹配全部带它的用例**。要精确到「只跑
ice 模块的用例」而不是「所有带 ice 标签的用例」，需要 `--tests-from-file`
（精确用例名清单）。所以：

- **第一层（粗筛）**：`-L <label>` —— 用于「快速看一眼这个标签下有
  多少用例」，以及没有精确需求时的兜底；
- **第二层（精确）**：`--tests-from-file <清单>` —— 清单由
  `ctest --show-only=json-v1` 的输出**精确筛出**带目标标签的用例名生成。

**默认走第二层**。清单由工具生成（从 ctest 自己的 JSON 输出里筛），
不走正则，所以没有元字符陷阱。

### 决策三：**标签是「工具与人之间的契约」，所以标签必须在项目里真的存在**

这是本 ADR 最重要的一条约束。

如果项目没给用例打标签，作用域规则就**匹配不到任何用例** —— 此时
**绝不许跑 0 个用例然后判门禁通过**。

**假绿是这里最危险的失败模式**：收窄后 ctest 找不到用例时**退出码是 0**
（ADR-096 决策二已实测确认：`No tests were found!!!`）。

**实现口径（2026-11-23 落地时确定）**：标签匹配到 0 个用例时
**门禁直接判失败**，而不是「退回全量」。理由：

- 「退回全量」听起来更安全，但它把一个**配置错误**（标签名写错了 /
  项目还没打标签）伪装成一次正常门禁 —— 人看到「门禁过了」，
  实际上「作用域规则根本没生效」这件事被**静默吞掉**了；
- 判失败会**逼出**这件事：「你的作用域规则匹配不到任何用例，
  请修规则或确认项目已打标签」。这正是「宁可少一个功能，
  也不许破一条不变量」；
- 门禁失败的成本（人看一眼就改）对齐了「假绿」的代价。

配套的两道防线：

- **清单生成为空** → 不跑那条命令，门禁判失败，失败原因写明
  「标签在 N 个用例里一个都没匹配到」；
- **收窄跑完退出码 0 但输出里看不到任何被筛选用例** → **判失败**
  （复用 ADR-096 的 `verifyNarrowedTestsRan`）。

注意「退回全量」仍然存在于**另一个层级**：写集**没命中任何规则**时
（`source: "fallback-full"`）→ 跑全量。那是「规则没覆盖到这片」
而不是「规则覆盖了但标签不存在」，两种情况要分开对待。

### 决策四：`fallback` 默认 `full`（宁可慢，不漏验）

一条写集都没命中任何规则时（常见于：项目还没配 `gate.scope`、写集是
glob 且规则写窄了、写集包含了 `CMakeLists.txt` 这类全局文件），
默认**跑全量**。

`fallback: full` 是安全默认。`fallback: none`（不跑任何用例）**不提供** ——
那等于「门禁可以什么都不验就通过」，与 C3/C7 的追溯精神直接冲突。

### 决策五：作用域**不改变**「门禁过了意味着什么」—— 但必须**留痕**

作用域收窄后，门禁过了的含义从「全项目测试通过」变成
「**本片相关**的测试通过」。

这个语义变化必须让人看得见，否则就变成了「悄悄降级的门禁」——
那正是 AGENTS.md 说的「声称的强度与实际强度不一致」。

因此 `gate.executed` / `gate.result` 事件必须记：

- `scoped: true/false` —— 这轮是不是收窄跑的；
- `scopeLabels: ["ice","sdp"]` —— 按哪些标签收窄的；
- `scopeTestCount: 137` —— 收窄后实际跑了多少个用例；
- `scopeTotalTestCount: 2387` —— 全量有多少个（对比用）；
- `scopeSource: "config" | "fallback-full" | "no-config"` —— 为什么
  收窄 / 为什么没收窄。

**并且**：签字复查的「验收真跑过本片」一项必须能看出这轮跑的是不是
本片相关用例。这一条留给 ADR-098 单独处理（本次不改动签字判据 ——
**改判据需要单独决策**，本次只保证事件里有足够信息）。

### 决策六：作用域是**可选**的，缺省行为零变化

没配 `gate.scope` → 门禁跑全量，行为与今天**完全一致**。

不改配置的老项目升级 zelto 后，行为不变。这是加法的承诺。

### 决策七：`--full` 是**人**的出口

配置里的规则是「机器按规则收窄」，但**规则可能漏**（项目后来新增了
一个模块，规则还没加；或者规则的手势写窄了）。

所以必须留一个人显式的出口：`zelto gate <id> --full` → 这轮**强制跑
全量**，不做任何收窄。

理由与 ADR-051 的「不自动合并」同源：**收窄是工具的判断，
全量是人的判断**。工具不因为「规则看起来覆盖了」就替人决定
「这次可以少验」—— 人说全量就跑全量。

`--full` 时的门禁输出会写明「人显式要求跑全量」，与「规则没命中」
区分开 —— 后者是配置问题，前者是人的决定。

## 技术验证（已实测，2026-11-23）

在真实 CMake 4.0.0-rc4 / CTest 4.0.0-rc4 上验证：

### 1. `ctest --show-only=json-v1` 能拿到用例名 + 标签

```json
{ "tests": [
  { "name": "Ice.CandidateBuild",
    "properties": [ { "name": "LABELS", "value": ["ice","module"] } ] },
  { "name": "Sdp.ParseOffer",
    "properties": [ { "name": "LABELS", "value": ["module","sdp"] } ] }
]}
```

退出码 0，输出在 **stdout**（stderr 另有内容 —— 解析时只取 stdout）。

### 2. `--show-only` 可以附加到已有命令尾部

```
ctest --test-dir build --output-on-failure -C Debug --timeout 120 --show-only=json-v1
```

→ 退出码 0，输出 JSON。**追加而不替换原命令**的意义：门禁命令里的
`--test-dir` / `-C Debug` / `--timeout` 等参数全部自动继承，
不需要 zelto 再去解析命令行各参数（那又是一份必然漂移的解析器）。

### 3. nimrtc 的用例名**不含模块路径** —— 这正是要用标签的原因

实测 `build/src/modules/ice/tests/` 下 gtest_discover_tests 生成的
include 文件，用例名形如 `test_ice_test.IceCandidateBuild` ——
**没有 `src/modules/ice` 这个路径成分**。所以「从用例名反推源目录」
这条路对 nimrtc 根本不成立；标签是唯一可靠落点。

### 4. nimrtc 当前**没有**给用例打标签

`cmake/NimRTCTest.cmake` 的 `nimrtc_add_test` 只调 `add_test(NAME ...)`，
没有 `set_tests_properties(... LABELS ...)`。

**这意味着：nimrtc 要用上这个能力，必须先在项目侧加标签** ——
这正是「决策三」要表达的：**能力是协作出来的，工具不猜**。

zelto 侧要做的：标签匹配不到用例时**退回全量并说清楚**
（`scopeSource: "fallback-full"` + 一句人话说明），而不是静默跑 0 个。

## 影响面

### 判定住在 `core/`，编排住在 `core/lifecycle/gate.ts`（ADR-086 口径）

新文件 `src/core/gate/scope.ts`：

- `parseScopeConfig(block)` —— 解析 `gate.scope` 段（纯解析，C3）；
- `matchScopeLabels(writes, rules, pathMatches)` —— 写集 → 标签集合
  （纯计算，C3）；
- `resolveScope(writes, scopeCfg, pathMatches, forceFull)` —— **作用域判定的
  唯一入口**（CLI 干跑 / Web / executor 三处共用，避免口径分叉）；
- `selectScopedTestNames(cTestJson, labels)` —— ctest JSON → 精确用例名
  清单（纯计算，C3）；
- `buildCtestEnumerateCommand(run)` —— 在 ctest 命令上追加
  `--show-only=json-v1`（纯字符串拼接，C3）；
- `scopeManifestFile` / `buildScopeManifestContent` —— 清单文件名与内容。

`core/gate/scope.ts` **零第三方依赖、不 import adapters/**（C2/C6），
**不调模型、不触网**（C3）。

### 四处读门禁配置的地方都要认作用域（否则又分叉）

同 ADR-045 的教训：

1. `core/gate/executor.ts` —— 门禁②真正执行的地方（收窄在这里发生）；
2. `core/lifecycle/gate.ts` —— 编排层（干跑也要算作用域，否则「干跑看到的」
   与「真跑跑的」不一样，干跑就失去意义了）；
3. `cli/commands/run-support.ts` 的 `autoGateAfterRun` —— **自动门禁**，
   必须与手动门禁同一套规则（否则「agent 验过的」与「门禁验的」口径不一致）；
4. `cli/commands/gate-sign.ts` —— `zelto gate` 自己组装 GateConfig 的地方；
5. `adapters/web/api.ts` —— Web 端走 `core/lifecycle/gate.ts`，
   传同一份 `config.gate.scope`。

**尤其是第 3 处**：ADR-045 已经为「命令一致」吃过一次教训；
ADR-097 之后，口径要一致的东西从「命令原文」扩展到「**跑哪些用例**」。

### 约束包要带上作用域信息

agent 拿到的不只是命令原文，还有「这轮门禁会验哪些用例」。否则 agent
会以为「门禁跑全量、我跑 3 个用例就行」，两边口径不一致。

实现落在 `ConstraintBundle.gateScope`（`core/sched/types.ts`）——
`buildConstraints` 多收一个参数，`buildInstructions` 多渲染一段：

```markdown
## Which tests the gate will run
The gate narrows its test run to the ones related to your write-set.
Labels: `ice`, `sdp`.
Reason: 写集命中 2 条作用域规则 → 收窄到标签：ice、sdp

Verify against **the same scope**. Running only a handful of tests and
assuming the rest are fine is exactly what the gate would not accept.
```

**这段话必须说「同一个作用域」** —— 不说的话 agent 会以为
「门禁跑全量、我跑 3 个用例就行」，然后在门禁收窄时**漏验**，
或者反过来（agent 跑全量、门禁收窄）导致两边结论对不上。

## 后果

- **收益**：nimrtc 的 `v2-ice` 一类切片（只碰 2 个模块），
  门禁从 2387 个用例降到 ~200 个（ice + sdp 模块的用例），
  **单次门禁省 200~250 秒**；配上 ADR-096 的重试收窄，
  一片 5 次门禁从 1254s 降到 ~400s。
- **代价**：项目侧要维护标签与规则。这是**显式的、有 review 的**成本，
  比「工具猜」便宜得多 —— 猜错的代价是门禁构建别的目标、
  报一个跟本片无关的错（实战演练记录里踩过两次）。
- **风险**：标签打错 → 收窄跑漏用例 → 门禁假绿。对策：决策三的
  「跑不到用例就判失败」+ 「规则没命中就退回全量」+ 事件的
  `scopeSource` 留痕。
- **不做的**：不改签字判据（留给 ADR-098）；不做依赖图推导；
  不做「按改动历史增量」（那是 CI 的活儿，不是门禁的）。
- **不做「只构建受影响的目标」**：构建命令**故意保持全量**
  （只占 10% 的墙钟，省它收益小、风险大 —— 漏一个链接依赖，
  报出来的错跟被测代码毫无关系）。

## 备选方案

**A. 工具从写集路径推导 CMake 目标名。** 否决 —— ADR-051 已否决：
推导规则藏在项目的 CMake 宏里，工具复制一份就是复制一份必然发散的规则。

**B. 用 CTest `-R` 正则按模块名过滤。** 否决 —— nimrtc 的用例名不含
模块路径（实测，见技术验证 §3），正则无从写起；而且 ADR-096 已实测
Windows 上 `cmd` 把 `|` 当管道符，正则会把命令打崩。

**C. 让项目在 `spec.gateCommands` 里手写本片命令，zelto 不做作用域。**
这就是 ADR-051 的现状。**否决** —— 有效但要求人知道目标名，
且每片手写一遍；本 ADR 做的事是「让人声明**规则**（一次），
工具按规则**自动**收窄（每片）」。

**D. 门禁按「上次跑过什么」增量（只跑上次跑过的用例）。** 否决 ——
那不是增量，那是「不变性检查」；改了代码之后，上次跑过的用例里
**新增**的用例根本不会跑。真正要的是「这次改动**影响**哪些用例」。

**E. 在 agent 侧做增量（让 agent 自己决定跑什么），门禁仍然全量。**
否决 —— 那门禁的 270 秒一分不省；本 ADR 的目标是**门禁本身**变快。

**F. 作用域配置放在 `.zelto/` 下的独立文件（如 `scope.yaml`）。**
否决 —— 放 `config.yaml` 的 `gate:` 段下，与其它门禁配置在一起，
一处看完；独立文件多一次「这个项目的门禁口径在哪」的寻找成本。

## 实现要点（踩坑备忘）

1. **只取 stdout 解析 JSON** —— `ctest --show-only=json-v1` 的 stderr
   会有别的内容（"Could not find executable" 等）。
2. **JSON 可能不完整** —— `ctest` 在 `FixCTestTestfile.cmake` 之类的
   场景下会报 include 找不到（nimrtc 当前就有这个问题），
   此时 JSON 解析失败 → **退回全量**，不许猜。
3. **清单文件名要带切片 id** —— 与 ADR-096 同理，避免并行切片互相覆盖。
4. **收窄后的清单必须能被验真** —— 复用 `verifyNarrowedTestsRan`。
5. **Windows 上 `--tests-from-file` 的相对路径** —— 清单写在门禁工作
   目录下，命令行只多一个相对路径（ADR-096 已验证）。
