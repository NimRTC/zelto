# Slice: v2-ci-pipeline

## 目的

在 `.github/workflows/ci.yml` 中新增独立的 `windows-latest` 作业，按顺序复用 `package.json` 中已有的 `build`、`test:quick`、`lint` 三个脚本，确保模块在 Windows 平台可构建、可快速测试、静态检查通过；作业统一使用 bash 调用，避免 PowerShell/cmd 语法差异。

## 范围

要改的：
- `.github/workflows/ci.yml`
- `tests/acceptance/v2-ci-pipeline/acceptance.test.cjs`

只读参考（**不得修改**，agent 只许读）：
- 只读 `package.json` —— 读取现有 `build`、`test:quick`、`lint` 三个 script 定义，新作业原样复用它们
- 只读 `scripts/test.mjs` —— 了解 `test:quick` 行为，确认在 Windows bash 下可被正常调用

## 需求

无（本片为 CI 接入型变更，不新增产品需求；验收标准即本片出处）。

## 验收标准

1. 新增 windows-latest 作业且复用三脚本：`ci.yml` 中存在 `runs-on: windows-latest` 的作业，其步骤按顺序调用 build、test:quick、lint 对应的已有命令；验证方式：验收测试解析 yaml 文本断言。
2. 新作业显式使用 bash：windows 作业的步骤或作业级默认设置 `shell: bash`；验证方式：验收测试断言文本含 shell bash。
3. 原有 ubuntu 作业保持不变：仍存在 ubuntu-latest 的构建测试作业；验证方式：验收测试断言文本同时含 ubuntu-latest。
4. 本片改动仅限 ci.yml：除验收骨架外，版本库改动文件集合仅含 `.github/workflows/ci.yml`；验证方式：验收测试不断言 git 状态，仅断言 ci.yml 路径存在且可解析。

## 风险

- windows-latest 默认 shell 不是 bash；应对：新作业显式设置 shell bash。
- 现有脚本在 Windows bash 下可能因路径分隔符失败；应对：只复用脚本调用，不改脚本本身。
