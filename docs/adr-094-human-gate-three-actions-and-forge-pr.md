# ADR-094: 人类门三动作与 GitHub 追溯链 PR —— 把「人有话说」和「远端可评审」接进驾驶舱

**状态**: 提案（§6 已实现部分待落地）
**日期**: 2026-11-22
**作者**: 系统架构
**关联约束**: C1, C2, C3, C4, C5, C7, C9
**关联文档**: `docs/zelto-项目目标.md`,
`docs/zelto-场景功能地图.md`,
`docs/zelto-技术架构.md`,
`docs/adr-018-no-auto-merge-on-sign.md`,
`docs/adr-021-sign-revoke.md`,
`docs/adr-037-violation-recovery-and-refreeze.md`,
`docs/adr-070-section-header-detection-and-silent-failure-guard.md`,
`docs/adr-072-web-cockpit-readonly-plus-sign.md`,
`docs/adr/adr-086-cockpit-throttle.md`

---

## 1. 摘要

zelto 的驾驶舱有两个**看得见但没接上**的缺口。

**缺口一：人只有「通过 / 否决」两个动作。**

`zelto sign` 的三个动作是 `--approve` / `--reject` / `--revoke`。其中：

- `--reject` 让切片进**终态** `abandoned` —— 规格得重写，整片作废；
- `--revoke` 只作废「批准」这条记录，**切片状态不动**，门禁结论还在，
  但下一次重跑 agent 拿不到任何「上次人说过什么」。

结果是：**人想说「这个方向不对，但 3 号那条实现思路换一下就能过」时，
zelto 没有对应的动作。** 人只好选 `--reject`（把片作废）或 `--revoke`
（作废批准但丢掉意见）。前者浪费一整轮，后者丢掉了最有价值的信息 ——
**人的判断**。

人给的意见是这条追溯链上**唯一不由工具生成的判断**。丢掉它，
追溯链就只剩「机器验过什么」，不剩「人当时 thinks 什么」。

**缺口二：远端评审没有接上。**

zelto 有 `zelto merge --push`（推分支），但没有 PR 创建、没有 PR 追踪、
没有把追溯链送进 PR body。于是：

- 远端 reviewer 看到的是一个普通 PR，**看不到**这片是门禁②验过的、
  规格是哪份、追溯项有哪些；
- 人不得不手动把 `zelto sign --review` 的输出复制粘贴进 PR 描述 ——
  复制粘贴会丢字段、会在几周后过期、**且与代码版本脱钩**（PR body
  说的是 A 版本，代码是 B 版本）。

**本 ADR 补两样东西**：

1. **人类门三动作**（§5）—— `sign --revise`（带意见重跑某步）与
   `spec --revise`（退回上游改规格），人的意见经事件流进入下一轮
   agent 的约束包；
2. **GitHub 追溯链 PR**（§6）—— `zelto forge pr`，PR body 内嵌
   **机器可读**的追溯块（`<!-- zelto-trace ... -->`）与人读的摘要。

**不**改变追溯链的结构，**不**动合并语义（ADR-018：签字与合并分开），
**不**引入新的判定闸门。

---

## 2. 动机

### 2.1 缺口一的具体病灶

| 事实 | 位置 | 影响 |
|---|---|---|
| `--reject` 让切片进终态 `abandoned` | `src/core/slice/state.ts` `SLICE_TRANSITIONS` | 人提一条意见的代价是整片作废 |
| `--revoke` 不改切片状态、不留意见给下一轮 | `src/core/gate/sign.ts` `revoke()` | agent 重跑时看不到人说过什么 |
| 签字评论只进事件流，**没有任何读取方** | `sign.rejected` / `sign.revoked` 的 `comment` payload | 意见写了等于没写 |
| 约束包里只有规格、写集、门禁命令、门禁失败证据 | `src/core/sched/engine.ts` `buildInstructions()` | 重跑的 agent 只能从头再摸一遍 |
| `REFREEZE` 转换已在状态机里，**但没有 CLI 入口** | `src/core/slice/state.ts` vs `src/cli/commands/` | 「人改了规格要重来」这条路径要绕 `freeze --refreeze` 手搓 |

最后一条是本次发现的**半成品**：`REFREEZE`（frozen → draft）是
ADR-037 为「人改了规格」加的转换，但它的触发方式是
`zelto freeze <id> --refreeze` —— 人得**自己想到**加这个旗标。
人当时的心理状态是「我审出了毛病，要让它重来」，不是
「我要重新冻结」—— 后者要求人知道 zelto 内部有「冻结」这回事。

**这正是 ADR-023 说的那个病灶：工具的内部概念泄漏成了人的负担。**

### 2.2 缺口二的具体病灶

