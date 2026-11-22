// ADR-095 · worktree 的「构建前置产物」（回归测试）
//
// 病灶（实测 nimrtc-v14 v3-n4-d6-connectivity，2026-11-22）：
//   agent 跑完 101 分钟，门禁②红了 —— 而**跟 agent 写的代码无关**：
//
//     ❌ build (exit 1)
//        Error copying file (if different) from ".../wolfssl/src/certs/ecc-key.pem"
//     ❌ test (exit 8)
//
//   两条独立的成因：
//     ① 子模块钉死的 commit 在本地**不存在** → `git checkout --force <pin>`
//        静默失败 → worktree 的 vendor 目录是**空的**；
//     ② **生成的产物**（在 `.gitignore` 里）不跟过去 →
//        `ecc-key.pem` 是 `scripts/build_dtls_cert.py` 产的，
//        git 只带被跟踪的内容，主仓那份是**未跟踪的残留**。
//
// 修法（ADR-095）：
//     ① `alignSubmodulesToMainRepo` 里用 `git cat-file -e` 校验 commit 在本地
//        对象库里；不存在 → **明确报错**（带可执行的修法），不再静默。
//     ② 新增 `worktree.prepare` 配置节 —— 建 worktree 时跑前置命令，
//        让产物**重新生成**（不是拷贝旧的）。
//
// 覆盖点：
//   1. 本地缺钉死的 commit → 抛错，且信息里带**修法**（不是只说「失败了」）
//   2. commit 在本地存在 → 正常对齐，不抛错
//   3. `worktree.prepare` 的命令**在 worktree 目录里**跑（cwd 正确）
//   4. 准备命令失败 → 抛错，且**不放行**（agent 不开跑）
//   5. fail fast：前一条失败就不跑后一条
//   6. 准备命令有**超时**（挂死的命令不能无限等）
//   7. 产物**重新生成**而不是拷贝 —— 脚本自己能证明这点
//   8. 配置解析：`worktree.prepare.commands` 能被读出来（含 timeoutSec）
//   9. 没配 `worktree.prepare` → 不跑任何命令（不产生行为变化）

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';

import {
  WorktreeManager,
  missingSubmoduleCommitMessage,
} from '../src/core/worktree/manager.js';
import { parseConfigYaml } from '../src/core/config/loader.js';

/** 造一个带初始提交的临时仓库。 */
function makeRepo(): string {
  const root = mkdtempSync(join(tmpdir(), 'zelto-adr095-'));
  const git = (...args: string[]): string =>
    execFileSync('git', args, { cwd: root, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] });
  git('init', '-b', 'main');
  git('config', 'user.email', 'adr095@example.com');
  git('config', 'user.name', 'adr095');
  writeFileSync(join(root, 'README.md'), '# adr095\n');
  git('add', '.');
  git('commit', '-m', 'init');
  return root;
}

describe('ADR-095 · 子模块钉死的 commit 校验', () => {
  let repo: string;

  beforeEach(() => {
    repo = makeRepo();
  });

  afterEach(() => {
    // 清理可能被**被杀掉的进程**占着目录（Windows 的 cwd lock，ZD-017）。
    // 那个进程是被 timeout 杀的，句柄要过一会儿才释放 —— 退避重试。
    rmWithRetry(repo);
  });

  it('错误信息带**可执行的修法**（不是只说「失败了」）', () => {
    const msg = missingSubmoduleCommitMessage(
      'src/third_party/googletest/src',
      '1546095900000000000000000000000000000000',
      repo,
    );

    // 必须有三种修法 —— 三种成因的修法完全不同。
    assert.match(msg, /fetch origin/, '要给出「从远程 fetch」的修法');
    assert.match(msg, /fetch <那个副本的路径>/, '要给出「从别的本地副本 fetch」的修法');
    assert.match(msg, /submodule update --init/, '要给出「主仓 index 记错了」的修法');

    // 必须说清楚「为什么在这里停下」—— 否则人不知道该不该管。
    assert.match(msg, /vendor/, '要说清后果（vendor 目录会是空的）');
  });

  it('`cat-file -e` 判据：本地有 commit → 不抛错；没有 → 抛错', () => {
    const manager = new WorktreeManager(repo);

    // 本地**有**这个 commit（就是 HEAD）。
    const head = execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: repo,
      encoding: 'utf-8',
    }).trim();
    const available = (
      manager as unknown as {
        commitAvailable(subPath: string, sha: string): boolean;
      }
    ).commitAvailable.bind(manager);
    assert.equal(available(repo, head), true, 'HEAD 本地一定有');

    // 本地**没有**这个 commit。
    assert.equal(
      available(repo, '1546095900000000000000000000000000000000'),
      false,
      '不存在的 commit 必须判为不可用',
    );
  });
});

