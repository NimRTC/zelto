# ADR-095: worktree 的「构建前置产物」—— 子模块钉死校验 + 生成物清单

**状态**: 已实现（2026-11-22）
**日期**: 2026-11-22
**作者**: 系统架构
**关联约束**: C1, C2, C3, C4, C9
**关联文档**: `docs/adr-011-worktree-isolation.md`,
`docs/adr-044-submodule-init.md`,
`docs/adr-047-submodule-align-to-main-repo.md`,
`docs/实战缺陷记录-nimrtc-v14.md` §ZD-026

---

## 1. 摘要

zelto 自己造的 worktree **不保证可构建**。

两条独立的成因，都被门禁②的 build 阶段撞出来，而**报错信息都指向别处**：

| # | 成因 | 门禁②看到的 | 真正的原因 |
|---|---|---|---|
| ① | 子模块钉死的 commit 在本地**不存在** | `MSB3073` 复制文件失败 / 「找不到 googletest」 | worktree 建立时 checkout **静默失败**，目录是空的 |
| ② | **生成的产物**（在 `.gitignore` 里）不跟过去 | `Error copying file ... ecc-key.pem` | git 只带**被跟踪**的内容；生成物从未进过版本库 |

本 ADR 让 zelto 在**建 worktree 的时候**就把这两件事说清楚：

- ① 从「静默失败 + 一行带乱码的警告」变成**明确的错误**（含可执行的修法）；
- ② 引入**生成物清单**（项目级配置）：建 worktree 时跑一次前置脚本，
  让产物**重新生成**，而不是从主仓拷贝旧的。

---

## 2. 动机

### 2.1 现场（ZD-026）

nimrtc-v14 的 `v3-n4-d6-connectivity` 切片，agent 跑完 101 分钟，
自动门禁②红了：

```
❌ build (10700ms, exit 1)
   'vswhere.exe' 不是内部或外部命令
❌ test (231929ms, exit 8)
   Errors while running CTest
Gate: ❌ Failed (518069ms)
```

`vswhere.exe` 那行是**噪声**（v2-ice 那轮也有同样的 stderr，但 `exit 0` 通过了）。
真正的错误埋在后面几百行：

```
error MSB3073: "cmake.exe" -E copy_if_different
  .../src/third_party/wolfssl/src/certs/ecc-key.pem
  .../build/tests/Debug/certs/
Error copying file (if different) from ".../certs/ecc-key.pem"
```

### 2.2 为什么这是 zelto 的问题，不是项目的问题

三条理由：

1. **worktree 是 zelto 造的**（`core/worktree/`），不是人手工建的。
   zelto 造出来的东西必须**可用** —— 否则门禁②必然红，
   而红的理由跟切片内容毫无关系。
2. **报错信息指向了错的地方**。人看到「build 失败」，
   第一反应是「agent 把代码写坏了」—— 但 agent 一个字节都没碰证书。
3. **不可复现地浪费**。门禁②红了之后，agent 已经烧掉的 101 分钟无法复用；
   而人**无法从门禁输出里推出真正的原因**（`MSB3073` 那一坨
   `if %errorlevel% neq 0 goto :cmEnd` 没有任何可读信息）。

### 2.3 ① 的具体形态

`version/v3` 的树钉住了较老的子模块 commit，而本地 module 仓库里只有较新的
「carbon copy」commit：

```
主仓 index 记录：googletest 15460959 / libopus 22244de5
本地 module 仓库：有 05d7a9b（较新），没有上面那两个
```

zelto 的 `alignSubmodulesToMainRepo` 按 C3（确定性、不触网）用
`git checkout --force <pin> --no-fetch` —— pinned commit 在本地**不存在**时
**静默失败**：

```ts
try {
  this.git(['checkout', '--force', target], undefined, false, wtSub);
  aligned.push(sub.path);
} catch {
  // 对不齐就留着 —— git status 会显示差异，审计会报出来（不静默）
}
```