| 事实 | 位置 | 影响 |
|---|---|---|
| 没有任何 PR 创建能力 | 全仓库无 `gh pr create` 调用 | 远端评审与 zelto 的追溯链完全脱节 |
| 签字复查的结论只能打在终端 | `src/cli/commands/sign-review.ts` | 人要手动复制到 PR 描述 |
| 复制的内容会过期 | —— | PR body 说「验收 5/5 通过」，代码已经改了 —— **假信息** |
| 合并的判据在 `merge` 里，与远端评审无关 | `src/cli/commands/merge.ts` | 远端 reviewer 无法独立复核 |

### 2.3 外部参考

参考对象是 **Tencent/LoopForge**（自托管 AgentOps 平台）。它的
Human Gate 有三个动作：

| LoopForge 动作 | 语义 |
|---|---|
| Approve | 通过 |
| Add Context & Rerun | **带上下文重跑某一步** |
| Send Back Upstream | **退回上游** |

这正好补上 zelto 的两个动作缺口。

**借鉴与不借鉴**：

| 外部做法 | 借鉴? | 理由 |
|---|---|---|
| 人类门有「带意见重跑」这一档 | ✅ | zelto 缺的就是这一档 |
| 人类门有「退回上游」这一档 | ✅ | zelto 有 `REFREEZE` 转换但没入口 |
| 重跑时把人的意见带给 agent | ✅ | zelto 有现成机制（约束包 + 事件流），不需要新机制 |
| 用 SOP 图 / Web UI 编排多 agent | ❌ | zelto 的编排是 `core/sched/` 的确定性准入，不靠可视化编排 |
| 用 Go + MySQL + Docker 部署多租户 | ❌ | 违反 C1（状态只在文件里）；zelto 零部署 |
| 用 Web UI 做远程代码评审 | ❌ | zelto 的评审入口是 CLI / 驾驶舱；PR 只是**追溯链的载体**，不是评审主体 |
| 自研 10 个 executor CLI | ❌ | zelto 的执行器是端口 + 适配器（`core/ports/`），加一个 executor 不该进核心 |
| GitHub tracker + PR 自动识别 | ✅（借鉴形态） | 但**只借鉴「把追溯链送进 PR body」这一件事** |
| PR 自动合并 | ❌ | 与 ADR-018 直接冲突：签字不自动合并，PR 也不自动合并 |

**最关键的一条不借鉴**：LoopForge 的 PR 是**评审主体**（review 在
GitHub 上做）。zelto 的 PR 是**追溯链的载体** —— 评审仍然在 zelto 的
签字门做（ADR-018：签字与合并必须分开执行），PR body 只是把
「这片凭什么可合」摆到远端去。

### 2.4 为什么不用 GitHub API 而用 `gh` CLI

LoopForge 用的是 GitHub API（自建 token）。zelto 选 `gh` CLI：

1. **core/ 零第三方依赖**（C2）—— 写 HTTP 客户端意味着 core/ 要处理
   token、分页、重试、API 版本。`gh` 把这些全包了。
2. **凭证不落配置文件**（ADR-022 精神）—— `gh` 用自己的登录态
   （`gh auth login`），zelto 不碰 token。
3. **core/ 不触网**（C3）—— 核心判定层只读文件、纯计算。`gh` 调用
   发生在 **adapter** 里，且只在**人显式执行 `zelto forge pr`** 时发生，
   不在任何判定路径上。

`gh` 不存在时命令要**明确报错并给出替代路径**，不能静默失败。

---

## 3. 关键决策

### D1：新增「退回重跑」状态，而不是复用 `rejected` —— 采纳

**决策**：`SignRequest.status` 增加 `'revised'`（退回重跑）与
`'returned'`（退回上游）两个新状态；切片状态机增加两个转换：

```
completed --SIGN_REVISE--> frozen     （带意见重跑这一片）
completed --SIGN_RETURN--> draft      （退回上游改规格）
```

**理由**：

- `rejected` 的语义是**终态作废**（`abandoned`）。改它的语义会破坏
  既有事件与既有切片的历史解释 —— 追溯链读的是**当时的意思**。
- 新状态让「退回重跑」在审计里一眼可辨：`sign.revised` ≠ `sign.rejected`。
- 切片状态回到 `frozen` 而不是 `running` —— **起跑是人的动作**
  （`zelto run`），退回只把片放回「可以跑」的状态。这与 ADR-018
  「签字不自动合并」是同一条原则的延伸：**签字门不代替人启动下一步。**

### D2：人的意见走**事件流**，不写进切片状态文件 —— 采纳

**决策**：`sign.revised` / `sign.returned` 事件的 payload 携带
`comment`（原文）；新增 `core/review/human-feedback.ts` 从事件流读出
人的意见，注入约束包。

**理由**：

- C4：事件流是追溯的唯一证据载体。意见是「发生过的事」，不是
  「切片的当前属性」—— 同一个切片可以被退回三次，三条意见都要在。
- C1：状态只在文件里 —— 事件流就是文件（`.zelto/events/<id>/events.jsonl`）。
- **不写进切片 JSON 的理由**：切片的 `writes` / `spec` / `state` 描述
  「这片现在什么样」；意见描述「人当时说了什么」。混在一起会让
  「这片是什么」随「人说了什么」漂移。

