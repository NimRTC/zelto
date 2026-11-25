# ADR-113：「触发的 tag 名 == 实际发布版本」这条保护的判据落点

**状态**：已采纳（2026-11-25）
**相关**：ADR-106（同一问题只能有一处判定）、ADR-108（版本一致性校验归 `version-check.mjs`）、
ADR-110（tag 命名空间按计划寻址）、ADR-018（签字不自动合并）
**相关缺陷**：见 `docs/实战缺陷记录-nimrtc-v14.md` §ZD-038 的后续

---

## 背景

### 表面上：三条验收红了

`tests/acceptance/v3-cicd-compat/acceptance.test.cjs` 有 3 条红：

- 「触发条件覆盖 `plan-<semver>/v<n>`」；
- 「版本号比对对纯 semver tag 与命名空间 tag 都生效（保护没被削弱）」；
- 「命名空间校验通过时不阻断：合法 tag 退出码为 0」。

前两条与第三条的**直接**原因很容易被误判：**ADR-110 取代了 `plan-<semver>/v<n>` 形态**，
而 `v3-cicd-compat` 的验收还按旧形态断言（`plan-0.7.1/v1` 现在非法）。
这部分是**过期断言**，改断言即可。

但**第二条不是**。它守的是一条**真实的发布保护被删掉了**。

### 真正的问题：v4 实施把发布保护一起删了

`v3-cicd-compat`（切片，提交 `7d22322`）在 `release.yml` 里留了一段版本号比对：

```bash
PKG=$(node -p "require('./package.json').version")
case "${TAG}" in
  plan-*/v*) TAG_SEMVER="${TAG#plan-}"; TAG_SEMVER="${TAG_SEMVER%%/*}" ;;
  v*)         TAG_SEMVER="${TAG#v}" ;;
  *)          TAG_SEMVER="" ;;
esac
if [ "${TAG_SEMVER}" != "${PKG}" ]; then ... exit 1; fi
```

`v4-tag-namespace-adr110`（切片，提交 `06eefe9`）把**整段删掉了**，
理由写在 `release.yml` 的注释里：

> ADR-110 之后**必须删掉**它 …… `plan-<planId>/v<n>` 里**没有 semver 可抽**。

这个理由**只对 `plan-*` 形态成立**。而**发布锚点** `v<semver>` 形态**仍然有 semver 可抽**，
而且**必须**校 —— 它就是「这次要发的那个版本」。

ADR-110 **决策二**的原话是：

> ① 命名合法性 → scripts/tag-namespace.mjs（唯一判据，workflow 只调用）
> ② 版本一致性 → **只对 `v<semver>` 形态校**（发布锚点才有「当前版本」这回事）

**决策二明确要求保留这条**。而 v4 的规格验收标准 11 把它写成了：

> 校验步骤不得再自行取 package.json 版本号做比对（那是 version-check.mjs 的职责）

这句**只说了「不要在 workflow 里自己做比对」**（这与决策二不冲突），
但 v4 的**实施**连「版本比对本身」也一并删了 —— **决策二的 ② 没有任何实现**。

### 那 `version-check.mjs` 接住了吗？—— 没接住

ADR-110 **决策四**把版本一致性判定的归属指向 `scripts/version-check.mjs`：

> 新增一条：**若仓库里有 `v<semver>` 形态的 tag，则它必须与 `package.json` 一致**

v4 在 `version-check.mjs` 里落的是**另一个判据**：

> `package.json` 的版本必须 **>=** 最高的发布锚点版本

（v4 规格的「关键实现要点」明确否掉了字面读法 ——「每个发布 tag 都等于当前版本 → 永远跑不过」，
所以实施时改了措辞。这个改动本身是对的。）

但**这两个判据方向相反、对象不同**：

| 判据 | 问的问题 | 拦得住什么 |
|------|---------|-----------|
| v4 落的（`pkg >= 最高 tag`） | 仓库版本有没有**落后**于已发布的版本？ | 回滚了 `package.json` 却没回滚发布状态 |
| 决策二要的（`触发的 tag == 当前版本`） | **这次要发的**，跟 `package.json` 对不对得上？ | 打错 tag，发出去的包跟 tag 说的不是一个版本 |

**两者互补，缺一不可。** 只落了前者。

### 缺口的后果（实测可复现）

当前仓库状态（`package.json` = `0.7.1`）下：

```bash
$ git tag v0.6.0 HEAD        # 打个错的 tag
$ npm publish                # 发出去的是 0.7.1（package.json 的版本）
```

