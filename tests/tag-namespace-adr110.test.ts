// ADR-110 单元测试 —— 版本 tag 命名空间按「计划」寻址
//
// 规格：specs/slices/v4-tag-namespace-adr110.md
// ADR：docs/adr/adr-110-version-tag-plan-scoped-namespace.md
//
// 本文件测**纯函数**与**脚本进程**两层：
//   · 纯函数层：planVersionTagName 的输出形状（core/version/branch.ts）
//   · 脚本层：tag-namespace.mjs / version-check.mjs 的真实退出码
//
// 脚本层一律**实跑**（临时仓库或真实仓库），
// 不靠断言源码文本 —— 断言文本证明不了「算得对」。

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { planVersionTagName, versionTagName } from '../src/core/version/branch.js';
import type { VersionPlan } from '../src/core/version/types.js';

// 编译后本文件在 dist-test/tests/ 下 —— 往上两级才是仓库根。
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const TAG_SCRIPT = join(ROOT, 'scripts', 'tag-namespace.mjs');
const VERSION_CHECK_SCRIPT = join(ROOT, 'scripts', 'version-check.mjs');

// ── 工具 ────────────────────────────────────────────────────────────────────

/** 跑 tag-namespace.mjs，传给定的 tag，返回 { status, output }。 */
function runTagScript(tags: string[], extraArgs: string[] = []) {
    const res = spawnSync(process.execPath, [TAG_SCRIPT, ...extraArgs, ...tags], {
        cwd: ROOT,
        encoding: 'utf8',
    });
    return { status: res.status, output: (res.stdout || '') + (res.stderr || '') };
}

/**
 * 造一个临时 git 仓库，含 package.json / pnpm-lock.yaml 与指定的 tag。
 * 返回目录路径（调用方负责清理）。
 */
function makeTempRepo({ pkgVersion, tags = [] }: { pkgVersion: string; tags?: string[] }) {
    const dir = mkdtempSync(join(tmpdir(), 'adr110-'));
    writeFileSync(
        join(dir, 'package.json'),
        JSON.stringify({ name: 'probe', version: pkgVersion, dependencies: { dep: '1.0.0' } }, null, 2),
    );
    writeFileSync(
        join(dir, 'pnpm-lock.yaml'),
        "lockfileVersion: '9.0'\nimporters:\n  .:\n    dependencies:\n      dep:\n        specifier: 1.0.0\n        version: 1.0.0\n",
    );
    const git = (args: string[]) => spawnSync('git', args, { cwd: dir, encoding: 'utf8' });
    git(['init', '-q']);
    git(['config', 'user.email', 'probe@example.com']);
    git(['config', 'user.name', 'probe']);
    git(['add', '-A']);
    git(['commit', '-q', '-m', 'init']);
    const sha = git(['rev-parse', 'HEAD']).stdout.trim();
    for (const t of tags) git(['tag', '-a', t, sha, '-m', t]);
    return dir;
}

/** 在临时仓库里跑 version-check.mjs。 */
function runVersionCheck(dir: string) {
    const res = spawnSync(process.execPath, [VERSION_CHECK_SCRIPT], {
        cwd: dir,
        encoding: 'utf8',
    });
    return { status: res.status, output: (res.stdout || '') + (res.stderr || '') };
}

// ── 验收标准 1：命名形态 ───────────────────────────────────────────────────

describe('验收标准 1：命名形态改为按计划寻址', () => {
    test('plan-<planId>/v<n> 合法', () => {
        const r = runTagScript(['plan-1795507341754/v3']);
        assert.equal(r.status, 0, `应合法，实际 ${r.status}：\n${r.output}`);
    });

    test('旧形态 plan-<semver>/v<n> 非法（否则等于没改）', () => {
        const r = runTagScript(['plan-0.7.1/v3']);
        assert.notEqual(r.status, 0, `旧形态必须非法，实际 ${r.status}：\n${r.output}`);
        assert.ok(/命名/.test(r.output), `错误信息应指出命名问题：\n${r.output}`);
    });

    test('裸版本 tag v1 / v2 / v3 非法', () => {
        for (const tag of ['v1', 'v2', 'v3']) {
            const r = runTagScript([tag]);
            assert.notEqual(r.status, 0, `裸 tag ${tag} 必须非法，实际 ${r.status}：\n${r.output}`);
        }
    });

    test('纯 semver tag 合法', () => {
        for (const tag of ['v0.6.0', 'v1.2.3', 'v10.0.0']) {
            const r = runTagScript([tag]);
            assert.equal(r.status, 0, `${tag} 应合法，实际 ${r.status}：\n${r.output}`);
        }
    });

    test('planId 不是 13 位数字时非法（不能放宽成 plan-.+）', () => {
        // 放宽会让 plan-0.7.1 这种旧形态也合法 —— 那等于没改。
        for (const tag of ['plan-abc/v1', 'plan-123/v1', 'plan-17955073417540/v1']) {
            const r = runTagScript([tag]);
            assert.notEqual(r.status, 0, `${tag} 应非法，实际 ${r.status}：\n${r.output}`);
        }
    });

    test('版本序号必须是非负整数', () => {
        for (const tag of ['plan-1795507341754/vx', 'plan-1795507341754/v1.5']) {
            const r = runTagScript([tag]);
            assert.notEqual(r.status, 0, `${tag} 应非法，实际 ${r.status}：\n${r.output}`);
        }
    });
});