**类比**：`core/gate/feedback.ts`（ZD-013）已经把门禁失败证据从事件流
读出来喂给重跑的 agent 了。本 ADR 是**同一条路的第二个来源** ——
从「机器验失败」扩到「人提意见」。

### D3：意见进约束包时**原文保留** —— 采纳

**决策**：渲染给 agent 的意见是**原文**，不加工、不摘要、不改写。

**理由**：与 ZD-013 同理 —— 人转述会把关键细节转掉。人写
「3 号那个 `parseInput` 的 null 处理不对，注意边界」，
工具转成「请修复输入解析」就丢掉了「null」和「边界」这两个锚点。

### D4：`sign --revise` 只改状态，**不自动起跑** —— 采纳

**决策**：`zelto sign <id> --revise --comment "..."` 把切片退回
`frozen` 并记录意见，然后**停住**。人自己跑 `zelto run <id>`。

**理由**：与 ADR-018 同构。签字门是「判断」，不是「驱动」。
自动起跑意味着人的签字动作顺带批准了一次 agent 执行 —— 而
C7 说 LLM 产出只作草稿，要进下游须经人 confirm。人 confirm 了
「改法」，不等于 confirm 了「现在就按这个改法跑」。

**但意见必须已经就位** —— 否则「confirm 改法」与「按改法跑」之间
存在一段记忆真空，人写完意见转身就忘。约束包读事件流解决这个。

### D5：退回上游用 `spec --revise`，**接上已有的 `REFREEZE`** —— 采纳

**决策**：`zelto spec revise <id> --comment "..."` 让切片从
`completed` 回到 `draft`（复用 `REFREEZE` 的语义），记录意见。

**理由**：

- `REFREEZE` 转换已经存在（ADR-037），只是没有面向「审阅退回」的入口。
- 复用它意味着**状态机不新增转换** —— 只有 `completed → draft` 一条
  新的边，且语义与 `frozen → draft` 一致（人要改规格重来）。
- 走 `draft` 而不是 `frozen`：退回上游之后规格**没改**，得让人改完
  再走门禁① + 冻结。直接回 `frozen` 会跳过门禁①。

### D6：PR body 里放**机器可读的追溯块** —— 采纳

**决策**：PR body 包含一个 HTML 注释块：

```html
<!-- zelto-trace
{"schema":"zelto-trace/1","sliceId":"...","frozenHash":"sha256:...","signId":"...","gate":{"passed":true,"acceptancePassed":true,"passCount":5,"totalCount":5},"trace":{"requirements":3,"contracts":1,"tests":1},"writtenAt":"2026-11-22T..."}
-->
```

**理由**：

- **机器可读**才能被工具校验。人肉看的是摘要，机器查的是块。
- **放在 HTML 注释里** —— PR body 同时要给人看，而 HTML 注释在
  GitHub 渲染后不可见。两全其美。
- **带 `schema` 版本号** —— 将来加字段时，解析方能判断格式代际。
- 摘要里的每一个数字都来自 `SignReviewFacts`（`core/sign-review/collect.ts`），
  **不重新计算** —— 判定只有一处（ADR-070 的核心诉求）。

### D7：PR 是**追溯链的载体**，不是评审主体 —— 采纳

**决策**：`zelto forge pr` 只负责「把追溯链摆到远端」。它**不**
检查 PR 是否被 approve，**不**在 PR 被 approve 时自动合并，
**不**替代 `zelto sign` / `zelto merge`。

**理由**：

- ADR-018：签字不自动合并。PR 的 approve 按钮是另一种「批准」——
  若它能触发合并，就有**两条批准路径**，且其中一条（GitHub 的）
  绕开了 zelto 的签字门（含追溯/验收/写集确认项，ADR-070）。
- 两条批准路径 = 追溯链分叉 = 「谁批的、依据什么」查不准。

**推论**：`zelto merge` 仍然只认 zelto 的签字请求。GitHub 上
reviewer 批了，zelto 也不认 —— 这不是缺陷，是**刻意的单点**。

### D8：PR 创建走 `ForgePort`，core/ 只定接口 —— 采纳

**决策**：`core/ports/forge.ts` 定义 `ForgePort` 接口（零依赖）；
`adapters/github/` 用 `gh` CLI 实现。

**理由**：与既有的 `core/ports/executor.ts` / `core/ports/llm.ts`
同一套依赖倒置。core/ 不知道 GitHub 存在；将来要支持 GitLab /
Gitea，是**加一个 adapter**，不是改 core/。

**但 core/ 里仍然要有 PR body 的**渲染** —— 因为那是**确定性文本生成**
（C3），不触网，判定的一部分。

### D9：`--dry-run` 是**默认行为**，真开 PR 要显式 —— 采纳

**决策**：`zelto forge pr <id>` 默认只**打印**将要提交的内容
（PR title + body + 目标分支），加 `--open` 才真的调 `gh pr create`。

**理由**：

