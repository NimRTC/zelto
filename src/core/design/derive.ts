// 设计文档的模块声明 —— 从正文推导，存的 modules 只是缓存
//
// 设计文档有两份「模块声明」：
//   - `body`：人读的那份正文（Markdown）—— **真源**
//   - `modules`：给判定用的结构化副本 —— **派生**
//
// 历史上 `modules` 是在生成时解析一次就存进文件的。解析口径一改
// （比如把「[无]（作为核心层，被其他模块依赖）」里的散文剥掉），
// 存量文档里的 `modules` 就成了旧口径的产物——正文明明写得清楚，
// 结构化副本里却冒出「无]（作为核心层」这种不存在的依赖名。
//
// 所以这里改成**每次从正文重新推导**：
//   - 正文能解析出模块 → 用推导结果（永远是当前口径）
//   - 正文解析不出模块（正文被裁剪过、格式不是设计模板）→ 退回存的 `modules`
//
// 存盘时仍然写 `modules`，但那只是给人看的快照；判定不依赖它。
//
// C3: 纯文本计算，不调模型、不触网
// C6: core/ 内，不依赖 adapters/

import { parseDesignModules } from './parse.js';
import type { DesignDoc, DesignModule } from './types.js';

/**
 * 推导设计文档的模块声明。
 *
 * 优先用正文重新解析；正文里没有可识别的模块时退回存的那份。
 */
export function deriveModules(doc: Pick<DesignDoc, 'body' | 'modules'>): DesignModule[] {
  const parsed = doc.body ? parseDesignModules(doc.body) : [];
  if (parsed.length > 0) return parsed;
  return doc.modules ?? [];
}
