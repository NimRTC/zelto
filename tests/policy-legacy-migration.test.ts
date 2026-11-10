// 老版本生成物的接管迁移（ADR-040）
//
// 问题：ADR-038 给 zelto 自己生成的文件加了 `# zelto:generated:<hash>` 标记，
// 接管时靠哈希比对判断「这份文件还是不是 zelto 留下的原样」。
// 但标记行是 ADR-038 之后才有的 —— 更早的 zelto 生成的文件没有这一行，
// 判定一律落到「人手写的」：
//
//   - 门禁命令还是通用的 `pnpm test`（在 CMake / Rust 项目上是错的）；
//   - 写集规则没按实际模块生成；
//   - 根级构建清单没有规则 → 规格里明写「在顶层 CMakeLists.txt 注册新模块」
//     会被 PreToolUse 钩子当场拒掉。
//
// 也就是说 ADR-038/039 的接管改进，对所有 ADR-038 之前接管的既有项目
// **完全失效** —— 看起来「接管成功了」，其实什么都没接管。
//
// 这组用例锁住四件事：
//  1. 老版本生成的策略 → 接管时被重建，补上根级构建清单；
//  2. 老版本生成、但含人工规则的策略 → 一个字都不动；
//  3. 老版本生成的配置 → 门禁命令是通用默认值才重建，自定义的一律不动；
//  4. 老策略内嵌的 `anchors:` 段 → 锚点搬进 policy/lock.json，
//     且 `policy validate` 不再因这个未知顶层键判红（只报警告）。

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, rm, writeFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { initializeProject } from '../src/core/project/initializer.js';
import { scanProject } from '../src/core/project/scanner.js';
import { parsePolicyYaml } from '../src/core/policy/yaml.js';
import { evaluatePolicy } from '../src/core/policy/engine.js';
import { validatePolicyYaml } from '../src/core/policy/validator.js';
import { readPolicyLock } from '../src/core/policy/lock.js';

const TEST_DIR = join(tmpdir(), `zelto-legacy-migration-${Date.now()}`);

/**
 * 一份**老版本** zelto 生成的策略：有生成器的文件头，没有标记行，
 * 规则只覆盖顶层目录（根级构建清单不在任何规则里）。
 */
function legacyPolicyYaml(projectName: string): string {
  return [
    '# zelto policy rules',
    `# Auto-generated for "${projectName}"`,
    '',
    'rules:',
    '',
    '  - id: allow-write-0',
    '    match:',
    '      path: "src/**"',
    '      operation: "write"',
    '    action: allow',
    '    basis: "policy.yaml#allow-write-0"',
    '',
    '  - id: allow-read-all',
    '    match:',
    '      path: "**"',
    '      operation: "read"',
    '    action: allow',
    '    basis: "policy.yaml#allow-read-all"',
    '    priority: 0',
    '',
  ].join('\n');
}

/** 老版本生成器写的 config：门禁命令是通用默认值 */
function legacyConfigYaml(projectName: string): string {
  return [
    '# zelto project configuration',
    `# Auto-generated for "${projectName}"`,
    '',
    'gate:',
    '  commands:',
    '    - name: test',
    '      run: pnpm test',
    '    - name: lint',
    '      run: pnpm lint',
    '  timeoutSec: 120',
    '  retry:',
    '    max: 2',
    '',
    'agent:',
    '  command: "npx @anthropic-ai/claude-code"',
    '',
  ].join('\n');
}

async function writeCppProject(dir: string): Promise<void> {
  await mkdir(join(dir, 'src', 'modules'), { recursive: true });
  await writeFile(join(dir, 'CMakeLists.txt'), 'cmake_minimum_required(VERSION 3.20)\n', 'utf-8');
  await writeFile(join(dir, 'src', 'modules', 'a.cpp'), 'int a() { return 1; }\n', 'utf-8');
}

