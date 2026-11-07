// zelto spec —— 切片规格的「生成草稿 → 人确认」闭环（ADR-034）
//
// 为什么要有这一组命令（ADR-032 §4 方案三/四的续）：
//
//   工具自动写的占位规格（「1. 完成 XXX」）会**物化成本片的需求追溯**，
//   于是「追溯合格」变成 zelto 替人批准的需求 —— 追溯链看着完整而实际不是。
//   ADR-032 当时的处理是「占位规格故意留空验收标准，宁可让人被拦住」。
//   那是对的，但它只解决了「不许造假」，没解决「人怎么才能得到一份能用的规格」。
//
//   这一组命令补上后半段：
//     draft   —— 生成规格**草稿**（有 LLM 走模型，没有则确定性降级），落到草稿路径；
//     show    —— 看当前草稿 / 正式规格；
//     confirm —— 人确认后写进正式规格路径，之后才谈得上冻结与追溯物化。
//
// C7: llm/ 只产草稿 —— 草稿不参与任何判定，进下游必须经人 confirm。
// C2: 这一层只做参数装配与文件搬运，规格内容逻辑在 llm/ 与 core/ 里。

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { getDefaultFormatter } from '../output-formatter.js';
import { register, events, store, ZELTO_DIR, createLlmFromConfig } from './shared.js';
import { generateSliceSpec, type SliceSpecInput } from '../../llm/generators/slice-spec.js';
import { writeAcceptanceSkeleton } from '../../core/spec/skeleton.js';
import { VersionStore } from '../../core/version/store.js';

/** 草稿目录 —— 与正式规格目录分开，人没确认的东西不进 specs/ */
export const SPEC_DRAFT_DIR = join(ZELTO_DIR, 'drafts', 'specs');

/** 草稿文件路径 */
export function specDraftPath(id: string): string {
  return join(SPEC_DRAFT_DIR, `${id}.md`);
}

/** 切片在版本计划里的上下文（模块 / 版本 / 前置版本） */
interface SlicePlanContext {
  module: string;
  version: string;
  prerequisites: string[];
}

/**
 * 从已确认的版本计划里找这个切片的上下文。
 *
 * 找不到不是错误 —— 切片也可以脱离版本计划单独存在（`zelto create`），
 * 那时模块与版本就是「未知」，规格里如实写未知，不编造。
 */
async function findPlanContext(id: string): Promise<SlicePlanContext> {
  const versionStore = new VersionStore(ZELTO_DIR);
  const plans = await versionStore.list().catch(() => []);
  for (const summary of plans) {
    const plan = await versionStore.read(summary.id).catch(() => null);
    if (!plan) continue;
    for (const version of plan.versions) {
      const found = version.slices.find((s) => s.id === id);
      if (found) {
        return {
          module: found.module ?? '',
          version: version.version,
          prerequisites: version.dependsOn ?? [],
        };
      }
    }
  }
  return { module: '', version: '', prerequisites: [] };
}

/** 组装生成器需要的输入 */
async function buildSpecInput(id: string): Promise<SliceSpecInput> {
  const slice = await store.read(id);
  const ctx = await findPlanContext(id);
  return {
    sliceId: slice.id,
    title: slice.title,
    module: ctx.module,
    writes: slice.writes ?? [],
    version: ctx.version,
    requirements: slice.trace.requirements ?? [],
    prerequisites: ctx.prerequisites,
  };
}

/** 草稿生成的结果 */
export interface SpecDraftResult {
  /** 草稿文件路径 */
  path: string;
  /** 草稿正文 */
  content: string;
  /** 草稿来源：模型生成 / 确定性降级 / 复用已有草稿 */
  source: 'llm' | 'deterministic' | 'existing';
  /** 验收骨架生成结果 */
  skeleton: { path: string | null; caseCount: number; reason: string | null };
}

/**
 * 生成（或复用）一份规格草稿。
 *
 * 已有草稿时**不重新生成** —— 草稿是人正在审的东西，工具擅自覆盖等于
 * 把人的工作抹掉（也会白花一次模型调用）。
 */
export async function createSpecDraft(id: string): Promise<SpecDraftResult | null> {
  if (!(await store.exists(id))) return null;

  const slice = await store.read(id);
  const draftPath = specDraftPath(id);
  const existing = readDraft(id);
  if (existing !== null) {
    return {
      path: draftPath,
      content: existing,
      source: 'existing',
      skeleton: { path: null, caseCount: 0, reason: null },
    };
  }

  const input = await buildSpecInput(id);
  const llm = createLlmFromConfig(id, 'zelto');
  const content = await generateSliceSpec(llm, input);

  mkdirSync(dirname(draftPath), { recursive: true });
  writeFileSync(draftPath, content, 'utf-8');

  await events.append(id, 'draft.created', 'zelto', {
    kind: 'spec',
    id,
    title: slice.title,
    path: draftPath,
    source: llm ? 'llm' : 'deterministic',
  });

  const skeleton = writeAcceptanceSkeleton(slice.acceptance?.dir, content, id);

  return {
    path: draftPath,
    content,
    source: llm ? 'llm' : 'deterministic',
    skeleton: { path: skeleton.path, caseCount: skeleton.caseCount, reason: skeleton.reason },
  };
}