- 开 PR 是**对外可见**的动作（远端 reviewer 会收到通知）。
- zelto 对「对外可见/不可逆」的动作一贯要求显式（`--hotfix` 必须配
  `--yes`，ADR-015；`--force` 才跳过确认项，ADR-070）。
- dry-run 的输出是**给人看的预览**，人看一眼再决定要不要开。

### D10：`gh` 缺失时**明确报错**，不静默降级 —— 采纳

**决策**：`gh` 不存在 → 命令报错，说明「PR 未创建」并给出替代路径
（手动开 PR + `zelto forge pr --print-body` 拿 body）。

**理由**：ADR-059/061 哲学 —— 「查不到就查不到，绝不冒充」。
同理：**开不了就说开不了，不能让命令「成功」返回而 PR 不存在。**

### D11：退回时**就地作废**已有的批准 —— 采纳（实施时修正）

**决策**：`sign --revise` / `spec revise` 允许退 **`pending` 或 `approved`**
的签字请求。退 `approved` 时，把它**就地**转成 `revised` / `returned` ——
不新建请求，也不分「先 revoke 再 revise」两步。

**理由**：`merge` 的判据是「存在 approved 的签字请求」（`merge.ts` §ADR-018）。
若批准之后再退回而 `approved` 请求还在，`merge` 照样会收它。
「已批准的切片被退回」与「已批准的切片可合并」同时成立 = 追溯链自相矛盾。

**就地点转，而不是两步**：两步（先 revoke 再 revise）中间会有一个
「既没批准也没退回」的中间态 —— 而那正是「追溯链说不清这块片是什么状况」
的状态。活动部件越少越好。

**为什么允许退 `approved`（实施时发现的）**：
「签了字又发现方向不对」是**最该退**的场景 —— 那时已经没有 `pending`
请求可退了。原先写成「要求没有 approved 请求」，等于把最常见的场景堵死。

**人在输出里必须知道**：退 `approved` 会连带作废批准 —— 这件事**不能悄悄做**。

### D12：`forge pr` 要求切片**已签字** —— 采纳

**决策**：没签字的切片不许开 PR。

**理由**：PR body 里的追溯块要有 `signId`。没签字就没有签字可引。
且「没签字就开 PR」会让远端 reviewer 以为这片已经过门禁。

**留个口子**：`--dry-run`（默认模式）不要求签字 —— 人可能想先看
body 长什么样再决定签不签。

---

## 4. 被否决的方案

### 4.1 「把 `sign.rejected` 的评论直接读给 agent」

**否决**。`rejected` 是终态语义，切片已 `abandoned`，不会重跑。
复用它等于让「作废」与「退回」共用一条事件类型 —— 审计里分不出
「这片被人否决了」与「这片被人打回来重做」。

### 4.2 「在切片 JSON 里加 `feedback: string[]` 字段」

**否决**（D2）。C4 说事件流是追溯的唯一证据载体；切片 JSON 是
「当前状态」，不是「历史」。三次退回的意见塞进切片文件，
「这片现在什么样」就变成了「这片被说过什么」。

**代价**：以后想看「这片被退回过几次」要扫事件流而不是读一个字段 ——
但审计报告本来就是从事件流生成的（`core/audit/trail.ts`），不增加成本。

### 4.3 「直接抄 LoopForge 的 SOP 图 / Web 编排」

**否决**。zelto 的编排是 `core/sched/` 的**确定性准入**（写集重叠就
拦、追溯不合格就拦）。SOP 图是给人看的工作流编排，判定权在人手上。
引入它等于让判定分叉（两处各判一次）。

### 4.4 「PR 被 approve 后自动 `zelto merge`」

**否决**（D7）。与 ADR-018 直接冲突，且会产生两条批准路径 ——
GitHub 的 approve 绕开了 zelto 签字门的确认项（追溯 / 验收 / 写集，
ADR-070）。追溯链一旦有两条批准路径，「谁批的」就查不准。

### 4.5 「在 `core/` 里写 GitHub REST 客户端」

**否决**（§2.4）。违反 C2（core/ 零第三方依赖）与 C3（core/ 不触网
的判定层）。core/ 只留 `ForgePort` 接口与 PR body 渲染。

### 4.6 「用 `--comment` 复用 `revoke` 的语义来做退回」

**否决**（D1）。`revoke` 是「签错了要能回退」，语义是**作废批准**，
不改切片状态。退回是**改变切片状态**（回到 frozen / draft），
且必须携带意见。两件事混在一个动作里，人分不清「我撤回了批准」
与「我让这片重来」。

### 4.7 「让 agent 自己读事件流里的意见」

**否决**。约束包是 zelto 给 agent 的**唯一**上下文入口（agent 看到
什么由 zelto 决定，见 `buildInstructions`）。让 agent 自己去翻
`.zelto/events/` 意味着：

1. agent 要知道事件流的路径与格式（内部实现细节泄漏）；
2. agent 会读到**全部**历史意见，包括已被后续意见取代的旧意见；
3. 读文件的行为不在写集预约的判据里（`.zelto/**` 是保护域，只读
   不拦）—— 等于开了一个不受控的上下文通道。

