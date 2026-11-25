# Git Tag 命名空间（ADR-110：按计划寻址）

治理 Git Tag 命名空间，消除 `v1/v2/v3` 这类裸版本 tag 与「多计划各有自己的 v1」的歧义。

> **规则来源**：ADR-110（`docs/adr/adr-110-version-tag-plan-scoped-namespace.md`）。
> 实施切片：`specs/slices/v4-tag-namespace-adr110.md`。
>
> **本文档取代** `plan-<semver>/v<n>` 规则（v2-tag-namespace 规格）。
> 旧规则的记录见本文末「历史：被取代的 `plan-<semver>/v<n>` 规则」。

## 命名规则

tag 分成**两个轴**，职责不同：

| 形态 | 语义 | 数量 |
|------|------|------|
| `plan-<planId>/v<n>` | **版本锚点** —— 某个计划的某一版做完时的产物汇聚点 | 每个计划的每个版本一个 |
| `v<major.minor.patch>` | **发布锚点** —— 发到 npm 的那一版 | 每次发布一个 |

**合法**：

- `plan-<planId>/v<n>` —— 如 `plan-1795507341754/v3`。
  - `<planId>`：版本计划自己的 id，形如 `plan-` + 13 位数字
    （`Date.now()` 生成，实测现有计划 id 全部 13 位、无一重复）。
  - `<n>`：该计划下的版本序号。
- `^v\d+\.\d+\.\d+$` —— 如 `v0.3.0`、`v0.6.0`。

**非法**：

- 裸版本 tag（`v1` / `v2` / `v3`）。
- 旧形态 `plan-<semver>/v<n>`（如 `plan-0.7.1/v3`）——
  `<semver>` 在 tag 里是「**当前**版本」的概念，而 tag 是**历史**，
  两者必然分叉（ADR-110 缺陷一）。

> **为什么 planId 必须严格是 13 位数字** ——
> 放宽成 `plan-.+` 会让旧形态 `plan-0.7.1/v3` 也合法，**等于没改**。

## 为什么命名空间按「计划」寻址

旧规则 `plan-<semver>/v<n>` 有四个实测缺陷（详见 ADR-110）：

1. **版本漂移致历史 tag 永久失效** ——
   `<semver>` 绑 `package.json` 的 `version`，但 tag 是历史、`package.json` 是现在。
   升版当天所有历史 tag 同时变非法，而 `build.mjs --release` 无参跑
   `tag-namespace.mjs`（读全量 `git tag`）→ **发布闸门自锁**。
2. **多计划抢占同名** ——
   多个计划各自都有 v1/v2/v3，同一个 `<semver>/v<n>` 装不下，名字被抢占。
3. **`ship` 默认派生裸 tag** —— 工具自己造自己的非法。
4. **CI 读不到 plan↔tag 关系** —— 版本计划在 `.zelto/`（被 gitignore）。

新规则下：

| 原缺陷 | 新规则下 |
|-------|---------|
| 版本漂移致历史 tag 失效 | tag 里没有版本号，**与 `package.json` 无关**，永不失效 |
| 多计划抢占同名 | planId 唯一，每个计划的每个版本都有唯一名字 |
| ship 打出非法 tag | 派生成 `plan-<planId>/v<n>`，**天然合法** |
| CI 读不到 plan↔tag 关系 | planId 在 tag 里，**CI 直接从 tag 名读出计划** |

## 存量迁移（2026-11-25 已完成）

**最终状态**（`node scripts/tag-namespace.mjs` 无参运行退出码 0）：

| tag | 指向 | 装的是什么 | 在 main 上 |
|-----|------|-----------|-----------|
| `plan-1794562105642/v1` | `532f942` | 计划 `plan-1794562105642`（sign-review）的 v1 | ❌ |
| `plan-1795422836717/v1` | `e4034af` | 计划 `plan-1795422836717`（0.7.0 可验证性）的 v1 | ✅ |
| `plan-1795422836717/v2` | `de3e22c` | 同上，v2 | ✅ |
| `plan-1795422836717/v3` | `0f50c73` | 同上，v3 | ✅ |
| `plan-1795507341754/v1` | `84be3ce` | 计划 `plan-1795507341754`（0.7.1 追溯一致性）的 v1 | ✅ |
| `plan-1795507341754/v2` | `b61c118` | 同上，v2 | ✅ |
| `plan-1795507341754/v3` | `482e0a4` | 同上，v3 | ✅ |
| `v0.3.0` … `v0.6.0` | — | **发布锚点，一个都没动** | ✅ |

**每个锚点的归属是查出来的，不是按名字推导的** ——
判据是「该锚点是否包含该版本**每个切片**的合并点」
（`git merge-base --is-ancestor`）。

> **`plan-1794562105642/v1` 保留指向 `532f942`** ——
> 实测 `532f942`（`Merge slice v1-sign-review-cli`）**不被任何其它 ref 包含**
> （不在 main、不在任何 `version/*`、不在任何其它 tag 里）。
> 若重指向，sign-review 计划的原始提交历史就**永久失去锚点**。
> 按人批决定：保留指向，不重指向。
>
> 它的**代码内容**都在 main 上（以 `fa8e34e` 等重新提交进入，ADR-104 又做了改进）——
> 丢的只是「原始提交历史」这个追溯锚点。

