// `zelto spec check` —— 规格符合性检查（Spec 轴）
//
// 做什么：把「agent 实际改了什么」与「规格要求了什么」摆在一起比，
// 报出三类结论：
//
//   implemented —— 规格要求的，代码里有证据
//   missing     —— 规格要求的，代码里找不到证据
//   unrequested —— 代码里有的，规格没点名（范围蔓延）
//
// 这与门禁②不重复：门禁②跑验收测试，**测试通过 ≠ 实现忠实于规格**。
// 规格里没写、代码里多出来的东西，现在只有这一层能查。
//
// 为什么是确定性判定而不是让模型判：
//   C7 规定 llm/ 的产出只能当草稿；要当闸门就必须是确定性的（C3）。
//   所以这一层把「规格说了什么」与「代码里有什么」都变成可比对的结构，
//   再用字面比对规则比。同样的输入永远给同样的结论。
//
// 退出码：0 = 没有 missing；1 = 有 missing（规格要求的没做）。
// 范围蔓延与「判不了」只报告，不影响退出码 —— 它们是提醒，不是定论。

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { getDefaultFormatter } from '../output-formatter.js';
import { colors } from '../color.js';
import { register, store, events, existingWorktreePath, ZELTO_DIR } from './shared.js';
import {
  collectChangedFiles,
  evaluateConformance,
  readFileContents,
} from '../../core/spec-conformance/index.js';
import type { SliceData } from '../../core/slice/store.js';

/**
 * zelto **自己**放的文件清单 —— 这些不是 agent 的产物。
 *
 * 范围蔓延判定要把它们排除掉，否则每次检查都会报一堆假阳性：
 * 切片文件（`.zelto/slices/<id>.json`）、规格副本、验收目录、约束包镜像 ——
 * 全是 zelto 放进去的。报假阳性的检查等于没检查（人会习惯性忽略）。
 *
 * **要覆盖全部切片，不只是当前切片**：工作区里可能躺着别的切片的托管文件
 * （上一次跑的残留、并行批次里的其他片）。只排除当前片的那些，
 * 别人的托管文件照样会被报成蔓延 —— 那是同一族假阳性。
 */
async function collectManagedPaths(slice: SliceData): Promise<string[]> {
  const paths: string[] = [
    join(ZELTO_DIR, 'events'),
    join(ZELTO_DIR, 'slices'),
  ];

  // 全部切片的托管文件 —— 不只是当前切片。
  //
  // 工作区里可能躺着别的切片的托管文件（上次跑的残留、并行批次里的其他片）。
  // 只排除当前片的那些，别人的托管文件照样会被报成蔓延 —— 同一族假阳性。
  let slices: SliceData[] = [slice];
  try {
    const ids = await store.list();
    const others = await Promise.all(
      ids.map(async (id) => {
        try {
          return await store.read(id);
        } catch {
          return null;
        }
      }),
    );
    slices = [slice, ...others.filter((s): s is SliceData => s !== null)];
  } catch {
    /* 读不到就只用当前切片 */
  }

  for (const s of slices) {
    paths.push(join(ZELTO_DIR, 'slices', `${s.id}.json`));
    paths.push(join(ZELTO_DIR, 'events', s.id));
    paths.push(join(ZELTO_DIR, `${s.id}-bundle.json`));
    // 规格副本与验收目录 —— 逐片取自己的路径（按约定拼是猜，读文件是准的）
    if (s.spec?.path) paths.push(s.spec.path);
    if (s.acceptance?.dir) paths.push(s.acceptance.dir);
  }

  return [...new Set(paths.filter(Boolean))];
}