---

## 5. 人类门三动作（§5）

### 5.1 三个动作的语义

| 动作 | 命令 | 切片状态 | 事件 | 人的意见去向 |
|---|---|---|---|---|
| 通过 | `zelto sign <id> --approve` | `completed` | `sign.approved` | — |
| **退回重跑** | `zelto sign <id> --revise --comment "..."` | `completed → frozen` | `sign.revised` | 下一轮 agent 的约束包 |
| **退回上游** | `zelto spec revise <id> --comment "..."` | `completed → draft` | `sign.returned` | 下一轮 agent 的约束包 |
| 否决 | `zelto sign <id> --reject --comment "..."` | `completed → abandoned` | `sign.rejected` | —（终态，不重跑） |
| 撤销批准 | `zelto sign <id> --revoke --comment "..."` | 不变 | `sign.revoked` | —（意见不重跑） |

**「退回重跑」与「退回上游」的区别**：

- **退回重跑**（`sign --revise`）：实现方向对，但细节要改。规格不动，
  写集不动，agent 重跑这一片。
- **退回上游**（`spec revise`）：**方向**不对，要改规格。重跑会白跑
  —— 规格变了，写集多半也要变，追溯要重新物化。

对应 LoopForge 的 Add Context & Rerun / Send Back Upstream 两档。

### 5.2 意见怎么进下一轮

```
人写意见
   ↓
zelto sign <id> --revise --comment "..."
   ↓
sign.revised 事件（append-only，C4）
   ↓
core/review/human-feedback.ts 读事件流
   ↓
Scheduler.buildConstraints() 组装约束包
   ↓
bundle.humanFeedback[] + 指令里的原文段落
   ↓
下一轮 agent 拿到「上次人说了什么」
```

**读哪些意见**：只读**最近一次退回**的意见（`sign.revised` /
`sign.returned` 里最新的那条），理由与 ZD-013 一致 —— 更早的意见
要么已被后续修复，要么已被更新的意见取代。全带过去会让 agent 去追
一个已经不存在的问题。

**意见为空怎么办**：`--revise` 要求 `--comment` 非空。
「不给意见就让人重跑」= 人自己也不清楚要改什么，重跑必然是白跑
（agent 拿不到任何新信息，与上一轮等价）。

### 5.2.1 退回来的片**不能从待办里消失**

**实现期发现的第二个病灶**（与 §7.1 的静默失败是同一类问题，
但方向相反）。

退回之后，切片不再 `completed` —— 它回到了 `frozen`（退回重跑）
或 `draft`（退回上游）。而 `pending-actions.ts` 的三档待办
（待签字 / 待合并 / 待发起签字）**全部只覆盖 `completed` 的切片**。

于是：

```
人签了字 → 发现不对 → sign --revise
  ↓
切片回到 frozen
  ↓
zelto next   → 「All slices are up to date.」
zelto suggest → 那片不见了
  ↓
这片静静躺在 frozen 里，直到被忘掉
```

**「人说要改」的那一片，恰恰是最不该被忘掉的一片。**

**修法**：`PendingActions` 加第四档 `rerun`，判据是
「**最新一条签字请求是 `revised` 或 `returned`**」，
且切片状态与之对得上（`frozen` / `draft`）。

**排序**：`rerun` 压在待签字**前面**。理由 ——
待签字的是**已经做完**的片（只差点一下）；待重跑的是
**人刚说过「要改」**的片（还没做完，带着意见）。
人刚把控制权要回去改东西，那就是眼下最该做的事。

**为什么不要求分支存在**（与 `requestSign` 不同）：那一条问的是
「产物还在树上、等着进主干吗」，所以要分支在。这一条问的是
「人说了要改、还没改吗」—— 分支可能还没建（人审的是规格，
`zelto run` 还没跑过），也可能已清理（`zelto merge` 后删掉了）。
两种情况下这片**都还要做**，不能因为「没分支」就装作没有这回事。
判据用**切片状态** —— 退回时状态机把它从 `completed` 挪走，
那本身就是「这片还没做完」的确证。

### 5.3 约束包里长什么样

```
## Human feedback — the reviewer asked for changes

The previous review of this slice was sent back with the notes below.
Address every point; do not guess what the reviewer meant.

### 退回重跑（sign.revised，2026-11-22T…）
```
3 号那个 parseInput 的 null 处理不对，注意边界
```
```

**「不要猜」那句是必须的** —— 否则 agent 会把「注意边界」自行解释成
「加几个 if」。

### 5.4 不变量自查

