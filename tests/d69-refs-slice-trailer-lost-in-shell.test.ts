// D-69：切片提交的 Refs-Slice trailer 被 cmd.exe 静默吞掉
//
// 病灶（实测 nimrtc-zelto，2026-11-18）：切片的提交信息里
// `Refs-Slice: <id>` 这一行不见了。
//
//   $ git log -1 --format=%B bd19608b
//   feat(v5-writeset-acceptance): slice approved
//
// 就一行。trailer 没了。
//
// 病根在 `src/cli/commands/merge-runner.ts`：
//
//   execSync(`git commit -m "feat(${sliceId}): slice approved
//
//   Auto-commit from zelto run
//
//   Refs-Slice: ${sliceId}"`)
//
// execSync 在 Windows 上走 cmd.exe。cmd.exe 把命令里的换行当成命令分隔符，
// 于是 `git commit -m` 实际只拿到了**第一行**，后面两行（含 trailer）
// 被 cmd 当成两条命令去执行 —— 有的执行成功有的失败，反正 commit 成功了，
// 信息只剩第一行。**没人会看到这个丢字**：提交成功、钩子放行、合并正常。
//
// 为什么这不是"少一行字"：
//   Refs-Slice 是追溯链上的一环 —— 它把这次提交绑回那个切片。
//   没了它，`git log --grep Refs-Slice` 查不到这个提交，
//   追溯链就断在这里，而且断得悄无声息。
//
// 同一次改动里还有两处同类隐患（都靠 shell 字符串传参）：
//   - `git add -- <path>`：路径带空格 / 特殊字符时被拆成多个参数，
//     add 的就不是那个路径了（"暂存了别的东西"比"没暂存"更难查）。
//   - `git branch -d <branch>` / `git push origin <branch>`：同理。
//
// 这一组用例守的是：
//   1. Windows 上提交信息**完整**（三行都在，trailer 在）；
//   2. commit 里带 trailer，且格式是 `Refs-Slice: <id>`；
//   3. 多个 -m 参数拼出来的信息与单块多行信息等价（换行语义一致）；
//   4. 路径带空格时 add 的确实是那个路径；
//   5. 回归防护：实现里不能再出现「把多行信息塞进 shell 字符串」这种写法。

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, execSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

function git(args: string[], cwd: string): string {
  return execFileSync('git', args, { cwd, encoding: 'utf-8' });
}

let dir: string;
let repo: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'zelto-d68-'));
  repo = join(dir, 'repo');
  mkdirSync(repo, { recursive: true });
  git(['init', '-q', '-b', 'main'], repo);
  git(['config', 'user.email', 'test@zelto.local'], repo);
  git(['config', 'user.name', 'zelto test'], repo);
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
});

