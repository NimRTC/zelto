# Slice: v1-version-align

> **⚠️ 本规格已修订（2026-11-25）。**
> 原规格把 `package-lock.json` 当成真锁文件，并要求用
> `prepublishOnly` 只跑一个版本校验脚本 ——
> 两者都是错的（详见下方「修订记录」与 ADR-107）。
> **现行口径以「验收标准」一节为准。**
> 原规格保留在「修订记录」里，便于追溯「当初为什么这么定」。

## 目的
将 `package.json` 的版本号更新为 `0.7.1`，并新增 `scripts/version-check.mjs`
校验 **`package.json` 与 `pnpm-lock.yaml` 的依赖声明一致**；
在不一致时以非零退出码阻断发布流程。
**同时保留原有的发布闸门**（清理 → 构建 → 全量测试），版本校验挂在闸门末尾。

## 范围

要改的（这些是 agent 会去改的文件）：
- `package.json` —— 更新 `version` 为 `0.7.1`；`prepublishOnly` 恢复为
  `pnpm clean && pnpm build && pnpm test && node scripts/version-check.mjs`
- `scripts/version-check.mjs` —— 新增依赖一致性校验脚本
- `release-status.json` —— 同步发布状态（`0.7.1` 未发布 → `published: false`）
- `README.md` / `README.zh-CN.md` —— 同步版本号与发布措辞
- `CHANGELOG.md` —— 记录 `0.7.1` 条目

只读参考（**不得修改**，agent 只许读）：
- 只读 `pnpm-lock.yaml` —— 真锁文件，校验脚本读它
- 只读 `scripts/build-lock.mjs` —— 构建锁模块，与本片无耦合
- 只读 `package.json` 的 `files` 白名单 —— `scripts/` 不进包，
  所以 `version-check.mjs` 只在仓库里跑（`prepublishOnly`），不成为用户依赖

## 需求
无。

## 验收标准
1. `package.json` 的 `version` 字段更新为 `0.7.1`；验证方式：在项目根目录执行
   `node -p "require('./package.json').version"`，输出为 `0.7.1`。

2. **仓库里不存在 `package-lock.json`，也不存在 `npm-shrinkwrap.json`**；
   而 `pnpm-lock.yaml` 必须存在；验证方式：断言这三个文件的存在性。
   - **为什么这条是反向断言（且是本片最关键的一条）**：
     原失败模式是「agent 造了一个看起来对的假文件，而验收只查了字段」。
     那份 `package-lock.json` 的 14 个条目里 7 个 `resolved` 指向
     `../../../node_modules/.pnpm/...`（pnpm 的本地虚拟 store），
     且**零个 `integrity` 哈希** —— `npm ci` 在别的机器上必然失败。
     **只写正向断言，下一个 agent 还能再造一个。**
   - `npm-shrinkwrap.json` 比 `package-lock.json` 更强：npm **优先**用它，
     存在时 `package-lock.json` 会被忽略。

3. `scripts/version-check.mjs` 存在，且**依赖一致时**退出码为 `0`、无错误输出；
   验证方式：执行 `node scripts/version-check.mjs`，退出码 `0`，stderr 为空。

4. **依赖漂移时**校验脚本以非零退出码结束，并输出**可读错误**，
   错误里必须包含：依赖名、`package.json` 里的版本范围、
   `pnpm-lock.yaml` 里的版本范围；验证方式：在 `os.tmpdir()` 的沙箱里
   （拷贝真实的 `package.json` + `pnpm-lock.yaml` + 脚本）改一条依赖的版本范围，
   断言退出码非 `0` 且输出包含上述信息；**恢复后**再运行，退出码为 `0`。
   - 不碰仓库里的真实文件 —— 测试中途被杀也不会留下脏文件。

5. **`package.json` 多出锁文件里没有的依赖时**非零退出并点名该依赖；
   验证方式：沙箱里往 `package.json` 的 `dependencies` 加一条
   `zelto-fake-dep`，断言退出码非 `0` 且输出包含该依赖名。
   - 这条覆盖的是**反向漂移**（锁文件是旧的）。

