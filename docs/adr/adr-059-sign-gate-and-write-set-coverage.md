# ADR-059：签字门与写集覆盖判据

**状态**: 已实施
**日期**: 2026-11-15
**作者**: 系统架构
**关联约束**: C1, C3, C9
**关联文档**: `src/cli/commands/merge.ts`（签字门）,
`src/core/spec/scope.ts`（`parseMentionedPaths`）,
`src/core/spec/write-set.ts`（`evaluateWriteSetCoverage`）,
`src/cli/commands/core-slice.ts`（冻结准入）

---

## 1. 摘要

**两条护栏各漏了一处，都被实战演练撞到了：**

1. **签字门漏判（D-6）** —— 显式给 id 的合并路径（`zelto merge <id>`）是直连的，
   只要切片存在就往下走。实测中 `zelto merge <id> --plan <plan-id>`
   在切片**尚未签字**时直接提交并合并了。
2. **写集覆盖漏判（D-4）** —— 规格的「需求」章节里点名要改某个文件，
   但写集里没有它。这个矛盾在冻结时就能看出来，却没有闸门做比对。

两条都是**漏判**（该拦的没拦），不是误判（不该拦的拦了）。这比误判更危险 ——
误判让人烦，漏判让人失去防线。

---

## 2. D-6：签字门

### 2.1 现象

2026-11-15 实战演练（nimrtc-zelto D1）：

```
zelto merge v1-rtp-packetizer-core --plan plan-1794700304594
```

切片**尚未签字**（还没跑过 `zelto sign`），zelto 却直接提交并合并了。

### 2.2 根因：两条合并路径的判据不一致

`zelto merge` 有两条路径：

| 路径 | 判据 |
|---|---|
| 不带 id（合并全部） | `collectMergeCandidates()` —— 只收 `status=approved` 的签字请求 |
| **带 id**（显式指定） | 直接 `store.read(id)` —— **不查签字状态** |

带 id 的路径是直连的。这本来不算错（人明确指定了切片），
但 ADR-018 定的规矩是「签字与合并必须解耦」——
**解耦的意思是合并要校验签字，不是合并不管签字**。

实测暴露的更具体的问题：`--plan` 参数（ADR-056 §3.2 的归属消歧）
被当成了「这条路径已经验证过」的信号。`--plan` 只应影响
「合到哪里」，不应影响「能不能合」。

### 2.3 决策

**合并路径无条件校验签字状态。**

```ts
const signManager = new SignManager(ZELTO_DIR, events, store);
const approvedSigns = await signManager.list('approved');
const approvedSliceIds = new Set(approvedSigns.map((r) => r.sliceId));

const unapproved = ids.filter((id) => !approvedSliceIds.has(id));
if (unapproved.length > 0) {
  // 拒绝，列出是哪几片
  return 1;
}
```

判据位置：**在 ownership 解析与 `commitPendingWorktrees` 之前**。
理由是合并有副作用（提交 worktree 里的改动），必须在任何副作用之前拒绝。

批次语义：整批拒绝，不做部分合并。理由是合并是**版本级**操作 ——
版本分支上出现「一半已签字、一半没签字」的状态，比整批被拒更难收拾。

`pending` 与 `revoked` 都不算已批准：

- `pending`：签字请求发出去了，但人还没决定
- `revoked`：签过了又撤销了（`zelto sign revoke`）—— 撤销后切片状态仍是
  `completed`，但「批准」这条记录作废了，需要重新签字

### 2.4 为什么不用切片状态代替签字记录

切片状态 `completed` 与签字记录 `approved` 是**两件事**：

- 状态 `completed` 也可能来自 hotfix（跳过门禁②自动批准）
- 签字记录被 `revoke` 后，切片状态**仍然是** `completed`（见
  `src/core/gate/sign.ts` 的 `revoke()` 注释）

所以判据必须是签字记录，不能是切片状态。

### 2.5 约束核对

