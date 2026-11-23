// 冻结编排（ADR-086）
//
// 为什么编排要下沉到 core：
// ADR-072 §4 / ADR-084 §1 排除 Web 侧做 freeze 的理由是
// 「CLI 侧有完整实现，Web 侧再实现一份会分叉判定」（C3 的隐患）。
//
// 但核实后发现：**判据本来就在 core 里，编排序列在 CLI 里**。
// 于是「Web 侧再实现一份」的真实成本不是「重写判据」，
// 而是「把编排序列抄第二遍」—— 那才是分叉的来源。
//
// 所以本模块把**编排序列**收进 core，让 CLI 与 Web 调同一份。
//
// 编排顺序（与 CLI 原实现严格同序 —— 顺序本身就是语义）：
//   1. 状态检查（draft / clarifying；frozen + --refreeze → REFREEZE）
//   2. 追溯物化（evaluateFreezeTrace）
//   3. 写集 × 策略预检（先问「策略放行吗」—— 病根在策略时，
//      让人去改写集是治错了地方）
//   4. D-4 规格提到的文件必须在写集里
//   5. 追溯合格判定
//   6. 写冻结哈希 + FREEZE 转换 + 事件
//
// C3: 判定确定性 —— 只读文件、纯计算 + 文件写，不调模型、不触网。
// C2: 零第三方依赖、不 import adapters/。

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';
import { evaluateFreezeTrace } from '../spec/trace-extract.js';
import { evaluateWriteSetCoverage } from '../spec/write-set.js';
import { parseMentionedPaths } from '../spec/scope.js';
import { parseReferencedPaths } from '../spec/reference.js';
import { parseScopePaths } from '../spec/scope.js';
import { evaluateWriteSetAgainstPolicy } from '../spec/write-set-policy.js';
import { loadPolicy } from '../policy/data-access.js';
import { hashContent } from '../io/atomic-write.js';
import type { LifecycleContext, LifecycleOutcome } from './types.js';
import { fail, ok } from './types.js';

/** 冻结的选项。 */
export interface FreezeOptions {
  /**
   * 允许对已冻结的切片重新冻结。
   *
   * 为什么需要：规格冻结之后人可能还要改它 —— 最常见的是
   * **写集越界之后扩写集**（写集写在规格的「范围」章节里，改规格 = 改哈希）。
   * 没有这条路径，那个切片就永久卡住：check 报 hash mismatch，
   * freeze 又说「已经是 frozen，不能 freeze」。
   */
  refreeze?: boolean;
}

/**
 * 冻结一片切片。
 *
 * 与 CLI `zelto freeze` **同一份判定、同一份编排**（ADR-086 §1）。
 * CLI 侧改成调本函数 —— 输出保持不变。
 */
