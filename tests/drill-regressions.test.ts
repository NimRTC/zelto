// 实战演练 D-2 / D-3 / D-5 / D-8 的回归测试。
//
// D-2：`--agent` 没给值时，不能把 undefined 当成「用户指定的值」传下去
//       （实测日志里出现 `Agent: undefined`）
// D-3：提示词模板里的占位符标题（「需求标题」）不该被当成真标题存进去
// D-5：近形命令（`requirement` → `require`）不该掉进 LLM 自然语言路由
// D-8：门禁②的失败信息要能区分「没写断言」与「断言写错了」

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';

import { optionValue, optionValueStrict } from '../src/cli/commands/shared.js';
import { isPlaceholderTitle, fallbackTitleFrom } from '../src/llm/generators/placeholder-title.js';
import { parseTestRunnerStats, verifyAcceptanceRanTests, classifyAcceptanceFailure } from '../src/core/gate/acceptance.js';

const TEST_DIR = join(tmpdir(), `zelto-d2-d3-d5-d8-test-${Date.now()}`);
const CLI_SCRIPT = join(process.cwd(), 'dist', 'cli', 'index.js');

function runCommand(...args: string[]): Promise<{ stdout: string; stderr: string; code: number }> {
  return new Promise((resolve, reject) => {
    const child = spawn('node', [CLI_SCRIPT, ...args], {
      cwd: TEST_DIR,
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

// ─── D-2：带值选项的解析 ────────────────────────────────────────────────────

describe('D-2：带值选项的解析', () => {
  it('选项不存在 → 返回回退值', () => {
    assert.equal(optionValue(['run', 'my-slice'], '--agent', 'default-agent'), 'default-agent');
  });

  it('选项有值 → 返回该值', () => {
    assert.equal(optionValue(['run', 's', '--agent', 'claude'], '--agent', 'default-agent'), 'claude');
  });

  it('选项是最后一个参数（没有值）→ 返回回退值，不是 undefined', () => {
    // 演练里的实际症状：`args[indexOf('--agent') + 1]` 是 undefined，
    // 而 undefined 被当成「用户指定的值」传了下去。
    assert.equal(optionValue(['run', 's', '--agent'], '--agent', 'default-agent'), 'default-agent');
  });

  it('选项后面跟的是另一个选项 → 返回回退值', () => {
    assert.equal(
      optionValue(['run', 's', '--agent', '--dry-run'], '--agent', 'default-agent'),
      'default-agent',
    );
  });

  it('严格变体：选项缺失返回 undefined', () => {
    assert.equal(optionValueStrict(['run', 's'], '--agent'), undefined);
  });

  it('严格变体：选项有值返回该值', () => {
    assert.equal(optionValueStrict(['run', 's', '--agent', 'claude'], '--agent'), 'claude');
  });

  it('严格变体：选项没值返回 undefined', () => {
    assert.equal(optionValueStrict(['run', 's', '--agent'], '--agent'), undefined);
  });
});

// ─── D-3：占位符标题 ────────────────────────────────────────────────────────

describe('D-3：占位符标题识别', () => {
  it('历史格式的占位符（不带尖括号）被识别', () => {
    assert.ok(isPlaceholderTitle('需求标题'));
    assert.ok(isPlaceholderTitle('设计标题'));
  });

  it('当前格式的占位符（尖括号）被识别', () => {
    assert.ok(isPlaceholderTitle('<需求标题>'));
    assert.ok(isPlaceholderTitle('<设计标题>'));
  });

  it('任意尖括号填空槽被识别', () => {
    assert.ok(isPlaceholderTitle('<随便什么>'));
  });

  it('中文括号填空槽被识别', () => {
    assert.ok(isPlaceholderTitle('〈需求标题〉'));
    assert.ok(isPlaceholderTitle('《设计标题》'));
  });

  it('默认回退串被识别', () => {
    assert.ok(isPlaceholderTitle('Untitled Requirement'));
    assert.ok(isPlaceholderTitle('Untitled Design'));
  });

  it('真标题不被误判', () => {
    assert.ok(!isPlaceholderTitle('RTP 打包集中化'));
    assert.ok(!isPlaceholderTitle('Auth redesign'));
    assert.ok(!isPlaceholderTitle('需求标题的规范定义'));
  });

  it('空串被识别为占位符', () => {
    assert.ok(isPlaceholderTitle(''));
    assert.ok(isPlaceholderTitle('   '));
  });

  it('兜底标题从正文里捞一句像标题的话', () => {
    const content = ['# <需求标题>', '', '本需求规范用户认证流程。', '## 功能列表', '- [ ] x'].join('\n');
    assert.equal(fallbackTitleFrom(content), '本需求规范用户认证流程。');
  });

  it('兜底标题找不到时返回 null', () => {
    assert.equal(fallbackTitleFrom('# <需求标题>\n\n## 功能列表\n- [ ] x'), null);
  });
});

// ─── D-5：近形命令 ──────────────────────────────────────────────────────────

describe('D-5：近形命令别名', () => {
  it('`requirement list` 走 require 通路而不是 LLM 路由', async () => {
    await mkdir(join(TEST_DIR, '.zelto', 'requirements'), { recursive: true });
    const { stdout, stderr, code } = await runCommand('requirement', 'list');
    const output = stdout + stderr;
    // 不是 LLM 那套「需求似乎不够明确」的提示
    assert.ok(
      !output.includes('似乎不够明确'),
      `近形命令不该掉进 LLM 路由，实际输出：${output}`,
    );
    // 也不是「未知命令」
    assert.ok(
      !output.includes('Unknown command'),
      `近形命令不该报未知命令，实际输出：${output}`,
    );
    assert.equal(code, 0, `近形命令应正常执行，实际输出：${output}`);
  });

  it('`requirements list` 同样走 require 通路', async () => {
    const { stdout, stderr, code } = await runCommand('requirements', 'list');
    const output = stdout + stderr;
    assert.ok(!output.includes('Unknown command'), `实际输出：${output}`);
    assert.equal(code, 0, `实际输出：${output}`);
  });

  it('`req list` 同样走 require 通路', async () => {
    const { stdout, stderr, code } = await runCommand('req', 'list');
    const output = stdout + stderr;
    assert.ok(!output.includes('Unknown command'), `实际输出：${output}`);
    assert.equal(code, 0, `实际输出：${output}`);
  });
});

// ─── D-8：门禁②失败分类 ────────────────────────────────────────────────────

describe('D-8：门禁②失败分类', () => {
  it('全 todo → 归类为「没写断言」', () => {
    const stats = parseTestRunnerStats('# tests 5\nℹ pass 0\nℹ fail 0\nℹ todo 5');
    const verdict = verifyAcceptanceRanTests(stats);
    assert.equal(verdict.ok, false);
    assert.equal(verdict.kind, 'no-assertions');
    assert.ok(verdict.reason);
  });

  it('全 skipped → 归类为「全被跳过」', () => {
    const stats = parseTestRunnerStats('# tests 3\nℹ pass 0\nℹ fail 0\nℹ skipped 3');
    const verdict = verifyAcceptanceRanTests(stats);
    assert.equal(verdict.ok, false);
    assert.equal(verdict.kind, 'all-skipped');
  });

  it('pass 0 且无 todo/skipped → 归类为「空的」', () => {
    const stats = parseTestRunnerStats('# tests 0\nℹ pass 0\nℹ fail 0');
    const verdict = verifyAcceptanceRanTests(stats);
    assert.equal(verdict.ok, false);
    assert.equal(verdict.kind, 'empty');
  });

  it('有 pass → 判定为通过', () => {
    const stats = parseTestRunnerStats('# tests 8\nℹ pass 8\nℹ fail 0');
    const verdict = verifyAcceptanceRanTests(stats);
    assert.equal(verdict.ok, true);
    assert.equal(verdict.reason, null);
  });

  it('有断言失败 → 归类为「断言不成立」', () => {
    const stats = parseTestRunnerStats('# tests 8\nℹ pass 6\nℹ fail 2');
    const failure = classifyAcceptanceFailure(stats);
    assert.equal(failure.kind, 'assertion-failed');
  });

  it('全挂 → 归类为「全部失败」', () => {
    const stats = parseTestRunnerStats('# tests 8\nℹ pass 0\nℹ fail 8');
    const failure = classifyAcceptanceFailure(stats);
    assert.equal(failure.kind, 'all-failed');
  });

  it('读不出统计 → 归类为「命令失败」', () => {
    const stats = parseTestRunnerStats('some random output');
    const failure = classifyAcceptanceFailure(stats);
    assert.equal(failure.kind, 'command-failed');
  });

  it('分类标签互不相同（提示信息能区分开）', () => {
    const kinds = new Set([
      classifyAcceptanceFailure(parseTestRunnerStats('ℹ pass 1\nℹ fail 1')).label,
      classifyAcceptanceFailure(parseTestRunnerStats('ℹ pass 0\nℹ fail 2')).label,
      classifyAcceptanceFailure(parseTestRunnerStats('garbage')).label,
    ]);
    assert.equal(kinds.size, 3, '三类失败的提示语必须能区分开');
  });
});
