// Tests for the generated git hook script (ADR-014)
//
// 关注两件事：
//   1. 脚本里 git 的路径输出关了引号 —— 否则非 ASCII 文件名会被转义成
//      八进制（"docs/\346\212\200.md"），判定时路径对不上，正常文件被当成越界。
//   2. 脚本真的能跑：在临时仓库里装上脚本、提交一个中文路径的文件，
//      应当放行（退出码 0）。

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { hookScript } from '../../src/cli/commands/hook-install.js';

const HOOK_MODULE_DIR = join(process.cwd(), 'dist', 'hook');

/**
 * 找一个能执行 POSIX shell 的可执行文件；找不到就返回 null。
 *
 * Windows 上优先用 Git 自带的 bash：`sh` / `bash` 在 PATH 里可能指向 WSL，
 * 而 WSL 看不见 Windows 的盘符路径（`C:\...` 会被当成相对路径）。
 */
function findShell(): string | null {
  const candidates: string[] = [];

  // Windows 上的 Git 附带 bash，但不一定在 PATH 里
  if (process.platform === 'win32') {
    const execPath = spawnSync('git', ['--exec-path'], { encoding: 'utf-8' });
    if (execPath.status === 0) {
      const gitRoot = join(execPath.stdout.trim(), '..', '..', '..');
      candidates.push(join(gitRoot, 'bin', 'bash.exe'));
      candidates.push(join(gitRoot, 'bin', 'sh.exe'));
    }
  }

  candidates.push('sh', 'bash');

  for (const candidate of candidates) {
    const probe = spawnSync(candidate, ['--version'], { encoding: 'utf-8' });
    if (probe.status === 0) return candidate;
  }
  return null;
}

/** 把 Windows 路径转成 POSIX shell 认得的正斜杠形式。 */
function posixPath(path: string): string {
  return path.replace(/\\/g, '/');
}

/**
 * 把 `dist/hook/` 整个目录复制到仓库里。
 *
 * 只复制 `index.js` **不够** —— 它 import 了同目录的其它模块
 * （`protected.js` / `managed-spec.js` …）。缺了依赖，hook 进程启动即崩，
 * 而 hook 脚本把 stderr 丢进 /dev/null（`2>/dev/null`）——
 * 判定结果为空，脚本看不到 DENIED，于是**静默放行**。
 *
 * 这不是假设：写这条测试时它就真的发生了 —— 第一次跑「agent 提交必须被拦」
 * 得到的是「放行」，根因就是依赖没复制全。
 *
 * **一个静默失败的守卫比没有守卫更糟**：它让人以为门禁在。
 */
function copyHookModuleTree(repo: string): void {
  const srcDir = HOOK_MODULE_DIR;
  const dstDir = join(repo, 'dist', 'hook');
  mkdirSync(dstDir, { recursive: true });
  for (const entry of readdirSync(srcDir)) {
    if (!entry.endsWith('.js')) continue;
    copyFileSync(join(srcDir, entry), join(dstDir, entry));
  }
}

function git(cwd: string, ...args: string[]): void {
  const result = spawnSync('git', args, { cwd, encoding: 'utf-8' });
  if (result.status !== 0) {
    throw new Error(`git ${args.join(' ')} failed: ${result.stderr}`);
  }
}

