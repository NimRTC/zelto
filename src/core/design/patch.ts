// 设计文档的**确定性修正** —— 不经 LLM
//
// ADR-063 §2：为什么要有这个？
//
// `design refine` 走 LLM 重新生成正文，但**修正设计不是创作**。
// 本轮实战演练里遇到的问题：
//
//   设计里写 `src/dtls/*`，代码实际在 `src/modules/dtls/`
//   → `arch check` 报「模块无文件」
//   → 想改路径，但 `design refine` 只接受 draft，已确认的设计改不了
//   → 只能手改 JSON
//
// 手改 JSON 有个坑：**`body` 是真源，`modules` 是缓存快照** ——
// 只改一个会不一致（判定用 body，报告用 modules）。
//
// 所以这里做的是**确定性文本替换**：
//   - 找到 `### <模块名>` 段
//   - 替换该段的 `**文件路径**` 行（以及可选的 `**依赖模块**` 行）
//   - 重新推导 modules（保证两处一致）
//
// **不经 LLM 的理由**：LLM 会「顺手」改别的东西。
// 修正一个路径，结果它重写了整个职责描述 —— 那不是修正，是创作，
// 而创作需要人重新确认。这里只做**人明确指定的那一处改动**，
// 改完仍然要人确认。
//
// C3: 纯文本计算，不调模型、不触网
// C6: core/ 内，不依赖 adapters/

import { deriveModules } from './derive.js';
import { parseFieldList } from './parse.js';
import type { DesignDoc, DesignModule } from './types.js';

/** 一次模块字段修正 */
export interface ModulePatch {
  /** 模块名（对应正文里的 `### <模块名>`） */
  module: string;
  /** 新的文件路径列表（逗号分隔的 glob） */
  filePatterns?: string[];
  /** 新的依赖模块列表 */
  dependencies?: string[];
  /**
   * **新增**一个模块段（而不是改现有段）。
   *
   * 为什么需要（实战 ZD-012）：
   * 设计的模块图常常**不完整** —— 模块 A 声明了依赖 `core`，
   * 但模块图里根本没有 `core` 这个模块。于是架构护栏报
   * 「未知模块」并 deny，门禁开不了。
   *
   * 修法有两种：补上缺失的模块声明，或删掉那条依赖。
   * 前者需要「加一段」，后者用 `--dep` 就能做。
   *
   * 补的段必须**长成设计模板的样子**（职责 / 文件路径 / 依赖模块），
   * 否则解析层认不出它的字段 —— 加了等于没加。
   */
  add?: {
    /** 模块名（正文里的 `### <name>`） */
    name: string;
    /** 一句话职责 */
    description: string;
    /** 文件路径列表 */
    filePatterns: string[];
    /** 依赖模块列表 */
    dependencies: string[];
  };
}

/** 修正结果 */
export interface PatchResult {
  /** 修正后的正文 */
  body: string;
  /** 重新推导的模块声明（与正文一致） */
  modules: DesignModule[];
  /** 实际改了哪些模块 */
  changed: Array<{
    module: string;
    field: 'filePatterns' | 'dependencies';
    before: string[];
    after: string[];
  }>;
  /** 没找到的模块名 */
  missing: string[];
}

/**
 * 对设计正文应用一组模块字段修正。
 *
 * 只改**明确指定**的字段 —— 传了 `filePatterns` 就只改文件路径，
 * 传了 `dependencies` 就只改依赖模块。其它字段一律不动。
 */
