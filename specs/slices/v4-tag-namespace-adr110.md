# Slice: v4-tag-namespace-adr110

## 目的

实施 ADR-110（`docs/adr/adr-110-version-tag-plan-scoped-namespace.md`）：
把 Git Tag 命名空间从 `plan-<semver>/v<n>` 改为**按计划寻址**的
`plan-<planId>/v<n>`，`<semver>` 从 tag 里移出去。

一次解决四个实测缺陷（证据见 ADR-110 与 §ZD-038）：

1. **版本漂移致历史 tag 永久失效，发布闸门自锁** ——
   `<semver>` 绑 `package.json` 的 `version`，但 tag 是「历史」、
   `package.json` 是「现在」，两者必然分叉。而 `build.mjs --release`
   无参调用 `tag-namespace.mjs`（读全量 `git tag`）→ 升版当天
   历史 tag 全部变非法 → **发布闸门永远打不开**。
2. **多计划抢占同名** —— 多个计划各有自己的 v1/v2/v3，
   同一个 `<semver>/v<n>` 装不下，名字被抢占。
3. **`ship` 默认派生的是裸 tag** —— 工具自己造自己的非法。
4. **CI 读不到 plan↔tag 关系** —— 版本计划在 `.zelto/`（被 gitignore）。

## 范围

要改的（这些是 agent 会去改的文件）：

- `src/core/version/branch.ts`
- `src/core/version/types.ts`
- `src/core/version/store.ts`
- `src/cli/commands/version-ship.ts`
- `scripts/tag-namespace.mjs`
- `scripts/tag-map.json`
- `scripts/version-check.mjs`
- `scripts/build.mjs`
- `.github/workflows/release.yml`
- `docs/tag-namespace.md`
- `policy/policy.yaml`（加 `versions/*.json` 写规则）+ `policy/lock.json`（重锚）
- `versions/<planId>.json`（运行时生成的跟踪副本；由 store 自动写）
- `tests/acceptance/v4-tag-namespace-adr110/acceptance.test.cjs`
- `tests/tag-namespace-adr110.test.ts`

只读参考（**不得修改**，agent 只许读）：

- 只读 `package.json` —— 仅作版本参照。
- 只读 `docs/adr/adr-110-version-tag-plan-scoped-namespace.md` —— 规则的真源。
- 只读 `.zelto/versions/*.json` —— 版本计划的运行时真源（只读，不许改）。

## 需求

- 无（本片没有关联的需求条目；验收口径见下）。

## 验收标准

1. **命名形态改为 `plan-<planId>/v<n>`** ——
   `plan-1795507341754/v3` 合法；`plan-0.7.1/v3` **非法**
   （旧形态必须不再合法，否则「旧名也合法」等于没改）；
   裸 `v1` / `v2` / `v3` 非法；纯 semver tag（`v0.6.0`）合法。
   验证方式：实跑 `node scripts/tag-namespace.mjs <tag>` 断言退出码。

2. **版本漂移不影响历史 tag 的合法性**（ADR-110 决策一的核心）——
   把 `package.json` 的 version 临时改成 `0.9.9`（**改完必须还原**），
   `plan-1795507341754/v3` **仍然合法**（退出码 0）。
   验证方式：实跑脚本，断言两种 version 下退出码都是 0。

3. **两个不同计划的同名版本各有唯一合法名** ——
   `plan-1794562105642/v1` 与 `plan-1795422836717/v1` **同时合法**、互不冲突。
   验证方式：实跑脚本断言两个都退出 0。

4. **`ship` 在 `version.tag` 未设时派生合法 tag** ——
   `planVersionTagName(planId, label)` 返回 `plan-<planId>/v<label>`；
   `version-ship.ts` 的取值顺序是 `version.tag ?? planVersionTagName(...)`；
   **不再**有 `versionTagName(versionLabel)` 直接产裸 tag 的路径。
   验证方式：单测断言派生函数的输出；断言 `version-ship.ts` 的**可执行代码**里
   不再出现 `versionTagName(`（注释里的「旧写法」是解释，不算）。

5. **`version.tag` 显式设定时优先于派生**（ADR-078 的钉子语义不变）——
   验证方式：源码断言 `version.tag ??` 的顺序；单测断言优先级。

