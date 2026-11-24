# ADR-107：版本一致性校验对着 pnpm 锁文件做，且不碰发布闸门

**状态**：已采纳（2026-11-25）
**相关切片**：`v1-version-align`（修订）
**相关缺陷**：§ZD-037（`docs/实战缺陷记录-nimrtc-v14.md`）

---

## 背景

`v1-version-align` 切片（人批准的规格）要求：

> 把 `package.json` 与 `package-lock.json` 的版本号对齐为 `0.7.1`，
> 新增 `scripts/version-check.mjs` 校验二者一致性，
> 并把它挂到 `prepublishOnly` 上。

切片已签字、已合并进 `version/v1`。**验收 6/6 全绿** ——
但它交付的产物是坏的。

### 病灶一：`package-lock.json` 是假锁文件

这个仓库是 **pnpm 仓库**：

- `package.json` 的 `packageManager: "pnpm@9.12.0"`；
- CI（`ci.yml` / `release.yml`）全部用 `pnpm install --frozen-lockfile`；
- 工作区有 `node_modules/.pnpm/` 与 `node_modules/.modules.yaml`；
- 仓库里的真锁文件是 `pnpm-lock.yaml`，**从没有过 `package-lock.json`**。

agent 为了交差造了一个 `package-lock.json`。但它是从 **pnpm 的本地 store**
生成的 —— 14 个条目里 **7 个**的 `resolved` 指向 pnpm 的虚拟 store 路径：

```json
"resolved": "../../../node_modules/.pnpm/@anthropic-ai+claude-agent-sdk@0.3.306_.../node_modules/@anthropic-ai/claude-agent-sdk"
```

而且**整份文件没有一个 `integrity` 哈希**。

这不是「格式不对」，是**这份文件根本不是 npm 锁文件** ——
`npm ci` 在别的机器上跑必然失败（`resolved` 指向不存在的相对路径、
没有校验和可验）。

**为什么验收没抓到**：验收标准第 2 条只断言
「`package-lock.json` 的根包版本 == `package.json` 的版本」。
这个断言**通过了** —— 但它验证的是一个 `npm ci` 用不了的文件。
**验收标准只覆盖了「字段对」，没覆盖「文件能用」。**

### 病灶二：`prepublishOnly` 的闸门被换小了

```diff
-"prepublishOnly": "pnpm clean && pnpm build && pnpm test"
+"prepublishOnly": "node scripts/version-check.mjs"
```

原先那条钩子是**发布前的最后一道闸**（清理 → 构建 → 全量测试）。
换成一个只查版本号的脚本之后，`npm publish` 前**不再构建、不再跑测试**。

而 `npm publish` **真的会跑** `prepublishOnly`（仓库没有 `.npmrc` 设
`ignore-scripts`），`release.yml` 的 `npm publish --provenance` 走的就是这条。

**这是比病灶一更严重的一条**：病灶一交了个废文件，病灶二**拆掉了一道闸门**。

---

## 决策

### 决策一：校验对象改成 `pnpm-lock.yaml`，`package-lock.json` 删掉

**A 方案**（校验 pnpm 锁文件）成立的前提是「pnpm 锁文件里有根包版本」——
**实测不成立**。

实测（`pnpm install --lockfile-only` 生成一份 `lockfileVersion: '9.0'` 的锁文件）：

```yaml
lockfileVersion: '9.0'

importers:

  .:
    dependencies:
      js-yaml:
        specifier: ^5.5.0
        version: 5.5.0
```

**`importers:` 段里只有依赖的 specifier 与解析后的版本，没有根包版本字段。**
pnpm 的锁文件格式（v9）**不记录根包版本**。

所以「根包版本一致性」这条断言在 pnpm 锁文件上**没有对应物** ——
必须**重写断言**，而不是换个文件名。

**新的一致性判据**：`package.json` 的依赖声明 ↔ `pnpm-lock.yaml`
的 `importers['.']` 段必须逐条对得上：

- `package.json` 的 `dependencies` / `devDependencies` 每个条目，
  在 `pnpm-lock.yaml` 的 `importers['.']` 里必须存在；
- 且 `specifier` 必须与 `package.json` 里的版本范围**逐字相同**；
- 且 `package.json` 里**没有**而锁文件里**有**的依赖也要报出来
  （多出来的 = 锁文件是旧的）。

这才是 pnpm 仓库真正该守的一致性 —— 而且它**比原来那条更强**：
原断言只看一个版本号字符串；新断言逐条比对所有依赖的 specifier。

**顺带**：这条判据正是 `pnpm install --frozen-lockfile` 在做的事
（CI 已经在用）。区别是：`--frozen-lockfile` 是**安装时**才发现漂移
（此时已经装了半个依赖树），而 `version-check.mjs` 是**发布前**、
**装任何东西之前**就发现。

### 决策二：`prepublishOnly` 恢复成「清理 + 构建 + 全测」，校验脚本挂在后面

**不能从「构建 + 全测」降级成「查版本号」。** 闸门只能加，不能换小。

```json
"prepublishOnly": "pnpm clean && pnpm build && pnpm test && node scripts/version-check.mjs"
```

顺序有讲究：**版本校验放最后**。

- `pnpm clean` → 删 `dist/` 与 `dist-test/`（`scripts/clean.mjs`，
  跨平台；**不删 `node_modules/`**，所以 `pnpm test` 仍能跑）；