### 迁移台账 `scripts/tag-map.json`

台账从**扁平映射**升级为**带内容校验**的台账：

```json
{
  "v1": { "new": "plan-1794562105642/v1", "commit": "532f9420", "note": "…" },
  "v3": { "new": "plan-1795422836717/v3", "commit": "0f50c73", "note": "…" }
}
```

**`commit` 字段是关键** —— 校验脚本会核对**该 tag 当前指向的提交 == `commit` 字段**。
不符时**报错并报出具体差异**（哪个 tag、期望什么、实际什么）。

> **为什么必须记 commit**：ADR-110 缺陷二的根因正是「映射表只记名字，不记内容」——
> 于是 `v1 → plan-0.7.1/v1` 这条记录**掩盖了**「它装的是别的计划的版本」。
> 带上 commit，**台账说的与 git 事实不一致时会报错**，而不是沉默。

## 校验脚本

`scripts/tag-namespace.mjs` **只管命名**（ADR-110 决策四）：

```bash
node scripts/tag-namespace.mjs [tag...]
node scripts/tag-namespace.mjs --published-only
```

- 带参：校验给定的 tag 列表。
- 无参：从 stdin 逐行读 tag；stdin 无输入时读 `git tag`（校验仓库当前状态）。
- `--published-only`：**只校验与当前发布相关的 tag**（ADR-110 决策五）——
  历史批次的 tag 不参与判定。发布闸门该拦的是「今天要发的东西有问题」，
  不是「历史上某条 tag 曾经有问题」。
- 退出码：`0` = 全部合法；`1` = 有非法命名 / 台账与 git 事实不符。

它**不读 `package.json`** —— 版本号的一致性归 `version-check.mjs` 管。

## 版本一致性（`scripts/version-check.mjs`）

发布锚点的版本一致性**不在** tag 命名里判，而在版本校验里判：

> **`package.json` 的版本不得低于已发布的发布锚点版本。**

- 版本**更高**（准备发新版）→ 放行 —— 那是发布的正常状态。
- 版本**更低**（仓库落后于已发布）→ **拦下** ——
  下一次发布会把旧版本当成「新版本」发出去，而新版本已经在 npm 上。

**只对 `v<semver>` 形态生效** —— 版本锚点（`plan-*`）是**历史**，
不该因 `package.json` 升版而失效。

> **为什么不是「每个发布锚点都等于当前版本」** ——
> `v0.3.0` / `v0.4.0` / `v0.5.0` 是**过去**发出去的版本，
> 它们当然小于当前的 `0.7.1`。那样判，这个脚本**永远跑不过**。

## 发布流水线（`.github/workflows/release.yml`）

- 触发模式：`v*` 与 `plan-*/v*` —— 两类锚点都该能触发。
- 命名合法性：调用 `scripts/tag-namespace.mjs`（唯一判据，workflow 不手写第二套）。
- **版本一致性不再在 workflow 里判** —— `plan-<planId>/v<n>` 里**没有 semver 可抽**
  （planId 是时间戳，抽出来的数字与 `package.json` 毫无可比性），
  且那条判据会把版本锚点拖进版本比对（ADR-110 决策二）。

## 版本计划双写

版本计划**双写**到两个地方（ADR-110 决策六）：

```
.zelto/versions/<planId>.json          ← 运行时真源（读从这里）
versions/<planId>.json                  ← 跟踪副本（CI 要读 plan↔tag 关系）
```

写时同步（`VersionStore.save()`），**不做双向同步** ——
那会让「谁是权威」变成一个新问题。

## 历史：被取代的 `plan-<semver>/v<n>` 规则

> 以下为 v2-tag-namespace 规格的记录，**已不再生效**，保留作历史。

旧规则：`plan-<semver>/v<n>`（如 `plan-0.7.1/v1`），
`<semver>` 须与 `package.json` 的 `version` 一致。

被取代的理由见 ADR-110 的四条缺陷。其中最要紧的是**缺陷一**：

> 实测（2026-11-25，`package.json` = `0.7.1`）：
>
> ```
> node scripts/tag-namespace.mjs plan-0.7.1/v3   → 合法
> node scripts/tag-namespace.mjs plan-0.7.0/v1   → 退出码 1
>     [版本号不一致] plan-0.7.0/v1 的 <semver> 是 0.7.0，package.json 当前版本是 0.7.1
> ```
>
> 升版当天**所有历史 tag 同时变成非法** ——
> 而 `build.mjs --release` 的 tag 段**无参**调用本脚本（读全量 `git tag`），
> 于是**发布闸门被历史 tag 锁死**。

旧规则下的迁移记录（原 `plan-0.7.1/v1` / `v2` / `v3`）
已在本次迁移中改名为 `plan-<planId>/v<n>`。
