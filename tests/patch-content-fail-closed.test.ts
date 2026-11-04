/**
 * patch-content fail-closed —— 未识别参数拒绝，非交互失败必须有明确报错。
 *
 * 回归来源：非交互模式 `git diff` 失败或空 diff 时静默返回 null，
 * 调用方只看到退出码 1，不知道是「不是 git 仓库」还是「没有变更」。
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import '../src/cli/commands/index.js';
import { commands } from '../src/cli/commands/shared.js';
import { runPatchContent } from '../src/cli/commands/patch-content.js';

describe('patch-content fail-closed', () => {
  it('--help 只打印用法，退出 0', async () => {
    const code = await commands['patch-content'](['--help']);
    assert.equal(code, 0);
  });

  it('未知参数直接拒绝', async () => {
    const code = await commands['patch-content'](['--bogus']);
    assert.equal(code, 1);
  });

  it('--source 缺值直接拒绝', async () => {
    const code = await commands['patch-content'](['--source']);
    assert.equal(code, 1);
  });

  it('--source 非法取值直接拒绝', async () => {
    const code = await commands['patch-content'](['--source', 'weird', '--all-to', 's1']);
    assert.equal(code, 1);
  });

  it('runPatchContent 非法 source 返回 null（已打印原因）', async () => {
    const result = await runPatchContent('weird', 's1');
    assert.equal(result, null);
  });
});
