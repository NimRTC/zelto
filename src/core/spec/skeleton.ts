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
 * 验收目标下的骨架文件路径（相对仓库根）。
 *
 * 目录形态 → `<dir>/acceptance.test.cjs`；文件形态 → 那个文件本身。
 *
 * 单独抽出来是因为**写集也要用它**（ADR-046）：骨架是 zelto 生成的
 * `test.todo` 列表，agent 必须把它改成真正的断言 —— 而这需要它落在
 * 写集里，否则 hook 会拦住 agent 改它。
 */
export function acceptanceSkeletonTarget(acceptanceDir: string, root: string = process.cwd()): string {
  const raw = acceptanceDir.trim();
  const normalized = raw.replace(/[\\/]+$/, '');
  const abs = join(root, normalized);
  const isDirShape = raw.endsWith('/') || raw.endsWith('\\') || (existsSync(abs) && statSync(abs).isDirectory());
  // 路径统一成**正斜杠**（ADR-051 配套）：写集里的路径最终要与策略引擎、
  // hook 的判定比大小，而那些地方都按正斜杠归一。这里用 join() 会得到
  // Windows 的反斜杠 —— 同一个文件在写集里出现两次（`a/b` 与 `a\b`），
  // 重复项、且与规格里写的路径对不上。
  const target = isDirShape ? `${normalized}/${SKELETON_FILE_NAME}` : normalized;
  return target.replace(/\\/g, '/');
}

/**
 * 写集边界断言的**正确写法**（ADR-075）。
 *
 * 病灶（实测于 nimrtc-zelto，2026-11-18）：
 *
 *   agent 常在验收测试里加一条「写集边界」断言，判据写成
 *   「`git diff --name-only` 的结果非空」「必须包含某个文件」。
 *   这种判据**只在切片尚未合并时成立** ——
 *   门禁在 agent 的 worktree 里跑时看到的是未提交改动，断言成立；
 *   切片合并进版本分支、worktree 被清理之后，在主干复跑同一份验收，
 *   `git diff` 为空，**断言红**。
 *
 *   而「这次切片改了哪些文件」是一个**历史事件**（合并前后不一样），
 *   「这次切片的产物在不在树上」是一个**状态**（合并前后一样）。
 *   追溯链（C4：事后可审计）要求结论可复现，所以断言必须判**状态**。
 *
 * 为什么放在骨架里：ADR-034 的骨架负责「每条验收标准一条用例」，
 * 但从来没人告诉 agent「这条断言该怎么写才不出错」——
 * 真空在这里被填上，而不是等每个 agent 各踩一次。
 *
 * 模板给出的是**可直接抄的形态**，不是散文描述：
 * agent 只要把路径换成自己写集里的具体路径即可。
 */
export const WRITE_SET_ASSERTION_GUIDE = `// ─── 写集边界断言（ADR-075）────────────────────────────────────────────────
//
// 如果你要断言「本片改了哪些文件」，**不要用 \`git diff\`**。
//
//   错（只在未合并状态成立）：
//     const changed = gitDiff('--name-only');
//     assert.ok(changed.length >= 1, '写集内必须存在已追踪文件的改动');
//     assert.ok(changed.includes('xxx'), '本片必须改 xxx');
//   → 门禁在 worktree 里跑时绿；切片合并、worktree 清理后，主干复跑变红。
//     同一份产品代码，两种状态两个结论 —— 追溯链断在这里。
//
//   对（任何状态都成立）：判「产物在不在树上」
//     const tracked = new Set(gitLsFiles());
//     assert.ok(tracked.has('xxx'), 'xxx 必须在树上');
//
// 「这次切片改了哪些文件」是**历史事件**（合并前后不一样）；
// 「这次切片的产物在不在树上」是**状态**（合并前后一样）。
// 追溯链要求结论可复现 → 断言必须判状态。
//
// 附：两个可直接用的辅助函数
//   function gitLsFiles() { return gitOut(['ls-files']); }        // 树上所有已追踪文件
//   function gitOut(args) {
//     const r = spawnSync('git', args, { cwd: ROOT, encoding: 'utf8' });
//     return (r.stdout || '').split(/\\r?\\n/).filter(Boolean);
//   }
//
// 越界守卫（写集外的文件不该由本片引入）也写成状态式：
//   const base = gitOut(['merge-base', 'HEAD', '<切片基点 commit>']);
//   const touched = gitOut(['diff', '--name-only', '<基点>', 'HEAD']);
//   → 用「基点之后的提交改了什么」而不是「当前工作区脏不脏」
//   （后者会误伤别的切片留下的合法改动）。
`;

/**
 * 生成验收测试骨架的正文。
 *
 * 每条验收标准一条 `todo` 用例，用例名就是验收标准原文 —— 人和 agent
 * 都能一眼看出「这条验收标准对应哪个用例、还没写」。
 *
 * 末尾附「写集边界断言的正确写法」（ADR-075）—— 骨架是 agent 抄的东西，
 * 缺的说明它就自己发明，于是发明出只在一种状态下成立的断言。
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
  lines.push(WRITE_SET_ASSERTION_GUIDE);
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
  opts?: { force?: boolean },
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
    // 正斜杠（ADR-051 配套）：写集路径要与策略引擎、hook 的判定对齐，
    // 那些地方都按正斜杠归一；join() 在 Windows 上给的是反斜杠。
    target = `${normalized}/${SKELETON_FILE_NAME}`;
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
  if (existsSync(targetAbs) && !opts?.force) {
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
