
# ADR-122：重新冻结要重推写集，规格解析不许静默丢路径

**状态**：草案（待批准）
**日期**：2026-11-26
**相关**：ADR-092（边界摘要随冻结钉住）、ADR-098（D-4 报错给出路）、ADR-033（不知道 ≠ 成立）、C1、C3、C4、C9

## 背景

实测 nimrtc-v14 的 `v1-rtcp-processor-collaborator` 切片（2026-11-26），在**按人的裁决修改规格并 refreeze** 之后，写集里**多出来的那条路径怎么都进不去**。排查发现这不是一个 bug，而是**三个缺陷叠在一起**，每一个都会让「人改了规格 → 写集却没变」这件事**静默发生**。

这三个缺陷的共同点是：**不报错、不留痕、门禁与 JSON 都说「正常」**。人以为改了规格就改了边界，实际上写集还是旧的 —— 而写集是 C9 运行时强制的边界。旧写集意味着 agent 会在**错误的授权范围**里干活：要么改不动新加的文件（被写集守卫拦下，白跑一轮），要么……

### 实测序列（真实发生）

1. agent 完整研究代码、设计定稿，发现两个写集缺口，**按 AGENTS.md 停下提问**（没写一行代码，exit 0，花费 $5.57）。这两个缺口都是真问题：
   - 新测试 `tests/test_engine_rtcp_processor.cpp` 在写集里，但注册它必需的 `tests/CMakeLists.txt` 不在 → 不注册就不编译，`ctest` 必挂。
   - `rtp::RtcpBlock` 收口被只读的 `engine_scratch.hpp` 挡住。
2. 人裁决：`tests/CMakeLists.txt` 允许改；`RtcpBlock` 收窄豁免。
3. 规格「范围」章节加入 `tests/CMakeLists.txt`。
4. `zelto freeze --refreeze` → **成功**，`zelto check` → **All checks passed**。
5. 但读 `.zelto/slices/<id>.json` 的 `writes`：**`tests/CMakeLists.txt` 不在里面**。

第 4 步和第 5 步同时为真 —— 这就是本 ADR 要消灭的东西。

## 缺陷一：`refreeze` 从不重推写集（主因，最危险）

写集有三级来源（`resolveEffectiveWrites` / `resolveWriteSet` 同口径）：

1. `slice.writes`（已显式给）→ **原样返回**
2. 规格「范围」章节 → 解析
3. 目录探测 → 兜底

两处的第一级都是同一条短路：

- `src/core/lifecycle/freeze.ts:275` —— `if (slice.writes.length > 0) return slice.writes;`
- `src/cli/commands/run-support.ts:127` —— `if (slice.writes.length > 0) return { writes: slice.writes, ... };`

**第一次** freeze 时 `slice.writes` 为空，于是走第 2 级从规格推、`persist=true` 写回 `slice.writes`。
**之后每一次** refreeze，`slice.writes` 已非空 → 永远走第 1 级 → **规格「范围」章节再改也不会被重新读取**。

`freezeSlice` 的 `--refreeze` 分支（`freeze.ts:84-101`）会清空 `frozenHash` / `boundaryHash` / `trace.requirements`，**唯独不清 `writes`**。而 `boundaryHash = computeBoundaryHash(slice)` 覆盖的是 `writes + gateCommands` —— 于是**新边界被算出、钉住，钉的却是旧写集**。`boundaryHash` 校验会通过（它自洽），但它保护的是一份已经和规格对不上的边界。

**为什么特别坏**：`check` 与 `freeze` 全部通过。人只会去"再检查是不是格式问题"，然后改写法规格——**在正确的规格上反复试错**。实测此处曾误判为「路径格式要求」转而重排、加反引号，全部无效，真正的病灶一行都没碰到。

### 修法

`refreeze` 时**以规格为真源重推写集**。具体地：

- `resolveEffectiveWrites` 接受 `refreeze: boolean`。`refreeze === true` 时**跳过第 1 级短路**，直接从规格「范围」章节解析；解析出非空即以它为准。
- `resolveWriteSet` 同口径加 `refreeze`（CLI `zelto freeze --refreeze` 传 `true`）。
- 规格解析为空（人删光了「范围」）时，**不**静默回退到旧写集，也**不**回退到目录探测 —— **报错停下**，给两条出路：补「范围」章节，或显式 `zelto set <id> --field writes`（ADR-098 的"报错给出路"）。

