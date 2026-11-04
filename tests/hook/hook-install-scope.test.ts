// git hooks 的安装作用域：只装进「被管理的项目」
//
// 背景：zelto 工具自身的仓库不是被管理的项目 —— 它是工具。
// 在工具仓库里跑 `zelto hook --install`，钩子应该装到配置里的
// targetProject（真正被 zelto 管着的那个仓库）里去，而不是装进工具仓库。

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  isManagedProject,
  isZeltoToolCheckout,
  resolveHookInstallRoot,
} from '../../src/cli/commands/hook-install.js';

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), 'zelto-hook-scope-'));
}

describe('resolveHookInstallRoot', () => {
  it('装进当前目录 —— 当前目录就是被管理的项目', () => {
    const dir = tempDir();
    try {
      mkdirSync(join(dir, '.zelto'), { recursive: true });
      const scope = resolveHookInstallRoot(dir);
      assert.equal(scope.root, dir);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('工具仓库不装 —— 改装配置里的 targetProject', () => {
    const base = tempDir();
    const toolDir = join(base, 'tool');
    const targetDir = join(base, 'target');
    mkdirSync(toolDir, { recursive: true });
    mkdirSync(targetDir, { recursive: true });
    try {
      // 造一个「zelto 工具仓库」的形态
      writeFileSync(
        join(toolDir, 'package.json'),
        JSON.stringify({ name: 'zelto', version: '0.1.0' }),
        'utf-8',
      );
      mkdirSync(join(toolDir, 'src', 'hook'), { recursive: true });
      writeFileSync(join(toolDir, 'src', 'hook', 'index.ts'), '// hook\n', 'utf-8');
      mkdirSync(join(toolDir, '.zelto'), { recursive: true });
      writeFileSync(
        join(toolDir, '.zelto', 'config.yaml'),
        ['targetProject:', '  path: "../target"', ''].join('\n'),
        'utf-8',
      );

      const scope = resolveHookInstallRoot(toolDir);
      assert.equal(scope.root, targetDir, '应该指向 targetProject 目录');
      assert.ok(scope.reason.includes('targetProject'), '理由里应说明是 targetProject');
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  it('工具仓库没有 targetProject —— 不装', () => {
    const toolDir = tempDir();
    try {
      writeFileSync(
        join(toolDir, 'package.json'),
        JSON.stringify({ name: 'zelto', version: '0.1.0' }),
        'utf-8',
      );
      mkdirSync(join(toolDir, 'src', 'hook'), { recursive: true });
      writeFileSync(join(toolDir, 'src', 'hook', 'index.ts'), '// hook\n', 'utf-8');

      const scope = resolveHookInstallRoot(toolDir);
      assert.equal(scope.root, null);
      assert.ok(scope.reason.includes('只装在被管理的项目里'));
    } finally {
      rmSync(toolDir, { recursive: true, force: true });
    }
  });

  it('普通目录 —— 不装', () => {
    const dir = tempDir();
    try {
      const scope = resolveHookInstallRoot(dir);
      assert.equal(scope.root, null);
      assert.ok(scope.reason.includes('不是被 zelto 管理的项目'));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('项目形态判定', () => {
  it('isManagedProject 看 .zelto/ 是否存在', () => {
    const dir = tempDir();
    try {
      assert.equal(isManagedProject(dir), false);
      mkdirSync(join(dir, '.zelto'), { recursive: true });
      assert.equal(isManagedProject(dir), true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('isZeltoToolCheckout 看包名 + 源码形态', () => {
    const dir = tempDir();
    try {
      writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'zelto' }), 'utf-8');
      assert.equal(isZeltoToolCheckout(dir), false, '没有 src/hook/index.ts 就不算工具源码库');
      mkdirSync(join(dir, 'src', 'hook'), { recursive: true });
      writeFileSync(join(dir, 'src', 'hook', 'index.ts'), '// hook\n', 'utf-8');
      assert.equal(isZeltoToolCheckout(dir), true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