6. **`tag-map.json` 的 `commit` 与 git 事实不符时校验失败** ——
   映射表升级为 `{ "<old>": { "new": ..., "commit": ... } }`；
   脚本核对每个条目的 `commit` 与该 tag 实际指向的提交；
   不符时**报出具体差异**（哪个 tag、期望什么、实际什么）。
   验证方式：在临时仓库里造一个 commit 不符的映射表，断言退出码非零
   且输出含 tag 名与两个 commit。

7. **`build.mjs --release` 的 tag 段只校验当前批次** ——
   历史批次的非法 tag 不阻断发版。验证方式：源码断言
   `RELEASE_STAGES` 里 tag-namespace 那段**带参** `--published-only`；
   且实跑 `node scripts/tag-namespace.mjs --published-only` 退出 0。

8. **`version-check.mjs` 能判出「`package.json` 版本低于已发布版本」** ——
   验证方式：在临时仓库里造一个 `v0.7.1` 的 tag + `package.json` 为
   `0.6.0`，断言 `version-check.mjs` 退出非零且输出指出版本不一致；
   反向：`package.json` 为 `0.7.1` + 历史 tag `v0.3.0`…`v0.6.0` 时**必须放行**
   （历史发布 tag 小于当前版本是**正常状态**，不是漂移）。

9. **版本计划的跟踪副本存在且与运行时副本一致** ——
   `versions/<planId>.json` 存在，内容与 `.zelto/versions/<planId>.json` 一致。
   验证方式：实跑 `VersionStore.save()`，断言两个文件都存在且 JSON 相同；
   并断言 `policy.yaml` 放行 `versions/*.json` 的写（否则默认 deny）。

10. **四个发布 tag 一字未动** ——
    `v0.3.0` / `v0.4.0` / `v0.5.0` / `v0.6.0` 的指向与提交前完全一致。
    验证方式：断言四个 tag 仍存在、仍指向同样的提交。

11. **`npm test` 全绿、`npm run lint` 通过。**

12. **不越界** —— 改动只在写集内；`docs/adr/**` 与
    `docs/实战缺陷记录-nimrtc-v14.md` **不得改动**（ADR 已定稿，
    实施阶段只许照着做，不许顺手改规则）。
    验证方式：`git status --porcelain` 断言改动路径全部落在写集内。

## 关键实现要点（规格里已定，实施时不要重新发明）

### 命名空间判据

```
plan-<planId>/v<n>      planId 形如 plan-1795507341754（plan- 前缀 + 13 位数字）
v<major.minor.patch>     纯 semver
```

`<planId>` 的正则是 `^plan-\d{13}$` —— 13 位是 `Date.now()` 的十进制长度
（实测当前 10 个计划 id 全部是 13 位，无一重复）。
**不要放宽成 `^plan-.+$`** —— 那会让 `plan-0.7.1` 这种旧形态也合法，
等于没改（ADR-110 验收标准 1）。

### 版本一致性判据的去处（ADR-110 决策二 / 决策四）

- `tag-namespace.mjs`：**只管命名**。不再读 `package.json`。
- `version-check.mjs`：**管发布锚点的版本一致性** ——
  `package.json` 的版本不得**低于**已发布的最高版本锚点。
  注意：**只管 `v<semver>`**，不管 `plan-*`（那是历史，不该因当前版本变动而失效）。

**判据的方向性**（实测踩过的坑）：
- 「每个发布 tag 都等于当前版本」→ **永远跑不过**（历史 tag 本来就小于当前版本）。
- 「最新的发布 tag 必须等于当前版本」→ **逼着人先发版才能跑预检**（循环依赖）。
- ✅「`package.json` 版本 **>=** 最高的发布 tag」→ 拦的是**真的发生过**的漂移
  （回滚了 package.json 却没回滚发布状态），且准备发版时正常放行。

### `--published-only` 模式（ADR-110 决策五）

`node scripts/tag-namespace.mjs --published-only` ——
只校验与当前发布相关的 tag。历史批次的 tag 不参与判定。
`build.mjs` 的 tag 段**必须带这个参**（否则发布闸门仍会被历史 tag 锁死）。

### 双写版本计划（ADR-110 决策六）

- `.zelto/versions/<planId>.json` —— 运行时真源，**读**从这里。
- `versions/<planId>.json` —— 跟踪副本，**写**时同步。
- 两份**不做双向同步** —— 避免「谁是权威」变成新问题。
- 副本写失败**不抛**（真源已落盘），但要往 stderr 报一条警告。