describe('ADR-095 · 生成物清单（worktree.prepare）', () => {
  let repo: string;
  let manager: WorktreeManager;

  beforeEach(() => {
    repo = makeRepo();
    manager = new WorktreeManager(repo);
  });

  afterEach(() => {
    rmWithRetry(repo);
  });

  it('命令在 **worktree 目录**里跑（cwd 正确）', () => {
    const wt = join(repo, '.zelto', 'worktrees', 's1');
    mkdirSync(wt, { recursive: true });

    manager.prepareArtifacts(wt, [
      { run: 'node -e "require(\'fs\').writeFileSync(\'cwd.txt\', process.cwd())"' },
    ]);

    const written = readFileSync(join(wt, 'cwd.txt'), 'utf-8');
    assert.equal(
      pathNormalize(written),
      pathNormalize(wt),
      '准备命令必须在 worktree 目录里跑',
    );
  });

  it('产物是**重新生成**的，不是从主仓拷来的', () => {
    const wt = join(repo, '.zelto', 'worktrees', 's1');
    mkdirSync(wt, { recursive: true });

    // 主仓里有一份「旧的」产物。
    writeFileSync(join(repo, 'generated.txt'), 'OLD');

    manager.prepareArtifacts(wt, [
      { run: 'node -e "require(\'fs\').writeFileSync(\'generated.txt\', \'FRESH\')"' },
    ]);

    assert.equal(
      readFileSync(join(wt, 'generated.txt'), 'utf-8'),
      'FRESH',
      'worktree 里的产物应该是脚本重新生成的，不是主仓那份',
    );
    assert.equal(
      readFileSync(join(repo, 'generated.txt'), 'utf-8'),
      'OLD',
      '主仓那份不该被动',
    );
  });

  it('失败 → 抛错，且**不放行**（agent 不开跑）', () => {
    const wt = join(repo, '.zelto', 'worktrees', 's1');
    mkdirSync(wt, { recursive: true });

    assert.throws(
      () =>
        manager.prepareArtifacts(wt, [
          { run: 'node -e "process.exit(3)"' },
        ]),
      (err: unknown) => {
        const msg = err instanceof Error ? err.message : String(err);
        // 必须说清「agent 没有开跑」—— 否则人会去查 agent 的代码。
        assert.match(msg, /准备阶段失败/);
        assert.match(msg, /没有.*开跑|不开跑/);
        // 必须带命令原文 —— 否则人不知道是哪条命令。
        assert.match(msg, /process\.exit\(3\)/);
        return true;
      },
    );
  });

  it('fail fast：前一条失败就不跑后一条', () => {
    const wt = join(repo, '.zelto', 'worktrees', 's1');
    mkdirSync(wt, { recursive: true });

    assert.throws(() =>
      manager.prepareArtifacts(wt, [
        { run: 'node -e "process.exit(1)"' },
        { run: 'node -e "require(\'fs\').writeFileSync(\'second.txt\', \'x\')"' },
      ]),
    );

    assert.equal(
      existsSync(join(wt, 'second.txt')),
      false,
      '第一条失败后，第二条不该跑 —— 跑了也只会浪费，且报错会指错地方',
    );
  });

  it('命令有**超时**（挂死的命令不能无限等）', () => {
    const wt = join(repo, '.zelto', 'worktrees', 's1');
    mkdirSync(wt, { recursive: true });

    const started = Date.now();
    // 一条会睡很久的命令；timeoutSec 给 1 秒。
    assert.throws(() =>
      manager.prepareArtifacts(wt, [
        { run: 'node -e "setTimeout(()=>{}, 60000)"', timeoutSec: 1 },
      ]),
    );

    const elapsed = Date.now() - started;
    assert.ok(elapsed < 30_000, `挂死的命令应该在超时内被杀（实际 ${elapsed}ms）`);
  });

  it('没配清单 → 不跑任何命令（不产生行为变化）', () => {
    const wt = join(repo, '.zelto', 'worktrees', 's1');
    mkdirSync(wt, { recursive: true });

    const result = manager.prepareArtifacts(wt, []);
    assert.deepEqual(result.ran, [], '空清单 = 什么都没跑');
  });
  it('顺序执行（结果里的顺序 = 配置顺序）', () => {
    const wt = join(repo, '.zelto', 'worktrees', 's1');
    mkdirSync(wt, { recursive: true });

    const result = manager.prepareArtifacts(wt, [
      { run: 'node -e "require(\'fs\').writeFileSync(\'a.txt\',\'a\')"' },
      { run: 'node -e "require(\'fs\').writeFileSync(\'b.txt\',\'b\')"' },
    ]);

    assert.equal(result.ran.length, 2);
    assert.ok(existsSync(join(wt, 'a.txt')));
    assert.ok(existsSync(join(wt, 'b.txt')));
  });
});

