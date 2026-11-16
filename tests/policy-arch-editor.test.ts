// ADR-068 的回归测试：
//   1. `zelto policy arch` 子命令组（架构护栏的编辑器）
//   2. `zelto policy validate --update`（一体化重锚入口）
//   3. **D-30**：`policy edit` / `policy remove` 不再抹掉 `arch:` 段
//      —— 也不抹掉注释、`anchors:` 段、解析器不认识的字段
//
// D-30 是这一组里最重要的一个：
// `arch:` 段是**架构护栏的判定依据**，被一个看起来无关的命令静默抹掉，
// 人明确写下的「已知例外」（如 `cycle: ask`）会无声消失。

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';

const CLI_SCRIPT = join(process.cwd(), 'dist', 'cli', 'index.js');

let workDir: string;

/** 一份「真实项目形状」的 policy.yaml（nimrtc-zelto 的结构） */
const REAL_SHAPED_POLICY = `# Header comment
rules:
  - id: keep-me
    match:
      path: "src/**"
      operation: "write"
    action: allow
    basis: "policy.yaml#keep-me"
    reason: "Source directory agents may write"

# ── 架构护栏注释 ──
# 这条例外是 ADR-025 承认的
arch:
  - kind: cycle
    action: ask
    basis: "ADR-025"

anchors:
  policy: "sha256:init"
`;

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

function readPolicy(): string {
  return readFileSync(join(workDir, 'policy', 'policy.yaml'), 'utf-8');
}

function writePolicy(content: string): void {
  writeFileSync(join(workDir, 'policy', 'policy.yaml'), content, 'utf-8');
}

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), 'zelto-adr068-'));
  mkdirSync(join(workDir, 'policy'), { recursive: true });
  writePolicy(REAL_SHAPED_POLICY);
});

afterEach(() => {
  rmSync(workDir, { recursive: true, force: true });
});

// ─── D-30：policy edit / remove 不再抹掉 arch: 段 ─────────────────────────

describe('D-30：policy edit / remove 不再抹掉 arch: 段', () => {
  it('policy edit 之后 arch: 段仍在', async () => {
    const { code } = await runCommand('policy', 'edit', 'keep-me', '--action', 'deny');
    assert.equal(code, 0);
    assert.ok(readPolicy().includes('arch:'), 'arch: 段被抹掉了');
    assert.ok(readPolicy().includes('kind: cycle'), 'arch: 段内容被抹掉了');
  });

  it('policy remove 之后 arch: 段仍在', async () => {
    const { code } = await runCommand('policy', 'remove', 'keep-me');
    assert.equal(code, 0);
    assert.ok(readPolicy().includes('arch:'), 'arch: 段被抹掉了');
    assert.ok(readPolicy().includes('kind: cycle'), 'arch: 段内容被抹掉了');
  });

  it('policy edit 之后段落之间的注释仍在', async () => {
    await runCommand('policy', 'edit', 'keep-me', '--action', 'deny');
    const content = readPolicy();
    assert.ok(content.includes('这条例外是 ADR-025 承认的'), '注释被抹掉了');
  });

  it('policy edit 之后 anchors: 段仍在', async () => {
    await runCommand('policy', 'edit', 'keep-me', '--action', 'deny');
    assert.ok(readPolicy().includes('anchors:'), 'anchors: 段被抹掉了');
  });

  it('policy edit 之后解析器不认识的字段仍在（reason:）', async () => {
    await runCommand('policy', 'edit', 'keep-me', '--action', 'deny');
    assert.ok(
      readPolicy().includes('reason: "Source directory agents may write"'),
      'reason: 字段被悄悄抹掉了',
    );
  });

  it('policy add 之后 arch: 段仍在', async () => {
    await runCommand('policy', 'add', 'new-rule', '--path', 'docs/**', '--action', 'allow', '--basis', 'policy.yaml#new');
    assert.ok(readPolicy().includes('kind: cycle'), 'arch: 段被抹掉了');
  });

  it('policy edit 只改指定字段，其它字段逐字保留', async () => {
    await runCommand('policy', 'edit', 'keep-me', '--action', 'deny');
    const content = readPolicy();
    assert.ok(content.includes('action: deny'), 'action 没改成');
    assert.ok(content.includes('path: "src/**"'), 'path 被误改了');
    assert.ok(content.includes('operation: "write"'), 'operation 被误改了');
    assert.ok(content.includes('basis: "policy.yaml#keep-me"'), 'basis 被误改了');
  });
});

// ─── policy arch 子命令组 ─────────────────────────────────────────────────