// ── 验收标准 2：版本漂移不影响历史 tag ─────────────────────────────────────

describe('验收标准 2：版本漂移不影响历史 tag 的合法性', () => {
    test('tag-namespace.mjs 完全不读 package.json 的版本', () => {
        // 判据：**只管命名**。把 package.json 的版本改掉，
        // 历史 tag 的合法性必须一丝不变。
        //
        // 做法：复制仓库到临时目录（连 scripts 一起），
        // 在那里改 package.json 版本，比对退出码。
        const dir = mkdtempSync(join(tmpdir(), 'adr110-ver-'));
        try {
            // 复制最小必要文件
            mkdirSync(join(dir, 'scripts'), { recursive: true });
            writeFileSync(
                join(dir, 'scripts', 'tag-namespace.mjs'),
                readFileSync(TAG_SCRIPT, 'utf8'),
            );
            // tag-map.json 也要在（脚本会读它）。
            //
            // 用**空台账**而不是真仓库那份 —— 真台账记的是真仓库里那些 tag 的
            // commit，临时仓库里根本没有那些 tag，抄过来会让「改版本前就失败」
            // （失败原因是台账指向不存在的锚点，与本用例要测的无关）。
            writeFileSync(join(dir, 'scripts', 'tag-map.json'), JSON.stringify({}, null, 2));
            writeFileSync(
                join(dir, 'package.json'),
                JSON.stringify({ name: 'probe', version: '0.7.1' }, null, 2),
            );
            const git = (args: string[]) => spawnSync('git', args, { cwd: dir, encoding: 'utf8' });
            git(['init', '-q']);
            git(['config', 'user.email', 'p@e.com']);
            git(['config', 'user.name', 'p']);
            git(['add', '-A']);
            git(['commit', '-q', '-m', 'init']);
            const sha = git(['rev-parse', 'HEAD']).stdout.trim();
            git(['tag', '-a', 'plan-1795507341754/v3', sha, '-m', 'v3']);
            git(['tag', '-a', 'v0.6.0', sha, '-m', 'v0.6.0']);

            const run = () =>
                spawnSync(process.execPath, [join(dir, 'scripts', 'tag-namespace.mjs')], {
                    cwd: dir,
                    encoding: 'utf8',
                }).status;

            const before = run();
            assert.equal(before, 0, `改版本前应通过，实际 ${before}`);

            // **必须还原** —— 用 try/finally 保证异常路径也还原。
            try {
                writeFileSync(
                    join(dir, 'package.json'),
                    JSON.stringify({ name: 'probe', version: '0.9.9' }, null, 2),
                );
                const after = run();
                assert.equal(
                    after,
                    before,
                    `版本漂移后退出码必须不变（版本锚点是历史，不该因升版失效），实际 ${after} ≠ ${before}`,
                );
            } finally {
                writeFileSync(
                    join(dir, 'package.json'),
                    JSON.stringify({ name: 'probe', version: '0.7.1' }, null, 2),
                );
            }
            assert.equal(run(), 0, '还原后必须仍然通过');
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });
});

// ── 验收标准 3：不同计划的同名版本各有唯一合法名 ───────────────────────────

describe('验收标准 3：多计划不抢占同名', () => {
    test('两个计划的同名 v1 同时合法', () => {
        const r = runTagScript(['plan-1794562105642/v1', 'plan-1795422836717/v1']);
        assert.equal(r.status, 0, `两个都应合法，实际 ${r.status}：\n${r.output}`);
    });

    test('同一计划的多个版本各自合法', () => {
        const r = runTagScript([
            'plan-1795507341754/v1',
            'plan-1795507341754/v2',
            'plan-1795507341754/v3',
        ]);
        assert.equal(r.status, 0, `三个都应合法，实际 ${r.status}：\n${r.output}`);
    });
});

// ── 验收标准 4 / 5：ship 的 tag 派生与优先级 ───────────────────────────────

describe('验收标准 4/5：planVersionTagName 的形状与优先级', () => {
    test('派生出 plan-<planId>/v<label>', () => {
        assert.equal(planVersionTagName('plan-1795507341754', 'v3'), 'plan-1795507341754/v3');
        assert.equal(planVersionTagName('plan-1795507341754', '3'), 'plan-1795507341754/v3');
    });

    test('派生结果恒为合法形态（不含裸 tag）', () => {
        for (const label of ['v1', 'v2', 'v3', 'v10', '1', '2']) {
            const tag = planVersionTagName('plan-1795507341754', label);
            assert.match(
                tag,
                /^plan-\d{13}\/v\d+$/,
                `派生结果 ${tag} 必须匹配命名规则`,
            );
            const r = runTagScript([tag]);
            assert.equal(r.status, 0, `${tag} 应合法：\n${r.output}`);
        }
    });

    test('versionTagName 仍是 label 清洗工具，但不再产出 ship 的默认 tag', () => {
        // 它保留是为了别处仍用它做清洗 —— 但它会把 v1 原样返回（裸 tag）。
        assert.equal(versionTagName('v1'), 'v1');
        assert.equal(versionTagName('2.0'), '2.0');
    });

    test('version-ship.ts 的 tag 取值顺序是 version.tag 优先', () => {
        // 源码断言：ADR-078 的「钉子语义」必须保持 ——
        // 人显式填的 version.tag 优先于自动派生。
        //
        // **只看可执行代码，不看注释** ——
        // 注释里出现「旧写法 `versionTagName(versionLabel)`」是**解释**
        // （说明为什么改），不是判定。若连注释一起扫，
        // 就会逼着人把「为什么」删掉 —— 那等于让后来人失去上下文。
        const src = readFileSync(
            join(ROOT, 'src', 'cli', 'commands', 'version-ship.ts'),
            'utf8',
        );
        const code = src
            .split('\n')
            .map((l) => l.trim())
            .filter((l) => l !== '')
            .filter((l) => !l.startsWith('//'))
            .filter((l) => !l.startsWith('*'))
            .filter((l) => !l.startsWith('/*'))
            .join('\n');

        assert.ok(
            code.includes('version.tag ?? planVersionTagName('),
            'ship 的 tag 取值必须是 version.tag ?? planVersionTagName(...)',
        );
        assert.ok(
            !code.includes('versionTagName('),
            'ship 的可执行代码里不得再出现 versionTagName(...)（那会产出裸 tag）',
        );
    });
});

// ── 验收标准 6：台账与 git 事实不符时校验失败 ──────────────────────────────

describe('验收标准 6：迁移台账与 git 事实核对', () => {
    test('台账的 commit 与实际指向不符时报出具体差异', () => {
        const dir = mkdtempSync(join(tmpdir(), 'adr110-map-'));
        try {
            mkdirSync(join(dir, 'scripts'), { recursive: true });
            writeFileSync(
                join(dir, 'scripts', 'tag-namespace.mjs'),
                readFileSync(TAG_SCRIPT, 'utf8'),
            );
            writeFileSync(
                join(dir, 'scripts', 'tag-map.json'),
                JSON.stringify(
                    {
                        v9: {
                            new: 'plan-1795507341754/v9',
                            commit: 'deadbeef',
                        },
                    },
                    null,
                    2,
                ),
            );
            const git = (args: string[]) => spawnSync('git', args, { cwd: dir, encoding: 'utf8' });
            git(['init', '-q']);
            git(['config', 'user.email', 'p@e.com']);
            git(['config', 'user.name', 'p']);
            writeFileSync(join(dir, 'package.json'), '{"version":"0.7.1"}');
            git(['add', '-A']);
            git(['commit', '-q', '-m', 'init']);
            const sha = git(['rev-parse', 'HEAD']).stdout.trim();
            git(['tag', '-a', 'plan-1795507341754/v9', sha, '-m', 'v9']);

            const res = spawnSync(process.execPath, [join(dir, 'scripts', 'tag-namespace.mjs')], {
                cwd: dir,
                encoding: 'utf8',
            });
            const output = (res.stdout || '') + (res.stderr || '');
            assert.notEqual(res.status, 0, `台账不符必须失败，实际 ${res.status}：\n${output}`);
            assert.ok(
                output.includes('plan-1795507341754/v9'),
                `错误信息须含 tag 名：\n${output}`,
            );
            assert.ok(
                output.includes('deadbeef'),
                `错误信息须含台账记的 commit：\n${output}`,
            );
            assert.ok(
                output.includes(sha.slice(0, 7)),
                `错误信息须含 git 实际指向的 commit：\n${output}`,
            );
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    test('真实仓库的台账与 git 事实一致', () => {
        const r = runTagScript([]);
        assert.equal(r.status, 0, `仓库台账应自洽，实际 ${r.status}：\n${r.output}`);
    });

    test('台账条目必须带 commit（旧扁平格式不被接受）', () => {
        const dir = mkdtempSync(join(tmpdir(), 'adr110-flat-'));
        try {
            mkdirSync(join(dir, 'scripts'), { recursive: true });
            writeFileSync(
                join(dir, 'scripts', 'tag-namespace.mjs'),
                readFileSync(TAG_SCRIPT, 'utf8'),
            );
            writeFileSync(
                join(dir, 'scripts', 'tag-map.json'),
                JSON.stringify({ v1: 'plan-1795507341754/v1' }, null, 2),
            );
            const res = spawnSync(process.execPath, [join(dir, 'scripts', 'tag-namespace.mjs')], {
                cwd: dir,
                encoding: 'utf8',
            });
            const output = (res.stdout || '') + (res.stderr || '');
            assert.notEqual(res.status, 0, '旧扁平格式必须被拒绝');
            assert.ok(/commit/.test(output), `错误信息须指出缺 commit：\n${output}`);
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });
});

// ── 验收标准 7：build.mjs 的 tag 段只校验当前批次 ──────────────────────────

describe('验收标准 7：发布闸门不被历史 tag 锁死', () => {
    test('build.mjs 的 tag 段带 --published-only 参数', () => {
        const src = readFileSync(join(ROOT, 'scripts', 'build.mjs'), 'utf8');
        assert.ok(
            src.includes("args: ['--published-only']"),
            'build.mjs 的 tag-namespace 段必须带 --published-only（否则历史非法 tag 会锁死发布闸门）',
        );
    });

    test('--published-only 模式下历史批次的非法 tag 不阻断', () => {
        const dir = mkdtempSync(join(tmpdir(), 'adr110-po-'));
        try {
            mkdirSync(join(dir, 'scripts'), { recursive: true });
            writeFileSync(
                join(dir, 'scripts', 'tag-namespace.mjs'),
                readFileSync(TAG_SCRIPT, 'utf8'),
            );
            writeFileSync(
                join(dir, 'scripts', 'tag-map.json'),
                JSON.stringify({}, null, 2),
            );
            writeFileSync(join(dir, 'package.json'), '{"version":"0.7.1"}');
            const git = (args: string[]) => spawnSync('git', args, { cwd: dir, encoding: 'utf8' });
            git(['init', '-q']);
            git(['config', 'user.email', 'p@e.com']);
            git(['config', 'user.name', 'p']);
            git(['add', '-A']);
            git(['commit', '-q', '-m', 'init']);
            const sha = git(['rev-parse', 'HEAD']).stdout.trim();
            // 一条**历史批次**的非法 tag（旧形态）
            git(['tag', '-a', 'plan-0.7.0/v1', sha, '-m', 'old']);

            const script = join(dir, 'scripts', 'tag-namespace.mjs');
            const full = spawnSync(process.execPath, [script], { cwd: dir, encoding: 'utf8' });
            assert.notEqual(
                full.status,
                0,
                '全量模式下历史非法 tag 应被报出来（这正是缺陷一的病根）',
            );

            const only = spawnSync(process.execPath, [script, '--published-only'], {
                cwd: dir,
                encoding: 'utf8',
            });
            assert.equal(
                only.status,
                0,
                `--published-only 下历史批次不该阻断发版，实际 ${only.status}：\n${only.stdout}${only.stderr}`,
            );
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });
});

// ── 验收标准 8：version-check 判出版本不一致 ────────────────────────────────

describe('验收标准 8：发布锚点的版本一致性', () => {
    test('package.json 版本低于已发布版本时报出不一致', () => {
        const dir = makeTempRepo({ pkgVersion: '0.6.0', tags: ['v0.7.1'] });
        try {
            const r = runVersionCheck(dir);
            assert.notEqual(r.status, 0, `版本落后必须被拦，实际 ${r.status}：\n${r.output}`);
            assert.ok(/0\.7\.1/.test(r.output), `须报出版本号：\n${r.output}`);
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    test('package.json 版本等于已发布版本时放行', () => {
        const dir = makeTempRepo({ pkgVersion: '0.7.1', tags: ['v0.7.1'] });
        try {
            const r = runVersionCheck(dir);
            assert.equal(r.status, 0, `应放行，实际 ${r.status}：\n${r.output}`);
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    test('历史发布 tag 都在（版本号都小于当前）时放行', () => {
        const dir = makeTempRepo({
            pkgVersion: '0.7.1',
            tags: ['v0.3.0', 'v0.4.0', 'v0.5.0', 'v0.6.0'],
        });
        try {
            const r = runVersionCheck(dir);
            assert.equal(r.status, 0, `历史 tag 不该被拦，实际 ${r.status}：\n${r.output}`);
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    test('版本锚点（plan-）不参与版本一致性判定', () => {
        const dir = makeTempRepo({ pkgVersion: '0.7.1', tags: ['plan-1795507341754/v3'] });
        try {
            const r = runVersionCheck(dir);
            assert.equal(r.status, 0, `版本锚点是历史，不该被拦，实际 ${r.status}：\n${r.output}`);
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    test('当前版本还没发版（无发布锚点）时放行', () => {
        const dir = makeTempRepo({ pkgVersion: '0.7.1', tags: ['v0.6.0'] });
        try {
            const r = runVersionCheck(dir);
            assert.equal(r.status, 0, `应放行，实际 ${r.status}：\n${r.output}`);
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });
});

// ── 验收标准 9：版本计划的跟踪副本 ──────────────────────────────────────────

describe('验收标准 9：版本计划双写', () => {
    test('save() 同时写运行时真源与跟踪副本', async () => {
        const { VersionStore } = await import('../src/core/version/store.js');
        const base = mkdtempSync(join(tmpdir(), 'adr110-store-'));
        try {
            const store = new VersionStore(join(base, '.zelto'));
            // 用 VersionPlan 的真实形状 —— 少字段会在 strict 模式下报出来，
            // 那比运行时才发现「计划存不进去」好。
            const plan: VersionPlan = {
                id: 'plan-1795507341754',
                designId: 'design-adr110',
                title: '测试计划',
                status: 'draft',
                createdAt: '2026-11-25T00:00:00.000Z',
                confirmedAt: null,
                versions: [
                    {
                        version: 'v1',
                        dependsOn: [],
                        description: '第一版',
                        slices: [],
                        integrationTestDir: '',
                        status: 'planned',
                        tag: 'plan-1795507341754/v1',
                    },
                ],
            };
            await store.save(plan);

            const runtime = join(base, '.zelto', 'versions', 'plan-1795507341754.json');
            const tracked = join(base, 'versions', 'plan-1795507341754.json');
            assert.ok(existsSync(runtime), `运行时真源必须存在：${runtime}`);
            assert.ok(existsSync(tracked), `跟踪副本必须存在：${tracked}`);
            assert.deepEqual(
                JSON.parse(readFileSync(tracked, 'utf8')),
                JSON.parse(readFileSync(runtime, 'utf8')),
                '两份内容必须一致',
            );
        } finally {
            rmSync(base, { recursive: true, force: true });
        }
    });
});

// ── 验收标准 10：四个发布 tag 一字未动 ──────────────────────────────────────

describe('验收标准 10：发布 tag 未被迁移波及', () => {
    test('v0.3.0 … v0.6.0 仍存在且指向不变', () => {
        const expected = {
            'v0.3.0': '25f30a2',
            'v0.4.0': 'e3f4373',
            'v0.5.0': '2ed1881',
            'v0.6.0': 'fa5d86b',
        };
        for (const [tag, want] of Object.entries(expected)) {
            const res = spawnSync('git', ['rev-parse', '--short', `${tag}^{commit}`], {
                cwd: ROOT,
                encoding: 'utf8',
            });
            assert.equal(res.status, 0, `${tag} 必须仍存在`);
            const actual = res.stdout.trim();
            assert.ok(
                actual.startsWith(want),
                `${tag} 指向被改了：${actual} ≠ ${want}`,
            );
        }
    });
});
