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

/** 源码语言 */
export type SourceLang = 'ts' | 'python';

/** 一条 import 引用 */
export interface ImportRef {
  /** 原始说明符，如 './db'、'@app/db'、'os' */
  specifier: string;
  kind: 'relative' | 'package' | 'builtin';
  /** 1 基行号 */
  line: number;
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
}

/** 模块之间的一条实际依赖边 */
export interface ModuleEdge {
  from: string;
  to: string;
  /** 产生这条边的文件 */
  files: string[];
  /** 涉及的说明符 */
  specifiers: string[];
}

/** 扫描结果 */
export interface ScanResult {
  /** 参与 import 图的源文件 */
  files: ScannedFile[];
  /** 模块名 → 该模块负责的全部文件（含契约、规格等非源文件） */
  moduleFiles: Map<string, string[]>;
  /** 模块名 → 该模块负责的源文件 */
  moduleCodeFiles: Map<string, string[]>;
  /** 模块之间的实际依赖边 */
  edges: ModuleEdge[];
  /** 没有模块认领的源文件 */
  unmapped: string[];
  /** 相对路径解析不到目标文件的 import */
  unresolved: Array<{ file: string; specifier: string }>;
}

/** 偏离类型 */
export type DeviationKind =
  | 'missing_dependency'       // 声明了依赖，实际代码里没有
  | 'undeclared_dependency'     // 实际代码里有依赖，设计里没声明
  | 'ambiguous_module'          // 一个文件被多个模块认领
  | 'unmapped_file'             // 有文件没有模块认领
  | 'unknown_module'            // 依赖指向的模块在设计里根本不存在
  | 'unverifiable_dependency'   // 目标模块没有源文件，无法用 import 验证
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
    /** 负责的源文件数 */
    codeFileCount: number;
    declaredDeps: string[];
    actualDeps: string[];
  }>;
  /** 设计里声明的依赖边 */
  declaredEdges: string[];
  /** 代码里实际的依赖边 */
  actualEdges: string[];
  deviations: Deviation[];
  /** 实际依赖里的环 */
  cycles: string[][];
  /** 没有偏离为 true（软偏离不算） */
  ok: boolean;
}