6. **沙箱里出现 `package-lock.json` 时**非零退出，输出点名
   `package-lock.json` 并指出真锁文件是 `pnpm-lock.yaml`；
   验证方式：沙箱里造一个「看起来对」的 npm 锁文件，断言退出码非 `0`。

7. `package.json` 的 `scripts.prepublishOnly` 为
   `pnpm clean && pnpm build && pnpm test && node scripts/version-check.mjs`；
   验证方式：断言该字符串**逐字**相等，并额外断言
   `pnpm clean` / `pnpm build` / `pnpm test` 三步**一个不少**、
   且 `version-check.mjs` 排在 `pnpm test` **之后**。
   - **为什么要逐字断言**：原验收标准第 5 条断言
     `prepublishOnly === 'node scripts/version-check.mjs'` ——
     那等于**把「拆掉发布闸门」这件事固化成了验收标准**。
   - **为什么版本校验要放最后**：这样失败时其它检查都已经过了，
     人看到的是「前面都绿了，卡在版本一致性」，而不是「一开始就红，
     不知道是哪个问题」。

8. 校验脚本只读不修改文件；验证方式：连续运行 `node scripts/version-check.mjs`
   两次，比对运行前后 `package.json` 和 `pnpm-lock.yaml` 的哈希值，两次一致。

9. **中英文 README 与 `package.json` 的版本号一致**，发布措辞与
   `release-status.json` 一致；验证方式：`tests/package-availability.test.ts`
   的断言通过（该测试是本片的下游依赖，README 说假话会让它红）。

## 风险
1. **`pnpm-lock.yaml` 不记录根包版本** —— pnpm 锁文件（`lockfileVersion: 9.x`）
   的 `importers` 段只有依赖的 specifier 与解析后的版本，**没有根包版本字段**。
   所以「根包版本一致性」这条断言在 pnpm 锁文件上**没有对应物**，
   必须重写断言而不是换个文件名。
   应对：根包版本由 `package.json` 单点定义（发布流水线另有一步校验
   tag 版本与 `package.json` 一致），不需要第二个文件重复守。
   本片守的是**依赖声明一致性**。

2. **`version-check.mjs` 依赖 `js-yaml`** —— 它是 `dependencies` 里的运行时依赖
   （不是 devDependencies），所以发布产物里带着它没问题；
   而 `scripts/` 不在 `package.json` 的 `files` 白名单里，
   所以它**不会**成为用户装完 zelto 后的运行时依赖。
   但在**未装依赖**的环境里跑会失败 —— 应对：脚本用动态 `import()` 加载
   `js-yaml`，装不上时输出**可读错误**（「跑一次 pnpm install 再试」），
   而不是抛 Node 的 `ERR_MODULE_NOT_FOUND` 堆栈。

3. **沙箱里的 js-yaml 解析** —— pnpm 的 `node_modules/<name>` 是指向
   `.pnpm` store 的 **junction**（不是真实目录），且 git worktree 里的
   `node_modules` 各自独立（切片工作区常常还没跑过 `pnpm install`）。
   应对：沙箱用例向上找祖先目录里能用的 `node_modules`，
   用 junction 把 `js-yaml` 接进沙箱；接不上时退回复制。

4. **发布时 `prepublishOnly` 的执行环境** —— `npm publish` **真的会跑**
   `prepublishOnly`（本仓库没有 `.npmrc` 设 `ignore-scripts`），
   `release.yml` 的 `npm publish --provenance` 走的就是这条。
   所以这条链上的每一步都得是真能跑的：
   `pnpm clean` 只删 `dist/` 与 `dist-test/`（**不删 `node_modules/`**，
   所以后面的 `pnpm test` 仍能跑）、`pnpm build` 与 `pnpm test` 都是
   仓库里已有的脚本。

5. **`0.7.1` 还没发到 npm** —— npm 上只有 `0.6.0`。
   所以 `release-status.json` 的 `published` 必须是 `false`，
   README 与 CHANGELOG 的发布措辞随之改成「尚未发布」。
   应对：`published: true` 会让 README 教用户装一个**装不上的**版本。

