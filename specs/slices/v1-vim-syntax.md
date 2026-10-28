# Slice: v1-vim-syntax

## 目的
为 zelto 的切片规格文件（specs/slices/*.md）提供 Vim 语法高亮文件，提升在 Vim 中编辑这些文件时的可读性。

## 范围
- `syntax/zelto-slice.vim` — Vim 语法高亮文件
- `syntax/ftdetect/zelto-slice.vim` — Vim 文件类型自动检测
- `tests/vim-syntax.test.ts` — 语法文件测试

## 设计

### Vim 语法高亮 (syntax/zelto-slice.vim)
为 specs/slices/*.md 提供专用的 Vim 语法高亮，包括：

| 高亮组 | 匹配内容 | 链接到 |
|---------|----------|--------|
| zeltoYAMLFrontmatter | YAML frontmatter（`---` 包裹的元数据块） | PreProc |
| zeltoSectionTitle | `## ` 开头的章节标题 | Title |
| zeltoStatusLine | `Status: xxx` 状态行 | Special |
| zeltoRefsSlice | `Refs-Slice:` trailer | Special |
| zeltoSliceID | `[id-xxx]` 格式的切片 ID 引用 | Identifier |
| zeltoCodeBlock | ` ``` ` 包裹的代码块 | String |
| zeltoChecklistDone | `- [x]` 已完成项 | Statement |
| zeltoChecklistTodo | `- [ ]` 待办项 | Comment |
| zeltoTodo | TODO/FIXME/HACK 标记 | Todo |
| zeltoBlockquote | `> ` 开头的引用块 | Comment |
| zeltoMarkdownLink | `[text](url)` Markdown 链接 | Underlined |

### 文件类型检测 (syntax/ftdetect/zelto-slice.vim)
自动将 `specs/slices/` 目录下的 `.md` 文件关联到 `zelto-slice` 语法。

## 验收标准
1. `syntax/zelto-slice.vim` 文件存在且包含上述所有高亮组定义
2. `syntax/ftdetect/zelto-slice.vim` 文件存在且正确设置文件类型检测
3. 测试验证文件存在性、基本结构、核心高亮组定义
4. 全部测试通过

## 风险
- 无
