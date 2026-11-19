// 前端资源的**语法守卫** —— 前端脚本必须能被真实解析器接受。
//
// ── 为什么必须单独一条 ────────────────────────────────────────────────
//
// 2026-11-19 实测发现：`renderAppJs()` 生成的 45KB 脚本里有一个
// **未闭合的字符串**（`doResume` 的多行 confirm 文案），整段脚本被
// 浏览器拒绝执行。
//
// 症状是**最坏的那种**：
//   - 页面永远停在「加载中…」，没有任何错误提示
//   - 脱离上下文看，像「服务连不上」或「轮询卡住」，其实是**一行都没跑**
//   - 2602 个测试全绿、lint 全绿、编码检查全绿 —— 没有一条看得见它
//
// 当时的根因：代码藏在一个**外层模板字符串**里，内层的 `'\n'` 被外层
// 求值成真换行。ADR-093 已把前端脚本迁成独立文件（`frontend/app.js`），
// **那一类故障从此在结构上不可能发生** —— 但也正因为代码搬了家，
// 必须有测试盯着「搬出来的文件」与「嵌进首页的那串字符」是同一份。
//
// 本文件保留并加强：判据从「剥模板」改为「直接验文件 + 验嵌入结果」。

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';

import { renderAppJs, renderStyles } from '../src/adapters/web/frontend-assets.js';

const here = dirname(fileURLToPath(import.meta.url));

/**
 * 找到仓库根的 `src/adapters/web/frontend/`。
 *
 * 不用「往上数几层」—— `dist-test/tests/` 与仓库根的深度是实现细节，
 * 改一次 tsconfig 的 `outDir` 就会错位。这里从当前文件向上走到有
 * `package.json` 的那一层，再拼相对路径。
 */
function findFrontendDir(from: string): string {
  let dir = from;
  for (let i = 0; i < 10; i++) {
    try {
      readFileSync(join(dir, 'package.json'));
      return join(dir, 'src', 'adapters', 'web', 'frontend');
    } catch {
      const parent = dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  }
  throw new Error(`找不到仓库根（从 ${from} 向上没碰到 package.json）`);
}

const SRC_ASSET_DIR = findFrontendDir(here);

describe('前端资源守卫（ADR-093）', () => {
  it('renderAppJs() 的产物是合法 JavaScript', () => {
    const js = renderAppJs();
    assert.ok(js.length > 1000, '生成的脚本不该是空的');
    // 用一个**真实的 JS 解析器**判 —— 正则永远追不上语法。
    assert.doesNotThrow(
      () => {
        new Function(js);
      },
      '嵌入的脚本有语法错误 —— 浏览器会整段拒绝执行，页面将永远停在「加载中…」',
    );
  });

  it('嵌入的脚本就是 app.js 文件本身（没有被二次加工）', () => {
    // 病根曾经是「源码字符 ≠ 浏览器字符」。这一条把两者钉死相等：
    // 任何一层转义、任何一次偷偷的 replace 都会让它变红。
    const fromDisk = readFileSync(join(SRC_ASSET_DIR, 'app.js'), 'utf-8');
    assert.equal(
      renderAppJs(),
      fromDisk,
      'renderAppJs() 的返回值必须与 frontend/app.js 逐字相同 —— 中间不许有任何加工',
    );
  });

  it('嵌入的样式表就是 styles.css 文件本身', () => {
    const fromDisk = readFileSync(join(SRC_ASSET_DIR, 'styles.css'), 'utf-8');
    assert.equal(renderStyles(), fromDisk, 'renderStyles() 必须与 frontend/styles.css 逐字相同');
  });

  it('脚本里没有跨行的字符串字面量', () => {
    // 与 ADR-093 之前同一个判据，仍然值得留：现在虽然不太可能再犯，
    // 但它描述的是「浏览器会怎么理解这串字符」，不是「我们怎么写的」。
    const js = renderAppJs();
    for (const [i, line] of js.split('\n').entries()) {
      const quoteCount = (line.match(/'/g) ?? []).length;
      assert.equal(
        quoteCount % 2,
        0,
        `第 ${i + 1} 行的单引号个数是奇数（字符串跨行未闭合）：${line}`,
      );
    }
  });

  it('脚本在空上下文里能跑到「拿不到 DOM」为止，而不是语法报错', () => {
    const js = renderAppJs();
    const fakeDoc = {
      getElementById: () => null,
      querySelectorAll: () => [],
      querySelector: () => null,
      createElement: () => ({ appendChild() {}, addEventListener() {} }),
    };
    let err: unknown;
    try {
      runInNewContext(js, { document: fakeDoc, window: {}, setInterval: () => 0 });
    } catch (e) {
      err = e;
    }
    if (err instanceof Error) {
      assert.ok(
        !(err instanceof SyntaxError),
        `脚本在解析阶段就失败了（不是运行时）：${err.message}`,
      );
    }
  });

  it('脚本里没有把 DOM 节点当文本传进 el() 的写法', () => {
    // 2026-11-19 实测：`renderLiveBox` 写成 `el('span', 'ev', liveBadge(summary))`，
    // 而 liveBadge 返回的是节点 —— el() 内部 `String(text)` 把它变成了
    // 字面量 "[object HTMLSpanElement]"，详情页真的把那串东西显示给了人。
    // 预算页的「已超支」徽标同理。
    const js = renderAppJs();
    const offenders: string[] = [];
    const nodeHelpers = ['liveBadge', 'costCell', 'progressCell', 'stateBadge', 'livenessCell'];
    const re = new RegExp(`el\\([^)]*,\\s*(?:[^)]*,\\s*)?(?:${nodeHelpers.join('|')})\\(`);
    for (const [i, line] of js.split('\n').entries()) {
      if (re.test(line)) offenders.push(`第 ${i + 1} 行：${line.trim()}`);
    }
    assert.deepEqual(
      offenders,
      [],
      `这些行把返回 DOM 节点的 helper 传给了 el()，页面会显示 "[object HTMLSpanElement]"：\n${offenders.join('\n')}`,
    );
  });

  it('样式表非空且花括号配对', () => {
    const css = renderStyles();
    assert.ok(css.length > 100, '样式表不该是空的');
    let depth = 0;
    for (const ch of css) {
      if (ch === '{') depth++;
      else if (ch === '}') depth--;
      assert.ok(depth >= 0, 'CSS 出现了多余的右花括号');
    }
    assert.equal(depth, 0, 'CSS 花括号没有配对');
  });
});
