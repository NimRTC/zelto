// 归一化的公共零件 —— 剥引号、认「空」占位词
//
// 这两件事在两个地方都要做：
//   - core/arch/normalize.ts   归一化模块声明（文件名 / 依赖名）
//   - core/design/parse.ts     解析设计正文里的模块声明
//
// 以前两边各写一份，「什么算空」出现了两个口径：一边认「无」，
// 另一边不认，于是同一个依赖在架构报告里是「空」，
// 在设计解析里却是「一条名叫『无』的依赖」。
//
// 现在只有一份定义。两个调用方都从这里取，解析层与判定层不会各说各话。
//
// 纯字符串计算：不调模型、不触网（C3）。core/ 内，不依赖 adapters/（C6）。

/** 可以包裹路径的引号字符 */
const QUOTE_CHARS = ['`', '"', "'", '“', '”', '‘', '’', '（', '）', '(', ')'];

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