describe('ADR-095 · 配置解析（worktree.prepare）', () => {
  it('能读出 commands 与 timeoutSec', () => {
    const parsed = parseConfigYaml(`
gate:
  commands:
    - name: test
      run: npm test
  timeoutSec: 120
  retry:
    max: 2
agent:
  command: "npx claude-code"
worktree:
  prepare:
    commands:
      - run: python scripts/build_dtls_cert.py
        timeoutSec: 60
      - run: npm run codegen
`);

    assert.ok(parsed, '配置应该能解析出来');
    const commands = prepareCommandsOf(parsed);
    assert.equal(commands.length, 2);
    assert.equal(commands[0].run, 'python scripts/build_dtls_cert.py');
    assert.equal(commands[0].timeoutSec, 60);
    assert.equal(commands[1].run, 'npm run codegen');
    // 没写 timeoutSec → 不给这个字段（用默认值）
    assert.equal(commands[1].timeoutSec, undefined);
  });

  it('没配 worktree 段 → 没有这一节（不产生行为变化）', () => {
    const parsed = parseConfigYaml(`
gate:
  commands:
    - name: test
      run: npm test
  timeoutSec: 120
  retry:
    max: 2
agent:
  command: "npx claude-code"
`);

    assert.ok(parsed);
    assert.equal(parsed.worktree, undefined, '没配就不该有 worktree 节');
  });

  it('`worktree.prepare` 里的 run 不会被 gate 的命令解析吃掉', () => {
    // 回归点：worktree 段是**平级**的顶层节，
    // 它的 `run:` 不能被当成 gate 的门禁命令读走。
    const parsed = parseConfigYaml(`
gate:
  commands:
    - name: test
      run: npm test
  timeoutSec: 120
  retry:
    max: 2
agent:
  command: "npx claude-code"
worktree:
  prepare:
    commands:
      - run: python scripts/gen.py
`);

    assert.ok(parsed);
    // gate 段仍然只有 1 条命令
    assert.equal(parsed.gate.commands.length, 1);
    assert.equal(parsed.gate.commands[0].run, 'npm test');
    // prepare 段有自己的命令
    const commands = prepareCommandsOf(parsed);
    assert.equal(commands.length, 1);
    assert.equal(commands[0].run, 'python scripts/gen.py');
  });

  it('`run:` 为空的条目被跳过（不拿空命令去跑）', () => {
    const parsed = parseConfigYaml(`
gate:
  commands:
    - name: test
      run: npm test
  timeoutSec: 120
  retry:
    max: 2
agent:
  command: "npx claude-code"
worktree:
  prepare:
    commands:
      - run: ""
      - run: python scripts/gen.py
`);

    assert.ok(parsed);
    const commands = prepareCommandsOf(parsed);
    assert.equal(commands.length, 1);
    assert.equal(commands[0].run, 'python scripts/gen.py');
  });
});

/**
 * 删掉一个可能被占用的目录，退避重试。
 *
 * 为什么需要：Windows 上「被杀的子进程」会短暂持有它的工作目录句柄
 * （cwd lock，ZD-017），立刻 `rmSync` 会报 `EPERM`。
 * 那个进程是超时杀掉的，句柄过一会儿就释放 —— 退避重试即可。
 *
 * 实在删不掉就**放着** —— 临时目录，不删也不会有人管。
 * 让测试因为「清理失败」而红，比因为「被测行为不对」而红更糟。
 */
function rmWithRetry(dir: string): void {
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      rmSync(dir, { recursive: true, force: true });
      return;
    } catch {
      // 被占着 → 等一会儿再试。
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 200);
    }
  }
}

/** Windows 上路径大小写/分隔符可能有差异，比对前先归一化。 */
function pathNormalize(p: string): string {
  return p.replace(/\\/g, '/').replace(/\/$/, '').toLowerCase();
}

/**
 * 取出 prepare 清单 —— 断言它存在。
 *
 * 用断言函数而不是 `!` 非空断言：后者只是骗过类型检查，
 * 真出问题时错误信息会指向 `undefined.commands`（没用），
 * 而这里能直接说「清单没解析出来」。
 */
function prepareCommandsOf(
  parsed: ReturnType<typeof parseConfigYaml>,
): Array<{ run: string; timeoutSec?: number }> {
  assert.ok(parsed, '配置应该能解析出来');
  assert.ok(parsed.worktree, '应该有 worktree 节');
  assert.ok(parsed.worktree.prepare, '应该有 worktree.prepare 节');
  return parsed.worktree.prepare.commands;
}