describe('hookScript', () => {
  it('turns off git path quoting so non-ASCII paths stay readable', () => {
    const script = hookScript('pre-commit', 'git diff --cached --quiet --exit-code');
    assert.ok(
      script.includes('core.quotePath=false'),
      'the script must disable git path quoting, otherwise CJK filenames are octal-escaped',
    );
  });

  it('uses the same quoting for the pre-push file list', () => {
    const script = hookScript('pre-push', 'git diff --quiet HEAD~1..');
    const listLines = script.split('\n').filter((line) => line.includes('diff --name-only'));
    assert.ok(listLines.length > 0, 'the script should list changed files');
    for (const line of listLines) {
      assert.ok(
        line.includes('core.quotePath=false'),
        `file listing must disable quoting: ${line}`,
      );
    }
  });

  // ─── D-24：区分「agent 提交」与「人提交」──────────────────────────────────
  //
  // 保护域拦的是 agent（agent 不许改策略）。但人必须能改策略 ——
  // C5 的配套流程是「人改 policy.yaml → zelto policy lock --update 重新锚定」。
  // 原来不区分谁在提交，人的提交也被拦，只能 --no-verify 绕过。

  it('script detects the submitter from the environment', () => {
    const script = hookScript('pre-commit', 'git diff --cached --quiet --exit-code');
    assert.ok(
      script.includes('ZELTO_SLICE_ID'),
      'the script must look at the agent marker env vars',
    );
    assert.ok(
      script.includes('git-human') && script.includes('git-agent'),
      'the script must pass a harness that distinguishes human from agent',
    );
  });

  it('script does not hard-code the harness to a single value', () => {
    const script = hookScript('pre-commit', 'git diff --cached --quiet --exit-code');
    // 原来写死 "harness":"git" —— 区分不出谁在提交
    assert.ok(
      !script.includes('"harness":"git"'),
      'the harness must not be hard-coded to "git"',
    );
  });

  // ─── ADR-119：default deny vs 判定没跑成 ────────────────────────────────
  it('default deny 只告警放行，但「判定没跑成」必须拦截（C9 fail closed）', () => {
    const script = hookScript('pre-commit', 'git diff --cached --quiet --exit-code');
    // 显式 deny 排除 default —— 保持原口径
    assert.ok(script.includes('"$RULE" = "default"'), 'default deny 不应拦截');
    // 没有 matched_rule（判进程坏了）不能落进「放行」分支
    assert.ok(script.includes('"$RULE" = "null"'), 'matched_rule 为 null 时必须拦截');
    assert.ok(script.includes('no verdict'), '无判定结论时要有明确报错');
    // 二进制缺失不能再静默放行
    const missingBinaryBlock = script.slice(script.indexOf('Binary not found'));
    assert.ok(
      missingBinaryBlock.slice(0, 200).includes('exit 1'),
      'hook 二进制缺失时必须 exit 1，不能静默放行',
    );
  });
});

