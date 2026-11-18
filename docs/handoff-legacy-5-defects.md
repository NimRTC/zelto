# 交接：清掉实战演练遗留的 5 条 zelto 缺陷

**日期**：2026-11-18
**来源**：`docs/zelto-实战演练记录-20261116.md` §8「第三轮遗留状态」的「仍然遗留」清单
**状态**：**5 条全部完成**（缺陷编号 D-75 ~ D-79）

---

## 结论

| 编号 | 缺陷 | 状态 | 回归测试 |
|---|---|---|---|
| D-75 | Java / Kotlin 依赖解析缺失 | ✅ 完成 | `tests/d75-d77-arch-language-parsing.test.ts` |
| D-76 | Go 的文件名构建约束 | ✅ 完成 | 同上 |
| D-77 | Rust 的 `super::` / `self::` 层级解析 | ✅ 完成 | 同上 |
| D-78 | 「静默失败」防线只覆盖 policy 编辑路径 | ✅ 完成 | `tests/d78-verified-file-writes.test.ts` |
| D-79 | 合并清理报错措辞 | ✅ 完成 | `tests/d79-merge-cleanup-wording.test.ts` |

**契约变更**：ADR-082（`docs/adr/adr-082-verified-file-writes.md`）—— 统一写入原语。

**门禁**（2026-11-18）：

| 检查 | 结果 |
|---|---|
| `npm test` | ✅ 2465 passed / 0 failed / 546 suites |
| `npm run lint` | ✅ 通过（biome） |
| `npm run check:encoding` | ✅ 通过（18 个文件无乱码） |

---

## 背景（必读）

这 5 条是**在真实项目（nimrtc-zelto）上跑出来的**，不是理论推演。

演练记录里反复出现同一个教训，已经复发至少 4 次：

> **「每条路径都接上了」不等于「每条路径都接全了」。**
> **「这一层改好了」被当成「这件事改好了」。**

D-55（进展喂了两条路，第三条漏了）、D-64（回退路径补了，空壳清理路径没补）、
D-69（判据不能只靠一根绳）都是这个形态。

**所以这次的核心要求是：修完一条，必须去真实项目上复验一遍**，
而不是「单元测试绿了就算完」。

---

## D-75：Java / Kotlin 依赖解析缺失（中等）

### 问题

`src/core/arch/imports.ts` 里有 Java/Kotlin 的**语言分类**，
但**没有 import 解析器**：

```ts
// imports.ts:95
java: 'java', kt: 'java', kts: 'java',   // ← 只分类，不解析
```

`parseImports()` 没有 `java` 分支，`scan.ts` 里也没有 `file.lang === 'java'` 的分支。

### 实现

- **`src/core/arch/imports.ts`**
  - 新增 `parseJavaImports()`：认 `import a.b.C;` / `import static a.b.C;` /
    `import a.b.*;` / `import a.b.C as D;`；Kotlin 的 `import a.b.C` / `import a.b.C as D`。
  - `.java` / `.kt` / `.kts` 都归到 `java` 语言类别。
  - `isVerifiableLang()` 加入 `java` —— 现在它才真正说得通。
- **`src/core/arch/scan.ts`**
  - 新增 `resolveJavaImport(specifier, fileSet)`：包路径 → 类文件。
    - 候选目录按约定枚举：`src/main/java`、`src/main/kotlin`、`src/test/java`、
      `src/test/kotlin`、`src`（Gradle / Maven / Kotlin 常见布局都认）。
    - 兜底：按**路径后缀**唯一匹配（多模块 Gradle 的 `core/src/main/java/...`
      这类布局也能落到）。**多个命中 = 歧义 → 返回 null**（宁可漏边，不猜错边）。
    - 通配符 import（`a.b.*`）解析不到具体类 → 返回 null（漏边，不猜）。
  - `scan.ts` 里加 `java` 分支：解析出包路径 → 落到具体类文件 → 产生跨模块边。
- **`src/core/arch/types.ts`**：`SourceLang` 增加 `'java'`。

### 「宁可漏边也不要判错边」

假边会产生假的「环」—— 报告会报一个不存在的架构违规，
人得花半天去查一个根本不存在的问题。
所以解析不确定时一律返回 `null`（漏边），不返回猜测值。

