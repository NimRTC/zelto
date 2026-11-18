/**
 * atomic-write.ts —— 可核对的文件写入原语（ADR-082）
 *
 * ## 为什么需要它
 *
 * 实战演练里反复出现同一个形状（D-31）：
 *
 * > 工具报告「✓ 已修改」，但文件一个字节没变。
 *
 * 根因是「报告成功」只靠「我调用了写文件的 API」，
 * 而没有任何**独立证据**证明文件现在的内容就是调用方要写的内容。
 *
 * ADR-070 只给 policy 的分段编辑路径补了「先确认段/条目在」的防线，
 * 其它写路径没有同构防线。这个原语把防线下沉到写入口本身。
 *
 * ## 保证
 *
 * 1. **原子替换**：同目录临时文件 + `rename`。目标文件要么是旧内容，
 *    要么是完整的新内容 —— 不会停在「截断了一半」的状态。
 * 2. **写完必验**：读回目标文件，与预期内容逐字节比对；不一致直接抛错。
 * 3. **失败必抛**：不吞异常，不返回「看起来成功」的结果。
 * 4. **成功有凭据**：返回值带字节数、SHA-256 哈希、是否发生变化。
 *
 * ## 不变量
 *
 * - C1：状态只在文件里 —— 这里只负责把内容可靠地落到文件。
 * - C2：只用 Node 内置模块，零第三方运行时依赖。
 * - C3：纯文件读写与哈希计算，不调模型、不触网。
 */

import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

/** 一次成功写入的可核对凭据 */
export interface WriteReceipt {
  /** 写入的绝对路径 */
  path: string;
  /** 写入内容的 UTF-8 字节数 */
  bytes: number;
  /** 写入内容的 SHA-256，形如 `sha256:<hex>` */
  hash: string;
  /** 与写前内容相比是否发生了变化 */
  changed: boolean;
}

/** 写完后读回比对失败时抛出的异常 */
export class WriteVerificationError extends Error {
  readonly path: string;

  constructor(path: string, detail: string) {
    super(`写入验证失败：${path} —— ${detail}`);
    this.name = 'WriteVerificationError';
    this.path = path;
  }
}

/** 内容哈希（与 `core/policy/engine.ts` 的锚点算法保持同一形态） */
export function hashContent(content: string): string {
  return `sha256:${createHash('sha256').update(content, 'utf-8').digest('hex')}`;
}

/**
 * 原子写入文本文件，并读回验证。
 *
 * @param path - 目标路径（父目录不存在时自动创建）
 * @param content - 要写入的完整内容
 * @returns 可核对的写入凭据
 * @throws 写入失败或读回比对不一致时抛错
 */
export async function atomicWriteText(path: string, content: string): Promise<WriteReceipt> {
  const absolute = path;
  const bytes = Buffer.byteLength(content, 'utf-8');
  const hash = hashContent(content);

  const previous = await readIfExists(absolute);
  const changed = previous !== content;

  await mkdir(dirname(absolute), { recursive: true });

  // 同目录临时文件 —— 保证 `rename` 在同一文件系统内（跨盘会失败）
  const tempPath = join(dirname(absolute), `.${basename(absolute)}.zelto-${process.pid}-${Date.now()}.tmp`);

  try {
    await writeFile(tempPath, content, 'utf-8');
    await rename(tempPath, absolute);
  } catch (err) {
    // 失败时清掉临时文件，别留半截产物
    await rm(tempPath, { force: true }).catch(() => {});
    throw err;
  }

  // ─── 写完必须读回比对 ───
  // 「我调用了 writeFile 所以成功了」不是证据。
  // 读回来的字节与预期不一致 —— 抛错，让调用方不能报告成功。
  const actual = await readFile(absolute, 'utf-8');
  if (actual !== content) {
    throw new WriteVerificationError(
      absolute,
      `读回内容与预期不一致（预期 ${bytes} 字节 / ${hash}，实际 ${Buffer.byteLength(actual, 'utf-8')} 字节 / ${hashContent(actual)}）`,
    );
  }

  return { path: absolute, bytes, hash, changed };
}

/**
 * 原子写入 JSON 文件（两空格缩进，与项目既有状态文件格式一致）。
 */
export async function atomicWriteJson(path: string, value: unknown): Promise<WriteReceipt> {
  return atomicWriteText(path, `${JSON.stringify(value, null, 2)}\n`);
}

/** 文件不存在时返回 null；读取失败则让异常向上冒（不吞） */
async function readIfExists(path: string): Promise<string | null> {
  if (!existsSync(path)) return null;
  return readFile(path, 'utf-8');
}

/** 取文件名（临时文件命名用） */
function basename(path: string): string {
  const normalized = path.replace(/\\/g, '/');
  const index = normalized.lastIndexOf('/');
  return index === -1 ? normalized : normalized.slice(index + 1);
}