- npm 上收到的是 **0.7.1**；
- 仓库的发布锚点却记着 **`v0.6.0`** ——
  **锚点说谎**：从 tag 看不出发出去的到底是哪一版；
- 而 `version-check.mjs` 的「已发布版本」代理是**git tag**，
  于是它认定「已发布到 `0.6.0`」—— 与 npm 上的事实**分叉**。
  后续所有依赖「已发布版本」这个事实的防漂移判据
  （`pkg >= 最高 tag`）从此建立在**错的基准**上。

> **注意这条缺口不是「未来可能」** —— 它是「**下一个打 tag 的时刻**」必踩。

---

## 决策

### 决策一：判据落到 `scripts/version-check.mjs`，新增 `--tag` 参数

`release.yml` **不自己比对版本号**，只**调用**唯一判据：

```bash
node scripts/version-check.mjs --tag "${GITHUB_REF_NAME}"
```

`--tag` 的判据形状：

| tag 形态 | 判什么 | 为什么 |
|---------|-------|--------|
| `v<semver>` | **必须** == `package.json` 的 `version` | 它是**这次要发的那一版** —— 发出去的包必须跟它说的一致 |
| `plan-<planId>/v<n>` | **不比** | 版本锚点是**历史**（ADR-110 决策一），不该因当前版本变动而失效 |
| 其它 | 报错退出（认不出版本号） | 命名合法性归 `tag-namespace.mjs`；走到这里说明两支判据的边界漏了 |

**为什么落在 `version-check.mjs` 而不是 workflow 内联**：

1. **ADR-110 决策四**已经定了归属 ——「版本号的一致性归它管，才叫同源」。
   恢复这条保护时**改位置不改归属**，才是对决策二的兑现，
   而不是又开第三处判定。
2. **ADR-106 §5**：「同一问题只能有一处判定」。内联回 workflow 等于在 workflow 里
   **再建一处**版本号判定 —— 正是 v3-cicd-compat 当初要消除的形态。
3. `version-check.mjs` **已经在**管「`package.json` 与锁文件的依赖声明一致」
   与「`package.json` 不低于已发布版本」—— 版本一致性本来就是它的职责域。
   多一条 `--tag` 判据是**同域扩展**，不是新职责。

### 决策二：`--tag` 与无参判据**并存**，各管一件事

`version-check.mjs` 现在有**三条**互不重叠的判据：

| 判据 | 触发方式 | 拦什么 |
|------|---------|--------|
| 依赖声明一致 | 无参 | `package.json` 与 `pnpm-lock.yaml` 对不上 |
| `pkg >= 最高已发布 tag` | 无参 | 仓库版本**落后**于已发布版本 |
| **触发的 tag == 当前版本** | `--tag <name>` | **这次发出去的包与 tag 说的不是一版** |

**前两条无参跑，第三条只在发布流水线里带 `--tag` 跑** ——
所以「本地跑 `node scripts/version-check.mjs`」不会因为**历史** tag 而失败
（那正是 ADR-110 缺陷一的病根）。

> **为什么 `--tag` 不能与「无参」合并成一条** ——
> 无参判据问的是「仓库状态对不对」，`--tag` 问的是「**这次发布**对不对」。
> 合成一条就会退回「每个发布 tag 都等于当前版本」那个永远跑不过的形态。

### 决策三：v3-cicd-compat 的验收按 ADR-110 校准，而不是回退 ADR-110

`v3-cicd-compat` 的验收里，被 ADR-110 取代的**形态断言**（`plan-0.7.1/v1` 合法）
按新规则改写（`plan-<planId>/v<n>` 合法）；被本 ADR 恢复的**版本比对断言**
改写为「workflow 调用 `version-check.mjs --tag`」。

**不回退 ADR-110** —— 命名空间按计划寻址是对的，
`plan-0.7.1/v1` 确实已经非法。**红的是过期断言与漏掉的保护，不是规则本身。**

### 决策四：v3-cicd-compat 的「三文件哈希不变」判据要改

该切片验收标准 7 断言 `scripts/version-check.mjs` 不得被改动 ——
那是**当片**的写集边界，成立。

但本 ADR 要改它。处置：**该判据改为「`tag-namespace.mjs` 与 `tag-map.json` 仍不可改，
`version-check.mjs` 的改动仅限新增 `--tag` 判据」** ——
写集边界按**新规则**写，不删掉这条判据（删掉就等于放弃边界检查）。

---

## 影响面

### 修改