export async function freezeSlice(
  ctx: LifecycleContext,
  sliceId: string,
  options: FreezeOptions = {},
): Promise<LifecycleOutcome> {
  const { store, events, actor, via } = ctx;

  // ── 1. 状态检查 ────────────────────────────────────────────────────
  let slice = await store.read(sliceId);

  if (slice.state !== 'draft' && slice.state !== 'clarifying') {
    // 只有 frozen 能重新冻结。running / completed / abandoned 的规格
    // 变了要另走流程 —— 那些状态里可能已经有 agent 的产物了。
    const canRefreeze = options.refreeze === true && slice.state === 'frozen';
    if (!canRefreeze) {
      return fail(`切片 "${sliceId}" 处于 ${slice.state}，不能冻结`, [], [
        slice.state === 'frozen'
          ? '规格已改？重新冻结请用 refreeze 选项（zelto freeze <id> --refreeze）'
          : '',
      ].filter(Boolean));
    }

    // 重新冻结 = 人确认了新规格。退回 draft 让 FREEZE 转换合法可用。
    //
    // 顺序要紧：`store.transit` 会重新读盘并整份覆写，
    // 所以字段修改必须在 transit **之后**再做（否则刚改的字段会被冲掉）。
    await store.transit(sliceId, 'REFREEZE', actor);

    const refreshed = await store.read(sliceId);
    refreshed.spec.frozenHash = null;
    refreshed.spec.frozenAt = null;
    // ADR-092：边界摘要一并清空 —— 重新冻结会重算
    refreshed.spec.boundaryHash = null;
    // 追溯重新物化：规格改了，需求条目也可能变了
    refreshed.trace.requirements = [];
    await store.write(refreshed);
    // 后面基于这个对象继续 —— 不换掉的话局部变量还停在旧状态（frozen），
    // FREEZE 转换会直接抛 Invalid transition。
    slice = refreshed;

    await events.append(sliceId, 'slice.state.changed', actor, {
      sliceId, from: 'frozen', to: 'draft', event: 'REFREEZE', via,
    });
  }

  // ── 2. 追溯物化 ────────────────────────────────────────────────────
  //
  // 人显式声明过的追溯优先；没声明时，从规格正文的「验收标准」物化 ——
  // 那份验收标准就是人批准的出处。
  // 物化只读规格、不改规格，也不替人写需求。
  const specPath = resolveSpecPath(ctx.repoRoot, slice.spec.path);
  let specContent = '';
  try {
    specContent = await readFile(specPath, 'utf-8');
  } catch {
    specContent = '';
  }
  const traceGate = evaluateFreezeTrace(slice, specContent);
  const materialized = traceGate.requirements.length !== slice.trace.requirements.length;
  if (materialized) {
    slice.trace.requirements = traceGate.requirements;
    await store.write(slice);
  }

  // ── 3. 写集 × 策略的预检 ───────────────────────────────────────────
  //
  // 放在 D-4 检查**之前**：D-4 问「规格提到的文件在写集里吗」，
  // 这条问「写集里的路径 policy 放行吗」。**先问后者**——
  // 写集整体被策略挡住时，D-4 报「某文件不在写集里」只是症状，
  // 病根在策略。顺序反了会让人去改写集，而真正该改的是策略。
  //
  // 冻结 = 把规格钉成「基线」。钉一个**注定跑不起来**的基线没有意义：
  // 后面每一条事件都会指向这个基线，而基线对应的活根本交不出来。
  const effectiveWrites = await resolveEffectiveWrites(ctx, slice);
  const policyVerdict = evaluateWriteSetAgainstPolicyAgainstProjectPolicy(
    effectiveWrites,
    ctx.repoRoot,
  );
  if (!policyVerdict.ok) {
    await events.append(sliceId, 'spec.checked', actor, {
      sliceId,
      issues: policyVerdict.details.length,
      passed: false,
      details: policyVerdict.details,
      phase: 'freeze',
      via,
    });
    return fail(
      '写集与策略互相矛盾，拒绝冻结',
      policyVerdict.details,
      policyVerdict.advisories,
    );
  }

  // ── 4. D-4：规格提到的文件必须在写集里 ────────────────────────────
  //
  // 「规格说要改 + 写集不允许改」这个矛盾，在冻结时就能看出来 ——
  // 写集守卫（C9）会正确地拦住 agent，但代价是 agent 建了新文件
  // 却无法登记，链接期才炸。
  //
  // **只读引用要豁免**：规格里「对应 `docs/plan/xxx.md` §5.1」这种
  // **指路**不是「要改它」—— 那份规划文档恰恰是 agent 不该动的
  // （它是人批准的出处）。把指路当成要求修改 → 冻结被误报。
  const mentionedPaths = parseMentionedPaths(specContent);
  const referencedPaths = new Set(parseReferencedPaths(specContent));
  const requiredPaths = mentionedPaths.filter((p) => !referencedPaths.has(p));
  const coverage = evaluateWriteSetCoverage(requiredPaths, effectiveWrites, ctx.repoRoot);
  if (coverage.uncovered.length > 0) {
    // ZD-033：报错必须**给出路**，不能只说「你有问题」。
    //
    // 病灶（ADR-098 实测）：五片规格阶段共 23.93h，其中 97.8% 是
    // 「人在改规格与改写集」的往返，而 97% 的闸门失败都是同一句
    // 「规格提到「X」，但它不在写集里 —— agent 改不了它」。
    //
    // 这句话**没告诉人该怎么改**。人得自己判断：
    //   - X 是本片要改的 → 要加进写集
    //   - X 只是拿来参考的 → 要在规格里标成只读
    // 两种修法方向完全相反，人猜错了就是再等几小时被门禁打回。
    //
    // 所以每条未覆盖路径都带上**两条出路**（ADR-098 决策五：
    // 工具**不**自动改写集 —— 写集是人批准的边界，C9）。
    const details = coverage.uncovered.map((p) => {
      const exists = existsSync(resolve(ctx.repoRoot, p));
      return (
        `规格提到「${p}」，但它不在写集里 —— agent 改不了它` +
        (exists ? '' : '（该文件当前不存在，可能是本片要新建的）')
      );
    });
    const advisories = [
      `每个路径都要选一条出路（先想清楚它是「要改的」还是「只读参考的」）：`,
      `  ① 本片确实要改它 → 加进写集：` +
        `zelto set ${sliceId} --field writes --value '["${coverage.uncovered[0]}", …]'` +
        `（写集是本片**允许改动**的边界，加进来的路径 agent 就能改了）`,
      `  ② 只是拿来参考 / 仿照 → 在规格的「范围」章节写成「只读 <路径>」：` +
        `把该路径前面加上「只读」两个字（如「- 只读 \`${coverage.uncovered[0]}\` —— 参考它的实现」），` +
        `再冻结`,
      `两种改法方向相反，选错会被门禁打回 —— 判据：「这行代码本片会不会改？」会改 → ①；不会 → ②`,
    ];
    await events.append(sliceId, 'spec.checked', actor, {
      sliceId,
      issues: details.length,
      passed: false,
      details,
      advisories,
      phase: 'freeze',
      via,
    });
    return fail('规格与写集不一致，拒绝冻结', details, advisories);
  }

  // ── 5. 追溯合格判定 ───────────────────────────────────────────────
  if (traceGate.blocking.length > 0) {
    const details = traceGate.blocking.map((v) => v.message);
    await events.append(sliceId, 'spec.checked', actor, {
      sliceId,
      issues: traceGate.blocking.length,
      passed: false,
      details,
      phase: 'freeze',
      via,
    });
    return fail('追溯不合格，拒绝冻结', details);
  }

  // ── 6. 写冻结哈希 + 转换 + 事件 ───────────────────────────────────
  //
  // 物化追溯也是一次状态变更（C4）：留痕挂在同一次冻结动作的事件上 ——
  // 单独再写一条 spec.checked 会让「本片 check 过几次」这种统计失真。
  const specHash = hashSpecFile(specPath);
  slice.spec.frozenHash = specHash ?? `sha256:${Date.now()}`;
  slice.spec.frozenAt = new Date().toISOString();
  // ADR-092：边界摘要（writes + gateCommands）随冻结一起钉住。
  // frozenHash 只覆盖规格文件；边界是切片 JSON 字段 —— 不钉住就能被事后偷改。
  slice.spec.boundaryHash = computeBoundaryHash(slice);
  await store.write(slice);

  await store.transit(sliceId, 'FREEZE', actor);
  await events.append(sliceId, 'spec.frozen', actor, {
    sliceId,
    frozenHash: slice.spec.frozenHash,
    boundaryHash: slice.spec.boundaryHash,
    frozenAt: slice.spec.frozenAt,
    materializedRequirements: traceGate.requirements.length,
    traceSource: materialized ? 'spec' : 'declared',
    via,
  });

  return ok('切片已冻结', {
    sliceId,
    state: 'frozen',
    frozenHash: slice.spec.frozenHash,
    boundaryHash: slice.spec.boundaryHash,
    frozenAt: slice.spec.frozenAt,
    materializedRequirements: traceGate.requirements.length,
    traceSource: materialized ? 'spec' : 'declared',
  });
}

