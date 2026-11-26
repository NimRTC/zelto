// `zelto plan patch` —— 修正已确认版本计划里的切片清单（确定性，不经 LLM）
//
// ADR-063 的设计补丁（`zelto design patch`）在版本计划这一层的对应物。
//
// 实战演练里踩到的坑：
//
//   1. 需求文档（`docs/plan/ai-game-demo-plan.md`）的里程碑结构变了
//      —— M1/M2/M3 的切片清单与原来的「v1/v2/v3/v4」对不上
//   2. 已确认的计划改不了：`zelto plan add-version` 走 LLM，
//      而且只能加整个版本，改不了某个切片的写集、也加不了单个切片
//   3. 只能手改 `.zelto/versions/<id>.json`
//
// 手改状态文件是**追溯链上的谎言**：文件变了，事件流里没有记录
// （C4 要求每个动作写事件）；而且计划里的 `writes` 与
// `.zelto/slices/<id>.json` 里的 `writes` 必须一致，
// 手改只改一边 → `version start` 建出来的切片写集是错的。
//
// 这个命令做**确定性**的修正：
//   - 只改人明确指定的字段（写集 / 标题 / 模块 / 规格路径 / 依赖 / 状态）
//   - 改完仍要人确认（改的是已确认的计划）
//   - 写 append-only 事件（谁改的、改了什么、原来是什么）
//
// C4: 事件是追溯的唯一证据载体 —— 这次修正也必须留痕。

import { createInterface } from 'node:readline';
import { VersionStore } from '../../core/version/store.js';
import {
  applyPlanPatch,
  findDuplicateSliceIds,
  type PlanPatch,
  type SlicePatch,
  type VersionPatch,
} from '../../core/version/patch.js';
import type { VersionSlice } from '../../core/version/types.js';
import { register, events, ZELTO_DIR } from './shared.js';
import { getDefaultFormatter } from '../output-formatter.js';

const f = getDefaultFormatter();

/** 从命令行参数里取一个选项的值（取到下一个 `--` 为止）。 */
function optionValue(args: string[], name: string): string | undefined {
  const idx = args.indexOf(name);
  if (idx === -1) return undefined;
  const next = args[idx + 1];
  if (next === undefined || next.startsWith('--')) return undefined;
  return next;
}

/** 取一个可重复出现的选项的所有值。 */
function optionValues(args: string[], name: string): string[] {
  const values: string[] = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] !== name) continue;
    const next = args[i + 1];
    if (next === undefined || next.startsWith('--')) continue;
    values.push(next);
  }
  return values;
}

/** 事件流里的 draft key（与 ai-pipeline.ts 保持一致）。 */
function draftEventKey(kind: string, id: string): string {
  return `draft-${kind}-${id}`;
}