describe('D-69：Refs-Slice trailer 不能被 shell 吞掉', () => {
  it('execSync + 多行 shell 字符串会丢 trailer（这就是病灶本身）', () => {
    // 这个 bug 是 **Windows 特有**的：execSync 在 Windows 上走 cmd.exe，
    // cmd.exe 把命令里的换行当成命令分隔符；Linux/macOS 上走 /bin/sh，
    // 引号内的换行原样传给 git —— 旧写法在那边是好的。
    //
    // 所以这条用例**只在 Windows 上有意义**。
    // 钉住「旧写法在 Windows 上会坏」的价值是：
    // 一旦 cmd.exe 的行为变了（或有人把这段搬到别的平台），它会主动报错提醒重写。
    if (process.platform !== 'win32') {
      // 非 Windows：反向断言 —— 旧写法在 POSIX shell 下**不会**丢 trailer。
      // 这不是「跳过」，是把平台差异记进测试。
      writeFileSync(join(repo, 'a.txt'), 'a\n');
      git(['add', '-A'], repo);
      execSync(
        `git commit -m "feat(v9-demo): slice approved

Auto-commit from zelto run

Refs-Slice: v9-demo"`,
        { cwd: repo, stdio: ['pipe', 'pipe', 'pipe'] },
      );
      const msg = git(['log', '-1', '--format=%B'], repo);
      assert.ok(
        msg.includes('Refs-Slice'),
        'POSIX shell 下旧写法不该丢 trailer —— 若这条失败，说明 execSync 的行为变了',
      );
      return;
    }

    writeFileSync(join(repo, 'a.txt'), 'a\n');
    git(['add', '-A'], repo);

    // 复刻旧的写法（execSync 在 Windows 上默认走 cmd.exe）
    try {
      execSync(
        `git commit -m "feat(v9-demo): slice approved

Auto-commit from zelto run

Refs-Slice: v9-demo"`,
        { cwd: repo, stdio: ['pipe', 'pipe', 'pipe'] },
      );
    } catch {
      // cmd 的退出码不关心 —— 要看的是提交信息
    }

    const msg = git(['log', '-1', '--format=%B'], repo);
    assert.ok(
      !msg.includes('Refs-Slice'),
      '旧写法丢 trailer —— 如果这条断言失败，说明 cmd.exe 的行为变了，本用例需要重写',
    );
  });

  it('execFileSync + 多个 -m：完整三行都在', () => {
    writeFileSync(join(repo, 'a.txt'), 'a\n');
    git(['add', '-A'], repo);

    execFileSync(
      'git',
      [
        'commit',
        '-m',
        'feat(v9-demo): slice approved',
        '-m',
        'Auto-commit from zelto run',
        '-m',
        'Refs-Slice: v9-demo',
      ],
      { cwd: repo },
    );

    const msg = git(['log', '-1', '--format=%B'], repo);
    assert.match(msg, /feat\(v9-demo\): slice approved/);
    assert.match(msg, /Auto-commit from zelto run/);
    assert.match(msg, /Refs-Slice: v9-demo/);
  });

  it('多个 -m 与单块多行信息等价（段落分隔是空行）', () => {
    writeFileSync(join(repo, 'a.txt'), 'a\n');
    git(['add', '-A'], repo);
    execFileSync(
      'git',
      ['commit', '-m', 'subject\n\nbody\n\nRefs-Slice: v9-demo'],
      { cwd: repo },
    );
    const oneBlock = git(['log', '-1', '--format=%B'], repo);

    writeFileSync(join(repo, 'b.txt'), 'b\n');
    git(['add', '-A'], repo);
    execFileSync(
      'git',
      ['commit', '-m', 'subject', '-m', 'body', '-m', 'Refs-Slice: v9-demo'],
      { cwd: repo },
    );
    const threeBlocks = git(['log', '-1', '--format=%B'], repo);

    assert.equal(oneBlock.replace(/\r\n/g, '\n'), threeBlocks.replace(/\r\n/g, '\n'));
  });

  it('实现里不再有「把多行提交信息塞进 shell 字符串」的写法', () => {
    const src = readFileSync(
      join(process.cwd(), 'src', 'cli', 'commands', 'merge-runner.ts'),
      'utf-8',
    );
    // execSync 的命令里出现换行 → cmd.exe 会吃掉它
    assert.ok(
      !/execSync\(\s*`[^`]*\n/.test(src),
      'merge-runner.ts 里还有 execSync + 含换行的命令串',
    );
    // git commit 必须走参数数组
    assert.ok(
      !/execSync\([^)]*git commit/.test(src),
      'merge-runner.ts 里还有 execSync 跑 git commit',
    );
  });

  it('路径带空格时 add 的确实是那个路径', () => {
    const spaced = join(repo, 'a dir', 'b file.txt');
    mkdirSync(join(repo, 'a dir'), { recursive: true });
    writeFileSync(spaced, 'x\n');
    writeFileSync(join(repo, 'other.txt'), 'y\n');

    execFileSync('git', ['add', '--', 'a dir/b file.txt'], { cwd: repo });

    const staged = git(['diff', '--cached', '--name-only'], repo);
    assert.equal(staged.trim(), 'a dir/b file.txt');
  });
});
