/**
 * lock.command.ts — `zelto policy lock` 子命令
 *
 * 查看 / 更新策略哈希锚点（C5）。
 *
 * 锚点存 `policy/lock.json`，独立于策略本身：
 *   - 策略被改过而锚点没动 → **失配**（可检出）
 *   - 改锚是人的决定 —— 只有显式 `--update` 才改
 *
 * C3：纯文件判定 + 纯计算，不调模型、不触网。
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  POLICY_LOCK_PATH,
  checkPolicyAnchor,
  computePolicyHash,
  writePolicyLock,
} from '../../../core/policy/lock.js';
import { colors } from '../../color.js';
import { writeOutput } from '../../output.js';

export interface PolicyLockOptions {
  /** 显式改锚（人的决定） */
  update?: boolean;
  /** JSON 输出 */
  json?: boolean;
}

/**
 * `zelto policy lock`
 *
 * 不带 `--update` 时只看不改：输出锚点值、当前哈希、失配与否。
 * 失配时退出码 1 —— 这样它可以直接当门禁用。
 */
export async function lockPolicy(options: PolicyLockOptions): Promise<number> {
  const rootDir = process.cwd();
  const policyPath = join(rootDir, 'policy', 'policy.yaml');

  if (options.update) {
    if (!existsSync(policyPath)) {
      const message = `Policy file not found: policy/policy.yaml`;
      if (options.json) {
        writeOutput({ ok: false, updated: false, message }, undefined, { json: true });
      } else {
        console.error(`${colors.red('✗')} ${message}`);
        console.error(`  ${colors.dim('先跑 zelto init 或 zelto project init 生成策略。')}`);
      }
      return 1;
    }

    const current = computePolicyHash(readFileSync(policyPath, 'utf-8'));
    writePolicyLock(rootDir, {
      version: 1,
      policy: current,
      lockedAt: new Date().toISOString(),
      source: 'manual',
    });

    if (options.json) {
      writeOutput({ ok: true, updated: true, policy: current }, undefined, { json: true });
    } else {
      console.log(`${colors.green('✓')} 锚点已更新：${POLICY_LOCK_PATH}`);
      console.log(`  ${colors.dim(current)}`);
    }
    return 0;
  }

  const status = checkPolicyAnchor(rootDir);

  if (options.json) {
    writeOutput(
      {
        ok: !status.mismatch,
        lockFile: POLICY_LOCK_PATH,
        hasLock: status.hasLock,
        locked: status.locked,
        current: status.current,
        mismatch: status.mismatch,
        lockedAt: status.lockedAt,
        source: status.source,
      },
      undefined,
      { json: true },
    );
    return status.mismatch ? 1 : 0;
  }

  if (!status.hasLock) {
    console.log(`${colors.yellow('⚠')} 尚未锚定 —— ${POLICY_LOCK_PATH} 不存在`);
    console.log(`  ${colors.dim('锚定后，策略被改动就能被检出。跑 zelto policy lock --update 锚定。')}`);
    return 0;
  }

  console.log(`${colors.bold('策略锚点')}（${POLICY_LOCK_PATH}）`);
  console.log(`  锚点:   ${status.locked}`);
  console.log(`  当前:   ${status.current}`);
  console.log(`  锚定于: ${status.lockedAt ?? '（未知）'}`);
  console.log(`  来源:   ${status.source === 'generated' ? 'zelto 生成' : '人工锚定'}`);

  if (status.mismatch) {
    console.log('');
    console.log(`${colors.red('✗')} 失配：策略内容与锚点对不上。`);
    console.log(`  ${colors.dim('策略被改过而锚点没动。确认改动是有意的，跑 zelto policy lock --update 改锚。')}`);
    return 1;
  }

  console.log('');
  console.log(`${colors.green('✓')} 锚点一致。`);
  return 0;
}
