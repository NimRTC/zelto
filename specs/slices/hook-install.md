# Slice: hook-install

## 目的
新增 `zelto hook --install` 命令，自动在 `.git/hooks/` 下安装 pre-commit 和 pre-push hook 脚本，使 `zelto-hook` 策略判定在每次提交和推送时自动运行。

## 范围
- `src/cli/commands.ts` — 注册 `hook` 命令（install / uninstall / status）
- `.git/hooks/pre-commit` — 安装时创建的 hook 脚本（对每个 staged 文件调用 zelto-hook 做 write 判定）
- `.git/hooks/pre-push` — 安装时创建的 hook 脚本（可选，对 push 分支做审计）
- `Docs/zelto-场景功能地图.md` — 标记 git hooks 为 ✅

## 验收标准
1. `zelto hook --install` 在 `.git/hooks/pre-commit` 创建可执行 hook 脚本
2. `zelto hook --install` 在 `.git/hooks/pre-push` 创建可执行 hook 脚本
3. `zelto hook --status` 显示当前安装状态
4. `zelto hook --uninstall` 移除已安装的 hook 脚本
5. Hook 脚本在 pre-commit 时收集 staged 文件，逐个通过 stdin 调用 `zelto-hook` 做 write 判定
6. 任何 deny 判定阻止提交并输出违规路径
7. 不修改已有 hook（如果已存在非 zelto 的 hook，报错提示手动合并）

## 不包含
- 编辑器扩展（那是另一个切片）
- CI 门禁（那是另一个切片）
- 修改 zelto-hook 核心逻辑

## 风险
- Windows 上 `.git/hooks/` 路径可能不存在
- 用户可能已有自定义 hook，不能覆盖
- Hook 脚本需要跨平台（bash for POSIX, cmd for Windows）