判据是「**人在 refreeze 这一刻批准的规格**」。refreeze 的语义本来就是"我改了规格，请以新规格为准重新钉住" —— 写集是规格的一部分（范围章节），不重读它，refreeze 就是半个动作。

### 不做

- 不在 `check` 里自动重推并写回 —— `check` 是只读诊断，写盘的只有 freeze 家族。
- 不引入「写集 > 规格」的优先级概念之外的任何合并规则 —— 两者只能二选一，合并就是猜。

## 缺陷二：范围章节的平路径条目会静默丢路径

`parseScopePaths`（`src/core/spec/scope.ts`）对**不带反引号**的条目走这条：

```
const match = line.match(/^(\s*)[-*]\s+(?:`([^`]+)`(.+)?|(.+?))\s*$/);
...
const cleaned = match[2] ? p : p.replace(/\s+[-—–]\s+.*$/, '').trim();
```

对 `- src/a/b.hpp          （新增）`：

- `(.+?)` 是**懒惰量词**，配合尾部 `\s*$`，它会在**尽量早**的位置停下（停在行的"第一个可行匹配"），于是捕获组**含尾部的对齐空格**；
- 第 54 行的清理只去 `空格-空格` 形式的说明（` - 说明`），**去不掉全角括号 `（新增）`**；
- 于是 `looksLikePath("src/a/b.hpp          （新增）")` 取末段 = `b.hpp          （新增）`，不是已知扩展名 → **该路径被丢弃**。

实测复现（6 条写集，只认出 1 条）：

```
输入：- src/engine/src/rtcp_processor.hpp          （新增）
      - src/engine/src/rtcp_processor.cpp          （新增）
      - src/engine/src/engine_rtcp.cpp
      - tools/check_engine_layering.py              （新增一条守则，见判据 9）
      - tests/test_engine_rtcp_processor.cpp        （新增）
      - tests/CMakeLists.txt                        （仅新增测试 target 注册，见判据 5）
