# Slice: v5-release-tag-guard

## 目的

实施 ADR-113（`docs/adr/adr-113-release-tag-version-guard.md`）：
恢复「**触发的 tag 名 == 实际发布版本**」这条发布保护，
并把它落到**唯一判据** `scripts/version-check.mjs`（新增 `--tag` 参数），
`release.yml` 只调用、不自己比对。

同时按 ADR-110 校准 `v3-cicd-compat` 里**过期**的形态断言 ——
**不回退 ADR-110**（命名空间按计划寻址是对的）。

## 背景：这一片修的是「v4 实施遗留的发布保护缺口」

### 表象

`tests/acceptance/v3-cicd-compat/acceptance.test.cjs` 3 条红：

1. 「触发条件覆盖 `plan-<semver>/v<n>`」；
2. 「版本号比对对纯 semver tag 与命名空间 tag 都生效（保护没被削弱）」；
3. 「命名空间校验通过时不阻断：合法 tag 退出码为 0」。

第 1、3 条是**过期断言**（ADR-110 取代了 `plan-<semver>/v<n>` 形态）。
第 2 条不是 —— 它守的是一条**真实的发布保护被删掉了**。

### 缺口

`v4-tag-namespace-adr110`（`06eefe9`）把 `release.yml` 里那段版本号比对**整段删了**，
理由是「`plan-<planId>/v<n>` 里没有 semver 可抽」。

**这个理由只对 `plan-*` 形态成立。** 发布锚点 `v<semver>` 形态**仍有 semver 可抽**，
且**必须**校 —— 它就是「这次要发的那个版本」。

ADR-110 **决策二**原文：

> ① 命名合法性 → scripts/tag-namespace.mjs（唯一判据，workflow 只调用）
> ② 版本一致性 → **只对 `v<semver>` 形态校**

**决策二的 ② 在 v4 实施后没有任何实现。**
`version-check.mjs` 里落的是**另一个判据**（`pkg >= 最高已发布 tag`）——
它拦的是「仓库版本落后」，不是「**这次发的**跟 tag 对不对得上」。两者互补，缺一不可。

### 缺口的后果（实测可复现）

`package.json` = `0.7.1` 时：

```bash
$ git tag v0.6.0 HEAD
$ npm publish
```

- npm 上收到的是 **0.7.1**；
- 仓库发布锚点记着 **`v0.6.0`** —— **锚点说谎**；
- `version-check.mjs` 的「已发布版本」代理是 git tag，
  于是认定「已发布到 `0.6.0`」，与 npm 事实分叉 ——
  后续所有依赖「已发布版本」这个事实的防漂移判据从此建立在错的基准上。

## 范围

要改的（这些是 agent 会去改的文件）：

- `scripts/version-check.mjs`
- `.github/workflows/release.yml`
- `tests/acceptance/v3-cicd-compat/acceptance.test.cjs`
- `docs/adr-trace-index.md`（加一行 ADR-113）
- `docs/adr/adr-113-release-tag-version-guard.md`（回填哈希）

只读参考（**不得修改**，agent 只许读）：

- 只读 `docs/adr/adr-110-version-tag-plan-scoped-namespace.md` —— 决策二的真源。
- 只读 `docs/adr/adr-113-release-tag-version-guard.md` —— 本片的规则真源。
- 只读 `scripts/tag-namespace.mjs` —— 命名合法性的唯一判据（不因本片改变）。
- 只读 `scripts/tag-map.json` —— 迁移台账。
- 只读 `scripts/build.mjs` —— 发布预检的四段串联。

## 需求

- 无（本片没有关联的需求条目；验收口径见下）。

## 验收标准

1. **`version-check.mjs --tag <name>` 三种形态各判各的** ——
   验证方式：**实跑**脚本，断言退出码：
   - `v<当前版本>` → **0**（发布锚点，版本一致 → 放行）；
   - `v<比当前版本低的版本>` → **非 0**，且错误信息指出版本号不一致；
   - `plan-<planId>/v1` → **0**（版本锚点是**历史**，不校版本）；
   - `v1`（裸 tag，认不出版本号）→ **非 0**。

