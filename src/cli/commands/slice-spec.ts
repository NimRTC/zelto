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

import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { atomicWriteText } from '../../core/io/atomic-write.js';
import { getDefaultFormatter } from '../output-formatter.js';
import { register, events, store, ZELTO_DIR, createLlmFromConfig } from './shared.js';
import { generateSliceSpec, type SliceSpecInput } from '../../llm/generators/slice-spec.js';
import type { DesignContext } from '../../llm/design-context.js';
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
  const requirementIds = slice.trace.requirements ?? [];
  const details = await loadRequirementDetails(requirementIds);
  return {
    sliceId: slice.id,
    title: slice.title,
    module: ctx.module,
    writes: slice.writes ?? [],
    version: ctx.version,
    requirements: requirementIds,
    // 需求条目的**正文**（ZD-005）—— 只给 id 模型只能写套话
    requirementDetails: details.map((d) => ({ id: d.id, text: d.text })),
    // 需求条目的**全部侧面**（ZD-031）—— 只给主体那一行，
    // 模型看不到「验收口径」与「测试形态」，规格的验收标准就得自己编。
    requirementAspects: details
      .filter((d) => (d.aspects?.length ?? 0) > 1)
      .map((d) => ({ id: d.id, aspects: d.aspects! })),
    // 设计上下文（ZD-032）—— 本片所属模块的路径与依赖事实。
    // 读不到就降级为 null（规格少点上下文，但不阻断起草）。
    designContext: await loadDesignContext(ctx.module, slice.writes ?? [], requirementIds),
    prerequisites: ctx.prerequisites,
  };
}

/**
 * 取本片的设计上下文（模块路径 / 依赖）。
 *
 * 降级不阻断：读不到已确认的设计时返回 null ——
 * 规格起草照旧进行，只是模型拿不到模块事实。
 */
async function loadDesignContext(
  module: string,
  writes: string[],
  requirementIds: string[],
): Promise<DesignContext | null> {
  try {
    const { buildDesignContext } = await import('../../llm/design-context.js');
    return await buildDesignContext(ZELTO_DIR, {
      sliceModule: module,
      writes,
      requirementIds,
    });
  } catch {
    return null;
  }
}

/**
 * 把需求条目的正文从已确认的需求文档里取出来。
 *
 * 取哪一份需求文档：与这个切片同属一条链上的**已确认**需求 ——
 * 取最新的一份已确认的（superseded 的不取）。找不到就返回空数组，
 * 规格里如实写「没有关联的需求条目」，不编造。
 */
async function loadRequirementDetails(
  ids: string[],
): Promise<Array<{ id: string; text: string; aspects?: string[] }>> {
  if (ids.length === 0) return [];
  try {
    const { RequirementStore } = await import('../../core/requirements/store.js');
    const { extractCriteria } = await import('../../core/requirements/criteria.js');
    const reqStore = new RequirementStore(ZELTO_DIR);
    const all = await reqStore.list();
    // 最新的一份已确认需求（superseded 的排除）
    const confirmed = all
      .filter((r) => r.status === 'confirmed')
      .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
    for (const summary of confirmed) {
      const doc = await reqStore.read(summary.id);
      const criteria = extractCriteria(doc.spec, doc.acceptanceCriteria, ids);
      if (criteria.some((c) => c.text.length > 0)) {
        return criteria.map((c) => ({
          id: c.id,
          text: c.text,
          aspects: c.aspects,
        }));
      }
    }
    return ids.map((id) => ({ id, text: '' }));
  } catch {
    return ids.map((id) => ({ id, text: '' }));
  }
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
  // ADR-082：原子写入 + 写完读回验证；失败必抛（命令据此返回非 0）。
  await atomicWriteText(draftPath, content);

  await events.append(id, 'draft.created', 'zelto', {
    kind: 'spec',
    id,
    title: slice.title,
    path: draftPath,
    source: llm ? 'llm' : 'deterministic',
  });

  const skeleton = writeAcceptanceSkeleton(slice.acceptance?.dir, content, id);

  // 骨架进了写集（ADR-046）：骨架里全是 `test.todo`，门禁②不认 todo
  // （「todo 与 skip 不算验证」）—— 必须有人把它改成真正的断言，而
  // 那个「有人」是 agent。agent 改写集外的文件会被 hook 拦住，所以
  // 骨架**必须**在写集里，否则本片永远过不了门禁②。
  if (skeleton.path) {
    await addAcceptanceSkeletonToWriteSet(id, skeleton.path);
  }

  return {
    path: draftPath,
    content,
    source: llm ? 'llm' : 'deterministic',
    skeleton: { path: skeleton.path, caseCount: skeleton.caseCount, reason: skeleton.reason },
  };
}

