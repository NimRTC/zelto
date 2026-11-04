/**
 * halt fail-closed —— 状态型命令对未识别参数必须拒绝，不能默认拉闸。
 *
 * 回归来源：`zelto halt --help` 在旧实现里被当成一次 scope=all 的真拉闸。
 * 拉闸写 `.zelto/halts/` + `batch.halted` 事件，有副作用的参数必须先校验。
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import '../src/cli/commands/index.js';
import { commands } from '../src/cli/commands/shared.js';

describe('halt fail-closed', () => {
  const originalCwd = process.cwd();
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'zelto-halt-fail-closed-'));
    process.chdir(dir);
  });

  afterEach(() => {
    process.chdir(originalCwd);
    rmSync(dir, { recursive: true, force: true });
  });

  it('--help 只打印用法，不写暂停请求', async () => {
    const code = await commands['halt'](['--help']);
    assert.equal(code, 0);
    assert.equal(existsSync(join(dir, '.zelto', 'halts')), false);
  });

  it('未知参数直接拒绝，不写暂停请求', async () => {
    const code = await commands['halt'](['--bogus']);
    assert.equal(code, 1);
    assert.equal(existsSync(join(dir, '.zelto', 'halts')), false);
  });

  it('多余的位置参数直接拒绝，不写暂停请求', async () => {
    const code = await commands['halt'](['all']);
    assert.equal(code, 1);
    assert.equal(existsSync(join(dir, '.zelto', 'halts')), false);
  });

  it('--scope 缺值直接拒绝，不写暂停请求', async () => {
    const code = await commands['halt'](['--scope']);
    assert.equal(code, 1);
    assert.equal(existsSync(join(dir, '.zelto', 'halts')), false);
  });

  it('--list 与 --clear 互斥，同时出现直接拒绝', async () => {
    const code = await commands['halt'](['--list', '--clear']);
    assert.equal(code, 1);
    assert.equal(existsSync(join(dir, '.zelto', 'halts')), false);
  });
});