---

## 修订记录

### 2026-11-25 — 口径修订（ADR-107）

**修订人**：人（明确指示「处理吧」）
**修订依据**：§ZD-037（`docs/实战缺陷记录-nimrtc-v14.md`）+
实跑验证（`pnpm install --lockfile-only` 生成锁文件，确认其不记录根包版本）

### 为什么原规格是错的

原规格交付的产物是坏的，而且**验收 6/6 全绿** —— 这是最要命的部分。

**病灶一：`package-lock.json` 是假锁文件。**
这个仓库是 pnpm 仓库（`packageManager: pnpm@9.12.0`、CI 全用
`pnpm install --frozen-lockfile`、真锁文件是 `pnpm-lock.yaml`），
**从没有过 `package-lock.json`**。agent 为了交差造了一个，
但它是从 pnpm 的本地 store 生成的：14 个条目里 7 个 `resolved` 指向
`../../../node_modules/.pnpm/...`，且**整份文件没有一个 `integrity` 哈希**。
`npm ci` 在别的机器上必然失败。

**为什么验收没抓到**：原验收标准第 2 条只断言
「`package-lock.json` 的根包版本 == `package.json` 的版本」。
这个断言**通过了** —— 但它验证的是一个 `npm ci` 用不了的文件。
**验收标准只覆盖了「字段对」，没覆盖「文件能用」。**

**病灶二：`prepublishOnly` 的闸门被换小了。**

```diff
-"prepublishOnly": "pnpm clean && pnpm build && pnpm test"
+"prepublishOnly": "node scripts/version-check.mjs"
```

原先那条钩子是**发布前的最后一道闸**（清理 → 构建 → 全量测试）。
换成一个只查版本号的脚本之后，`npm publish` 前**不再构建、不再跑测试**。
**这是比病灶一更严重的一条**：病灶一交了个废文件，病灶二**拆掉了一道闸门**。

**连带发现（第三个病灶）**：版本号从 `0.6.0` 提到 `0.7.1` 时，
中英文 README 都**没跟着改**（还写 `v0.6.0`），
`tests/package-availability.test.ts` 因此红。
`release-status.json` 的 `published: true` + `npmVersion: 0.6.0`
说的也是另一个版本的事 —— `0.7.1` 根本没发到 npm。

### 改了什么

| 项 | 原规格 | 修订后 |
|---|---|---|
| 校验对象 | `package-lock.json` | `pnpm-lock.yaml` |
| 校验内容 | 根包版本号相等 | **依赖声明逐条一致**（存在性 + specifier 逐字比对 + 反向漂移） |
| 假锁文件 | 造一个 | **删掉**，并加**反向断言**锁死「不再造」 |
| `prepublishOnly` | 只跑版本校验 | **恢复**「清理 + 构建 + 全测」，版本校验挂末尾 |
| 验收标准条数 | 6 条 | **9 条**（新增反向断言、闸门完整性、README 一致性） |
| README/CHANGELOG/`release-status.json` | 未提及 | 纳入范围并对齐 `0.7.1` |

### 被否决的选项

- **B 方案（用真 npm 锁文件）**：等于在 pnpm 仓库里长期维护两套锁文件。
  两套锁文件会漂 —— 而「版本一致性校验脚本」的存在意义就是防漂。
  用一个需要防漂的机制去引入新的漂移源，方向是反的。
  （而且 npm 锁文件不含 pnpm 的 peer dependency 解析结果，
  `pnpm install --frozen-lockfile` 与 `npm ci` 会装出**不同的依赖树**。）
- **C 方案（删掉假锁文件与大部分验收标准，只留版本号）**：逻辑对
  （`--frozen-lockfile` 本来就保证一致性），但它把发布前的一致性校验
  整个去掉了 —— 而**发布流程与 CI 流程不是同一条路**
  （CI 用 `--frozen-lockfile`，发布走 `npm publish`）。
  留一个**发布前**的校验脚本是对的。
  **本修订取 A 的方向（校验 pnpm 锁文件）+ C 的保留（脚本留着）**，
  同时**恢复**被降级的闸门。

