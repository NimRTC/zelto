// zelto 生成的验收骨架 —— 「哪些验收文件还是 zelto 造的，不是人的代码」
//
// 为什么单列一个模块（ADR-056 真实项目验证发现的）：
//
// 合并与 ship 之前都有一个守卫：目标工作区必须干净。守卫要拦的是
// 「人改了代码还没提交」—— 合并会把分支上的改动带进主干，
// 未提交的本地改动会被盖掉。
//
// 但 zelto 自己生成的**验收骨架**（`tests/acceptance/<id>/acceptance.test.cjs`，
// 全是 `test.todo`，见 ADR-034 / ADR-046）也会出现在「工作区不干净」里。
// 它不是代码改动 —— 它是**追溯链的出处**（规格的可执行投影），
// 跟 `specs/slices/**` 同一个性质。
//
// 不豁免它的后果很实际：`zelto version start` 会给每个切片生成骨架 →
// 主仓多出未跟踪的 `tests/acceptance/<id>/` → **之后所有 merge 与 ship
// 都被这个守卫拦下**（真实项目 nimrtc-zelto 上实测到的）。
//
// 豁免的边界：**只豁免还是纯 todo 的骨架**。
// agent 把 todo 改成真断言之后，那份文件就是**代码**了 —— 它进了写集、
// 参与门禁②判定，合并会覆盖它，必须挡住。
//
// C3：确定性 —— 只读文件、按固定形态判定，不调模型、不触网。

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

/** 验收目录（相对仓库根） */
export const ACCEPTANCE_DIR_PREFIX = 'tests/acceptance/';

/** 骨架文件名 */
export const SKELETON_FILE_NAME = 'acceptance.test.cjs';

/**
 * 这个路径是不是还在 `tests/acceptance/**` 下面？
 *
 * 只认仓库根下的验收目录 —— 别的目录里恰好有个同名子目录不算。
 */
export function isAcceptancePath(path: string): boolean {
  const normalized = path.replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, '');
  return normalized.startsWith(ACCEPTANCE_DIR_PREFIX);
}

/**
 * 这个验收文件是不是「还全是 todo 的骨架」？
 *
 * 判据是**内容形态**：骨架里的每条用例都是 `test.todo(...)`。
 * 只要出现一条真断言（`test(` / `it(` / `describe(` 开头而不是 `.todo`），
 * 就不再是骨架 —— 那份文件里有人的（或 agent 的）工作，不能豁免。
 *
 * @param path 相对仓库根的路径
 * @param root 仓库根
 */
export function isUntouchedAcceptanceSkeleton(path: string, root: string): boolean {
  if (!isAcceptancePath(path)) return false;

  const normalized = path.replace(/\\/g, '/').replace(/\/+$/, '');
  const abs = join(root, normalized);

  // git 报告未跟踪内容时会把目录**折叠成目录本身**
  // （`?? tests/acceptance/v2-x/` 而不是逐个文件）。
  // 折叠的目录名不代表「里面只有骨架」—— 目录里可能有 agent 写的真断言。
  //
  // 折叠情形单独判：目录里的**每一个** `acceptance.test.cjs` 都得是纯 todo，
  // 且目录里不能有别的 `.cjs/.ts/.js` 文件（有的话说明有真代码，不豁免）。
  if (existsSync(abs) && statSync(abs).isDirectory()) {
    return directoryIsAllSkeletons(abs);
  }

  if (!existsSync(abs)) return false;

  let content: string;
  try {
    content = readFileSync(abs, 'utf-8');
  } catch {
    return false; // 读不到 → 不豁免（保守）
  }

  return isPureTodoSkeleton(content);
}

/**
 * 这个目录里是不是只有「还全是 todo 的骨架」？
 *
 * 判据：
 * - 目录里至少有一个 `acceptance.test.cjs`
 * - 每个 `acceptance.test.cjs` 都是纯 todo
 * - 没有别的测试源文件（`.cjs` / `.ts` / `.js` / `.mjs`）——
 *   有的话说明里面已经有真代码，不能豁免
 */
function directoryIsAllSkeletons(dirAbs: string): boolean {
  let entries: string[];
  try {
    entries = readdirSync(dirAbs);
  } catch {
    return false;
  }

  const testFiles = entries.filter((e) => /\.(cjs|mjs|js|ts)$/.test(e));
  if (testFiles.length === 0) return false;

  // 有骨架以外的文件 → 不是「只有骨架」
  const nonSkeleton = testFiles.filter((e) => e !== SKELETON_FILE_NAME);
  if (nonSkeleton.length > 0) return false;

  // 每个骨架都得是纯 todo
  for (const name of testFiles) {
    let content: string;
    try {
      content = readFileSync(join(dirAbs, name), 'utf-8');
    } catch {
      return false;
    }
    if (!isPureTodoSkeleton(content)) return false;
  }

  return true;
}

/**
 * 内容是不是「纯 todo 骨架」？
 *
 * 抽成独立函数是为了能直接测（不依赖文件系统）。
 *
 * 判据：
 * - 至少有一条 `test.todo(` —— 否则压根不是骨架
 * - 没有任何**真断言**（`test(` / `it(` / `test.only(` / `test.skip(` 等）
 */
export function isPureTodoSkeleton(content: string): boolean {
  // 有真断言 → 不是骨架
  // （`test.todo(` 不会被 `test(` 匹配到 —— 中间有 `.todo`）
  if (/(^|[^.\w])(test|it|describe)\s*(\.\s*(only|skip|todo|each|concurrent)\s*)?\(/.test(content)) {
    // 逐个用例判定更准：把 `.todo` 变体排除掉
    const hasRealAssertion =
      /(^|[^.\w])(test|it|describe)\s*\(\s*['"`]/.test(content) ||
      /(^|[^.\w])(test|it)\s*\.\s*(only|skip|concurrent)\s*\(/.test(content);
    if (hasRealAssertion) return false;
  }

  // 至少要有一条 todo
  return /(test|it)\s*\.\s*todo\s*\(/.test(content);
}