register('spec-check', async (args) => {
  const f = getDefaultFormatter();
  const asJson = args.includes('--json');

  const id = args.find((a) => !a.startsWith('--'));
  if (!id) {
    f.error('USAGE', 'Usage: zelto spec-check <slice-id> [--json]');
    f.out('       检查 agent 的改动是否忠实于切片规格（确定性判定）');
    return 1;
  }

  let slice;
  try {
    slice = await store.read(id);
  } catch {
    f.error('NOT_FOUND', `切片 "${id}" 不存在。`);
    return 1;
  }

  // 规格正文 —— 切片的规格路径是 `specs/slices/<id>.md`
  const specPath = slice.spec?.path ?? join('specs', 'slices', `${id}.md`);
  if (!existsSync(specPath)) {
    f.error('NOT_FOUND', `找不到规格文件：${specPath}`);
    return 1;
  }
  const specText = readFileSync(specPath, 'utf-8');

  // 改动事实 —— 在切片的 worktree 里跑 git（agent 的改动在那儿）
  const worktreePath = existingWorktreePath(id);
  const cwd = worktreePath ?? process.cwd();
  const baseRef = slice.baseCommit ?? 'HEAD';

  const changedFiles = collectChangedFiles(cwd, baseRef);
  const contents = readFileContents(
    cwd,
    changedFiles.map((f) => f.path),
  );

  // zelto 自己的托管文件不算范围蔓延（见 conformance.ts 的说明）——
  // 切片文件、规格副本、约束包镜像都是 zelto 放进去的，不是 agent 的产物。
  const managedPaths = await collectManagedPaths(slice);

  const report = evaluateConformance(specText, changedFiles, contents, { managedPaths });

  await events.append(id, 'spec.conformance_checked', 'zelto', {
    requirements: report.totalRequirements,
    implemented: report.implemented,
    missing: report.missing,
    unknown: report.unknown,
    scopeCreep: report.scopeCreep.length,
    filesConsidered: report.filesConsidered,
    baseRef,
    worktree: worktreePath,
  });

  if (asJson) {
    f.data({
      sliceId: id,
      specPath,
      baseRef,
      worktree: worktreePath,
      report,
    });
    return report.missing > 0 ? 1 : 0;
  }

  // ─── 文本输出 ────────────────────────────────────────────────────────
  f.out('');
  f.out(`${colors.bold(colors.cyan('规格符合性检查'))} ${colors.dim('（确定性判定，不调模型）')}`);
  f.out(`${colors.dim('切片:')} ${id}`);
  f.out(`${colors.dim('规格:')} ${specPath}`);
  f.out(`${colors.dim('基准:')} ${baseRef}${worktreePath ? colors.dim(` · worktree ${worktreePath}`) : ''}`);
  f.out(`${colors.dim('─'.repeat(56))}`);

  if (changedFiles.length === 0) {
    f.out('');
    f.out(`  ${colors.dim('没有检出任何改动 —— 本次不做符合性判断。')}`);
    return 0;
  }

  f.out('');
  f.out(`  ${colors.bold('要求')} ${colors.dim(`共 ${report.totalRequirements} 条 · 已实现 ${report.implemented} · 未实现 ${report.missing} · 判不了 ${report.unknown}`)}`);

  if (report.requirements.length > 0) {
    for (const req of report.requirements) {
      const mark =
        req.status === 'implemented'
          ? colors.green('✔')
          : req.status === 'missing'
            ? colors.red('✘')
            : colors.dim('?');
      f.out(`    ${mark} ${req.text}`);
      if (req.evidence.length > 0) {
        f.out(`      ${colors.dim(`证据: ${req.evidence.join(', ')}`)}`);
      }
      if (req.reason) {
        f.out(`      ${colors.dim(req.reason)}`);
      }
    }
  } else {
    f.out(`    ${colors.dim('（规格里没有可提取的要求条目 —— 没有验收标准，也没有需求章节）')}`);
  }

  if (report.scopeCreep.length > 0) {
    f.out('');
    f.out(`  ${colors.bold(`规格没点名的改动 (${report.scopeCreep.length})`)} ${colors.dim('范围蔓延 —— 报告给人看，不拦人')}`);
    for (const creep of report.scopeCreep) {
      f.out(`    ${colors.yellow('●')} ${creep.path} ${colors.dim(`(${creep.status})`)}`);
    }
  }

  f.out('');

  if (report.missing > 0) {
    f.error(
      'SPEC_NONCONFORMANCE',
      `有 ${report.missing} 条规格要求在改动里找不到实现证据。`,
    );
    f.out('   证据不足不等于没实现 —— 确认后要么补实现，要么改规格。');
    return 1;
  }

  f.success('规格要求的每一条都在改动里找到了实现证据。');
  return 0;
});