| 约束 | 核对 |
|---|---|
| **C1** 状态只在文件里 | 判据只读 `.zelto/locks/sign-*.json`，未引入内存状态 |
| **C3** 判定确定性 | 只读文件 + 字符串比较，未调模型、未触网 |
| **C4** append-only 事件 | 未改事件类型；合并动作的事件仍由 `merge-executor.ts` 写 |

---

## 3. D-4：规格与写集的一致性

### 3.1 现象

实测案例（nimrtc-zelto D1）的规格「需求 6」：

> **不引入新依赖、不新增模块**：只使用已有的 `rtp::` 与 `nimrtc::core::` API。
> `src/engine/CMakeLists.txt` 如需登记新 `.cpp` 文件，只加一行。

但写集里**没有** `src/engine/CMakeLists.txt`。

后果：agent 建了 `rtp_packetizer.cpp`，却无法在 CMakeLists 里登记 ——
链接期才炸：

```
error LNK2019: 无法解析的外部符号 "nimrtc::engine::build_rtp_packet(...)"
```

写集守卫（C9）**正确拦住了越界**（agent 想改也改不了）。
但代价是「规格说要改 + 写集不允许改」这个矛盾，
**要靠人比对 spec 和 write-set 才能发现**。

### 3.2 这是 zelto 主张的薄弱处

zelto 的核心主张是「越界在发生的那一刻暴露」。但这里暴露的是**反向**的问题：

> **该写的东西没被授权。**

写集守住了「不该写的没写」，但没有守住「该写的写了」。
护栏只管住了越界，没管住**授权不足**。

而且这个矛盾**在冻结时就能看出来** —— 规格正文和切片状态文件都在手边，
纯文本比对即可。没有任何理由留到链接期。

### 3.3 决策

**冻结准入增加一条判据：规格提到的文件必须被写集覆盖。**

三步：

1. **提取**（`core/spec/scope.ts` 的 `parseMentionedPaths`）——
   解析规格**全文**提到的路径，不只「范围」章节。
   规则：反引号包裹的优先 + 行内带已知扩展名的裸路径；
   排除 URL、绝对路径、含 glob 通配的片段。

2. **覆盖判定**（`core/spec/write-set.ts` 的 `evaluateWriteSetCoverage`）——
   用「写集是否覆盖该路径」而不是「路径是否字面等于写集条目」。
   写集常写成 glob（`src/engine/src/**`）或目录（`src/engine/src/`），
   字面比较会把大量实际覆盖的情况误报成未覆盖。

3. **接入冻结准入**（`core-slice.ts` 的 `freeze`）——
   有未覆盖路径 → **拒绝冻结**，逐个点名，并给出两条出路
   （加写集 / 改规格）。

### 3.4 比对的是「有效写集」，不是 `slice.writes`

写集有三级来源（`src/cli/commands/run-support.ts` 的 `resolveWriteSet`）：

```
1. slice.writes        切片文件里已存的
2. spec「范围」章节     从规格解析
3. detectDefaultWrites 目录探测兜底
```

切片没显式给 `--writes` 时，写集要从规格的「范围」章节推导。
只看 `slice.writes` 会把「写集由规格推导出来」的正常切片误判成缺授权 ——
这是实现时踩到的真坑（`tests/acceptance/refreeze.test.ts` 因此红了 10 个用例）。

所以冻结准入用 `resolveWriteSet(id, false)` 取有效写集
（`persist=false` —— 只读命令不该改状态）。

### 3.5 为什么是阻断而不是提示

三条理由：

1. **代价不对称**。误报（覆盖了却报没覆盖）的代价是用户多跑一条 `zelto set`；
   漏报（真没覆盖却放过去）的代价是链接期才炸，agent 已经跑完一轮、
   门禁②也过了 —— 反馈回路长得多。
2. **在冻结时修是秒级**。加一个写集条目是 `zelto set <id> --field writes --value ...`，
   一条命令。链接期再修要重跑 agent。