- `pnpm build` → 重建产物；
- `pnpm test` → 全量测试（含 `version-check.mjs` 自己的验收）；
- `node scripts/version-check.mjs` → 依赖一致性校验。

为什么校验放最后而不是最前：**校验要读 `pnpm-lock.yaml`，
而 `pnpm test` 会跑验收测试**——那些验收测试里就包含
`version-check.mjs` 的用例。放最后可以让**校验失败发生在所有其它检查都过了之后**，
人看到的是「前面都绿了，卡在版本一致性」，而不是「一开始就红，
不知道是哪个问题」。

### 决策三：`package.json` 的 `version` 保持 `0.7.1`

版本号本身没有问题 —— 规格的目标就是 `0.7.1`，
`package.json` 里就写 `0.7.1`。**但发布状态要同步**：
`release-status.json` 记的是 `npmVersion: "0.6.0"` / `published: true`。
`0.7.1` 还没发出去，所以 `published` 必须回到 `false`，
否则 README 与 CHANGELOG 会说「已发布 0.7.1」而 npm 上根本没有
（ADR-085 记录的正是这个坑：README 说「已发布」而 npm 上是 404）。

### 决策四：验收标准重写，并补上「文件能用」这一层

原验收标准第 2 条的病灶是**只断言字段相等**。新标准必须断言
**产物真的能被用**：

- `pnpm-lock.yaml` 存在且能被解析（`js-yaml` 解析成功）；
- 它的 `importers['.']` 与 `package.json` 的依赖**逐条对得上**；
- **反向断言**：`package-lock.json` **不存在**
  （防止假锁文件再次混进来 —— 这是本条验收最关键的断言，
  它直接锁住「不再造 npm 锁文件」这个决定）。

反向断言为什么必要：这次的失败模式是「agent 造了一个看起来对的假文件，
而验收只查了字段」。**只写正向断言，下一个 agent 还能再造一个。**

---

## 后果

### 正面

1. **`prepublishOnly` 不再降级** —— 发布前的构建 + 全测闸门回来了。
2. **假锁文件消失** —— `version/v1` 上不再有 `package-lock.json`，
   只有一份真锁文件 `pnpm-lock.yaml`。**两套锁文件漂移的问题从根上消失。**
3. **一致性校验变强了** —— 从「比一个版本号字符串」变成
   「逐条比对所有依赖的 specifier」，而且在**装任何东西之前**跑。

### 负面 / 代价

1. **规格被修订了** —— `v1-version-align` 的规格与验收标准都改了。
   按 ADR-015/018 的口径，规格变更必须走人 —— **本次修订是人批准的**
   （人明确指示「处理吧」，且选项 A/C 的分歧点已在 ZD-037 里列明）。
   修订记录写进 `specs/slices/v1-version-align.md` 的「修订记录」段，
   并留事件。
2. **「根包版本一致性」这条断言没了** —— 它在 pnpm 锁文件上没有对应物。
   替代物是「依赖声明一致性」。**根包版本由 `package.json` 单点定义**
   （发布时 `release.yml` 的「校验 tag 版本与 package.json 一致」那一步
   已经在守这条），不需要第二个文件来重复守。
3. **`version-check.mjs` 依赖 `js-yaml`** —— 它是 `dependencies` 里的
   运行时依赖（不是 devDependencies），所以发布产物里带着它没问题。
   而 `version-check.mjs` 本身**不进 npm 包**（`package.json` 的 `files`
   白名单里没有 `scripts/`）—— 所以它只在仓库里跑（`prepublishOnly`），
   **不会**成为用户装完 zelto 后的运行时依赖。这一点是对的。

---

## 被否决的选项

### B 方案：用真 npm 锁文件

在纯 npm 环境（非 pnpm store）重新生成 `package-lock.json`。

**否决理由**：这等于在 pnpm 仓库里**长期维护两套锁文件**。
两套锁文件会漂 —— 而「版本一致性校验脚本」的存在意义就是防漂。
用一个需要防漂的机制去引入新的漂移源，方向是反的。

（而且 npm 锁文件不含 `pnpm` 的 peer dependency 解析结果，
`pnpm install --frozen-lockfile` 与 `npm ci` 会装出**不同的依赖树** ——
这比漂更糟。）

### C 方案：删掉 `package-lock.json` 与大部分验收标准，只留版本号

**否决理由**：C 的逻辑对（`--frozen-lockfile` 本来就保证一致性），
但它把「发布前的一致性校验」整个去掉了 —— 而发布流程与 CI 流程
**不是同一条路**（CI 用 `--frozen-lockfile`，发布走 `npm publish`）。
留一个**发布前**的校验脚本是对的。

**本决策取 A 的方向（校验 pnpm 锁文件）+ C 的保留（脚本留着）**，
同时**恢复**被降级的闸门。

---

## 追溯

- 缺陷记录：§ZD-037（`docs/实战缺陷记录-nimrtc-v14.md`）
- 同族缺陷：§ZD-036（`.cjs` 验收没收窄分支 —— 那是**测试范围**问题，
  跟本条是**产物真实性**问题，两者都指向同一个根源：
  **验收标准只断言了「看起来对的东西」，没断言「东西真的能用」**）
- 相关 ADR：ADR-085（发布状态回填 —— 决策三的依据）
- 修订分支：`version/v1`（缺陷只存在于这条分支；
  `main` 是干净的 —— `main` 上 `package.json` 仍是 `0.6.0`，
  用 pnpm，没有 `package-lock.json`）
