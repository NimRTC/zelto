// 根级构建清单必须可写 —— 接管任何 CMake / npm 项目都会踩到的一条
//
// 问题：policy 生成时只给「顶层目录」发 allow 规则（`src/**` 等），
// 根级的构建清单（`CMakeLists.txt` / `package.json` / `Cargo.toml` …）
// 不在任何规则里 → 落到 `default: deny`。
//
// 后果：规格里明确写「在顶层 CMakeLists.txt 注册新模块」，agent 一改
// 这个文件就被 PreToolUse 钩子当场拒掉。切片刻意做完了、门禁也过了，
// 却卡在一个本该允许的动作上 —— 接管路径整体走不通。
//
// 这组用例锁住三件事：
//  1. 根级构建清单在生成的策略里是 allow；
//  2. 粒度是**精确路径** —— 子目录里的同名文件不由这条规则管
//     （子目录由各自的目录规则管，边界更细的那层不能丢）；
//  3. 根级**非**构建文件（README.md 之类）仍然落在 default deny ——
//     修一个洞不能顺手开一个更大的洞。

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { initializeProject } from '../src/core/project/initializer.js';
import { scanProject, detectRootBuildFiles } from '../src/core/project/scanner.js';
import { evaluatePolicy } from '../src/core/policy/engine.js';
import { parsePolicyYaml } from '../src/core/policy/yaml.js';

const TEST_DIR = join(tmpdir(), `zelto-root-build-${Date.now()}`);

async function writeCppProject(dir: string): Promise<void> {
  await mkdir(join(dir, 'src', 'modules'), { recursive: true });
  await writeFile(join(dir, 'CMakeLists.txt'), 'cmake_minimum_required(VERSION 3.20)\n', 'utf-8');
  await writeFile(join(dir, 'CMakePresets.json'), '{ "version": 6 }\n', 'utf-8');
  await writeFile(join(dir, 'src', 'modules', 'CMakeLists.txt'), '# module list\n', 'utf-8');
  await writeFile(join(dir, 'src', 'modules', 'a.cpp'), 'int a() { return 1; }\n', 'utf-8');
  await writeFile(join(dir, 'README.md'), '# demo\n', 'utf-8');
}

async function writeNodeProject(dir: string): Promise<void> {
  await mkdir(join(dir, 'src'), { recursive: true });
  await writeFile(
    join(dir, 'package.json'),
    '{ "name": "demo", "version": "1.0.0", "scripts": { "test": "npm test" } }\n',
    'utf-8',
  );
  await writeFile(join(dir, 'src', 'a.ts'), 'export const a = 1;\n', 'utf-8');
}

describe('根级构建清单 · policy 生成', () => {
  let cppDir: string;
  let nodeDir: string;

  before(async () => {
    cppDir = join(TEST_DIR, 'cpp');
    nodeDir = join(TEST_DIR, 'node');
    await mkdir(cppDir, { recursive: true });
    await mkdir(nodeDir, { recursive: true });
    await writeCppProject(cppDir);
    await writeNodeProject(nodeDir);
  });

  after(async () => {
    await rm(TEST_DIR, { recursive: true, force: true });
  });

  it('检测到的根级构建清单只含实际存在的文件', () => {
    assert.deepEqual(
      detectRootBuildFiles(cppDir, 'cpp'),
      ['CMakeLists.txt', 'CMakePresets.json'],
      '不存在的文件不该出现在清单里',
    );
    assert.deepEqual(detectRootBuildFiles(nodeDir, 'node'), ['package.json']);
    assert.deepEqual(detectRootBuildFiles(cppDir, 'unknown'), []);
  });

  it('C++ 项目的根级 CMakeLists.txt 在策略里是 allow', async () => {
    await initializeProject(scanProject(cppDir), { autoDetect: true, policyTemplate: 'default' });

    const { rules } = parsePolicyYaml(
      // 策略由 initializeProject 写到 policy/policy.yaml
      readFileSync(join(cppDir, 'policy', 'policy.yaml'), 'utf-8'),
    );

    const decision = evaluatePolicy({ rules, protected: [] }, 'CMakeLists.txt', 'write', 'test');
    assert.equal(decision.decision, 'allow', `根级构建清单必须可写，实际：${JSON.stringify(decision)}`);

    const preset = evaluatePolicy({ rules, protected: [] }, 'CMakePresets.json', 'write', 'test');
    assert.equal(preset.decision, 'allow', 'CMakePresets.json 同样要可写');
  });

  it('粒度是精确路径 —— 子目录里的同名文件不由根级规则管', async () => {
    await initializeProject(scanProject(cppDir), { autoDetect: true, policyTemplate: 'default' });

    const { rules } = parsePolicyYaml(
      readFileSync(join(cppDir, 'policy', 'policy.yaml'), 'utf-8'),
    );

    // src/modules/CMakeLists.txt 由 'src/**' 目录规则管，不由根级规则管
    const rootRule = rules.find((r) => r.match.path === 'CMakeLists.txt');
    assert.ok(rootRule, '应当有一条精确匹配根级 CMakeLists.txt 的规则');
    assert.equal(rootRule.match.operation, 'write');

    const nested = evaluatePolicy({ rules, protected: [] }, 'src/modules/CMakeLists.txt', 'write', 'test');
    assert.equal(nested.decision, 'allow', '子目录里的同名文件仍由目录规则放行');
    assert.notEqual(nested.ruleId, rootRule.id, '子目录那条应由目录规则命中，而不是根级规则');
  });

  it('node 项目的根级 package.json 可写', async () => {
    await initializeProject(scanProject(nodeDir), { autoDetect: true, policyTemplate: 'default' });

    const { rules } = parsePolicyYaml(
      readFileSync(join(nodeDir, 'policy', 'policy.yaml'), 'utf-8'),
    );

    const decision = evaluatePolicy({ rules, protected: [] }, 'package.json', 'write', 'test');
    assert.equal(decision.decision, 'allow', `根级 package.json 必须可写，实际：${JSON.stringify(decision)}`);
  });

  it('根级非构建文件仍然落在 default deny（不因修一个洞开更大的洞）', async () => {
    await initializeProject(scanProject(cppDir), { autoDetect: true, policyTemplate: 'default' });

    const { rules } = parsePolicyYaml(
      readFileSync(join(cppDir, 'policy', 'policy.yaml'), 'utf-8'),
    );

    const decision = evaluatePolicy({ rules, protected: [] }, 'README.md', 'write', 'test');
    assert.equal(decision.decision, 'deny', 'README.md 不该因为这次修复变得可写');
  });

  it('接管重建策略时根级规则仍在（不是只在首次生成时）', async () => {
    await initializeProject(scanProject(cppDir), { autoDetect: true, policyTemplate: 'default' });

    // 接管之间项目变了：新增一个顶层模块目录（策略里会多一条 lib/** 规则）
    await mkdir(join(cppDir, 'lib'), { recursive: true });
    await writeFile(join(cppDir, 'lib', 'c.cpp'), 'int c() { return 3; }\n', 'utf-8');

    const result = await initializeProject(scanProject(cppDir), { autoDetect: true, policyTemplate: 'default' });
    assert.ok(result.updated.includes('policy/policy.yaml'), '第二次接管应当重建策略');

    const { rules } = parsePolicyYaml(
      readFileSync(join(cppDir, 'policy', 'policy.yaml'), 'utf-8'),
    );
    const decision = evaluatePolicy({ rules, protected: [] }, 'CMakeLists.txt', 'write', 'test');
    assert.equal(decision.decision, 'allow', '重建后根级构建清单仍要可写');
  });
});