输出：["src/engine/src/engine_rtcp.cpp"]   ← 其余 5 条全丢
```

对照：`tests/CMakeLists.txt` 还被另一条闸门挡——`looksLikePath` 的"末段须带已知扩展名或已知无扩展名文件名"判据里，`KNOWN_EXTENSIONLESS_FILENAMES` **没有 `cmakelists.txt`**（只有 `makefile`/`dockerfile` 等）。带反引号能绕过（反引号分支不调 `looksLikePath`），但这是**靠人记住"要加反引号"**，不该是契约。

**为什么特别坏**：人写规格的自然形式就是"路径 + 对齐 + 中文括注"，这恰好是丢路径的形状。而且丢的是**写集的一部分**——写集看起来"有几条"，只是少了几条，`check` 不会告诉你少了。

### 修法

两处都改，方向一致：**零容忍静默丢弃**。

1. **捕获组要吃到行尾再清理**：平路径分支改为先取整行 `\s*\S.*`，再按"第一个空白或全角标点前的 token"截路径。至少必须覆盖：对齐全空格 + 半角/全角括号注释 + ` — ` 说明 三种尾部。
2. **把 `cmakelists.txt` 加进 `KNOWN_EXTENSIONLESS_FILENAMES`**（它与 `makefile`/`dockerfile` 同类：无扩展名语义的文件名，`.txt` 不属于已知扩展名）。
3. **零丢弃断言（关键）**：解析完「范围」章节后，对每一条"看起来像 bullet 且含 `/` 或已知扩展名"的行，若最终没进 `paths`，**收集成 `droppedCandidates`**。`freeze` 在 `droppedCandidates.length > 0` 时**拒绝冻结**并列出这些行 —— 让人当场决定"这是路径但我没写对"还是"这不是路径"。这比"尽力猜"安全：漏报（真路径被静默丢）比误报（要求人多看一眼）更坏，因为漏报不吵架。

## 缺陷三：`--refreeze` 的变更事件没有记录写集差异（追溯缺口，非必改）

`refreeze` 会写 `slice.state.changed`（frozen→draft）和后续的 `spec.checked`，但**没有任何一条事件记录"写集从 X 变成了 Y"**。事后审计"这片什么时候被谁扩了边界"时，只能对比 JSON 快照，事件流里没有边界变更这一笔。

这是 C4 的追溯价值问题：**边界变更本身就是最该留痕的动作之一**（它直接改变 agent 的授权范围）。

### 修法（建议，可独立于缺陷一）

refreeze 前后若有写集差异，追加一条事件：

```
spec.writeset.changed  { sliceId, from: [...], to: [...], reason: 'refreeze', via }
```

只追加、不改不删（C4）。diff 为空则不写（避免噪音）。

## 决策

| # | 决策 | 优先级 |
|---|---|---|
| 1 | `refreeze` 跳过写集第 1 级短路，以规格为真源重推；规格空则报错停下 | **必须** |
| 2 | `parseScopePaths` 修对齐空格/中文括注丢路径；补 `cmakelists.txt`；零丢弃断言 | **必须** |
| 3 | 写集变更追加 `spec.writeset.changed` 事件 | 建议 |

## 影响面

- **所有用 `--refreeze` 改过「范围」的项目都中招**，且症状是"改了没效果"。不报错，所以没人知道曾经中招过。
- **任何规格写了「路径 + 对齐 + 中文括注」的切片**，写集都可能缺路径。
- 修好后：
  - refreeze 语义完整（规格改动 → 写集跟着变）✅
  - 规格写法容错（对齐、中文括注不再丢路径）✅
  - 仍丢时**拒绝冻结并列出**，而不是静默少几条 ✅
  - 老切片不动（不重推历史写集；只有下一次 refreeze 才生效）

## 不做（边界）

- **不回溯重推已冻结切片的写集**。历史写集是当时人批准的东西，重推等于改写历史边界；要改就人显式 refreeze。
- **不自动改写集**（ADR-098 既有原则：写集是人批准的边界，C9）。本 ADR 全部是"报错 + 让人选"，没有一条自动补路径。
- **不把 `scope.ts` 的解析器扩展到"理解中文括注的语义"**。只做"不丢"，不做"读懂"——后者是猜。

## 不变量核查

- **C1**：无新增状态位置。写集仍在 `<worktree>/.zelto/slices/<id>.json`。
- **C2/C6**：`core/spec/scope.ts`、`core/lifecycle/freeze.ts` 只用 Node 内置；不 import `adapters/`。
- **C3**：解析与比对是纯字符串 / 文件读，确定性，不调模型、不触网。
- **C4**：缺陷三补的事件是 append-only；拒绝冻结的路径**不改盘**（除既有的 `spec.checked` 失败事件）。
- **C5 / C9**：本 ADR 不改保护域，不改写集运行时强制的语义；只让"写集本身"更可信。
- **C7**：不涉及 `llm/`。

## 验收标准

1. `zelto freeze <id> --refreeze` 在规格「范围」章节新增路径后，`.zelto/slices/<id>.json` 的 `writes` **包含**该路径；`boundaryHash` 随之变化；
2. 规格「范围」章节为空时 `--refreeze` **失败**，错误信息给出两条出路（补范围 / 显式 set writes），不静默保留旧写集；
3. `parseScopePaths` 对 `- path          （中文括注）` 形式的条目**全部**识别（含 `tests/CMakeLists.txt` 这种末段非已知扩展名但属 `cmakelists.txt` 的文件）；
4. 解析器遇到"像路径却没收进去"的行时，`freeze` 拒绝冻结并原样列出这些行；
5. `tests/` 下新增覆盖以上四条的单测（缺陷一 2 条、缺陷二 2 条），全部通过；`npm run lint` 通过；
6. 缺陷三若实施：refreeze 有写集差异时事件流出现 `spec.writeset.changed`，无差异时不出现。

## 编号说明

现有最新为 ADR-121，本文取 **122**。按 ADR-116「每号只有一个家」，若 122 已被占用请顺延并保留本决策内容不拆。