### 测试

`tests/d75-d77-arch-language-parsing.test.ts`：

- import 解析：静态导入 / 通配符 / `as` 别名 / Kotlin。
- 包路径 → 类文件：Gradle 布局、Maven 布局、Kotlin 布局。
- 解析不到时返回 `null`（不猜）。
- 模块归属：Java 的 import 产生 `src/app → src/core` 的边。
- 覆盖面：`java` 进入 `verifiable`，Java 文件参与 import 图。

---

## D-76：Go 的文件名构建约束（低，但影响覆盖率口径）

### 问题

Go 有平台后缀（`_linux.go` / `_windows.go` / `_darwin.go`）
和测试后缀（`_test.go`）。原来**完全没处理**。

### 实现

- **`src/core/arch/scan.ts`**
  - 新增 `parseGoFileConstraints(filePath)`：认 `_linux` / `_windows` / `_darwin` /
    `_linux_amd64` 这类 OS/arch 后缀。
    - 只认**文件名最后一段**的后缀 —— `linux_helper.go` 不是 linux 专属。
  - 平台专属文件产生的依赖边标成**条件边**（`conditional`）。
    - 同一个包在不同平台可能有不同实现 → 依赖边要按「所有平台都成立」算，
      否则会误报环。
- **`src/core/arch/test-files.ts`**：`_test.go` 归类为**测试文件**，
  不参与模块依赖边（与既有约定一致）。

### 测试

`tests/d75-d77-arch-language-parsing.test.ts`：

- `_test.go` 是测试文件；`registry.go` 不是。
- 平台后缀识别；没有后缀时返回 `null`；`linux_helper.go` 不认。
- 两个平台专属实现互相引用 → **不误报环**，边被标成条件边。

---

## D-77：Rust 的 `super::` / `self::` 层级解析（低，判不准时漏边）

### 问题

`classifyRustSpecifier()` 把 `super::` / `self::` 归类为 `relative`，
但 `resolveRustImport()` **只处理 `crate::`**：

```ts
// 原来的 scan.ts
if (!specifier.startsWith('crate::')) return null;   // ← super:: / self:: 直接漏掉
```

### 实现

**`src/core/arch/scan.ts`**：

- 新增 `moduleDirOfRustFile(fromFile)`：算出「当前文件所属模块的目录」。
  - `src/foo/mod.rs` → `src/foo`（模块 `foo` 的目录就是它所在的目录）
  - `src/foo.rs` → `src/foo`（模块 `foo` 由这个文件构成，子模块在 `src/foo/` 下）
  - `src/foo/bar.rs` → `src/foo/bar`（模块 `foo::bar`）
- 新增 `parentModuleDir(dir)`：上一级模块目录。
- `resolveRustRelativeImport()`：
  - **逐段剥掉** `self` / `super` / `super::super` 前缀（`super` 上跳一级，`self` 不动）。
  - 路径从长到短**逐级缩短**尝试 —— `super::engine::helper::H` 可能指模块
    `engine::helper`，也可能指模块 `engine` 里的类型 `helper`。
  - 同时认 `<module>/<name>.rs` 与 `<module>/<name>/mod.rs` 两种布局。
  - **不做 crate 根兜底** —— 否则 `src/foo/bar.rs` 里的 `super::baz`
    会错误地落到 `src/baz.rs`。

### 测试

`tests/d75-d77-arch-language-parsing.test.ts`：

- `self::sibling` → 当前模块目录下的 sibling。
- `super::parent` → 上一级模块。
- `super::super::x` → 上跳两级。
- `foo.rs` + `foo/` 两种布局都认。
- 模块目录形式（`self::x` → `x/mod.rs`）。
- 从 `mod.rs` 出发时 `super::` → 上一级目录。
- 判不准时返回 `null`（漏边，不猜）。
- `crate::` 跨模块边照常产生。

---

## D-78：「静默失败」防线只覆盖了 policy 编辑路径（严重）

**这是 5 条里唯一还在持续产生新病灶的**，其余 4 条是特定语言的解析盲区，
影响面局限。