2. **`--tag` 判据与无参判据并存** ——
   验证方式：实跑 `node scripts/version-check.mjs`（无参）在真实仓库退出 0；
   且断言 `version-check.mjs` 里**同时**存在无参的
   「`pkg >= 最高已发布 tag`」判据与 `--tag` 的「`tag == 当前版本`」判据
   （两条都删掉或只留一条都判不过）。

3. **`release.yml` 不自己比对版本号，但调用唯一判据** ——
   验证方式：断言 workflow **「校验 tag 命名空间」那一步的可执行代码**里
   - **不含**任何自行取版本号比对的逻辑（`PKG=` / `TAG_SEMVER` / `case ... TAG`）；
   - **含** `node scripts/version-check.mjs --tag`；
   > **为什么这条不能省**：ADR-106 §5「同一问题只能有一处判定」。
   > 内联回 workflow 等于在 workflow 里**再建一处**版本号判定 ——
   > 正是 `v3-cicd-compat` 当初要消除的形态。

4. **`release.yml` 的触发模式两类都在** ——
   验证方式：断言含 `- 'v*'` 与 `- 'plan-*/v*'`（ADR-110 决策二要求保留）。

5. **命名合法性的唯一判据不变** ——
   验证方式：断言 `release.yml` 仍含 `node scripts/tag-namespace.mjs`；
   且实跑 `node scripts/tag-namespace.mjs`（无参）退出 0。

6. **`v3-cicd-compat` 的形态断言按 ADR-110 校准** ——
   验证方式：断言该验收文件里**不再**出现 `plan-0.7.1/` 这类旧形态
   （`plan-<semver>/v<n>` 已被 ADR-110 取代），
   且**仍**断言 `plan-<planId>/v<n>` 形态合法（用真实的 13 位 planId）。

7. **`v3-cicd-compat` 的版本比对断言改为「实跑 `version-check.mjs --tag`」** —
   验证方式：断言该验收文件里**实跑**该脚本（不再抽取 workflow 里的 shell），
   且**不再**含 `TAG_SEMVER`（那段 shell 已移出 workflow）。

8. **`v3-cicd-compat` 的写集边界判据按 ADR-113 决策四改写** ——
   验证方式：断言该验收文件里 `FROZEN_REFS` 仍**存在**（边界检查没被删掉），
   但 `scripts/version-check.mjs` 从「不可改」名单里**移出**，
   改为「其改动仅限新增 `--tag` 判据」的定向断言
   （原有三条判据一条都不能少）。

9. **`npm test` 全绿、`npm run lint` 通过。**

10. **不越界** —— 改动只在写集内；
    `docs/adr/adr-110-*.md`、`docs/adr/adr-113-*.md` 的**规则正文**
    与 `docs/实战缺陷记录-nimrtc-v14.md` 不得改动
    （ADR 已定稿，实施阶段只许照着做，不许顺手改规则）。
    验证方式：`git status --porcelain` 断言改动路径全部落在写集内。

## 关键实现要点（规格里已定，实施时不要重新发明）

### `--tag` 的判据形状

```
tag 形态                判什么                              结果
v<semver>               必须 == package.json 的 version     不等 → 非 0 退出
plan-<planId>/v<n>      不比（版本锚点是历史）               → 0
其它（认不出版本号）    报错（认不出这次发的是哪一版）       → 非 0 退出
```

**为什么 `plan-*` 不校**：ADR-110 决策一 —— 版本锚点是**历史**，
不该因当前版本变动而失效（那正是 ADR-110 缺陷一的病根）。

### 版本号怎么取

`package.json` 的 `version` 已经是 semver（`0.7.1`）。
tag 里的版本号：`v<semver>` 去掉 `v` 前缀。
**不做 semver 范围比较** —— 只判**字面相等**。
「`pkg >= 最高已发布 tag`」那条无参判据已经在管「落后」，
本条只管「**这次发的** == 当前版本」，两条**不重叠**。

### 错误信息要说清什么

必须能让人一眼看出「哪个 tag」「期望哪个版本」「实际哪个版本」——
三样都要有。参考现有 `version-check.mjs` 的 `fail()` 风格。

### `--tag` 与无参的关系

**并存**，不是二选一。无参跑时**不触发** `--tag` 判据
（否则本地检查会被历史 tag 污染 —— ADR-110 缺陷一的同一坑）。

### workflow 里怎么调

