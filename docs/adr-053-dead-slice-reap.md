# ADR-053：死切片的批量清理

**状态**: 已实施
**日期**: 2026-11-11
**作者**: 系统架构
**关联约束**: C1, C3, C4, C9
**关联文档**: `docs/adr-047-agent-failure-unsticks-slice.md`（§6 遗留项之一）,
`docs/adr-052-retry-budget-reset.md`

---

## 1. 摘要

ADR-047 修好了「agent 失败后切片卡在 running 跑不了第二次」，但留下了一个
尾巴：**死切片仍然占着 `zelto status` 的「running」计数，人得逐片
`zelto resume` 才能清掉。**

ADR-047 §6 把它记为遗留问题，并倾向「先不加批量命令」。本次补上：
新增显式命令 **`zelto stall --reap`**，把所有死切片批量退回 `frozen`。

## 2. 问题

### 2.1 什么是死切片

**死切片 = 状态还停在 `running`，但 agent 早就挂了。**

判据是确定性的（不调模型、不触网，C3）：状态为 `running` **且** 带停机分类
**且** 停机分类不是 `agent_question`。

### 2.2 为什么 `zelto halt --rollback` 扫不到它

这是两个**不同**的问题，判据也不同：

| 命令 | 扫什么 | 死切片为什么扫不到 |
|---|---|---|
| `zelto halt --rollback` | 状态 `running` 且**持有预约的进程已死**（批次崩了） | 死切片**没有预约** —— agent 挂了，预约已释放 |
| `zelto stall --reap`（本次新增） | 状态 `running` 且**带停机分类** | —— |

`--rollback` 解决的是「批次进程崩了，整批切片卡住」；
`--reap` 解决的是「agent 挂了，切片卡住」。批次活着的时候不能回退（会跟
正在跑的批次抢切片），agent 挂了的切片则没有预约需要考虑。

**所以不能把 `--reap` 塞进 `halt`** —— ADR-047 §6 明确说过「不该悄悄塞进 halt」。

### 2.3 提问回路不是死切片

`agent_question` 的 agent **还活着** —— 它只是停下来等人数码，答完在原地续跑
（ADR-013 §3.5）。把它算成死的，等于把一个还在等答复的会话判成尸体。

而且提问回路的切片**一直占着写集**，人迟迟不答就挡着别人 —— 但那是
ADR-047 §6 遗留项之二（提问回路的写集占用时长）要处理的问题，
**不是**批量清理该顺手做的。这里明确排除。

## 3. 决策

### 3.1 独立的显式命令 `zelto stall --reap`

批量改状态的动作必须是显式的（ADR-047 §6）。所以是独立命令，不是
`halt` 的一个隐藏开关。

支持 `--dry-run`（只列不改）和 `--json`（机器可读）。

### 3.2 清理动作 = `RUN_FINISH`

`running --RUN_FINISH--> frozen`，与 ADR-047 的 `markSliceStalled`、
ADR-037 的越界回退是**同一条退路**：语义是「这一轮跑完了，回到可以再跑的状态」。

### 3.3 **保留**停机分类

这一点与 ADR-047 的 `resume()` 不同 —— `resume()` 会清掉停机分类，
本次**不清**。

理由：`resume()` 是「人确认处理完了，恢复这片」，清分类是对的；
本次只是「把状态掰回可跑的样子」，**停机这件事本身仍然成立**
（人还没看过现场）。清掉分类等于宣称「这片已经处理好了」，
而实际上没人看过。

后果：清理之后这片仍会出现在 `zelto stall` 列表里 —— 这是**对的**，
它确实还没被人处理。人的下一步仍然是逐片 `zelto resume <id>`。

### 3.4 不碰写集预约

清理只改切片状态，**不动预约**（C9）。

预约由 `zelto reservation release <id>` 显式释放 —— 死切片通常预约已经释放了
（agent 挂了），但如果还有残留，让人在确认现场后自己决定。

## 4. 追溯（C4）

每次清理写一条 `slice.state.changed` 事件：

```json
{
  "from": "running",
  "to": "frozen",
  "event": "RUN_FINISH",
  "reason": "清理死切片：agent 已停机，切片卡在 running",
  "reaped": true,
  "previousStallClass": "environment_failure"
}
```

`reaped: true` 让事后审计能区分「这次状态变更是批量清理干的」
与「这是人 resume 的结果」。

## 5. 影响面

- `src/core/stall/reap.ts`（新增）：`findDeadSlices` + `reapDeadSlices`
- `src/core/stall/index.ts`：导出
- `src/cli/commands/info-help.ts`：`zelto stall --reap` + 停机列表里单列死切片
- `src/cli/commands/catalog.ts`：`stall` 的 detail 更新

不改 schema、不加依赖、不动不变量。

## 6. 遗留

**`zelto status` 的「running」计数本身仍会把死切片算进去。**
本次只提供清理手段，没有改 status 的判定 —— 改 status 会牵动「运行中的
会话」展示逻辑（session 持久化、worktree 存活探测），风险比收益大。

**提问回路的写集占用时长**（ADR-047 §6 遗留项之二）仍未解决 ——
明确不在本次范围内。
