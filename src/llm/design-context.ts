// 设计上下文 —— 给「切片规格起草」补上模块事实
//
// ── 病灶（nimrtc v1.4 实测，2026-11-21 ~ 11-22）──
//
// `zelto spec draft` 给模型的输入，实测只有 **470 ~ 705 token**：
//
//   - 切片 id / 标题 / 模块名（一句）
//   - 写集路径列表
//   - 需求条目的**一行**正文
//   - 前置切片 id
//
// 而人要写出一份**能判定的**规格，需要知道的是：
//
//   - 本片落在哪个模块、那个模块**归哪些路径**（`src/modules/ice/**`）
//   - 那个模块**依赖谁**（core / engine / sdp）
//   - 有哪些**已存在的文件**可改（新建 vs 修改）
//
// 这些事实**已经在仓库里**了 —— 在已确认的设计文档
// （`.zelto/design/dsg-*.json` 的 `modules[].filePatterns` / `dependencies`）。
//
// 但规格起草这条路**根本没读设计文档** —— 于是模型只能凭空猜文件路径，
// 或者写出一份空泛的骨架。人只好从零查代码、从零写规格。
//
// 为什么这事值 22 小时：ADR-098 实测五片的规格阶段墙钟 **23.93h**，
// 其中 LLM 调用只占 **2.2%**（32 分钟），其余 **97.8% 是人在改规格与改写集**。
// 规格草稿信息量不足 → 模型产出空壳 → 人从零补 → 几小时往返。
//
// 所以这里的修法是：**把已确认设计里的模块事实喂进 prompt**。
//
// 三条纪律：
//
// 1. **只喂已确认的设计** —— draft 状态的设计是模型草稿，人没批准，
//    拿它当事实就是把「模型的猜测」升级成「输入的真相」。
// 2. **只喂本片相关的模块** —— 全部 10 个模块塞进去是噪音。
//    判据：模块名与切片模块名匹配，或模块的 filePatterns 与写集有交集。
// 3. **降级不阻断** —— 读不到设计就照旧走（信息少一点，不是不能干活）。
//
// C3: 纯文件读取 + 纯计算，不调模型、不触网。
// C2: 只依赖 core/，不 import adapters/。

import { DesignStore } from '../core/design/store.js';
import { deriveModules } from '../core/design/derive.js';
import type { DesignDoc, DesignModule } from '../core/design/types.js';

/** 切片规格起草需要的模块上下文 */
export interface DesignModuleContext {
  /** 模块名（如「网络适配层 (ice)」） */
  name: string;
  /** 模块职责（设计文档里的一句话） */
  description: string;
  /** 模块归的路径模式（写集的来源） */
  filePatterns: string[];
  /** 模块依赖的其它模块 */
  dependencies: string[];
  /** 这个模块是不是本片所属的那个模块 */
  isSliceModule: boolean;
  /**
   * 这个模块在本片里的**角色**（ZD-032）。
   *
   * - `write`：本片要改的（就是本片所属模块）
   * - `readonly`：本片**可以参考但不该改**的（依赖模块）
   *
   * 为什么要分角色：规格的「范围」章节要分「要改的」与「只读参考的」两段。
   * 依赖模块正是「只读参考」的天然候选 —— 本片要对接它们的接口、
   * 仿照它们的实现，但改动它们**必须另开切片**（那是别的模块的边界）。
   */
  role: 'write' | 'readonly';
}

/** 切片规格起草需要的整体设计上下文 */
export interface DesignContext {
  /** 本片所属的模块名（来自版本计划） */
  sliceModule: string;
  /** 本片所属模块在设计里的名字（可能与版本计划写法略有出入） */
  sliceModuleName: string;
  /** 与本片相关的模块清单 */
  modules: DesignModuleContext[];
  /** 用的是哪份设计文档（可追溯） */
  designId: string | null;
  /** 设计文档标题 */
  designTitle: string | null;
}

/**
 * 一个设计模块是否与本片相关。
 *
 * 三种相关：
 *   1. 模块名与切片模块名匹配（版本计划里写的就是模块名）；
 *   2. 模块的路径模式与写集有交集；
 *   3. 模块是本片所属模块的**依赖模块**（或其依赖）——
 *      那正是本片要**对接 / 仿照**的对象，规格里要列为「只读参考」。
 */
