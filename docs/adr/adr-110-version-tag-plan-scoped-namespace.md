# ADR-110：版本 tag 的命名空间按「计划」寻址，版本号从 tag 里移出去

**状态**：已采纳（2026-11-25）
**取代**：ADR-056 D6 的 tag 命名部分、`plan-<semver>/v<n>` 规则
（`docs/tag-namespace.md` 所述 v2-tag-namespace 规格）
**相关**：ADR-018（签字不自动合并）、ADR-056（版本分支是追溯锚点）、
ADR-076（D-71 空操作合并的 mergeCommit 真实性）、
ADR-078（tag 记录以 git 事实为准）、ADR-085（发布状态的真源是文件）、
ADR-106（同一问题只能有一处判定，`docs/adr-106-spec-write-set-exemption.md`）、
AGENTS.md 硬约束 C1–C9
**相关缺陷**：见 `docs/实战缺陷记录-nimrtc-v14.md` §ZD-038

---

## 背景

`v2-tag-namespace` 切片定下了 tag 命名规则 `plan-<semver>/v<n>`
（如 `plan-0.7.1/v3`），并写了 `scripts/tag-namespace.mjs` 守它。
迁移那批存量裸 tag 时（2026-11-25），实测出**四个真缺陷** ——
不是「迁移做得不干净」，是**规则本身有洞**。

### 缺陷一：`<semver>` 与 `package.json` 绑定 —— 版本一漂移，历史 tag 全部变非法

规则要求 `plan-<semver>/v<n>` 的 `<semver>` == `package.json` 的 `version`。
`package.json` 是**当前**版本；tag 是**历史**。

实测（2026-11-25，`package.json` = `0.7.1`）：

```
node scripts/tag-namespace.mjs plan-0.7.1/v3   → 合法
node scripts/tag-namespace.mjs plan-0.7.0/v1   → 退出码 1
    [版本号不一致] plan-0.7.0/v1 的 <semver> 是 0.7.0，package.json 当前版本是 0.7.1
```

所以 `0.7.1` 发出去、`package.json` 改成 `0.8.0` 的那一刻，
**所有 0.7.1 的 tag 同时变成非法**。

这不是小事 —— 它会**卡死发布闸门**：

```js
// scripts/build.mjs
const RELEASE_STAGES = [
  { key: 'tag-namespace', label: 'Git Tag 命名空间治理', script: 'scripts/tag-namespace.mjs' },
  // ...
];
// runStage() 用 spawnSync(process.execPath, [scriptPath]) —— **不传任何参数**
```

`tag-namespace.mjs` 无参运行时读 `git tag`（**全部** tag）——
所以 `package.json` 一升版，**历史上完全正常的 tag 会让 `build.mjs --release` 失败**。
发布闸门因为一条历史 tag 而**永远打不开**。

> **实测确认**：当前 `package.json` = `0.7.1`，仓库已有 `plan-0.7.1/v2`、`plan-0.7.1/v3`。
> 下一次升版（无论升到 `0.7.2` 还是 `0.8.0`）**立刻复现**。
> 这不是「将来可能」—— 是「下一次发版必踩」。

**更根本的问题**：这条规则把**两种不同的东西**塞进了同一个字段。
`<semver>` 在 tag 里表达的是「这一版属于哪个发布批次」，
而 `package.json` 的 `version` 表达的是「**现在**要发的是哪一版」。
两者**必然**在某一刻分叉 —— 那时规则就自相矛盾了。

### 缺陷二：`<semver>/v<n>` 装不下多个计划 —— 名字会被抢占

`plan-<semver>/v<n>` 里的 `<n>` 是「这一批里的第 n 个版本」。
但历史上多个计划**各自**都有自己的 v1/v2/v3：

| 计划 | 自己的 v1 |
|------|----------|
| `plan-1794562105642`（sign-review） | `532f942` |
| `plan-1795422836717`（0.7.0 可验证性） | `e4034af`（正确的诚实锚点） |
| `plan-1795507341754`（0.7.1 追溯一致性） | `84be3ce` |

