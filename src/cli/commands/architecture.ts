// 架构偏离检查（G-4/B 报告 + ADR-027 护栏结论）
//
// `zelto arch check` 把两样东西摆在一起比：
//   设计里的模块图（DesignDoc.modules 的依赖声明）
//   代码里实际的 import 图（扫源码算出来的）
//
// 差出来的几类东西：
//   未声明依赖 —— 代码里有、设计里没写（架构腐化的主要来源）
//   缺失依赖   —— 设计写了、代码里没有
//   未知模块   —— 依赖指向设计里根本不存在的模块
//   归属歧义   —— 一个文件落在多个模块的范围里
//   文件无归属 —— 有文件没有任何模块认领
//   依赖成环   —— 模块边界已经烂了
//
// 不带 `--strict` 时是纯报告（退出码恒 0，不读配置）。
// 带 `--strict` 时按 policy.yaml 的 `arch:` 段重算结论（ADR-027）：
// 缺段时全按 deny，与旧的 `!report.ok` 一致。

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { getDefaultFormatter, OutputFormat } from '../output-formatter.js';
import { colors } from '../color.js';
import { DesignStore } from '../../core/design/store.js';
import type { DesignDoc } from '../../core/design/types.js';
import {
  buildArchitectureReport,
  buildArchRelaxSnippet,
  judgeArchGuard,
  scanArchitecture,
  type ArchitectureReport,
  type Deviation,
  type GuardRule,
  type GuardVerdict,
  type ModuleSpec,
} from '../../core/arch/index.js';
import { register } from './shared.js';
import { loadPolicyConfig, ZELTO_DIR } from './shared.js';

interface ArchOptions {
  designId?: string;
  root: string;
  strict: boolean;
  json: boolean;
}

function parseOptions(args: string[]): ArchOptions {
  const options: ArchOptions = { root: process.cwd(), strict: false, json: false };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--design' && args[i + 1]) {
      options.designId = args[i + 1];
      i++;
    } else if (arg === '--root' && args[i + 1]) {
      options.root = args[i + 1];
      i++;
    } else if (arg === '--strict') {
      options.strict = true;
    } else if (arg === '--json') {
      options.json = true;
    }
  }
  return options;
}

/** 找设计：指定了就用指定的，否则取最近一份已确认的设计 */
async function resolveDesign(designId?: string): Promise<DesignDoc | null> {
  const store = new DesignStore(ZELTO_DIR);
  if (designId) {
    if (!(await store.exists(designId))) return null;
    return store.read(designId);
  }
  // 没有设计目录就别去 list —— list 会顺手建目录，
  // 而这是一条只读报告命令，不该在别人的项目里留下痕迹
  if (!existsSync(join(ZELTO_DIR, 'design'))) return null;
  const list = await store.list();
  const confirmed = list.filter((d) => d.status === 'confirmed');
  if (confirmed.length === 0) return null;
  return store.read(confirmed[0].id);
}

function toModuleSpecs(design: DesignDoc): ModuleSpec[] {
  return design.modules.map((m) => ({
    name: m.name,
    description: m.description,
    filePatterns: m.filePatterns,
    dependencies: m.dependencies,
  }));
}

const DEVIATION_LABEL: Record<string, string> = {
  missing_dependency: '缺失依赖',
  undeclared_dependency: '未声明依赖',
  ambiguous_module: '模块归属歧义',
  unmapped_file: '文件无归属',
  unknown_module: '未知模块',
  unverifiable_dependency: '依赖无法验证',
  cycle: '依赖成环',
};

function deviationColor(kind: string): (s: string) => string {
  if (kind === 'cycle' || kind === 'unknown_module') return colors.red;
  if (kind === 'undeclared_dependency' || kind === 'missing_dependency') return colors.yellow;
  if (kind === 'unverifiable_dependency') return colors.dim;
  return colors.dim;
}