/** 逗号分隔的 glob 拆成列表（与 design patch 同口径）。 */
function splitPatterns(values: string[]): string[] {
  return values
    .flatMap((v) => v.split(','))
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * 把命令行参数解析成修正指令。
 *
 * 语法：
 * ```
 * zelto plan patch <plan-id> \
 *   --version <v> [--description <text>] [--depends-on <v1,v2>] [--status <s>] [--tag <name|none>] \
 *   [--base-commit <sha|none>] [--remove-version] \
 *   --add-slice <id> --slice-title <t> --slice-module <m> --slice-spec <path> --write <p>... \
 *   --remove-slice <id> \
 *   --slice <id> [--write <p>...] [--slice-title <t>] [--slice-module <m>] [--slice-spec <path>] \
 *     [--slice-state <draft|frozen|running|completed|failed>]
 * ```
 *
 * `--add-slice` / `--remove-slice` / `--slice` 各自成组：
 * 每个 `--add-slice` 之后、下一个 `--add-slice` 或 `--remove-slice` 或 `--slice`
 * 之前的选项属于这个切片。
 */
function parsePlanPatch(args: string[]): PlanPatch {
  const versions = new Map<string, VersionPatch>();

  const ensure = (label: string): VersionPatch => {
    let v = versions.get(label);
    if (!v) {
      v = { version: label };
      versions.set(label, v);
    }
    return v;
  };

  const versionLabel = optionValue(args, '--version');
  if (!versionLabel) return { versions: [] };

  const v = ensure(versionLabel);

  const description = optionValue(args, '--description');
  if (description !== undefined) v.description = description;

  const dependsOn = optionValues(args, '--depends-on');
  if (dependsOn.length > 0) v.dependsOn = splitPatterns(dependsOn);

  const status = optionValue(args, '--status');
  if (status !== undefined && ['planned', 'in_progress', 'integrated', 'delivered'].includes(status)) {
    v.status = status as VersionPatch['status'];
  }

  // ── 版本 tag（D-78）──
  //
  // `--tag <name>` 设 tag；`--tag none` 清掉记录。
  //
  // 「这一版有没有 tag」是追溯锚点（ADR-056 D6-C）。
  // D-73 修的是「以后 ship 会以 git 事实为准」；
  // 历史遗留的错误记录靠这个选项修 —— 且修正会写 `draft.revised` 事件，
  // 不留「谁在什么时候把 tag 改成什么」的痕迹就是追溯链上的谎言。
  const tagOpt = optionValue(args, '--tag');
  if (tagOpt !== undefined) {
    v.tag = tagOpt === 'none' ? null : tagOpt;
  }

  // ── 版本基点（钉死的 commit）──
  //
  // `--base-commit <sha>` 钉死基点；`--base-commit none` 清掉（回到默认解析）。
  //
  // 为什么需要：有一类版本的基点不在主干上 —— 比如在功能分支上开发的版本
  // （nimrtc v1.4 开发在 `feat/v14-turn-tls` 上）。默认规则会退回 main HEAD，
  // 于是版本分支从错误的基点长出来。之前钉基点只能手改状态文件（C4 的谎言）。
  const baseOpt = optionValue(args, '--base-commit');
  if (baseOpt !== undefined) {
    v.baseCommit = baseOpt === 'none' ? null : baseOpt;
  }

  // ── 移除整个版本（ADR-077）──
  //
  // `--remove-version` 与 `--version <v>` 合用，把该版本整条从计划删掉。
  // 用于「整个版本已并入更早的版本、一片都不剩」的清退。
  if (args.includes('--remove-version')) {
    v.removeVersion = true;
  }

  // ── 加切片 / 改切片 / 删切片 ──
  //
  // 三组各自成段：**每个 `--add-slice` 之后的选项属于那个切片**，
  // 直到下一个 `--add-slice` / `--remove-slice` / `--slice` 出现。
  type Segment = { kind: 'add' | 'remove' | 'edit'; id: string; patch: SlicePatch };
  const segments: Segment[] = [];

  let current: Segment | null = null;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];

    if (arg === '--add-slice' || arg === '--remove-slice' || arg === '--slice') {
      const id = args[i + 1];
      if (!id || id.startsWith('--')) continue;
      const kind = arg === '--add-slice' ? 'add' : arg === '--remove-slice' ? 'remove' : 'edit';
      current = { kind, id, patch: { sliceId: id } };
      segments.push(current);
      i++;
      continue;
    }

    // ── 搬切片到另一个版本（ADR-127）──
    //
    // `--move-slice <id> --from <version>` —— 目标是 `--version <v>`。
    //
    // 为什么单独一条而不是「从 A 移除 + 往 B 添加」：remove + add 会**重建**
    // 切片对象，丢掉一切没被 CLI 显式建模的字段（实测 nimrtc-v14 的 `note`：
    // 「ADR-031；version/v3 8abb815a」—— 那正是「这片的归属依据」的人写下的凭据）。
    if (arg === '--move-slice') {
      const id = args[i + 1];
      if (!id || id.startsWith('--')) continue;
      // `--from` 紧跟其后
      let from: string | undefined;
      if (args[i + 2] === '--from' && args[i + 3] && !args[i + 3].startsWith('--')) {
        from = args[i + 3];
        i += 3;
      } else {
        i++;
      }
      if (!from) continue;
      v.moveSlices = [...(v.moveSlices ?? []), { id, from }];
      continue;
    }

    if (!current) continue;

    if (arg === '--write') {
      const value = args[i + 1];
      if (!value || value.startsWith('--')) continue;
      current.patch.writes = [...(current.patch.writes ?? []), ...splitPatterns([value])];
      i++;
      continue;
    }
    if (arg === '--slice-title') {
      const value = args[i + 1];
      if (!value || value.startsWith('--')) continue;
      current.patch.title = value;
      i++;
      continue;
    }
    if (arg === '--slice-module') {
      const value = args[i + 1];
      if (!value || value.startsWith('--')) continue;
      current.patch.module = value;
      i++;
      continue;
    }
    if (arg === '--slice-spec') {
      const value = args[i + 1];
      if (!value || value.startsWith('--')) continue;
      current.patch.specPath = value;
      i++;
      continue;
    }
    if (arg === '--slice-state') {
      // ADR-127：把一个「已做完的片」按真实归属搬进另一个版本时，计划态不能退回 draft
      const value = args[i + 1];
      if (!value || value.startsWith('--')) continue;
      if (['draft', 'frozen', 'running', 'completed', 'failed'].includes(value)) {
        current.patch.state = value as NonNullable<SlicePatch['state']>;
      }
      i++;
      continue;
    }
    if (arg === '--slice-note') {
      // ADR-127：备注里记着「ADR-031；version/v3 8abb815a」——
      // 那正是「这片的归属依据」的可查凭据。
      const value = args[i + 1];
      if (!value || value.startsWith('--')) continue;
      current.patch.note = value;
      i++;
      continue;
    }
  }

  for (const seg of segments) {
    if (seg.kind === 'remove') {
      v.removeSlices = [...(v.removeSlices ?? []), seg.id];
      continue;
    }
    if (seg.kind === 'add') {
      const specPath = seg.patch.specPath ?? `specs/slices/${seg.id}.md`;
      const slice: VersionSlice = {
        id: seg.id,
        module: seg.patch.module ?? '未指定模块',
        title: seg.patch.title ?? seg.id,
        writes: seg.patch.writes ?? [],
        specPath,
        state: 'draft',
      };
      // ADR-127：`note` 也要能带过来（`--add-slice` 也能指定备注）
      if (seg.patch.note !== undefined) slice.note = seg.patch.note;
      v.addSlices = [...(v.addSlices ?? []), slice];
      continue;
    }
    v.slices = [...(v.slices ?? []), seg.patch];
  }

  return { versions: [...versions.values()] };
}