那句注释里的「不静默」指的是**审计**会发现 —— 但审计发现的是
「vendor 目录和主仓不一致」，**不是**「这个 commit 本地根本没有」。
从「commit 不存在」到「门禁报文件缺失」，中间隔着几百行无关的编译输出。

### 2.4 ② 的具体形态

`ecc-key.pem` 是**生成的**，不是签入的：

```
$ cd src/third_party/wolfssl/src
$ git check-ignore -v certs/ecc-key.pem
.gitignore:109:ecc-key.pem   certs/ecc-key.pem
```

它由 `scripts/build_dtls_cert.py` 生成（那个脚本把自签 ECC 证书镜像到
wolfssl 自己的 cert 树里，好让 CMake 的 `copy_if_different` 规则能捡到）。
而 CMake 的 `nimrtc_copy_wolfssl_certs()` **无条件** copy 这两个文件 ——
源文件不在，POST_BUILD 就炸，连带整个测试目标构建失败。

**为什么主仓没事、worktree 有事**：主仓的 cert 目录里**有**那个文件 ——
历史上跑过一次生成脚本留下的**未被跟踪的残留**。新建 worktree 时
git 只带**被跟踪**的内容，这个残留不带过去。

于是主仓能构建、任何新 worktree 不能 —— **差异不在代码，在工作区的历史**。

---

## 3. 决策

### 3.1 决策一：子模块钉死 commit **不存在** → 明确报错，不静默

`alignSubmodulesToMainRepo` 里的 checkout 失败要**区分两种情况**：

| 情况 | 判据 | 处置 |
|---|---|---|
| commit 本地**不存在** | `git cat-file -e <sha>` 失败 | **抛错**，带可执行的修法 |
| checkout 因别的原因失败 | `cat-file` 成功但 checkout 失败 | 维持现状（记入 `submoduleFailures`，让审计去报） |

**为什么不一律抛错**：checkout 失败的原因不止一种。有些是「本地缺 commit」
（必须拦），有些是「文件被占用」之类的一次性问题（拦了会误伤）。
判据是**确定性的**（`cat-file -e` 只读本地对象库，不触网，C3 合规）。

**报错信息要给可执行的修法**，不能只说「失败了」。三条修法各有适用场景：

```
本地 module git 目录里没有 index 记录的 commit 15460959
（submodule: src/third_party/googletest/src）

三种修法，按适用场景选：
  1) 该 commit 在远程仓库里（推荐）：
     git -C <主仓>/src/third_party/googletest/src fetch origin 15460959
  2) 该 commit 只在别的本地副本里：
     git -C <主仓>/src/third_party/googletest/src fetch <那个副本> 15460959
  3) 主仓 index 记录的 commit 本来就是错的（少见）：
     在主仓里 git submodule update --init 修正后重新建 worktree
```

**为什么是「抛错」而不是「警告」**：门禁②的 build 阶段会**必然**失败。
让它在**建 worktree 的时候**失败（早几分钟、错误信息直达），
比在**门禁的时候**失败（错误信息被几千行编译输出淹没）好得多。

C9 说「预约缺失时 fail closed（一律拒绝）」—— 同一个原则：
**依赖缺失时的正确动作是停下，不是带着缺口继续跑**。

### 3.2 决策二：生成物清单 —— 建 worktree 时**重新生成**，不拷贝旧的

新增项目级配置节 `worktree.prepare`：

```yaml
worktree:
  prepare:
    # 建 worktree 之后、agent 开跑之前，跑这些命令。
    # 用途：生成「不进版本库」的构建产物（证书、protobuf、代码生成…）。
    #
    # 为什么是「生成」而不是「拷贝」：拷贝旧的产物可能带来**过期**的
    # 内容（过期的证书、过期的 protobuf），而重新生成保证产物与当前
    # 代码一致。
    #
    # 约束：
    #   - 在 worktree 目录里执行（cwd = worktree 根）
    #   - 顺序执行，前一条失败则不跑后一条（fail fast）
    #   - 失败 → worktree 建立失败（不放行到 agent）
    #   - 有超时（默认 120s，可配）
    commands:
      - run: python scripts/build_dtls_cert.py
        timeoutSec: 60
      - run: npm run codegen
        timeoutSec: 120
```

