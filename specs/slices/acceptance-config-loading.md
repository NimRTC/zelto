# Slice: acceptance-config-loading

## 目的
为已完成的 `config-loading` 切片编写端到端验收测试，验证 `zelto` 命令能正确从 `policy/policy.yaml` 和 `.zelto/config.yaml` 加载配置。
验收测试放在 `tests/acceptance/config-loading/` 目录下，采用 spawn CLI 子进程的方式运行。

## 范围
- `tests/acceptance/config-loading/` — 新建验收测试脚本

## 验收标准
1. 验收测试在临时目录中创建 `.zelto/config.yaml` 和 `policy/policy.yaml`，然后 spawn `zelto check` 验证策略加载
2. 验收测试验证 `zelto gate` 使用 `.zelto/config.yaml` 中配置的命令而非硬编码
3. 验收测试验证 `zelto freeze` 使用 spec 文件内容的真实 sha256 作为 frozenHash
4. 验收测试验证修改配置后策略判定行为变化
5. 验收测试使用 `node --test` 运行，输出符合 TAP 格式
6. 验收测试使用独立的临时目录运行，不影响项目工作目录

## 不包含
- 其他切片的验收测试
- 修改任何已存在的源文件或测试文件

## 风险
- 验收测试需要 `dist/cli/index.js` 已编译（依赖 `pnpm build`）
- Windows 路径分隔符与 POSIX 不同，需确保跨平台兼容
