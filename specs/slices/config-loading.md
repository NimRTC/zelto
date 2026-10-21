# Slice: config-loading

## 目的
替换 CLI 中硬编码的策略规则和门禁配置，改为从文件真实加载：
1. `loadPolicyConfig()` 改为读 `policy/policy.yaml`
2. `loadConfig()` 改为读 `.zelto/config.yaml`
3. `frozenHash` 用 spec 文件的真实 sha256 替代 Date.now() 占位符

## 范围
- `src/cli/commands.ts` — 修改 `loadPolicyConfig()`, `loadConfig()`, `freeze` 和 `start` 命令

## 验收标准
1. `zelto freeze` 使用 spec 文件内容的 sha256 作为 frozenHash
2. `zelto check` 检测 spec 文件是否存在、哈希是否匹配
3. `zelto gate` 使用 `.zelto/config.yaml` 中的命令配置（而非硬编码）
4. 策略判定使用 `policy/policy.yaml` 中的规则（而非硬编码）
5. 全部 204+ 测试通过

## 风险
- 文件读取失败时需有合理的降级行为