**为什么放 `worktree.prepare` 而不是复用 `gate.commands`**：

- `gate.commands` 是**判定**用的（跑测试、验契约），它的失败是「门禁红」；
- 这里是**准备**用的（生成产物），它的失败是「worktree 不可用」。
- 两者时机不同：准备在 agent **开跑之前**，判定在 agent **跑完之后**。
- 混在一起的话，「准备失败」会被报成「门禁红」—— 人会去查 agent 的代码，
  而问题在准备阶段（就是 ZD-026 的老毛病：报错指向错的地方）。

**为什么不放 `policy.yaml`**：policy 是**策略**（谁能写什么、什么必须拦），
`worktree.prepare` 是**环境准备**。policy 的规则会被 gate/sched 消费，
混进「要跑什么脚本」会让策略层变成脚本执行器。config.yaml 才是对的位置。

**失败怎么办**：**不放行**。worktree 建立失败 → 切片不进 `running`，
人看到「准备失败：第 2 条命令退出码 1」。这与 C9 的 fail closed 一致。

**默认超时**：120 秒。理由同 `web.launchTimeoutMs`（ADR-086）——
准备阶段在含 submodule 的工程上实测要 127 秒（nimrtc v1.4，2026-11-20），
但那是**同步 submodule** 的时间；生成物脚本通常是秒级，
120 秒给足余量而不至于挂死。

### 3.3 决策三：生成物清单**可为空**，不配就不跑

没配 `worktree.prepare` = 不做任何准备 = 现在的行为。

**为什么不做「自动探测」**：探测「这个项目有哪些生成物」需要理解每个项目的
构建系统 —— 那是**项目知识**，不是工具知识。让人显式声明，比让工具猜准。

### 3.4 决策四：清单里的命令**只在 worktree 建立时**跑一次

不每次 `create()` 都跑。复用已有 worktree 时（`create()` 的 `existsSync` 分支）
**也跑** —— 因为 agent 可能在上轮跑挂了、worktree 里的产物可能被删了。

判据：**每次 agent 开跑前**都要保证产物在位。产物不在位 → 构建会失败，
而失败点在门禁②，代价是 agent 的整轮时间。所以准备阶段必须**充分**。

### 3.5 被否决的方案

**A. 从主仓拷贝未跟踪的生成物**

把主仓工作区里所有**被 .gitignore 忽略**的文件都拷进 worktree。

否决理由：
- **太宽** —— 会把 `build/`、`node_modules/`、`.cache/` 一起搬过去，
  几百 MB，而且可能带进**脏**状态（别人改了一半的 build 产物）。
- **产物可能过期** —— 主仓的证书是三个月前生成的，与当前代码不匹配。
- **判据不可靠** —— 「被 .gitignore 忽略」不等于「是构建产物」。
  `secrets.json` 也常被 ignore，拷过去是**安全问题**。

**B. 拷「指定清单」的文件**（而不是跑命令生成）

即：清单里写「把主仓的 `certs/ecc-key.pem` 拷过来」。

否决理由：**产物会过期**。证书、protobuf、代码生成产物都跟当前代码耦合，
拷贝等于把「主仓上次生成的版本」当成「当前代码的产物」。
清单里写命令，产物由项目自己的脚本生成 —— **项目自己最清楚怎么生成**。

**C. 让 zelto 理解各项目的构建系统**（自动跑 `npm install` / `cmake` 等）

否决理由：zelto 是**驾驶舱**，不是构建系统。理解构建的是构建工具自己。
zelto 要做的只是「在正确的时机调用正确的命令」。

