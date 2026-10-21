# Slice: hook-install-acceptance

## 目的
为 `zelto hook --install` 命令补充验收测试，验证 git hooks 安装/卸载/状态查询功能的正确性。

## 范围
- `tests/acceptance/hook-install/hook-install.test.ts` — 验收测试文件

## 不包含
- 修改 `src/cli/commands.ts` 中的 hook 功能代码（保护域）
- 修改 `src/hook/index.ts` 中的 hook 判定逻辑（保护域）

## 验收标准
1. `zelto hook --install` 在 `.git/hooks/` 下创建 pre-commit 和 pre-push 脚本
2. 安装的 hook 脚本包含 zelto 标记（`# zelto-hook — DO NOT EDIT`）
3. `zelto hook --status` 正确报告已安装状态
4. `zelto hook --uninstall` 移除已安装的 hook 脚本
5. `zelto hook --uninstall` 后 `--status` 报告未安装
6. 验收测试在独立临时目录中运行，不影响项目自身的 git hooks
7. 不修改任何功能代码

## 风险
- 测试需要 `.git/hooks/` 目录——在临时 git 仓库中运行
- Windows 上 `.git/hooks/` 权限处理不同——测试应跨平台
