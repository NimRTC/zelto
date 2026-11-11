# ADR-049：写集解析口径统一到 scope.ts，`create --from-spec` 不再自备行内正则

## 状态

已接受（2026-11-11）

## 背景

在 `nimrtc-zelto` 上推进 Track F 的 F3 切片（`v1-bwe-transport-cc-fields`）时，
规格按人的自然写法列写集——不带反引号：

```markdown
## 范围

- src/plugins/include/nimrtc/plugins/bwe.hpp
- src/plugins/tests/test_bwe_feedback_fields.cpp
- src/plugins/tests/CMakeLists.txt
```

结果 `zelto create v1-bwe-transport-cc-fields --from-spec` 建出来的切片**写集是空的**，
切片拿不到写集就过不了冻结准入，只能人肉补。

排查下来是两个独立缺陷叠在一起。

### 缺陷一：写集解析器有两份实现，行为不一致

`src/core/spec/scope.ts` 的 `parseScopePaths` 是**共享解析器**，
但 `src/cli/commands/core-slice.ts` 的 `createSliceFromSpec` 又自己写了一份行内正则：

```ts
const writeMatch = line.match(/^\s*[-*]\s*`([^`]+)`/);
```

它**只认反引号**。于是：

- `resolveWriteSet`（run-support.ts）走 `parseScopePaths` → 认得平路径；
- `createSliceFromSpec`（core-slice.ts）走自己的正则 → 只认反引号。

同一份规格，两个入口给出两个不同的写集。这不是"某处写漏了"，
而是**同一语义有两处实现**，改一处必然漏另一处。

### 缺陷二：验收目标只认一种形态

`createSliceFromSpec` 里写死了：

```ts
const acceptanceTestPath = `tests/acceptance/${id}.test.ts`;
```

但仓里真实存在的形态是**目录**：`tests/acceptance/<id>/acceptance.test.cjs`
（`core/spec/skeleton.ts` 的 `SKELETON_FILE_NAME` 就是这个名）。
于是目录形态的切片 `trace.tests` 恒为空，追溯门禁无从校验。

## 决策

1. **`createSliceFromSpec` 改用共享解析器**：
   写集走 `parseScopePaths`，验收标准走 `parseAcceptanceCriteria`。
   删掉那份行内正则。两处行内解析（范围 / 验收标准）合并成两次共享调用。

2. **验收目标按候选列表探测**，三种形态都认：
   - `tests/acceptance/<id>/acceptance.test.cjs`（zelto 骨架，目录形态）
   - `tests/acceptance/<id>.test.ts`（人自己写的文件形态）
   - `tests/acceptance/<id>.test.cjs`

3. **`parseScopePaths` 同时支持反引号与平路径**，
   平路径带尾部说明（`- src/foo.hpp — 新增字段`）时只取路径部分。

## 后果

- 规格里写不写反引号都能拿到写集；`resolveWriteSet` 与 `create --from-spec` 口径一致。
- `trace.tests` 能正确指向目录形态的验收骨架。
- 写集语义不再有两份实现 —— 后续加规则只改 `scope.ts` 一处。

## 备选方案

**只把 `scope.ts` 的正则改成兼容反引号**。否决：那只解决 `resolveWriteSet`，
`create --from-spec` 里的第二份实现还在，下次改还是漏。

**在 `createSliceFromSpec` 里把平路径也认了**。否决：等于承认两份实现是合理的，
分叉会随时间扩大；共享解析器是唯一能保证口径一致的写法。
