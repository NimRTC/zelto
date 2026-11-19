// 前端资源的**语法守卫** —— 生成的 App JS 必须能被真实解析器接受。
//
// ── 为什么必须单独一条 ────────────────────────────────────────────────
//
// 2026-11-19 实测发现：`renderAppJs()` 生成 45KB 的脚本，其中有一个
// **未闭合的字符串**（`doResume` 的多行 confirm 文案），整段脚本被
// 浏览器拒绝执行。
//
// 症状是**最坏的那种**：
//   - 页面永远停在「加载中…」，没有任何错误提示
//   - 脱离上下文看，像「服务连不上」或「轮询卡住」，其实是**一行都没跑**
//   - 2602 个测试全绿、lint 全绿、编码检查全绿 —— 没有一条看得见它
//
// 根因：`renderAppJs()` 的函数体是一个**外层模板字符串**。模板字符串里
// 写的 `'\n'` 会被求值成真换行符，于是生成出的 JS 里那个字符串字面量
// 真的跨了行。外层模板里的每一个 `\n` 都必须写成 `\\n`。
//
// 同类问题还有一个：注释里的**反引号**。它会把外层模板字符串提前结束，
// 后面的中文注释就被当成代码解析（TS1005 / TS1443）。
//
// 这条测试的意义：**让「页面根本跑不起来」这件事在测试里变红**，
// 而不是等到人打开浏览器才发现。

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { runInNewContext } from 'node:vm';

import { renderAppJs, renderStyles } from '../src/adapters/web/frontend-assets.js';

describe('前端资源语法守卫（ADR-086）', () => {
  it('renderAppJs() 的产物是合法 JavaScript', () => {
    const js = renderAppJs();
    assert.ok(js.length > 1000, '生成的脚本不该是空的');
    // 用一个**真实的 JS 解析器**判，而不是我们自己写的正则 ——
    // 正则永远追不上语法。
    assert.doesNotThrow(
      () => {
        new Function(js);
      },
      'renderAppJs() 产出了语法错误的脚本 —— 浏览器会整段拒绝执行，页面将永远停在「加载中…」',
    );
  });

  it('renderAppJs() 的产物里没有裸换行的字符串字面量', () => {
    // 上面那条已经能抓到，这条单独再说清楚一次病根：
    // 外层模板字符串吃掉了 `\n`，生成出的源码里就出现了「引号内换行」。
    const js = renderAppJs();
    const lines = js.split('\n');
    for (const [i, line] of lines.entries()) {
      const quoteCount = (line.match(/'/g) ?? []).length;
      // 单行里奇数个单引号 = 有一个字符串在这行没闭合
      assert.equal(
        quoteCount % 2,
        0,
        `第 ${i + 1} 行的单引号个数是奇数（字符串跨行未闭合）：${line}`,
      );
    }
  });

  it('renderStyles() 产出非空 CSS 且花括号配对', () => {
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

  it('生成的脚本在空上下文里能跑到「拿不到 DOM」为止，而不是语法报错', () => {
    const js = renderAppJs();
    // 给一个没有任何元素的假 DOM —— 脚本会拿到 null，
    // 但**必须是运行时失败，不是解析失败**。
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

  it('生成的脚本里没有把 DOM 节点当文本传进 el() 的写法', () => {
    // 2026-11-19 实测：`renderLiveBox` 写成 `el('span', 'ev', liveBadge(summary))`，
    // 而 liveBadge 返回的是节点 —— el() 内部 `String(text)` 把它变成了
    // 字面量 "[object HTMLSpanElement]"，详情页真的把那串东西显示给了人。
    // 预算页的「已超支」徽标同理。
    //
    // 静态判据：el(...) 的第三个参数不该是一个「返回节点的 helper」的直接调用。
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
});