三个不同的版本都想叫 `plan-0.7.1/v1` —— **只有一个能叫**。

实测后果（本次迁移）：裸 tag `v1` 改名成 `plan-0.7.1/v1`，
指向 `532f942`（sign-review 计划的 v1）。而 `plan-1795422836717`
自己的 v1（切片 `v1-contracts-schemas` 等，四个合并点）
**从来就没被任何 tag 指向过** —— `532f942` 里**不含**那些提交
（实测：`21a89d9` / `8e2d9b6` / `afa0057` / `e4034af` 四个合并点
`merge-base --is-ancestor` 全部为假）。

于是**「0.7.0 计划 v1 的 tag」从一开始就指错了** —— 它指着一个别的计划的版本。
这不是迁移搞坏的，是规则**从设计上就不可能同时装下它们**。

> **精确表述（避免夸大）**：0.7.0 计划 v1 的四个切片合并点
> （`afa0057` / `e4034af` / `8e2d9b6` / `21a89d9`）**都在 main 上**，
> 且都是 `plan-0.7.1/v2` 的祖先 —— **内容没丢**。
> 但**没有任何一个 tag 把它们当作自己的指向** ——
> 也就是说「0.7.0 计划 v1」这个版本**从来没有自己的锚点**，
> 而「某版整体长什么样」这个不可变锚点恰恰是 tag 的全部意义。
> 内容在 ≠ 锚点在。

### 缺陷三：`ship` 默认打出的 tag 是非法 tag —— 工具自己造自己的非法

```ts
// src/core/version/branch.ts
export function versionTagName(label: string): string {
  const sanitized = label.trim().replace(/[^A-Za-z0-9._-]+/g, '-')...;
  return sanitized || 'unnamed';       // ← label 是 "v1" 就返回 "v1"
}
```

```ts
// src/cli/commands/version-ship.ts
const tag = version.tag ?? versionTagName(versionLabel);   // ← 缺省 → 裸 tag
```

`version.tag` 是**计划里手工填的**（`.zelto/versions/*.json`）。
没填就用 `versionTagName(label)` —— 得到 `v1`、`v2`、`v3` —— **正是规则认定为非法的形态**。

实测：当前计划 `plan-1795507341754` 的 v1 / v2 **都没填 `tag`**，
所以它们一旦 ship，会打出裸 `v1` / `v2` —— **当场违反自己刚定的规则**。

> 实测佐证：`plan-1795422836717` 的 v1/v2/v3 里 `tag` 字段是 `v1`/`v2`/`v3`，
> `plan-1794562105642` 的 v1 是 `v1` —— 全是裸 tag。
> 计划里存的**就是**非法名。

### 缺陷四：CI 读不到「哪个 tag 属于哪个计划」

版本计划文件在 `.zelto/versions/*.json`，而 `.zelto/` 在 `.gitignore` 里
（实测：`git ls-files .zelto` → **0 个文件**）。

于是任何需要在 CI 里回答「这个 tag 对应哪个计划的哪一版」的地方，
**都拿不到数据源**。实测：全仓 95 个被跟踪的规格文件里，
**没有一个**带 `version:` frontmatter（`readVersionFromSpec()` 那条路
对现有规格**完全失效**）；计划 id 在被跟踪文件里只出现 2 次，
而且都在 `docs/` 和 `policy/` 里，不是结构化数据。

---

## 决策

### 决策一：tag 按「计划」寻址 —— `plan-<planId>/v<n>`

**新规则**：

```
plan-<planId>/v<n>          版本交付锚点（这一版的产物汇聚点）
v<major.minor.patch>         发布锚点（发到 npm 的那一版）
```