3. **这道闸门只挡「规格点名了但写集没有」这一个方向**。
   写集超出规格（agent 自选的写集）**不拦** —— 那是合法的。

### 3.6 约束核对

| 约束 | 核对 |
|---|---|
| **C3** 判定确定性 | 纯字符串解析 + 路径覆盖判定，未调模型、未触网 |
| **C9** 写集预约运行时强制 | 未改运行时守卫；本判据是**准入层**的补充，运行时守卫仍是最终防线 |
| **C1** 状态只在文件里 | 只读规格正文与切片状态文件 |

---

## 4. 顺带修的四个小缺陷

同批修复，都不涉及契约变化，未单独开 ADR：

| 编号 | 缺陷 | 修法 |
|---|---|---|
| D-1 | 脏 `dist/` 产物比 `main` 新，`zelto run` 崩在 agent 预检 | `npm run build` 先清 `dist/`（新增 `scripts/clean-dist.mjs`） |
| D-2 | `--agent` 没给值时把 `undefined` 当成「用户指定的值」 | 新增 `optionValue` / `optionValueStrict`，三处调用点统一走它 |
| D-3 | 提示词模板的占位符标题（「需求标题」）被当成真标题 | 模板改成 `<需求标题>` 填空槽 + 解析侧识别占位符 |
| D-5 | 近形命令（`requirement`）掉进 LLM 自然语言路由 | 合并前先查别名表；命中直接跑真命令 |
| D-8 | 门禁②的失败信息不分类 | 失败原因加分类前缀：「没写断言」/「断言不成立」/「命令失败」 |

**D-1 的教训**：`tsc` 不删旧产物，所以从别的分支构建过的 `dist/` 会一直留在磁盘上。
产物目录应该是**当前源码的精确映射**，不是一个跨分支累积的垃圾场。

**D-2 的教训**：`createExecutorAdapter` 对 `undefined` 的兜底**掩盖了 bug** ——
征兆只剩日志里的 `Agent: undefined`。兜底是好东西，但兜底会吃掉错误的信号。

**D-3 的教训**：提示词模板里的占位符是**内容的一部分**。
模型有可能原样照抄模板。解析侧必须独立判一次，不能信任模型填了。

**D-5 的教训**：LLM 路由的成本不只是「调一次模型」——
它给出的答案还比一条明确的提示更糟，因为它让人以为工具「懂了但没找到」，
而不是「命令名不对」。**近形命令不该动用 LLM。**

**D-8 的教训**：「没写断言」与「断言写错了」的修法完全不同
（前者要写测试，后者要改实现）。失败信息不该长得都一样。

---

## 5. 影响

- `zelto merge <id>` 在切片未签字时拒绝执行（退出码 1），并点名是哪几片
- `zelto freeze <id>` 在规格点名的文件未被写集覆盖时拒绝冻结，并给出修法
- `npm run build` 会先清 `dist/`（不影响 `dist-test/`）
- `--agent` / `--adapter` 缺值时回退到默认，不再传 `undefined`
- 需求 / 设计的标题不再停在占位符
- `zelto requirement list` 等近形命令直达真命令
- 门禁②失败信息带分类前缀

## 6. 遗留问题

- **写集覆盖判据只覆盖「规格点了名但写集没有」**。反向（写集有但规格没提）
  不阻断 —— 目前只统计为 `extra`。是否该提示，待观察。
- **`parseMentionedPaths` 的路径识别靠扩展名白名单**。没扩展名的文件
  （`Makefile`、`Dockerfile`）识别不到。需要扩白名单。
- **D-6 之后，`zelto merge` 的两条路径判据统一了**，
  但 `collectMergeCandidates` 里那套「已合入目标 且 worktree 干净」的判据
  与新的签字门是两套独立逻辑，仍有漂移的可能（未验证）。
- **`zelto plan` 仍不能删切片 / 改切片归属**（ADR-057 已记录）。