| 文件 | 改什么 |
|------|-------|
| `scripts/version-check.mjs` | 新增 `--tag <name>` 判据；对 `v<semver>` 校「== `package.json` 的 version」，对 `plan-*` 不校 |
| `.github/workflows/release.yml` | 「校验 tag 命名空间」之后新增一步，调用 `version-check.mjs --tag "${GITHUB_REF_NAME}"`（`ref_type == 'tag'` 时才跑） |
| `tests/acceptance/v3-cicd-compat/acceptance.test.cjs` | 形态断言按 ADR-110 校准；版本比对断言改为「调用 `version-check.mjs --tag`」；写集边界判据按决策四改写 |
| `specs/slices/v3-cicd-compat.md` | 同步标注被 ADR-110 / 本 ADR 取代的条目 |
| `docs/adr-trace-index.md` | 加一行 ADR-113 |

### 不动

- `scripts/tag-namespace.mjs` —— 命名合法性判据**只管命名**（ADR-110 决策四），不因本 ADR 改变。
- `scripts/tag-map.json` —— 迁移台账，与本 ADR 无关。
- `v0.3.0` … `v0.6.0` —— 发布锚点，一个都不动（ADR-110 决策九）。
- `src/core/**` —— 零改动（判定在 `scripts/`，不在 `core/`）。

---

## 不变量核查

- **C1**（状态只在文件里）：**无影响** —— 不新增任何状态载体。
- **C2**（`core/` 零第三方依赖）：**无影响** —— 改动全在 `scripts/` 与 `tests/`。
- **C3**（判定确定性）：**加强** —— 新判据是纯字符串比较 + 只读 `package.json`，
  不调模型、不触网。
- **C4**（append-only 事件流）：**无影响** —— 事件类型零改动。
- **C5**（保护域与锚点外部化）：**加强** —— 「发布锚点必须说真话」这条保护**恢复**了。
- **C7**（llm 只产草稿）：**无影响**。
- **C9**（写集预约运行时强制）：**无影响** —— 改动在 `scripts/` 与 `tests/`。

---

## 验收标准

1. `node scripts/version-check.mjs --tag v<当前版本>` 退出 0；
2. `node scripts/version-check.mjs --tag v<比当前版本低>` **非零**退出，
   错误信息指出版本号不一致；
3. `node scripts/version-check.mjs --tag plan-<planId>/v1` 退出 0
   （版本锚点是历史，不校版本）；
4. `release.yml` 里**没有**任何自行比对版本号的 shell，
   但**有** `node scripts/version-check.mjs --tag`；
5. `node scripts/tag-namespace.mjs`（无参）退出 0 —— 全仓无非法 tag；
6. `npm test` 全绿、`npm run lint` 通过。

---

## 已知取舍（明确记录，不假装没有）

### 1. `--tag` 只在 CI 里被用，本地跑 `version-check.mjs` 不会触发它

**接受**：本地跑无参版是「检查仓库状态」，CI 里带 `--tag` 是「检查这次发布」。
两个问题、两种调用方式。把它做成无参时也生效，会让「历史 tag 判失败」重新污染本地检查
（ADR-110 缺陷一的同一坑）。

### 2. 发布锚点说谎的历史已经发生过

`v0.3.0` … `v0.6.0` 这些 tag 与 npm 上实际发出去的版本**是否一致**，
本 ADR **不追溯**、**不修改**。ADR-110 已知取舍第 5 条是同一条纪律：
**不假装历史没发生过**。

### 3. 本 ADR 不改 `scripts/adr-trace-check.mjs` 的 `ADR_PREFIXES`

那个清单写死了 `adr-102` / `adr-103` / `adr-104`，
加 ADR-110 / 111 / 113 属于**契约面变更**，需另立决定。
本 ADR 只在 `docs/adr-trace-index.md` 里加行并回填哈希。

---

## 版本追溯

| 字段 | 值 |
| --- | --- |
| 所属版本号 | v0.7.1 |
| 关联 ADR 编号 | ADR-113 |
| 提交哈希 | 9861f74306d1349a492ff0a447033d8bb1c48466 |
| 验证方式 | [git show --stat 抽查 + 人工复核] |

> **提交哈希**：本 ADR 落地提交（实施切片 `v5-release-tag-guard`）。
> 落地后**回填真实哈希**。

---

## 追溯

- 前置 ADR：ADR-106（同一问题只能有一处判定）、
  ADR-108（版本一致性归 `version-check.mjs`）、
  ADR-110（tag 命名空间按计划寻址 —— 本 ADR 是它**决策二**的兑现）
- 实施切片：`v5-release-tag-guard`
- 相关缺陷：§ZD-038 的后续（v4 实施遗留的发布保护缺口）