| 约束 | 自查 |
|---|---|
| **C1** 状态只在文件里 | 意见只落在事件流（`.zelto/events/<id>/events.jsonl`）；`core/review/human-feedback.ts` 是**纯读取**，不写任何状态 |
| **C2** core 零第三方依赖 | `core/review/human-feedback.ts` 只用 `node:` 内置；不 import `adapters/` |
| **C3** 判定确定性 | 读事件流 + 取最新一条 + 字符串渲染；同一份事件流永远同一段文本 |
| **C4** append-only 事件 | `sign.revised` / `sign.returned` 已进 `EVENT_TYPES`、契约 enum、审计摘要表 |
| **C5/C8** 保护域 | 本 ADR 不动保护域；`.zelto/**` 仍是保护域 |
| **C7** LLM 只产草稿 | 全链路不调模型 |
| **C9** 写集预约 | 不涉及 —— 本 ADR 不改写集判定 |

---

## 6. GitHub 追溯链 PR（§6）

### 6.1 分层

```
core/ports/forge.ts          ForgePort 接口（零依赖，core/ 不知道 GitHub 存在）
core/forge/collect.ts        收集追溯链事实（复用 SignReviewFacts）
core/forge/pr-body.ts        确定性渲染 PR title + body
adapters/github/index.ts     用 `gh` CLI 实现 ForgePort
cli/commands/forge.ts        zelto forge pr <id> [--open] [--base <branch>]
```

**依赖方向**：`cli/` → `adapters/` → `core/ports/`（C6 单向向下）。

### 6.2 PR body 结构

````markdown
# <切片标题>

<!-- zelto-trace
{...JSON...}
-->

## 这片是什么

<切片描述（来自规格 frontmatter 或切片标题）>

## 追溯链

| 环节 | 结果 |
|---|---|
| 追溯项 | 需求 3 / 契约 1 / 测试 1 |
| 门禁② | ✅ 通过 |
| 验收 | ✅ 5/5 |
| 写集越界 | 无 |
| 停机 | 无 |
| 成本 | $0.12 |
| 产物在主干 | 未合并（正常 —— 合并是显式动作） |

## 人工核对

- 冻结规格哈希：`sha256:…`
- 签字请求：`sign-<id>-<ts>`
- 合并动作在 zelto 里显式执行：`zelto merge <id>`
````

**「合并动作在 zelto 里显式执行」这句必须写在 body 里** —— 远端
reviewer 看到 PR 就会以为「合并 = 点 merge 按钮」。这句把 zelto 的
单点合并（ADR-018）告诉远端。

### 6.3 追溯块（机器可读）

```json
{
  "schema": "zelto-trace/1",
  "sliceId": "v1-foo",
  "title": "…",
  "specPath": "specs/slices/v1-foo.md",
  "frozenHash": "sha256:…",
  "signId": "sign-v1-foo-1732…",
  "approvedBy": "human",
  "approvedAt": "2026-11-22T…",
  "gate": { "passed": true, "acceptanceRan": true, "acceptancePassed": true, "passCount": 5, "totalCount": 5 },
  "trace": { "requirements": 3, "contracts": 1, "tests": 1 },
  "writeSetViolations": [],
  "stalled": false,
  "costUsd": 0.12,
  "artifact": "not-in-trunk",
  "baseBranch": "main",
  "headBranch": "slice/v1-foo",
  "writtenAt": "2026-11-22T…"
}
```

**为什么 JSON 而不是 YAML**：JSON 是 HTML 注释里最安全的形态 ——
不需要担心 `#` 开头被当注释、不需要担心缩进被 GitHub 编辑器吃掉。
且 `JSON.parse` 无依赖。

**字段取舍**：只放**已经算好的事实**。不放「结论」——
「门禁过没过」在 `gate.passed` 里，但「该不该合」的判断不在这块里
（那是 `zelto merge` 的事，ADR-018）。

### 6.4 命令

```
zelto forge pr <slice-id> [--open] [--base <branch>] [--print-body] [--json]
```

- 默认（无 `--open`）：**打印** title / body / 目标分支，**不开 PR**（D9）。
- `--open`：真的调 `gh pr create`。
- `--base <branch>`：目标分支；缺省从切片归属解析（ADR-056），
  解析不出来退回 `main`。
- `--print-body`：只输出 body（配合 `--open` 之外的用法 —— 人想手动贴）。

**没有 `--title`**：title 由 `renderPrTitle()` 确定性渲染
（`[zelto] <切片标题>`）。**不给人改** —— 追溯链的每一段都要能
从切片的既定事实推出来；一个手改的 title 会让「PR 列表里这一行」
与「追溯链里这个切片」对不上。要改切片标题就改切片。

**`gh` 调用形态**：

```
gh pr create --title <title> --body-file <tmp> --base <base> --head <head>
```

用 `--body-file` 而不是 `--body`：body 里有多行、可能有反引号，
走命令行参数会被 shell 拆碎（D-69 的同一个坑）。

### 6.5 事件

`forge.pr_opened` —— 记 PR 的 URL、number、目标分支、head 分支。

**只记「真的开了」**：`--dry-run`（默认）不写事件 —— 它什么都没做。
写成事件会让人以为「已经开了 PR」。

### 6.6 不变量自查