describe('zelto policy arch：列出现有护栏规则', () => {
  it('list 列出 arch: 段里的规则', async () => {
    const { stdout, code } = await runCommand('policy', 'arch', 'list');
    assert.equal(code, 0);
    assert.ok(stdout.includes('cycle'), `实际输出：${stdout}`);
    assert.ok(stdout.includes('ask'), `实际输出：${stdout}`);
  });

  it('list --json 输出结构化结果', async () => {
    const { stdout, code } = await runCommand('policy', 'arch', 'list', '--json');
    assert.equal(code, 0);
    const parsed = JSON.parse(stdout);
    assert.equal(parsed.arch.length, 1);
    assert.equal(parsed.arch[0].kind, 'cycle');
    assert.equal(parsed.arch[0].action, 'ask');
  });

  it('list 在没有 arch: 段时不报错', async () => {
    writePolicy('rules:\n  - id: only-rule\n    match: { path: "src/**" }\n    action: allow\n    basis: "policy.yaml#only-rule"\n');
    const { code } = await runCommand('policy', 'arch', 'list');
    assert.equal(code, 0);
  });
});

describe('zelto policy arch：新增护栏规则', () => {
  it('add 之后 arch: 段多一条', async () => {
    const { code } = await runCommand(
      'policy', 'arch', 'add', 'unmapped_file',
      '--action', 'ask', '--basis', 'policy.yaml#arch', '--guidance', '先看看',
    );
    assert.equal(code, 0);
    const content = readPolicy();
    assert.ok(content.includes('kind: unmapped_file'), '新规则没写进去');
    assert.ok(content.includes('guidance: "先看看"'), 'guidance 没写进去');
  });

  it('add 不动 rules: 段', async () => {
    await runCommand('policy', 'arch', 'add', 'unmapped_file', '--action', 'ask', '--basis', 'policy.yaml#arch');
    const content = readPolicy();
    assert.ok(content.includes('id: keep-me'), 'rules: 段被动到了');
    assert.ok(content.includes('reason: "Source directory agents may write"'), 'rules: 段的字段被动到了');
  });

  it('add 不动注释、不动 anchors: 段', async () => {
    await runCommand('policy', 'arch', 'add', 'unmapped_file', '--action', 'ask', '--basis', 'policy.yaml#arch');
    const content = readPolicy();
    assert.ok(content.includes('这条例外是 ADR-025 承认的'), '注释被抹掉了');
    assert.ok(content.includes('anchors:'), 'anchors: 段被抹掉了');
  });

  it('add 重复 kind → 拒绝', async () => {
    const { code, stderr, stdout } = await runCommand(
      'policy', 'arch', 'add', 'cycle', '--action', 'deny', '--basis', 'policy.yaml#arch',
    );
    assert.equal(code, 1);
    assert.ok(
      (stderr + stdout).includes('already exists'),
      `重复 kind 应被拒绝，实际输出：${stderr + stdout}`,
    );
  });

  it('add 非法 kind → 拒绝', async () => {
    const { code } = await runCommand(
      'policy', 'arch', 'add', 'not_a_kind', '--action', 'ask', '--basis', 'policy.yaml#arch',
    );
    assert.equal(code, 1);
  });

  it('add 缺 --action → 拒绝', async () => {
    const { code } = await runCommand('policy', 'arch', 'add', 'unmapped_file', '--basis', 'policy.yaml#arch');
    assert.equal(code, 1);
  });

  it('add 缺 --basis → 拒绝', async () => {
    const { code } = await runCommand('policy', 'arch', 'add', 'unmapped_file', '--action', 'ask');
    assert.equal(code, 1);
  });

  it('add 非法 --action → 拒绝', async () => {
    const { code } = await runCommand(
      'policy', 'arch', 'add', 'unmapped_file', '--action', 'maybe', '--basis', 'policy.yaml#arch',
    );
    assert.equal(code, 1);
  });

  it('add 之后提示下一步是 validate --update（改锚是人的决定）', async () => {
    const { stdout } = await runCommand(
      'policy', 'arch', 'add', 'unmapped_file', '--action', 'ask', '--basis', 'policy.yaml#arch',
    );
    assert.ok(
      stdout.includes('validate --update'),
      `必须告诉人下一步跑什么，实际输出：${stdout}`,
    );
  });
});

describe('zelto policy arch：修改护栏规则', () => {
  it('edit 只改指定字段', async () => {
    const { code } = await runCommand('policy', 'arch', 'edit', 'cycle', '--action', 'allow');
    assert.equal(code, 0);
    const content = readPolicy();
    assert.ok(content.includes('action: allow'), 'action 没改成');
    assert.ok(content.includes('basis: "ADR-025"'), 'basis 被误改了');
  });

  it('edit 改 guidance 不影响其它字段', async () => {
    await runCommand('policy', 'arch', 'edit', 'cycle', '--guidance', '新的说明');
    const content = readPolicy();
    assert.ok(content.includes('guidance: "新的说明"'), 'guidance 没改成');
    assert.ok(content.includes('action: ask'), 'action 被误改了');
  });

  it('edit 不存在的 kind → 拒绝', async () => {
    const { code } = await runCommand('policy', 'arch', 'edit', 'nope', '--action', 'allow');
    assert.equal(code, 1);
  });
});

