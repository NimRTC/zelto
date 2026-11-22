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

#### 2.4.1 主仓那份残留到底是什么（2026-11-22 实测更正）

写这份 ADR 时曾断言主仓的 `ecc-key.pem` 是「跑过一次 `build_dtls_cert.py`
留下的残留」。**这个断言是错的**，实测结论如下：

| 文件 | 主仓里的实际内容 | 来源 |
|---|---|---|
| `src/third_party/wolfssl/src/certs/server-ecc.pem` | `CN=www.wolfssl.com`，**无 SAN** | **wolfSSL 上游自带**（子模块里被 git 跟踪） |
| `src/third_party/wolfssl/src/certs/ecc-key.pem` | `ASN1 OID: prime256v1` + `BEGIN EC PRIVATE KEY` | **wolfSSL 自己的 keygen 工具**的输出 |

判据是**格式**：脚本写的是 PKCS8（`-----BEGIN PRIVATE KEY-----`），
而主仓那份是 wolfSSL keygen 的传统格式（`-----BEGIN EC PRIVATE KEY-----`）。
所以主仓那份**不是**那个 Python 脚本产的。

**这意味着主仓从来没有成功跑过那个脚本** —— 主仓能构建，靠的是
wolfSSL 上游自带的 cert（它有 SAN 缺失的老问题，但**构建期不需要它**：
证书只在 Chrome 互操作的**运行期**才被用到）。

**这不影响本 ADR 的结论**，但改变了一条「怎么修」的说法：
不是「把主仓那份拷过去就行」（那份连 SAN 都没有，拷过去也过不了
Chrome 的 DTLS 握手），而是**必须重新生成**。这恰好是 §3.2 选
「生成」而非「拷贝」的理由之一 —— 拷贝的是**上游的旧证书**，
生成的是**带 SAN 的新证书**。

#### 2.4.2 顺带查清的一件事：为什么脚本跑不起来

第一版实测时 `build_dtls_cert.py` 直接崩：

```
ImportError: DLL load failed while importing _rust: 找不到指定的程序。
```

第一直觉是「用错 python 环境」。**实测排除了这个可能**：

- `where python` 只有 `D:\ProgramData\Miniconda3\python.exe`（3.9.1），
  另有两个 pyenv / uv 的解释器，但**都没装** `cryptography`；
- `conda` 的包缓存里装的是 **`cryptography-3.3.1-py39hcd4344a_0`**
  （纯 C 实现，依赖 OpenSSL 1.1）—— 它**本来是好的**；
- 但 site-packages 里却是 **`cryptography 42.0.8`** —— 某次 `pip install`
  把它升到了 Rust 实现。

**42.0.8 的 PyPI wheel 不带 `cryptography_rust.dll`**（实测 42.0.7 / 42.0.8 /
43.0.3 / 41.0.7 四个 wheel 全都只有 `_rust.pyd`，没有配套 dll），
而 `_rust.pyd` 静态依赖它 —— 于是 `import cryptography` 直接失败。
**只有 conda-forge 的构建才会把那个 dll 打包进去。**

修法：卸掉 pip 装的 42.0.8，把 conda 缓存里的 3.3.1 拷回去。
之后 `python scripts/build_dtls_cert.py` 正常，产出
`CN=localhost` + SAN（`DNS:localhost` / `IP:127.0.0.1` / 本机各网卡 IP）的
自签 ECC 证书。

**这条不写进 ADR 的「决策」部分**（那是 nimrtc 的环境问题，不是 zelto 的），
但值得记一笔：**它印证了 §3.2「重新生成」这条路依赖项目自己的脚本能跑** ——
如果项目的生成脚本本身跑不起来，`worktree.prepare` 会**明确报错**并
不放行到 agent，而不是让 agent 在缺产物的目录里跑一小时再在门禁②炸掉。

#### 2.4.3 真正的根因：本地 wolfSSL 是一份「删过文件」的碳拷贝（2026-11-22 深夜更正）

§2.4.1 解释了「主仓那份 `ecc-key.pem` 不是脚本产的」，但没解释
**为什么主仓构建会失败**。答案在当天深夜的核查里才浮出来，
而且推翻了一个更省事的假设。

**假设 A（曾被默认）：** 「上游 wolfSSL 本来就不跟踪 `ecc-key.pem`，
所以谁 clone 都缺」—— **错**。

