// 设计文档的归一化 —— 把 LLM 写出来的模块声明变成可判定的形状
//
// 规格里的模块声明是人（或模型）用自然语言写的，格式不统一：
//
//   filePatterns: ["`src/adapters/**/*.ts`"]   ← 反引号包着
//   dependencies: ["无"]                        ← 中文占位符
//   name: " src/core "                          ← 前后空白
//
// 这些都不是设计者的真实意图，只是书写习惯。如果直接拿去匹配，
// 会得出「所有文件都没有归属」「依赖指向不存在的模块」这种假结论——
// 报告一旦全是噪声，就没人会看它。
//
// 归一化只做**形状**上的清理，不改语义：
//   - 剥掉包裹用的引号 / 反引号 / 前后空白
//   - 识别「无」类占位词（无 / 无依赖 / none / n/a / -）并当成空
//   - 模块名与依赖名统一去空白
//
// 判定仍然是纯字符串计算（C3），不调模型、不触网。
// C6: core/ 内，不依赖 adapters/

import type { ModuleSpec } from './types.js';

/** 为空的占位词 */
const EMPTY_TOKENS = new Set([
  '无',
  '无依赖',
  '没有',
  'none',
  'n/a',
  'na',
  'null',
  'nil',
  '-',
  '—',
  '()',
]);

/** 可以包裹路径的引号字符 */
const QUOTE_CHARS = ['`', '"', "'", '“', '”', '‘', '’', '（', '）', '(', ')'];

/**
 * 剥掉包裹用的引号与前后空白。
 *
 * 只在**两端都配对**时才剥 —— 否则路径里合法的括号会被削掉。
 */
export function stripWrappingQuotes(raw: string): string {
  let value = (raw ?? '').trim();
  let changed = true;
  while (changed) {
    changed = false;
    for (const quote of QUOTE_CHARS) {
      if (value.length >= 2 && value.startsWith(quote) && value.endsWith(quote)) {
        value = value.slice(quote.length, -quote.length).trim();
        changed = true;
        break;
      }
    }
  }
  return value;
}

/**
 * 判断一个声明是不是「空」的占位写法。
 *
 * 依赖写成「无」、文件范围写成「无」都算空。
 */
export function isEmptyToken(raw: string): boolean {
  const value = stripWrappingQuotes(raw).toLowerCase();
  if (!value) return true;
  return EMPTY_TOKENS.has(value);
}

/**
 * 归一化一组模块声明。
 *
 * 幂等：归一化过的结果再归一化一次不会变。
 */
export function normalizeModuleSpecs(specs: ModuleSpec[]): ModuleSpec[] {
  const normalized: ModuleSpec[] = [];
  for (const spec of specs) {
    const name = stripWrappingQuotes(spec.name ?? '');
    if (!name) continue;

    const filePatterns = dedupe(
      (spec.filePatterns ?? [])
        .filter((p) => !isEmptyToken(p ?? ''))
        .map((p) => stripWrappingQuotes(p ?? ''))
        .filter((p) => p.length > 0),
    );

    const dependencies = dedupe(
      (spec.dependencies ?? [])
        .filter((d) => !isEmptyToken(d ?? ''))
        .map((d) => stripWrappingQuotes(d ?? ''))
        .filter((d) => d.length > 0),
    );

    normalized.push({
      name,
      description: (spec.description ?? '').trim(),
      filePatterns,
      dependencies,
    });
  }
  return normalized;
}

/**
 * 模式的「具体程度」。
 *
 * 文件归属靠它判定：父模块的宽泛模式（如 src/core 下的递归匹配）
 * 与子模块的具体模式（如 src/core/audit 下的单层匹配）同时命中一个
 * 文件时，谁更具体谁拿走。按声明顺序判会把子模块的文件全抢走，
 * 于是整个模块图都是乱的。
 *
 * 具体程度 = 第一个通配符之前的字面前缀长度（越长越具体），
 * 前缀一样时通配符少的更具体。
 */
export interface PatternSpecificity {
  /** 第一个通配符之前的字面前缀 */
  prefix: string;
  /** 前缀长度 */
  prefixLength: number;
  /** 通配符个数 */
  wildcards: number;
}

export function patternSpecificity(pattern: string): PatternSpecificity {
  const wildcardIndex = pattern.search(/[*?]/);
  const prefix = wildcardIndex === -1 ? pattern : pattern.slice(0, wildcardIndex);
  const wildcards = (pattern.match(/[*?]/g) ?? []).length;
  return { prefix, prefixLength: prefix.length, wildcards };
}

/**
 * 比较两个模式的具体程度：a 是否比 b 更具体。
 *
 * 返回正数表示 a 更具体。前缀更长者更具体；前缀等长则通配符更少者更具体。
 */
export function compareSpecificity(a: PatternSpecificity, b: PatternSpecificity): number {
  if (a.prefixLength !== b.prefixLength) return a.prefixLength - b.prefixLength;
  if (a.wildcards !== b.wildcards) return b.wildcards - a.wildcards;
  return 0;
}

function dedupe(values: string[]): string[] {
  return [...new Set(values)];
}
