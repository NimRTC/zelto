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
