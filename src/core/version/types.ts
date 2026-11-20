// Version types

export type VersionStatus = 'planned' | 'in_progress' | 'integrated' | 'delivered';

export interface VersionSlice {
  id: string;
  module: string;
  title: string;
  writes: string[];
  specPath: string;
  state?: string;
}

export interface Version {
  version: string;
  dependsOn: string[];
  description: string;
  slices: VersionSlice[];
  integrationTestDir: string;
  status: VersionStatus;
  /** 版本分支名；缺省派生为 `version/<label>` */
  branch?: string;
  /** 版本分支的基点 commit（建分支时的位置；可以是主干 HEAD、前置版本 tip，或计划里显式钉死的提交） */
  baseCommit?: string | null;
  /** 版本 tag 名；缺省派生为 `v<label>`（ADR-056 D6） */
  tag?: string;
  /**
   * 这个版本的分支是不是**补建**的（ADR-056 迁移）。
   *
   * 老项目升级到版本分支制度时，版本已经在跑（`in_progress`），
   * 但版本分支从不存在 —— 得由 `zelto version adopt` 补建。
   *
   * 补建的基点是**补建时刻**的主干 HEAD，不是原始基点
   * （老项目从来没有版本级基点这个概念）。
   * 记这个标记是为了**事后审计能看出区别** ——
   * 否则基点看起来跟原生的一样，追溯链会撒谎。
   */
  adopted?: boolean;
  /** 补建时刻（ISO 时间） */
  adoptedAt?: string;
}

export interface VersionPlan {
  id: string;
  designId: string;
  title: string;
  versions: Version[];
  status: 'draft' | 'confirmed';
  createdAt: string;
  confirmedAt: string | null;
}

export interface VersionSummary {
  id: string;
  title: string;
  versionCount: number;
  status: 'draft' | 'confirmed';
  createdAt: string;
}
