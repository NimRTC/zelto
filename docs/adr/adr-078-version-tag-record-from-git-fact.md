# ADR-078：版本计划里的 tag 记录以 git 事实为准 —— 「本次打了」与「这一版有 tag」是两件事

**状态**：实施
**日期**：2026-11-18
**相关**：ADR-056（版本分支与 tag 是追溯锚点）、ADR-076（D-71 空操作合并的 mergeCommit 真实性）、D6-C（tag 是不可变锚点）

## 背景

`zelto version ship` 有两处写 tag 记录的地方，都是用「**本次有没有新打 tag**」
当成「**这一版有没有 tag**」：

```ts
// 打 tag（幂等 —— 已存在就跳过，不覆盖）
function tagVersion(tag, commit, ...) {
  if (exists) return false;      // ← 已存在 → 返回 false
  git tag -a ...
  return true;
}

let tagged = tagVersion(tag, ...);
version.tag = tagged ? tag : undefined;          // ← 计划里的记录
events.append(..., { tag: tagged ? tag : null }); // ← 事件里的记录
```

`tagVersion` 的幂等语义是对的（不覆盖已有 tag），但**返回值被当成了别的意思**。

## 病灶

实测（nimrtc-zelto，2026-11-17）：v1 和 v2 各被 ship 了**两次**。
第二次 ship 时 tag 已存在 → `tagVersion` 返回 false →

- 计划里 `version.tag` 被抹成 `undefined`
- 事件里记 `tag: null`

**但 git 里 tag 好好地在那儿** —— `git tag -l` 看得到 `v1` / `v2`。

于是：计划说「这一版没打 tag」，git 说「tag 在」。
**两个证据打架**（C4：事件是追溯的唯一证据载体，这里事件说了假话）。

实测后果（版本计划 `plan-1794832504096.json`）：

| 版本 | 被 ship 几次 | 计划里的 tag |
|------|------------|------------|
| v1 | 2 | `undefined` ❌ |
| v2 | 2 | `undefined` ❌ |
| v3 | 1 | `"v3"` ✅ |
| v4 | 1 | `"v4"` ✅ |
| v5 | 1 | `"v5"` ✅ |

规律精确到「有没有被 ship 第二次」—— 这正是判定它是**系统性问题**而非偶发。

## 决策

### 「这一版有没有 tag」以 git 里的事实为准

```
tagExists   = git rev-parse --verify refs/tags/<tag>   （成功即存在）
versionHasTag = tagExists
```

三种情形对得很齐：

| 情形 | git 里有吗 | 记录 |
|------|-----------|------|
| 本次打了 tag | 有 | 记 tag |
| tag 早就有了（二次 ship） | 有 | 记 tag（沿用） |
| 真没有 / `--no-tag` | 没有 | 记 null（不虚报） |

### `--no-tag` 的语义是「本次不**创建** tag」，不是「抹掉这一版的 tag 记录」

抹掉记录是同一个病灶换个方向犯 —— 人显式说「别打 tag」，
zelto 顺手把「这一版曾经有过 tag」也否认了。

### 一条被 D-73「顺手满足」的错断言（D-71 的用例）

修 D-73 时，`tests/d71-noop-merge-commit-truth.test.ts` 里一条断言露了馅：

```ts
assert.notEqual(secondTag, firstTag,
  '两次 ship 的 tag 不能指向同一个提交（那正是 v1 与 v4 撞车的病灶）');
```

它比的是 **tag 名字**（`"vx"` vs `"vx"`），而**同一个版本的两次 ship
名字本来就该一样** —— 这条断言从一开始就在比错的东西。

它之所以「通过」：二次 ship 时 `tagVersion()` 返回 false
→ 事件里记 `tag: null` → `null !== "vx"` → 断言成立。

也就是说：**D-73 的缺陷恰好满足了一条写错的断言**。
D-73 修好（tag 名不再被抹成 null）后，断言就露馅了。

病灶的实质不是「tag 名字一样」—— 同一个版本本来就该用同一个 tag 名。
实质是「tag 指向了**别的版本**留下的提交」。

所以判据改成：
- 空操作时 `anchorCommit` = **版本分支 tip**（ADR-076 D2）；
- 新增一条用例造**两个不同版本**（v1 / v2），断言两个 tag 指向不同提交。

**教训**：一条断言长期「通过」可能不是因为它对，而是因为它被某个缺陷
意外满足了。修缺陷时冒出红，要先问「是断言写错了，还是我的修复错了」——
两者都真实发生过。

## 影响面

- `src/cli/commands/version-ship.ts`
  - 新增 `tagAlreadyExists(tag, repoRoot)`
  - 计划记录、事件 payload、JSON 输出统一改用 `versionHasTag`
  - JSON 输出新增 `tagCreated`（本次是否新打）
- `src/core/version/patch.ts` + `src/cli/commands/plan-patch.ts`
  - 新增 `VersionPatch.tag` 字段与 `--tag <name|none>` 选项
  - 用途：**修历史遗留的错误记录**（见下「遗留」）
- `tests/d73-ship-tag-record-preserved.test.ts` —— 5 条用例（新增）
  走**真实 CLI 进程**（`dist/cli/index.js`），不是 mock ——
  病灶本身就是「跨进程 + 跨文件」的行为，mock 测不出来。
- `tests/plan-patch.test.ts` —— 4 条用例（新增）：tag 字段的修正语义
- `tests/d71-noop-merge-commit-truth.test.ts` —— 修正 1 条错断言 + 新增 1 条用例
  （两个不同版本的 tag 不撞车）

## 不变量核查

- **C1**（状态只在文件里）：无影响 —— 判据是 git 的事实，git 的对象库也是文件。
- **C2**（core 零第三方依赖）：无影响。
- **C3**（判定确定性）：`git rev-parse --verify` 是确定性判定。
- **C4**（append-only 事件流）：**加强** —— 事件不再否认已存在的 tag。
  事件流仍是只追加：修的是「追加的内容不对」，不是「改写历史」。
- **C5**（保护域外部化）：无影响。
- **C9**（写集预约运行时强制）：无影响。

## 遗留

nimrtc-zelto 的版本计划里 v1 / v2 的 `tag` 字段是历史遗留的 `undefined`。
本 ADR 只修**未来**的行为 —— 历史状态文件不自动改写
（改写状态文件而不留事件同样是追溯链上的谎言）。

修历史走 `zelto plan patch --tag <name>`：确定性修正 + 写 `draft.revised` 事件。
本 ADR 同时给 `plan patch` 加了 `--tag` 选项，就是为了让这条路径存在 ——
否则修历史只能手改状态文件，那又是同一个病灶。

实测（nimrtc-zelto，2026-11-18）已用它把 v1 / v2 的记录修正为 `v1` / `v2`，
事件流里有对应的 `draft.revised` 记录（before=`(无)`，after=`v1`/`v2`）。
