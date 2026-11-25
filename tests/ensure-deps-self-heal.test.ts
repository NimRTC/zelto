// 依赖自检与自愈 —— 并发 `pnpm install` 弄坏 node_modules 时的兜底
//
// 病灶（2026-11-25 实测，本机连踩三次）：
//
//   `npm test` / `npm run build` 突然报：
//
//     error TS2307: Cannot find module '@anthropic-ai/claude-agent-sdk'
//     or its corresponding type declarations.
//
//   而 `node_modules/@anthropic-ai/claude-agent-sdk/` **目录还在** ——
//   它是个 junction，指向 `.pnpm/` 下的实体目录。
//
//   真相：那个**实体目录被删了**，junction 变成悬空指针。
//
//   根因是**并发 `pnpm install`**：pnpm 的安装流程是
//   「删旧目录 → 从 store 重建」。两个进程同时跑时，
//   一个删掉了另一个正要用的目录；那个进程还占着文件句柄 →
//   `ERR_PNPM_EBUSY` → 它中途放弃，留下**半成品**：
//   junction 重建了，实体目录没重建。
//
//   后果的形状很恶劣：**编译报错完全不提「依赖坏了」**，
//   只说「找不到模块」—— 人第一反应是「代码写错了」，
//   而代码没问题，是环境坏了。
//
// 这个文件钉住三件事：
//   1. **判据**：悬空 junction / 缺 package.json 的半成品 → 判为「坏了」
//   2. **好的依赖不许误判**（不能因为一个包没装就报坏）
//   3. **修不好时必须中止**，不许带着坏依赖继续构建
//      —— 那样报错会指向错误的地方（比不修更坏）
//
// 注意：真去跑 `pnpm install` 会动真仓库的 node_modules，
// 所以测试只跑**判据部分**，不碰真实依赖。

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { tmpdir } from 'node:os';

/** 仓库根 —— 从本文件往上找 `package.json`（同 adr-080-build-lock.test.ts 的做法）。 */
const repoRoot = (() => {
  let dir = dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
  for (;;) {
    if (existsSync(join(dir, 'package.json'))) return dir;
    const up = dirname(dir);
    if (up === dir) throw new Error('找不到仓库根（没有 package.json）');
    dir = up;
  }
})();

const ensureDepsPath = join(repoRoot, 'scripts', 'ensure-deps.mjs');

type EnsureDepsApi = {
  inspectPackageForTest: (pkgDir: string) => string | null;
};

// 动态 import —— 路径是运行时算出来的，TS 没法静态解析（同 adr-080）
const { inspectPackageForTest } = (await import(
  pathToFileURL(ensureDepsPath).href
)) as EnsureDepsApi;

const TEST_DIR = join(tmpdir(), `zelto-ensure-deps-${Date.now()}`);

/** 造一个「装好了的包」：普通目录 + package.json。 */
function makeGoodPackage(base: string, name: string): string {
  const dir = join(base, 'node_modules', ...name.split('/'));
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name, version: '1.0.0' }), 'utf-8');
  return dir;
}

/**
 * 造一个「悬空 junction」：链接指向不存在的目录。
 *
 * 布局要跟 pnpm 真实布局一致：**`node_modules/@scope/name` 本身就是 junction**
 * （不是 `@scope/name/name`）—— 否则测的就不是真实形态了。
 *
 * 注意：**junction 所在路径不能预先存在**（junction 自己就是那个路径），
 * 所以只建它的**父目录**。
 */
function makeDanglingLink(base: string, name: string, targetRel: string): string {
  const parts = name.split('/');
  const link = join(base, 'node_modules', ...parts);
  mkdirSync(dirname(link), { recursive: true });
  symlinkSync(targetRel, link, 'junction');
  return link;
}