/**
 * 求本片的**有效写集**。
 *
 * 三级来源（与 `run-support.ts` 的 `resolveWriteSet` 同口径）：
 *   1. `slice.writes`（已显式给）→ 原样
 *   2. 规格「范围」章节 → 解析
 *   3. 目录探测 → 兜底
 *
 * 为什么不算 `slice.writes` 就判「D-4 未覆盖」：
 * 写集有三级来源，切片没显式给 `--writes` 时写集要从规格里推。
 * 只看 `slice.writes` 会把「写集由规格推导出来」的正常切片误判成缺授权。
 *
 * 注意：本函数**不落盘** —— 冻结路径下写入由调用方决定
 * （CLI 的 `resolveWriteSet(persist=true)` 会写回，Web 侧走同一条）。
 */
export async function resolveEffectiveWrites(
  ctx: LifecycleContext,
  slice: { id: string; writes: string[]; spec: { path: string } },
): Promise<string[]> {
  if (slice.writes.length > 0) return slice.writes;

  try {
    const content = await readFile(resolveSpecPath(ctx.repoRoot, slice.spec.path), 'utf-8');
    const specWrites = parseScopePaths(content);
    if (specWrites.length > 0) return specWrites;
  } catch {
    // 规格读不出来 → 往下走目录探测
  }

  return detectDefaultWrites(ctx.repoRoot);
}

