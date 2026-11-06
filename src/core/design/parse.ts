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

  let text = raw.trim();

  // 方括号包裹的列表：只认括号里的内容，括号后面是给人看的说明
  if (text.startsWith('[')) {
    const close = text.indexOf(']');
    text = close === -1 ? text.slice(1) : text.slice(1, close);
  } else {
    // 没有方括号时，括号注释整体丢掉（`无（说明）` → `无`）
    const note = text.search(/[（(]/);
    if (note !== -1) text = text.slice(0, note);
  }

  const items = text
    .split(/[,，、\n]/)
    .map((item) => stripParentheticalNote(item.trim()))
    .map((item) => stripWrappingQuotes(item))
    .filter((item) => item.length > 0)
    .filter((item) => !isEmptyToken(item));

  return [...new Set(items)];
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

  const descMatch = body.match(/\*\*职责\*\*[：:]\s*(.+)/);
  const description = descMatch ? descMatch[1].trim() : '';

  const filesMatch = body.match(/\*\*文件路径\*\*[：:]\s*(.+)/);
  const filePatterns = parseFieldList(filesMatch?.[1]);

  const depsMatch = body.match(/\*\*依赖模块\*\*[：:]\s*(.+)/);
  const dependencies = parseFieldList(depsMatch?.[1]);

  return { name: section.name, description, filePatterns, dependencies };
}
