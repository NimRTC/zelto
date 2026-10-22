// Tests for LLM generators — with mocked adapter (no network calls)

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import type { LlmAdapter, LlmResponse } from '../src/adapters/llm/types.js';
import { generateRequirements, refineRequirements } from '../src/llm/generators/requirements.js';
import { generateDesign, refineDesign } from '../src/llm/generators/design.js';
import { generateSlicePlan, generateVersion } from '../src/llm/generators/slice-plan.js';

function createMockLlm(responseContent: string): LlmAdapter {
  return {
    async chat(): Promise<LlmResponse> {
      return {
        content: responseContent,
        model: 'mock-model',
        usage: { promptTokens: 10, completionTokens: 20, totalTokens: 30 },
      };
    },
  };
}

describe('LLM Generators — requirements', () => {
  it('generateRequirements parses title from # heading', async () => {
    const llm = createMockLlm('# Login System\n\n## Overview\nA login system.');
    const result = await generateRequirements(llm, 'build a login', '');
    assert.equal(result.title, 'Login System');
    assert.ok(result.spec.includes('Login System'));
  });

  it('generateRequirements extracts acceptance criteria from - [ ] lines', async () => {
    const spec = [
      '# Auth',
      '',
      '## Features',
      '- [ ] Users can register',
      '- [ ] Users can login with email',
      '- [ ] Users can reset password',
      '',
      '## Non-functional',
      '- fast',
    ].join('\n');
    const llm = createMockLlm(spec);
    const result = await generateRequirements(llm, 'auth', '');
    assert.equal(result.acceptanceCriteria.length, 3);
    assert.ok(result.acceptanceCriteria[0].includes('register'));
  });

  it('generateRequirements returns untitled for missing heading', async () => {
    const llm = createMockLlm('just some text without heading');
    const result = await generateRequirements(llm, 'input', '');
    assert.equal(result.title, 'Untitled Requirement');
  });

  it('refineRequirements preserves structure', async () => {
    const llm = createMockLlm('# Updated Auth\n\n## Overview\nNow with SSO.');
    const result = await refineRequirements(llm, '# Auth\n\n## Overview\nBasic auth.', 'add SSO');
    assert.ok(result.title);
    assert.ok(result.spec);
  });
});

describe('LLM Generators — design', () => {
  const designSpec = [
    '# Auth Design',
    '',
    '## Tech Stack',
    '- Node.js',
    '',
    '## Modules',
    '',
    '### AuthModule',
    '- **职责**：handles authentication',
    '- **文件路径**：src/auth/**/*.ts',
    '- **依赖模块**：[]',
    '',
    '### UserModule',
    '- **职责**：handles users',
    '- **文件路径**：src/user/**/*.ts',
    '- **依赖模块**：[AuthModule]',
  ].join('\n');

  it('generateDesign parses modules from ### headings', async () => {
    const llm = createMockLlm(designSpec);
    const result = await generateDesign(llm, 'req spec', '');
    assert.equal(result.title, 'Auth Design');
    assert.equal(result.modules.length, 2);
    assert.equal(result.modules[0].name, 'AuthModule');
    assert.equal(result.modules[1].name, 'UserModule');
  });

  it('generateDesign extracts file patterns and dependencies', async () => {
    const llm = createMockLlm(designSpec);
    const result = await generateDesign(llm, 'req spec', '');
    assert.deepEqual(result.modules[0].filePatterns, ['src/auth/**/*.ts']);
    assert.deepEqual(result.modules[1].dependencies, ['AuthModule']);
  });

  it('refineDesign returns updated content', async () => {
    const llm = createMockLlm('# Updated Design\n\n## Modules\n\n### NewModule\n- **职责**：new');
    const result = await refineDesign(llm, '# Old Design', 'simplify');
    assert.ok(result.title);
    assert.ok(result.modules.length >= 0);
  });
});

describe('LLM Generators — slice plan', () => {
  const planJson = JSON.stringify({
    title: 'Test Plan',
    versions: [
      {
        version: 'v1',
        description: 'Core',
        dependsOn: [],
        slices: [
          { id: 'v1-core', module: 'Core', title: 'Core feature', writes: ['src/core/**'] },
        ],
      },
    ],
  });

  it('generateSlicePlan parses JSON response', async () => {
    const llm = createMockLlm(planJson);
    const result = await generateSlicePlan(llm, 'design body', [], '');
    assert.equal(result.title, 'Test Plan');
    assert.equal(result.versions.length, 1);
    assert.equal(result.versions[0].version, 'v1');
    assert.equal(result.versions[0].slices.length, 1);
  });

  it('generateSlicePlan handles markdown-wrapped JSON', async () => {
    const wrapped = '```json\n' + planJson + '\n```';
    const llm = createMockLlm(wrapped);
    const result = await generateSlicePlan(llm, 'design body', [], '');
    assert.equal(result.versions.length, 1);
  });

  it('generateSlicePlan sets correct slice properties', async () => {
    const llm = createMockLlm(planJson);
    const result = await generateSlicePlan(llm, 'design body', [], '');
    const slice = result.versions[0].slices[0];
    assert.equal(slice.id, 'v1-core');
    assert.equal(slice.module, 'Core');
    assert.equal(slice.specPath, 'specs/slices/v1-core.md');
    assert.equal(slice.state, 'draft');
    assert.equal(result.versions[0].status, 'planned');
  });

  it('generateVersion parses single version JSON', async () => {
    const versionJson = JSON.stringify({
      version: 'v3',
      description: 'New version',
      dependsOn: ['v2'],
      slices: [
        { id: 'v3-new', module: 'New', title: 'New feature', writes: ['src/new/**'] },
      ],
    });
    const llm = createMockLlm(versionJson);
    const result = await generateVersion(llm, 'design', [], 'add new feature');
    assert.equal(result.version, 'v3');
    assert.equal(result.description, 'New version');
    assert.deepEqual(result.dependsOn, ['v2']);
    assert.equal(result.slices.length, 1);
    assert.equal(result.status, 'planned');
  });
});