describe('installed git hook on a non-ASCII path', { concurrency: false }, () => {
  let repo: string;
  const shell = findShell();

  before(() => {
    repo = mkdtempSync(join(tmpdir(), 'zelto-hook-script-'));
    git(repo, 'init', '-b', 'main');
    git(repo, 'config', 'user.email', 'test@example.com');
    git(repo, 'config', 'user.name', 'Test');

    mkdirSync(join(repo, 'policy'), { recursive: true });
    writeFileSync(
      join(repo, 'policy', 'policy.yaml'),
      [
        'rules:',
        '  - id: allow-docs',
        '    match: { path: "docs/**", operation: "write" }',
        '    action: allow',
        '    basis: "policy.yaml#allow-docs"',
        '',
      ].join('\n'),
      'utf-8',
    );

    // hook 二进制放在仓库的 dist/hook/ 下 —— 脚本按 git 仓库根找它
    mkdirSync(join(repo, 'dist', 'hook'), { recursive: true });
    copyHookModuleTree(repo);
    writeFileSync(join(repo, 'package.json'), '{"type":"module"}\n', 'utf-8');

    const hooksDir = join(repo, '.git', 'hooks');
    mkdirSync(hooksDir, { recursive: true });
    writeFileSync(
      join(hooksDir, 'pre-commit'),
      // 显式钉死 node 路径：hook 脚本经 POSIX shell 找 `node` 时，PATH 里可能
      // 只有无扩展名的坏 stub（本机实测 PATH 里 `node` 指向 281 字节的文本文件），
      // shell 会选中它，hook 二进制起不来 → 2>/dev/null 吞掉 → 静默放行。
      // 用 process.execPath（正在跑测试的那个 node）钉死，不依赖 PATH。
      hookScript('pre-commit', 'git diff --cached --quiet --exit-code', { nodePath: process.execPath }),
      'utf-8',
    );

    mkdirSync(join(repo, 'docs'), { recursive: true });
    writeFileSync(join(repo, 'docs', '技术架构.md'), '# 技术架构\n', 'utf-8');
    // 只暂存这一个文件 —— 判定看的是暂存区里的改动，
    // 其余文件（hook 二进制、策略文件）留在工作区外，不该被算进来。
    git(repo, 'add', '--', 'docs/技术架构.md');
  });

  after(() => {
    rmSync(repo, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  it('allows a commit touching a CJK-named file', (t) => {
    if (!shell) {
      t.skip('no POSIX shell available to run the hook script');
      return;
    }

    const result = spawnSync(shell, [posixPath(join(repo, '.git', 'hooks', 'pre-commit'))], {
      cwd: repo,
      encoding: 'utf-8',
      // 父进程（测试运行器 / agent）可能带着 agent 标记；不清掉的话
      // 脚本会把「人改策略」误判成 agent 提交而拦下 —— 测的就不是本组要看的事了。
      env: { ...process.env, ZELTO_SLICE_ID: '', ZELTO_SESSION_ID: '', ZELTO_AGENT_SESSION_ID: '' },
    });

    assert.notEqual(
      result.stdout.includes('DENIED'),
      true,
      `the hook must not deny a CJK path: ${result.stdout}\n${result.stderr}`,
    );
    assert.equal(result.status, 0, `the hook must exit 0: ${result.stdout}\n${result.stderr}`);
  });
});

// ─── D-24：保护域对「人」放行、对「agent」拦截 ─────────────────────────────
//
// 端到端验证：真的装上 hook 脚本，真的提交保护域文件，两种发起方两种结果。
// 只测字符串拼接测不出「脚本传下去的 harness 对不对」。

describe('installed git hook on a protected path', { concurrency: false }, () => {
  let repo: string;
  const shell = findShell();

  before(() => {
    repo = mkdtempSync(join(tmpdir(), 'zelto-hook-protected-'));
    git(repo, 'init', '-b', 'main');
    git(repo, 'config', 'user.email', 'test@example.com');
    git(repo, 'config', 'user.name', 'Test');

    mkdirSync(join(repo, 'policy'), { recursive: true });
    writeFileSync(
      join(repo, 'policy', 'policy.yaml'),
      [
        'rules:',
        '  - id: allow-policy',
        '    match: { path: "policy/**", operation: "write" }',
        '    action: allow',
        '    basis: "policy.yaml#allow-policy"',
        '',
      ].join('\n'),
      'utf-8',
    );

    mkdirSync(join(repo, 'dist', 'hook'), { recursive: true });
    copyHookModuleTree(repo);
    writeFileSync(join(repo, 'package.json'), '{"type":"module"}\n', 'utf-8');

    const hooksDir = join(repo, '.git', 'hooks');
    mkdirSync(hooksDir, { recursive: true });
    writeFileSync(
      join(hooksDir, 'pre-commit'),
      // 与上一组 describe 同理：钉死 node 路径，避免 shell 选中 PATH 里的坏 stub
      hookScript('pre-commit', 'git diff --cached --quiet --exit-code', { nodePath: process.execPath }),
      'utf-8',
  );

    // 改一个保护域文件并暂存
    writeFileSync(join(repo, 'policy', 'policy.yaml'), 'rules: []\n', 'utf-8');
    git(repo, 'add', '--', 'policy/policy.yaml');
  });
  after(() => {
    rmSync(repo, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });
  function runHook(env: Record<string, string> = {}): { status: number | null; stdout: string } {
    const result = spawnSync(shell!, [posixPath(join(repo, '.git', 'hooks', 'pre-commit'))], {
      cwd: repo,
      encoding: 'utf-8',
      env: { ...process.env, ...env },
    });
    return { status: result.status, stdout: result.stdout };
  }

  it('agent 提交保护域 → 拦截', (t) => {
    if (!shell) {
      t.skip('no POSIX shell available to run the hook script');
      return;
    }

    // 带上 agent 标记 → 脚本判成 git-agent
    const result = runHook({ ZELTO_SLICE_ID: 'v1-test' });
    assert.equal(
      result.status,
      1,
      `agent 提交保护域必须被拦：\n${result.stdout}`,
    );
    assert.ok(
      result.stdout.includes('DENIED'),
      `应当报 DENIED：\n${result.stdout}`,
    );
  });

  it('人提交保护域 → 放行', (t) => {
    if (!shell) {
      t.skip('no POSIX shell available to run the hook script');
      return;
    }

    // 不带 agent 标记 → 脚本判成 git-human
    const result = runHook({
      ZELTO_SLICE_ID: '',
      ZELTO_SESSION_ID: '',
      ZELTO_AGENT_SESSION_ID: '',
    });
    assert.equal(
      result.status,
      0,
      `人提交保护域必须放行（否则 C5 的配套流程走不通）：\n${result.stdout}`,
    );
  });
});