/**
 * 把规格路径解析成**能真的读到文件的**绝对/完整路径。
 *
 * 为什么需要这一步：切片文件里记的规格路径是**相对的**
 * （`specs/slices/<id>.md`）—— 相对谁，取决于进程的工作目录。
 *
 * - CLI 侧：cwd 就是项目根，相对路径直接能用；
 * - Web 侧：驾驶舱的 `repoRoot` 是**参数**（可能是临时目录、可能是别的仓），
 *   而进程的 cwd 未必是它 —— 于是相对路径会读到**别的项目**的规格，
 *   或者读不到。
 *
 * 症状很隐蔽：规格读不出来时 `specContent` 是空串，
 * 追溯物化拿不到任何需求 → 冻结报「追溯不合格」——
 * **人明明写了验收标准，却被告知没写。**
 *
 * 所以这里统一按 `repoRoot` 解析：绝对路径原样保留，相对路径拼到 `repoRoot` 下。
 */
export function resolveSpecPath(repoRoot: string, specPath: string): string {
  if (!specPath) return specPath;
  if (isAbsolute(specPath)) return specPath;
  return join(repoRoot, specPath);
}

/**
 * 写集 × 策略判定 —— 只认**项目自己的**策略。
 *
 * 为什么不用兜底策略阻断（ADR-042 的同一个坑）：
 * 项目没有自己的 `policy/policy.yaml` 时，兜底策略是给 TypeScript 项目用的
 * （`src/**` 下的 `.ts` 与 `tests/**` 下的 `.ts`）。拿它去判一个 C++ 项目的写集
 * 会得出「不在任何允许规则覆盖范围内」—— **一个纯误判**：
 * 那个路径在项目自己的策略里很可能被允许，只是这个项目还没写策略而已。
 *
 * 「还没写策略」和「策略不允许」是两件事。前者不该拦人。
 */
export function evaluateWriteSetAgainstPolicyAgainstProjectPolicy(
  writes: string[],
  repoRoot: string,
): { ok: boolean; details: string[]; advisories: string[] } {
  const loaded = loadPolicy(repoRoot);
  // 没有项目策略 = 没有判据 = 放行。
  // 读策略失败不该让流程卡死：判不了就说「判不了」，
  // 而不是编一个「跑不起来」的结论。
  if (!loaded) {
    return { ok: true, details: [], advisories: [] };
  }

  const result = evaluateWriteSetAgainstPolicy(writes, {
    rules: loaded.rules as never,
    protected: ['policy/**', '.zelto/**', 'AGENTS.md', '.cursor/rules/**'],
  });
  return {
    ok: result.conflicts.length === 0,
    details: result.conflicts.map((c) => c.message),
    advisories: result.advisories.map((a) => a.message),
  };
}

