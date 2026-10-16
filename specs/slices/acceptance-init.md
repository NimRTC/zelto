# Slice: acceptance-init

## 目的
为已完成的 `init-command` 切片编写端到端验收测试，验证 `zelto init` 命令在真实（临时目录）环境中的行为。
验收测试放在 `tests/acceptance/init-command/` 目录下，采用 spawn CLI 子进程的方式运行。

这是验收测试系列的第一个切片。后续将为每个已 completed 的切片补全验收测试。

## 范围
- `tests/acceptance/init-command/` — 新建验收测试脚本

## 验收标准
1. 验收测试 spawn `zelto init`，验证 `.zelto/slices/` `.zelto/events/` `.zelto/locks/` 目录和 `.zelto/config.yaml` 被创建
2. 验收测试验证二次运行 `zelto init` 不报错、不覆盖已有文件
3. 验收测试验证 `zelto init` 在已有 `.zelto/` 且 config.yaml 被手动修改后不覆盖 config.yaml
4. 验收测试使用 `node --test` 运行，输出符合 TAP 格式
5. 验收测试脚本文件命名 `tests/acceptance/init-command/init.test.ts`
6. 验收测试与 `tests/init-command.test.ts` 不冲突（后者是单元测试，测试 CLI 命令逻辑；验收测试 spawn 真实子进程）
7. 验收测试使用独立的临时目录运行，不影响项目工作目录

## 不包含
- 其他切片的验收测试（后续切片逐一添加）
- 修改任何已存在的源文件或测试文件

## 风险
- 验收测试需要 `dist/cli/index.js` 已编译（依赖 `pnpm build`）
- Windows 路径分隔符与 POSIX 不同，需确保跨平台兼容
