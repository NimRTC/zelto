// 设计正文的模块解析 —— 把设计文档的 Markdown 变成模块声明
//
// 设计文档里的模块声明是模型用自然语言写的，格式不统一：
//
//   **依赖模块**：`src/core/ports`,`src/core/events`   ← 反引号 + 逗号
//   **依赖模块**：[无]                                  ← 中文占位符
//   **依赖模块**：[无]（作为核心层，被其他模块依赖）    ← 占位符后面跟着散文
//
// 解析得太粗，散文会被当成模块名（「作为核心层」变成一条依赖），
// 报告里就多出一堆「依赖指向不存在的模块」这种假结论。
//
// 这一层只做**形状**上的清理，不改语义：
//   - 方括号里的是列表，方括号后面的是说明，丢掉说明
//   - 括号注释（`（…）` / `(…)`）是解释，丢掉
//   - 剥掉反引号 / 引号
//   - 「无」类占位词当成空
//
// 占位词的判定复用 core/text/normalize 的 isEmptyToken ——
// 「什么算空」只有一份定义，解析层与判定层不能各说各话。
//
// C3: 纯文本计算，不调模型、不触网
// C6: core/ 内，不依赖 adapters/

import { isEmptyToken, stripWrappingQuotes } from '../text/normalize.js';
import type { DesignModule } from './types.js';

/**
 * 解析一个列表型字段（文件路径、依赖模块）。
 *
 * 规则：
 *   1. 出现方括号时只取方括号里的内容（`[a, b]（说明）` → `a, b`）
 *   2. 每个条目后面的括号注释丢掉（`a（说明）` → `a`）
 *   3. 按逗号 / 顿号 / 换行切分
 *   4. 剥掉包裹用的引号与反引号
 *   5. 「无」类占位词丢掉
 */
export function parseFieldList(raw: string | undefined | null): string[] {
  if (!raw) return [];

  // 先把**整段**的尾部说明去掉：`[a, b]（这两个是顶层）` → `[a, b]`。
  //
  // 说明必须在这一步剥掉，不能留到切分之后 —— 说明里自己带逗号
  // （`（作为核心层，被其他模块依赖）`），切分后它就变成独立的条目，
  // 于是「无依赖」凭空多出一条叫「被其他模块依赖）」的依赖。
  const text = stripTrailingNote(raw.trim());

  // 方括号只认**紧跟着当前这一项**的那一组：`[a, b]` → `a`, `b`。
  //
  // 不能在整段文本上找所有方括号 —— 字段值常是多项，每项各自带括号
  // （`[engine RTCP demux], [rtp模块的transport-cc解析]`），
  // 整段扫会把**别的项**的括号内容也捞进来，
  // 也会让真正的不带括号项（文件路径）整段被丢弃。
  const items = splitOutsideBrackets(text)
    .flatMap((item) => splitOutsideBrackets(stripBulletMarker(item.trim())))
    .map((item) => stripFieldLabel(item.trim()))
    .flatMap((item) => splitOutsideBrackets(unwrapBracketed(item)))
    .map((item) => stripParentheticalNote(item.trim()))
    .map((item) => stripWrappingQuotes(item))
    .filter((item) => item.length > 0)
    .filter((item) => !isEmptyToken(item));

  return [...new Set(items)];
}

/**
 * 去掉整段文本**末尾**的括号说明。
 *
 * 只处理尾部 —— 中间的括号注释由 `stripParentheticalNote` 逐项处理。
 */
function stripTrailingNote(text: string): string {
  const match = text.match(/^(.*?)\s*[（(][^（()）]*[）)]\s*$/);
  if (!match) return text;
  return match[1].trim();
}

/**
 * 按逗号 / 顿号 / 换行切分，但**方括号内部不算分隔符**。
 *
 * `[src/core, src/cli]（这两个是顶层）` 是一**项**（两个条目），
 * 不是三项 —— 括号里的逗号属于内容。
 */
function splitOutsideBrackets(text: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let current = '';

  for (const ch of text) {
    if (ch === '[') depth++;
    else if (ch === ']') depth = Math.max(0, depth - 1);

    if (depth === 0 && (ch === ',' || ch === '，' || ch === '、' || ch === '\n')) {
      parts.push(current);
      current = '';
      continue;
    }
    current += ch;
  }
  parts.push(current);
  return parts;
}

/**
 * 拆掉一项外面的方括号，只留里面的内容。
 *
 * `[engine RTCP demux]` → `engine RTCP demux`
 *
 * 没有方括号就原样返回 —— 方括号后面的说明（`[a]（说明）`）由
 * `stripParentheticalNote` 负责去掉。
 */
function unwrapBracketed(value: string): string {
  const match = value.match(/^\[([^\]]*)\]/);
  if (!match) return value;
  const inner = match[1].trim();
  // 方括号后面还有内容（说明文字）→ 说明由 stripParentheticalNote 处理
  return inner.length > 0 ? inner : value;
}

/**
 * 字段标签的形状：`**字段名**：`。
 *
 * 用来判断「这一行是不是另一个字段的开头」——文件路径那一段要吃到
 * 下一个字段标签为止，再往下就不是它的内容了。
 */
const FIELD_LABEL = /^\*\*.+\*\*[：:]/;

/**
 * 丢掉条目里混进来的**下一个字段标签**。
 *
 * 设计正文的模块段落长这样：
 *
 *   **文件路径**:
 *     - `src/a.cpp`
 *     - `src/b.cpp`
 *   **依赖模块**: [core]
 *
 * 文件路径这一段要吃到 `**依赖模块**` 为止 —— 再往下就是别的字段的内容，
 * 不属于文件清单。列表里混进 `**依赖模块**: [core]` 这种条目时，
 * 它既不是路径也不是依赖，丢掉。
 */
