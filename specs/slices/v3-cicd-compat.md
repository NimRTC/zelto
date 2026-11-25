# Slice: v3-cicd-compat

## 目的

让发布流水线（`.github/workflows/release.yml`）适配 v2 引入的 Git Tag 命名空间治理，
使计划版本 tag（`plan-<semver>/v<n>`）能真正触发发布，且发布前跑的 tag 校验
与仓库里唯一的命名空间规则（`scripts/tag-namespace.mjs`）**同源**，不出现两套判定。

## 背景：这一片原先要修的东西不存在

原草案验收标准假设 `scripts/build-lock.mjs` 管着「构建锁文件中的版本号」，
并要求它与 `package.json` 的 `version` 保持一致。**实测该前提不成立**：

- `scripts/build-lock.mjs` 只有三个导出：`acquireBuildLock` / `releaseBuildLock` /
  `withBuildLock`；
- 它管的是 `.build-lock/` **目录互斥锁**（ADR-080），用来保证「构建」与「读 `dist/` 的测试」
  不重叠，**没有任何 version 概念**；
- 全文检索 `version` 命中 **0** 次。

若按原标准实现，等于给互斥锁硬塞一个「版本号」字段，而**没有任何调用点会写它** ——
那个字段永远是空或陈旧，阻断判据形同虚设。故本片改为修**实测存在的** CI/CD 不兼容。

## 实测到的真实缺陷

v2 的 `v2-tag-namespace` 切片定下了两套并存的 tag 形态
（见 `docs/tag-namespace.md`）：

| 形态 | 例子 | 合法性 |
|------|------|--------|
| 计划版本 tag | `plan-0.7.1/v1` | 合法（`<semver>` 必须 == `package.json` 的 `version`） |
| 裸版本 tag | `v1` / `v2` / `v3` | **非法**，须迁移 |
| 语义化版本 tag | `v0.6.0` | 合法 |

但 `.github/workflows/release.yml` 只认第一代形态：

1. **触发条件**是 `tags: ['v*']` —— 计划版本 tag `plan-0.7.1/v1` **不匹配**，
   流水线根本不会被触发；
2. **版本校验**是 `if [ "v${PKG}" != "${TAG}" ]` —— 只认 `v<version>`，
   对命名空间 tag 一律判为「与 package.json 不一致」；
3. 整个 workflow 里**没有**任何 `tag-namespace` 调用 ——
   仓库里明明已经有了唯一的命名空间判据（`scripts/tag-namespace.mjs` + `scripts/tag-map.json`），
   发布流水线却自己手写了一套**更弱**的判定（只比版本号，不查命名合法性、不查存量映射）。

第 3 条是本片的核心：**两套判定**。ADR-106 §5 的老教训是「同一个问题两处判定，必然走偏」；
发布流水线与仓库校验脚本各判一次 tag，正是这个形态。

## 范围

要改的（这些是 agent 会去改的文件）：
- .github/workflows/release.yml
- tests/acceptance/v3-cicd-compat/acceptance.test.cjs

只读参考（**不得修改**，agent 只许读）：
- 只读 scripts/tag-namespace.mjs —— 命名空间的**唯一判据**。发布流水线只许**调用**它，
  不许复制它的规则（复制即两套判定）。
- 只读 scripts/tag-map.json —— 存量裸 tag → 新命名空间的映射表。
- 只读 scripts/version-check.mjs —— 版本一致性校验（ADR-108）。
- 只读 docs/tag-namespace.md —— 命名规则的人批口径。

## 需求
无。

## 验收标准

以下条目为草案：本切片没有关联需求，验收标准依据所属模块的人批设计上下文拟定；
在需求补齐并复核前，这些标准不视为最终口径。

1. `release.yml` 的 tag 触发条件覆盖命名空间形态 `plan-<semver>/v<n>`；
   验证方式：解析 `.github/workflows/release.yml` 的 `on.push.tags` 列表，
   断言其中含一个能匹配 `plan-0.7.1/v1` 的模式（可含 `**` 等 glob 语义），
   且原有的 `v*` 语义版本 tag 触发能力**未被移除**。

2. `release.yml` 的 tag 版本校验改为**调用** `scripts/tag-namespace.mjs`，
   不再内联 `v${PKG}` 形式的版本号比对；
   验证方式：断言 workflow 文件中**不含** `v${PKG}` 这类手写版本号比对片段，
   且含对 `scripts/tag-namespace.mjs` 的调用（`node scripts/tag-namespace.mjs`）。

3. 命名空间校验**失败时发布中止**，且错误信息指出是命名空间问题；
   验证方式：在临时克隆/沙箱里构造一个含非法裸 tag（如 `v1`）的仓库状态，
   执行 workflow 里的那条校验命令，断言退出码非 0 且输出提到命名空间/非法命名。

4. 命名空间校验**通过时**不阻断发布流程；
   验证方式：构造一个只含合法 tag（语义版本 tag `v0.6.0` 或命名空间 tag）的仓库状态，
   执行同一条校验命令，断言退出码为 0。

5. 发布流水线不引入第二套 tag 判定规则；
   验证方式：断言 workflow 文件里**不存在**对 `plan-` 前缀或 `<semver>/v<n>` 形态的
   **手写正则/字符串匹配**（即不得复制 `tag-namespace.mjs` 的规则）；
   命名空间的形态判定只允许存在于那一个脚本里。

6. workflow 的其余行为（打包、发布、`release-status.json` 回写）保持不变；
   验证方式：断言本次改动**只**触及 tag 触发条件与 tag 校验步骤，
   其余步骤（`npm publish --provenance`、`release-status.json` 置 `published: true` 并提交）
   在文件中仍然存在且逻辑未被改写。

7. 不修改 `scripts/tag-namespace.mjs`、`scripts/tag-map.json`、`scripts/version-check.mjs`；
   验证方式：断言这三个文件的哈希在本次改动前后不变（写集边界检查）。

## 风险

- 关联需求为空，验收标准是草案，可能不被验收门禁接受；
  应对：进入实现前先由需求人补齐需求并复核本规格，确认后再编码。
- **发布流水线的改动风险高于普通代码改动** —— 它决定「发出去的包对不对」，
  且只在 tag push 时才真正执行，本地难以端到端跑通；
  应对：验收测试只断言 workflow 的**声明**（触发模式、调用方式、保留项），
  不试图在本地模拟整套 GitHub Actions；命名空间校验命令本身则**真实执行**（它是纯脚本，可本地跑）。
- `plan-<semver>/v<n>` 里的 `<semver>` 必须等于 `package.json` 的 `version` ——
  若发布时两者不同，命名空间校验会失败并阻断发布。这是**期望行为**（防漂移），
  但需确认不会挡住「发一个新版本」：新版本的正确做法是先把 `package.json` 提升到目标 semver，
  再打对应命名空间的 tag。
  应对：在规格与实现注释里写清这条前置条件。
- `scripts/tag-namespace.mjs` 无参运行时读 stdin，stdin 无输入时校验仓库当前 tag 状态；
  在 CI 里必须以**非交互**方式喂入待校验的 tag 列表，否则可能挂起等待输入；
  应对：workflow 里显式把待校验 tag 列表作为参数或管道喂进去，并设置非交互前提。
- 原草案的「build-lock 版本一致性」诉求被本片放弃，可能被认为「漏做需求」；
  应对：规格的「背景」小节已写明该前提不成立的实测依据（0 次命中 `version`），
  并保留了被放弃诉求的推理过程，供需求人复核。
