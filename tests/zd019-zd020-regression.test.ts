// ZD-019 / ZD-020 回归测试
//
// ZD-019：占位符检查把规格里提到的 **API 名**当成占位符误报。
//
//   病灶（nimrtc-v14 v1-audio-p2，2026-11-20）：
//   规格的验收判据里写「验收测试文件里不许残留 `test.todo`」——
//   这是一条**正确的、对 agent 的约束**（不许留空测试）。
//   而占位符检查的正则是 `/TBD|TODO|FIXME/.../i` 全文匹配，
//   `test.todo` 里的 `todo` 正好命中（大小写不敏感）→ 报「规格含占位符」。
//
//   闸门误报比闸门漏报更糟：误报会让人去**改正确的规格**。
//
// ZD-020：写集只有 glob 时，裸文件名的覆盖判据失效。
//
//   病灶（同上切片）：
//   写集声明为 `src/modules/opus/**`，规格正文写「`opus.cpp` 的
//   `packetise` 需要…」—— 只给了文件名。
//   而 glob 条目与裸文件名做字面比较必然不相等
//   → 报「规格提到 opus.cpp，但它不在写集里」→ 冻结被拦。
//
//   规格完全没问题 —— `src/modules/opus/src/opus.cpp` 就在写集覆盖的目录里。
//
// 这两条都是**闸门误报**，修的时候必须同时守住反向判据
// （真占位符仍要报、该授权没授权的文件仍要报）。

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { findPlaceholders, hasPlaceholder } from '../src/core/spec/semantic/placeholder.js';
import { evaluateWriteSetCoverage, isInWriteSet } from '../src/core/spec/write-set.js';
import { parseMentionedPaths } from '../src/core/spec/scope.js';

// ─────────────────────────── ZD-019 ───────────────────────────

describe('ZD-019 占位符检查不把 API 名当占位符', () => {
  it('`test.todo` 这种 API 名不算占位符', () => {
    const spec = [
      '## 验收判据',
      '',
      '- 验收测试文件里不许残留 `test.todo`，所有用例必须有断言。',
    ].join('\n');
    assert.deepEqual(findPlaceholders(spec), [], `误报：${JSON.stringify(findPlaceholders(spec))}`);
  });

  it('`createTodo` / `TODO_LIST` 这类标识符不算占位符', () => {
    const spec = [
      '## 设计',
      '',
      '- 新增 `createTodo` 接口，常量放在 `TODO_LIST` 里。',
    ].join('\n');
    assert.deepEqual(findPlaceholders(spec), []);
  });

  it('真占位符仍然要报：独立的 TODO', () => {
    const spec = ['## 设计', '', '- TODO'].join('\n');
    assert.ok(hasPlaceholder(spec), '独立成行的 TODO 应当被判为占位符');
  });

  it('真占位符仍然要报：TODO: 后面跟说明', () => {
    const spec = ['## 设计', '', '- TODO: 这里还没想清楚'].join('\n');
    assert.ok(hasPlaceholder(spec));
  });

  it('真占位符仍然要报：TBD / FIXME / XXX', () => {
    for (const marker of ['TBD', 'FIXME', 'XXX']) {
      const spec = ['## 设计', '', `- ${marker}`].join('\n');
      assert.ok(hasPlaceholder(spec), `${marker} 应当被判为占位符`);
    }
  });

  it('真占位符仍然要报：短语形态', () => {
    for (const marker of ['coming soon', 'not yet determined', 'to be filled']) {
      const spec = ['## 设计', '', `- ${marker}`].join('\n');
      assert.ok(hasPlaceholder(spec), `${marker} 应当被判为占位符`);
    }
  });

  it('真占位符仍然要报：中文「待定：xxx」', () => {
    const spec = ['## 设计', '', '- 待定：`src/foo.cpp` 的具体实现'].join('\n');
    assert.ok(hasPlaceholder(spec), '「待定：」后面跟具体内容应当被判为占位符');
  });

  it('普通叙述里的中文词不算占位符（「值待定由上层决定」没有冒号）', () => {
    const spec = ['## 设计', '', '- 这个值待定由上层决定'].join('\n');
    // 「待定」后面没有跟具体的东西 → 不算占位符
    assert.deepEqual(findPlaceholders(spec), []);
  });

  it('英文短语 not yet determined 在正文中间也要能识别', () => {
    const spec = ['## 设计', '', '- the value is not yet determined'].join('\n');
    assert.ok(hasPlaceholder(spec));
  });
});

// ─────────────────────────── ZD-020 ───────────────────────────

describe('ZD-020 glob 写集覆盖裸文件名', () => {
  const root = mkdtempSync(join(tmpdir(), 'zelto-zd020-'));
  // 模拟 nimrtc-v14 的目录形态
  mkdirSync(join(root, 'src/modules/opus/src'), { recursive: true });
  mkdirSync(join(root, 'src/modules/opus/include'), { recursive: true });
  mkdirSync(join(root, 'src/engine/src'), { recursive: true });
  writeFileSync(join(root, 'src/modules/opus/src/opus.cpp'), '// opus\n');
  writeFileSync(join(root, 'src/modules/opus/src/opus_encoder.c'), '// enc\n');
  writeFileSync(join(root, 'src/modules/opus/include/opus.hpp'), '// hpp\n');
  writeFileSync(join(root, 'src/engine/src/engine_media.cpp'), '// media\n');

  const WRITES = ['src/modules/opus/**'];

  it('glob 写集覆盖范围内的裸文件名算覆盖', () => {
    assert.ok(
      isInWriteSet('opus.cpp', WRITES, root),
      'opus.cpp 明明在 src/modules/opus/** 覆盖范围内',
    );
    assert.ok(isInWriteSet('opus_encoder.c', WRITES, root));
    assert.ok(isInWriteSet('opus.hpp', WRITES, root));
  });

  it('glob 写集覆盖范围外的裸文件名不算覆盖', () => {
    assert.equal(
      isInWriteSet('engine_media.cpp', WRITES, root),
      false,
      'engine_media.cpp 不在 src/modules/opus/** 里，不能算覆盖',
    );
  });

  it('完整路径始终按 glob 判定', () => {
    assert.ok(isInWriteSet('src/modules/opus/src/opus.cpp', WRITES, root));
    assert.equal(isInWriteSet('src/engine/src/engine_media.cpp', WRITES, root), false);
  });

  it('D-4 覆盖判据不再误报（裸文件名在 glob 内）', () => {
    const coverage = evaluateWriteSetCoverage(['opus.cpp', 'opus_encoder.c'], WRITES, root);
    assert.deepEqual(
      coverage.uncovered,
      [],
      `误报未覆盖：${JSON.stringify(coverage.uncovered)}`,
    );
  });

  it('反向：不属实的覆盖仍然要报（不能为了修误报而放松真判据）', () => {
    const coverage = evaluateWriteSetCoverage(['engine_media.cpp'], WRITES, root);
    assert.deepEqual(
      coverage.uncovered,
      ['engine_media.cpp'],
      'glob 外的文件仍然必须报未覆盖',
    );
  });

  it('反向：glob 前缀之外完全无关的名字仍然要报', () => {
    const coverage = evaluateWriteSetCoverage(['CHANGELOG.md'], WRITES, root);
    assert.deepEqual(coverage.uncovered, ['CHANGELOG.md']);
  });

  // 清理
  it('清理临时目录', () => {
    rmSync(root, { recursive: true, force: true });
  });
});
