# ADR-080：`npm test` 必须自己构建 `dist/` —— 绿灯不能依赖一个自己不产出的东西

**状态**：实施
**日期**：2026-11-18
**相关**：ADR-034（骨架生成器）、D-1（构建前必须清 `dist/`）、AGENTS.md「测试前必须先构建」

## 背景

`package.json` 里：

```json
"build": "node scripts/clean-dist.mjs && tsc",
"test":  "node scripts/check-encoding.mjs && tsc -p tsconfig.test.json && node --test \"dist-test/tests/**/*.test.js\""
```

`test` 脚本编译了 `dist-test/`，**但没有编译 `dist/`**。

而验收测试（`tests/acceptance/**`）跑的是**真实 CLI 进程**：

```ts
const CLI_SCRIPT = join(process.cwd(), 'dist', 'cli', 'index.js');
```

也就是说：**`npm test` 的验收部分，测的是一个它自己不构建的产物。**

## 病灶

### 一、并发构建与测试 → 验收全红

`npm run build` 的第一步是 `rmSync(dist)`（D-1：产物目录必须是当前源码的精确映射）。

于是**任何一次 `npm run build` 与 `npm test` 并发**，验收测试就会看到 `dist/` 被删掉的那一刻：

```
Error: Cannot find module 'D:\MyOpen\Zelto\dist\cli\index.js'
  code: 'MODULE_NOT_FOUND'
```

实测（2026-11-18）：全量 `npm test` 里 6 个用例红，全是这个错。
**而这些用例单独跑是绿的** —— 判据没错，是被环境打掉了。

### 二、CI 只是**侥幸**躲过

CI 里是两步：

```yaml
- run: pnpm build
- run: pnpm test
```

串行的，所以 `dist/` 在 `test` 之前就建好了。**CI 绿不代表这件事被解决** ——
它只是碰巧按对了顺序。本地 `npm test`（不先 build）就会撞上。

### 三、更隐蔽的一种：**用旧二进制跑新代码**

AGENTS.md 早就写着：

> 测试前必须先构建。……否则验收测试会拿旧二进制去跑，出现「改了代码却还是旧行为」的假象。

但那句话只是**文档里的叮嘱**。工具**不强制**它。

于是有一条路径是这么走的：

1. 改了 `src/cli/commands/version-ship.ts`；
2. 忘了 `npm run build`；
3. `npm test` → `dist/` 里还是**上一次的旧代码**；
4. 验收测试跑旧二进制 → **绿**；
5. 你以为改动是对的。

**验收测试测的不是你改的代码，而你还是绿的** —— 这是比红更坏的情况：
红会告诉你「有问题」，绿告诉你「没问题」。

> 追溯链（C4）在这里断了一节：
> 「验收绿」这个结论，不再能被追溯到「验收的是哪一份代码」。

## 决策

### `npm test` 自己构建 `dist/`

```json
"test": "node scripts/test.mjs"
```

`test.mjs` 依次做：编码检查 → **构建 `dist/`** → 编译 `dist-test/` → 跑测试。

**代价**：`npm test` 多编译一次 `dist/`（约 4 秒）。

**收益**：验收测试测的**一定**是当前源码 —— 「绿灯」与「代码」之间不再有缝隙。

### 为什么不是「反过来让 build 依赖 test」

不成立。`build` 是产物产出，`test` 是验证。验证依赖产物是**正常方向**。

### 为什么不是「验收测试自己编译」

验收测试在自己的临时目录里跑真实 CLI 进程。让**每个测试文件**各自编译一份 `dist/` 是荒谬的
（几十个文件 × 一次全量编译）。

正确的做法是**构建一次，测这一次** —— 即 `npm test` 负责构建。

### 空窗期：靠**互斥锁**，不靠 rename

删掉 `dist/` 到建好之间的空窗期，理论上可以用
「编译到临时目录 → 一次性 rename 换名」消除。

**实测在 Windows 上行不通**：

```
Error: EPERM: operation not permitted, rename 'D:\MyOpen\Zelto\dist' -> 'D:\MyOpen\Zelto\.dist-old'
```