describe('zelto policy arch：删除护栏规则', () => {
  it('remove 之后那一条消失', async () => {
    const { code } = await runCommand('policy', 'arch', 'remove', 'cycle');
    assert.equal(code, 0);
    const content = readPolicy();
    assert.ok(!content.includes('kind: cycle'), '规则没删掉');
  });

  it('remove 不动 rules: 段与注释', async () => {
    await runCommand('policy', 'arch', 'remove', 'cycle');
    const content = readPolicy();
    assert.ok(content.includes('id: keep-me'), 'rules: 段被动到了');
    assert.ok(content.includes('这条例外是 ADR-025 承认的'), '注释被抹掉了');
    assert.ok(content.includes('anchors:'), 'anchors: 段被抹掉了');
  });

  it('remove 不存在的 kind → 拒绝', async () => {
    const { code } = await runCommand('policy', 'arch', 'remove', 'nope');
    assert.equal(code, 1);
  });
});

// ─── validate --update：一体重锚入口 ───────────────────────────────────────

describe('zelto policy validate --update', () => {
  it('没有锚点时 validate 通过，退出码 0', async () => {
    const { code } = await runCommand('policy', 'validate');
    assert.equal(code, 0);
  });

  it('锚定之后策略没变 → validate 通过', async () => {
    await runCommand('policy', 'lock', '--update');
    const { code } = await runCommand('policy', 'validate');
    assert.equal(code, 0);
  });

  it('策略改了 → validate 报失配，但退出码仍是 0（判与报分开）', async () => {
    await runCommand('policy', 'lock', '--update');
    writePolicy(readPolicy().replace('action: allow', 'action: deny'));
    const { code, stdout } = await runCommand('policy', 'validate');
    assert.equal(code, 0, '失配不该让 validate 变红（ADR-068 D3）');
    assert.ok(stdout.includes('锚点失配'), `应该报出失配，实际输出：${stdout}`);
  });

  it('validate --update → 重锚，退出码 0', async () => {
    await runCommand('policy', 'lock', '--update');
    writePolicy(readPolicy().replace('action: allow', 'action: deny'));
    const { code, stdout } = await runCommand('policy', 'validate', '--update');
    assert.equal(code, 0);
    assert.ok(stdout.includes('锚点已重锚'), `应该报出重锚，实际输出：${stdout}`);
  });

  it('validate --update 之后锚点确实一致', async () => {
    await runCommand('policy', 'lock', '--update');
    writePolicy(readPolicy().replace('action: allow', 'action: deny'));
    await runCommand('policy', 'validate', '--update');
    const { stdout } = await runCommand('policy', 'lock');
    assert.ok(stdout.includes('锚点一致'), `重锚后应一致，实际输出：${stdout}`);
  });

  it('validate --update 之后再次 validate 不再报失配', async () => {
    await runCommand('policy', 'lock', '--update');
    writePolicy(readPolicy().replace('action: allow', 'action: deny'));
    await runCommand('policy', 'validate', '--update');
    const { stdout } = await runCommand('policy', 'validate');
    assert.ok(!stdout.includes('锚点失配'), `重锚后不该再报失配，实际输出：${stdout}`);
  });

  it('validate --update 在策略本身非法时 → 退出码 1，且不重锚', async () => {
    await runCommand('policy', 'lock', '--update');
    const before = readFileSync(join(workDir, 'policy', 'lock.json'), 'utf-8');

    // 写一条不合法的规则（缺 basis）
    writePolicy('rules:\n  - id: bad-rule\n    match: { path: "src/**" }\n    action: allow\n');

    const { code } = await runCommand('policy', 'validate', '--update');
    assert.equal(code, 1, '策略本身非法时应退出码 1');

    const after = readFileSync(join(workDir, 'policy', 'lock.json'), 'utf-8');
    assert.equal(after, before, '策略非法时不该重锚（给坏策略改锚 = 锚点盖住坏策略）');
  });

  it('validate --update 在没有锚点时也能建锚点', async () => {
    assert.ok(!existsSync(join(workDir, 'policy', 'lock.json')));
    const { code } = await runCommand('policy', 'validate', '--update');
    assert.equal(code, 0);
    // 没有锚点时不算失配 → 不需要重锚 → 不该凭空造一个锚点文件
    assert.ok(
      !existsSync(join(workDir, 'policy', 'lock.json')),
      '没有失配时不该创建锚点文件',
    );
  });

  it('validate --update --json 报出重锚状态', async () => {
    await runCommand('policy', 'lock', '--update');
    writePolicy(readPolicy().replace('action: allow', 'action: deny'));
    const { stdout, code } = await runCommand('policy', 'validate', '--update', '--json');
    assert.equal(code, 0);
    const parsed = JSON.parse(stdout);
    assert.equal(parsed.anchor.reanchored, true);
    assert.equal(parsed.anchor.status, 'reanchored');
  });
});

