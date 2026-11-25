// `zelto design patch` —— 修正已确认设计里的模块字段（确定性，不经 LLM）
//
// ADR-063：为什么要有这个命令？
//
// 实战演练里踩到的坑：
//
//   1. `arch check` 报出「模块无文件」—— 设计的文件路径写错了
//   2. 想改路径，但 `design refine` 只接受 draft，已确认的设计改不了
//   3. 只能手改 JSON
//
// 手改 JSON 的坑：**`body` 是真源，`modules` 是缓存快照** ——
// 只改一个会不一致（判定读 body，报告读 modules）。
//
// 这个命令做**确定性文本替换**：
//   - 只改人明确指定的字段（文件路径 / 依赖模块）
//   - 正文与 modules 两处同步
//   - 改完仍要人确认（因为改的是已确认的设计）
//
// **不经 LLM 的理由**：LLM 会「顺手」改别的东西。
// 修正一个路径，结果它重写了整个职责描述 —— 那不是修正，是创作，
// 而创作需要人重新从头确认。这里只做**人明确指定的那一处改动**。
//
// C4: 每次修正写 append-only 事件（`draft.revised`）

import { createInterface } from 'node:readline';
import { atomicWriteText } from '../../core/io/atomic-write.js';
import { DesignStore } from '../../core/design/store.js';
import { applyPatch, type ModulePatch } from '../../core/design/patch.js';
import { register, events, ZELTO_DIR } from './shared.js';
import { getDefaultFormatter } from '../output-formatter.js';

const f = getDefaultFormatter();

/**
 * 从命令行参数里取一个选项的值。
 *
 * 取到下一个 `--` 开头的选项为止 —— 所以 `--path "a, b" --dep x` 里的
 * `a, b` 不会被误截断。
 */
function optionValue(args: string[], name: string): string | undefined {
  const idx = args.indexOf(name);
  if (idx === -1) return undefined;
  const next = args[idx + 1];
  if (next === undefined || next.startsWith('--')) return undefined;
  return next;
}

/** 取一个可重复出现的选项的所有值（`--path a --path b`） */
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

/**
 * 解析模块修正指令。
 *
 * 支持两种写法：
 *
 *   `--module src/dtls --path "src/modules/dtls/{@/*}, src/modules/dtls/{@/*}{@/*}"`
 *   `--module src/dtls --path src/modules/dtls/{@/*} --path "src/modules/dtls/{@/*}{@/*}"`
 *
 * （注释里写 glob 要转义星号 —— 否则会提前结束这段块注释。）
 *
 * 多个 `--module` 时，每个模块拿**它自己之后、下一个 --module 之前**
 * 的 `--path` / `--dep`。
 */
function parsePatches(args: string[]): ModulePatch[] {
  const patches: ModulePatch[] = [];
  let current: ModulePatch | null = null;
  // `--add-module` 的累积参数（下一个 `--` 之前）
  let add: ModulePatch['add'] | null = null;

  const flushAdd = (): void => {
    if (add) {
      // 新增模块自成一条修正 —— 它不属于任何 `--module` 段。
      // 单独 push，不跟 `--module` 混在一起（混了会让「已存在同名模块」
      // 那条分支的语义变得含糊）。
      patches.push({ module: '', add });
    }
    add = null;
  };

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--add-module') {
      flushAdd();
      const name = args[i + 1];
      if (!name || name.startsWith('--')) continue;
      add = { name, description: '', filePatterns: [], dependencies: [] };
      i++;
      continue;
    }
    if (args[i] === '--desc' || args[i] === '--description') {
      if (!add) continue;
      const value = args[i + 1];
      if (!value || value.startsWith('--')) continue;
      add.description = value;
      i++;
      continue;
    }
    if (args[i] === '--add-dep') {
      if (!add) continue;
      const value = args[i + 1];
      if (!value || value.startsWith('--')) continue;
      add.dependencies.push(value);
      i++;
      continue;
    }
    if (args[i] === '--module') {
      flushAdd();
      const name = args[i + 1];
      if (!name || name.startsWith('--')) continue;
      current = { module: name };
      patches.push(current);
      i++;
      continue;
    }    if (args[i] === '--path') {
      const value = args[i + 1];
      if (!value || value.startsWith('--')) continue;
      // `--add-module` 的模式下，`--path` 属于新模块
      if (add) {
        add.filePatterns.push(value);
        i++;
        continue;
      }
      if (!current) continue;
      (current.filePatterns ??= []).push(value);
      i++;
      continue;
    }
    if (args[i] === '--dep') {
      const value = args[i + 1];
      if (!value || value.startsWith('--')) continue;
      if (add) {
        add.dependencies.push(value);
        i++;
        continue;
      }
      if (!current) continue;
      (current.dependencies ??= []).push(value);
      i++;
    }
  }
  flushAdd();

  return patches.filter((p) => p.add || p.filePatterns || p.dependencies);
}