`<planId>` 就是版本计划自己的 id（`plan-1795507341754` 这种）。
**`<semver>` 从 tag 里移出去** —— 它本来就不该在 tag 里
（缺陷一：它是「当前」的概念，tag 是「历史」的）。

**为什么这样就彻底了**：

| 原缺陷 | 新规则下 |
|-------|---------|
| 缺陷一：版本漂移致历史 tag 失效 | tag 里没有版本号，**与 `package.json` 无关**，永不失效 |
| 缺陷二：多计划抢占同名 | planId 唯一，**每个计划的每个版本都有唯一名字** |
| 缺陷三：ship 打出非法 tag | 派生成 `plan-<planId>/v<n>`，**天然合法** |
| 缺陷四：CI 读不到 plan↔tag 关系 | planId 在 tag 里，**CI 直接从 tag 名读出计划** |

**实例**（本仓现状按新规则应当如此）：

```
plan-1794562105642/v1     sign-review 计划的 v1
plan-1795422836717/v1     0.7.0 计划的 v1
plan-1795422836717/v2     0.7.0 计划的 v2
plan-1795422836717/v3     0.7.0 计划的 v3
plan-1795507341754/v1     0.7.1 计划的 v1
plan-1795507341754/v2     0.7.1 计划的 v2
plan-1795507341754/v3     0.7.1 计划的 v3
```

互不冲突，语义自明 —— **看 tag 就知道是哪个计划的哪一版**。

### 决策二：版本号一致性判定从「tag 命名」里**移出去**，落到发布锚点上

「这一版要发的是不是 `package.json` 现在那个版本」——
这条保护**必须保留**（ADR-106 §5：同一问题只能有一处判定；
`v3-cicd-compat` 已经在 `release.yml` 里实现了它）。

但它的**位置**要改：它属于**发布锚点**（`v<semver>`），不属于**版本锚点**（`plan-*/v*`）。

| tag 形态 | 语义 | 校不校版本一致 |
|---------|------|---------------|
| `plan-<planId>/v<n>` | 版本交付锚点 | **不校** —— 它是历史，不该因当前版本变动而失效 |
| `v<semver>` | 发布锚点 | **校** —— 发的包必须 == `package.json` 的 `version` |

于是 `release.yml` 的两段判定**职责清晰**：

```
① 命名合法性 → scripts/tag-namespace.mjs（唯一判据，workflow 只调用）
② 版本一致性 → 只对 v<semver> 形态校（发布锚点才有「当前版本」这回事）
```

**注意 `plan-*/v*` 形态现在也需要能被 workflow 触发**（它现在就能）。
但 workflow 里那段「从 tag 里抽 semver」的 shell 代码要对新形态**明确不适用** ——
`plan-1795507341754/v3` 里**没有** semver 可抽。

### 决策三：`ship` 默认派生出合法 tag —— `versionTagName` 改为计划感知

```ts
// 新增（core/version/branch.ts）
export function planVersionTagName(planId: string, label: string): string {
  // → plan-<planId>/v<label>
}
```

`version-ship.ts` 的取值顺序改为：

```
version.tag（计划里显式钉的）  ??  planVersionTagName(planId, version.version)
```

**为什么保留 `version.tag` 优先**：ADR-078 确立了「tag 记录以 git 事实为准」，
而 `version.tag` 是**人可以在计划里显式指定**的钉子 —— 那是有意的追溯声明，
不该被自动派生覆盖。

**为什么不再有「裸 tag」这条路**：派生结果**恒为合法**。
人想钉非法名，那是他**显式**填的 `version.tag` —— 那是人的声明，
校验脚本会报出来，**但那是人自己的选择**，不是工具默认造出来的。

### 决策四：校验脚本拆成「命名合法性」与「发布一致性」两支

`scripts/tag-namespace.mjs` 的职责收窄为**只管命名**：

| 形态 | 判据 |
|------|------|
| `plan-<planId>/v<n>` | 合法 |
| `v<semver>` | 合法（**不再与 `package.json` 比对**） |
| 其它（含裸 `v1`） | **非法** |