**D. 只在门禁②的 build 阶段补救**（构建前先生成）

否决理由：门禁②是**判定**阶段，它的失败信息会混在几千行编译输出里
（就是 ZD-026 的现场）。准备阶段失败要**早**、要**干净**。

---

## 4. 实现要点

### 4.1 `core/worktree/manager.ts`

新增：

```ts
/** 本次 worktree 准备阶段的结果（ADR-095 §3.2）。 */
export interface PrepareResult {
  /** 跑成功的命令（按顺序）。 */
  ran: string[];
  /** 失败的那条命令及其原因（没有失败则为空）。 */
  failed?: { run: string; reason: string };
}
```

`WorktreeManager` 新增方法：

- `pinnedCommitOf(subPath)` —— 读**主仓** index 里的 gitlink，拿到钉死的 sha。
- `commitAvailable(subPath, sha)` —— 用 `git cat-file -e` 校验 commit 在**本地**
  对象库里；不存在则抛 `WorktreeError`（带修法）。
- `prepareArtifacts(worktreePath, commands)` —— 逐条跑，fail fast，
  失败抛 `WorktreeError`。

### 4.2 三个「实现时才暴露」的坑

这三个坑都不是设计问题，是**只有真跑起来才会遇到**的问题。
记在这里是因为下一个动这块代码的人会撞上同样的坑。

**坑一：检查必须放在 `submodule update` 之前**

失败发生在 `submodule update --init --no-fetch` 阶段（被记成一条**警告**），
而 `alignSubmodulesToMainRepo` 在 update **之后** —— update 失败，
align 根本没机会跑。所以「commit 存在性」的判据必须前置到 update 之前。

**坑二：钉死的 commit 要读**主仓**的 index，不是 worktree 的**

`git submodule add` 把 gitlink **暂存**进 index，但**不提交**。
而 worktree 是从 **HEAD** 建出来的 —— worktree 的 index 里**没有**那个 gitlink。
读 worktree 的 index 的话永远读到空 → 判据形同虚设（而且测试会「绿」，
因为它压根没触发）。

**坑三：查 commit 时必须设 `GIT_WORK_TREE`**

独立嵌套克隆（submodule 的 `.git` 是**目录**）的 config 里有 `core.worktree`，
通常是**相对路径**（`../../../../vendor/lib`）。git 在任何命令前都会 chdir 到它，
从别的 cwd 进去就找不到：

```
fatal: cannot chdir to '../../../../vendor/lib': No such file or directory
```

明明有那个 commit，却判成「没有」→ **误拦一个好的工程**。

设 `GIT_WORK_TREE` 能顶掉它（环境变量优先于 config）。
`-c core.worktree=…` **不管用** —— chdir 发生在读 config 之后。

### 4.3 `core/config/loader.ts`

`ZeltoConfig` 新增 `worktree?: { prepare?: { commands: Array<{ run: string; timeoutSec?: number }> } }`。

**解析是纯文本**（C3）：读 YAML 文本、抽 `worktree.prepare.commands`，
不执行任何东西。**执行只发生在 `core/worktree/`，且只在建 worktree 时**。

**解析的三个细节**：

1. YAML 的列表项前缀 `- ` 也在 `trimmed` 里 —— 判「是不是 `run:`」之前
   要先剥掉它。不剥的话 `worktree.prepare` 的命令**一条都读不出来**。
2. `worktree:` 是**平级**的顶层节，要**关掉**其它段的标志位 ——
   否则它下面的 `run:` 会被 gate 的命令解析器读走（变成门禁命令）。
3. `run:` 为空的条目**跳过** —— 宁可少一条，也不要拿空命令去跑
   （必然失败，且失败原因会误导人）。

### 4.3 C3 合规性

