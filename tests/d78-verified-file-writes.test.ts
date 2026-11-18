// ADR-082：写文件后报告成功的路径必须**可核对**。
//
// 核心判据（D-31 的教训）：
// > 「报告成功」必须能被**独立证据**复核 —— 读回文件比对内容，
// > 而不是「我调用了 writeFileSync 所以成功了」。
//
// 这份测试守两件事：
//   1. **原语层**：`atomicWriteText` 写完读回比对；失败必抛；
//      返回值带可核对的凭据（字节数 / 哈希 / 是否变化）。
//   2. **命令层**：文件没被改动时，命令必须**报错退出码 ≠ 0**，
//      而不是报告成功。
//
// 第 2 条才是实战里真正咬人的那条 —— 单元测试绿了不算，
// 命令报告「✅ 已修改」而文件没动，才是 D-31。

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';

import { atomicWriteText, hashContent, WriteVerificationError } from '../src/core/io/atomic-write.js';

const CLI_SCRIPT = join(process.cwd(), 'dist', 'cli', 'index.js');

let workDir: string;

function runCommand(...args: string[]): Promise<{ stdout: string; stderr: string; code: number }> {
  return new Promise((resolve, reject) => {
    const child = spawn('node', [CLI_SCRIPT, ...args], {
      cwd: workDir,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (c: Buffer) => {
      stdout += c.toString();
    });
    child.stderr.on('data', (c: Buffer) => {
      stderr += c.toString();
    });
    child.on('close', (code) => resolve({ stdout, stderr, code: code ?? 1 }));
    child.on('error', reject);
  });
}

// ─── 原语层 ─────────────────────────────────────────────────────────────────

describe('ADR-082：原子写入原语', () => {
  beforeEach(() => {
    workDir = mkdtempSync(join(tmpdir(), 'zelto-atomic-write-'));
  });

  afterEach(() => {
    rmSync(workDir, { recursive: true, force: true });
  });

  it('写完文件内容就是写进去的内容', async () => {
    const target = join(workDir, 'a.txt');
    const receipt = await atomicWriteText(target, 'hello\n');
    assert.equal(readFileSync(target, 'utf-8'), 'hello\n');
    assert.equal(receipt.bytes, 6);
    assert.ok(receipt.hash.startsWith('sha256:'));
  });

  it('返回可核对的凭据（字节数 + 哈希 + 是否变化）', async () => {
    const target = join(workDir, 'b.txt');
    const first = await atomicWriteText(target, 'x');
    assert.equal(first.changed, true);

    const second = await atomicWriteText(target, 'x');
    assert.equal(second.changed, false, '同样内容再写一次不算变化');
    assert.equal(second.hash, first.hash);
    assert.equal(second.bytes, first.bytes);
  });

  it('父目录不存在时自动创建', async () => {
    const target = join(workDir, 'deep', 'nested', 'c.txt');
    await atomicWriteText(target, 'z');
    assert.equal(readFileSync(target, 'utf-8'), 'z');
  });

  it('不留下临时文件', async () => {
    await atomicWriteText(join(workDir, 'd.txt'), 'q');
    const leftovers = readdirSync(workDir).filter((f) => f.includes('.tmp'));
    assert.deepEqual(leftovers, [], `留下了临时文件：${leftovers.join(', ')}`);
  });

  it('hashContent 的形态与策略锚点一致（sha256:<hex>）', () => {
    const hash = hashContent('abc');
    assert.match(hash, /^sha256:[0-9a-f]{64}$/);
  });

  it('WriteVerificationError 是 Error 的子类（可被上层统一捕获）', () => {
    const err = new WriteVerificationError('/tmp/x', 'detail');
    assert.ok(err instanceof Error);
    assert.equal(err.name, 'WriteVerificationError');
    assert.equal(err.path, '/tmp/x');
  });
});

// ─── 命令层：文件没变时必须报错 ─────────────────────────────────────────────

describe('ADR-082：写状态的命令在「没改动」时必须报错', () => {
  beforeEach(() => {
    workDir = mkdtempSync(join(tmpdir(), 'zelto-no-change-'));
    mkdirSync(join(workDir, 'policy'), { recursive: true });
    mkdirSync(join(workDir, '.zelto'), { recursive: true });
    mkdirSync(join(workDir, '.zelto', 'slices'), { recursive: true });
    mkdirSync(join(workDir, 'specs', 'slices'), { recursive: true });
    writeFileSync(
      join(workDir, 'policy', 'policy.yaml'),
      [
        'rules:',
        '  - id: keep-me',
        '    match: { path: "src/**", operation: "write" }',
        '    action: allow',
        '    basis: "policy.yaml#keep-me"',
        '',
        'arch:',
        '  - kind: cycle',
        '    action: ask',
        '    basis: "ADR-025"',
        '',
      ].join('\n'),
      'utf-8',
    );
    writeFileSync(
      join(workDir, '.zelto', 'config.yaml'),
      ['gate:', '  timeoutSec: 120', '  commands:', '    - name: build', '      run: "make"', ''].join('\n'),
      'utf-8',
    );
  });

  afterEach(() => {
    rmSync(workDir, { recursive: true, force: true });
  });

  it('config set：同样的值再设一次 → 退出码 ≠ 0，且文件没变', async () => {
    const before = readFileSync(join(workDir, '.zelto', 'config.yaml'), 'utf-8');
    const { code, stdout, stderr } = await runCommand('config', 'set', 'gate.timeoutSec', '120');
    const out = stdout + stderr;

    assert.notEqual(code, 0, `内容没变时不该报成功，实际输出：${out}`);
    assert.ok(
      out.includes('nothing') || out.includes('没有') || out.includes('没有变化'),
      `提示应说清「没有任何改动」，实际输出：${out}`,
    );
    assert.equal(readFileSync(join(workDir, '.zelto', 'config.yaml'), 'utf-8'), before, '文件不该被改动');
  });

  it('config set：真正改值 → 退出码 0，且文件确实变了', async () => {
    const { code, stdout, stderr } = await runCommand('config', 'set', 'gate.timeoutSec', '300');
    assert.equal(code, 0, `改值应成功，实际输出：${stdout}${stderr}`);
    const content = readFileSync(join(workDir, '.zelto', 'config.yaml'), 'utf-8');
    assert.ok(content.includes('timeoutSec: 300'), `文件没被改成期望值，实际：${content}`);
  });

  it('policy edit：改成同样的值 → 退出码 ≠ 0，文件没变', async () => {
    const before = readFileSync(join(workDir, 'policy', 'policy.yaml'), 'utf-8');
    const { code, stdout, stderr } = await runCommand('policy', 'edit', 'keep-me', '--action', 'allow');
    const out = stdout + stderr;

    assert.notEqual(code, 0, `内容没变时不该报成功，实际输出：${out}`);
    assert.equal(readFileSync(join(workDir, 'policy', 'policy.yaml'), 'utf-8'), before, '文件不该被改动');
  });

  it('policy edit：真正改值 → 退出码 0，且文件确实变了', async () => {
    const { code, stdout, stderr } = await runCommand('policy', 'edit', 'keep-me', '--action', 'deny');
    assert.equal(code, 0, `改值应成功，实际输出：${stdout}${stderr}`);
    const content = readFileSync(join(workDir, 'policy', 'policy.yaml'), 'utf-8');
    assert.ok(content.includes('action: deny'), `文件没被改成期望值，实际：${content}`);
    // arch: 段仍在（D-30 的老规矩不能破）
    assert.ok(content.includes('kind: cycle'), 'arch: 段被抹掉了');
  });

  it('policy arch edit：改成同样的值 → 退出码 ≠ 0', async () => {
    const before = readFileSync(join(workDir, 'policy', 'policy.yaml'), 'utf-8');
    const { code, stdout, stderr } = await runCommand('policy', 'arch', 'edit', 'cycle', '--action', 'ask');
    const out = stdout + stderr;

    assert.notEqual(code, 0, `内容没变时不该报成功，实际输出：${out}`);
    assert.equal(readFileSync(join(workDir, 'policy', 'policy.yaml'), 'utf-8'), before, '文件不该被改动');
  });

  it('policy remove：不存在的规则 → 退出码 ≠ 0，文件没变', async () => {
    const before = readFileSync(join(workDir, 'policy', 'policy.yaml'), 'utf-8');
    const { code, stdout, stderr } = await runCommand('policy', 'remove', 'no-such-rule');
    const out = stdout + stderr;

    assert.notEqual(code, 0, `规则不存在时不该报成功，实际输出：${out}`);
    assert.equal(readFileSync(join(workDir, 'policy', 'policy.yaml'), 'utf-8'), before, '文件不该被改动');
  });

  it('slice create：规格文件已存在 → 退出码 ≠ 0，文件没变', async () => {
    const specPath = join(workDir, 'specs', 'slices', 's1.md');
    writeFileSync(specPath, '# Slice: s1\n\n## 目的\n原内容\n', 'utf-8');

    const { code, stdout, stderr } = await runCommand('slice', 'create', 's1');
    const out = stdout + stderr;

    assert.notEqual(code, 0, `文件已存在时不该报成功，实际输出：${out}`);
    assert.equal(readFileSync(specPath, 'utf-8'), '# Slice: s1\n\n## 目的\n原内容\n', '文件不该被改动');
  });
});

// ─── 命令层：写集的 set 命令 ───────────────────────────────────────────────

describe('ADR-082：zelto set 在「没改动」时必须报错', () => {
  beforeEach(() => {
    workDir = mkdtempSync(join(tmpdir(), 'zelto-set-no-change-'));
    mkdirSync(join(workDir, '.zelto', 'slices'), { recursive: true });
    mkdirSync(join(workDir, '.zelto', 'events'), { recursive: true });
    mkdirSync(join(workDir, 'specs', 'slices'), { recursive: true });
    const now = new Date().toISOString();
    writeFileSync(
      join(workDir, '.zelto', 'slices', 's1.json'),
      JSON.stringify(
        {
          id: 's1',
          title: '原标题',
          state: 'frozen',
          spec: { path: 'specs/slices/s1.md', frozenHash: 'h', frozenAt: now },
          acceptance: { dir: 'tests/acceptance/s1/', frozenHash: null, oracleSrc: null },
          baseCommit: null,
          drift: { detected: false, reason: null, at: null },
          trace: { requirements: [], contracts: [], tests: [] },
          traceWaiver: null,
          baseline: false,
          writes: ['src/a.ts'],
          runs: [],
          stall: { class: null, autoResolved: 0, gateRetries: 0 },
          createdAt: now,
          updatedAt: now,
        },
        null,
        2,
      ),
      'utf-8',
    );
  });

  afterEach(() => {
    rmSync(workDir, { recursive: true, force: true });
  });

  it('set 成同一个值 → 退出码 ≠ 0', async () => {
    const { code, stdout, stderr } = await runCommand('set', 's1', '--field', 'title', '--value', '原标题');
    const out = stdout + stderr;

    assert.notEqual(code, 0, `内容没变时不该报成功，实际输出：${out}`);
    assert.ok(
      out.includes('没有任何改动') || out.includes('NO_CHANGE'),
      `提示应说清「没有任何改动」，实际输出：${out}`,
    );
  });

  it('set 成新值 → 退出码 0，且状态文件确实变了', async () => {
    const { code, stdout, stderr } = await runCommand('set', 's1', '--field', 'title', '--value', '新标题');
    assert.equal(code, 0, `改值应成功，实际输出：${stdout}${stderr}`);
    const content = readFileSync(join(workDir, '.zelto', 'slices', 's1.json'), 'utf-8');
    assert.ok(content.includes('新标题'), '状态文件没被改成期望值');
  });
});

// ─── 命令层：spec confirm ───────────────────────────────────────────────────

describe('ADR-082：zelto spec confirm 在「没改动」时必须报错', () => {
  beforeEach(() => {
    workDir = mkdtempSync(join(tmpdir(), 'zelto-spec-no-change-'));
    mkdirSync(join(workDir, '.zelto', 'slices'), { recursive: true });
    mkdirSync(join(workDir, '.zelto', 'events'), { recursive: true });
    mkdirSync(join(workDir, '.zelto', 'drafts', 'specs'), { recursive: true });
    mkdirSync(join(workDir, 'specs', 'slices'), { recursive: true });

    const now = new Date().toISOString();
    writeFileSync(
      join(workDir, '.zelto', 'slices', 's1.json'),
      JSON.stringify(
        {
          id: 's1',
          title: '一片',
          state: 'draft',
          spec: { path: 'specs/slices/s1.md', frozenHash: null, frozenAt: null },
          acceptance: { dir: 'tests/acceptance/s1/', frozenHash: null, oracleSrc: null },
          baseCommit: null,
          drift: { detected: false, reason: null, at: null },
          trace: { requirements: [], contracts: [], tests: [] },
          traceWaiver: '需求尚未物化 — 显式豁免',
          baseline: false,
          writes: ['src/a.ts'],
          runs: [],
          stall: { class: null, autoResolved: 0, gateRetries: 0 },
          createdAt: now,
          updatedAt: now,
        },
        null,
        2,
      ),
      'utf-8',
    );

    const spec = '# Slice: s1\n\n## 目的\n同一份内容\n';
    writeFileSync(join(workDir, '.zelto', 'drafts', 'specs', 's1.md'), spec, 'utf-8');
    writeFileSync(join(workDir, 'specs', 'slices', 's1.md'), spec, 'utf-8');
  });

  afterEach(() => {
    rmSync(workDir, { recursive: true, force: true });
  });

  it('草稿与正式规格完全一致 → 退出码 ≠ 0', async () => {
    const { code, stdout, stderr } = await runCommand('spec', 'confirm', 's1');
    const out = stdout + stderr;

    assert.notEqual(code, 0, `内容没变时不该报成功，实际输出：${out}`);
    assert.ok(
      out.includes('没有任何改动') || out.includes('NO_CHANGE') || out.includes('一致'),
      `提示应说清「没有任何改动」，实际输出：${out}`,
    );
  });
});