/**
 * 把「文件无归属」按目录聚合成一行。
 *
 * 一个没被认领的目录往往意味着「设计漏了这个目录」，
 * 逐个文件列出几十行没人看；聚成一行反而能看出是哪一块漏了。
 */
function groupUnmapped(deviations: Deviation[]): Map<string, string[]> {
  const groups = new Map<string, string[]>();
  for (const dev of deviations) {
    if (dev.kind !== 'unmapped_file') continue;
    const path = dev.to;
    const slash = path.lastIndexOf('/');
    const dir = slash === -1 ? '.' : path.slice(0, slash);
    const list = groups.get(dir) ?? [];
    list.push(path);
    groups.set(dir, list);
  }
  return groups;
}

function renderReport(report: ArchitectureReport, design: DesignDoc, guard?: GuardVerdict, guardRules?: GuardRule[]): string {
  const out: string[] = [];
  out.push('');
  out.push(`  ${colors.bold(colors.cyan('架构偏离检查'))} ${colors.dim('（只读报告，不拦人）')}`);
  out.push(`  ${colors.dim('设计:')} ${design.id} "${design.title}"`);
  out.push(`  ${colors.dim('─'.repeat(56))}`);

  out.push('');
  out.push(`  ${colors.bold('模块')}`);
  if (report.modules.length === 0) {
    out.push(`    ${colors.dim('（设计里没有模块声明）')}`);
  } else {
    for (const mod of report.modules) {
      const declared = mod.declaredDeps.length > 0 ? mod.declaredDeps.join(', ') : '—';
      const actual = mod.actualDeps.length > 0 ? mod.actualDeps.join(', ') : '—';
      const files =
        mod.codeFileCount === mod.fileCount
          ? `${mod.fileCount} 个文件`
          : `${mod.fileCount} 个文件（${mod.codeFileCount} 源码）`;
      out.push(
        `    ${mod.name.padEnd(28)} ${files.padEnd(20)} 声明依赖: ${declared}  实际依赖: ${actual}`,
      );
    }
  }

  // ─── 偏离 ────────────────────────────────────────────────────────────
  const deviations = report.deviations;
  const unmappedGroups = groupUnmapped(deviations);
  const others = deviations.filter((d) => d.kind !== 'unmapped_file');

  out.push('');
  if (deviations.length === 0) {
    out.push(`  ${colors.green('✔ 没有偏离')} —— 实际 import 图与设计声明一致`);
  } else {
    if (others.length > 0) {
      out.push(`  ${colors.bold(`偏离 (${others.length})`)}`);
      for (const dev of others) {
        const label = DEVIATION_LABEL[dev.kind] ?? dev.kind;
        const color = deviationColor(dev.kind);
        out.push(`    ${color('●')} ${color(label.padEnd(8))} ${dev.from} → ${dev.to}`);
        out.push(`      ${colors.dim(dev.detail)}`);
      }
    }

    if (unmappedGroups.size > 0) {
      const total = [...unmappedGroups.values()].reduce((sum, files) => sum + files.length, 0);
      out.push('');
      out.push(`  ${colors.bold(`文件无归属 (${total})`)} ${colors.dim('按目录聚合')}`);
      const sorted = [...unmappedGroups.entries()].sort((a, b) => b[1].length - a[1].length);
      for (const [dir, files] of sorted) {
        out.push(`    ${colors.dim('●')} ${dir.padEnd(28)} ${colors.dim(`${files.length} 个文件`)}`);
        for (const file of files.slice(0, 3)) {
          out.push(`      ${colors.dim(file)}`);
        }
        if (files.length > 3) {
          out.push(`      ${colors.dim(`… 还有 ${files.length - 3} 个`)}`);
        }
      }
    }
  }

  if (report.cycles.length > 0) {
    out.push('');
    out.push(`  ${colors.bold('依赖环')}`);
    for (const cycle of report.cycles) {
      out.push(`    ${colors.red(cycle.join(' → '))}`);
    }
  }

  // ─── 护栏结论（仅 --strict 时传入）────────────────────────────────────
  if (guard) {
    out.push('');
    const pending = guard.perKind.filter((k) => k.needsConfirm && k.count > 0);
    const blocked = guard.perKind.filter((k) => k.blocked);
    const ignored = guard.perKind.filter((k) => k.action === 'allow' && k.count > 0);
    if (!guard.blocked && pending.length === 0) {
      out.push(`  ${colors.green('✔ 护栏通过')} —— 按 policy.yaml 的 arch 段重算，无需拦截`);
    } else {
      if (blocked.length > 0) {
        out.push(`  ${colors.red(colors.bold(`护栏拦截 (${blocked.reduce((s, k) => s + k.count, 0)})`))}`);
        for (const k of blocked) {
          out.push(`    ${colors.red('●')} ${(DEVIATION_LABEL[k.kind] ?? k.kind).padEnd(8)} ${k.count} 处 · deny`);
        }
      }
      if (pending.length > 0) {
        out.push(`  ${colors.yellow(colors.bold(`待人确认 (${pending.reduce((s, k) => s + k.count, 0)})`))} ${colors.dim('不拦，只标注')}`);
        for (const k of pending) {
          out.push(`    ${colors.yellow('●')} ${(DEVIATION_LABEL[k.kind] ?? k.kind).padEnd(8)} ${k.count} 处 · ask`);
        }
      }
      if (ignored.length > 0) {
        out.push(`  ${colors.dim(`已忽略 (${ignored.reduce((s, k) => s + k.count, 0)}) · allow，证据仍在报告里`)}`);
      }
    }
    // Q1 省力放开：给出可复制的 arch 片段（按当前已配规则重算，只给还会被拦的种类）
    const snippet = buildArchRelaxSnippet(report, guardRules);
    if (snippet) {
      out.push('');
      out.push(`  ${colors.dim('原型期放开（复制进 policy.yaml，交付前收紧为 deny）：')}`);
      for (const line of snippet.split('\n')) {
        out.push(`  ${colors.dim(line)}`);
      }
    }
  }

  out.push('');
  return out.join('\n');
}

