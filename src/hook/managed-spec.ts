// zelto 托管的规格文件 —— hook 侧的口径（ADR-054）
//
// 与 `core/project/managed-paths.ts` 是同一套口径，但**必须各有一份**：
// hook 是**可独立编译的判定进程**，不能 import core/（否则 hook 就得拖上
// 整个 core 的编译产物）。「有意复制」不等于「可以漂移」—— 两边的一致性
// 由 `tests/adr-054-managed-spec-commit-exemption.test.ts` 守住。
//
// 这些文件是**谁写的**：zelto 自己。
//   - `zelto spec confirm` 把人批准的正式规格写进主仓；
//   - 跑切片时 zelto 把规格副本放进隔离 worktree，让 agent 读得到；
//   - 合并时 zelto 把 worktree 里的规格提交回主干。
//
// 所以提交时刻它们出现在 diff 里是**正常的**，不是「谁写了不该写的地方」。
// 它们的边界由更细的两层管：写集预约（agent 只能写自己写集里的路径）
// 与托管文件哈希（规格副本被改动 = 篡改，审计阶段会报）。

/** zelto 管理的规格文件目录（相对仓库根） */
export const MANAGED_SPEC_PREFIX = 'specs/slices/';

/**
 * 这个路径是不是 zelto 托管的规格文件？
 *
 * 只认仓库根下的 `specs/` 树 —— 别的目录里恰好有个同名子目录不算。
 *
 * 还有一个坑：git 报告未跟踪内容时会**把目录折叠成目录本身**
 * （`?? specs/` 而不是 `?? specs/slices/epsilon.md`）。所以除了目录里的文件，
 * 它的祖先目录（`specs`、`specs/slices`）也要认 —— 否则未跟踪的规格目录
 * 照样会被当成「有人写了不该写的地方」。
 */
export function isZeltoManagedSpecPath(path: string): boolean {
  const normalized = path.replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, '');
  if (normalized.startsWith(MANAGED_SPEC_PREFIX)) return true;
  // 祖先目录（`specs`、`specs/slices`）：未跟踪目录折叠的情况
  return normalized === 'specs' || normalized === 'specs/slices';
}