**版本一致性判定移到 `scripts/version-check.mjs`**（已存在，
`docs/adr-108-version-check-pnpm-lockfile.md`），
新增一条：**若仓库里有 `v<semver>` 形态的 tag，则它必须与 `package.json` 一致**。

> **为什么不是留在 tag-namespace.mjs 里**：ADR-106 §5 的教训 ——
> 「同一问题两处判定，必然走偏」。现在两支判据**各管一件事**、
> 判据**不重叠**、**都有唯一出处**。
> 而「发布锚点版本必须 == 当前版本」这件事，`version-check.mjs` 本来就在管
> `package.json` 与锁文件的一致性 —— **版本号的一致性归它管**，
> 才叫「同源」。

### 决策五：`build.mjs --release` 的 tag 段必须**带参**，不许再读全量 `git tag`

即使决策四把版本一致性挪走了，全量扫描**仍有一个隐患**：
无参运行读 `git tag` 全量，任何一条**历史**的非法 tag 都会让发布闸门失败。
历史 tag 应该是**历史事实**，不该阻塞今天发版。

**改法**：`build.mjs` 的 tag 段**显式传参**：

```js
{ key: 'tag-namespace', label: 'Git Tag 命名空间治理', script: 'scripts/tag-namespace.mjs',
  args: ['--published-only'] }   // 只校验「当前发布批次」相关的 tag
```

新增 `--published-only` 模式：**只校验与当前 `package.json` 版本相关的 tag**，
历史批次的 tag 不参与判定。

**为什么要有这个开关**：发布闸门该拦的是「**今天要发的东西**有问题」，
不是「历史上某条 tag 曾经有问题」。全量扫描把历史问题**升格**成了当下的阻断 ——
这正是缺陷一的病根。

### 决策六：版本计划文件纳入 git 跟踪 —— CI 要能读 plan↔tag

`.zelto/` 整体被 gitignore 是对的（运行时状态多、噪音大）。
但**版本计划**不是运行时状态 —— 它是**规格**（人批准的产物），是追溯链的一环。

**改法**：版本计划**双写**到被跟踪的目录：

```
.zelto/versions/<planId>.json          ← 运行时真源（现状，不动）
versions/<planId>.json                  ← 跟踪副本（新增）
```

`VersionStore.save()` 写前者时**同步**写后者；读时**以运行时那份为准**
（避免两份打架）。

**为什么必须双写而不是移动**：`.zelto/` 里有大量运行时状态
（切片状态、事件、锁），整个移出会破坏 C1 的目录约定与现有工具路径。
只把**版本计划**这一类规格产物复制出来，是最小改动。

**CI 拿到什么**：`versions/<planId>.json` 里有 `versions[].tag` —— 发布时
CI 可以断言「tag `plan-1795507341754/v3` 确实对应计划 1795507341754 的 v3」。

### 决策七：存量裸 tag 与旧命名空间的迁移 —— 一张**可核对**的迁移表

`scripts/tag-map.json` 从 `{ "<old>": "<new>" }` 升级为带内容校验的迁移台账：

```json
{
  "v1": { "new": "plan-1794562105642/v1", "commit": "532f942" },
  "v2": { "new": "plan-1795422836717/v2", "commit": "de3e22c" },
  "v3": { "new": "plan-1795422836717/v3", "commit": "0f50c73" }
}
```

**新增的 `commit` 字段是关键**：校验脚本会核对
**该 tag 当前指向的提交 == `commit` 字段**。

**为什么**：缺陷二的根因就是「映射表只记名字，不记内容」——
于是 `v1 → plan-0.7.1/v1` 这条记录**掩盖了**「它装的是别的计划的版本」。
带上 commit，**映射表说的与 git 事实不一致时会报错**，而不是沉默。

**存量裸 tag 怎么归位**（每条都要查清内容，不许猜）：

