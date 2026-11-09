// 发布产物可用性 —— 打包出来的东西得真的能用。
//
// 白名单（package.json 的 files）只回答「哪些文件进包」，不回答「进包的
// 这些文件凑在一起能不能跑」。这两件事之间有一道缝：白名单少一个文件，
// npm pack 照样成功，只是装出来的包在某个命令上炸掉。
//
// 这组用例守的是缝的另一头 —— 装出来的包要能在**没有源仓库**的干净目录里
// 跑起来。踩过的坑：
//
//   - bin/zelto.sh 写的是 "$(dirname "$0")/dist/cli/index.js"，而 dist/ 与
//     bin/ 平级，脚本从落地那天起就找不到入口。
//   - files 里带着 policy/，发的是 zelto 自己的写集规则；用户项目里的
//     policy.yaml 是 `zelto init` 按项目探测生成的，读不到包内这份。
//
// 用例跑的是真实的 npm pack + 真实的安装，慢一些，但这正是「装出来能不能用」
// 唯一可靠的验法 —— 只检查白名单里的字符串是验不出来的。

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const REPO_ROOT = process.cwd();
const PACKAGE_NAME = 'zelto';

interface PackEntry {
  path: string;
}

let packRoot: string;
let tarball: string;
let installed: string;

/** 在指定目录里跑已安装包的 CLI，返回 stdout 与退出码 */
function runCli(cwd: string, args: string[]): { stdout: string; code: number } {
  try {
    const stdout = execFileSync(
      process.execPath,
      [join(installed, 'node_modules', PACKAGE_NAME, 'dist', 'cli', 'index.js'), ...args],
      { cwd, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 60_000 },
    );
    return { stdout, code: 0 };
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string; status?: number };
    return { stdout: `${e.stdout ?? ''}${e.stderr ?? ''}`, code: e.status ?? 1 };
  }
}

before(() => {
  packRoot = mkdtempSync(join(tmpdir(), 'zelto-pack-'));

  // npm pack --json 给出产物清单与生成的 tarball 路径
  const out = execFileSync('npm', ['pack', '--json', '--pack-destination', packRoot], {
    cwd: REPO_ROOT,
    encoding: 'utf-8',
    stdio: ['ignore', 'pipe', 'pipe'],
    shell: process.platform === 'win32',
    timeout: 180_000,
  });
  const parsed = JSON.parse(out) as Array<{ filename: string; files: PackEntry[] }>;
  tarball = join(packRoot, parsed[0].filename);

  // 装到临时目录里 —— 用 npm install 本地 tarball，模拟用户拿到的样子
  installed = mkdtempSync(join(tmpdir(), 'zelto-install-'));
  writeFileSync(join(installed, 'package.json'), JSON.stringify({ name: 'pack-test', version: '1.0.0' }));
  execFileSync('npm', ['install', tarball, '--no-audit', '--no-fund'], {
    cwd: installed,
    encoding: 'utf-8',
    stdio: ['ignore', 'pipe', 'pipe'],
    shell: process.platform === 'win32',
    timeout: 300_000,
  });
});

after(() => {
  rmSync(packRoot, { recursive: true, force: true });
  rmSync(installed, { recursive: true, force: true });
});

describe('发布产物装出来能用', () => {
  it('npm pack 产出的包里有 bin 指向的两个入口', () => {
    const out = execFileSync('npm', ['pack', '--dry-run', '--json'], {
      cwd: REPO_ROOT,
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
      shell: process.platform === 'win32',
      timeout: 180_000,
    });
    const parsed = JSON.parse(out) as Array<{ files: PackEntry[] }>;
    const paths = parsed[0].files.map((f) => f.path);
    assert.ok(paths.includes('dist/cli/index.js'), 'CLI 入口没进包');
    assert.ok(paths.includes('dist/hook/index.js'), 'hook 入口没进包');
  });

  it('包里有 contracts/ —— 契约校验从包内读 schema', () => {
    const schema = join(installed, 'node_modules', PACKAGE_NAME, 'contracts', 'schemas', 'slice-v2.json');
    assert.ok(existsSync(schema), `契约 schema 不在包里：${schema}`);
  });

  it('包里的 policy/ 不外发 —— 用户项目的策略是 init 按项目生成的', () => {
    const out = execFileSync('npm', ['pack', '--dry-run', '--json'], {
      cwd: REPO_ROOT,
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
      shell: process.platform === 'win32',
      timeout: 180_000,
    });
    const parsed = JSON.parse(out) as Array<{ files: PackEntry[] }>;
    const paths = parsed[0].files.map((f) => f.path);
    const leaked = paths.filter((p) => p.startsWith('policy/'));
    assert.deepEqual(leaked, [], `发布包里混进了 zelto 自己的策略：${leaked.join(', ')}`);
  });

  it('装出来的 CLI 跑得起来', () => {
    const { stdout, code } = runCli(installed, ['--version']);
    assert.equal(code, 0, `CLI 起不来：${stdout}`);
    assert.match(stdout, /zelto v/);
  });

  it('装出来的 CLI 能在干净目录里 init 出可用的项目', () => {
    const project = mkdtempSync(join(tmpdir(), 'zelto-proj-'));
    try {
      const { stdout, code } = runCli(project, ['init']);
      assert.equal(code, 0, `init 失败：${stdout}`);

      // init 出来的策略必须带锚点 —— 没有锚点，「策略被改过」就检不出来（C5）
      const lockPath = join(project, 'policy', 'lock.json');
      assert.ok(existsSync(lockPath), `init 没写出策略锚点：${lockPath}`);
      const lock = JSON.parse(readFileSync(lockPath, 'utf-8')) as { policy?: string };
      assert.match(String(lock.policy ?? ''), /^sha256:[0-9a-f]{64}$/);

      // 锚点与当前策略一致
      const { stdout: lockOut, code: lockCode } = runCli(project, ['policy', 'lock']);
      assert.equal(lockCode, 0, `锚点自检失败：${lockOut}`);
    } finally {
      rmSync(project, { recursive: true, force: true });
    }
  });

  it('bin/zelto.sh 找得到入口 —— 脚本与 dist/ 平级，要往上退一级', () => {
    const script = join(installed, 'node_modules', PACKAGE_NAME, 'bin', 'zelto.sh');
    assert.ok(existsSync(script), `包装脚本不在包里：${script}`);
    const content = readFileSync(script, 'utf-8');
    // 实际执行的那行必须往上一级找 dist/。dist/ 与 bin/ 平级，
    // 直接拼 bin/dist 是找不到入口的（脚本从落地那天起就坏着）。
    const execLine = content
      .split('\n')
      .find((line) => line.trim().startsWith('node '));
    assert.ok(execLine, 'zelto.sh 里没有执行 node 的那行');
    assert.match(execLine, /\.\.\/dist\/cli\/index\.js/);
    assert.ok(
      !/\/dist\/cli\/index\.js/.test(execLine.replace(/\.\.\/dist\/cli\/index\.js/, '')),
      `zelto.sh 的执行行拼的是 bin/dist，找不到入口：${execLine}`,
    );
  });

  it('README 说的安装方式与 package.json 一致', () => {
    const pkg = JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf-8')) as {
      private?: boolean;
      version: string;
    };
    const readme = readFileSync(join(REPO_ROOT, 'README.md'), 'utf-8');
    // private 为 true 时 README 必须说「还没发布」，不能反过来
    if (pkg.private) {
      assert.match(readme, /Not published to npm yet/);
    }
    assert.match(readme, new RegExp(`v${pkg.version.replace(/\./g, '\\.')}`));
  });
});
