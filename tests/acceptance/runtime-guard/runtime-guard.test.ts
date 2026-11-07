// Acceptance test: runtime-guard (ADR-014)
//
// 验收的是硬约束 C9：**写集预约必须在运行时被 hook 真的执行**，不是纸面承诺。
// 跑的是真实 CLI 进程（dist/cli/index.js），agent 用一个假 agent 顶替：
// 假 agent 读 worktree 里的 .claude/settings.local.json，把 zelto 装的那条
// PreToolUse 钩子真跑一遍。
//
// 覆盖四件事：
//   1. hook 放行写集内的写入、拦下写集外的写入
//   2. hook 拦不住的写（绕过 hook 直接写文件）由运行后审计兜住
//   3. zelto 自己写进 worktree 的文件（规格副本、钩子设置）不算 agent 越界
//   4. 判定与审计结论都落成 append-only 事件，预约用完就释放

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const BASE_DIR = join(tmpdir(), `zelto-acceptance-runtime-guard-${Date.now()}`);
const CLI_SCRIPT = join(process.cwd(), 'dist', 'cli', 'index.js');
const FAKE_AGENT = join(BASE_DIR, 'fake-agent.cjs');
const RESULT_FILE = join(BASE_DIR, 'hook-results.json');
const SLICE_ID = 'guard-test';

// agent 命令通过 --agent 命令行参数传入（不走 YAML 解析：stripSurroundingQuotes
// 只剥双引号，单引号包裹会原样留在命令里）。路径含空格时用双引号包裹，
// cmd.exe 与 POSIX shell 都能正确解析。
const AGENT_PATH = FAKE_AGENT.replace(/\\/g, '/');
const AGENT_COMMAND = /\s/.test(AGENT_PATH) ? `node "${AGENT_PATH}"` : `node ${AGENT_PATH}`;

function git(...args: string[]): void {
  const res = spawnSync('git', args, { cwd: BASE_DIR, encoding: 'utf-8' });
  if (res.status !== 0) {
    throw new Error(`git ${args.join(' ')} failed: ${res.stderr}`);
  }
}

function zelto(...args: string[]): Promise<{ stdout: string; stderr: string; code: number }> {
  return new Promise((resolve, reject) => {
    const child = spawn('node', [CLI_SCRIPT, ...args], {
      cwd: BASE_DIR,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, ZELTO_TEST_OUT: RESULT_FILE },
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString(); });
    child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });
    child.on('close', (code) => resolve({ stdout, stderr, code: code ?? 1 }));
    child.on('error', reject);
  });
}