export function patchDesignBody(body: string, patches: ModulePatch[]): PatchResult {
  const lines = body.split('\n');
  const changed: PatchResult['changed'] = [];
  const missing: string[] = [];

  // 正文里每个模块段落的位置：[起始行, 结束行)
  const sections = findModuleSections(lines);

  for (const patch of patches) {
    // ── 新增模块段 ──────────────────────────────────────────────────
    //
    // 必须插在**最后一个 `###` 段之后**、`##` 段落之前 ——
    // 插错了位置，`findModuleSections` 会把它算进别的段落里。
    //
    // 插在哪：所有 `###` 段的末尾（最后一个段的 end）。
    // 若正文里一个 `###` 都没有，就插在第一个 `##` 标题之前。
    if (patch.add) {
      const name = patch.add.name.trim();
      if (sections.has(name)) {
        // 已经有了 → 当成改它（不重复加）
        const existing: ModulePatch = { module: name };
        if (patch.add.filePatterns.length > 0) existing.filePatterns = patch.add.filePatterns;
        if (patch.add.dependencies.length > 0) existing.dependencies = patch.add.dependencies;
        if (existing.filePatterns || existing.dependencies) {
          const sub = patchDesignBody(lines.join('\n'), [existing]);
          changed.push(...sub.changed);
          missing.push(...sub.missing);
        }
        continue;
      }

      const block = renderModuleBlock(patch.add);
      const insertAt = findInsertionPoint(lines, sections);
      lines.splice(insertAt, 0, ...block);
      changed.push({
        module: name,
        field: 'filePatterns',
        before: [],
        after: patch.add.filePatterns,
      });
      // 重新定位 —— 插入后行号全变了
      const resections = findModuleSections(lines);
      for (const [k, v] of resections) sections.set(k, v);
      continue;
    }

    const section = sections.get(patch.module);
    if (!section) {
      missing.push(patch.module);
      continue;
    }

    if (patch.filePatterns) {
      const before = readField(lines, section, '文件路径');
      const value = patch.filePatterns.join(', ');
      const ok = replaceField(lines, section, '文件路径', value);
      if (ok) {
        changed.push({ module: patch.module, field: 'filePatterns', before, after: patch.filePatterns });
      }
    }

    if (patch.dependencies) {
      const before = readField(lines, section, '依赖模块');
      const value = patch.dependencies.length > 0 ? patch.dependencies.join(', ') : '无';
      const ok = replaceField(lines, section, '依赖模块', value);
      if (ok) {
        changed.push({ module: patch.module, field: 'dependencies', before, after: patch.dependencies });
      }
    }
  }

  const newBody = lines.join('\n');
  return {
    body: newBody,
    // 重新推导 —— 保证 modules 与 body 一致（body 是真源）
    modules: deriveModules({ body: newBody, modules: [] }),
    changed,
    missing,
  };
}

/**
 * 把新增模块渲染成设计模板的形状。
 *
 * 模板（和 `parseDesignModules` 认的格式一致）：
 *
 * ```
 * ### <name>
 * - **职责**：<description>
 * - **文件路径**：<paths>
 * - **依赖模块**：<deps>
 * ```
 *
 * **依赖模块**那行必须写 —— 哪怕没有依赖，也要写「无」。
 * 少了这一行，解析层读出的依赖是空数组，看起来一样，
 * 但正文与设计模板不一致，下一个读的人会以为漏了。
 */
function renderModuleBlock(add: NonNullable<ModulePatch['add']>): string[] {
  const paths = add.filePatterns.length > 0 ? add.filePatterns.join(', ') : '无';
  const deps = add.dependencies.length > 0 ? add.dependencies.join(', ') : '无';
  return [
    `### ${add.name}`,
    `- **职责**：${add.description}`,
    `- **文件路径**：${paths}`,
    `- **依赖模块**：${deps}`,
    '',
  ];
}

/**
 * 新增模块段插在哪一行。
 *
 * 规则：插在**最后一个 `###` 段的末尾**（也就是它的 end 行）——
 * 那里正好是下一个 `##` 标题之前，模块段连成一片。
 *
 * 正文里一个 `###` 都没有 → 插在第一个 `##` 标题之前；
 * 连 `##` 都没有 → 插在正文末尾。
 */