Windows 上**目录 rename** 要求没有进程持有该目录（或其子目录）的句柄 ——
文件监视器（编辑器 / Cursor 的索引器）随时可能持有。
而且**失败是偶发的**（换个时刻跑就成功了）。

> **那是环境依赖的判据 —— 不能拿它当保证。**
> 一次「这次成了」不能证明「下次也会成」。

改用**互斥锁**（`scripts/build-lock.mjs`）：

| | 内容 |
|---|---|
| 锁的形态 | **目录**（`mkdir` 在 Windows 与 POSIX 上都是原子的：已存在则 `EEXIST`） |
| 拿不到锁 | **等**（不抢、不报错） |
| 超时 | 15 分钟，报错说清「怎么办」 |
| 陈旧锁 | 超过 10 分钟视为陈旧，**自愈**（进程被强杀留下的锁不会永久卡住） |

**构建与测试共用同一把锁** —— 它们不重叠，于是「读 `dist/`」永远看得见一个**完整的**目录。

**实测**（持锁 8 秒，第二个 build 耗时 **7924ms**）—— 后来者真的等了。

### 为什么锁是目录而不是文件

文件锁要处理「文件存在但进程已死」（得看 PID、得看时间戳），
而目录的 `mkdir` 天然原子，且**删除即释放**。

陈旧锁的自愈靠 `mtime`（不是 PID）—— 因为 PID 会被复用，
「PID 还在」不等于「那个进程还在」。

## 影响面

- `package.json`：`build` → `scripts/build.mjs`，`test` → `scripts/test.mjs`
- `scripts/build.mjs`（CLI 入口）+ `scripts/build-dist.mjs`（实现）
- `scripts/test.mjs`（测试入口）
- `scripts/build-lock.mjs`（锁）+ `scripts/build-lock.d.mts`（类型声明）
- `scripts/clean-dist.mjs`：**保留**（D-1 的历史入口，不再被 `build` 调用）
- `.gitignore`：加 `.build-lock`
- CI：`pnpm build` + `pnpm test` 可以保留（`test` 里的构建是幂等的），
  也可以去掉前者 —— 但**去掉更诚实**（少一次没必要的重复构建）

## 不变量核查

- **C1**（状态只在文件里）：无影响 —— 构建产物本来就是文件。
- **C2**（core 零第三方依赖）：无影响 —— `package.json` 脚本不是运行时依赖；
  `scripts/*.mjs` 只用 Node 内置。
- **C3**（判定确定性）：**加强** —— 验收测试测的产物不再取决于「谁先跑」。
- **C4**（append-only 事件流）：无影响。
- **C5**（保护域外部化）：无影响。
- **C9**（写集预约运行时强制）：无影响。

## 验收标准

1. ✅ `npm test` 在**没有预先 `npm run build`** 的干净工作区上全绿
   （实测 2404/2404）；
2. ✅ 并发 `npm run build` 与 `npm test` 时，验收测试**不出现**
   `MODULE_NOT_FOUND`（实测：并发跑，2404/2404 全绿）；
3. ✅ 改 `src/` 后**不**手动 build，`npm test` 测的是**新代码**
   （`test.mjs` 内部构建）；
4. ✅ 锁的行为有测试锁定（`tests/adr-080-build-lock.test.ts`，5 条）；
5. ⏳ CI 绿灯（本地已全绿，待推送后由 CI 复核）。

## 关联缺陷

- D-1（构建前必须清 `dist/`）：本 ADR **不推翻**它 ——
  「产物目录是当前源码的精确映射」这条仍然成立，
  只是**多了一把锁**保证「清 + 建」这个过程不被读者撞见。
- ADR-075（验收断言状态无关性）：**互补** ——
  那条修的是「判据的形态」，这条修的是「测的是哪份代码」。
  两者都是「同一个结论能不能被复现」。
- **Windows 目录 rename 不可靠**（本轮新发现的）：
  `EPERM` 且**偶发** —— 一次成功不能证明下次也会成。

## 参考

- `AGENTS.md` —— 「测试前必须先构建」（本 ADR 把这句话从文档变成工具行为）
- `scripts/clean-dist.mjs` —— D-1 的实现