register('arch', async (args) => {
  const f = getDefaultFormatter();
  const subcmd = args[0];

  if (subcmd && subcmd !== 'check') {
    f.error('USAGE', 'Usage: zelto arch check [--design <id>] [--root <dir>] [--strict]');
    return 1;
  }

  const options = parseOptions(args.slice(1));

  const design = await resolveDesign(options.designId);
  if (!design) {
    if (options.designId) {
      f.error('NOT_FOUND', `Design "${options.designId}" not found.`);
    } else {
      f.error(
        'NO_DESIGN',
        '找不到已确认的设计。先跑 "zelto design confirm <id>"，或用 --design <id> 指定。',
      );
    }
    return 1;
  }

  const specs = toModuleSpecs(design);
  const scan = scanArchitecture(options.root, specs);
  const report = buildArchitectureReport(specs, scan);

  // ADR-027: --strict 才读护栏配置（纯报告模式不读，保证退出码恒 0）
  // 策略读进程 cwd（项目根），与设计同根；--root 只影响源码扫描目录。
  const guardRules = options.strict ? loadPolicyConfig().arch : undefined;
  const guard = options.strict ? judgeArchGuard(report, guardRules) : undefined;

  const payload = {
    design: { id: design.id, title: design.title },
    report,
    ...(guard ? { guard } : {}),
  };

  if (options.json || f.getFormat() === OutputFormat.JSON) {
    // 直接输出裸 JSON —— 包一层 {data:...} 会让调用方多解一次壳
    console.log(JSON.stringify(payload, null, 2));
  } else if (f.getFormat() === OutputFormat.YAML) {
    f.data(payload);
  } else {
    process.stdout.write(renderReport(report, design, guard, guardRules) + '\n');
  }

  return options.strict ? (guard && guard.blocked ? 1 : 0) : 0;
});