function isRelevant(
  module: DesignModule,
  sliceModule: string,
  writes: string[],
  dependencyNames: Set<string>,
): boolean {
  // 判据一：模块名与切片模块名匹配（版本计划里写的就是模块名）
  if (sliceModule && module.name === sliceModule) return true;

  // 判据二：模块的路径模式与写集有交集
  for (const pattern of module.filePatterns) {
    const prefix = pattern.replace(/\/?\*+$/, '').replace(/\/$/, '');
    if (!prefix) continue;
    for (const write of writes) {
      if (write.startsWith(prefix) || prefix.startsWith(write)) return true;
    }
  }

  // 判据三：依赖模块（及其传递依赖）
  if (dependencyNames.size > 0 && matchesDependency(module.name, dependencyNames)) return true;

  return false;
}

/**
 * 模块名是否命中依赖名集合。
 *
 * 设计的依赖名是**短名**（`core`、`engine`），而模块名是**带括号的标题**
 * （`核心基础层 (core)`、`引擎层 (engine)`）—— 两者字面不相等。
 *
 * 判据：模块名里**含括号里的短名**，或**等于**短名。
 * 含（而不是等于）是因为真实文档里两种写法都有：
 * 「核心基础层 (core)」与「core」。
 */
function matchesDependency(moduleName: string, dependencyNames: Set<string>): boolean {
  if (dependencyNames.has(moduleName)) return true;
  const bracket = moduleName.match(/[（(]([^）)]+)[）)]\s*$/);
  const short = bracket ? bracket[1].trim() : moduleName;
  return dependencyNames.has(short);
}

/**
 * 算出本片所属模块的**依赖闭包**（依赖的依赖也算）。
 *
 * 为什么需要闭包：设计的依赖名可能指向一个**中间**模块
 * （`ice` 依赖 `sdp`，`sdp` 依赖 `core`）—— 只取一层的话，
 * `core` 不会出现在只读参考里，而它恰恰是最常被参考的那个。
 */
function collectDependencyClosure(
  modules: DesignModule[],
  sliceModuleName: string,
): Set<string> {
  const byName = new Map<string, DesignModule>();
  for (const m of modules) {
    byName.set(m.name, m);
    const bracket = m.name.match(/[（(]([^）)]+)[）)]\s*$/);
    if (bracket) byName.set(bracket[1].trim(), m);
  }

  const closure = new Set<string>();
  const queue: string[] = [];
  const own = byName.get(sliceModuleName);
  if (own) queue.push(...own.dependencies);

  while (queue.length > 0) {
    const name = queue.shift()!;
    if (closure.has(name)) continue;
    closure.add(name);
    const dep = byName.get(name);
    if (dep) {
      for (const d of dep.dependencies) {
        if (!closure.has(d)) queue.push(d);
      }
    }
  }

  return closure;
}

/**
 * 找出与本片相关的、**已确认**的设计文档。
 *
 * 为什么优先「最新且已确认」：设计会被修订（`supersedes`），
 * 拿旧设计当事实 = 按已作废的架构写规格。
 */
async function findConfirmedDesign(
  baseDir: string,
  requirementIds: string[],
): Promise<DesignDoc | null> {
  try {
    const store = new DesignStore(baseDir);
    const all = await store.list();
    // 最新的一份已确认设计
    const confirmed = all
      .filter((d) => d.status === 'confirmed')
      .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
    if (confirmed.length === 0) return null;

    // 优先选与本片需求同源的设计；找不到就取最新的已确认设计
    if (requirementIds.length > 0) {
      for (const summary of confirmed) {
        const doc = await store.read(summary.id);
        if (requirementIds.some((rid) => doc.requirementId === rid)) {
          return doc;
        }
      }
    }

    return await store.read(confirmed[0].id);
  } catch {
    return null;
  }
}

/**
 * 组装切片规格起草用的设计上下文。
 *
 * 读不到设计 / 没有已确认设计 → 返回 null（调用方照旧走，规格少点上下文，
 * 但不阻断）。
 */
