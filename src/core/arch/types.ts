// 架构偏离检查的类型
//
// G-4/B：把「设计里画的模块图」和「代码里实际的 import 图」摆在一起比，
// 差出来的东西就是**架构腐化的证据**。
//
// 这一层是**只读报告**：不改判定、不拦人、不改代码。
// 报告给出的是「哪里已经和当初的规划不一致」，怎么处置由人决定。
//
// C3: 全部确定性计算，不调模型、不触网
// C6: core/ 内，不依赖 adapters/

/** 设计里声明的一个模块 */
export interface ModuleSpec {
  name: string;
  description: string;
  /** 这个模块负责的文件（glob） */
  filePatterns: string[];
  /** 这个模块声明依赖哪些模块 */
  dependencies: string[];
}

/**
 * 源码语言（**能参与 import 图**的语言）
 *
 * ADR-062：新增 `'cpp'` —— C / C++ 的依赖表达是 `#include`，
 * 语义上接近「相对路径 + include 根目录搜索」。
 *
 * ADR-069：新增 `'go'` 与 `'rust'` ——
 * Go 的依赖表达是 `import "..."`（模块路径，无相对路径），
 * Rust 的是 `use ...;` / `extern crate ...;`（crate 内部路径）。
 */
export type SourceLang = 'ts' | 'python' | 'cpp' | 'go' | 'rust';

/**
 * 语言类别（报告用，比 `SourceLang` 粗）。
 *
 * 覆盖**所有**文件类型 —— 包括扫不了的，这样报告才能说清
 * 「哪些文件没能验证」。
 */
export type LangCategory =
  | 'typescript'
  | 'python'
  | 'cpp'
  | 'go'
  | 'rust'
  | 'java'
  | 'build'
  | 'doc'
  | 'config'
  | 'other';

/** 一条 import 引用 */
export interface ImportRef {
  /** 原始说明符，如 './db'、'@app/db'、'os' */
  specifier: string;
  kind: 'relative' | 'package' | 'builtin';
  /** 1 基行号 */
  line: number;
  /**
   * C/C++ 专有：尖括号（`<>`）还是引号（`""`）
   *
   * 决定**搜索顺序**：
   *   - `""` → 当前目录 → include 根
   *   - `<>` → include 根（跳过当前目录）
   *
   * ADR-062 §3.2（修正）：两者**都能**指向项目内部头文件 ——
   * 真实项目里 1081 条尖括号 include 是项目内部的。
   * 所以这不是「内部 vs 外部」的标记，只影响搜索顺序。
   */
  cppBracket?: '<' | '"';
  /**
   * C/C++ 专有：这条 include 处在**真条件编译**块里
   *
   * 值是条件表达式（如 `defined(_WIN32)`、
   * `defined(NIMRTC_PLUGINS_AMF_ON) && defined(_WIN32)`）。
   * 没条件时是 undefined。
   *
   * **include 守卫不算条件** —— `#ifndef FOO_HPP` / `#define FOO_HPP`
   * 永远为真，里面的 include 一直生效。守卫不标这里。
   *
   * ADR-064：条件编译里的 include **仍然是真依赖** ——
   * 开启那个特性时它就在。所以这里只**标记**，不隐藏。
   */
  cppCondition?: string;
  /**
   * **通用**条件标记（ADR-069）
   *
   * 条件编译块里的依赖**仍然是依赖** —— 开启那个特性时它就在。
   * 所以这里只**标记**，不隐藏。
   *
   * C++ 解析器同时填 `cppCondition` 与 `condition`（保持向后兼容）；
   * Go / Rust 只填 `condition`。
   *
   * 值是条件表达式（如 `defined(_WIN32)`、`linux && amd64`、
   * `target_os = "linux"`）。
   */
  condition?: string;
}

/** 扫出来的一个源文件 */
export interface ScannedFile {
  /** 相对项目根的路径（正斜杠） */
  path: string;
  lang: SourceLang;
  /** 归属模块；null = 没有模块认领这个文件 */
  module: string | null;
  /** 命中多个模块的模块名（歧义） */
  ambiguousWith: string[];
  /**
   * 是不是测试文件（ADR-066）
   *
   * 测试文件参与归属与覆盖统计，但**不产生依赖边** ——
   * 测试引用被测对象是测试的本职，不构成架构耦合。
   */
  isTest: boolean;
}