实测（`gh api repos/wolfSSL/wolfssl/contents/certs/ecc-key.pem?ref=v5.9.2-stable`）：
**上游 wolfSSL 的 `v5.9.2-stable` 分支是跟踪 `certs/ecc-key.pem` 的。**
钉死的 commit 是 `ac01707552c611fbd135cc723b2682b3e7f80f2`
（`src/third_party/vendor.json` 里记的就是它）。

**假设 B（曾被默认）：** 「CI 也是绿的，所以 CI 也有这个文件」—— **对，
但不是因为 CI 特殊**。

CI 日志（run `44688171635`）里明明白白：

```
Submodule 'src/third_party/wolfssl/src' (https://github.com/wolfSSL/wolfssl.git) registered ...
Submodule path 'src/third_party/wolfssl/src': checked out 'ac01707552c611fbd135cc723b2682b3e7f80f2'
```

CI 拿到的**就是上游那份**，带着 `certs/ecc-key.pem`，
所以 `nimrtc_copy_wolfssl_certs()` 的 POST_BUILD 拷贝成功，2310 个测试全绿。

**而本地主仓的子模块不在这个 commit 上：**

| | commit | `certs/` 条目数 | 有 `ecc-key.pem` 吗 |
|---|---|---|---|
| 上游 / CI | `ac01707` | 161 | **有** |
| 本地主仓 | `da2d676`（提交信息就叫 "carbon copy"） | 159 | **没有** |

差集正好两个文件：`certs/ecc-key.pem` 和 `certs/ecc-key.der`。

**所以 ZD-026 的真实根因是：** 主仓的 wolfSSL 子模块是一份**本地碳拷贝**，
它相对上游**少了两个证书文件**；而 `nimrtc_copy_wolfssl_certs()`
无条件拷贝 `ecc-key.pem`，于是构建期必然失败。CI 之所以绿，
是因为 CI 用的是上游那份，不受这份碳拷贝影响。

**这条对 zelto 意味着什么（§3.2 的选型因此更站得住）：**

- 修复点**不在**「把缺失的证书补回去」—— 补回去只能补一份**上游的
  `CN=www.wolfssl.com`、无 SAN** 的旧证书，而运行期要的是
  **带 SAN 的新证书**（§2.4.1）；
- 修复点**在**「让构建期产物由项目自己的脚本生成，且不落在别人的仓库里」。

**对 §3.2「生成 vs 拷贝」的影响：**

原方案是「从主仓拷贝 `ecc-key.pem` 到 worktree」。这个方案**在本地根本无从执行** ——
主仓自己就缺这个文件，而且就算不缺，拷来的也是无 SAN 的上游证书。
所以「生成」不只是更干净，是**唯一可行**的选项。

**顺带一条工程结论（2026-11-22 已落地到 nimrtc 侧）：**
「构建期产物写进 vendored 子模块的跟踪文件」这个做法本身要被淘汰 ——
`server-ecc.pem` 在子模块里是**被跟踪**的，脚本覆盖它会让子模块长期显示
`-dirty`。nimrtc 侧已改为：脚本只写 `tests/wolfssl_dtls/certs/`
（该目录被 `.gitignore:227` 忽略），CMake 从那里取，
CI 侧显式加一步生成证书。

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
    # 而且在 ZD-026 这个具体案例里，「拷贝」根本**不可行**：
    # 主仓自己就缺 `ecc-key.pem`（本地 wolfSSL 是一份少了两个文件的
    # 碳拷贝，见 §2.4.3），而且主仓那份上游证书**没有 SAN**，
    # 拷过去也过不了 Chrome 的 DTLS 握手。「生成」是唯一可行选项。
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

### 4.4 C3 合规性

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

---

## 7. 验证记录（2026-11-22）

### 7.1 端到端：真实 worktree + 真实生成脚本

在 nimrtc-v14 主仓里用 `WorktreeManager.create()` 造了一个**真实**的
新 worktree，带上 `prepareCommands: [{ run: 'python scripts/build_dtls_cert.py' }]`：

| 检查项 | 结果 |
|---|---|
| 新 worktree 里 prepare 前有 `ecc-key.pem` 吗 | **没有**（git 只带被跟踪的内容） |
| prepare 后有吗 | **有** |
| 内容是 PKCS8（= 重新生成的，不是 wolfSSL keygen 的旧格式） | **是**（`BEGIN PRIVATE KEY`，241 字节） |
| `server-ecc.pem` 是带 SAN 的自签证书 | **是**：`CN=localhost` + `DNS:localhost` / `IP:127.0.0.1` / 本机各网卡 IP |