function stripFieldLabel(value: string): string {
  if (!FIELD_LABEL.test(value)) return value;
  return '';
}

/**
 * 去掉 Markdown 列表项的前缀标记：`- ` / `* ` / `+ ` / `1. `。
 *
 * 设计正文里的文件路径常常写成多行列表：
 *
 *   **文件路径**:
 *     - `src/modules/net_feedback/CMakeLists.txt`
 *     - `src/modules/net_feedback/src/aggregator.cpp`
 *
 * 不剥掉前缀，这些模式就带着 `- ` 开头，永远匹配不上任何真实路径 ——
 * 于是模块「一个文件都没认领」，报告里全是「文件无归属」。
 */
function stripBulletMarker(value: string): string {
  return value.replace(/^(?:[-*+]|\d+[.)])\s+/, '').trim();
}

/** 去掉条目尾部的括号注释：`src/core（核心层）` → `src/core` */
function stripParentheticalNote(value: string): string {
  const note = value.search(/[（(]/);
  return note === -1 ? value : value.slice(0, note).trim();
}

/**
 * 从设计文档正文里解析模块声明。
 *
 * 模块以 `### 模块名` 开头，正文里用
 * `**职责**` / `**文件路径**` / `**依赖模块**` 三行描述。
 *
 * 用逐行扫描而不是一个大正则：正则的「下一个 `###` 或 `##` 或文末」
 * 前瞻在**最后一个模块**上会失配——`### 优先级保证` 后面直接是文末，
 * 前瞻的 `\n### ` 已经吃掉了换行，下一轮匹配从换行处起步，找不到 `### `，
 * 于是最后一个模块被静默丢掉。逐行扫描没有这个问题。
 *
 * 代码围栏（```）里的 `###` 不算标题 —— 那是代码注释，不是模块声明。
 */
export function parseDesignModules(content: string): DesignModule[] {
  const lines = content.split('\n');
  const modules: DesignModule[] = [];

  let current: { name: string; body: string[] } | null = null;
  let inFence = false;

  for (const line of lines) {
    const trimmed = line.trim();

    // 代码围栏的开合
    if (trimmed.startsWith('```')) {
      inFence = !inFence;
      if (current) current.body.push(line);
      continue;
    }

    if (inFence) {
      if (current) current.body.push(line);
      continue;
    }

    // `##` 级别的标题结束当前模块（模块声明只在 `###` 之下）
    if (/^##\s/.test(trimmed)) {
      if (current) {
        modules.push(toModule(current));
        current = null;
      }
      continue;
    }

    if (/^###\s/.test(trimmed)) {
      if (current) modules.push(toModule(current));
      current = { name: trimmed.replace(/^###\s+/, '').trim(), body: [] };
      continue;
    }

    if (current) current.body.push(line);
  }

  if (current) modules.push(toModule(current));

  return modules;
}

/** 把一段模块正文（`### 标题` 之后的行）变成一条模块声明 */
function toModule(section: { name: string; body: string[] }): DesignModule {
  const body = section.body.join('\n');

  // 职责是**一句话**：只取标签后面的第一行，剩下的（文件清单、接口代码块）
  // 属于别的字段或自由段落，不该被吸进描述里。
  const description = extractField(body, '职责').split('\n')[0].trim();
  const filePatterns = parseFieldList(extractField(body, '文件路径'));
  const dependencies = parseFieldList(extractField(body, '依赖模块'));

  return { name: section.name, description, filePatterns, dependencies };
}

/**
 * 取出一个字段（`**字段名**：值`）的值。
 *
 * 值可以写在同一行，也可以写在下一行并以 Markdown 列表展开：
 *
 *   **文件路径**:
 *     - `src/a.cpp`
 *     - `src/b.cpp`
 *
 * 同行的写法保留原样；换行展开的写法把整段列表原样交给调用方，
 * 由 `parseFieldList` 负责切分与剥前缀。
 */
function extractField(body: string, label: string): string {
  const head = new RegExp(`\\*\\*${label}\\*\\*[：:]`);
  const match = body.match(head);
  if (!match || match.index === undefined) return '';

  const rest = body.slice(match.index + match[0].length);
  const lines = rest.split('\n');

  // 第一行：同行写的值。空的（或只有列表前缀）说明值在下一行开始。
  const first = lines[0].trim();
  if (first.length > 0) {
    // 同行有值，但后面还跟着列表项 → 两段都要
    const following = collectBulletLines(lines.slice(1));
    return following.length > 0 ? `${first}\n${following.join('\n')}` : first;
  }

  return collectBulletLines(lines.slice(1)).join('\n');
}

/**
 * 收集连续的 Markdown 列表行（空行或非列表行即停）。
 *
 * **遇到下一个字段标签就停** —— 文件路径那一段要吃到 `**依赖模块**`
 * 为止，再往下是别的字段的内容，不属于本字段。
 */
function collectBulletLines(lines: string[]): string[] {
  const collected: string[] = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    if (!/^(?:[-*+]|\d+[.)])\s+/.test(trimmed)) break;
    // 列表项本身是下一个字段（`- **依赖模块**: [core]`）→ 到此为止
    if (FIELD_LABEL.test(stripBulletMarker(trimmed))) break;
    collected.push(trimmed);
  }
  return collected;
}
