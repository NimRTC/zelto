# ADR-050：验收骨架的出处是正式规格；验收标准条目可跨行

## 状态

已接受（2026-11-11）

## 背景

在 `nimrtc-zelto` 推进 Track F 的 F3 切片（`v1-bwe-transport-cc-fields`）时，
从正式规格生成的验收骨架里，每条用例名都只剩**半句**：

```javascript
test.todo("`signal_source` 判别式存在，且能表达 `kLossRtt` / `kTransportCc` / `kRemb` 三种来源；");
test.todo("transport-cc 的三个字段（到达间隔、包大小、ack 跨度）存在且默认值表示「没有该信号」；");
```

规格原文是这样的：

```markdown
1. `signal_source` 判别式存在，且能表达 `kLossRtt` / `kTransportCc` / `kRemb` 三种来源；
   验证方式：单元测试对三种取值各断言一次，且默认值是「未指定」。
```

「验证方式：……」整段不见了 —— 那正是**这条验收标准怎么算通过**的说明。
agent 拿到的是半条契约，它只能自己猜「什么算通过」。

## 缺陷一：编号条目只取本行，续行被丢掉

`core/spec/trace-extract.ts` 的 `numberedItems`（以及 `core/spec/scope.ts`
的 `parseAcceptanceCriteria`）原来只匹配编号行**本行**：

```ts
const m = line.match(/^\s*\d+\.\s+(.+?)\s*$/);
if (m) continue;          // ← 只取本行，续行直接跳过
const text = m[1].trim();
```

而规格里的验收标准**经常跨行**：第一行写「做什么」，缩进的续行写「怎么验证」。

**修复**：条目可以跨行。缩进的、非列表项的续行接上一条，用空格拼接
（条目正文是散文，空格分隔比换行更贴近原文语义）。

编号条目与无序条目（`bulletItems`）都改了。

## 缺陷二：验收骨架的出处是**草稿**，不是正式规格

`zelto spec draft` 生成骨架时用的是**草稿正文**（模型写的）。
但正式规格才是「人批准的出处」。

在 F3 这片上，两者差得很远：模型把草稿里的字段名写成
`transport_cc_arrival_interval_ms` / `transport_cc_packet_size_bytes` /
`transport_cc_ack_span_ms`，默认值写成 `-1`；而人写的正式规格是
`arrival_delta_ms` / `packet_size_bytes` / `ack_span`，默认值 0 且
「不用哨兵值假装有数据」。

骨架是从草稿来的 —— 于是 agent 拿到的是一份**已经不存在的契约**：
它会去实现三个不存在的字段名，还会被要求用 `-1` 当缺省值。

**修复**：

1. 新增 `zelto spec skeleton <slice-id> [--force]`：
   从**正式规格**重新生成骨架。
2. `zelto spec confirm` 在写进正式规格后，按新规格重建骨架
   （`force: true`）—— 人改了验收标准，骨架跟着变。
3. `writeAcceptanceSkeleton` 增加 `opts.force`，允许显式覆盖。

骨架的**唯一出处**是正式规格：正式规格是人批准的出处，骨架是它的可执行投影。

## 后果

- 验收骨架里的用例名是**完整的验收标准**，agent 拿到的契约是完整的。
- 人改了正式规格的验收标准，骨架不会停在旧版。
- 验收标准条目的提取在 `scope.ts` 与 `trace-extract.ts` 两处行为一致
  （两边都支持跨行）。

## 备选方案

**只修 `trace-extract.ts`**。否决：`scope.ts` 的 `parseAcceptanceCriteria`
是 `create --from-spec` 用的路径，同样截断 —— 只改一处会留下分叉。

**让 `spec draft` 直接用正式规格当草稿**。否决：草稿的存在意义就是
「人正在审、还没批准的东西」。两者的角色不能互换；正确做法是让**骨架**
从正式规格生成，而不是让草稿冒充正式规格。

**在骨架里保留截断，但把「验证方式」单独存字段**。否决：那要给用例名
另开一个数据结构，收益只是省几个字 —— 用例名完整就够了。
