// Add version prompt template — for extending an existing version plan

export const ADD_VERSION_PROMPT = `你是一个项目管理专家。根据以下设计文档和现有版本计划，追加一个新版本。

设计文档：
{{DESIGN_BODY}}

现有版本：
{{EXISTING_VERSIONS}}

新版本描述：
{{VERSION_DESCRIPTION}}

请分析现有版本覆盖了哪些模块，然后为描述中的新需求生成一个新的版本，包含合适的切片分解。

请按以下格式输出一个 JSON 对象（只输出 JSON，不要其他文字）：

{
  "version": "v3",
  "description": "新版本的描述",
  "dependsOn": ["v2"],
  "slices": [
    {
      "id": "v3-模块名",
      "module": "模块名",
      "title": "切片标题",
      "writes": ["src/module/**/*.ts"]
    }
  ]
}

注意：
1. version 编号接续现有版本（如已有 v1/v2 则新版本为 v3）
2. dependsOn 设为上一个版本
3. 每个 slice 的 id 格式：v<版本号>-<模块名>
4. 只输出 JSON，不要 markdown 代码块标记`;
