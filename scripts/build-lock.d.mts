// `scripts/build-lock.mjs` 的类型声明（ADR-080）。
//
// 锁的实现见 `build-lock.mjs` —— 那里有完整的设计说明。

/** 锁目录名（放在仓库根下） */
export declare const LOCK_NAME: string;

/**
 * 拿构建锁。拿不到就**等**，等不到（超时）就抛错。
 *
 * @param root 仓库根目录
 * @param timeoutMs 等不到锁就放弃的上限（毫秒）
 * @returns 锁目录路径（release 时传回去）
 */
export declare function acquireBuildLock(root: string, timeoutMs?: number): string;

/** 放锁 */
export declare function releaseBuildLock(lockDir: string): void;

/**
 * 在锁内跑一段逻辑。
 *
 * **异常时也放锁** —— 锁漏了会把后面的构建永久卡住。
 */
export declare function withBuildLock<T>(
  root: string,
  fn: () => T,
  timeoutMs?: number,
): T;
