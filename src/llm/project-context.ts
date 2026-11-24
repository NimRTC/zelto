// 项目结构摘要 — 给 `zelto design <req-id>` 的「设计」生成补上真实仓库上下文
//
// ── 为什么要有这个模块（实战：nimrtc v1.4，2026-11-20） ──
//
// `zelto design <req-id>` 生成设计时，只把需求文本喂给模型。模型不认识这个仓库，
// 于是编出了 `src/net/`、`src/device/`、`src/events/` 这些根本不存在的目录，
// 连底层库也编错了（写 libnice，实际是 libjuice；写 OpenSSL，实际是 vendored wolfSSL）。
//
// 后果比「文档写得不准」严重得多：
// - 设计的 `modules[].filePatterns` 是写集（writes）的来源 → 切片会要求写不存在的路径；
// - `arch check` 拿设计的模块对照真实 import 图 → 立刻报「模块无文件」；
// - 人审设计时看到的目录和仓库对不上，只能整份重do。
//
// 修法：从 `scanProject` 的确定性扫描结果里抽一份**紧凑**摘要（模块名 + 文件数 +
// 代表性文件 + 构建工具/测试命令），注入设计 prompt。它只描述事实（读目录、读文件名），
// 不调模型（C3），也不产出任何判定。
//
// 摘要必须**紧凑**：NimRTC 有 3k+ 文件、50+ 模块，全塞进去会爆上下文。
// 每个模块只给少数代表性路径，并显式告诉模型「这些是目录清单，权威清单是仓库」。

import type { ProjectMap, ProjectModule, ProjectType } from '../core/project/types.js';

/** 摘要里每个模块最多带几条代表性文件 */
const FILES_PER_MODULE = 6;

/** 摘要里最多列几个顶层模块（超出时说明还有多少） */
const MAX_TOP_LEVEL_MODULES = 40;

/**
 * 「第三方库」目录的名字 —— 这些目录下的**子目录名**就是库名。
 *
 * 为什么需要（ZD-003）：
 * 摘要里只有 `src/third_party/libjuice/src/Makefile` 这样的**文件路径**，
 * 模型得自己推「libjuice 是个库」。而 nimrtc v1.4 演练里模型就推错了 ——
 * 它把 `libjuice` 写成了 `libnice`，把 vendored wolfSSL 写成了 OpenSSL。
 *
 * 修法：把 vendor 目录下的**子目录名**单独抽出来，列成
 * 「项目已依赖的第三方库：libjuice, wolfSSL, opus, ...」。
 * 这是**确定的事实**（目录名），不是让模型去猜。
 *
 * 为什么是白名单而不是「凡带 third_party/vendor 字样就算」：
 * 白名单可控、可测。未知目录名顶多漏列（模型仍然能从文件路径推出），
 * 而乱认会把业务目录误当成第三方库。
 */
const VENDOR_DIR_NAMES = ['third_party', 'thirdparty', 'third-party', 'vendor', 'vendors', 'external', 'extern', 'thirdlibs'];

/**
 * 摘要字符预算 —— 超过就砍模块（从尾部砍，保留开头跟项目主干模块）。
 *
 * 为什么需要：`scanProject` 的模块树会把 vendored 源码也收进来
 * （nimrtc 的 `src/third_party` 一个目录 14k 个文件）。「每模块 6 个文件」的规则
 * 在 14 个顶层模块 × 每个带 15 个子模块时依然能炸到百万字符。
 * 预算保证注入 prompt 的永远是可控大小，宁可少列模块也不爆模型上下文。
 */
const MAX_SUMMARY_CHARS = 12000;

