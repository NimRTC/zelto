# Slice: v1-version

## 目的
版本 v1 — 定义版本号常量和获取版本字符串函数

## 范围
- 在 `package.json` 中已有 `version` 字段
- 新增 `src/cli/version.ts` 模块，导出版本信息

## 设计
- 从 `package.json` 读取 `version` 字段
- 导出 `VERSION` 常量和 `getVersionString()` 函数
- 格式: `zelto v{version}` (例如 `zelto v0.1.0`)

## 验收标准
1. `getVersionString()` 返回包含版本号的字符串
2. 版本号与 `package.json` 中的 `version` 字段一致
3. 单元测试覆盖

## 风险
- 无