| 裸 tag | 原本指向 | 属于 | 新名 |
|--------|---------|------|------|
| `v1` | `532f942` | sign-review 计划 | `plan-1794562105642/v1` |
| `v2` | `de3e22c` | 0.7.0 计划 | `plan-1795422836717/v2` |
| `v3` | `0f50c73` | 0.7.0 计划 | `plan-1795422836717/v3` |

> **`v1` 为什么归 sign-review 计划**：实测 `532f942` 是
> `Merge slice v1-sign-review-cli`，且它**不含** 0.7.0 计划 v1 的四个合并点
> （`21a89d9` / `8e2d9b6` / `afa0057` / `e4034af` 全部 `is-ancestor` 为假）。
>
> 0.7.0 计划 v1 的诚实锚点是**它最后一个切片的合并点** `e4034af`
> （`v1-event-hash-chain`）—— 实测提交链顺序为
> `21a89d9`（v1-adr-hashchain）→ `8e2d9b6`（v1-audit-verify-command）
> → `afa0057`（v1-contracts-schemas）→ `e4034af`（v1-event-hash-chain），
> 即 `e4034af` 是最后一个合入的，四片产物在它上面汇聚。
>
> **注意这与计划里 `slices` 数组的书写顺序不同** ——
> 计划里写的是 `v1-contracts-schemas, v1-event-hash-chain,
> v1-audit-verify-command, v1-adr-hashchain`，
> 但**实际合入顺序**（由 git 父提交链实测）是上面那条。
> **锚点必须按 git 事实取，不能按计划里数组的顺序取。**
>
> 该提交**在 main 上**，但**从未被任何 tag 当作指向** ——
> 本次迁移**补上**这个缺失的锚点：`plan-1795422836717/v1` → `e4034af`。

### 决策八：`plan-1795422836717` 的 v1 **补锚点**，`plan-1795507341754` 的 v1/v2 **改指向**

- **0.7.0 计划 v1**（`e4034af`，在 main 上）→ 补 tag `plan-1795422836717/v1`。
  这是**补一个从未存在的锚点** —— 之前没有 tag 指向它。
- **0.7.0 计划 v2**（`de3e22c`）→ 改名 `plan-1795422836717/v2`。
- **0.7.0 计划 v3**（`0f50c73`）→ 改名 `plan-1795422836717/v3`。
  （实测 `0f50c73` 是 `plan-0.7.1/v3` 的**祖先**，内容已被其覆盖 ——
  但它作为「0.7.0 计划 v3 整体长什么样」的锚点**不可替代**，
  所以要**另建** `plan-1795422836717/v3`，不是删掉就完事。）
- **0.7.1 计划 v1**（`84be3ce`）→ 建 `plan-1795507341754/v1`。
- **0.7.1 计划 v2**（`b61c118`，当前是 `plan-0.7.1/v2` 的指向）→ 改指向为
  `plan-1795507341754/v2`。

**每一处重指向都必须先确认「旧指向的内容已被别处覆盖」**——
否则就是毁掉一个计划的锚点（这是本次迁移中真实遇到过的险情：
`plan-0.7.1/v1` 指向的 `532f942` **不被任何其它 ref 包含**，
若贸然重指向，sign-review 计划的原始提交历史就**永久失去锚点**）。

> **实测**：`532f942` 只被 `refs/tags/plan-0.7.1/v1` 引用，
> 不在 main、不在任何 `version/*`、不在任何其它 tag 里。
> 而 sign-review 的**代码内容**都在 main 上（以 `fa8e34e` 等重新提交进入，
> ADR-104 又做了改进）—— 丢的只是原始提交历史。
> **按人批决定：保留 `plan-1794562105642/v1` 指向 `532f942`，不重指向。**

### 决策九：纯 semver tag 与 `plan-` tag **并存**，职责不同