export interface ProjectStructureSummary {
  projectName: string;
  projectType: ProjectType;
  buildTool: string | null;
  testCommand: string | null;
  lintCommand: string | null;
  /** 渲染成 markdown 的模块清单 */
  modulesMarkdown: string;
  /**
   * 项目已依赖的**第三方库**名（ZD-003）。
   *
   * 为什么要单列：摘要里的文件路径（`src/third_party/libjuice/src/Makefile`）
   * 只说明「有这条路径」，模型得自己推「libjuice 是个库」——
   * 而它推错过（写成了 libnice）。库名是**事实**，不该靠模型从路径形状里猜。
   *
   * 空数组 = 扫不到第三方库（项目不 vendor 依赖）。
   */
  vendorLibraries: string[];
  /** 真源声明（告诉模型：这是扫描事实，不是你的猜测） */
  sourceNote: string;
}

function moduleLine(mod: ProjectModule, depth: number): string[] {
  const indent = '  '.repeat(depth);
  const head = `${indent}- \`${mod.name}\``;
  const counts = [`${mod.files.length} 个源文件`];
  if (mod.testFiles.length > 0) counts.push(`${mod.testFiles.length} 个测试`);
  const sample = mod.files.slice(0, FILES_PER_MODULE);
  const more = mod.files.length > sample.length ? ` …(+${mod.files.length - sample.length})` : '';
  const lines: string[] = [];
  lines.push(`${head}（${counts.join('，')}）`);
  if (sample.length > 0) {
    lines.push(`${indent}  ${sample.join(', ')}${more}`);
  }
  // 子模块在预算里逐个尝试，超出预算的交给 summarizer 统一切掉 ——
  // 这里**不**提前判断预算，否则每一层都要传预算参数
  for (const sub of mod.submodules) {
    lines.push(...moduleLine(sub, depth + 1));
  }
  return lines;
}

/**
 * 按字符预算截断模块树：从尾部逐个丢，至少保留 5 个顶层模块。
 *
 * 返回 { lines, dropped } —— dropped 是没列进来的顶层模块名（记进摘要里说明）。
 */
function budgetModules(
  modules: ProjectModule[],
  maxChars: number,
): { lines: string[]; dropped: string[] } {
  const accepted: string[] = [];
  const dropped: string[] = [];
  let used = 0;
  for (let i = 0; i < modules.length; i++) {
    const block = moduleLine(modules[i], 0);
    const cost = block.join('\n').length + 1;
    if (used + cost > maxChars && i >= 5) {
      // 预算用尽：剩下的模块都不再展开，只留名字
      dropped.push(...modules.slice(i).map((m) => m.name));
      break;
    }
    accepted.push(...block);
    used += cost;
  }
  return { lines: accepted, dropped };
}

/**
 * 从模块树里认出「第三方库」。
 *
 * 判据：模块路径里出现 vendor 目录名（`third_party` / `vendor` / …），
 * **它后面的那一段**就是库名。
 *
 * 例：`src/third_party/libjuice` → 库名 `libjuice`。
 *
 * 为什么从模块树认而不是读文件系统：
 * `summarizeProjectStructure` 是**纯函数**（只读传入的 ProjectMap，不做 IO）——
 * 摘要的其它部分都从这个树来，库清单也该从同一个来源来。
 * 而且 vendor 目录下的子目录**本来就是模块**（scanProject 把它们扫成了模块），
 * 所以树里一定有。
 *
 * 为什么要单列（ZD-003）：
 * 摘要里只有 `src/third_party/libjuice/src/Makefile` 这样的文件路径时，
 * 模型得自己推「libjuice 是个库」—— 它推错了（写成了 libnice）。
 * 库名是**事实**，不该让模型从路径形状里猜。
 */
export function extractVendorLibraries(map: ProjectMap): string[] {
  const found: string[] = [];
  const seen = new Set<string>();

  const walk = (mods: ProjectModule[]): void => {
    for (const mod of mods) {
      // 模块名**本身就是**相对仓库根的完整路径（`src/third_party/wolfssl`），
      // 不是路径片段 —— 所以直接按 `/` 切分即可，不该再拼前缀。
      const segs = mod.name.split('/');
      const vendorIdx = segs.findIndex((s) => VENDOR_DIR_NAMES.includes(s.toLowerCase()));

      if (vendorIdx < 0) {
        // 不是 vendor 目录 → 继续往下找
        walk(mod.submodules);
        continue;
      }

      const lib = segs[vendorIdx + 1];
      if (lib && !VENDOR_DIR_NAMES.includes(lib.toLowerCase())) {
        // 找到了库目录 → 记下库名，**不再往下**：
        // 库目录**下面**的子模块是库内部结构（`wolfssl/src`），不是新库。
        if (!seen.has(lib)) {
          seen.add(lib);
          found.push(lib);
        }
        continue;
      }

      // 这个模块**就是** vendor 目录本身（`src/third_party`）——
      // 库名在它的子模块里，往下走。
      walk(mod.submodules);
    }
  };

  walk(map.modules);
  return found;
}

