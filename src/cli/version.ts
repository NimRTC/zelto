// Version information for zelto CLI
// Reads version from package.json

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getDefaultFormatter } from './output-formatter.js';

interface PackageJson {
  version: string;
  name?: string;
}

/**
 * 找到 package.json。
 *
 * 相对**模块自身**定位，不是相对 cwd —— `zelto --version` 会在任何目录里跑
 * （连别人的项目里），按 cwd 找会找不到文件，直接崩。
 *
 * 向上逐级找，因为模块深度在两种构建布局下不同：
 *   dist/cli/version.js     → 仓库根
 *   dist-test/src/cli/version.js → 仓库根
 */
function findPackageJson(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 6; i++) {
    const candidate = join(dir, 'package.json');
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  // 找不到就退回 cwd（至少给个明确的失败而不是静默错值）
  return join(process.cwd(), 'package.json');
}

const PKG_PATH = findPackageJson();

function loadPackageJson(): PackageJson {
  const raw = readFileSync(PKG_PATH, 'utf-8');
  return JSON.parse(raw) as PackageJson;
}

const pkg = loadPackageJson();

/** The version string from package.json (e.g. "0.1.0") */
export const VERSION: string = pkg.version;

/** Returns a formatted version string: "zelto v{version}" */
export function getVersionString(): string {
  return `zelto v${VERSION}`;
}

/**
 * Print version using OutputFormatter and return exit code.
 */
export function printVersion(): number {
  const f = getDefaultFormatter();
  f.out(getVersionString());
  return 0;
}
