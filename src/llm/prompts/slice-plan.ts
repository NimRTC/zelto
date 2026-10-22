// Slice plan generation prompt template

export const SLICE_PLAN_PROMPT = `你是一个项目管理专家。根据以下设计文档，生成版本计划和切片分解。

设计文档：
{{DESIGN_BODY}}

模块列表：
{{MODULES_JSON}}

请按以下格式输出一个 JSON 对象（只输出 JSON，不要其他文字）：

{
  "title": "版本计划标题",
  "versions": [
    {
      "version": "v1",
      "description": "第一个版本：核心功能",
      "dependsOn": [],
      "slices": [
        {
          "id": "v1-模块名",
          "module": "模块名",
          "title": "切片标题",
          "writes": ["src/module/**/*.ts", ...]
        }
      ]
    }
  ]
}

分解原则：
1. **纵向按模块**：每个模块一个或几个 slice
2. **横向按版本**：v1 做核心功能（能让系统跑起来的最小集），v2/v3 逐步增加功能
3. **版本依赖**：v2 dependsOn ["v1"]，v3 dependsOn ["v2"]，依次递增
4. **每个 slice 的 writes 参考模块定义中的文件路径**
5. **v1 只包含最核心的模块**，确保能独立交付
6. **每个版本 2-4 个 slice**，太多则继续拆分版本
7. **slice id 格式：v<版本号>-<模块名>**，用英文小写和连字符

注意：
- 只输出 JSON，不要 markdown 代码块标记
- 确保 JSON 格式正确，可以被 JSON.parse 解析`;