（主仓那份 2938 字节、worktree 里 806 字节 —— 差异只是 `cryptography`
3.3.1 与 42.x 的 PEM 编码行宽不同，**证书内容等价**，`certutil -dump`
两边解析出的 SAN 一致。）

### 7.2 回归测试

- `tests/adr095-worktree-build-prerequisites.test.ts` —— 单元层面
  （子模块校验、prepare 的 cwd / fail fast / 超时 / 配置解析）
- `tests/adr095-submodule-missing-commit.test.ts` —— 真实 submodule 集成
- 全量 `npm test`：**2938 pass / 0 fail**

### 7.3 根因收敛：碳拷贝差异（2026-11-22 深夜）

§2.4.1 只解释了「主仓那份证书不是脚本产的」。真正让构建失败的
是**主仓的 wolfSSL 子模块不是上游那份**：

| | commit | `certs/` 条目 | `ecc-key.pem` |
|---|---|---|---|
| 上游 `v5.9.2-stable` / CI | `ac01707` | 161 | 有 |
| 本地主仓 | `da2d676`（"carbon copy"） | 159 | **无** |

差集：`certs/ecc-key.pem`、`certs/ecc-key.der`。

CI 日志证据（run `44688171635`）：

```
Submodule path 'src/third_party/wolfssl/src': checked out 'ac01707552c611fbd135cc723b2682b3e7f80f2'
```

CI 用上游那份 → POST_BUILD 拷贝成功 → 2310 测试全绿；
本地用碳拷贝 → 拷 `ecc-key.pem` 必然失败。

### 7.4 nimrtc 侧的落地（2026-11-22）

ZD-026 的修复落在 nimrtc 仓库，本 ADR 只记录它对本方案的影响：

1. **脚本不再写 vendored 子模块。** `build_dtls_cert.py` 只写
   `tests/wolfssl_dtls/certs/`（该目录被 `.gitignore:227` 忽略）。
   此前它会覆盖子模块里**被跟踪**的 `certs/server-ecc.pem`，
   让主仓长期显示 `m src/third_party/wolfssl/src`（`-dirty`）。
2. **CMake 从新位置取证书**（4 处）：
   `cmake/NimRTCTest.cmake`、`cmake/NimRTCRuntime.cmake`、
   `src/modules/dtls/CMakeLists.txt`（编译期兜底路径）、
   以及 `dtls_wolfssl_session.cpp` 的运行期查找候选表
   （同时**移除**了 wolfSSL 子模块路径作为候选 —— 留着它，
   上游那份无 SAN 的旧证书会在某些 CWD 下**赢过**新证书，
   Chrome 随即以 alert 46 拒绝握手）。
3. **CI 显式生成证书。** 6 个 workflow、14 个 job 加了
   `Generate the DTLS test certificate pair` 步骤
   （`ci.yml` / `ci-fast.yml` / `interop.yml` / `release.yml` /
   `soak.yml` / `hardware.yml`）。
   此前 CI 靠上游跟踪的 `ecc-key.pem` 免这一步。
4. **子模块保持干净。** 实测：新 worktree 走完
   `WorktreeManager.create()` + prepare 后，
   主仓与 worktree 的 `git submodule status` **都不带 `-dirty`**。

### 7.5 CI 侧踩到的第二个坑：`cryptography` 的版本

CI 步骤里写的是 `pip install "cryptography<42"`，**不是** `>=42`。
原因与 §2.4.2 是同一个坑，但发生在 CI 上：

- `cryptography>=42` 的 PyPI Windows wheel 是 Rust 实现，
  只带 `_rust.pyd`、**不带** `cryptography_rust.dll`，
  `import cryptography` 直接 `ImportError: DLL load failed while importing _rust`；
- 41.x 是最后一条纯 C 线，实测在干净 venv 里 `import` 正常，
  且 `scripts/build_dtls_cert.py` 跑通、产出 `CN=localhost` + 8 条 SAN。

### 7.6 一处遗留（未在本轮修）

本地主仓的 wolfSSL 碳拷贝与上游的 2 文件差异**本身**没修 ——
它属于 nimrtc 的 vendoring 问题，不在本 ADR 范围。
修掉之后，本地与 CI 的子模块内容一致，
构建期就不再依赖「本地缺不缺那两个文件」这件偶然的事。