- `v0.3.0` … `v0.6.0` —— **发布锚点**，已经推送到远程，**一个都不动**。
- `plan-*/v*` —— **版本锚点**，本地为主。

两者**不是冗余**，是两个轴：

| | 发布锚点 | 版本锚点 |
|---|---------|---------|
| 形态 | `v<semver>` | `plan-<planId>/v<n>` |
| 语义 | 「发到 npm 的那一版」 | 「某个计划的某一版做完时的产物汇聚点」 |
| 数量 | 每次发布一个 | 每个计划的每个版本一个 |
| 远程 | 已推送 | 本地 |

**为什么不合并成一个**：发布锚点要能**独立于计划**存在
（一次发版可能包含多个计划的切片，见 `docs/zelto-并行自治计划.md` 的
多版本并行模型 —— ADR-056）。一个 `v0.7.1` 可能同时含 0.7.0 计划与 0.7.1 计划的切片。
反过来，一个计划的 v1 未必对应一次发布。

---

## 影响面

### 修改

| 文件 | 改什么 |
|------|-------|
| `src/core/version/branch.ts` | 新增 `planVersionTagName(planId, label)`；`versionTagName` 保留但**不再作 ship 的默认**（仅作 label 清洗工具） |
| `src/core/version/types.ts` | `Version.tag` 注释更新（不再默认裸 tag） |
| `src/cli/commands/version-ship.ts` | tag 取值改为 `version.tag ?? planVersionTagName(planId, version.version)`；dry-run 同步 |
| `src/core/version/store.ts` | `save()` 同步写 `versions/<planId>.json` 跟踪副本（决策六） |
| `scripts/tag-namespace.mjs` | 命名判据改为 `plan-<planId>/v<n>`；**移除**与 `package.json` 的版本比对；新增 `--published-only` 模式；`tag-map.json` 改为带 `commit` 的台账并**核对 git 事实** |
| `scripts/tag-map.json` | 升级为 `{ "<old>": { "new": ..., "commit": ... } }` |
| `scripts/version-check.mjs` | 新增「`v<semver>` tag 必须 == `package.json` 版本」判定 |
| `scripts/build.mjs` | tag 段**带参**（`--published-only`），不再全量扫描（决策五） |
| `.github/workflows/release.yml` | 版本一致性校对应新形态调整：**只对 `v<semver>` 校**；`plan-*/v*` 只校命名 |
| `docs/tag-namespace.md` | 按本 ADR 重写规则与迁移记录 |
| `.gitignore` | 排除 `versions/` 副本中的临时文件（若有） |
| `policy/policy.yaml` | 如需放宽 `versions/**` 写权限，加一条规则（`basis` 指向本 ADR） |

### 新增

- `tests/tag-namespace-adr110.test.ts` —— 本 ADR 的验收测试（见下）。
- `versions/<planId>.json` —— 版本计划的跟踪副本（运行时生成）。

### 不动

- `contracts/schemas/**` —— 零改动。
  **注意**：版本计划**没有** JSON Schema（实测 `contracts/schemas/` 里
  无 version/plan 相关 schema）—— 本 ADR 不新增（新增即契约变更，
  那是另一件事、另一个 ADR）。
- `src/core/policy/`、`src/core/gate/`、`src/core/sched/` —— 零改动。
- `v0.3.0` … `v0.6.0` —— **一个 tag 都不动**（决策九）。

---

## 不变量核查

- **C1**（状态只在文件里）：**加强** —— 版本计划有了跟踪副本，
  「哪个计划的哪一版对应哪个 tag」不再只存在于被 gitignore 的目录里。
- **C2**（`core/` 零第三方依赖、不 import `adapters/`）：**无影响** ——
  新增的 `planVersionTagName()` 是纯字符串运算，只用 Node 内置。
- **C3**（判定确定性）：**加强** —— 校验判据全部是字符串匹配 + `git` 只读查询。
  不调模型、不触网。
