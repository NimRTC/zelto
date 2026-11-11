# ADR-044：隔离 worktree 必须初始化 git submodule

- 状态：已接受
- 日期：2026-11-11
- 决策者：zelto（维护者）
- 影响范围：`src/core/worktree/manager.ts`

## 背景

zelto 给每个切片建一个独立的 git worktree，agent 在里面干活。
`git worktree add` 只复制**主仓的受版本控制内容**，**不包含 submodule 的源码树**。

submodule 在主仓里是一个 gitlink（index mode 160000），只记录一个 commit 指针；
真正的源码树住在它自己的仓库里（`<主仓>/.git/modules/<name>/`），
并通过 `<子模块路径>/.git` 这个文件指回去。于是 worktree 里那个目录是**空的**。

## 现场

nimrtc-zelto 的 `v1-exception-handling` 切片（2026-11-11）：

1. agent 在 worktree 里写完了 `safety_check.hpp` / `safety_check.cpp` /
   `test_safety_check.cpp` 和 CMake 接线；
2. 然后卡在 configure：`CMake Error … The binary directory _googletest_module_subbuild
   is already used to build a source directory`；
3. 排查下去发现根因是 `src/third_party/googletest/` 与 `src/third_party/msquic/`
   在 worktree 里**完全是空的** —— submodule 没被带过去；
4. agent 的应对是**从主仓手工 cp 一份** googletest 和 msquic 进去，
   把两个 gitlink 变成了普通目录（`git status` 里从 `m` 变成 `?`）。

代价有两层：

- **时间**：整轮 30 分钟的 agent 预算几乎全花在重新配置和拉源码上，
  第一轮直接超时被 zelto 判为 `environment_failure` 并自动重试；
- **正确性**：手工 cp 出来的 vendor 目录不再是 submodule，
  合并回主干时会把 vendor 的版本管理搞乱 —— 这是 agent 越过了「不碰写集之外的东西」
  这条线，只是 hook 抓不到（cp 的目标是 submodule 路径，而 hook 只看写集里的路径）。

## 决策

**worktree 创建时（以及复用已有 worktree 时）把 submodule 一并初始化进去。**

具体做法（`WorktreeManager.syncSubmodules`）：

1. 从 `.gitmodules` 读出全部 submodule 的 **name** 与 **path**；
2. 按主仓里的实际形态分三种情况处理：

   | 主仓里的形态 | 处理 | 代价 |
   |---|---|---|
   | 有 `.git`（正常初始化的 submodule） | 用 git 初始化进 worktree，克隆源指向本地 module git 目录 | 1–4 秒 |
   | 没有 `.git`，但**有内容**（源码被当普通文件提交） | 直接把目录内容复制过去 | 几秒（22MB 量级） |
   | 既没有 `.git` 也没有内容 | 跳过（`skipped`） | 0 |

   第二种情况在 nimrtc-zelto 上就存在：`src/third_party/msquic` 的源码
   在主仓里，但没保留 gitlink 关系（`.git` 不存在）。不处理的话，agent
   会去网络上现拉 msquic（22MB，还要走 HTTPS 克隆一个 fork）——
   离线环境直接卡死，慢的环境上多花十几分钟。

3. 单个 submodule 失败只记入 `skipped`，不阻断整个 worktree 的创建。

### 为什么必须覆盖 url

直接 `git submodule update --init` 会**从 `.gitmodules` 里写的远端地址克隆**。
两个问题：

- **触网**：CI/离线环境里根本拉不到；
- **`protocol.file.allow` 限制**：git 2.38.1 起默认禁止 `file://` 本地克隆
  （CVE-2022-39253 的加固），本地 submodule 的克隆会直接报
  `fatal: transport 'file' not allowed`。

把 url 覆盖成本地的 module git 目录，两个问题一起消失：objects 是现成的，
克隆源是本地路径（显式放行）。

### 为什么 name 与 path 要分开处理

`.gitmodules` 里的 section 名（name）和落盘路径（path）**不一定相同**：

```ini
[submodule "gtest-lib"]
	path = vendor/lib
```

- 配置键 `submodule.<name>.url` 用的是 **name**；
- module git 目录 `.git/modules/<name>/` 用的也是 **name**；
- 而 `git submodule update --init <path>` 的参数是 **path**。

用 path 去拼配置键会「改错 submodule」：命令不报错，内容却没进来。
本 ADR 的实现对两种位置都做查找（name 优先，path 兜底），
以兼容按 path 存放模块仓库的历史布局。

## 后果

- **正面**：依赖 submodule 的工程（vendor 目录是 gitlink 的工程）
  在 worktree 里**开箱即可编译**。agent 不再需要「自己想办法把 vendor 弄进来」，
  也就不会再手工 cp 出破坏版本管理的目录。
- **正面**：初始化复用本地 objects，不触网，不受 `protocol.file.allow` 限制。
- **代价**：worktree 创建会多花一点时间（每个 submodule 一次本地克隆，
  nimrtc-zelto 上约 1–4 秒）。
- **代价**：主仓里没初始化过的 submodule 会被跳过（`skipped`），
  这是有意的 —— 不为了「让 worktree 完整」而去触网拉取。

### 不在本次范围内

- **不验证 submodule 的 commit 指针是否与主仓一致**。worktree 里的 submodule
  会被 checkout 到 worktree 那次 commit 记录的指针上（`git submodule update`
  的默认行为），而 module git 目录里的 objects 来自主仓。两者一致时没问题；
  主仓的 submodule 被手动切到别的 commit 时，worktree 里会跟着 worktree 的
  指针走 —— 这是正确的语义。
- **不做 submodule 的递归嵌套同步**。`--recursive` 参数已经传了，
  但嵌套 submodule 的 module git 目录同样要存在于主仓才会被复用。

## 验证

`tests/core/worktree/manager.test.ts` 新增 6 条用例（ADR-044 小节）：

1. 新建的 worktree 里 submodule 内容确实存在；
2. `syncSubmodules` 正确报告 `initialized` 与 `skipped`；
3. 主仓里没初始化的 submodule 被跳过（不触网拉取）；
4. 没有 `.gitmodules` 的仓库不做任何事；
5. **name ≠ path 的 submodule 也能正确初始化**（回归上面那条坑）；
6. **主仓里只有普通文件内容（没有 `.git`）的 submodule 被复制进 worktree**
   （离线场景：不让 agent 去网络上现拉）。

## 关联

- ADR-042：写集判定分层（新建文件型切片的写集不再阻断门禁①）
- ADR-043：hook 的引号感知重定向解析（避免 `awk 'NR>100'` 被误判为越界写入）