| 约束 | 自查 |
|---|---|
| **C1** 状态只在文件里 | PR 是**远端**对象，不是本地状态；zelto 只在事件流里记「开过这个 PR」这个事实 |
| **C2** core 零第三方依赖 | `core/ports/forge.ts` 是纯接口；`core/forge/` 只用 `node:` 内置 |
| **C3** 判定确定性 | PR body 的渲染是纯函数（同样的事实 → 同样的文本）；`gh` 调用在 adapter 里，不在任何判定路径上 |
| **C4** append-only 事件 | `forge.pr_opened` 已进 `EVENT_TYPES`、契约 enum、审计摘要表 |
| **C5/C8** 保护域 | 不动 |
| **C7** LLM 只产草稿 | 不调模型 |
| **C9** 写集预约 | 不涉及 |

---

## 7. 影响面

| 文件 | 变更 |
|---|---|
| `src/core/review/human-feedback.ts` | 新增 —— 读事件流里的人的意见 + 渲染 |
| `src/core/review/index.ts` | 导出 |
| `src/core/gate/sign.ts` | `SignRequest.status` 加 `'revised'` / `'returned'`；加 `reviseRequest()` / `returnRequest()` |
| `src/core/slice/state.ts` | `SliceEvent` 加 `SIGN_REVISE` / `SIGN_RETURN`；`completed` 加两条转换 |
| `src/core/sched/types.ts` | `ConstraintBundle` 加 `humanFeedback` |
| `src/core/sched/engine.ts` | `buildConstraints` / `buildInstructions` 接入人的意见；加 `readHumanFeedback()` |
| `src/core/ports/forge.ts` | 新增 —— `ForgePort` 接口 |
| `src/core/ports/index.ts` | 导出 |
| `src/core/forge/collect.ts` | 新增 —— 追溯链事实收集 |
| `src/core/forge/pr-body.ts` | 新增 —— PR title / body 确定性渲染 |
| `src/core/forge/index.ts` | 新增 —— 导出 |
| `src/adapters/github/index.ts` | 新增 —— `gh` CLI 适配器 |
| `src/cli/commands/forge.ts` | 新增 —— `zelto forge pr` |
| `src/cli/commands/gate-sign.ts` | 加 `--revise` 分支 |
| `src/cli/commands/slice-spec.ts` | 加 `spec revise` 子命令 |
| `src/cli/commands/pending-actions.ts` | 加 `rerun` 档（退回的片不进待办就等于被忘掉，§5.2.1） |
| `src/cli/commands/info-help.ts` | `next` / `suggest` 接入 `rerun` 档 |
| `src/cli/commands/index.ts` | 注册 `forge` 命令 |
| `src/cli/commands/catalog.ts` | 目录加 `forge` 一行；`sign` / `spec` 的 detail 更新 |
| `src/core/events/stream.ts` | `EVENT_TYPES` 加 4 种（`sign.revised` / `sign.returned` / `sign.state_mismatch` / `forge.pr_opened`） |
| `contracts/schemas/event-envelope.json` | enum 加 4 个 |
| `src/core/audit/trail.ts` | 审计摘要加 4 条 |
| `src/adapters/web/api.ts` | 签字状态白名单加两个新状态 |
| `docs/zelto-场景功能地图.md` | 事件类型 64 → 68；命令表加 `forge`；事件表加 4 行 |
| `docs/zelto-技术架构.md` | 事件类型数量 64 → 68 |
| `docs/zelto-项目目标.md` | 事件类型数量 64 → 68 |
| `README.zh-CN.md` | 事件类型数量 64 → 68 |
| `tests/core/review/human-feedback.test.ts` | 新增单元测试 |
| `tests/core/forge/pr-body.test.ts` | 新增单元测试 |
| `tests/acceptance/sign-revise-command/` | 新增验收测试 |
| `tests/acceptance/forge-pr-command/` | 新增验收测试 |
| `tests/acceptance/next-suggest-pending.test.ts` | 加 `rerun` 档的验收测试（§5.2.1） |

**未改动**：`src/core/policy/`、`src/core/gate/executor.ts`、
`src/core/trace/`、`src/hook/`、`policy/`。

---

## 7.1 实现期发现：签字动作的**静默失败**（D-19）

实现三动作时发现一个**既有病灶**，它比三动作本身更值得记一笔。

### 病灶

`core/gate/sign.ts` 的 `approve()` / `reject()` / `reviseRequest()` /
`returnRequest()` 都长这样：

```ts
try {
  await this.store.transit(req.sliceId, 'SIGN_APPROVE');
  // ...
} catch {
  // Non-fatal: slice may already be in completed state
}
```

状态转移失败被 **`catch {}` 吞掉**。于是：

| 人看到的 | 追溯链里的事实 |
|---|---|
| `zelto sign x --approve` → `✅ Approved` | 签字请求 = approved，**切片还在 `draft`** |
| `zelto sign x --reject` → `❌ Rejected` | 签字请求 = rejected，**切片还在 `draft`** |
| `zelto sign x --revise` → `↩️ Sent back for rework`，提示「下一步：zelto run x」 | 签字请求 = revised（**已消耗**），切片还在 `draft` |

