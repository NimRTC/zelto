# Slice: v3-cicd-compat

## 目的

让发布流水线（`.github/workflows/release.yml`）适配 v2 引入的 Git Tag 命名空间治理，
使计划版本 tag（`plan-<semver>/v<n>`）能真正触发发布，且发布前跑的 tag 校验
与仓库里唯一的命名空间规则（`scripts/tag-namespace.mjs`）**同源**，不出现两套判定。

## 背景：这一片原先要修的东西不存在

原草案验收标准假设只读 `scripts/build-lock.mjs` 管着「构建锁文件中的版本号」，
并要求它与只读 `package.json` 的 `version` 保持一致。**实测该前提不成立**：

- 只读 `scripts/build-lock.mjs` 只有三个导出：`acquireBuildLock` / `releaseBuildLock` /
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

2. `release.yml` 的 tag 校验**调用** `scripts/tag-namespace.mjs` 做**命名合法性**判定，
   同时**保留**「tag 版本号必须等于 `package.json` 的 `version`」这条发布保护；
   验证方式：断言 workflow 文件含对 `scripts/tag-namespace.mjs` 的调用
   （`node scripts/tag-namespace.mjs`），**且**仍含版本号一致性比对
   （`PKG` 与 tag 中的版本号比对），二者**并存**。

   > **为什么不能只留一条**（实测结论，写在此处以免后来人「简化」掉）：
   > `scripts/tag-namespace.mjs` 按设计**不管纯 semver tag 的版本一致性** ——
   > 实测 `node scripts/tag-namespace.mjs v0.6.0` 在 `package.json` 为 `0.7.1` 时
   > **退出码 0**（`checkTag` 对 `SEMVER_TAG` 直接 `return null`）。
   > 它只在**命名空间 tag** 上校版本（`plan-0.7.0/v1` 在 `0.7.1` 下退出码 1）。
   > 而 `release.yml` 现有的 `v${PKG}` 比对正是防住
   > 「发出去的包和仓库对不上」的那条保护（见 `release.yml` 步骤注释）。
   > 若按原草案「不再内联 `v${PKG}` 比对」执行，这条保护会被**静默削弱** ——
   > 打一个 `v0.6.0` tag 就能把 `0.7.1` 的包发出去。
   > 故本片是**加**一条命名空间校验，不是**换**掉原有校验。

2b. 版本号比对对**两种 tag 形态**都生效（纯 semver tag 与命名空间 tag）；
   验证方式：从 `release.yml` 里抽出那段比对逻辑，**实跑**五种 tag，
   断言退出码 —— `v<当前版本>` 放行、`v0.6.0` 拒绝（版本不符）、
   `plan-<当前版本>/v1` 放行、`plan-0.7.0/v1` 拒绝（版本不符）、
   `v1` 拒绝（认不出版本号）。

   > **为什么要实跑而不是断言文本**：这段 shell 的正确性全在 `case` 与
   > 参数展开上（「文本里有某个字符串」证明不了它算得对）。
   >
   > **实跑时的两个坑**（已踩过，写在这里免得后来人重踩）：
   > ① 抽取时**不能**用 `#.*$` 就地截断去注释 —— 那会把 `${TAG#plan-}`
   >    这种参数展开里的 `#` 当注释起点，把代码截成 `TAG_SEMVER="${TAG`，
   >    bash 直接报「unexpected EOF」。只去**整行**注释。
   > ② 抽取时**不能**单独去掉 `if [ "${GITHUB_REF_TYPE}" = "tag" ]` 那层外壳
   >    —— 会留下落单的 `fi`，if/fi 不配对 → bash 语法错。
   >
   > **还有一条环境坑**：跑 bash 时**用位置参数、不用环境变量**，
   > 且**落成脚本文件**而不是 `bash -c <body>`。
   > 实测本机 `bash` 是 WSL 的 bash（`x86_64-pc-linux-gnu`）：
   > 它既收不到 Windows 侧环境变量（`bash -c 'echo [$MYVAR]'` 输出空），
   > 对 `bash -c` 的位置参数处理也与 Git Bash / Linux 不一致。
   > 「脚本文件 + 位置参数 + 仓库内相对路径」这条路三处行为一致。

3. 命名空间校验**失败时发布中止**，且错误信息指出是命名空间问题；
   验证方式：在沙箱里构造一个含非法裸 tag（如 `v1`）的仓库状态，
   执行 workflow 里的那条命名空间校验命令，断言退出码非 0 且输出提到命名空间/非法命名。

4. 命名空间校验**通过时**不阻断发布流程；
   验证方式：构造一个只含合法 tag（纯 semver tag `v0.6.0` 或命名空间 tag `plan-0.7.1/v1`）
   的仓库状态，执行同一条校验命令，断言退出码为 0。
   注意：纯 semver tag 的**版本号**一致性由 workflow 里保留的那条比对负责
   （见验收标准 2），不在本条断言范围内。

5. 发布流水线**不引入第二套命名合法性判定规则**；
   验证方式：断言 workflow 文件里**不存在**对「什么形态算合法」的**判定** ——
   即不得出现「某形态 → 非法/拒绝」这类结论性判断；
   命名空间的形态合法性只允许存在于 `scripts/tag-namespace.mjs` 里。

   > **「提取」与「判定」必须分清**（这条容易写死，写在这里免得后来人踩）：
   > workflow 里从 tag 取出 semver 的那点形态识别（`plan-<semver>/v<n>` 与 `v<semver>`
   > 各怎么取版本号）是**提取**，不是**判定** —— 它跑在脚本已判合法**之后**
   > （脚本非零退出就 `set -e` 中止了，根本走不到提取那步）。
   > 判定的唯一来源仍是脚本。
   > 验证方式：断言 shell 代码里**没有**「非法」「不合法」「拒绝」这类针对形态的结论词，
   > 且没有形态正则（`\d`、`[0-9]`、`^v\d` 之类）。

   > 注意这条**只管命名合法性**，不管版本号一致性 ——
   > 版本号比对是「tag 与 package.json 对齐」，与命名合法性是两件事，
   > 允许（且必须）留在 workflow 里（见验收标准 2 的实测说明）。

6. workflow 的其余行为（打包、发布、`release-status.json` 回写）保持不变；
   验证方式：断言本次改动**只**触及 tag 触发条件与 tag 校验步骤，
   其余步骤（`npm publish --provenance`、只读 `release-status.json` 置 `published: true` 并提交）
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
- **验收测试要在三种 bash 实现下都成立** —— 本机是 WSL bash，CI 是 Linux bash，
  开发机还可能是 Git Bash。WSL bash 对「环境变量」与「`bash -c` 的位置参数」
  的处理都与另两者不同（实测：env 传不进去、`bash -c` 的 `$1` 为空）；
  应对：验收测试用「脚本文件 + 位置参数 + 仓库内相对路径」这条三处一致的路子，
  不用环境变量注入、不用 `bash -c <多行 body>`。
- 原草案的「build-lock 版本一致性」诉求被本片放弃，可能被认为「漏做需求」；
  应对：规格的「背景」小节已写明该前提不成立的实测依据（0 次命中 `version`），
  并保留了被放弃诉求的推理过程，供需求人复核。