/**
 * 规格文件的哈希 —— 冻结基线的凭据。
 *
 * 读不出来时返回 null（调用方决定怎么办），
 * **不**编一个假哈希 —— 假哈希会让「规格变了没有」这个判定永远为假。
 *
 * **格式必须与 CLI 侧 `hashSpecFile` 一致**：`sha256:<hex>`。
 *
 * 为什么强调这个：`hashContent()` **已经**带 `sha256:` 前缀了，
 * 这里再拼一次就成了 `sha256:sha256:<hex>` ——
 * 而 `zelto check` 用的是 CLI 侧那份（`sha256:<hex>`），
 * 于是**冻结时写的哈希与 check 算的哈希永远对不上**，
 * 表现为「规格刚冻结完就报 hash mismatch」。
 * 这种「同一个东西两份实现、格式悄悄不一样」的坑，
 * 是判定分叉的典型形态（C3）—— 所以这里**直接复用**同一个哈希函数。
 */
export function hashSpecFile(specPath: string): string | null {
  try {
    return hashContent(readFileSync(specPath, 'utf-8'));
  } catch {
    return null;
  }
}

/**
 * 门禁边界的规范化摘要（ADR-092）。
 *
 * 覆盖两样东西 —— 它们都是切片 JSON 字段，不在规格文件里，所以
 * `frozenHash` 管不到：
 *   - `writes`：写集（C9 运行时强制用的就是它，冻结时做过策略预检 / D-4 覆盖）；
 *   - `spec.gateCommands`：本片专属门禁命令（ADR-051）。
 *
 * 规范化口径（必须确定性、与实现无关）：
 *   - `writes`：正斜杠归一 + 去重 + **排序**（顺序无意义）；
 *   - `gateCommands`：按**原顺序**（顺序是语义，ADR-045），每项 `<name>\0<run>`；
 *   - 空 gateCommands 与「未设置」视为同一（都 = 用项目级命令）。
 *
 * 与 `frozenHash` 同前缀（`sha256:`），避免真假哈希分叉（见 ADR-075 §2）。
 */
export function computeBoundaryHash(slice: {
  writes: string[];
  spec: { gateCommands?: Array<{ name: string; run: string }> };
}): string {
  const writes = Array.from(
    new Set((slice.writes ?? []).map((w) => w.replace(/\\/g, '/'))),
  ).sort();
  const gate = (slice.spec.gateCommands ?? []).map((c) => `${c.name}\u0000${c.run}`);
  const payload = `${writes.join('\n')}\n--\n${gate.join('\n')}`;
  return hashContent(payload);
}

/**
 * 目录探测 —— 写集的最后一级兜底。
 *
 * 扫项目根下常见的源码目录名。**只读目录，不递归**。
 */
export function detectDefaultWrites(repoRoot: string): string[] {
  const candidates = [
    'src', 'lib', 'app', 'tools', 'scripts', 'tests', 'docs',
    'include', 'assets', 'public', 'components', 'pages',
  ];
  const found: string[] = [];
  try {
    const entries = readdirSync(repoRoot);
    for (const entry of entries) {
      if (candidates.includes(entry)) {
        try {
          if (statSync(join(repoRoot, entry)).isDirectory()) {
            found.push(`${entry}/**`);
          }
        } catch {
          // 某个条目 stat 失败 —— 跳过，不影响其它条目
        }
      }
      if (
        entry === 'CMakeLists.txt' || entry === 'Makefile' || entry === 'package.json' ||
        entry === 'Cargo.toml' || entry === 'go.mod'
      ) {
        if (!found.includes(entry)) found.push(entry);
      }
    }
  } catch {
    // 目录读不出来 → 没有兜底写集
  }
  return found;
}
