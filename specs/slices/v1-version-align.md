# Slice: v1-version-align

## 目的
将 `package.json` 与 `package-lock.json` 的版本号对齐更新为 `0.7.1`，并新增 `scripts/version-check.mjs` 用于校验二者版本一致性；在不一致时以非零退出码阻断发布流程，确保发布制品携带的版本号可信。

## 范围

要改的（这些是 agent 会去改的文件）：
- `package.json` —— 更新 `version` 为 `0.7.1`，增加 `prepublishOnly` 校验钩子
- `package-lock.json` —— 同步根包版本为 `0.7.1`，使其与 `package.json` 一致
- `scripts/version-check.mjs` —— 新增版本一致性校验脚本

只读参考（**不得修改**，agent 只许读）：
- 只读 `scripts/build-lock.mjs` —— 模块依赖它生成/读取锁文件版本，新脚本需与其读写口径保持一致
- 只读 `npm-shrinkwrap.json` —— 仅检测存在性并提示，不修改（不存在则忽略）

## 需求
无。

## 验收标准
1. `package.json` 的 `version` 字段更新为 `0.7.1`；验证方式：在项目根目录执行 `node -p "require('./package.json').version"`，输出为 `0.7.1`。
2. `package-lock.json` 的根包版本与 `package.json` 一致，均为 `0.7.1`；验证方式：在项目根目录执行 `node -e "const p=require('./package-lock.json'); const v=p.lockfileVersion>=2 ? p.packages[''].version : p.version; if(v!=='0.7.1') process.exit(1)"`，命令退出码为 `0`。
3. 新增 `scripts/version-check.mjs`，且版本一致时校验通过；验证方式：执行 `node scripts/version-check.mjs`，退出码为 `0`，无错误输出。
4. 版本不一致时校验脚本以非零退出码结束，并输出包含 `package.json`、`package-lock.json` 及实际/预期版本的可读错误；验证方式：临时将 `package.json` 的 `version` 改为 `0.7.2`，运行 `node scripts/version-check.mjs`，断言退出码非 `0` 且输出包含上述信息；恢复改动后再运行，退出码为 `0`。
5. `package.json` 中新增 `"prepublishOnly": "node scripts/version-check.mjs"` 钩子；验证方式：执行 `npm pkg get scripts.prepublishOnly`，输出为 `"node scripts/version-check.mjs"`。
6. 校验脚本只读不修改文件；验证方式：连续运行 `node scripts/version-check.mjs` 两次，使用校验工具（如 `sha256sum`）比对运行前后 `package.json` 和 `package-lock.json` 的哈希值，两次哈希一致。

## 风险
1. `package-lock.json` 的 `lockfileVersion` 不同可能导致根包版本字段位置不同（v1 在顶层 `version`，v2/v3 在 `packages[""].version`）；应对：脚本读取 `lockfileVersion` 后按对应路径取值，并兼容两处字段同时存在的情况。
2. 直接手改 `package-lock.json` 可能仅更新了部分版本字段，造成内部不一致；应对：验收标准第 2 条已覆盖根包版本校验，且脚本同时校验顶层与 `packages[""]` 两处；若发现不一致，可回退使用 `npm install --package-lock-only` 重新生成锁文件。
3. 发布流程若实际使用 `npm-shrinkwrap.json`，只校验 `package-lock.json` 会覆盖不到真实发布锁文件；本片写集未包含该文件，因此不实现；应对：在脚本中检测到 `npm-shrinkwrap.json` 存在时给出提示，并留待后续切片补齐支持。
