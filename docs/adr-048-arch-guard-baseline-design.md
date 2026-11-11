# ADR-048：架构护栏必须对着**项目基线设计**判，且设计正文要能解析出多行文件清单

- 状态：已接受
- 日期：2026-11-11
- 决策者：zelto（维护者）
- 影响范围：`src/core/design/parse.ts`、`src/core/design/selection.ts`、`src/cli/commands/panoramic-project.ts`

## 背景

ADR-027 把架构偏离做成了可配护栏。切片级护栏的语义是
「只看与本片**写集**相关的偏离」—— 与写集无关的漂移不拦干净切片。

这套语义能成立的前提有两个：

1. 拿来对照的**设计**必须描述整个仓库（否则整图里全是噪声，
   而噪声恰好落在写集上时就把切片拦了）；
2. 设计正文里的**模块声明必须解析得出**（解析不出来的话，
   模块只认领零个文件，全仓都成「无归属」）。

2026-11-11 在 nimrtc-zelto 上跑 `v1-exception-handling` 时，
门禁②被架构护栏拦下：`文件无归属` + `依赖指向不存在的模块`，
而 agent 的代码、9 个单元测试、5 条验收断言**全部编译通过、全部跑绿**。

查下来是**两个互相独立**的缺陷叠在一起。

## 缺陷一：设计正文的文件路径解析不出来

### 现场

设计 `dsg-1794196163860` 的正文长这样：

```markdown
### 3. 异常处理模块
- **职责**：处理无效数据输入和边界条件
- **文件路径**:
  - `src/modules/net_feedback/include/nimrtc/net_feedback/safety_check.hpp`
  - `src/modules/net_feedback/src/safety_check.cpp`
- **依赖模块**: [core基础类型]
```

解析出来却是：

```json
{
  "name": "3. 异常处理模块",
  "filePatterns": ["- `src/modules/net_feedback/include/nimrtc/net_feedback/safety_check.hpp`"]
}
```

**一个模块只认领了一个文件，而且那个模式还带着 `- ` 前缀**
—— 带着前缀的模式匹配不上任何真实路径，于是这个模块认领了**零**个文件。

四个模块加起来，全仓 **453** 个文件被判「无归属」。

### 成因

`parseDesignModules` 的字段提取用的是一个单行正则：

```typescript
const filesMatch = body.match(/\*\*文件路径\*\*[：:]\s*(.+)/);
```

三个问题叠在一起：

1. **`\s*` 会吃掉换行** —— `**文件路径**:` 后面紧跟换行时，
   匹配跨到下一行，`.+` 只吃到了第一条列表项；
2. **只取一行** —— 多行列表里的其余条目全丢；
3. **不剥列表项前缀** —— `- ` 留在模式开头，模式永远匹配不上。

依赖名那一栏同样中招：`[engine RTCP demux], [rtp模块的transport-cc解析]`
只解析出第一个（`parseFieldList` 的方括号分支用 `indexOf(']')` 取第一段）。

### 决策

**字段提取改成「按字段边界切」而不是「按正则吃一行」。**

- `extractField(body, label)`：从 `**字段名**：` 之后取值，
  值可以同行写，也可以下一行起以 Markdown 列表展开；
  列表收集到**下一个字段标签**为止（`- **依赖模块**: ...` 就是边界）。
- `stripBulletMarker`：剥掉 `- ` / `* ` / `+ ` / `1. ` 前缀。
- `splitOutsideBrackets`：按逗号/顿号/换行切分，但**方括号内部不算分隔符**
  （`[a, b]` 是一项里的两个条目，不是两项）。
- `stripTrailingNote`：整段尾部的括号说明在**切分之前**去掉 ——
  说明里自己带逗号（`（作为核心层，被其他模块依赖）`），
  切分后它会变成独立条目，于是「无依赖」凭空多出一条叫
  「被其他模块依赖）」的依赖。
- `unwrapBracketed`：方括号只认**紧跟当前项**的那一组 ——
  整段扫所有方括号会把别的项的括号内容也捞进来。

## 缺陷二：基线设计认不出来

### 现场

nimrtc-zelto 里有两份已确认设计：

| id | requirementId | 内容 |
|---|---|---|
| `prj-1792993843912` | `(project-takeover)` | 19 个模块，覆盖整个仓库 |
| `dsg-1794196163860` | `req-1794196093469` | 4 个模块，只讲 net_feedback |

基线设计本该是 `prj-...`。但 `pickDefaultDesign` 认的是：

```typescript
export const PROJECT_REQUIREMENT_ID = '__project__';
const baseline = byNewest.find((d) => d.requirementId === PROJECT_REQUIREMENT_ID);
```

而写设计的那边（`zelto project design` / 接管路径）写的是：

```typescript
requirementId: '(project-takeover)',
```

**写的人与认的人对不上。** 于是基线设计永远认不出来，
护栏退化成「拿一份只讲 net_feedback 的局部设计去对照整个仓库」。

`PROJECT_REQUIREMENT_ID` 这个常量当时**只被 selection.ts 自己引用**，
没有任何生产方用它 —— 常量存在，但没有接线。

### 决策

1. **写的那边用共享常量**：`panoramic-project.ts` 改用
   `PROJECT_REQUIREMENT_ID`，不再写字面量。
2. **认的那边认全部历史写法**：`isProjectBaselineDesign` 用正则
   `^(__project__|\(project-takeover\))$`。
   存量项目里已经有 `(project-takeover)` 的设计了，
   只改写的那边救不了存量 —— 两边都得改。

## 后果

- **正面**：设计正文的多行文件清单能完整解析，
  模块认领范围与设计意图一致，「文件无归属」不再刷屏。
- **正面**：基线设计能被认出来，护栏对照的是**整个仓库的结构**，
  而不是一份局部功能设计。
- **正面**：`v1-exception-handling` 的切片级护栏结论变成
  **零相关偏离**（此前 `blocked: true`）。
- **代价**：解析规则变宽了 —— 列表项、方括号、多字段边界的组合都要照顾。
  这些都有测试钉住（`tests/design-parse.test.ts`）。

## 验证

nimrtc-zelto 上实测（`v1-exception-handling` 切片级护栏）：

| | 修复前 | 修复后 |
|---|---|---|
| 选中的设计 | `dsg-1794196163860`（局部） | `prj-1792993843912`（基线） |
| 全图 `unmapped_file` | 453 | 377（全是 `src/third_party/**` 里的 vendor 代码） |
| 切片相关偏离 | 4 条（`blocked: true`） | **0 条**（`blocked: false`） |

zelto 自身测试套件：**1570 个用例全过**（新增 5 个回归用例）。

## 关联

- ADR-027：架构护栏按 policy 定级
- ADR-027 §3.7：切片级过滤语义（只看与写集相关的偏离）