### 问题

ADR-070 为 policy 编辑路径建了防线，
但**其它「写文件然后报告成功」的路径没有同构防线**。
典型例子（D-31 的原始病灶）：

```ts
// section-editor.ts:291 —— 找不到就原样返回
export function removeSectionEntry(...): string {
  const entry = findSectionEntry(yaml, section, keyName, id);
  if (!entry) return yaml;        // ← 文件没变，但调用方照样 return success: true
}
```

### 实现

#### ① 统一写入原语（ADR-082）

新增 `src/core/io/atomic-write.ts`（仅用 Node 内置，零第三方依赖）：

```ts
export interface WriteReceipt {
  path: string;
  bytes: number;
  hash: string;      // sha256:<hex>
  changed: boolean;  // 与写前内容是否不同
}

export async function atomicWriteText(path: string, content: string): Promise<WriteReceipt>;
export async function atomicWriteJson(path: string, value: unknown): Promise<WriteReceipt>;
```

原语的保证：

1. **原子替换** —— 先写同目录临时文件，再 `rename` 覆盖。
2. **写完必验** —— 读回目标文件，逐字节比对预期内容；不一致直接抛错。
3. **失败必抛** —— 不吞异常，不返回「看起来成功」的结果。
4. **成功有凭据** —— 返回值带字节数、SHA-256 哈希、是否发生变化。

#### ② 调用方必须复核「内容是否真的变了」

对于「修改既有状态文件」的命令，**内容没变就是失败**，不能报成功。
原语返回 `changed: false` 时，调用方必须：

- 返回**非 0 退出码**；
- 打印明确的原因（目标条目/键不存在、内容已是期望值等）；
- 不写「成功」类事件。

#### ③ 接入范围

**用户可见、修改状态文件**的命令：

| 命令 | 位置 |
|---|---|
| `zelto set` | `src/cli/commands/slice-detail.ts` |
| `zelto config set` | `src/cli/commands/config.ts` |
| `zelto spec draft` / `confirm` | `src/cli/commands/slice-spec.ts` |
| `zelto design patch` | `src/cli/commands/design-patch.ts` |
| `zelto plan patch` | `src/cli/commands/plan-patch.ts` |
| `zelto patch-content` | `src/cli/commands/patch-content.ts` |
| `zelto policy add/edit/remove` | `src/cli/policy/handlers/rules.handler.ts` |
| `zelto policy arch add/edit/remove` | `src/cli/policy/handlers/arch.handler.ts` |
| `zelto slice create` | `src/cli/commands/slice-detail.ts` |

**`core/` 状态 store**（切片、设计、版本计划、需求）也改用同一原语保存：

- `src/core/slice/store.ts`
- `src/core/design/store.ts`
- `src/core/version/store.ts`
- `src/core/requirements/store.ts`

### 顺带修掉的两个「同类」缺陷

修复过程中暴露出两处**同形状**的病灶，一并修掉：

#### ① `section-editor.ts` 的条目范围吞掉了文件末尾换行

段在文件末尾时，`range.end = lines.length`，
而 `split('\n')` 会在文件末尾的换行符之后多出一个空串。
不裁掉的话，`replaceSectionEntry` 把条目块换回去时会把那个空串**一起吃掉**
—— 文件末尾的换行没了，于是「内容其实没变」也会被判定成「变了」。

→ `src/core/policy/section-editor.ts`：条目范围不吞尾部空行。

#### ② 命令别名把真命令整个遮住了

`COMMAND_ALIASES` 里有 `slice: 'slices'`，而 `slice` 本身**也是**一个真命令
（`slice create` / `slice validate` / `slice <id>` 详情）。
别名优先于真命令，于是：

```
zelto slice create s1
→ 跑到 slices（列表）上去 → 输出「No slices found.」+ 退出码 0
```

这是「工具报告成功、实际什么都没做」那族缺陷的**新变体**。

→ `src/cli/commands/index.ts`：**真命令优先**，别名只在真命令不存在时兜底。

（`docs/zelto-场景功能地图.md` 早就写了 `zelto slice <id> [--json]` 是「查看切片详情」——
 文档说的和实际行为早就不一致了。）