/**
 * 把验收骨架加进本片写集（ADR-046）。
 *
 * 已存在则不动 —— 写集是「人批准的边界」，这里只**补一个** agent
 * 确实需要改的路径，不替换已有内容。
 */
async function addAcceptanceSkeletonToWriteSet(id: string, skeletonPath: string): Promise<void> {
  try {
    const slice = await store.read(id);
    if (slice.writes.includes(skeletonPath)) return;
    slice.writes = [...slice.writes, skeletonPath];
    await store.write(slice);
  } catch {
    // 写集补不上不阻断草稿生成 —— 人还能用 zelto set 手工补
  }
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

// ─── skeleton ─────────────────────────────────────────────────────────────

/**
 * 从**正式规格**重新生成验收测试骨架。
 *
 * 为什么要有这条命令（ADR-050）：
 * `zelto spec draft` 的骨架是从**草稿**正文生成的。草稿是模型写的，
 * 而正式规格是人批准过的 —— 两者可能不一样（人改了字段名、调整了验收标准）。
 * 骨架要是还停在草稿那一版，agent 拿到的 todo 就是在追一个**已经不存在的**契约。
 *
 * 所以骨架的**唯一出处**是正式规格：正式规格是人批准的出处，
 * 骨架是它的可执行投影。
 */
async function handleSkeleton(args: string[]): Promise<number> {
  const f = getDefaultFormatter();
  const id = args[0];
  if (!id || id.startsWith('--')) {
    f.error('USAGE', 'Usage: zelto spec skeleton <slice-id> [--force]');
    return 1;
  }

  if (!(await store.exists(id))) {
    f.error('NOT_FOUND', `Slice "${id}" not found.`);
    return 1;
  }

  const slice = await store.read(id);
  if (!existsSync(slice.spec.path)) {
    f.error('NOT_FOUND', `切片 "${id}" 没有正式规格（${slice.spec.path}），无从生成骨架。`);
    return 1;
  }

  const specContent = readFileSync(slice.spec.path, 'utf-8');
  const skeleton = writeAcceptanceSkeleton(slice.acceptance?.dir, specContent, id, process.cwd(), {
    force: args.includes('--force'),
  });

  if (!skeleton.path) {
    f.error('SKELETON', skeleton.reason ?? '验收骨架未生成');
    return 1;
  }

  await addAcceptanceSkeletonToWriteSet(id, skeleton.path);
  await events.append(id, 'draft.created', 'zelto', {
    kind: 'skeleton',
    id,
    title: slice.title,
    path: skeleton.path,
    caseCount: skeleton.caseCount,
    from: slice.spec.path,
  });

  f.success(`验收骨架已从正式规格重新生成：${skeleton.path}`);
  f.out(`  用例数：${skeleton.caseCount}`);
  f.out('  骨架里全是 todo —— 需要实现成真正的断言，门禁②才认。');
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
    f.error('USAGE', 'Usage: zelto spec confirm <slice-id> [--force] [--refreeze]');
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

  // ── 状态门（ADR-092）──
  //
  // 冻结 = 这套规格与边界已被人批准。冻结后重写规格必须显式走 --refreeze，
  // 让整套校验（追溯物化 / 策略预检 / D-4 覆盖 / 边界摘要）重新跑一遍。
  //
  // 没有这道门时，`spec confirm` 能在 frozen 切片上把规格与骨架一起换掉 ——
  // 签字时比对的是旧规格的哈希，但盘上已经是新内容，追溯链从此对不上。
  const isFrozen = slice.state === 'frozen';
  const force = args.includes('--force');
  const refreeze = args.includes('--refreeze');
  if (isFrozen && !refreeze) {
    f.error(
      'FROZEN',
      `切片 "${id}" 已冻结 —— 改规格请先重新冻结（让整套校验重跑）。`,
    );
    f.out('');
    f.out(`  1) 重新冻结（会把切片退回 draft 并重走追溯 / 策略 / 写集校验）：`);
    f.out(`     zelto freeze ${id} --refreeze`);
    f.out(`  2) 然后再确认草稿：zelto spec confirm ${id}`);
    return 1;
  }

  // ── 确认前预演追溯物化 ──
  //
  // 为什么要在确认时拦：草稿里可能没有可物化的需求条目（`spec draft`
  // 在没有已批准需求时写的是占位符「（待人确认：…）」）。这种草稿确认
  // 之后，写进正式规格、然后 `freeze` 被追溯闸门拒掉 —— 人被引导确认了
  // 一份注定不能用的规格，然后卡在下一步，不知道问题出在哪。
  //
  // 拦住它的时机应该在「确认」：确认是「人批准这份规格」的瞬间，
  // 也是最后一道能改内容的瞬间。过了这道门，规格就是「人批准的出处」，
  // 不该再拒。
  //
  // 判据复用冻结准入的同一个函数（`evaluateFreezeTrace`）——
  // 两处各判一套的话，人会遇到「confirm 说行、freeze 说不行」。
  const { evaluateFreezeTrace } = await import('../../core/spec/trace-extract.js');
  const gate = evaluateFreezeTrace(
    {
      trace: slice.trace,
      traceWaiver: slice.traceWaiver,
      baseline: slice.baseline,
    },
    draft,
  );

  if (gate.blocking.length > 0) {
    f.error('TRACE', `切片 "${id}" 的规格无法物化需求追溯 —— 拒绝确认。`);
    f.out('');
    for (const v of gate.blocking) {
      f.out(`  - ${v.message}`);
    }
    f.out('');
    f.out('规格里要有可物化的需求条目，任选一种：');
    f.out('  1) 在「## 验收标准」下写编号条目（如 "1. 用户能登录"）→ 自动物化成需求追溯');
    f.out('  2) 显式声明需求引用：zelto set ' + id + ' --field trace.requirements --value "<需求引用>"');
    f.out('  3) 写明豁免理由：zelto set ' + id + ' --field traceWaiver --value "<理由>"');
    f.out('');
    f.out('改完草稿后再确认：zelto spec confirm ' + id);
    return 1;
  }

  mkdirSync(dirname(specPath), { recursive: true });
  // ADR-082：原子写入 + 写完读回验证。
  // **内容没变 = 失败** —— 报告「规格已确认」但文件没变，就是 D-31 那类静默失败。
  let receipt;
  try {
    receipt = await atomicWriteText(specPath, draft);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    f.error('WRITE_FAILED', `写入正式规格失败：${msg}`);
    return 1;
  }

  if (!receipt.changed) {
    f.error(
      'NO_CHANGE',
      `正式规格 ${specPath} 的内容与草稿完全一致 —— 没有任何改动，未写入。` +
      `若规格本就已正确，请直接冻结；否则请修改草稿后重试。`,
    );
    return 1;
  }

  await events.append(id, 'draft.confirmed', 'zelto', {
    kind: 'spec',
    id,
    title: slice.title,
    path: specPath,
    draftPath: specDraftPath(id),
  });

  // 确认后按新规格重建骨架（ADR-050：骨架的出处是**正式规格**）。
  // 人改了验收标准，骨架就该跟着变 —— 否则 agent 追的是上一版的契约。
  //
  // 但「跟着变」**不能**覆盖已实现的断言（ADR-092）。判据：目标文件是否还是
  // 纯 todo 骨架。
  //   - 不存在            → 正常生成；
  //   - 纯 todo           → 覆盖重建（此时覆盖无损失）；
  //   - 含真断言 / 已编辑 → **默认保全**；只有显式 `--force` 才覆盖。
  //
  // 默认保全而不是默认覆盖，是因为断言是「绿灯的含义」，是人的劳动产物。
  // 悄悄换回 todo = 悄悄改验证语义，正是追溯链最不能容忍的静默失败。
  const first = writeAcceptanceSkeleton(slice.acceptance?.dir, draft, id, process.cwd(), {
    // 先不 force：让 writeAcceptanceSkeleton 告诉我们「现有文件是什么形态」。
    force: false,
  });

  let skeleton = first;
  let overwritten: 'none' | 'skeleton' | 'assertions' = 'none';

  if (first.path) {
    // 骨架不存在 → 已生成
    overwritten = 'skeleton';
  } else if (first.skippedExisting) {
    if (first.existingIsPureTodo) {
      // 现有文件还是纯 todo —— 覆盖没有损失，按新规格重建
      skeleton = writeAcceptanceSkeleton(slice.acceptance?.dir, draft, id, process.cwd(), {
        force: true,
      });
      overwritten = 'skeleton';
    } else if (force) {
      // 人显式要求覆盖含真断言的文件
      skeleton = writeAcceptanceSkeleton(slice.acceptance?.dir, draft, id, process.cwd(), {
        force: true,
      });
      overwritten = 'assertions';
    } else {
      // 保全：含真断言的骨架**不覆盖**
      skeleton = first;
    }
  }

  if (skeleton.path) {
    await addAcceptanceSkeletonToWriteSet(id, skeleton.path);
  }

  if (overwritten === 'assertions') {
    // 覆盖了真断言——这是「改验证语义」，留下显著痕迹（C4）。
    // 复用既有 `spec.checked` 事件（不新增事件类型）：
    // phase 标明这是 confirm 阶段的检查，overwritten 说明骨架被覆盖。
    await events.append(id, 'spec.checked', 'zelto', {
      sliceId: id,
      passed: true,
      phase: 'confirm',
      overwritten: 'assertions',
      path: skeleton.path,
    });
  }

  f.success(`规格已确认，写入 ${specPath}`);
  f.out('  这份规格现在是「人批准的出处」—— 冻结时它会物化成本片的需求追溯。');
  if (skeleton.path) {
    f.out(`  验收骨架已按新规格重建：${skeleton.path}（${skeleton.caseCount} 条用例）`);
  } else if (first.skippedExisting && !first.existingIsPureTodo && !force) {
    // 保全路径：要明确告诉人「有断言没被覆盖」，以及怎么覆盖
    const target = first.reason?.split('：').slice(1).join('：') ?? '验收骨架';
    f.warn(`  验收骨架 ${target} 含已实现的断言 —— 已保全，未覆盖（ADR-092）。`);
    f.out(`  若确实需要按新规格重建（会抹掉这些断言）：zelto spec confirm ${id} --force`);
  } else if (skeleton.reason) {
    f.warn(`  验收骨架未重建：${skeleton.reason}`);
  }
  return 0;
}

// ─── 注册 ──────────────────────────────────────────────────────────────────

register('spec', async (args: string[]): Promise<number> => {
  const f = getDefaultFormatter();
  const subcmd = args[0];

  if (!subcmd) {
    f.error('USAGE', 'Usage: zelto spec <draft|show|confirm|revise|skeleton> <slice-id>');
    f.out('       zelto spec draft <slice-id>    生成规格草稿 + 验收测试骨架');
    f.out('       zelto spec show <slice-id>     看草稿 / 正式规格');
    f.out('       zelto spec confirm <slice-id> [--force] [--refreeze]  确认草稿 → 写进正式规格');
    f.out('       zelto spec revise <slice-id> --comment "要改什么"');
    f.out('         退回上游：方向不对，规格要改。切片回到 draft，意见带进下一轮上下文');
    f.out('       zelto spec skeleton <slice-id> [--force]  从正式规格重新生成验收骨架');
    f.out('         （含已实现断言的骨架默认保全；--force 才覆盖；frozen 切片需 --refreeze）');
    return 1;
  }

  if (subcmd === 'draft') return handleDraft(args.slice(1));
  if (subcmd === 'show') return handleShow(args.slice(1));
  if (subcmd === 'confirm') return handleConfirm(args.slice(1));
  if (subcmd === 'revise') return handleRevise(args.slice(1));
  if (subcmd === 'skeleton') return handleSkeleton(args.slice(1));

  f.error('USAGE', `Unknown spec subcommand: ${subcmd}`);
  f.out('       zelto spec draft|show|confirm|revise|skeleton <slice-id>');
  return 1;
});

// ─── revise（退回上游，ADR-094 §5.1）────────────────────────────────────────

/**
 * 退回上游 —— 人审出**方向**不对，要改规格。
 *
 * 与 `zelto sign <id> --revise`（退回重跑）的区别在**回哪个状态**：
 *
 *   sign --revise  → frozen   规格不动，重跑即可
 *   spec revise     → draft    规格要改，改完重新走门禁① + 冻结
 *
 * 回 `draft` 而不是 `frozen`（ADR-094 D5）：直接回 frozen 会**跳过
 * 门禁①** —— 而规格改了之后门禁①必须重跑（追溯要重新物化、写集要
 * 重新核覆盖）。
 *
 * **必须有意见**（ADR-094 §5.2）：不给意见就让人改规格，改的方向还是
 * 只有人自己知道 —— 那等于没退。
 */
async function handleRevise(args: string[]): Promise<number> {
  const f = getDefaultFormatter();
  const id = args[0];
  if (!id || id.startsWith('--')) {
    f.error('USAGE', 'Usage: zelto spec revise <slice-id> --comment "要改什么"');
    return 1;
  }

  if (!(await store.exists(id))) {
    f.error('NOT_FOUND', `Slice "${id}" not found.`);
    return 1;
  }

  const commentIdx = args.indexOf('--comment');
  const comment = commentIdx >= 0 ? args[commentIdx + 1] : null;
  if (!comment || !comment.trim() || comment.startsWith('--')) {
    f.error('MISSING_COMMENT', '退回上游必须带意见（--comment）。');
    f.out('');
    f.out('  没有意见，agent 拿到的信息与上一轮完全等价 —— 重跑必然白跑。');
    f.out('  用法：zelto spec revise ' + id + ' --comment "方向哪里不对"');
    return 1;
  }

  const slice = await store.read(id);

  // 状态门：只有 completed 的切片能被「退回上游」。
  //
  // 别的状态各有各的出路（frozen → freeze --refreeze；draft → 直接改），
  // 混在这里只会让人以为「退回」能做所有事。
  if (slice.state !== 'completed') {
    f.error(
      'BAD_STATE',
      `切片 "${id}" 处于 ${slice.state} —— 只有 completed 的切片能被退回上游。`,
    );
    f.out('');
    if (slice.state === 'frozen') {
      f.out('  已冻结但未完成：改规格请用 zelto freeze ' + id + ' --refreeze');
    } else if (slice.state === 'draft') {
      f.out('  还没冻结：直接改规格草稿（zelto spec draft ' + id + '）');
    } else {
      f.out('  还没完成：先让它跑完（zelto run ' + id + '）');
    }
    return 1;
  }

  // 需要一条可退的请求 —— 没有请求就无从「退」。
  //
  // `pending` 与 `approved` 都能退（ADR-094 D11）：签了字又发现方向不对，
  // 是最该退的场景 —— 那时已经没有 pending 请求了。
  const { SignManager } = await import('../../core/gate/sign.js');
  const signManager = new SignManager(ZELTO_DIR, events, store);
  const pendingReq = (await signManager.list('pending')).find((r) => r.sliceId === id);
  const approvedReq = (await signManager.list('approved')).find((r) => r.sliceId === id);
  const req = pendingReq ?? approvedReq;
  if (!req) {
    f.error('NO_SIGN_REQUEST', `切片 "${id}" 没有可退的签字请求 —— 无从退回。`);
    f.out('');
    f.out('  退回是对「签字请求」的处置。先发起签字请求（门禁②通过时会自动发起）。');
    return 1;
  }

  // D11：已批准的就地作废 —— `returnRequest()` 把 approved 转成 returned，
  // 所以 approved 状态自然不再成立（「已批准的片可合并」不再为真）。
  //
  // 但「批准被作废了」这件事**必须在输出里明说** ——
  // 人以为在退回，实际连带撤了批准，这件事不能悄悄做。
  const revokedApproval = approvedReq !== undefined && approvedReq !== null;

  // `returnRequest()` 在动手之前校验切片状态 —— 状态不对就抛错，
  // 且**一个字都没改**（签字请求没被消耗）。
  let returned;
  try {
    returned = await signManager.returnRequest(req.id, 'human', comment);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    f.error('RETURN_FAILED', `退回上游失败：${msg}`);
    f.out('');
    f.out('  **没有退回**：签字请求与切片状态都没动。');
    return 1;
  }

  f.out(`zelto spec revise ${id} -- ↩️  Returned upstream (${returned.id})`);
  if (revokedApproval) {
    f.out(`  ⚠️  此前的批准已作废（${approvedReq!.id}）—— 否则它仍可被合并。`);
  }
  f.out('  切片回到 draft：规格可以改了。');
  f.out('  你的意见会带进下一轮 agent 的上下文。');
  f.out('');
  f.out('下一步：');
  f.out('  1) 改规格：zelto spec draft ' + id + '   （写清楚这次要改成什么样）');
  f.out('  2) 确认：zelto spec confirm ' + id);
  f.out('  3) 重新冻结：zelto freeze ' + id);
  return 0;
}