/** 把一批 glob 拆成列表（支持逗号分隔） */
function splitPatterns(values: string[]): string[] {
  return values
    .flatMap((v) => v.split(','))
    .map((s) => s.trim())
    .filter(Boolean);
}

/** 事件流里的 draft key（与 ai-pipeline.ts 保持一致） */
function draftEventKey(kind: string, id: string): string {
  return `draft-${kind}-${id}`;
}

/**
 * `zelto design patch <id> --module <name> --path <glob> [--dep <module>]`
 */
export async function designPatch(args: string[]): Promise<number> {
  const id = args[0];
  if (!id || id.startsWith('--')) {
    f.error(
      'USAGE',
      'Usage: zelto design patch <id> --module <name> --path <glob> [--dep <module>] [--yes]\n' +
        '       zelto design patch <id> --add-module <name> --desc <text> --path <glob> [--add-dep <module>] [--yes]',
    );
    return 1;
  }

  const patches = parsePatches(args);
  if (patches.length === 0) {
    f.error(
      'USAGE',
      'Nothing to patch. Use --module <name> --path <glob> (or --dep <module>), ' +
        'or --add-module <name> --desc <text> --path <glob> to add a missing module.',
    );
    return 1;
  }

  // 把逗号分隔的 glob 拆开
  for (const patch of patches) {
    if (patch.filePatterns) patch.filePatterns = splitPatterns(patch.filePatterns);
    if (patch.dependencies) patch.dependencies = splitPatterns(patch.dependencies);
    if (patch.add) {
      patch.add.filePatterns = splitPatterns(patch.add.filePatterns);
      patch.add.dependencies = splitPatterns(patch.add.dependencies);
    }
  }

  const designStore = new DesignStore(ZELTO_DIR);
  if (!(await designStore.exists(id))) {
    f.error('NOT_FOUND', `Design "${id}" not found.`);
    return 1;
  }

  const doc = await designStore.read(id);
  const { doc: patched, result } = applyPatch(doc, patches);

  if (result.missing.length > 0) {
    f.error(
      'NOT_FOUND',
      `Module(s) not found in design body: ${result.missing.join(', ')}. Check the module name (it must match a "### <name>" heading).`,
    );
    return 1;
  }

  if (result.changed.length === 0) {
    f.error(
      'NO_CHANGE',
      'No field matched. The module body may not follow the "**文件路径** / **依赖模块**" format.',
    );
    return 1;
  }

  // ─── 展示改动 ────────────────────────────────────────────────────────────
  f.out(`\n设计 "${id}" 的修正：`);
  for (const change of result.changed) {
    const label = change.field === 'filePatterns' ? '文件路径' : '依赖模块';
    f.out(`  ${change.module} · ${label}`);
    f.out(`    旧：${change.before.length > 0 ? change.before.join(', ') : '（无）'}`);
    f.out(`    新：${change.after.join(', ')}`);
  }
  // ─── 确认 ────────────────────────────────────────────────────────────────
  // 改的是**已确认**的设计 —— 这是治理动作，必须人点头。
  // `--yes` 跳过交互（供脚本用），但默认要人确认。
  if (!args.includes('--yes')) {
    if (!process.stdin.isTTY) {
      f.error(
        'NOT_TTY',
        'Not a TTY — cannot ask for confirmation. Re-run with --yes to apply without prompting.',
      );
      return 1;
    }
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

  // ADR-082：写完必须能核对 —— 内容没变就是失败，不能报成功。
  let receipt;
  try {
    receipt = await atomicWriteText(designStore.pathFor(id), JSON.stringify(patched, null, 2));
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    f.error('WRITE_FAILED', `写入设计失败：${msg}`);
    return 1;
  }
  if (!receipt.changed) {
    f.error('NO_CHANGE', '设计文件内容没有变化 —— 未写入任何内容。');
    return 1;
  }

  // C4：每次修正都写 append-only 事件
  await events.append(draftEventKey('design', id), 'draft.revised', 'zelto', {
    kind: 'design',
    id,
    title: patched.title,
    changes: result.changed.map((c) => ({
      module: c.module,
      field: c.field,
      before: c.before,
      after: c.after,
    })),
  });

  f.success(`Design "${id}" patched (${result.changed.length} field(s) changed).`);
  return 0;
}

register('design-patch', designPatch);
