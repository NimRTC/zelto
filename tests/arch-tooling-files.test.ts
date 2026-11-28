import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { isToolingFile, partitionToolingFiles } from '../src/core/arch/tooling-files.js';
import { scanArchitecture } from '../src/core/arch/scan.js';
import { buildArchitectureReport } from '../src/core/arch/report.js';
import type { ModuleSpec } from '../src/core/arch/types.js';

// ─── 工具脚本识别 ──────────────────────────────────────────────────────────

test('isToolingFile：顶层工具目录下的文件是工具脚本', () => {
  assert.equal(isToolingFile('tools/check_engine_layering.py'), true);
  assert.equal(isToolingFile('scripts/api_freeze_scan.js'), true);
  assert.equal(isToolingFile('scripts/build_dtls_cert.py'), true);
  assert.equal(isToolingFile('tools/nested/deep/helper.py'), true);
});

test('isToolingFile：大小写不敏感', () => {
  assert.equal(isToolingFile('Tools/check.py'), true);
  assert.equal(isToolingFile('Scripts/check.py'), true);
});

test('isToolingFile：只认顶层 —— 模块内部的同名目录不是工具脚本', () => {
  // `src/engine/tools/` 是**某个模块内部的子目录** —— 它理应被那个模块认领，
  // 把嵌套同名目录也排除，会让模块内部的文件悄悄失去归属检查。
  assert.equal(isToolingFile('src/engine/tools/helper.py'), false);
  assert.equal(isToolingFile('src/foo/scripts/run.py'), false);
});

test('isToolingFile：生产代码不是工具脚本', () => {
  assert.equal(isToolingFile('src/core/log.ts'), false);
  assert.equal(isToolingFile('src/modules/frame.cpp'), false);
  assert.equal(isToolingFile('examples/demo/main.cpp'), false);
  // 只叫「tools」后缀的普通目录名不是约定名
  assert.equal(isToolingFile('src/toolset/a.ts'), false);
  assert.equal(isToolingFile('src/script/a.ts'), false);
});

test('partitionToolingFiles：把路径分成工具脚本与其余两组', () => {
  const { toolingFiles, otherFiles } = partitionToolingFiles([
    'src/a.ts',
    'tools/b.py',
    'scripts/c.js',
    'src/engine/tools/d.py',
  ]);
  assert.deepEqual(toolingFiles, ['tools/b.py', 'scripts/c.js']);
  assert.deepEqual(otherFiles, ['src/a.ts', 'src/engine/tools/d.py']);
});

// ─── 扫描：工具脚本不报「文件无归属」 ─────────────────────────────────────

function makeProject(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), 'zelto-arch-tooling-'));
  for (const [path, content] of Object.entries(files)) {
    const full = join(root, path);
    mkdirSync(join(full, '..'), { recursive: true });
    writeFileSync(full, content, 'utf-8');
  }
  return root;
}

const MODULES: ModuleSpec[] = [
  { name: 'src/core', description: '', filePatterns: ['src/core/**'], dependencies: [] },
  { name: 'src/plugins', description: '', filePatterns: ['src/plugins/**'], dependencies: [] },
];

test('报告：工具脚本不报「文件无归属」偏离（ADR-138）', () => {
  // 真实证据（nimrtc-v14 靶子项目，2026-11-28）：
  // `tools/check_engine_layering.py` 不在任何设计模块的范围内，
  // 于是报 unmapped_file（deny）→ 门禁拦截 → 改工具脚本的切片自锁。
  const root = makeProject({
    'src/core/index.ts': "export const a = 1;\n",
    'tools/check_engine_layering.py': "import sys\nprint('check')\n",
    'scripts/api_freeze_scan.js': "console.log('scan');\n",
    'src/loose.ts': "export const loose = 1;\n",
  });

  const scan = scanArchitecture(root, MODULES);
  const report = buildArchitectureReport(MODULES, scan);

  const unmappedFiles = report.deviations
    .filter((d) => d.kind === 'unmapped_file')
    .map((d) => d.to);

  assert.ok(
    !unmappedFiles.includes('tools/check_engine_layering.py'),
    '工具脚本不该报「文件无归属」',
  );
  assert.ok(!unmappedFiles.includes('scripts/api_freeze_scan.js'), '工具脚本不该报「文件无归属」');
  // 生产文件的无归属仍然要报 —— 别把人真该修的事一起吞掉
  assert.ok(unmappedFiles.includes('src/loose.ts'), '生产代码的无归属必须继续报');
});

test('工具脚本在 scan.unmapped 里也不出现', () => {
  const root = makeProject({
    'src/core/index.ts': "export const a = 1;\n",
    'tools/check.py': "print('x')\n",
  });

  const scan = scanArchitecture(root, MODULES);
  assert.ok(!scan.unmapped.includes('tools/check.py'), '工具脚本不该进 unmapped 清单');
});

test('模块内部的同名目录仍然照报无归属（不能误放行）', () => {
  // 只排除**顶层** tools/ scripts/。`src/orphan/tools/` 不是仓库级工具目录，
  // 它不在任何模块范围内就该报 —— 否则模块内部会悄悄丢归属检查。
  //
  // 注意：模式 `src/core/**` **会**认领 `src/core/tools/helper.py`
  // （匹配到就是归属），所以要用一个**没被任何模块覆盖**的位置
  // 才能观察到「照报」。
  const root = makeProject({
    'src/core/index.ts': "export const a = 1;\n",
    'src/orphan/tools/helper.py': "print('x')\n",
  });

  const scan = scanArchitecture(root, MODULES);
  const report = buildArchitectureReport(MODULES, scan);
  const unmappedFiles = report.deviations
    .filter((d) => d.kind === 'unmapped_file')
    .map((d) => d.to);
  assert.ok(
    unmappedFiles.includes('src/orphan/tools/helper.py'),
    '模块内部的同名目录必须继续报「文件无归属」',
  );
});

test('工具脚本不产生依赖边（ADR-138）', () => {
  // 一个检查脚本读项目的模块，是这个脚本的**本职**（与测试同理）。
  // 这类引用不构成「模块 A 依赖模块 B」—— 它不该进模块图。
  //
  // 真实场景：`tools/check_engine_layering.py` 要读 `src/engine/src/**`
  // 才能检查分层。若这条边进了图，会伪造成「未声明依赖」甚至假环。
  const root = makeProject({
    'src/core/index.ts': "export const a = 1;\n",
    'tools/uses_core.py': "from index import a\nprint(a)\n",
  });

  const scan = scanArchitecture(root, MODULES);
  assert.equal(scan.edges.length, 0, '工具脚本不该产生模块依赖边');
});

test('覆盖统计：工具脚本仍计入文件数（排除的是偏离判定，不是文件存在）', () => {
  const root = makeProject({
    'src/core/index.ts': "export const a = 1;\n",
    'src/core/helper.ts': "export const h = 1;\n",
    'tools/check.py': "print('x')\n",
    'scripts/scan.js': "console.log('x');\n",
  });

  const scan = scanArchitecture(root, MODULES);
  // 工具脚本仍是仓库的一部分 —— 报告必须能说清「多少文件没参与验证」
  assert.equal(scan.coverage.totalFiles, 4);
  // ADR-138：工具脚本**单独计数**，不混进语言分母
  assert.equal(scan.coverage.toolingFiles, 2);
  // Python 分母只数项目自己的生产文件，不含工具脚本
  assert.equal(scan.coverage.counts.python, 0);
  // 已验证的文件数只算生产代码 —— 工具脚本不产生依赖边，不算「已验证」
  assert.equal(scan.coverage.verifiedFiles, 2);
});