**最毒的是第三行**：`--revise` 的全部内容就是「改变切片状态」。状态没变 =
动作没发生 = 人以为退回了、实际没有。而「下一步 `zelto run`」这句提示
还是错的 —— `draft` 片不能跑，签字请求也已经用掉了，人得从头走一遍。

而 `merge` 的判据是「存在 `approved` 的签字请求」——
于是一片**压根没跑过**的切片也能进合并候选。

### 修法：分两种动作，两种处理

关键区分：**这个动作的全部内容是不是「改变切片状态」**。

**A. 「退回」（`--revise` / `spec revise`）—— 状态不对就**先拒绝**，
一个字都不改。

改签字请求**在转移之前**校验状态，转移不了就抛错。
理由：动作没发生，人却以为发生了 —— 这是最坏的一种不一致。
签字请求不该被消耗，因为人还可以换个动作再试。

**B. 「签字」（`--approve` / `--reject`）—— **不推翻签字**，但把不一致**报出来**。

签字是**人的决定**。工具不替人拒绝 —— `zelto sign --force` 存在的
意义就是「明知故犯地签一片没跑好的片」。所以：

- 签字照记（请求状态 = approved / rejected）；
- 切片状态**不动**（不许工具偷偷把 `draft` 改成 `completed`）；
- 但**必须写一条事件**：`sign.state_mismatch`，带上
  `sliceState` 与 `expected`；
- CLI 额外在 stderr 说明「签字已记录，但状态没跟着变」。

于是追溯链里能查到「已批准」与「切片还在 draft」这两件**并存的事实**，
而不是被 `catch {}` 抹成一片空白。

### 为什么新增 `sign.state_mismatch` 事件而不是只打日志

日志会随时间滚走、也会被 CI 吞掉。追溯链的规矩是
「**每个动作写 append-only 事件**」（C4）—— 一个「动作做了一半」
的事实，同样要进事件流，否则审计时看不见。

这条事件也是**审计摘要**里唯一一条以 `⚠️` 开头的：
它标记的不是「发生了什么」，而是「**该发生的没发生**」。

### 代价

事件类型 +1（64 → 68）。这是 ADR-094 唯一的额外开销，
换来的是「人做的决定」与「工具执行的判定」之间的裂缝被焊上。

---

## 8. 待人决策（不自行拍板）

### D13：退回的次数要不要设上限

**背景**：`sign --revise` 可以无限次用。一个切片被退回 20 次说明
**流程本身有问题**（规格写歪了 / 门禁命令不对 / agent 选错了路径），
但 zelto 现在不会拦 —— 它只记事件。

**候选**：

- **A**：不设上限，只在审计报告里显示「本片被退回 N 次」（现状）。
- **B**：设上限（如 3 次），超过要 `--force`。
- **C**：超过上限自动升级为「退回上游」（`spec revise`）。

**建议**：先按 A 跑。理由与 ADR-057 §D8 同源 —— **闸门的阻断语义要稳**，
在真实项目上跑过之前设阈值容易误报。B/C 会带来「人只想再试一次
却被工具拦住」的挫败感。

### D14：PR body 要不要包含切片的完整验收标准

**背景**：现在 body 里只有「验收 5/5 通过」这样的**计数**。
远端 reviewer 想知道「验收的是什么」。

**候选**：

- **A**：只给计数 + 追溯块（现状）。人想看细节自己去 `specs/slices/<id>.md`。
- **B**：把验收标准原文也贴进 body。

**代价**：B 会让 body 变得很长（验收标准常常几十条），且**会过期** ——
规格改了 body 不改。追溯链的核心是「可核对」，计数 + 冻结哈希 + 规格
路径已经足够让人去核对原文。

**建议**：A。冻结哈希 + 规格路径就是「原文在哪」的凭据，贴全文反而
制造「body 与规格不一致」的第二份真相。

---

## 9. 教训

**「人有话说」比「人说了算」更重要。**

zelto 原本有签字门 —— 人能说「不」。但人**不能带话说**：
说完了要么整片作废，要么意见被丢掉。「否决」是**关于片子的判决**，
「带意见重跑」是**关于下一步的指令** —— 两者不能混。

**外部平台的形态要借鉴，信任模型要审视。**

LoopForge 的 Human Gate 三动作直接对应 zelto 的缺口，形态照抄没问题。
但它的 PR 是**评审主体**（GitHub 上 approve 就完事），
zelto 的 PR 只能是**追溯链的载体** —— 批准权单点留在 zelto（ADR-018）。
照抄形态、审查信任模型，跟 ADR-057 学 mattpocock 双轴 review 时
用的是同一把尺子。

**半成品比缺失更危险。**

`REFREEZE` 转换早就在状态机里了，却因为入口藏在
`freeze --refreeze` 旗标后面而几乎没人用 —— 人不会想到「我审出毛病」
等于「我要重新冻结」。**能力在不在，和人能不能想到用，是两回事。**
