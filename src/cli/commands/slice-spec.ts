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
    f.error('USAGE', 'Usage: zelto spec <draft|show|confirm|skeleton> <slice-id>');
    f.out('       zelto spec draft <slice-id>    生成规格草稿 + 验收测试骨架');
    f.out('       zelto spec show <slice-id>     看草稿 / 正式规格');
    f.out('       zelto spec confirm <slice-id> [--force] [--refreeze]  确认草稿 → 写进正式规格');
    f.out('       zelto spec skeleton <slice-id> [--force]  从正式规格重新生成验收骨架');
    f.out('         （含已实现断言的骨架默认保全；--force 才覆盖；frozen 切片需 --refreeze）');
    return 1;
  }

  if (subcmd === 'draft') return handleDraft(args.slice(1));
  if (subcmd === 'show') return handleShow(args.slice(1));
  if (subcmd === 'confirm') return handleConfirm(args.slice(1));
  if (subcmd === 'skeleton') return handleSkeleton(args.slice(1));

  f.error('USAGE', `Unknown spec subcommand: ${subcmd}`);
  f.out('       zelto spec draft|show|confirm|skeleton <slice-id>');
  return 1;
});