```yaml
- name: 校验发布 tag 与仓库版本一致
  run: |
    set -euo pipefail
    if [ "${GITHUB_REF_TYPE}" = "tag" ]; then
      node scripts/version-check.mjs --tag "${GITHUB_REF_NAME}"
    fi
```

**放在「校验 tag 命名空间」之后、`pnpm install` 之后** ——
先判命名合法（命名非法的 tag 说不出自己是不是版本锚点），
再判版本一致（脚本要读 `pnpm-lock.yaml` 并加载 `js-yaml`，依赖必须先装好）。

### `v3-cicd-compat` 验收的校准要点

- 形态断言：`plan-0.7.1/v1` → 换成**真实的** `plan-1795507341754/v1`
  （13 位 planId，ADR-110 规定的形态）；
- 版本比对断言：从「抽取 workflow 里的 shell 再用 bash 跑」改为
  「**实跑** `version-check.mjs --tag`」——
  判据从 shell 挪到了脚本里，测试就该跟着挪；
  顺便甩掉「WSL bash 对 `bash -c` 位置参数处理不一致」那个环境坑；
- 写集边界：`FROZEN_REFS` 里**移出** `scripts/version-check.mjs`，
  但**保留** `scripts/tag-namespace.mjs` 与 `scripts/tag-map.json`，
  并为 `version-check.mjs` 加一条**定向**断言（它的改动只能新增 `--tag` 判据，
  原有三条判据一条都不能少）。

> **为什么要保留边界检查而不是删掉** ——
> 删掉就等于放弃边界检查。ADR-113 决策四的做法是**按新规则改写**，
> 不是**取消**。

## 风险

- **`--tag` 判据可能误伤 `plan-*` tag 的发布** ——
  ADR-110 决策九明确「两者不是冗余，是两个轴」。
  若 `plan-*` tag 触发的发布本该发 `package.json` 的版本，
  那**就该**通过；不通过说明 `package.json` 与该计划的意图不符 ——
  那是**真问题**，该被拦。
  应对：验收标准 1 断言 `plan-<planId>/v1` 退出 0。
- **CI 上 `scripts/version-check.mjs` 依赖 `js-yaml` 与 `pnpm-lock.yaml`** ——
  它本来就在 `prepublishOnly` 里跑（ADR-108），依赖是现成的。
  但 CI 上 `pnpm install --frozen-lockfile` 必须在**这一步之前**完成。
  应对：把这一步放在 `pnpm install` 之后的既有步骤区里（不改依赖顺序）。
- **`version-check.mjs` 从 cwd 读 `package.json`**（不是从脚本位置读）——
  这是 ADR-108 刻意的设计（脚本报的必须是「正在被校验的那个项目」）。
  CI 里 cwd 是仓库根，**恰好**就是 zelto 自己 —— 语义正确。
- **改动 `v3-cicd-compat` 的验收文件要小心「自己绿自己」** ——
  改验收断言去迎合实现，是**改判据**而不是**修实现**。
  应对：本片**先定 ADR、再改实现、最后改验收**，
  且验收的每一条新断言都必须**实跑脚本**验证（断言文本证明不了算得对）。
- **并发会话在本仓有未提交改动**（`policy/*`、`src/adapters/web/*` 等）——
  写集边界断言要把它们排除掉，否则会把「别人的活」算成越界。
  应对：照抄现有验收文件里那份排除清单。
- **并发会话可能 `git reset --hard` 清掉未提交的工作** ——
  实测已发生一次（本片的 ADR / 规格 / 脚本改动被清掉一次）。
  应对：**改完尽早提交**，别攒着。

## 备注

- 本片实施 ADR-113。ADR 本身已定稿，实施阶段**不得改 ADR 的规则**。
  若实施中发现规则有问题，**停下来报告**，不要自行改规则。
- `scripts/adr-trace-check.mjs` 的 `ADR_PREFIXES` 写死了
  `adr-102` / `adr-103` / `adr-104` —— 把 ADR-113 纳入受检范围是**契约面变更**，
  **不在本片范围**。本片只回填哈希 + 在 `docs/adr-trace-index.md` 加行。
- 本片的写集与 `v3-cicd-compat` 有交集（都改 `release.yml` 与那个验收文件）。
  本片**基于已合并的 `v3-cicd-compat`** 实施 —— 两片不并行。