/**
 * `zelto plan patch <plan-id> --version <v> [...]`
 */
export async function planPatch(args: string[]): Promise<number> {
  const id = args[0];
  if (!id || id.startsWith('--')) {
    f.error('USAGE', 'Usage: zelto plan patch <plan-id> --version <v> [--add-slice <id> ...] [--remove-slice <id>] [--move-slice <id> --from <version>] [--remove-version] [--slice <id> --write <p> ... --slice-state <s> --slice-note <text>] [--tag <name|none>] [--base-commit <sha|none>]');
    return 1;
  }

  const patch = parsePlanPatch(args);
  if (patch.versions.length === 0) {
    f.error('USAGE', 'Nothing to patch. Use --version <v> with --add-slice / --remove-slice / --slice.');
    return 1;
  }

  const versionStore = new VersionStore(ZELTO_DIR);
  if (!(await versionStore.exists(id))) {
    f.error('NOT_FOUND', `Version plan "${id}" not found.`);
    return 1;
  }

  const plan = await versionStore.read(id);
  const { plan: patched, changed, missingVersions, missingSlices } = applyPlanPatch(plan, patch);

  // 「写入之前要不要问人」判定得比预演早 —— 预演本身不需要确认。
  const interactive = !args.includes('--yes');
  if (interactive && !args.includes('--info') && !process.stdin.isTTY) {
    f.error('NOT_TTY', 'Not a TTY — cannot ask for confirmation. Re-run with --yes to apply without prompting.');
    return 1;
  }

  // `f.error` 直接把「错误」打到 stderr —— 它不抛。

  if (missingVersions.length > 0) {
    f.error('NOT_FOUND', `Version(s) not found in plan: ${missingVersions.join(', ')}.`);
    return 1;
  }
  if (missingSlices.length > 0) {
    f.error('NOT_FOUND', `Slice(s) not found: ${missingSlices.join(', ')}.`);
    return 1;
  }

  if (changed.length === 0) {
    f.error('NO_CHANGE', 'No field matched. The plan may already be in the requested state.');
    return 1;
  }

  // ── 展示改动 ──
  f.out(`\n计划 "${id}" 的修正：`);
  for (const change of changed) {
    const where = change.slice ? `${change.version} / ${change.slice}` : change.version;
    f.out(`  ${where} · ${change.field}`);
    f.out(`    旧：${formatValue(change.before)}`);
    f.out(`    新：${formatValue(change.after)}`);
  }

  // ── 重复切片 id 检查 ──
  //
  // 同一个切片 id 出现在两个版本里 → 合并时 `resolveSliceOwnership` 抛
  // `AmbiguousOwnershipError`，人要消歧。这属于**计划层面的错**，
  // 在这里查出来比在合并时炸掉好。
  const duplicates = findDuplicateSliceIds(patched);
  if (duplicates.length > 0) {
    f.error('DUPLICATE', `Slice id(s) appear in more than one version: ${duplicates.join(', ')}. Fix before applying.`);
    return 1;
  }

  // ── 预演（ZD-059）──
  //
  // 为什么需要：`--yes` 是「确认执行」，**不是**「只看不做」。想在真正写盘前
  // 看一遍「这次会改哪 14 处」的人，原来没有安全的途径 —— 要么直接写，要么
  // 手工去算。`--info` 只展示改动，不写文件、不写事件（C4 的等价物是「没发生就不记」）。
  if (args.includes('--info')) {
    f.out(`\n计划 "${id}" 的修正（预演，未写入）：`);
    for (const change of changed) {
      const where = change.slice ? `${change.version} / ${change.slice}` : change.version;
      f.out(`  ${where} · ${change.field}`);
      f.out(`    旧：${formatValue(change.before)}`);
      f.out(`    新：${formatValue(change.after)}`);
    }
    f.out(`\n共 ${changed.length} 处改动。去掉 --info 并加 --yes 才会写入。`);
    return 0;
  }

  // ── 应用 ──
  //
  // 改的是**已确认**的计划 —— 这是治理动作，必须人点头。
  // `--yes` 跳过交互（供脚本用），但默认要人确认。
  if (interactive) {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    const answer = await new Promise<string>((resolve) => {
      rl.question('\n应用这些修正？[y/N] ', resolve);
    });
    rl.close();
    const trimmed = answer.trim().toLowerCase();
    if (trimmed !== 'y' && trimmed !== 'yes') {
      f.out('Aborted — no changes written.');
      return 0;
    }
  }

  // ADR-110 决策六：写完必须能核对 —— 内容没变就是失败，不能报成功。
  //
  // 为什么走 VersionStore.save 而不是直接 atomicWriteText：
  // save 会**双写**（`.zelto/versions/` 真源 + 被跟踪的 `versions/` 副本）。
  // 这里原来只写了真源 —— 修完计划，CI 读到的副本仍是旧的（ADR-110 缺陷四
  // 的同一个形状：「声明与现实不一致」）。save 的读回验证在 atomicWriteText
  // 里，内容没变照样抛。
  try {
    await versionStore.save(patched);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    f.error('WRITE_FAILED', `写入版本计划失败：${msg}`);
    return 1;
  }

  // C4：每次修正都写 append-only 事件
  await events.append(draftEventKey('plan', id), 'draft.revised', 'zelto', {
    kind: 'plan',
    id,
    title: patched.title,
    changes: changed.map((c) => ({
      version: c.version,
      slice: c.slice,
      field: c.field,
      before: c.before,
      after: c.after,
    })),
  });

  f.success(`Plan "${id}" patched (${changed.length} change(s) applied).`);
  f.out('   下一步：给新增/改动的切片确认规格，再跑 zelto version start。');
  return 0;
}

/** 把字段值渲染成人能看的样子。 */
function formatValue(value: string | string[] | null): string {
  if (value === null) return '（无）';
  if (Array.isArray(value)) return value.length > 0 ? value.join(', ') : '（无）';
  return value.length > 0 ? value : '（无）';
}

register('plan-patch', planPatch);
