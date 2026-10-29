# Slice: v1-diff-highlight

## 目的
为 `zelto` 添加 `diff-highlight` 命令，从 stdin 读取 unified diff 并输出 ANSI 颜色高亮的版本，使用与 `zelto plan` 命令的 diff 部分相同的视觉风格。

## 范围
- `src/cli/commands/diff-highlight.ts` — 命令处理器
- `src/cli/color.ts` — 添加背景色支持（bgGreen, bgRed, boldYellow）

## 设计

### 命令行为
`zelto diff-highlight` 从 stdin 读取 unified diff 内容，对每行进行分类并应用 ANSI 颜色转义：

| 行类型 | 匹配规则 | ANSI 样式 |
|--------|----------|-----------|
| 头信息行 | `diff --git`, `---`, `+++`, `new file`, `deleted file`, `index ` 开头 | 粗体黄色 (`\x1b[1;33m`) |
| 新增行 | `+` 开头（非 `+++`） | 绿色背景 (`\x1b[42m`) |
| 删除行 | `-` 开头（非 `---`） | 红色背景 (`\x1b[41m`) |
| 块头行 | `@@` 开头 | 青色前景 (`\x1b[36m`) |
| 上下文行 | 其他 | 无样式 |

### 颜色模块扩展
在 `src/cli/color.ts` 中添加：
- `bgGreen: (s) => \x1b[42m...\x1b[0m`
- `bgRed: (s) => \x1b[41m...\x1b[0m`
- `boldYellow: (s) => \x1b[1;33m...\x1b[0m`（组合粗体+黄色）

### 纯函数设计
高亮逻辑作为纯函数实现，与 `core/output-formatter.ts` 相同的设计思路：接收原始 diff 文本，返回 ANSI 转义后的输出。无外部依赖，仅用 Node 内置模块。

## 验收标准
1. `zelto diff-highlight` 从 stdin 读取 unified diff 并输出 ANSI 高亮版本
2. 新增行（`+` 开头）显示为绿色背景
3. 删除行（`-` 开头）显示为红色背景
4. 头信息行（`diff --git`, `---`, `+++` 等）显示为粗体黄色
5. 空输入时返回错误码 1
6. 全部测试通过

## 风险
- 无