/** 模块之间的一条实际依赖边 */
export interface ModuleEdge {
  from: string;
  to: string;
  /** 产生这条边的文件 */
  files: string[];
  /** 涉及的说明符 */
  specifiers: string[];
  /**
   * 这条边**只**由条件编译产生吗？
   *
   * true  = 开启对应特性时才有这条边（其它构建配置下不存在）
   * false = 无条件就有这条边
   * undefined = 边里没有条件编译的成分（TS / Python —— 无条件编译概念）
   *
   * ADR-064：条件边**仍然是依赖** —— 开启特性时它就在，
   * 设计该声明就得声明。所以这里只标记，报告里给个提示，
   * 不当违规。
   */
  conditionalOnly?: boolean;
  /** 条件边的条件表达式（去重后） */
  conditions?: string[];
  /**
   * 内部计数：这条边有多少来源是**无条件**的 / **有条件**的
   *
   * 判定 `conditionalOnly` 用它们 —— 一条边可能同时有两类来源
   *（比如某个头文件无条件 include 了 A，另一个文件在 `#ifdef` 里 include 了 A）。
   */
  unconditionalSources?: number;
  conditionalSources?: number;
}

/** 扫描结果 */
export interface ScanResult {
  /** 参与 import 图的源文件 */
  files: ScannedFile[];
  /** 模块名 → 该模块负责的全部文件（含契约、规格等非源文件） */
  moduleFiles: Map<string, string[]>;
  /**
   * 模块名 → 该模块负责的**代码文件**（不限语言）
   *
   * ADR-061：这里原先只放扫描器读得懂的文件（TS/JS/Python），
   * 于是 C++ 模块在报告里显示「0 源码」—— 而它明明有几十个 `.cpp`。
   *
   * 「源码」和「扫描器读得懂的源码」是**两件事**，
   * 报告里要用两个字段分别表达。
   */
  moduleCodeFiles: Map<string, string[]>;
  /**
   * 模块名 → 该模块里**已验证**（扫描器读得懂、参与了 import 图）的文件
   *
   * ADR-061 新增。`moduleCodeFiles.length - moduleVerifiedFiles.length`
   * 就是这个模块「有代码但没验过」的部分。
   */
  moduleVerifiedFiles: Map<string, string[]>;
  /**
   * 模块名 → 该模块里**生产代码**（非测试）的文件
   *
   * ADR-066 新增。测试文件不产生依赖边，所以一个**全是测试**的模块
   * 在依赖图里没有边 —— 它声明的依赖会全部报「缺失依赖」，
   * 那是假阳性（不是设计说错了，是这个模块本来就不在生产架构里）。
   *
   * 用这份清单判断「这个模块有没有生产代码」，
   * 再决定要不要比对它的声明依赖。
   */
  moduleProductionFiles: Map<string, string[]>;
  /** 模块之间的实际依赖边 */
  edges: ModuleEdge[];
  /** 没有模块认领的源文件 */
  unmapped: string[];
  /** 相对路径解析不到目标文件的 import */
  unresolved: Array<{ file: string; specifier: string }>;
  /**
   * 语言覆盖面 —— 本次扫描**能验证什么、不能验证什么**。
   *
   * ADR-060 §4 方案 A：没有它，`arch check` 在 C++ 项目上会输出
   * 「无法验证若干项」，看起来像「项目有点小问题」，
   * 而真相是「**这个工具在这个项目上没有判据**」。
   *
   * 这两件事对人的行动含义完全不同 —— 前者说「去修」，
   * 后者说「补判据或换工具」。
   */
  coverage: LangCoverage;
  /**
   * **vendor 目录**（外部代码的边界）—— ADR-065
   *
   * 相对项目根的路径前缀，如 `src/third_party`、`vendor`。
   *
   * 这些目录里是**引入的外部代码**，不是项目的架构。
   * 它们的内部依赖结构不是人的设计决策，
   * 把它们算进依赖图只会淹没真正的架构信号。
   */
  vendorDirs: string[];
  /**
   * vendor 目录里的文件（被排除在依赖图之外）
   *
   * 报告里要单独说清「有多少文件因为是 vendor 代码没参与验证」——
   * 否则「已验证 N 个文件」会给人「整个项目都验过了」的错觉。
   */
  vendorFiles: string[];
  /**
   * **vendor 模块** —— 设计里声明了、但整个模块都是 vendor 目录的模块
   *
   * 真实项目里设计会写一个 `src/third_party` 模块，职责是「第三方库集成」。
   * 这个模块**不是架构的一部分** —— 它是外部边界。
   *
   * 报告里要单独标出来：它的依赖不算「未声明依赖」，
   * 它的文件数不算进「已验证」的总账。
   */
  vendorModules: string[];
}

/** 语言类别的可读名（报告用） */
export const LANG_CATEGORY_LABELS: Record<LangCategory, string> = {
  typescript: 'TypeScript / JavaScript',
  python: 'Python',
  cpp: 'C / C++',
  go: 'Go',
  rust: 'Rust',
  java: 'Java / Kotlin',
  build: '构建脚本',
  doc: '文档',
  config: '配置文件',
  other: '其它文件',
};