### 测试

`tests/d78-verified-file-writes.test.ts`：

**原语层**：
- 写完文件内容就是写进去的内容。
- 返回可核对的凭据（字节数 + 哈希 + 是否变化）。
- 父目录不存在时自动创建。
- 不留下临时文件。
- `hashContent` 的形态与策略锚点一致（`sha256:<hex>`）。
- `WriteVerificationError` 是 `Error` 的子类。

**命令层**（每条接入路径至少一条）：
- `config set` 同值 → 退出码 ≠ 0，文件没变。
- `config set` 真改值 → 退出码 0，文件确实变了。
- `policy edit` 同值 → 退出码 ≠ 0。
- `policy arch edit` 同值 → 退出码 ≠ 0。
- `policy remove` 不存在的规则 → 退出码 ≠ 0。
- `slice create` 规格已存在 → 退出码 ≠ 0。
- `zelto set` 同值 → 退出码 ≠ 0。
- `zelto spec confirm` 草稿与正式规格完全一致 → 退出码 ≠ 0。

---

## D-79：合并清理报错措辞（低）

### 问题

`cleanupMergedSlices()` 的判据是对的（D-40 已修正过），但**两处措辞混着两种情况**：

1. **判据没过**（`!merged`）vs **git 拒绝删**（catch 分支）：
   - 前者是「分支上还有未合入的内容」—— **真需要人处理**
   - 后者是「git 说不行，但原因不明」—— 可能是 worktree 还占着
   原来两者的提示长得几乎一样，人分不出「要我去合」还是「要我去查锁」。
2. **措辞本身**：`it still has changes not merged into X` 在版本分支场景下
   **不准确** —— 分支**已经**合进 `version/vN` 了，只是判据查的是别的地方。
   这时应该说「已合入目标分支，但删不掉」，而不是「还有未合入的内容」
   （后者是假话，正是 D-62/D-63 那个形态）。

### 实现

`src/cli/commands/merge-runner.ts` —— 两类失败**分开措辞**，且都改成中文：

- **判据没过**：
  > 分支 `<name>` 上还有未合入 `<target>` 的内容 —— 先合，或确认后手动 `git branch -D <name>`
- **git 拒绝删**：
  > 分支已合入 `<target>`，但 git 拒绝删除（原因：<git 原话>）—— 通常是 worktree 还没释放；确认后手动 `git branch -D <name>`

### 测试

`tests/d79-merge-cleanup-wording.test.ts`：

- 判据没过 → 如实说「还有未合入的内容」，且不删分支。
- git 拒绝 → 说「已合入目标分支，但 git 拒绝删除」。
- 两条提示能区分（措辞不同）。
- 两条提示都是中文。

---

## 真实项目复验（nimrtc-zelto）

**「每条路径都接上了」不等于「每条路径都接全了」** ——
所以每条都在 `D:\MyOpen\nimrtc-zelto` 上跑过一遍真实 CLI。

### ① 架构扫描无回归

`zelto arch check --root .` → 退出码 0，覆盖面统计：

```json
{
  "counts": {
    "typescript": 2, "python": 82, "cpp": 493,
    "go": 0, "rust": 0, "java": 0, "csharp": 0,
    "build": 120, "doc": 160, "config": 36, "other": 115
  },
  "verifiable": ["typescript", "python", "cpp"],
  "verifiedFiles": 575,
  "unverifiableCodeFiles": 0,
  "vendorFiles": 68784,
  "testFiles": 244
}
```

C++ 的 493 个文件照常参与依赖验证，`unverifiableCodeFiles: 0`，
没有因为新增语言类别而漂移。

### ② D-75 / D-76 / D-77 逐条跑通

用真实构建产物（`dist/core/arch/scan.js`）在真实工程形态的 fixture 上扫：

| 语言 | 场景 | 结果 |
|---|---|---|
| Java | `src/app` 的 `import com.example.core.Registry` | ✅ `src/app → src/core` |
| Kotlin | `src/ktapp` 的 `import com.example.core.Engine` | ✅ `src/ktapp → src/ktcore` |
| Go | `internal/core` 的 `import "example.com/demo/internal/platform"` | ✅ `internal/core → internal/platform` |
| Rust | `src/engine/peer.rs` 的 `use super::helper::H` + `use crate::core::registry::Registry` | ✅ `src/engine → src/core` |

