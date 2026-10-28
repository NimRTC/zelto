# v1-spec-md-executor

> 让切片规格文件（`specs/slices/<id>.md`）本身成为可执行的规范。
> 通过 Markdown 中的结构化章节直接驱动 zelto 的验证流程，
> 不再需要将规格"翻译"成 TypeScript 测试代码。

## 动机

当前每个切片需要同时维护两份 artifact：
1. `specs/slices/<id>.md` — 人类可读的规格
2. `tests/` 中的 TypeScript 测试 — 机器可执行的校验

两者不同步时，规格就成了一纸空文。
spec-md-executor 让规格文件本身直接驱动验证，消除翻译损耗。

## Spec

### 1. Markdown 规格结构契约

每个切片规格文件必须包含以下结构化章节，才能被 spec-md-executor 识别：

```
# <id> — <title>

## Spec

<确定性描述，使用 GIVEN/WHEN/THEN 或直接断言语言>

## Checklists

- [ ] <验收条件 1>
- [ ] <验收条件 2>
- ...
```

- `## Spec` 章节：包含该切片的确定性规格描述
- `## Checklists` 章节：包含可勾选的验收条件列表
- 其他章节（如 Motivation、Notes）不参与执行

### 2. SpecMdExecutor

新增 `src/core/spec/SpecMdExecutor.ts`，提供：

```
class SpecMdExecutor {
  constructor(sliceRoot: string)  // sliceRoot = specs/slices/

  parse(sliceId: string): ParsedSpec
  // 返回 { spec: string, checklists: string[] }

  validate(sliceId: string): ValidationResult
  // 检查规格文件是否存在、结构是否完整
  // 返回 { valid: boolean, errors: string[] }

  runChecklists(sliceId: string): Promise<ChecklistResult[]>
  // 对每个 checklist 条目执行验证
  // 每个条目作为独立的断言运行
}
```

### 3. 验证规则

- `validate()` 检查：
  - 文件存在：`specs/slices/<id>.md`
  - 包含 `## Spec` 章节
  - 包含 `## Checklists` 章节
  - Checklists 中包含至少一个 `- [ ]` 条目

- `runChecklists()` 对每个 checklist 条目：
  - 提取条目文本（去掉 `- [ ] ` 前缀）
  - 作为独立验证断言执行
  - 返回 `{ text: string, passed: boolean, error?: string }`

### 4. 集成

- 在 CLI 中注册为 `zelto spec-md validate <slice-id>` 和 `zelto spec-md run <slice-id>` 命令
- 在 gate 流程中作为可选步骤：`zelto gate --spec-md` 触发规格文件自校验

## Checklists

- [ ] 创建 `specs/slices/v1-spec-md-executor.md` 切片规格文件
- [ ] 实现 `src/core/spec/SpecMdExecutor.ts` — parse / validate / runChecklists
- [ ] `validate()` 能正确检测缺失章节和空 checklist
- [ ] `runChecklists()` 能正确解析并执行 checklist 条目
- [ ] 注册 CLI 命令 `zelto spec-md validate <slice-id>` 和 `zelto spec-md run <slice-id>`
- [ ] gate 集成：`zelto gate --spec-md` 触发自校验
- [ ] 测试覆盖：单元测试 + 集成测试
- [ ] 所有测试通过

## 依赖

- `fs/promises` (Node 内置)
- 无第三方依赖
- 无依赖其他切片

## 不变量

- 不修改任何现有切片规格文件的内容
- 不修改 SpecService 现有接口（只新增 SpecMdExecutor）
- 不依赖 llm/、不触网、不调用模型
