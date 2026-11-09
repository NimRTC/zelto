// 策略锚点的外部化存储 —— `policy/lock.json`
//
// C5：保护域硬编码、不可被任何策略规则覆盖；**策略哈希锚点存于
// `policy/lock.json`，独立于策略本身**。
//
// 为什么锚点必须放在策略之外：
// 策略文件自己声明「我的哈希是 X」是**自证** —— 改策略的人顺手把哈希也
// 改掉，事后就看不出「当时按什么标准拦的」被换过。锚点独立存放之后，
// 「策略被改过但锚点没动」就是一件**可检出**的事：哈希对不上，失配。
//
// 这份文件是纯数据 + 纯计算（读文件、算哈希、比对），不调模型、不触网（C3）。

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { hashPolicy } from './engine.js';

/** 锚点文件相对仓库根的路径 */
export const POLICY_LOCK_PATH = 'policy/lock.json';

/** 锚点文件的格式版本 */
export const POLICY_LOCK_VERSION = 1;

/** 一条锚点记录 */
export interface PolicyLock {
  /** 格式版本 */
  version: number;
  /** 策略内容哈希（`sha256:<hex>`） */
  policy: string;
  /** 锚定时间 */
  lockedAt: string;
  /** 锚点来源：`generated` = zelto 生成策略时锚定；`manual` = 人手写策略时锚定 */
  source: 'generated' | 'manual';
}

/** 锚点与当前策略的比对结果 */
export interface PolicyAnchorStatus {
  /** 锚点文件在不在 */
  hasLock: boolean;
  /** 锚点记的哈希（没有锚点时为 null） */
  locked: string | null;
  /** 当前策略内容的哈希（策略文件不在时为 null） */
  current: string | null;
  /** 两者是否对不上（只有两边都有值时才可能为 true） */
  mismatch: boolean;
  /** 锚定时间 */
  lockedAt: string | null;
  /** 锚点来源 */
  source: 'generated' | 'manual' | null;
}

/** 锚点文件在仓库里的绝对路径 */
export function policyLockPath(rootDir: string): string {
  return join(rootDir, POLICY_LOCK_PATH);
}

/**
 * 读锚点。
 *
 * 读不出来（文件不存在 / 不是合法 JSON / 字段不对）一律当作「没有锚点」——
 * 锚点读不出来时不能当成「策略没被改过」，那会让失配检查形同虚设。
 */
export function readPolicyLock(rootDir: string): PolicyLock | null {
  const path = policyLockPath(rootDir);
  if (!existsSync(path)) return null;
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf-8')) as Partial<PolicyLock>;
    if (typeof parsed?.policy !== 'string' || parsed.policy.length === 0) return null;
    return {
      version: typeof parsed.version === 'number' ? parsed.version : POLICY_LOCK_VERSION,
      policy: parsed.policy,
      lockedAt: typeof parsed.lockedAt === 'string' ? parsed.lockedAt : '',
      source: parsed.source === 'generated' ? 'generated' : 'manual',
    };
  } catch {
    return null;
  }
}

/**
 * 写锚点。
 *
 * 写之前先建目录 —— `policy/` 可能还不存在（人还没跑过 init）。
 */
export function writePolicyLock(rootDir: string, lock: PolicyLock): void {
  const path = policyLockPath(rootDir);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(lock, null, 2) + '\n', 'utf-8');
}

/** 策略内容的哈希（锚点记的就是它） */
export function computePolicyHash(content: string): string {
  return hashPolicy(content);
}

/**
 * 比对锚点与当前策略。
 *
 * `mismatch` 只在**两边都有值**且不相等时为真：
 * - 没有锚点 → 还没锚定，不是失配（由调用方决定要不要锚）
 * - 没有策略文件 → 没东西可比，不是失配
 */
export function checkPolicyAnchor(rootDir: string): PolicyAnchorStatus {
  const lock = readPolicyLock(rootDir);
  const policyPath = join(rootDir, 'policy', 'policy.yaml');
  const current = existsSync(policyPath)
    ? computePolicyHash(readFileSync(policyPath, 'utf-8'))
    : null;

  const locked = lock?.policy ?? null;
  return {
    hasLock: lock !== null,
    locked,
    current,
    mismatch: locked !== null && current !== null && locked !== current,
    lockedAt: lock?.lockedAt ?? null,
    source: lock?.source ?? null,
  };
}