| 动作 | 触网？ | 调模型？ | 说明 |
|---|---|---|---|
| `git cat-file -e <sha>` | 否 | 否 | 只读本地对象库 |
| `git checkout --force` | 否 | 否 | 已有 `--no-fetch` 语义 |
| 跑 `worktree.prepare` 的命令 | **可能** | **可能** | 见下 |

**关于 `worktree.prepare` 可能触网**：项目的生成脚本**可能**要装依赖
（`npm install`）。这与 C3 不冲突 —— C3 约束的是
`core/policy/`、`core/gate/`、`core/sched/` 这三个**判定**目录
「不得调用模型、不得触网」。`core/worktree/` 不在那个清单里，
它做的是**环境准备**（跟 `git submodule update` 联网的性质一样，
而那件事已经被 ADR-044 明确认可并用「本地优先」约束）。

但仍然要**限制**：默认超时（防止挂死）、fail fast（失败即停）、
不重试（避免重复副作用）。

---

## 5. 影响

### 5.1 行为变化

| 场景 | 之前 | 之后 |
|---|---|---|
| 子模块 pinned commit 本地不存在 | worktree 建好，vendor 空，门禁②炸（信息误导） | **worktree 建立失败**，信息直达 + 三种修法 |
| 项目配了 `worktree.prepare` | 不跑 | 建 worktree 时跑，失败则不放行 |
| 项目没配 | 不跑 | 不跑（**无变化**） |

### 5.2 对既有契约的影响

D-73 立的契约（「本地缺 commit 时快速失败，且失败被记下来」）**依然成立**，
只是形态变了：现在**记进 `submoduleFailures`**（结构化留痕）**并抛错**。

两条契约不冲突 —— 记下来是给「事后可查」用的，抛错是给「当场停下」用的。
只抛错的话，调用方拿不到「是哪个 vendor」的结构化信息。

### 5.3 不破坏现有项目

`worktree.prepare` 是**可选**的，没配就是零行为变化。
①的改动只在「本地确实缺 pinned commit」时才触发 ——
而那本来就是坏的（worktree 建出来是空的）。

### 5.4 兼容性

`config.yaml` 的 `worktree` 是**新节**，旧配置不受影响。
不涉及 schema / 事件类型变更，所以**不需要**改 `contracts/schemas/`。

---

## 6. 剩余问题

1. **生成物清单没有「校验产物在位」的能力**。命令跑完，但产物可能在
   （脚本静默失败、输出到别处）。要严格，得再声明「产物清单」
   并在准备后校验存在 —— 但那又要一份清单，配置会变啰嗦。
   暂不做：脚本自身的退出码是更可靠的信号。
2. **准备阶段的耗时没有进任何统计**。`worktree.prepare` 跑 30 秒，
   在 `zelto status` 里看不出来。将来可以并进 `web.launchTimeoutMs` 那套。
3. **子模块 commit 缺失的「自动修复」没做**。现在只报错并给三种修法，
   不自动 `git fetch` —— 因为自动 fetch **触网**（C3 的地盘），
   且「fetch 哪个 URL」需要项目知识。
   折中方案：把 fetch 做成**显式的人工动作**（ADR 里已给出命令）。
4. **`worktree.prepare` 住在 `.zelto/config.yaml` 里 —— 而那个文件是
   **本机状态**（不入库）**。

   zelto 的 `init` 会往 `.gitignore` 写 `.zelto/`（理由：运行时产物
   可能含公司专属端点，逐主机重新生成）。所以 `worktree.prepare`
   **不会跟着仓库走** —— 换一台机器要重新配。

   这与 `gate.commands` 的处境**完全一样**（门禁命令也在同一个文件里），
   所以本 ADR 不引入新问题。但它确实限制了这个功能的可移植性。

   将来可能的做法：加一个**入库的**项目级配置（如 `zelto.yaml`），
   承载「与主机无关」的那部分配置（门禁命令、生成物清单），
   而 `.zelto/config.yaml` 承载「与主机相关」的那部分（端点、密钥）。
   那是**另一件事**，不在本 ADR 范围内。