/** 读草稿；没有就返回 null */
function readDraft(id: string): string | null {
  const path = specDraftPath(id);
  if (!existsSync(path)) return null;
  try {
    return readFileSync(path, 'utf-8');
  } catch {
    return null;
  }
}

// ─── draft ─────────────────────────────────────────────────────────────────

async function handleDraft(args: string[]): Promise<number> {
  const f = getDefaultFormatter();
  const id = args[0];
  if (!id || id.startsWith('--')) {
    f.error('USAGE', 'Usage: zelto spec draft <slice-id>');
    return 1;
  }

  if (!(await store.exists(id))) {
    f.error('NOT_FOUND', `Slice "${id}" not found.`);
    return 1;
  }

  const draft = await createSpecDraft(id);
  if (!draft) {
    f.error('NOT_FOUND', `Slice "${id}" not found.`);
    return 1;
  }

  f.success(`草稿已生成：${draft.path}`);
  if (draft.source === 'existing') {
    f.out('  来源：已有草稿（未重新生成 —— 草稿是人在审的东西，工具不擅自覆盖）');
  } else {
    f.out(draft.source === 'llm' ? '  来源：模型生成' : '  来源：确定性降级（未配置 LLM）');
  }

  // 验收测试骨架：把规格里的验收标准落成能跑的测试位置
  if (draft.skeleton.path) {
    f.out(
      `  验收骨架：${draft.skeleton.path}（${draft.skeleton.caseCount} 条用例，全部是 todo —— 需要实现成真正的断言）`,
    );
  } else if (draft.skeleton.reason) {
    f.warn(`  验收骨架未生成：${draft.skeleton.reason}`);
  }

  f.out('');
  f.out('下一步：');
  f.out(`  1) 审阅并按需修改草稿：${draft.path}`);
  f.out(`  2) 确认后写进正式规格：zelto spec confirm ${id}`);

  return 0;
}

// ─── show ──────────────────────────────────────────────────────────────────

async function handleShow(args: string[]): Promise<number> {
  const f = getDefaultFormatter();
  const id = args[0];
  if (!id || id.startsWith('--')) {
    f.error('USAGE', 'Usage: zelto spec show <slice-id>');
    return 1;
  }

  const draft = readDraft(id);
  if (draft !== null) {
    f.out(`# 草稿（${specDraftPath(id)}）`);
    f.out(draft);
    return 0;
  }

  if (!(await store.exists(id))) {
    f.error('NOT_FOUND', `Slice "${id}" not found.`);
    return 1;
  }

  const slice = await store.read(id);
  if (!existsSync(slice.spec.path)) {
    f.error('NOT_FOUND', `切片 "${id}" 既没有草稿也没有正式规格。先跑 zelto spec draft ${id}。`);
    return 1;
  }

  f.out(`# 正式规格（${slice.spec.path}）`);
  f.out(readFileSync(slice.spec.path, 'utf-8'));
  return 0;
}

// ─── confirm ───────────────────────────────────────────────────────────────

async function handleConfirm(args: string[]): Promise<number> {
  const f = getDefaultFormatter();
  const id = args[0];
  if (!id || id.startsWith('--')) {
    f.error('USAGE', 'Usage: zelto spec confirm <slice-id>');
    return 1;
  }

  if (!(await store.exists(id))) {
    f.error('NOT_FOUND', `Slice "${id}" not found.`);
    return 1;
  }

  const draft = readDraft(id);
  if (draft === null) {
    f.error(
      'NOT_FOUND',
      `切片 "${id}" 没有规格草稿。先跑 zelto spec draft ${id}，或者直接手写正式规格。`,
    );
    return 1;
  }

  const slice = await store.read(id);
  const specPath = slice.spec.path;
  mkdirSync(dirname(specPath), { recursive: true });
  writeFileSync(specPath, draft, 'utf-8');

  await events.append(id, 'draft.confirmed', 'zelto', {
    kind: 'spec',
    id,
    title: slice.title,
    path: specPath,
    draftPath: specDraftPath(id),
  });

  f.success(`规格已确认，写入 ${specPath}`);
  f.out('  这份规格现在是「人批准的出处」—— 冻结时它会物化成本片的需求追溯。');
  return 0;
}

// ─── 注册 ──────────────────────────────────────────────────────────────────

register('spec', async (args: string[]): Promise<number> => {
  const f = getDefaultFormatter();
  const subcmd = args[0];

  if (!subcmd) {
    f.error('USAGE', 'Usage: zelto spec <draft|show|confirm> <slice-id>');
    f.out('       zelto spec draft <slice-id>    生成规格草稿 + 验收测试骨架');
    f.out('       zelto spec show <slice-id>     看草稿 / 正式规格');
    f.out('       zelto spec confirm <slice-id>  确认草稿 → 写进正式规格');
    return 1;
  }

  if (subcmd === 'draft') return handleDraft(args.slice(1));
  if (subcmd === 'show') return handleShow(args.slice(1));
  if (subcmd === 'confirm') return handleConfirm(args.slice(1));

  f.error('USAGE', `Unknown spec subcommand: ${subcmd}`);
  f.out('       zelto spec draft|show|confirm <slice-id>');
  return 1;
});
