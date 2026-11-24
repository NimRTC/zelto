// D-4 的报错必须**给出路**（ZD-033）
//
// ── 病灶（ADR-098 实测，nimrtc v1.4）──
//
// 五片规格阶段共 **23.93h**，其中 97.8% 是「人在改规格与改写集」的往返，
// 而 97% 的闸门失败是**同一句**：
//
//     规格提到「X」，但它不在写集里 —— agent 改不了它
//
// 这句话**没告诉人该怎么改**。人得自己判断：
//
//   - X 是本片要改的 → 要加进写集
//   - X 只是拿来参考的 → 要在规格里标成「只读」
//
// 两条修法方向**完全相反**，人猜错了就是再等几小时被门禁打回。
//
// 修法（ADR-098 决策五）：工具**不**自动改写集 —— 写集是人批准的边界（C9）——
// 但报错必须把两条出路都摆出来，让人改一次就够了。

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';

const TEST_DIR = join(tmpdir(), `zelto-freeze-hint-test-${Date.now()}`);
const CLI_SCRIPT = join(process.cwd(), 'dist', 'cli', 'index.js');

function runCommand(...args: string[]): Promise<{ stdout: string; stderr: string; code: number }> {
  return new Promise((resolve, reject) => {
    const child = spawn('node', [CLI_SCRIPT, ...args], {
      cwd: TEST_DIR,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.on('close', (code) => resolve({ stdout, stderr, code: code ?? 1 }));
    child.on('error', reject);
  });
}

/** 造一份规格：「范围」里有 a.cpp，「需求」里提到不在写集里的 b.cpp */
async function writeSpec(id: string, scopeFiles: string[], mentions: string[]): Promise<void> {
  const content = `# Slice: ${id}

## 目的

测试写集不一致时的报错。

## 范围

${scopeFiles.map((f) => `- \`${f}\``).join('\n')}

## 需求

${mentions.map((f, i) => `${i + 1}. **需求 ${i + 1}**：如需登记，请同时改 \`${f}\`。`).join('\n')}

## 验收标准

1. 目标行为可验证。
`;
  await writeFile(join(TEST_DIR, 'specs', 'slices', `${id}.md`), content, 'utf-8');
}

async function writeSlice(id: string, writes: string[]): Promise<void> {
  const now = new Date().toISOString();
  const slice = {
    id,
    title: `Slice ${id}`,
    state: 'draft',
    spec: { path: `specs/slices/${id}.md`, frozenHash: null, frozenAt: null },
    acceptance: { dir: `tests/acceptance/${id}/`, frozenHash: null, oracleSrc: null },
    baseCommit: null,
    drift: { detected: false, reason: null, at: null },
    trace: { requirements: ['req-1'], contracts: [], tests: [] },
    traceWaiver: null,
    baseline: false,
    writes,
    runs: [],
    stall: { class: null, autoResolved: 0, gateRetries: 0 },
    createdAt: now,
    updatedAt: now,
  };
  await writeFile(
    join(TEST_DIR, '.zelto', 'slices', `${id}.json`),
    JSON.stringify(slice, null, 2),
    'utf-8',
  );
}

describe('冻结报「不在写集里」时给出可操作的两条出路（ZD-033）', () => {
  before(async () => {
    await mkdir(join(TEST_DIR, '.zelto', 'slices'), { recursive: true });
    await mkdir(join(TEST_DIR, '.zelto', 'events'), { recursive: true });
    await mkdir(join(TEST_DIR, '.zelto', 'locks'), { recursive: true });
    await mkdir(join(TEST_DIR, 'specs', 'slices'), { recursive: true });
    await mkdir(join(TEST_DIR, 'policy'), { recursive: true });
    await writeFile(
      join(TEST_DIR, 'policy', 'policy.yaml'),
      [
        'rules:',
        '  - id: allow-src',
        '    match:',
        '      path: "src/**"',
        '      operation: "write"',
        '    action: allow',
        '    basis: "policy.yaml#allow-src"',
        '',
      ].join('\n'),
      'utf-8',
    );
  });

  after(async () => {
    await rm(TEST_DIR, { recursive: true, force: true });
  });

  it('报错里同时给出「加进写集」与「标成只读」两条出路', async () => {
    await writeSpec('hint-mismatch', ['src/a.cpp'], ['src/b.cpp']);
    await writeSlice('hint-mismatch', ['src/a.cpp']);

    const res = await runCommand('freeze', 'hint-mismatch');
    const out = res.stdout + res.stderr;

    assert.equal(res.code, 1, '应该拒绝冻结');
    assert.match(out, /不在写集里/, '仍然要说清问题');

    // 出路一：加进写集
    assert.match(out, /--field writes/, '要给出加写集的命令');
    // 出路二：在规格里标只读
    assert.match(out, /只读/, '要给出标只读的修法');
    // 还要说清怎么判（两条方向相反）
    assert.match(out, /要改|参考/, '要说清怎么选');
  });

  it('JSON 输出也带上 advisories（Web 端要显示）', async () => {
    await writeSpec('hint-mismatch-json', ['src/a.cpp'], ['src/b.cpp']);
    await writeSlice('hint-mismatch-json', ['src/a.cpp']);

    const res = await runCommand('freeze', 'hint-mismatch-json', '--json');
    const payload = JSON.parse(res.stdout);
    assert.equal(payload.success, false);
    assert.ok(Array.isArray(payload.advisories), 'JSON 里要有 advisories');
    assert.ok(payload.advisories.length > 0, 'advisories 不能是空的');
    assert.match(payload.advisories.join('\n'), /只读/);
  });
});
