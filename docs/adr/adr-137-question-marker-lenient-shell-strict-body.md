# ADR-137：提问标记的**外壳**要宽松，**内容**要严格

**状态**：已决（2026-11-27）· 已落地
**日期**：2026-11-27
**相关**：ADR-013（agent 提问回路）、ADR-047（agent 失败要能救回切片）、ZD-065
**病灶来源**：nimrtc-v14 `v1-transport-manager-pacing`（2026-11-27）

## 背景

ADR-013 立的提问回路：agent 遇到规格说不清的地方，**停下来问人**，
人答完原地续跑。这条回路依赖一个**文本标记**：

```
<<<ZELTO_QUESTION
type: spec_gap | choice | blocker
question: <one line>
options: <opt1> | <opt2>
>>>
```

`src/core/question/protocol.ts` 的 `parseQuestion()` 原本只认
`output.lastIndexOf('<<<ZELTO_QUESTION')` 这**一个精确串**。

### 病灶（nimrtc-v14 `v1-transport-manager-pacing`，2026-11-27）

agent 停下来问了人。问题**完全正确**：

> 新文件 `engine_audio_bitrate_ceiling.cpp` 需要一行 CMake 注册才能编进
> `nimrtc_engine`，但 `src/engine/CMakeLists.txt` 不在写集里 —— 是否把它加进写集？

但它把标记写成了：

```
ZELTO_QUESTION
type: spec_gap
question: ...
options: ...
>>>
```

**少了三个尖括号**。于是：

1. `parseQuestion()` 返回 `null` → 问题**从未登记**；
2. 「agent 停下问人」被当成「agent 成功完成」→
   `run.finished` 事件记 `exitCode: 0`、`summary: 未跑验收`；
3. 门禁在一个**零改动的 worktree** 上跑 →
   `build` 报 `Error: .../build is not a directory`，
   `test` 报 `Failed to change working directory`；
4. 验收目标也不存在 → `验收目标不存在：tests/acceptance/v1-transport-manager-pacing`。

**代价**：整轮白跑（$2.78）+ 一条**指错方向**的错误信息
（说构建目录不存在，实际根因是**一行代码都没写**）。

这条错误的杀伤力不在于「一次失败」，而在于它**伪装成另一个失败**：
人看到「build is not a directory」会去查构建配置，查不出问题；
真正该做的（回答那个问题）已经**静默消失**了。

### 为什么不是 agent 的错

agent 的行为**是对的**：它识别出规格缺口，停下来问人，
还给了三个选项和先例依据。它唯一的不当是**标记的书写格式**。
把「格式差一点」变成「整轮白跑 + 误导性报错」，
责任在**协议那一侧对格式的容错为零**。

## 决策

### 决策一：外壳宽松，内容严格

标记的**识别**与字段的**解析**拆成两件事，各用各的判据：

| 层 | 判据 | 为什么 |
|---|---|---|
| **外壳**（找到标记在哪） | 宽松 —— 认得多种写法 | 少写三个尖括号不该让提问消失 |
| **内容**（字段合不合法） | 严格 —— 字段缺一不可、类型必须认 | 宽松外壳不是为了认垃圾 |

**宁可多认一个不是问题的标记，也不要漏认一个真的是问题的标记。**
多认的代价：后面被字段校验挡掉，返回 `null`，行为与今天一致。
漏认的代价：agent 的提问**静默消失**，而提问静默消失的代价是
「agent 停下了，但工具以为它干完了」。

### 决策二：认得这些形态

| 形态 | 例子 |
|---|---|
| 规范形态 | `<<<ZELTO_QUESTION` |
| 少一个尖括号 | `<<ZELTO_QUESTION` |
| 少三个尖括号 | `ZELTO_QUESTION` ← **ZD-065 实测踩到** |
| 尖括号后带空格 | `<<< ZELTO_QUESTION` |
| 尾冒号 | `ZELTO_QUESTION:` |
| 代码块围栏包裹 | ` ```ZELTO_QUESTION ` ``` |

前导 `<` 的数量上限是 **3** —— 再多的尖括号几乎肯定是别的标记（如 `<<<<`）。
`ZELTO_QUESTION` 前面若紧跟字母数字下划线，则**不认**
（那是 `MY_ZELTO_QUESTION` 之类，不是标记）。

### 决策三：缺收尾标记时，取引用块到输出末尾

标记本来就该终止回复。所以「后面没有 `>>>`」时，
最合理的兜底边界就是**输出末尾**。

今天的行为是「缺 `>>>` → 整条丢掉」——
与决策二同向：**少写一个符号不该让提问消失**。

### 决策四：仍然看**最后一个**标记块

与原实现同口径（协议要求标记终止回复）。
**不改成「第一个」** —— 那会让「后面又想了想，其实不用问了」
这种结尾把真问题盖掉。

### 决策五：字段的严格校验一个字都不松

- `type` 必须在 `spec_gap | choice | blocker` 三者之内；
- `question` 必须非空；
- `options` 可选。

外壳宽松**不**意味着「什么都能认」。
上面三个条件一个都不放松 —— 否则「正文里提到一句 ZELTO_QUESTION」
就会被当成一个真问题登记，切片被挂起等一个不存在的问题。

## 被否决的方案

1. **只把 `<<<` 去掉、把 `ZELTO_QUESTION` 认作标记**（不加空格/围栏容错）：
   能修 ZD-065 这个具体病灶，但下一个 agent 换个写法又踩。
   容错的**成本**只是一个正则，**收益**是整类问题不再复现。
2. **在解析失败时打一条 warning 日志**：
   只让人**事后**知道错过了什么，不能救这一轮。
   病灶的代价是「这一轮的提问丢失」——
   事后日志救不回**已经跑完**的 agent。
3. **让 agent 重试一次（提示它标记写错了）**：
   要多跑一轮 agent（成本翻倍），且 agent 可能再写错。
   与决策一「宁可多认」直接冲突。
4. **把 `question` 也放宽成可空**：
   那会登记「一个没有内容的问题」，人无从回答。
   严格校验是**内容**层的底线，不能动。

## 影响面

| 文件 | 改动 |
|---|---|
| `src/core/question/protocol.ts` | `parseQuestion()` 重写；新增 `findMarker()` |
| `tests/core/question/protocol.test.ts` | 七种外壳变体的回归用例 + 内容仍严格的用例 |

**不涉及**：提问回路的其余部分（登记、挂起、回答、续跑）——
它们拿到的是 `ParsedQuestion`，格式变不影响它们。

## 验收标准

1. `<<<ZELTO_QUESTION` / `<<` / 无尖括号 / 带空格 / 带尾冒号 / 代码块围栏
   —— **六种**（含规范形态共七种）外壳**全部**能解析出 `type` / `question` / `options`；
2. 缺 `>>>` → 取引用块到输出末尾，**仍然解析成功**；
3. 未知 `type` / 缺 `question` / 缺 `type` → **仍然返回 `null`**；
4. 正文里提到 `ZELTO_QUESTION` 但没有字段 → **不误认**；
5. 输出里有多个标记块 → 取**最后一个**（与原行为一致）；
6. `ZD-065` 的真实 transcript（nimrtc-v14 `v1-transport-manager-pacing`
   首轮）能被解析出原问题 —— **这是本 ADR 的验收基准**。

## 遗留（不在本 ADR 范围）

ZD-065 还暴露了第二个问题：**「agent 完成」不等于「agent 做了事」**。
零改动却报 `Agent completed successfully`，随后门禁在空 worktree 上炸。
那属于「完成的判定」问题，另行处理。