`unresolved: []` —— 没有留下解析不到的 import。

### ③ D-78 在真实状态文件上生效

```
$ zelto config set gate.timeoutSec 120     # 同值
Config key "gate.timeoutSec" already has that value — nothing was changed. Nothing was written.
EXIT= 1
```

真实项目的 `.zelto/config.yaml` 跑完后内容完好（注释、密钥占位符一个没丢）。

### ④ D-79 两种措辞都出来了

在真实 git 仓库里造了两种情形：

```
情形一（判据没过）：
  ℹ️  分支 "slice/verify-unmerged" 上还有未合入 "main" 的内容 —— 先合，或确认后手动 `git branch -D slice/verify-unmerged`

情形二（git 拒绝删）：
  ℹ️  分支已合入 "main"，但 git 拒绝删除（原因：Command failed: git branch -d slice/verify-locked）—— 通常是 worktree 还没释放；确认后手动 `git branch -D slice/verify-locked`
```

复验后真实项目已复位（`git reset --hard` 回原提交，分支 / worktree / 临时文件全部清干净）。

---

## 不变量核查

- **C1**：无影响。状态仍只在文件里；原语只是把写文件做得更可靠。
- **C2**：满足。`src/core/io/atomic-write.ts` 只用 `node:fs` / `node:path` / `node:crypto`；
  `core/` 仍零第三方运行时依赖、仍不 import `adapters/`。
- **C3**：满足。语言解析与写入原语都只做文件读写与纯计算，不调模型、不触网。
- **C4**：强化。写失败不再被当成成功动作，事件流不会记录一个没发生的变更。
- **C5**：无影响。
- **C6**：满足。`core/` 不 import `adapters/`。
- **C7**：无影响。
- **C9**：无影响。写入范围仍由既有写集预约机制控制。

---

## 顺带说明：语言类别表的两处整理

D-75 把 `java` 加进 `isVerifiableLang()` 之后，
`isCodeLangCategory()` 与 `isVerifiableLang()` 变成了**完全相同的两个列表** ——
「代码类但验不了」这一档空了，ADR-061 的区分就没法演示了。

处理：

1. **新增 `csharp` 类别**（`.cs`）—— 它有 `using` 依赖语义，但扫描器还没实现解析，
   正好是「代码类但验不了」的代表。报告对 C# 项目能说清
   「这是代码」与「依赖已验证」是两回事。
2. **合并两份 `LangCategory` 定义** —— `imports.ts` 与 `types.ts` 各写了一份，
   加语言时只改一处就会漂。现在 `imports.ts` 重新导出 `types.ts` 的那份，
   **单一真源**。
3. **CLI 改用 core 的 `isCodeLangCategory`** —— `src/cli/commands/architecture.ts`
   里原来自己抄了一份，抄一份就会漂。

相应地，`tests/arch-cpp-project.test.ts` 与 `tests/arch-lang-coverage.test.ts`
里「用 Java 代表『验不了的代码』」的断言换成了 C#，
「Java 不是可验证语言」的断言改成了「Java 是可验证语言」。

---

## 现场资料

| 位置 | 内容 |
|---|---|
| `D:\MyOpen\Zelto` | zelto 仓库本体 |
| `D:\MyOpen\nimrtc-zelto` | 真实项目（复验用） |
| `D:\MyOpen\Zelto\docs\zelto-实战演练记录-20261116.md` | 演练全过程 + 缺陷目录 |
| `D:\MyOpen\Zelto\docs\adr\adr-082-verified-file-writes.md` | 本次新增的 ADR |
| `D:\MyOpen\Zelto\docs\adr\adr-069-dependency-resolution.md` | 依赖解析（Go / Rust） |
| `D:\MyOpen\Zelto\docs\adr\adr-070-policy-edit-silent-failure.md` | 静默失败防线（policy 编辑路径） |
| `D:\MyOpen\Zelto\docs\adr\adr-080-build-dist-lock.md` | 构建锁 |