// ─── D-31：带 BOM 的 policy.yaml —— 段标题判据被打穿（静默失败）─────────────
//
// 根因：`findSection` 判定段标题用的是「trim 后相等 **且** 长度相等」。
// JS 的 `trim()` 会把 BOM（U+FEFF）当空白去掉，所以 `trim() === 'rules:'` 成立；
// 但 `lines[i].length` 比标题多 1 → 长度判据不成立 → **整段找不到**。
//
// 后果（比 D-30 更隐蔽）：命令**报告成功**，文件一个字节没变。
// D-30 是「抹掉了不该抹的」，D-31 是「什么都没做却说你做了」。
//
// BOM 在 Windows 上很常见：PowerShell 5.1 的 `Set-Content -Encoding UTF8`、
// 记事本、部分编辑器都会写 BOM。

describe('D-31：带 BOM 的 policy.yaml 不再静默失败', () => {
  /** 写一个带 BOM 的 policy.yaml */
  function writePolicyWithBom(content: string): void {
    writeFileSync(join(workDir, 'policy', 'policy.yaml'), `\uFEFF${content}`, 'utf-8');
  }

  beforeEach(() => {
    writePolicyWithBom(REAL_SHAPED_POLICY);
  });

  it('policy edit 真的改了文件（不是只报成功）', async () => {
    const { code } = await runCommand('policy', 'edit', 'keep-me', '--action', 'deny');
    assert.equal(code, 0);
    assert.ok(readPolicy().includes('action: deny'), 'edit 报告成功但文件没变');
  });

  it('policy remove 真的删掉了规则（不是只报成功）', async () => {
    const { code } = await runCommand('policy', 'remove', 'keep-me');
    assert.equal(code, 0);
    assert.ok(!readPolicy().includes('id: keep-me'), 'remove 报告成功但规则还在');
  });

  it('policy arch edit 真的改了文件', async () => {
    const { code } = await runCommand('policy', 'arch', 'edit', 'cycle', '--action', 'deny');
    assert.equal(code, 0);
    assert.ok(readPolicy().includes('action: deny'), 'arch edit 报告成功但文件没变');
  });

  it('policy arch remove 真的删掉了护栏规则', async () => {
    const { code } = await runCommand('policy', 'arch', 'remove', 'cycle');
    assert.equal(code, 0);
    assert.ok(!readPolicy().includes('kind: cycle'), 'arch remove 报告成功但规则还在');
  });

  it('policy arch list 能读出带 BOM 的 arch: 段', async () => {
    const { stdout, code } = await runCommand('policy', 'arch', 'list');
    assert.equal(code, 0);
    assert.ok(stdout.includes('cycle'), `实际输出：${stdout}`);
  });

  it('policy arch add 不产生重复的 arch: 段', async () => {
    await runCommand('policy', 'arch', 'add', 'unmapped_file', '--action', 'ask', '--basis', 'policy.yaml#arch');
    const content = readPolicy();
    const occurrences = content.split('arch:').length - 1;
    assert.equal(occurrences, 1, `arch: 段出现了 ${occurrences} 次 —— 段没被识别，追加了一个新的`);
  });

  it('policy remove 不抹掉带 BOM 的 arch: 段', async () => {
    await runCommand('policy', 'remove', 'keep-me');
    const content = readPolicy();
    assert.ok(content.includes('kind: cycle'), 'arch: 段被抹掉了');
  });

  it('BOM 不会被写回时丢掉（编辑不改文件编码标记）', async () => {
    await runCommand('policy', 'edit', 'keep-me', '--action', 'deny');
    const raw = readFileSync(join(workDir, 'policy', 'policy.yaml'), 'utf-8');
    assert.ok(raw.startsWith('\uFEFF'), 'BOM 被抹掉了 —— 文件编码标记不该被工具改');
  });

  it('段缺失时命令报错而不是报告成功（静默失败防线）', async () => {
    // 造一个「解析器认得、但分段编辑器认不出」的文件：
    // rules: 被缩进（它就不在顶层了）
    writePolicy('anchors:\n  policy: "sha256:init"\n');
    const { code } = await runCommand('policy', 'remove', 'keep-me');
    // 规则本来就不存在 → 报「找不到」而不是「已删除」
    assert.notEqual(code, 0, '找不到规则时不该返回 0');
  });
});