/**
 * 从项目扫描结果生成紧凑结构摘要。
 *
 * 纯函数：只读传入的 ProjectMap，不做 IO。
 */
export function summarizeProjectStructure(map: ProjectMap): ProjectStructureSummary {
  const top = map.modules.slice(0, MAX_TOP_LEVEL_MODULES);
  const { lines, dropped } = budgetModules(top, MAX_SUMMARY_CHARS);
  if (dropped.length > 0) {
    lines.push(`- …（还有 ${dropped.length} 个顶层模块因预算未展开：${dropped.slice(0, 10).join(', ')}${dropped.length > 10 ? ' …' : ''}）`);
  }
  if (lines.length === 0) {
    lines.push('- （项目扫描没有发现源码目录；按需求文档描述即可）');
  }

  const vendorLibraries = extractVendorLibraries(map);

  return {
    projectName: map.projectName,
    projectType: map.projectType,
    buildTool: map.buildTool,
    testCommand: map.testCommand,
    lintCommand: map.lintCommand,
    modulesMarkdown: lines.join('\n'),
    vendorLibraries,
    sourceNote:
      '以上「项目现状」是对仓库目录与文件的**确定性扫描结果**，不是猜测。\n' +
      '模块名、目录路径、文件名都必须以它为准；不要发明清单里不存在的顶层目录。\n' +
      '这份清单只列出代表性文件（节选），仓库里真实存在但没列出的文件也属于相应模块 —— \n' +
      '设计里「文件路径」写 glob（如 `src/modules/ice/**`）比写具体文件名更稳。',
  };
}

/**
 * 把摘要渲染成 prompt 片段 —— 由调用方拼接到需求章节之前/之后。
 */
export function renderStructureSection(summary: ProjectStructureSummary): string {
  const facts: string[] = [];
  facts.push(`- 项目类型：${summary.projectType}`);
  if (summary.buildTool) facts.push(`- 构建工具：${summary.buildTool}`);
  if (summary.testCommand) facts.push(`- 测试命令：\`${summary.testCommand}\``);
  if (summary.lintCommand) facts.push(`- Lint 命令：\`${summary.lintCommand}\``);

  const sections: string[] = [
    '## 项目现状（扫描事实，以下为真源）',
    '',
    summary.sourceNote,
    '',
    ...facts,
  ];

  // ZD-003：第三方库清单单列一节。
  //
  // 为什么单列而不是塞进「模块清单」：模块清单是**目录树**，
  // 库名是**从库名该被用到的地方**抽出来的 —— 混在一起模型仍会
  // 把 `src/third_party/libjuice` 当成一个普通模块，而不是「一个叫
  // libjuice 的第三方库」。单列 + 明说「这是库名」，模型才不会拿它去编。
  if (summary.vendorLibraries.length > 0) {
    sections.push(
      '',
      '### 项目已依赖的第三方库',
      '',
      summary.vendorLibraries.join('、'),
      '',
      '这些是仓库里**已经 vendored 进来的**库（扫描所得）。' +
        '设计里提到要用某个库时，只能用这里列出来的名字 —— ' +
        '不要凭印象写别的名字（踩过的坑：实际 vendored 的是 libjuice，' +
        '却写成了 libnice；实际是 wolfSSL，却写成了 OpenSSL）。',
    );
  }

  sections.push('', '### 模块清单（节选代表性文件）', '', summary.modulesMarkdown);

  return sections.join('\n');
}
