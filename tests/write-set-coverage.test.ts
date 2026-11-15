// D-4：规格提到的文件必须在写集里。
//
// 实测缺陷（nimrtc-zelto D1 演练）：规格的「需求」章节里写着
// 「`src/engine/CMakeLists.txt` 如需登记新 `.cpp` 文件，只加一行」，
// 但写集里没有这个文件。写集守卫（C9）正确地拦住了 agent 改它，
// 于是 agent 建了新 `.cpp` 却无法登记 —— 链接期才炸：
//
//     error LNK2019: 无法解析的外部符号 "nimrtc::engine::build_rtp_packet(...)"
//
// 「规格说要改 + 写集不允许改」这个矛盾本来在冻结时就能看出来，
// 但没有任何一道闸门做这个比对。**该写的东西没被授权**，要靠人先看出来。
//
// 本测试守住：冻结时这个矛盾被拦下；修好写集后能正常冻结。

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, rm, writeFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';

import { parseMentionedPaths } from '../src/core/spec/scope.js';

const TEST_DIR = join(tmpdir(), `zelto-write-set-coverage-test-${Date.now()}`);
const CLI_SCRIPT = join(process.cwd(), 'dist', 'cli', 'index.js');

function runCommand(...args: string[]): Promise<{ stdout: string; code: number }> {
  return new Promise((resolve, reject) => {
    const child = spawn('node', [CLI_SCRIPT, ...args], {
      cwd: TEST_DIR,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.on('close', (code) => resolve({ stdout: stdout || stderr, code: code ?? 1 }));
    child.on('error', reject);
  });
}

/**
 * 造一个切片规格。
 *
 * `scopeFiles` 进「范围」章节（= 写集来源），`requirementMentions` 进
 * 「需求」章节（= 规格提到但可能不在写集里的文件）。
 */
async function writeSpec(
  id: string,
  scopeFiles: string[],
  requirementMentions: string[],
): Promise<void> {
  const scopeLines = scopeFiles.map((f) => `- \`${f}\``).join('\n');
  const reqLines = requirementMentions.length
    ? requirementMentions
        .map((f, i) => `${i + 1}. **需求 ${i + 1}**：如需登记，请同时改 \`${f}\`。`)
        .join('\n')
    : '1. **基础需求**：实现目标行为。';

  const content = `# Slice: ${id}

## 目的

把 RTP 打包集中到一个文件。

## 范围

${scopeLines}

## 需求

${reqLines}

## 验收标准

1. 目标行为可验证。

## 不做

1. 不做无关改动。
`;
  await writeFile(join(TEST_DIR, 'specs', 'slices', `${id}.md`), content, 'utf-8');
}

/** 造一个带写集的切片状态文件 */
async function writeSlice(id: string, writes: string[]): Promise<void> {
  const now = new Date().toISOString();
  const slice = {
    id,
    title: `Slice ${id}`,
    state: 'draft',
    spec: { path: `specs/slices/${id}.md`, frozenHash: null, frozenAt: null },
    acceptance: { dir: `tests/acceptance/${id}/`, frozenHash: null, oracleSrc: null },
    baseCommit: null,
    drift: { detected: false, reason: null, at: null },
    trace: { requirements: ['req-1'], contracts: [], tests: [] },
    traceWaiver: null,
    baseline: false,
    writes,
    runs: [],
    stall: { class: null, autoResolved: 0, gateRetries: 0 },
    createdAt: now,
    updatedAt: now,
  };
  await writeFile(
    join(TEST_DIR, '.zelto', 'slices', `${id}.json`),
    JSON.stringify(slice, null, 2),
    'utf-8',
  );
}

describe('zelto freeze —— 规格与写集一致性（D-4）', () => {
  before(async () => {
    await mkdir(join(TEST_DIR, '.zelto', 'slices'), { recursive: true });
    await mkdir(join(TEST_DIR, '.zelto', 'events'), { recursive: true });
    await mkdir(join(TEST_DIR, '.zelto', 'locks'), { recursive: true });
    await mkdir(join(TEST_DIR, 'specs', 'slices'), { recursive: true });
    await mkdir(join(TEST_DIR, 'policy'), { recursive: true });
  });

  after(async () => {
    await rm(TEST_DIR, { recursive: true, force: true });
  });

  it('规格提到但写集没覆盖的文件 → 拒绝冻结（D-4 回归）', async () => {
    // 复刻演练现场：范围章节有 3 个文件，但需求章节提到 CMakeLists.txt
    await writeSpec(
      'coverage-mismatch',
      ['src/engine/src/rtp_packetizer.cpp', 'src/engine/src/engine_media.cpp'],
      ['src/engine/CMakeLists.txt'],
    );
    await writeSlice('coverage-mismatch', [
      'src/engine/src/rtp_packetizer.cpp',
      'src/engine/src/engine_media.cpp',
    ]);

    const { stdout, code } = await runCommand('freeze', 'coverage-mismatch');
    assert.notEqual(code, 0, '规格与写集不一致时必须拒绝冻结');
    assert.ok(
      stdout.includes('规格与写集不一致'),
      `错误信息应指出规格与写集不一致，实际输出：${stdout}`,
    );
    assert.ok(
      stdout.includes('src/engine/CMakeLists.txt'),
      `错误信息应点名是哪个文件，实际输出：${stdout}`,
    );
  });

  it('写集覆盖了规格提到的所有文件 → 正常冻结', async () => {
    await writeSpec(
      'coverage-ok',
      ['src/engine/src/rtp_packetizer.cpp', 'src/engine/CMakeLists.txt'],
      ['src/engine/CMakeLists.txt'],
    );
    await writeSlice('coverage-ok', [
      'src/engine/src/rtp_packetizer.cpp',
      'src/engine/CMakeLists.txt',
    ]);

    const { stdout, code } = await runCommand('freeze', 'coverage-ok');
    assert.equal(code, 0, `写集覆盖完整时应正常冻结，实际输出：${stdout}`);
    assert.ok(stdout.includes('frozen'), `实际输出：${stdout}`);

    const slice = JSON.parse(
      await readFile(join(TEST_DIR, '.zelto', 'slices', 'coverage-ok.json'), 'utf-8'),
    );
    assert.equal(slice.state, 'frozen');
  });

  it('写集用 glob 覆盖规格提到的文件 → 正常冻结', async () => {
    await writeSpec(
      'coverage-glob',
      ['src/engine/src/**'],
      ['src/engine/CMakeLists.txt', 'src/engine/src/engine_media.cpp'],
    );
    // glob 必须覆盖到 src/engine/CMakeLists.txt —— 用更宽的 glob
    await writeSlice('coverage-glob', ['src/engine/**']);

    const { stdout, code } = await runCommand('freeze', 'coverage-glob');
    assert.equal(code, 0, `glob 覆盖时不应被拦下，实际输出：${stdout}`);
  });

  it('把缺的文件加进写集后 → 能冻结', async () => {
    await writeSpec(
      'coverage-fixed',
      ['src/engine/src/rtp_packetizer.cpp'],
      ['src/engine/CMakeLists.txt'],
    );
    await writeSlice('coverage-fixed', ['src/engine/src/rtp_packetizer.cpp']);

    // 先确认被拦
    const blocked = await runCommand('freeze', 'coverage-fixed');
    assert.notEqual(blocked.code, 0, '加写集前应被拦');

    // 加写集
    const set = await runCommand(
      'set',
      'coverage-fixed',
      '--field',
      'writes',
      '--value',
      'src/engine/src/rtp_packetizer.cpp,src/engine/CMakeLists.txt',
    );
    assert.equal(set.code, 0, `加写集应成功，实际输出：${set.stdout}`);

    // 再冻结
    const ok = await runCommand('freeze', 'coverage-fixed');
    assert.equal(ok.code, 0, `加写集后应能冻结，实际输出：${ok.stdout}`);
  });

  it('规格没提到额外文件时不被拦（写集可超出规格）', async () => {
    await writeSpec(
      'coverage-extra',
      ['src/engine/src/rtp_packetizer.cpp'],
      [],
    );
    await writeSlice('coverage-extra', [
      'src/engine/src/rtp_packetizer.cpp',
      'src/engine/src/engine_media.cpp',
    ]);

    const { stdout, code } = await runCommand('freeze', 'coverage-extra');
    assert.equal(code, 0, `写集超出规格不应被拦，实际输出：${stdout}`);
  });

  it('被拦后不写冻结哈希（切片仍是 draft）', async () => {
    await writeSpec(
      'coverage-no-hash',
      ['src/engine/src/rtp_packetizer.cpp'],
      ['src/engine/CMakeLists.txt'],
    );
    await writeSlice('coverage-no-hash', ['src/engine/src/rtp_packetizer.cpp']);

    await runCommand('freeze', 'coverage-no-hash');

    const slice = JSON.parse(
      await readFile(join(TEST_DIR, '.zelto', 'slices', 'coverage-no-hash.json'), 'utf-8'),
    );
    assert.equal(slice.state, 'draft', '被拦后切片应仍是 draft');
    assert.equal(slice.spec.frozenHash, null, '被拦后不应写冻结哈希');
  });
});

// ─── 路径识别的白名单 ───────────────────────────────────────────────────────
//
// D-4 遗留项：`parseMentionedPaths` 靠扩展名白名单识别路径，
// `Makefile` / `Dockerfile` 这类**无扩展名**文件识别不到。
// 而这两个文件恰恰是 C++ / Go 项目里最常被规格点名的
// （改依赖、改构建都要动它们）—— 认不出它们，这道闸门就在最该拦的地方漏了。

describe('parseMentionedPaths —— 路径识别的白名单', () => {
  it('反引号里的无扩展名文件被识别', () => {
    const paths = parseMentionedPaths('要改 `Makefile` 与 `Dockerfile`。');
    assert.ok(paths.includes('Makefile'), `实际：${JSON.stringify(paths)}`);
    assert.ok(paths.includes('Dockerfile'), `实际：${JSON.stringify(paths)}`);
  });

  it('带目录的无扩展名文件被识别', () => {
    const paths = parseMentionedPaths('改 `build/Makefile` 与 `docker/Dockerfile`。');
    assert.ok(paths.includes('build/Makefile'), `实际：${JSON.stringify(paths)}`);
    assert.ok(paths.includes('docker/Dockerfile'), `实际：${JSON.stringify(paths)}`);
  });

  it('行内裸写的无扩展名文件被识别', () => {
    const paths = parseMentionedPaths('构建时改 Makefile 里的规则。');
    assert.ok(paths.includes('Makefile'), `实际：${JSON.stringify(paths)}`);
  });

  it('行内裸写的无扩展名文件（带目录）被识别', () => {
    const paths = parseMentionedPaths('构建时改 build/Makefile 里的规则。');
    assert.ok(paths.includes('build/Makefile'), `实际：${JSON.stringify(paths)}`);
  });

  it('CMakeLists.txt 被识别（文件名特殊，扩展名是 txt）', () => {
    const paths = parseMentionedPaths('在 `CMakeLists.txt` 里登记新文件。');
    assert.ok(paths.includes('CMakeLists.txt'), `实际：${JSON.stringify(paths)}`);
  });

  it('常见扩展名都被识别', () => {
    const paths = parseMentionedPaths(
      ['`a.ts`', '`b.cpp`', '`c.h`', '`d.py`', '`e.yaml`', '`f.toml`', '`g.go`', '`h.rs`'].join(' '),
    );
    for (const p of ['a.ts', 'b.cpp', 'c.h', 'd.py', 'e.yaml', 'f.toml', 'g.go', 'h.rs']) {
      assert.ok(paths.includes(p), `${p} 应被识别，实际：${JSON.stringify(paths)}`);
    }
  });

  it('散文不被误判成路径', () => {
    const paths = parseMentionedPaths('这个功能应该很快，用户会觉得这个体验不错。');
    assert.deepEqual(paths, [], `散文不应产生路径，实际：${JSON.stringify(paths)}`);
  });

  it('URL 不被当成路径', () => {
    const paths = parseMentionedPaths('见 https://example.com/docs/guide.md 了解更多。');
    assert.deepEqual(paths, [], `URL 不应产生路径，实际：${JSON.stringify(paths)}`);
  });

  it('glob 通配片段不被当成具体路径', () => {
    const paths = parseMentionedPaths('写 `src/engine/**` 下的所有文件。');
    assert.deepEqual(paths, [], `glob 不应产生具体路径，实际：${JSON.stringify(paths)}`);
  });

  it('绝对路径不被当成项目内路径', () => {
    const paths = parseMentionedPaths('引用 `/usr/include/x.hpp` 与 `C:\\foo\\bar.cpp`。');
    assert.deepEqual(paths, [], `绝对路径不应产生路径，实际：${JSON.stringify(paths)}`);
  });

  it('README / LICENSE 这类无扩展名文件被识别', () => {
    const paths = parseMentionedPaths('顺手更新 `README` 和 `LICENSE`。');
    assert.ok(paths.includes('README'), `实际：${JSON.stringify(paths)}`);
    assert.ok(paths.includes('LICENSE'), `实际：${JSON.stringify(paths)}`);
  });

  it('普通英文单词不被误判成无扩展名文件', () => {
    // `makefile` 在清单里，但 `makefiles` / `readme` 不该被当成路径
    const paths = parseMentionedPaths('We should read the makefiles and readmes carefully.');
    assert.deepEqual(paths, [], `实际：${JSON.stringify(paths)}`);
  });
});
