// Version information for zelto CLI
// Reads version from package.json

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { getDefaultFormatter } from './output-formatter.js';

const PKG_PATH = join(process.cwd(), 'package.json');

interface PackageJson {
  version: string;
  name?: string;
}

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