describe('ADR-040 · 老版本生成物的接管迁移', () => {
  before(async () => {
    await mkdir(TEST_DIR, { recursive: true });
  });

  after(async () => {
    await rm(TEST_DIR, { recursive: true, force: true });
  });

  it('老版本生成的策略 → 被重建，并补上根级构建清单规则', async () => {
    const dir = join(TEST_DIR, 'policy-legacy');
    await writeCppProject(dir);
    await mkdir(join(dir, 'policy'), { recursive: true });
    await writeFile(join(dir, 'policy', 'policy.yaml'), legacyPolicyYaml('demo'), 'utf-8');

    const result = await initializeProject(scanProject(dir), { autoDetect: true, policyTemplate: 'default' });

    assert.ok(result.updated.includes('policy/policy.yaml'), '老版本生成的策略应被重建');
    assert.equal(result.migrated.length, 1, '迁移要被记下来');
    assert.equal(result.migrated[0].file, 'policy/policy.yaml');

    const content = await readFile(join(dir, 'policy', 'policy.yaml'), 'utf-8');
    const { rules } = parsePolicyYaml(content);

    const decision = evaluatePolicy({ rules, protected: [] }, 'CMakeLists.txt', 'write', 'test');
    assert.equal(decision.decision, 'allow', '重建后根级构建清单必须可写');

    // 重建后带上了标记行 —— 下一次接管就走哈希比对那条路了
    assert.match(content, /# zelto:generated:[0-9a-f]{16}/, '重建后应当带标记行');
  });

  it('老版本生成、但含人工规则的策略 → 一个字都不动', async () => {
    const dir = join(TEST_DIR, 'policy-legacy-manual');
    await writeCppProject(dir);
    await mkdir(join(dir, 'policy'), { recursive: true });

    const original = [
      ...legacyPolicyYaml('demo').split('\n'),
      '  - id: my-own-rule',
      '    match:',
      '      path: "secrets/**"',
      '      operation: "write"',
      '    action: deny',
      '    basis: "policy.yaml#my-own-rule"',
      '',
    ].join('\n');
    await writeFile(join(dir, 'policy', 'policy.yaml'), original, 'utf-8');

    const result = await initializeProject(scanProject(dir), { autoDetect: true, policyTemplate: 'default' });

    assert.ok(!result.updated.includes('policy/policy.yaml'), '含人工规则的策略不能被覆盖');
    assert.ok(
      result.skipped.some((s) => s.includes('含人工规则')),
      '要明确告诉人「这份老策略含人工规则」',
    );

    const after = await readFile(join(dir, 'policy', 'policy.yaml'), 'utf-8');
    assert.equal(after, original, '策略文件必须逐字不变');
  });

  it('老版本生成的配置（通用默认门禁）→ 按真实探测结果重建', async () => {
    const dir = join(TEST_DIR, 'config-legacy');
    await writeCppProject(dir);
    await mkdir(join(dir, '.zelto'), { recursive: true });
    await writeFile(join(dir, '.zelto', 'config.yaml'), legacyConfigYaml('demo'), 'utf-8');

    const result = await initializeProject(scanProject(dir), { autoDetect: true, policyTemplate: 'default' });

    assert.ok(result.updated.includes('.zelto/config.yaml'), '通用默认门禁的老配置应被重建');
    const content = await readFile(join(dir, '.zelto', 'config.yaml'), 'utf-8');
    assert.ok(!content.includes('run: pnpm test'), 'C++ 项目不该再用通用的 pnpm test 当门禁');
  });

  it('老版本生成、但门禁命令是自定义的配置 → 一个字都不动', async () => {
    const dir = join(TEST_DIR, 'config-legacy-custom');
    await writeCppProject(dir);
    await mkdir(join(dir, '.zelto'), { recursive: true });

    const original = legacyConfigYaml('demo').replace(
      '      run: pnpm test',
      '      run: cmake --build build --target test_net_feedback',
    );
    await writeFile(join(dir, '.zelto', 'config.yaml'), original, 'utf-8');

    const result = await initializeProject(scanProject(dir), { autoDetect: true, policyTemplate: 'default' });

    assert.ok(!result.updated.includes('.zelto/config.yaml'), '自定义门禁的老配置不能被覆盖');
    const after = await readFile(join(dir, '.zelto', 'config.yaml'), 'utf-8');
    assert.equal(after, original, '配置文件必须逐字不变');
  });

  it('老策略内嵌的 anchors 锚点 → 搬进 policy/lock.json', async () => {
    const dir = join(TEST_DIR, 'anchors-legacy');
    await writeCppProject(dir);
    await mkdir(join(dir, 'policy'), { recursive: true });

    const legacyAnchor = `sha256:${'a'.repeat(64)}`;
    const original = [
      ...legacyPolicyYaml('demo').split('\n'),
      'anchors:',
      `  policy: "${legacyAnchor}"`,
      '',
    ].join('\n');
    await writeFile(join(dir, 'policy', 'policy.yaml'), original, 'utf-8');

    await initializeProject(scanProject(dir), { autoDetect: true, policyTemplate: 'default' });

    const lock = readPolicyLock(dir);
    assert.ok(lock, '锚点必须被外部化到 policy/lock.json');
    assert.equal(lock.policy, legacyAnchor, '老锚点不能被洗掉 —— 失配要能被判出来');
  });

  it('带 anchors: 段的策略不再让 policy validate 判红（只报警告）', () => {
    const content = [
      '# zelto policy rules',
      '# Auto-generated for "demo"',
      '',
      'rules:',
      '',
      '  - id: allow-write-0',
      '    match:',
      '      path: "src/**"',
      '      operation: "write"',
      '    action: allow',
      '    basis: "policy.yaml#allow-write-0"',
      '',
      'anchors:',
      `  policy: "sha256:${'b'.repeat(64)}"`,
      '',
    ].join('\n');

    const result = validatePolicyYaml(content);
    assert.equal(result.valid, true, 'anchors: 是废弃段，不是非法结构');
    assert.ok(
      (result.warnings ?? []).some((w) => w.code === 'W_DEPRECATED_ANCHORS'),
      '要报出「这段被忽略了」',
    );
  });

  it('被人改过的当前版本策略 → 不能被当成 legacy 覆盖', async () => {
    const dir = join(TEST_DIR, 'policy-current-edited');
    await writeCppProject(dir);
    await mkdir(join(dir, 'policy'), { recursive: true });

    // 当前版本生成（有标记行），人后来加了一条规则
    const first = await initializeProject(scanProject(dir), { autoDetect: true, policyTemplate: 'default' });
    assert.ok(first.created.includes('policy/policy.yaml'), '首次接管应生成策略');

    const path = join(dir, 'policy', 'policy.yaml');
    const original = (await readFile(path, 'utf-8')).replace(
      'rules:',
      [
        'rules:',
        '',
        '  - id: my-own-rule',
        '    match:',
        '      path: "secrets/**"',
        '      operation: "write"',
        '    action: deny',
        '    basis: "policy.yaml#my-own-rule"',
      ].join('\n'),
    );
    await writeFile(path, original, 'utf-8');

    const second = await initializeProject(scanProject(dir), { autoDetect: true, policyTemplate: 'default' });

    assert.ok(
      !second.updated.includes('policy/policy.yaml'),
      '有标记行 = 当前版本生成的，哪怕被改过也不能重建',
    );
    const after = await readFile(path, 'utf-8');
    assert.equal(after, original, '人的规则必须逐字保留');
  });
});