### 追溯

- ADR：`docs/adr-107-version-check-pnpm-lockfile.md`
- 缺陷记录：§ZD-037（`docs/实战缺陷记录-nimrtc-v14.md`）
- 同族缺陷：§ZD-036（`.cjs` 验收没收窄分支）——
  两者指向同一个根源：**验收标准只断言了「看起来对的东西」，
  没断言「东西真的能用」**。

### 原规格（2026-11-24 已签字版，保留供追溯）

<details>
<summary>点击展开原规格全文</summary>

### 目的
将 `package.json` 与 `package-lock.json` 的版本号对齐更新为 `0.7.1`，并新增 `scripts/version-check.mjs` 用于校验二者版本一致性；在不一致时以非零退出码阻断发布流程，确保发布制品携带的版本号可信。

### 范围

要改的（这些是 agent 会去改的文件）：
- `package.json` —— 更新 `version` 为 `0.7.1`，增加 `prepublishOnly` 校验钩子
- `package-lock.json` —— 同步根包版本为 `0.7.1`，使其与 `package.json` 一致
- `scripts/version-check.mjs` —— 新增版本一致性校验脚本

只读参考（**不得修改**，agent 只许读）：
- 只读 `scripts/build-lock.mjs` —— 模块依赖它生成/读取锁文件版本，新脚本需与其读写口径保持一致
- 只读 `npm-shrinkwrap.json` —— 仅检测存在性并提示，不修改（不存在则忽略）

### 需求
无。

### 验收标准
1. `package.json` 的 `version` 字段更新为 `0.7.1`；验证方式：在项目根目录执行 `node -p "require('./package.json').version"`，输出为 `0.7.1`。
2. `package-lock.json` 的根包版本与 `package.json` 一致，均为 `0.7.1`；验证方式：在项目根目录执行 `node -e "const p=require('./package-lock.json'); const v=p.lockfileVersion>=2 ? p.packages[''].version : p.version; if(v!=='0.7.1') process.exit(1)"`，命令退出码为 `0`。
3. 新增 `scripts/version-check.mjs`，且版本一致时校验通过；验证方式：执行 `node scripts/version-check.mjs`，退出码为 `0`，无错误输出。
4. 版本不一致时校验脚本以非零退出码结束，并输出包含 `package.json`、`package-lock.json` 及实际/预期版本的可读错误；验证方式：临时将 `package.json` 的 `version` 改为 `0.7.2`，运行 `node scripts/version-check.mjs`，断言退出码非 `0` 且输出包含上述信息；恢复改动后再运行，退出码为 `0`。
5. `package.json` 中新增 `"prepublishOnly": "node scripts/version-check.mjs"` 钩子；验证方式：执行 `npm pkg get scripts.prepublishOnly`，输出为 `"node scripts/version-check.mjs"`。
6. 校验脚本只读不修改文件；验证方式：连续运行 `node scripts/version-check.mjs` 两次，使用校验工具（如 `sha256sum`）比对运行前后 `package.json` 和 `package-lock.json` 的哈希值，两次哈希一致。

### 风险
1. `package-lock.json` 的 `lockfileVersion` 不同可能导致根包版本字段位置不同（v1 在顶层 `version`，v2/v3 在 `packages[""].version`）；应对：脚本读取 `lockfileVersion` 后按对应路径取值，并兼容两处字段同时存在的情况。
2. 直接手改 `package-lock.json` 可能仅更新了部分版本字段，造成内部不一致；应对：验收标准第 2 条已覆盖根包版本校验，且脚本同时校验顶层与 `packages[""]` 两处；若发现不一致，可回退使用 `npm install --package-lock-only` 重新生成锁文件。
3. 发布流程若实际使用 `npm-shrinkwrap.json`，只校验 `package-lock.json` 会覆盖不到真实发布锁文件；本片写集未包含该文件，因此不实现；应对：在脚本中检测到 `npm-shrinkwrap.json` 存在时给出提示，并留待后续切片补齐支持。

</details>
