// 跨版本回归基线 —— 「这个版本把上个版本的哪些行为弄坏了」
//
// 三个部分：
//   tap.ts     解析测试运行器输出，得到「哪条用例、什么状态」
//   baseline.ts 版本基线的落盘（文件态，C1）
//   compare.ts 两份基线的差集（纯计算，C3）

export { parseTapResults, mergeTapResults, testKey } from './tap.js';
export type { TapResults, TestResult, TestStatus } from './tap.js';
export { RegressionBaselineStore } from './baseline.js';
export type { RegressionBaseline } from './baseline.js';
export { compareRegression, hasRegression, renderRegression, emptyReport } from './compare.js';
export type { RegressionReport } from './compare.js';