describe('依赖自检：判据', () => {
  it('装好的包 → 不许误判为坏', () => {
    rmSync(TEST_DIR, { recursive: true, force: true });
    const base = join(TEST_DIR, 'ok');
    mkdirSync(base, { recursive: true });
    makeGoodPackage(base, '@scope/good');

    const reason = inspectPackageForTest(join(base, 'node_modules', '@scope', 'good'));
    assert.equal(reason, null, `装好的包不该被判坏，实际：${reason}`);
  });

  it('压根没装的包 → 判为坏（声明在 package.json 里的依赖，没装上就是坏了）', () => {
    rmSync(TEST_DIR, { recursive: true, force: true });
    const base = join(TEST_DIR, 'missing');
    mkdirSync(base, { recursive: true });

    const reason = inspectPackageForTest(join(base, 'node_modules', '@scope', 'absent'));
    assert.ok(reason !== null, '声明过的依赖压根没装 → 判为坏（重装能修）');
    assert.match(reason, /不存在/);
  });

  it('悬空 junction（目标不存在）→ 判为坏，且**说得出是哪一种坏**', () => {
    rmSync(TEST_DIR, { recursive: true, force: true });
    const base = join(TEST_DIR, 'dangling');
    mkdirSync(base, { recursive: true });
    // 指向一个不存在的目录 —— 这正是并发 install 留下的形态
    makeDanglingLink(base, '@scope/dangling', join(base, 'node_modules', '.pnpm', 'gone'));

    const reason = inspectPackageForTest(join(base, 'node_modules', '@scope', 'dangling'));
    assert.ok(reason !== null, '悬空 junction 必须被判坏');
    // 消息要**指认根因** —— 人靠这句话判断发生了什么。
    // 「链接指向的目录不存在」比「目录里没有 package.json」准得多。
    assert.match(reason, /链接指向的目录不存在/);
  });
  it('半成品（目录在但没 package.json）→ 判为坏', () => {
    rmSync(TEST_DIR, { recursive: true, force: true });
    const base = join(TEST_DIR, 'partial');
    mkdirSync(base, { recursive: true });
    const dir = join(base, 'node_modules', '@scope', 'partial');
    mkdirSync(dir, { recursive: true }); // 有目录，没 package.json

    const reason = inspectPackageForTest(dir);
    assert.ok(reason !== null, '半成品必须被判坏');
    assert.match(reason, /package\.json/);
  });

  it('Windows 上的 junction 也认得出来（pnpm 在 Windows 上正是用 junction）', () => {
    // 这条钉住一个真实的坑：
    //   **Windows 的 junction 在 Node 里 `lstatSync` 返回 `isSymbolicLink() === true`，
    //   但 `isDirectory()` 是 false**（junction 自己不是目录）。
    //   所以判「这是不是一个目录」必须用 `statSync`（它穿透），
    //   判「这是不是链接」用 `lstatSync`。**混用会得出相反的结论**。
    //
    // 判据必须跨平台：主判据是「能不能读到 package.json」，
    // 链接检查只是**补充**（用来把坏的原因说准）。
    rmSync(TEST_DIR, { recursive: true, force: true });
    const base = join(TEST_DIR, 'junction');
    mkdirSync(base, { recursive: true });

    // 造一个**好的** junction：目标是个真有 package.json 的目录
    const realTarget = join(base, 'real');
    mkdirSync(realTarget, { recursive: true });
    writeFileSync(join(realTarget, 'package.json'), '{"name":"@scope/j"}', 'utf-8');

    // 布局跟 pnpm 一致：`node_modules/@scope/j` 本身就是 junction
    const scopeDir = join(base, 'node_modules', '@scope');
    mkdirSync(scopeDir, { recursive: true });
    const link = join(scopeDir, 'j');
    symlinkSync(realTarget, link, 'junction');

    // 好的 junction → 不许误判为坏
    const okReason = inspectPackageForTest(link);
    assert.equal(okReason, null, `好的 junction 不该被判坏，实际：${okReason}`);
  });

  it('「修不好就中止」是硬要求 —— 带着坏依赖继续构建，报错会指向错误的地方', () => {
    // 这条不跑真的 install（那会动真仓库），而是断言**契约**：
    // `ensureDependenciesHealthy()` 返回 `{ ok: false }` 时，
    // 调用方（buildDist）必须抛出去中止，而不是继续编译。
    const src = readFileSync(join(repoRoot, 'scripts', 'build-dist.mjs'), 'utf-8');

    assert.match(
      src,
      /if \(!deps\.ok\)[\s\S]{0,300}throw/,
      '依赖检查没过时必须 throw 中止 —— 继续构建会让 tsc 的报错指向错误的地方',
    );
  });

  it('依赖自检必须挂在编译**之前**（否则编译仍会报误导性的「找不到模块」）', () => {
    const src = readFileSync(join(repoRoot, 'scripts', 'build-dist.mjs'), 'utf-8');

    const depsAt = src.indexOf('ensureDependenciesHealthy()');
    // 编译点取**实际调用 tsc 的那行**（`execFileSync(..., [tscBin, ...])`），
    // 不是 import 行 —— import 在文件头，比什么都靠前，比不了。
    const compileAt = src.indexOf('execFileSync(process.execPath, [tscBin');
    assert.ok(depsAt > 0, 'build-dist.mjs 里必须有依赖自检');
    assert.ok(compileAt > 0, 'build-dist.mjs 里必须有编译调用');
    assert.ok(
      depsAt < compileAt,
      '依赖自检必须在编译之前 —— 编译时报的「找不到模块」正是要避免的误导',
    );
  });
});
