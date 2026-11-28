// 架构偏离检查（G-4/B 报告 + ADR-027 护栏结论）
//
// `zelto arch check` 把两样东西摆在一起比：
//   设计里的模块图（从设计正文推导出来的模块声明 —— ADR-029）
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
import { deriveModules } from '../../core/design/derive.js';
import { otherConfirmedDesigns, pickDefaultDesign } from '../../core/design/selection.js';
import type { DesignDoc, DesignSummary } from '../../core/design/types.js';
import {
  buildArchitectureReport,
  buildArchRelaxSnippet,
  isCodeLangCategory,
  judgeArchGuard,
  LANG_CATEGORY_LABELS,
  scanArchitecture,
  type ArchitectureReport,
  type Deviation,
  type GuardRule,
  type GuardVerdict,
  type LangCategory,
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

/**
 * 找设计：指定了就用指定的，否则按 `pickDefaultDesign` 的规则挑。
 *
 * 默认挑项目基线设计（`zelto project design` 生成的 `__project__` 需求那一份），
 * 没有基线才退到「最新的已确认设计」。理由见 `core/design/selection.ts`。
 */
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
  const picked = pickDefaultDesign(list);
  if (!picked) return null;
  return store.read(picked.id);
}

function toModuleSpecs(design: DesignDoc): ModuleSpec[] {
  // 模块声明从正文推导（正文是真源），存的 modules 只是缓存
  return deriveModules(design).map((m) => ({
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
  empty_module: '模块无文件',
  conditional_dependency: '条件依赖',
  cycle: '依赖成环',
};

function deviationColor(kind: string): (s: string) => string {
  if (kind === 'cycle' || kind === 'unknown_module') return colors.red;
  if (kind === 'undeclared_dependency' || kind === 'missing_dependency') return colors.yellow;
  if (kind === 'unverifiable_dependency') return colors.dim;
  // empty_module 是**设计侧**的问题（路径写错了）——
  // 用 yellow 而不是 dim：它需要人处理，但不该像 cycle 那样刺眼。
  if (kind === 'empty_module') return colors.yellow;
  // conditional_dependency 是**提示**（这条边随构建配置变）——
  // dim：它不是问题，只是让人知道真相。
  if (kind === 'conditional_dependency') return colors.dim;
  return colors.dim;
}

/**
 * 模块概况里的文件数描述。
 *
 * ADR-061：三个数字分清三件事 ——
 *   文件总数   —— 这个模块负责多少文件
 *   代码文件数 —— 其中多少是**代码**（不限语言）
 *   已验证数   —— 其中多少是扫描器读得懂的
 *
 * 关键是别把「代码文件数」写成「源码数」而只装扫描器读得懂的文件 ——
 * 那样 C++ 模块会显示「0 源码」，读起来像「这个模块没有代码」。
 */
function formatModuleFiles(fileCount: number, codeFileCount: number, verifiedFileCount: number): string {
  if (fileCount === 0) return '0 个文件';
  if (codeFileCount === fileCount && verifiedFileCount === codeFileCount) {
    return `${fileCount} 个文件`;
  }
  if (codeFileCount === fileCount) {
    // 全是代码，但一部分验不了
    return `${fileCount} 个文件（${verifiedFileCount} 已验证）`;
  }
  if (verifiedFileCount === codeFileCount) {
    // 代码都验得了，其余是文档/配置/构建脚本
    return `${fileCount} 个文件（${codeFileCount} 代码）`;
  }
  return `${fileCount} 个文件（${codeFileCount} 代码 / ${verifiedFileCount} 已验证）`;
}

/**
 * 这些语言类别是「代码」—— 它们的依赖关系**本该**被验证。
 *
 * 与之相对的是构建脚本 / 文档 / 配置 —— 那些文件不产生依赖边，
 * 「没验」是正常的，不该混进「验不了」的警告里稀释掉重点。
 *
 * **直接用 core 的 `isCodeLangCategory`** —— 不在这里另抄一份：
 * 抄一份就会漂（加一种语言时忘了改这里，报告会说「不产生依赖边」）。
 */
function isCodeLang(category: LangCategory): boolean {
  return isCodeLangCategory(category);
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

function renderReport(
  report: ArchitectureReport,
  design: DesignDoc,
  guard?: GuardVerdict,
  guardRules?: GuardRule[],
  alternatives?: DesignSummary[],
): string {
  const out: string[] = [];
  out.push('');
  out.push(`  ${colors.bold(colors.cyan('架构偏离检查'))} ${colors.dim('（只读报告，不拦人）')}`);
  out.push(`  ${colors.dim('设计:')} ${design.id} "${design.title}"`);
  if (alternatives && alternatives.length > 0) {
    out.push(
      `  ${colors.dim('其它已确认设计:')} ${alternatives.map((d) => d.id).join(', ')} ${colors.dim('（用 --design <id> 换）')}`,
    );
  }
  out.push(`  ${colors.dim('─'.repeat(56))}`);

  out.push('');
  out.push(`  ${colors.bold('模块')}`);
  if (report.modules.length === 0) {
    out.push(`    ${colors.dim('（设计里没有模块声明）')}`);
  } else {
    for (const mod of report.modules) {
      const declared = mod.declaredDeps.length > 0 ? mod.declaredDeps.join(', ') : '—';
      const actual = mod.actualDeps.length > 0 ? mod.actualDeps.join(', ') : '—';
      // ADR-061：三个数字分清三件事 ——
      //   文件总数 / 代码文件数 / 已验证文件数
      //
      // 原来只显示「N 个文件（M 源码）」，而那个 M 是
      // 「扫描器读得懂的文件数」—— C++ 项目里恒为 0，
      // 于是报告显示「14 个文件（0 源码）」，读起来像是
      // 「这个模块没有代码」。它有 14 个 `.cpp` / `.hpp`。
      const files = formatModuleFiles(mod.fileCount, mod.codeFileCount, mod.verifiedFileCount);
      // ADR-065：vendor 模块标出来 —— 它是外部边界，不是架构的一部分
      const vendorTag = mod.isVendor ? colors.dim('  [外部代码]') : '';
      out.push(
        `    ${mod.name.padEnd(28)} ${files.padEnd(24)} 声明依赖: ${declared}  实际依赖: ${actual}${vendorTag}`,
      );
    }
  }

  // ─── 语言覆盖面（ADR-060 §4 方案 A）───────────────────────────────
  //
  // 这一段的作用是**诚实**。
  //
  // 没有它，`arch check` 在一个 C++ 项目上会输出「✔ 没有偏离」或
  // 「⚠️ N 项无法验证」—— 后者看起来像「项目有点小问题」，
  // 而真相是「**这个工具在这个项目上没有判据**」。
  //
  // 这两件事对人的行动含义完全不同：前者说「去修一下」，
  // 后者说「补判据或换工具」。
  const coverage = report.coverage;
  out.push('');
  out.push(`  ${colors.bold('扫描覆盖')}`);
  for (const [category, count] of Object.entries(coverage.counts)) {
    if (count === 0) continue;
    const label = LANG_CATEGORY_LABELS[category as LangCategory] ?? category;
    const verifiable = coverage.verifiable.includes(category as LangCategory);
    if (verifiable) {
      out.push(`    ${colors.green('✔')} ${label.padEnd(24)} ${String(count).padStart(5)} 个文件 ${colors.dim('（依赖已验证）')}`);
    } else if (isCodeLang(category as LangCategory)) {
      out.push(`    ${colors.yellow('⚠')} ${label.padEnd(24)} ${String(count).padStart(5)} 个文件 ${colors.dim('（代码 —— 无 import 语义，依赖未验证）')}`);
    } else {
      out.push(`    ${colors.dim('·')} ${colors.dim(label.padEnd(24))} ${colors.dim(String(count).padStart(5))} 个文件 ${colors.dim('（不产生依赖边）')}`);
    }
  }
  if (coverage.unverifiableCodeFiles > 0) {
    out.push('');
    // ADR-065：分母**排除** vendor 文件 ——
    // 「只验证了 47/523 个文件」比「580/14439」诚实得多：
    // 后者里 97% 是 vendor 代码，没参与验证也不该算进「没验过」。
    //
    // ADR-066：分母**也排除**测试文件 ——
    // 测试文件不产生依赖边（测试引用被测对象是测试的本职），
    // 算进「没验过」会让覆盖率失真。
    //
    // ADR-138：分母**也排除**工具脚本 ——
    // 工具脚本不产生依赖边（脚本读被操作对象是脚本的本职），
    // 而且它们不是架构的一部分，算进分母同样会失真。
    const checkedTotal =
      coverage.totalFiles - coverage.vendorFiles - coverage.testFiles - coverage.toolingFiles;
    out.push(
      `    ${colors.yellow('⚠')} 本次只验证了 ${coverage.verifiedFiles}/${checkedTotal} 个文件的依赖关系。`,
    );
    out.push(
      `      ${colors.dim(`${coverage.unverifiableCodeFiles} 个代码文件没有可用的依赖语义 —— 它们的依赖关系**没有被检查过**。`)}`,
    );
    out.push(
      `      ${colors.dim('上面的偏离只涉及已验证的部分；未验证部分的偏离本次查不出来。')}`,
    );
  }
  // ─── 测试文件（ADR-066）───────────────────────────────────────────────
  //
  // 测试文件**不参与**依赖验证 —— 它们不产生依赖边。
  // 但要**说清楚**，否则「已验证 47 个 C++ 文件」会给人错觉。
  if (coverage.testFiles > 0) {
    out.push('');
    out.push(`  ${colors.bold('测试代码')}`);
    out.push(
      `    ${colors.dim('·')} ${colors.dim(`${coverage.testFiles} 个测试文件不参与架构检查 —— 测试引用被测对象是测试的本职，不构成架构耦合。`)}`,
    );
  }
  // ─── 工具脚本（ADR-138）────────────────────────────────────────────────
  //
  // 工具脚本**不参与**依赖验证，也不参与模块归属判定 ——
  // 它们不是架构的一部分，只是开发期用来操作这个项目的脚本。
  // 但要**说清楚**，否则「已验证 47 个 C++ 文件」会给人错觉。
  if (coverage.toolingFiles > 0) {
    out.push('');
    out.push(`  ${colors.bold('开发工具脚本')}`);
    out.push(
      `    ${colors.dim('·')} ${colors.dim(`${coverage.toolingFiles} 个工具脚本不参与架构检查 —— 脚本读取被操作对象是脚本的本职，不是架构耦合。`)}`,
    );
  }
  // ─── vendor 目录（ADR-065）────────────────────────────────────────────
  //
  // 这些目录里的代码**没有参与**架构检查 —— 但要**说清楚**，
  // 否则「已验证 4481 个 C++ 文件」会给人「整个项目都验过了」的错觉。
  if (report.vendorDirs.length > 0 || coverage.vendorFiles > 0) {
    out.push('');
    out.push(`  ${colors.bold('外部代码边界')}`);
    for (const dir of report.vendorDirs) {
      out.push(`    ${colors.dim('·')} ${colors.dim(dir)}`);
    }
    out.push(
      `      ${colors.dim(`${coverage.vendorFiles} 个文件在 vendor 目录里 —— 引入的外部代码，不参与架构检查。`)}`,
    );
    if (report.vendorModules.length > 0) {
      out.push(
        `      ${colors.dim(`设计里的 vendor 模块：${report.vendorModules.join('、')} —— 它们的依赖不算架构耦合。`)}`,
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
  // `--help` 只读说明，不能进判定 —— 不拦住的话会被当成未知子命令报 USAGE 错误
  if (args.includes('--help') || args.includes('-h')) {
    f.error('USAGE', 'Usage: zelto arch check [--design <id>] [--root <dir>] [--strict] [--json]');
    return 0;
  }
  const subcmd = args[0];

  if (subcmd && subcmd !== 'check') {
    f.error('USAGE', 'Usage: zelto arch check [--design <id>] [--root <dir>] [--strict]');
    return 1;
  }

  const options = parseOptions(args.slice(1));

  // 其它已确认设计 —— 用来在报告里提示「默认挑了哪份、还有哪些可换」
  const allDesigns = existsSync(join(ZELTO_DIR, 'design'))
    ? await new DesignStore(ZELTO_DIR).list()
    : [];
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
  const alternatives = options.designId ? [] : otherConfirmedDesigns(allDesigns, design.id);

  const specs = toModuleSpecs(design);
  const scan = scanArchitecture(options.root, specs);
  const report = buildArchitectureReport(specs, scan);

  // ADR-027: --strict 才读护栏配置（纯报告模式不读，保证退出码恒 0）
  // 策略读进程 cwd（项目根），与设计同根；--root 只影响源码扫描目录。
  const guardRules = options.strict ? loadPolicyConfig().arch : undefined;
  const guard = options.strict ? judgeArchGuard(report, guardRules) : undefined;

  const payload = {
    design: { id: design.id, title: design.title },
    ...(alternatives.length > 0
      ? { otherDesigns: alternatives.map((d) => ({ id: d.id, title: d.title })) }
      : {}),
    report,
    ...(guard ? { guard } : {}),
  };

  if (options.json || f.getFormat() === OutputFormat.JSON) {
    // 直接输出裸 JSON —— 包一层 {data:...} 会让调用方多解一次壳
    console.log(JSON.stringify(payload, null, 2));
  } else if (f.getFormat() === OutputFormat.YAML) {
    f.data(payload);
  } else {
    process.stdout.write(renderReport(report, design, guard, guardRules, alternatives) + '\n');
  }

  return options.strict ? (guard && guard.blocked ? 1 : 0) : 0;
});
