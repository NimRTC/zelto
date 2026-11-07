// 验收测试骨架 —— 把规格里的「验收标准」变成能跑的测试骨架
//
// 背景（ADR-034）：门禁②（ADR-033）会去跑本片的验收目标，但此前**没有任何东西
// 生成验收测试** —— 于是 `slice.acceptance.dir` 只是一个路径提示，门禁只能报
// 「验收目标不存在」。规格里写了验收标准，却没落到任何能跑的断言上：
// 规格与门禁之间断了一截。
//
// 这里按规格正文的验收标准逐条生成 `test.todo(...)`：
//
//   - 骨架**存在**，门禁②找得到目标、能真的把命令跑起来；
//   - 骨架**不假装通过** —— todo 不算「跑过的用例」。门禁②会识别
//     「一个用例都没真正执行」的验收文件并判 failed（见 gate/acceptance.ts 的
//     verifyAcceptanceRanTests），所以 todo 必须被换成真正的断言。
//
// C3: 纯文本生成 + 写文件，不调模型、不触网。

import { existsSync, mkdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { extractAcceptanceCriteria } from './trace-extract.js';

/** 骨架文件名 —— 必须能被门禁的测试文件识别规则（isTestFileName）认出来 */
export const SKELETON_FILE_NAME = 'acceptance.test.cjs';

/** 骨架生成的结果 */
export interface SkeletonResult {
  /** 骨架文件路径；没生成时为 null */
  path: string | null;
  /** 生成了几条用例 */
  caseCount: number;
  /** 没生成的原因（中文，给人看）；生成成功时为 null */
  reason: string | null;
  /** 目标已存在、没覆盖时为 true */
  skippedExisting?: boolean;
}

/**
 * 生成验收测试骨架的正文。
 *
 * 每条验收标准一条 `todo` 用例，用例名就是验收标准原文 —— 人和 agent
 * 都能一眼看出「这条验收标准对应哪个用例、还没写」。
 */
export function buildAcceptanceSkeleton(sliceId: string, criteria: string[]): string {
  const lines: string[] = [
    '// 验收测试骨架 —— 由 `zelto spec draft` 生成（ADR-034）',
    '//',
    '// 这份文件是**骨架**：每条验收标准对应一条 `todo` 用例，等着被实现成真正的断言。',
    '// 门禁②会识别「没有一条用例真正跑起来」的验收文件并判 failed ——',
    '// 所以 todo 必须被替换成实际断言，不能留着当「已验证」。',
    `// 切片：${sliceId}`,
    '//',
    '// 改这块文件不会影响规格 —— 规格在 specs/slices/ 下，两者各自独立。',
    "const { test } = require('node:test');",
    '',
  ];

  for (const criterion of criteria) {
    lines.push(`test.todo(${JSON.stringify(criterion)});`);
  }

  lines.push('');
  return lines.join('\n');
}

/**
 * 把验收测试骨架写到本片的验收目标下。
 *
 * 验收目标有两种形态（既有代码里两种都真实存在）：
 *   - 目录：`tests/acceptance/<id>/` → 骨架写 `<目录>/acceptance.test.cjs`；
 *   - 文件：`tests/acceptance/<id>.test.ts` → 那是人自己的文件，**不覆盖**。
 *
 * @param acceptanceDir 切片登记的验收路径
 * @param specContent 规格正文（验收标准从里面取）
 * @param root 仓库根（相对路径按它解析）
 */
export function writeAcceptanceSkeleton(
  acceptanceDir: string | undefined | null,
  specContent: string,
  sliceId: string,
  root: string = process.cwd(),
): SkeletonResult {
  const raw = (acceptanceDir ?? '').trim();
  if (!raw) {
    return { path: null, caseCount: 0, reason: '本片没有登记验收目录，无法生成骨架' };
  }

  const criteria = extractAcceptanceCriteria(specContent).map((c) => c.text);
  if (criteria.length === 0) {
    return {
      path: null,
      caseCount: 0,
      reason: '规格里没有可用的验收标准条目（编号列表），无法生成骨架',
    };
  }

  const normalized = raw.replace(/[\\/]+$/, '');
  const abs = join(root, normalized);
  const isDirShape = raw.endsWith('/') || raw.endsWith('\\') || (existsSync(abs) && statSync(abs).isDirectory());

  let target: string;
  if (isDirShape) {
    target = join(normalized, SKELETON_FILE_NAME);
  } else {
    // 文件形态：那是人自己登记的验收文件，不覆盖
    if (existsSync(join(root, normalized))) {
      return {
        path: null,
        caseCount: 0,
        reason: `验收文件已存在，未覆盖：${normalized}`,
        skippedExisting: true,
      };
    }
    target = normalized;
  }

  const targetAbs = join(root, target);
  if (existsSync(targetAbs)) {
    return {
      path: null,
      caseCount: 0,
      reason: `验收骨架已存在，未覆盖：${target}`,
      skippedExisting: true,
    };
  }

  mkdirSync(dirname(targetAbs), { recursive: true });
  writeFileSync(targetAbs, buildAcceptanceSkeleton(sliceId, criteria), 'utf-8');

  return { path: target, caseCount: criteria.length, reason: null };
}