function findInsertionPoint(lines: string[], sections: Map<string, Section>): number {
  let lastEnd = -1;
  for (const section of sections.values()) {
    if (section.end > lastEnd) lastEnd = section.end;
  }
  if (lastEnd >= 0) return lastEnd;

  for (let i = 0; i < lines.length; i++) {
    if (/^##\s/.test(lines[i].trim())) return i;
  }
  return lines.length;
}

/** 一个模块段落 */
interface Section {
  /** `### <名字>` 那一行的下标 */
  start: number;
  /** 段落结束行（不含） */
  end: number;
}

/**
 * 找出正文里每个 `### <模块名>` 段落。
 *
 * `##` 级别的标题结束当前段落 —— 模块声明只在 `###` 之下。
 * 代码围栏里的 `###` 不算标题。
 */
function findModuleSections(lines: string[]): Map<string, Section> {
  const sections = new Map<string, Section>();
  let current: { name: string; start: number } | null = null;
  let inFence = false;

  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trim();

    if (trimmed.startsWith('```')) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;

    if (/^##\s/.test(trimmed)) {
      if (current) {
        sections.set(current.name, { start: current.start, end: i });
        current = null;
      }
      continue;
    }

    if (/^###\s/.test(trimmed)) {
      if (current) {
        sections.set(current.name, { start: current.start, end: i });
      }
      current = { name: trimmed.replace(/^###\s+/, '').trim(), start: i };
    }
  }

  if (current) {
    sections.set(current.name, { start: current.start, end: lines.length });
  }
  return sections;
}

/**
 * 读一个字段的当前值。
 *
 * 字段行长这样：`- **文件路径**：src/core/{@/*}, src/core/{@/*}{@/*}`
 *
 * （注释里写 glob 时要转义 —— 连续的星号后面跟斜杠，
 * 会提前结束这段块注释，后面的内容就成了代码。）
 *
 * 也支持**多行列表**写法：
 *
 * ```
 * - **文件路径**:
 *   - `src/a.cpp`
 *   - `src/b.cpp`
 * ```
 *
 * 两种写法都要能读 —— 设计正文的格式不统一（LLM 生成的）。
 */
function readField(lines: string[], section: Section, field: string): string[] {
  const label = new RegExp(`^\\s*[-*]?\\s*\\*\\*${field}\\*\\*\\s*[：:]\\s*(.*)$`);
  for (let i = section.start + 1; i < section.end; i++) {
    const match = lines[i].match(label);
    if (!match) continue;

    // 单行写法：值就在同一行
    const inline = match[1].trim();
    if (inline) return parseFieldList(inline);

    // 多行写法：值是下面连续的列表项
    const items: string[] = [];
    for (let j = i + 1; j < section.end; j++) {
      const item = lines[j].match(/^\s*[-*+]\s+(.*)$/);
      if (!item) break;
      // 列表项里混进下一个字段标签 → 不是路径
      if (FIELD_LABEL.test(item[1].trim())) break;
      items.push(item[1].trim());
    }
    // 复用 parse.ts 的字段解析 —— 反引号、方括号、括号说明都在那里清理
    // （这里重复实现一遍的话，两边的清理规则迟早会不一致）
    return parseFieldList(items.join('\n'));
  }
  return [];
}

/** 字段标签的形状：`**字段名**：`（与 parse.ts 保持一致） */
const FIELD_LABEL = /^\*\*.+\*\*[：:]/;

/**
 * 替换一个字段的值。
 *
 * 字段不存在时返回 false —— **不新增字段**。
 *
 * 为什么不新增：新增一个 `**文件路径**` 行到段落里，位置放哪？
 * 放最后？那字段顺序就不对了（设计模板是「职责 / 文件路径 / 依赖模块」）。
 * 放对了位置？那要判断段落里有哪些字段 —— 复杂度上升。
 *
 * 更重要的是：**没找到字段说明这个模块的写法不符合模板**，
 * 这时应该让人知道「这个模块的正文格式不对，工具改不了」，
 * 而不是硬塞一行进去。
 *
 * **多行列表写法**：值在字段标签的下一行起，是连续的列表项。
 * 替换时要**整块换掉**（标签行 + 所有列表项），
 * 否则会留下旧列表项和新值混在一起。
 */
function replaceField(lines: string[], section: Section, field: string, value: string): boolean {
  const label = new RegExp(
    '^(\\s*[-*]?\\s*\\*\\*' + field + '\\*\\*\\s*[：:]\\s*)(.*)$',
  );
  for (let i = section.start + 1; i < section.end; i++) {
    const match = lines[i].match(label);
    if (!match) continue;

    // 单行写法：值就在同一行
    if (match[2].trim()) {
      lines[i] = `${match[1]}${value}`;
      return true;
    }

    // 多行写法：值是下面连续的列表项 —— 整块换掉
    let end = i + 1;
    while (end < section.end) {
      const item = lines[end].match(/^\s*[-*+]\s+(.*)$/);
      if (!item) break;
      if (FIELD_LABEL.test(item[1].trim())) break;
      end++;
    }
    if (end === i + 1) {
      // 标签下面没有列表项 —— 当成空值处理，直接写单行
      lines[i] = `${match[1]}${value}`;
      return true;
    }
    lines.splice(i, end - i, `${match[1]}${value}`);
    return true;
  }
  return false;
}

/**
 * 把修正应用到设计文档上（返回新文档，不改原文档）。
 *
 * **正文与 modules 两处都改** —— body 是真源，modules 是缓存快照，
 * 只改一个会不一致（判定用 body，报告用 modules）。
 */
export function applyPatch(doc: DesignDoc, patches: ModulePatch[]): { doc: DesignDoc; result: PatchResult } {
  const result = patchDesignBody(doc.body, patches);
  const next: DesignDoc = {
    ...doc,
    body: result.body,
    modules: result.modules,
  };
  return { doc: next, result };
}