- **C4**（append-only 事件流）：**无影响** —— 事件类型零改动。
  tag 名字从 `v3` 变成 `plan-…/v3` 是**内容**变化，不是事件类型变化。
- **C5**（保护域与锚点外部化）：**无影响** —— 不碰保护域、不碰 `policy/lock.json`。
- **C7**（llm 只产草稿）：**无影响**。
- **C9**（写集预约运行时强制）：**无影响** —— 本 ADR 全在 `core/version/`、
  `cli/`、`scripts/`。

---

## 验收标准

1. ✅ `plan-<planId>/v<n>` 形态合法；裸 `v1` / `v2` / `v3` 非法；
2. ✅ **版本号漂移不影响历史 tag 的合法性** ——
   把 `package.json` 的 version 临时改成 `0.9.9`，
   `plan-1795507341754/v3` **仍然合法**（决策一的核心）；
3. ✅ 两个不同计划的同名版本**各有唯一合法名**
   （`plan-1794562105642/v1` 与 `plan-1795422836717/v1` 同时合法、互不冲突）；
4. ✅ `ship` 在 `version.tag` 未设时**派生出合法 tag**（不是裸 tag）；
5. ✅ `version.tag` 显式设定时**优先于派生**（ADR-078 的钉子语义不变）；
6. ✅ `tag-map.json` 的 `commit` 与 git 事实不符时 → **校验失败并报出具体差异**；
7. ✅ `build.mjs --release` 的 tag 段**只校验当前批次**，历史非法 tag 不阻断发版；
8. ✅ `version-check.mjs` 能判出「`v<semver>` tag 与 `package.json` 版本不一致」；
9. ✅ 版本计划的跟踪副本 `versions/<planId>.json` 存在且与运行时副本一致；
10. ✅ `v0.3.0` … `v0.6.0` **四个发布 tag 一字未动**；
11. ✅ `npm test` 全绿、`npm run lint` 通过。

---

## 已知取舍（明确记录，不假装没有）

### 1. tag 名变长，且带上了时间戳样的 planId

`plan-1795507341754/v3` 比 `v3` 长，也不如 `plan-0.7.1/v3` 好看。

**接受**：planId 不出现在 tag 里，「这个 tag 属于哪个计划」就**永远查不到**
（缺陷四）。**可读性换可追溯性，这里要可追溯性。**

### 2. 版本计划要双写（`.zelto/` + `versions/`）

两份文件是**新的不一致源**。

**缓解**：写时同步（同一函数内）；读时以运行时那份为准；
验收标准 9 断言两者一致。**不做双向同步** —— 那会让「谁是权威」变成新问题。

### 3. 存量裸 tag 的归位是**逐条查出来的**，不是推导出来的

`v1` / `v2` / `v3` 三个裸 tag 各自属于哪个计划，
是**查 git 事实**得到的（看合并提交属于哪个切片系列），
不是从「它们叫 v1/v2/v3」推出来的。

**为什么强调**：缺陷二的病根正是「按名字推导归属」。
若按名字推导，`v1` 会被归给「最早那个计划」——
而实测它属于 sign-review 计划，0.7.0 计划 v1 反而**没有** tag。

### 4. 纯 semver tag 的版本一致性，只由 `version-check.mjs` 管

`tag-namespace.mjs` **不再**管。这意味着有人单独跑
`node scripts/tag-namespace.mjs` 时，**得不到**「版本漂移」这类结论。

**接受**：ADR-106 §5 的纪律是「同一问题只能有一处判定」，
不是「每个脚本都要判所有事」。两条判据**职责不重叠**，
且 `build.mjs --release` 两段都跑 —— 预检整体覆盖没有缺口。

### 5. 本 ADR 不修「0.7.0 计划 v1 的 tag 从一开始就指错」这件事的**历史**