export async function buildDesignContext(
  baseDir: string,
  options: { sliceModule: string; writes: string[]; requirementIds: string[] },
): Promise<DesignContext | null> {
  const doc = await findConfirmedDesign(baseDir, options.requirementIds);
  if (!doc) return null;

  // 从正文重新推导模块（正文明明写得清楚时，正文才是准的）
  const modules = deriveModules(doc);
  if (modules.length === 0) return null;

  // 本片所属模块的名字（用于判角色）
  const sliceModuleName =
    modules.find((m) => m.name === options.sliceModule)?.name ?? options.sliceModule;

  // 本片所属模块的依赖闭包 —— 那些模块是「只读参考」的天然候选
  const dependencyNames = collectDependencyClosure(modules, sliceModuleName);

  const relevant = modules
    .filter((m) => isRelevant(m, options.sliceModule, options.writes, dependencyNames))
    .map((m) => ({
      name: m.name,
      description: m.description,
      filePatterns: m.filePatterns,
      dependencies: m.dependencies,
      isSliceModule: options.sliceModule ? m.name === options.sliceModule : false,
      // 本片所属模块 = 要改的；其它相关模块 = 只读参考
      role: (options.sliceModule ? m.name === options.sliceModule : false)
        ? ('write' as const)
        : ('readonly' as const),
    }));

  if (relevant.length === 0) return null;

  return {
    sliceModule: options.sliceModule,
    modules: relevant,
    designId: doc.id,
    designTitle: doc.title,
    sliceModuleName,
  };
}

/**
 * 把设计上下文渲染成 prompt 片段。
 *
 * 渲染成 markdown 而不是 JSON —— 模型对 markdown 列表的遵循度更好，
 * 且这些是给人看的（规格草稿里要复述这些事实）。
 */
export function renderDesignContext(context: DesignContext | null): string {
  if (!context) {
    return '（没有找到与本片相关的**已确认**设计文档 —— 规格里的模块与文件路径需要人补齐）';
  }

  const lines: string[] = [];
  lines.push(`以下是本片所属设计（\`${context.designId}\`${context.designTitle ? ` · ${context.designTitle}` : ''}）里的**模块事实**。`);
  lines.push('');

  const write = context.modules.filter((m) => m.role === 'write');
  const readonly = context.modules.filter((m) => m.role === 'readonly');

  if (write.length > 0) {
    lines.push('## 本片要改的模块');
    lines.push('');
    for (const m of write) {
      lines.push(`### ${m.name}（**本片所属模块**）`);
      if (m.description) lines.push(`- 职责：${m.description}`);
      if (m.filePatterns.length > 0) {
        lines.push(`- 归的路径：${m.filePatterns.map((p) => `\`${p}\``).join('、')}`);
      }
      if (m.dependencies.length > 0) {
        lines.push(`- 依赖模块：${m.dependencies.join('、')}`);
      }
      lines.push('');
    }
  }

  if (readonly.length > 0) {
    lines.push('## 本片可以参考、但**不该改**的模块');
    lines.push('');
    lines.push('这些是本片要**对接 / 仿照**的模块 —— 改动它们属于别的模块的边界，要另开切片。');
    lines.push('');
    for (const m of readonly) {
      lines.push(`### ${m.name}`);
      if (m.description) lines.push(`- 职责：${m.description}`);
      if (m.filePatterns.length > 0) {
        lines.push(`- 归的路径：${m.filePatterns.map((p) => `\`${p}\``).join('、')}`);
      }
      lines.push('');
    }
  }

  lines.push('这些是**人已批准的设计事实**，不是猜测：');
  lines.push('- 「本片要改的模块」里的「归的路径」就是写集该落的位置 —— 不要自己发明目录');
  lines.push('- 「可以参考但不该改的模块」是**只读参考**的天然候选 ——');
  lines.push('  本片要仿照它、对接它时，把具体路径写进规格「范围」章节的**只读参考**段，标上「只读」前缀');
  lines.push('- 设计里没有的路径，不要凭空写进「范围」章节');

  return lines.join('\n');
}