/** 语言覆盖面 */
export interface LangCoverage {
  /** 每种语言类别的文件数 */
  counts: Record<LangCategory, number>;
  /**
   * 能参与依赖验证的语言类别（已实现 import 解析）。
   *
   * 这些类别之外的代码文件，其依赖关系**没有被验证过**。
   */
  verifiable: LangCategory[];
  /**
   * 参与了 import 图的文件数
   */
  verifiedFiles: number;
  /**
   * 属于「代码类」但无法参与验证的文件数
   * （即 C++ / Go / Rust / Java 这些 —— 它们是代码，但不是「不产生依赖边」的东西）
   */
  unverifiableCodeFiles: number;
  /**
   * 不产生模块依赖边的文件数（构建脚本 / 文档 / 配置）
   */
  nonCodeFiles: number;
  /**
   * 总文件数
   */
  totalFiles: number;
  /**
   * vendor 目录里的文件数（ADR-065）
   *
   * 这些文件**没参与**依赖验证，但它们**不是**「这个工具没判据」——
   * 它们是引入的外部代码，本来就不该算进架构。
   *
   * 单独计数是为了让报告能说清：
   * 「已验证 47 个 C++ 文件（另有 4434 个在 vendor 目录里，不参与架构检查）」。
   */
  vendorFiles: number;
  /**
   * 测试文件数（ADR-066）
   *
   * 测试文件**不参与**依赖验证 —— 它们不产生依赖边（测试引用被测对象
   * 是测试的本职，不是架构耦合）。
   *
   * 单独计数是为了让报告能说清：
   * 「已验证 47 个 C++ 文件（另有 120 个测试文件不参与架构检查）」——
   * 而不能让测试文件混进「验不了」的分母里，那会让覆盖率失真。
   */
  testFiles: number;
}

/** 偏离类型 */
export type DeviationKind =
  | 'missing_dependency'       // 声明了依赖，实际代码里没有
  | 'undeclared_dependency'     // 实际代码里有依赖，设计里没声明
  | 'ambiguous_module'          // 一个文件被多个模块认领
  | 'unmapped_file'             // 有文件没有模块认领
  | 'unknown_module'            // 依赖指向的模块在设计里根本不存在
  | 'unverifiable_dependency'   // 目标模块没有源文件，无法用 import 验证
  | 'empty_module'              // 模块声明了，但一个文件都没匹配上（ADR-062 §4.4）
  | 'conditional_dependency'    // 这条依赖只在条件编译下存在（ADR-064）
  | 'cycle';                    // 实际依赖成环

/** 一条偏离 */
export interface Deviation {
  kind: DeviationKind;
  from: string;
  to: string;
  detail: string;
}

/** 报告 */
export interface ArchitectureReport {
  /** 每个模块的概况 */
  modules: Array<{
    name: string;
    /** 负责的文件总数 */
    fileCount: number;
    /**
     * 负责的**代码文件**数（不限语言）
     *
     * ADR-061：原先这个字段只数扫描器读得懂的文件，
     * 于是 C++ 模块显示「0 源码」。`.cpp` / `.hpp` 就是源码，
     * 只不过扫描器读不懂。
     */
    codeFileCount: number;
    /**
     * 负责的**已验证**文件数（扫描器读得懂、参与了 import 图）
     *
     * `codeFileCount - verifiedFileCount` = 有代码但没验过的部分。
     */
    verifiedFileCount: number;
    declaredDeps: string[];
    actualDeps: string[];
    /**
     * 这个模块是不是 **vendor 模块**（外部边界，不是架构的一部分）
     *
     * ADR-065：设计里常写一个 `src/third_party` 模块，职责是「第三方库集成」。
     * 这个模块的依赖**不算**架构耦合。
     */
    isVendor?: boolean;
  }>;
  /** 设计里声明的依赖边 */
  declaredEdges: string[];
  /** 代码里实际的依赖边 */
  actualEdges: string[];
  deviations: Deviation[];
  /** 实际依赖里的环 */
  cycles: string[][];
  /**
   * 语言覆盖面 —— 本次扫描能验证什么、不能验证什么。
   *
   * ADR-060 §4 方案 A：没有它，「无偏离」的结论会覆盖
   * 根本没被验证过的文件。
   */
  coverage: LangCoverage;
  /**
   * **vendor 目录**（ADR-065）—— 引入的外部代码的边界
   *
   * 报告里要单独说清：这些目录里的代码**没有参与**架构检查。
   */
  vendorDirs: string[];
  /**
   * **vendor 模块** —— 设计里声明的、但属于外部边界的模块
   */
  vendorModules: string[];
  /** 没有偏离为 true（软偏离不算） */
  ok: boolean;
}