function readEvents(sliceId: string): Array<Record<string, unknown>> {
  const file = join(BASE_DIR, '.zelto', 'events', sliceId, 'events.jsonl');
  if (!existsSync(file)) return [];
  return readFileSync(file, 'utf-8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

/** 假 agent：把 zelto 装的那条 PreToolUse 钩子真跑一遍，记录判定结果。 */
const FAKE_AGENT_SOURCE = `
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const cwd = process.cwd();

// 把 hook 命令行拆成 argv（双引号包裹的路径里可能有空格）
function parseCommand(cmd) {
  const tokens = [];
  let cur = '';
  let quoted = false;
  for (const ch of cmd) {
    if (ch === '"') { quoted = !quoted; continue; }
    if (!quoted && /\\s/.test(ch)) { if (cur) { tokens.push(cur); cur = ''; } continue; }
    cur += ch;
  }
  if (cur) tokens.push(cur);
  return tokens;
}

const settingsPath = path.join(cwd, '.claude', 'settings.local.json');
const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf-8'));
const entries = settings.hooks && settings.hooks.PreToolUse ? settings.hooks.PreToolUse : [];
const entry = entries.find((e) => e.hooks && e.hooks.some((h) => String(h.command).includes('--zelto-pretool')));
if (!entry) {
  fs.writeFileSync(process.env.ZELTO_TEST_OUT, JSON.stringify({ error: 'zelto hook not installed' }));
  process.exit(3);
}
const command = entry.hooks.find((h) => String(h.command).includes('--zelto-pretool')).command;
const argv = parseCommand(command);

function callHook(payload) {
  const res = spawnSync(argv[0], argv.slice(1), {
    input: JSON.stringify(payload),
    encoding: 'utf-8',
    cwd,
  });
  if (res.status !== 0) return { error: res.stderr || 'hook exited non-zero', status: res.status };
  try {
    return JSON.parse(res.stdout);
  } catch (err) {
    return { error: 'unparsable hook output: ' + res.stdout, stderr: String(err) };
  }
}

const results = {};

// 1. 写集内的写入 —— 应当放行
results.inside = callHook({
  tool_name: 'Write',
  tool_input: { file_path: path.join(cwd, 'src', 'core', 'ok.ts') },
});

// 2. 写集外的写入 —— 应当拦下
results.outside = callHook({
  tool_name: 'Write',
  tool_input: { file_path: path.join(cwd, 'src', 'policy', 'bad.ts') },
});

// 3. 真正落盘：写集内的文件（正常产出）
fs.mkdirSync(path.join(cwd, 'src', 'core'), { recursive: true });
fs.writeFileSync(path.join(cwd, 'src', 'core', 'ok.ts'), 'export const ok = 1;\\n');

// 4. 绕过 hook 直接写写集外的文件 —— 静态分析拦不住，靠运行后审计兜底
fs.mkdirSync(path.join(cwd, 'src', 'policy'), { recursive: true });
fs.writeFileSync(path.join(cwd, 'src', 'policy', 'bad.ts'), 'export const bad = 1;\\n');

fs.writeFileSync(process.env.ZELTO_TEST_OUT, JSON.stringify(results, null, 2));
`;

describe('acceptance: runtime-guard', { concurrency: false }, () => {
  before(async () => {
    rmSync(BASE_DIR, { recursive: true, force: true });
    mkdirSync(join(BASE_DIR, 'src', 'core'), { recursive: true });
    mkdirSync(join(BASE_DIR, 'policy'), { recursive: true });
    mkdirSync(join(BASE_DIR, 'specs', 'slices'), { recursive: true });
    mkdirSync(join(BASE_DIR, '.zelto'), { recursive: true });

    git('init', '-b', 'main');
    git('config', 'user.email', 'test@example.com');
    git('config', 'user.name', 'Test');

    writeFileSync(
      join(BASE_DIR, '.gitignore'),
      ['.zelto/', 'node_modules/', 'fake-agent.cjs', 'hook-results.json', ''].join('\n'),
      'utf-8',
    );
    writeFileSync(
      join(BASE_DIR, 'policy', 'policy.yaml'),
      [
        'rules:',
        '  - id: allow-src-ts',
        '    match: { path: "src/**/*.ts", operation: "write" }',
        '    action: allow',
        '    basis: "policy.yaml#allow-src-ts"',
        '',
      ].join('\n'),
      'utf-8',
    );
    writeFileSync(join(BASE_DIR, 'src', 'core', 'seed.ts'), 'export const seed = 0;\n', 'utf-8');
    git('add', '-A');
    git('commit', '-m', 'init');

    // 假 agent 放在仓库里（不进版本库）——它跑在 worktree 里，但不属于切片产出
    writeFileSync(FAKE_AGENT, FAKE_AGENT_SOURCE, 'utf-8');

    writeFileSync(
      join(BASE_DIR, '.zelto', 'config.yaml'),
      [
        'gate:',
        '  commands:',
        '    - { name: test, run: "echo ok" }',
        '  timeoutSec: 30',
        '  retry:',
        '    max: 0',
        'agent:',
        '  command: "echo"',
        '  maxRetries: 0',
        '',
      ].join('\n'),
      'utf-8',
    );

    // 规格故意不提交：worktree 是从 baseCommit 检出的，规格靠 syncContext 复制进去。
    // 这正是「zelto 自己的文件被审计成 agent 越界」最容易发生的场景。
    writeFileSync(
      join(BASE_DIR, 'specs', 'slices', `${SLICE_ID}.md`),
      [
        `# ${SLICE_ID}`,
        '',
        '## 范围',
        '',
        '- `src/core/**`',
        '',
        '## 验收',
        '',
        '- 写集内的写入被放行',
        '',
      ].join('\n'),
      'utf-8',
    );
  });

  after(() => {
    rmSync(BASE_DIR, { recursive: true, force: true });
  });

  it('the runtime guard enforces the write-set at run time', async () => {
    const created = await zelto('create', SLICE_ID, '--title', 'Runtime Guard Test', '--writes', 'src/core/**', '--requirement', 'REQ-1: 运行期写集守卫要拦住越界写入');
    assert.equal(created.code, 0, `create should exit 0: ${created.stderr}`);

    const frozen = await zelto('freeze', SLICE_ID);
    assert.equal(frozen.code, 0, `freeze should exit 0: ${frozen.stderr}`);

    const run = await zelto('run', SLICE_ID, '--agent', AGENT_COMMAND);
    assert.equal(run.code, 1, `run should exit 1 (write-set violation): ${run.stdout}\n${run.stderr}`);

    // 1. hook 的判定：写集内放行、写集外拦下
    assert.ok(existsSync(RESULT_FILE), 'the fake agent should have recorded hook decisions');
    const decisions = JSON.parse(readFileSync(RESULT_FILE, 'utf-8')) as {
      inside?: { hookSpecificOutput?: { permissionDecision?: string } };
      outside?: { hookSpecificOutput?: { permissionDecision?: string } };
      error?: string;
    };
    assert.equal(decisions.error, undefined, `hook should have run: ${decisions.error}`);
    assert.equal(
      decisions.inside?.hookSpecificOutput?.permissionDecision,
      'allow',
      'a write inside the write-set must be allowed',
    );
    assert.equal(
      decisions.outside?.hookSpecificOutput?.permissionDecision,
      'deny',
      'a write outside the write-set must be denied',
    );

    // 2. 绕过 hook 的写由运行后审计兜住
    const violations = readEvents(SLICE_ID).filter((e) => e.type === 'policy.violation');
    assert.equal(violations.length, 1, 'exactly one policy.violation event should be recorded');
    const payload = violations[0].payload as { violations?: string[]; kind?: string };
    assert.equal(payload.kind, 'write-outside-write-set');
    assert.deepEqual(payload.violations, ['src/policy/bad.ts']);

    // 3. zelto 自己写进 worktree 的文件不算 agent 越界
    const changed = (violations[0].payload as { changed?: string[] }).changed ?? [];
    assert.ok(
      changed.includes('specs/slices/guard-test.md'),
      `the spec copy should show up as a change: ${JSON.stringify(changed)}`,
    );
    assert.ok(
      !payload.violations?.includes('specs/slices/guard-test.md'),
      'the spec copy is zelto-owned and must not count as a violation',
    );
    assert.ok(
      !payload.violations?.includes('.claude/settings.local.json'),
      'the hook settings are zelto-owned and must not count as a violation',
    );

    // 4. 预约用完就释放，事件落在主仓库里
    const lock = join(BASE_DIR, '.zelto', 'locks', `${SLICE_ID}.json`);
    assert.ok(existsSync(lock), 'the reservation file should exist');
    const reservation = JSON.parse(readFileSync(lock, 'utf-8')) as { releasedAt: string | null };
    assert.ok(reservation.releasedAt, 'the reservation must be released after the run');

    const types = readEvents(SLICE_ID).map((e) => e.type);
    assert.ok(types.includes('reservation.acquired'), 'acquiring the reservation must be recorded');
    assert.ok(types.includes('reservation.released'), 'releasing the reservation must be recorded');
    assert.ok(types.includes('policy.decision'), 'every hook decision must be recorded');
  });
});