### 存量 tag 的迁移（ADR-110 决策七 / 决策八）

| 旧名 | 新名 | 指向 |
|------|------|------|
| `v1`（已删） | `plan-1794562105642/v1` | `532f942`（sign-review 计划，**保留指向不重指向**） |
| `plan-0.7.1/v1` | `plan-1794562105642/v1` | `532f942`（重命名，指向不变） |
| `plan-0.7.1/v2` | `plan-1795507341754/v2` | `b61c118`（重命名，指向不变） |
| `plan-0.7.1/v3` | `plan-1795507341754/v3` | `482e0a4`（重命名，指向不变） |
| —（新建） | `plan-1795422836717/v1` | `e4034af`（补 0.7.0 计划 v1 的锚点） |
| —（新建） | `plan-1795422836717/v2` | `de3e22c`（补 0.7.0 计划 v2 的锚点） |
| —（新建） | `plan-1795422836717/v3` | `0f50c73`（补 0.7.0 计划 v3 的锚点） |
| —（新建） | `plan-1795507341754/v1` | `84be3ce`（补 0.7.1 计划 v1 的锚点） |

**锚点归属是查出来的，不是按名字推导的** ——
判据：该锚点是否包含该版本**每个切片**的合并点
（`git merge-base --is-ancestor`）。

> **`v1` 为什么归 sign-review 计划**：实测 `532f942`（`Merge slice v1-sign-review-cli`）
> **不含** 0.7.0 计划 v1 的四个合并点（`21a89d9` / `8e2d9b6` / `afa0057` / `e4034af`
> 全部 `is-ancestor` 为假）。且 `532f942` **不被任何其它 ref 包含** ——
> 若重指向，sign-review 计划的原始提交历史就**永久失去锚点**。
> 按人批决定：**保留指向，不重指向**。

`v0.3.0` / `v0.4.0` / `v0.5.0` / `v0.6.0` —— **一个都不动**。

### workflow 的改动（ADR-110 决策二）

`release.yml` 里的版本号抽取逻辑要**整段删掉** ——
`plan-<planId>/v<n>` 里**没有** semver 可抽（planId 是时间戳）。
原来那段 `case "${TAG}" in plan-*/v*) ...` 的 `plan-*` 分支必须删。

**注意**：`plan-*/v*` 的**触发模式保留** —— 版本锚点也该能触发流水线。
（区分：触发模式在 `tags:` 列表里；case 分支在 `run:` 块里。）

## 风险

- **迁移 tag 时的重指向可能毁掉锚点** ——
  处置：**逐条用 `git merge-base --is-ancestor` 核实**，
  旧指向的内容未被覆盖时**不改指向**，并报出来问人。
- **`release.yml` 删掉版本号校验后，版本锚点 tag 会失去版本号校验** ——
  这是**有意的**（ADR-110 决策二：版本锚点不该因当前版本变动而失效）。
  但要确认命名合法性**仍然**由 `tag-namespace.mjs` 判。
- **`versions/` 双写引入新的不一致源** ——
  缓解：写时同步（同一函数内）；验收标准 9 断言两者一致。
- **`package.json` 改版本号做验收标准 2 的测试** ——
  **必须还原**。用 try/finally，并在测试里断言还原成功。

## 备注

- 本片实施 ADR-110。ADR 本身已定稿（`docs/adr/adr-110-*.md`，
  提交 `af491f0`），**实施阶段不得改 ADR 的规则**。
  若实施中发现规则有问题，**停下来报告**，不要自行改规则。
- ADR-110 的「版本追溯」小节里提交哈希是**全零**（= 还没有对应提交）。
  本片落地后**回填真实哈希**（`git show --stat <hash>` 抽查 + 人工复核），
  并把 `docs/adr-trace-index.md` 加一行。
- `scripts/adr-trace-check.mjs` 当前只检 `adr-102/103/104` 三份
  （`ADR_PREFIXES` 写死）。若要把 ADR-110 纳入受检范围，
  需同步改那个前缀列表 —— **但那是本片的写集外文件**，
  本片**只回填哈希**，不改那个脚本（若确有必要，报告给人决定）。
- **并发冲突提示**：本片实施期间，仓库里有并行会话在跑
  （`git reset --hard` + `git clean` 会清掉未提交的工作）。
  改完**尽早提交**；被清掉了从 `git stash list` 恢复。
