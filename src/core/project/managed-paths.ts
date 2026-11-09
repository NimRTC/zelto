// zelto 自己管理的路径 —— 「哪些文件是 zelto 的产物，不是人的代码」
//
// 为什么要单列一个模块：合并前有一个守卫（主仓工作区必须干净），
// 这个守卫会问「工作区里有没有未提交改动」。zelto 写的规格文件
// （`specs/slices/*.md`）也会出现在答案里 —— 但它不是「代码改动」，
// 合并不会碰它。把它算成「工作区不干净」，就会让合并永远被拦下：
// 接管既有项目时基线规格是新建文件，人还没来得及提交，合并就过不去。
//
// 口径只认「zelto 管理的规格文件」，不认别的：
//   - `.zelto/` 是运行时状态，本来就在 .gitignore 里，不会出现在 porcelain 输出里
//   - `specs/slices/` 下的规格文件是**追溯链的出处**，要入库、要看、要提交，
//     但它们不是代码改动，不该挡住合并
//
// C3：纯路径判定，不读文件、不调模型、不触网。

/** zelto 管理的规格文件目录（相对仓库根） */
export const MANAGED_SPEC_PREFIX = 'specs/slices/';

/**
 * 这个路径是不是 zelto 管理的规格文件？
 *
 * 只认仓库根下的 `specs/` 树 —— 别的目录里恰好有个同名子目录不算。
 *
 * 还有一个坑：git 报告未跟踪内容时会**把目录折叠成目录本身**
 * （`?? specs/` 而不是 `?? specs/slices/epsilon.md`）。所以除了目录里的文件，
 * 它的祖先目录（`specs`、`specs/slices`）也要认 —— 否则未跟踪的规格目录
 * 照样会挡住合并。
 */
export function isZeltoManagedSpecPath(path: string): boolean {
  const normalized = path.replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, '');
  if (normalized.startsWith(MANAGED_SPEC_PREFIX)) return true;
  // 祖先目录（`specs`、`specs/slices`）：未跟踪目录折叠的情况
  return normalized === 'specs' || normalized === 'specs/slices';
}
