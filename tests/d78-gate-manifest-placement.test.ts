// D-78：收窄清单的落点必须与 ctest 解析相对路径的基准一致
//
// ── 病灶（2026-11-25，nimrtc-v14 v1.4 实测）─────────────────────────────
//
// `ctest --test-dir build --tests-from-file <清单>` 里，**`<清单>` 是相对
// `--test-dir` 解析的**，不是相对进程 cwd 解析的。
//
// 也就是说：清单写在**工作目录根**（worktree 根）时，ctest 会去
// `<worktree>/build/<清单>` 找 —— 找不到就报：
//
// ```text
// Problem reading test list file: .zelto-gate-tests-<id>.txt
// while generating list of tests to run.
// ```
//
// 退出码 8。**门禁于是红了，但红的原因与被测代码毫无关系** ——
// 是 zelto 自己的收窄机制把测试命令打坏了。
//
// 实测对照（同一棵 build 树）：
// - 清单在 worktree 根 → `Problem reading test list file`（exit 8）
// - 清单在 `build/` 里   → 正常读到（exit 0）
//
// 危害等级：**高**。收窄机制的目的是「让重试更快」，结果它把重试
// 变成了 100% 失败 —— 门禁判红的理由与被测代码无关，人会去查错方向。
//
// ── 修法为什么是「绝对路径」（2026-11-25 补）───────────────────────────
//
// 第一版修法把清单写进 `build/`，命令行里仍写**裸文件名**。那在真 ctest 上
// 对（ctest 相对 `--test-dir` 解析），但在**端到端 fixture 的 ctest 替身**上
// 不对 —— 替身是 `node worker.cjs %*`，读相对路径走的是**进程 cwd**，
// 于是它去 worktree 根找，找不到（ZD-027 端到端用例实测红）。
//
// 反过来「写进 build/ + 命令行写 build/m.txt」也不行 —— 真 ctest 会去
// `build/build/m.txt` 找。
//
// **只有绝对路径在两边都指向同一个文件**。
// 代价是 Windows 路径里的空格/引号 —— 用引号兜住；
// 清单文件名由 zelto 生成（固定前缀 + 切片 id，无空格无引号）。
//
// C3：被测逻辑全是纯路径计算，判定确定。

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { join, sep } from 'node:path';

import { resolveCtestManifestPlacement } from '../src/core/gate/diagnostics.js';

const ROOT = '/work/tree';

/** 把带引号的引用去掉引号 —— 引号只是为了让 cmd 不劈开路径里的空格。 */
function unquote(ref: string): string {
  return ref.startsWith('"') && ref.endsWith('"') ? ref.slice(1, -1) : ref;
}

describe('D-78 · 收窄清单落点跟着 --test-dir 走', () => {
  it('带 --test-dir 时，清单落进那个目录（ctest 就是从那儿解析的）', () => {
    const run = 'cmd /c "ctest --test-dir build --output-on-failure -C Debug --timeout 120"';
    const placement = resolveCtestManifestPlacement(run, ROOT, '.zelto-gate-tests-x.txt');
    assert.equal(
      placement.absolutePath,
      join(ROOT, 'build', '.zelto-gate-tests-x.txt'),
      '清单必须落在 --test-dir 指向的目录里',
    );
  });

  it('命令行引用是带引号的绝对路径（真 ctest 与替身都指向同一个文件）', () => {
    const run = 'cmd /c "ctest --test-dir build --output-on-failure -C Debug --timeout 120"';
    const placement = resolveCtestManifestPlacement(run, ROOT, '.zelto-gate-tests-x.txt');
    assert.equal(
      unquote(placement.relativeRef),
      placement.absolutePath,
      '引用必须与落点指向同一个文件',
    );
    assert.ok(
      placement.relativeRef.startsWith('"') && placement.relativeRef.endsWith('"'),
      '绝对路径要用引号包住 —— cmd /c "..." 里的空格会劈开参数',
    );
  });

  it('--test-dir 是绝对路径时，清单落在那个绝对目录里', () => {
    const run = 'ctest --test-dir /opt/build --output-on-failure';
    const placement = resolveCtestManifestPlacement(run, ROOT, 'm.txt');
    assert.equal(placement.absolutePath, join('/opt/build', 'm.txt'));
  });

  it('没有 --test-dir 时，清单留在工作目录根（ctest 以 cwd 为工作目录）', () => {
    const run = 'ctest --output-on-failure -C Debug';
    const placement = resolveCtestManifestPlacement(run, ROOT, 'm.txt');
    assert.equal(placement.absolutePath, join(ROOT, 'm.txt'));
    assert.equal(
      unquote(placement.relativeRef),
      placement.absolutePath,
      '引用与落点必须指向同一个文件',
    );
  });

  it('--test-dir=build（等号形态）也要认', () => {
    const run = 'cmd /c "ctest --test-dir=build --output-on-failure"';
    const placement = resolveCtestManifestPlacement(run, ROOT, 'm.txt');
    assert.equal(placement.absolutePath, join(ROOT, 'build', 'm.txt'));
  });

  it('引号形态的 --test-dir 也要认', () => {
    const run = 'ctest --test-dir "D:/my build" --output-on-failure';
    const placement = resolveCtestManifestPlacement(run, ROOT, 'm.txt');
    assert.equal(placement.absolutePath, join('D:/my build', 'm.txt'));
  });

  it('落点与命令行引用必须自洽：引用指的就是清单本体', () => {
    // 这是整条判定的核心不变式 ——
    // 清单的落点与命令行里引用的路径必须是**同一个文件**。
    // 真 ctest 相对 `--test-dir` 解析清单，ctest 替身相对 cwd 解析；
    // 只有绝对路径在两边都成立。
    for (const run of [
      'cmd /c "ctest --test-dir build --output-on-failure"',
      'ctest --test-dir build --output-on-failure',
      'ctest --output-on-failure',
    ]) {
      const placement = resolveCtestManifestPlacement(run, ROOT, 'm.txt');
      assert.equal(
        unquote(placement.relativeRef),
        placement.absolutePath,
        `引用与落点必须指向同一个文件：${run}`,
      );
    }
  });

  it('落点目录是 --test-dir 指向的那个（不是工作目录根）', () => {
    const run = 'cmd /c "ctest --test-dir build --output-on-failure"';
    const placement = resolveCtestManifestPlacement(run, ROOT, 'm.txt');
    const dirOfManifest = placement.absolutePath.slice(
      0,
      placement.absolutePath.length - 'm.txt'.length,
    );
    assert.equal(
      dirOfManifest,
      join(ROOT, 'build') + sep,
      `解析基准必须是 build/，实际 ${dirOfManifest}`,
    );
  });
});