那个错是**当时**发生的，git 记录改不了。
本 ADR 做的是**补上正确的锚点**（`plan-1795422836717/v1` → `afa0057`），
并在 `tag-map.json` 里**记下真相**（`v1` 的 `commit` 字段记 `532f942`，
指向 sign-review 计划）。

**不假装历史没发生过。**

---

## 被否决的选项

### A 方案：保持 `plan-<semver>/v<n>`，只是放宽版本一致性判定

**否决理由**：只治了缺陷一（版本漂移），缺陷二（多计划抢占同名）
**原样存在** —— 而它已经在本仓造成实际后果
（`plan-0.7.1/v1` 装的是 sign-review 计划的版本，
0.7.0 计划 v1 **至今没有锚点**）。放宽版本判定**治不了**「名字被抢占」。

### B 方案：只按计划，不含版本号 —— `plan-<planId>/v<n>`，但 planId 用可读短名

**否决理由**：需要另设一张「短名 → planId」的映射表，
而那张表**又是一个新的不一致源**（短名撞了怎么办？）。
直接用 planId —— 它**本来就唯一**（`plan-${Date.now()}` 生成，实测 10 个计划 id 无一重复），
不需要额外映射。

> **保留意见**：planId 确实不好看。若将来人觉得可读性代价太大，
> 可以引入「计划别名」（计划里加一个 `slug` 字段），但**那是另一个决定**，
> 不在本 ADR 范围。

### C 方案：只用 `v<semver>` 一种 tag，取消版本级 tag

**否决理由**：版本级 tag 锚的是「**某个计划的某一版做完时的产物汇聚点**」，
与「发到 npm 的那一版」**不是一回事**：

- 一个计划的 v1 可能压根没进任何发布（还在 `integrated`）；
- 一次发布可能横跨多个计划（ADR-056 的多版本并行模型）。

两者是**两个轴**，合成一个必然丢信息。

### D 方案：把 planId 放进 tag 注释（annotated tag 的 message）而不是名字里

**否决理由**：tag 注释**不参与寻址**。`git tag --list 'plan-*/v*'` 匹配不到它，
CI 也无法从 tag 名推出计划 —— 缺陷四原样存在。
**追溯信息必须在名字里**，注释只能当补充。

---

## 版本追溯

| 字段 | 值 |
| --- | --- |
| 所属版本号 | v0.7.1 |
| 关联 ADR 编号 | ADR-110 |
| 提交哈希 | 0000000000000000000000000000000000000000 |
| 验证方式 | [本 ADR 为规则提案，实施切片落地后回填真实哈希 + 人工复核] |

> **提交哈希为什么是全零**：ADR-110 目前**只立规则、代码未改**
> （`scripts/tag-namespace.mjs` 仍按旧规则判）。
> 全零 = **「还没有对应提交」**，不是「忘了填」。
> 实施切片落地后用 `git show --stat <hash>` 抽查并回填真实哈希。
>
> **注意**：`scripts/adr-trace-check.mjs` 当前只检 `adr-102` / `adr-103` / `adr-104`
> 三份（`ADR_PREFIXES` 是写死的），本 ADR 不在受检范围内。
> 实施切片若要把 ADR-110 纳入受检范围，需同步改那个前缀列表
> —— **那是实施切片的事，本 ADR 不预先改**。

---

## 追溯

- 前置 ADR：ADR-056（版本分支与 tag 是追溯锚点）、
  ADR-076（空操作合并的 mergeCommit 真实性）、
  ADR-078（tag 记录以 git 事实为准）、
  ADR-085（发布状态的真源是文件）、
  ADR-106（同一问题只能有一处判定）
- **取代**：`plan-<semver>/v<n>` 规则（v2-tag-namespace 规格 +
  `docs/tag-namespace.md` 所述内容）
- 相关缺陷：§ZD-038（本 ADR 记录四个缺陷）
- 负向清单：本 ADR **不触碰**「自动合并」「一键批准」「完整 GUI」
  （签字仍不等于合并，ADR-018 不变）
