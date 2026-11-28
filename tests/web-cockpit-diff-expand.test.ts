// 驾驶舱「改了什么」段的展示与展开 —— 前端行为守卫
//
// ── 为什么要有这个 ────────────────────────────────────────────────────
//
// 这一段有两个容易悄悄坏掉的地方：
//
//   1. **封顶**：一次改动动到几百个文件是常事。首屏只给前 N 个
//      （ADR-070 §5.3 同一套限额思路），不然总览页会被撑爆。
//   2. **出口**：真要看全部时，人不该被迫切回终端 ——
//      驾驶舱是给人看东西的地方，不是「只许看一半」的地方。
//
// 这两件事**互相拉扯**：封顶是为了首屏可用，但封顶如果没有出口，
// 就变成了「驾驶舱在关键场景下失效」——
// 而驾驶舱失效等于把人赶回终端，正是这个项目一直在治的病。
//
// ── 为什么用「最小 DOM 垫片」而不是真浏览器 ───────────────────────────
//
// 仓库没有 DOM 库（不引第三方依赖 —— `core/` 零依赖，测试也不该为了
// 一个前端断言引入一整个浏览器引擎）。
//
// 所以这里手写一个**够用的最小 DOM**：只实现 `renderDiffSection`
// 真正用到的那几个方法（createElement / appendChild / textContent /
// querySelectorAll / remove / addEventListener）。
//
// 测的是**真实的那份 `app.js`**（从 `frontend/app.js` 读出来，
// 不是复制粘贴一份）—— 所以断言的是「浏览器会看到什么」。
//
// ── 为什么不在测试里重写一遍渲染逻辑 ───────────────────────────────────
//
// 重写一遍 = 测的是测试自己的副本，不是产品代码。
// 那种测试永远绿，也永远抓不到真 bug。

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';

const here = dirname(fileURLToPath(import.meta.url));

/** 找到仓库根的 `src/adapters/web/frontend/`。 */
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

const APP_JS = readFileSync(join(findFrontendDir(here), 'app.js'), 'utf-8');

// ── 最小 DOM 垫片 ───────────────────────────────────────────────────────

interface ShimNode {
  tagName: string;
  className: string;
  textContent: string;
  children: ShimNode[];
  parent: ShimNode | null;
  listeners: Array<() => void>;
  appendChild(child: ShimNode): ShimNode;
  remove(): void;
  addEventListener(type: string, fn: () => void): void;
  querySelectorAll(sel: string): ShimNode[];
  /** classList —— 真 DOM 有，app.js 的导航折叠用它切 `.open`。 */
  classList: {
    add(c: string): void;
    remove(c: string): void;
    contains(c: string): boolean;
    toggle(c: string): boolean;
  };
  /** 点击（触发监听器）。 */
  click(): void;
  /** 递归取文本（含后代）。 */
  text(): string;
}

function makeNode(tagName: string): ShimNode {
  const node: ShimNode = {
    tagName,
    className: '',
    textContent: '',
    children: [],
    parent: null,
    listeners: [],
    appendChild(child: ShimNode) {
      child.parent = node;
      node.children.push(child);
      return child;
    },
    remove() {
      const p = node.parent;
      if (!p) return;
      const i = p.children.indexOf(node);
      if (i >= 0) p.children.splice(i, 1);
      node.parent = null;
    },
    addEventListener(_type: string, fn: () => void) {
      node.listeners.push(fn);
    },
    classList: {
      add(c: string) {
        const parts = node.className.split(/\s+/).filter(Boolean);
        if (!parts.includes(c)) parts.push(c);
        node.className = parts.join(' ');
      },
      remove(c: string) {
        node.className = node.className
          .split(/\s+/)
          .filter((x) => x && x !== c)
          .join(' ');
      },
      contains(c: string) {
        return node.className.split(/\s+/).includes(c);
      },
      toggle(c: string) {
        const has = node.className.split(/\s+/).includes(c);
        if (has) {
          node.className = node.className
            .split(/\s+/)
            .filter((x) => x && x !== c)
            .join(' ');
        } else {
          const parts = node.className.split(/\s+/).filter(Boolean);
          parts.push(c);
          node.className = parts.join(' ');
        }
        return !has;
      },
    },
    querySelectorAll(sel: string) {
      // 支持两种：`tag` 与 `.class` —— 这一段用到两者
      // （`.diff-file` 用来删多余的行，`button` 用来找开关）。
      const isTag = !sel.startsWith('.');
      const cls = isTag ? '' : sel.replace(/^\./, '');
      const out: ShimNode[] = [];
      const walk = (n: ShimNode) => {
        for (const c of n.children) {
          const hit = isTag
            ? c.tagName === sel
            : c.className.split(/\s+/).includes(cls);
          if (hit) out.push(c);
          walk(c);
        }
      };
      walk(node);
      return out;
    },
    click() {
      for (const fn of node.listeners) fn();
    },
    text() {
      // getter 已经把后代文本算进去了 —— 这里不要再拼一遍。
      return node.textContent;
    },
  };

  // `textContent` 在真 DOM 里是**替换语义** —— 赋值会抹掉所有子节点。
  //
  // 这一条必须建模，否则测试会漏掉「赋 textContent 把按钮抹了」这类
  // 真实 bug：垫片若当成纯属性，代码里 `note.textContent = '...'` 看起来
  // 一切正常，浏览器里按钮却已经消失。
  let ownText = '';
  Object.defineProperty(node, 'textContent', {
    get() {
      return ownText + node.children.map((c) => c.text()).join('');
    },
    set(v: string) {
      ownText = String(v);
      for (const c of node.children) c.parent = null;
      node.children.length = 0;
    },
    enumerable: true,
    configurable: true,
  });

  return node;
}

/**
 * 在最小 DOM 里跑真实的 `app.js`，然后调 `renderDiffSection`。
 *
 * `app.js` 是个 IIFE —— 它把内部函数挂在全局还是局部？
 * 靠 `renderAppJs()` 那套办法行不通（IIFE 内部的函数不导出）。
 * 所以这里换一条路：**用 `vm` 把脚本跑起来，
 * 再从全局对象上取它暴露的东西**。
 *
 * 先看一下 app.js 的结构 —— 如果它是纯顶层脚本（非 IIFE），
 * 那 `runInNewContext` 里的顶层 `function` 声明就是全局的。
 */
function loadAppJs(): Record<string, unknown> {
  const sandbox: Record<string, unknown> = {
    document: {
      // app.js 在加载时就往这些节点上写东西（`refreshLine.className = ...`）
      // —— 所以 getElementById 必须返回**节点**，不能返回 null。
      getElementById: () => makeNode('div'),
      querySelectorAll: () => [],
      querySelector: () => null,
      createElement: (tag: string) => makeNode(tag),
      createTextNode: (t: string) => {
        const n = makeNode('#text');
        n.textContent = t;
        return n;
      },
      body: makeNode('body'),
      // 真 DOM 一定有这两个 —— app.js 的导航折叠在**加载时**就注册
      // 「点外面收起」与「Esc 收起」两个 document 级监听器。
      // 少了 addEventListener，整个脚本会在加载时就炸，
      // 掩盖掉真正的断言失败。
      addEventListener: () => {},
      removeEventListener: () => {},
    },
    window: {},
    setInterval: () => 0,
    clearInterval: () => {},
    setTimeout: () => 0,
    navigator: {},
    location: { search: '' },
    // app.js 加载末尾会触发一次拉取 —— 这里不关心内容，
    // 但不能让它把整个脚本炸掉（那会掩盖真正的断言失败）。
    fetch: () => Promise.resolve({ ok: true, json: () => Promise.resolve({}) }),
    console,
  };
  runInNewContext(APP_JS, sandbox);
  return sandbox;
}

/** 造一个 `facts.diff` 形状的对象。 */
function makeDiff(fileCount: number) {
  return {
    baseRef: 'abc1234',
    baseNote: '切片冻结时的基点 abc1234',
    filesChanged: fileCount,
    addedLines: fileCount * 10,
    deletedLines: fileCount * 2,
    files: Array.from({ length: fileCount }, (_, i) => ({
      path: `src/file-${String(i).padStart(3, '0')}.ts`,
      status: i % 3 === 0 ? 'added' : i % 3 === 1 ? 'modified' : 'deleted',
      added: i % 3 === 2 ? null : 10,
      deleted: i % 3 === 1 ? 2 : null,
    })),
  };
}

describe('驾驶舱「改了什么」段（前端行为）', () => {
  it('app.js 暴露了 renderDiffSection（否则这一段没法测）', () => {
    const sandbox = loadAppJs();
    assert.equal(
      typeof sandbox['renderDiffSection'],
      'function',
      'app.js 里的 renderDiffSection 必须在全局可见 —— 否则下面的断言测的是空气',
    );
  });

  it('文件少时直接全列，不出现「展开全部」', () => {
    const sandbox = loadAppJs();
    const target = makeNode('div');
    const renderDiffSection = sandbox['renderDiffSection'] as (
      t: ShimNode,
      d: unknown,
    ) => void;

    renderDiffSection(target, makeDiff(5));

    const rows = target.querySelectorAll('.diff-file');
    assert.equal(rows.length, 5, '5 个文件应当全列出来');
    const text = target.text();
    assert.ok(!text.includes('展开全部'), '文件不满限额时不该出现「展开全部」');
  });

  it('文件多时封顶到前 N 个，并给出「还有 M 个」', () => {
    const sandbox = loadAppJs();
    const target = makeNode('div');
    const renderDiffSection = sandbox['renderDiffSection'] as (
      t: ShimNode,
      d: unknown,
    ) => void;

    renderDiffSection(target, makeDiff(500));

    const rows = target.querySelectorAll('.diff-file');
    assert.ok(rows.length > 0 && rows.length < 500, '不该全渲染出来');
    assert.ok(
      target.text().includes('还有'),
      '必须告诉人「还有多少个」—— 不说就是藏起来了',
    );
    assert.ok(target.text().includes('展开全部'), '必须给展开的出口');
  });

  it('点「展开全部」后列出全部文件', () => {
    const sandbox = loadAppJs();
    const target = makeNode('div');
    const renderDiffSection = sandbox['renderDiffSection'] as (
      t: ShimNode,
      d: unknown,
    ) => void;

    renderDiffSection(target, makeDiff(500));

    const before = target.querySelectorAll('.diff-file').length;
    const toggle = target.querySelectorAll('button').find(
      (b) => b.text() === '展开全部',
    );
    assert.ok(toggle, '必须有「展开全部」按钮');

    toggle.click();

    const after = target.querySelectorAll('.diff-file').length;
    assert.equal(after, 500, '展开后应当是全部 500 个文件');
    assert.ok(after > before, '展开后行数必须变多');
  });

  it('展开后能收起，回到封顶视图', () => {
    const sandbox = loadAppJs();
    const target = makeNode('div');
    const renderDiffSection = sandbox['renderDiffSection'] as (
      t: ShimNode,
      d: unknown,
    ) => void;

    renderDiffSection(target, makeDiff(500));

    const capped = target.querySelectorAll('.diff-file').length;
    const expandBtn = target.querySelectorAll('button').find(
      (b) => b.text() === '展开全部',
    );
    assert.ok(expandBtn);
    expandBtn.click();
    assert.equal(target.querySelectorAll('.diff-file').length, 500);

    const collapseBtn = target.querySelectorAll('button').find(
      (b) => b.text() === '收起',
    );
    assert.ok(collapseBtn, '展开后按钮应当变成「收起」');
    collapseBtn.click();

    assert.equal(
      target.querySelectorAll('.diff-file').length,
      capped,
      '收起后应当回到封顶的行数',
    );
    const expandAgain = target.querySelectorAll('button').find(
      (b) => b.text() === '展开全部',
    );
    assert.ok(expandAgain, '收起后按钮应当变回「展开全部」');
  });

  it('展开 → 收起 → 再展开，结论一致（不是单向的一次性）', () => {
    const sandbox = loadAppJs();
    const target = makeNode('div');
    const renderDiffSection = sandbox['renderDiffSection'] as (
      t: ShimNode,
      d: unknown,
    ) => void;

    renderDiffSection(target, makeDiff(120));

    const capped = target.querySelectorAll('.diff-file').length;

    for (let i = 0; i < 3; i++) {
      const expand = target.querySelectorAll('button').find((b) => b.text() === '展开全部');
      assert.ok(expand, `第 ${i + 1} 轮找不到展开按钮`);
      expand.click();
      assert.equal(target.querySelectorAll('.diff-file').length, 120);

      const collapse = target.querySelectorAll('button').find((b) => b.text() === '收起');
      assert.ok(collapse, `第 ${i + 1} 轮找不到收起按钮`);
      collapse.click();
      assert.equal(target.querySelectorAll('.diff-file').length, capped);
    }
  });

  it('展开出来的行内容正确（不是空壳）', () => {
    const sandbox = loadAppJs();
    const target = makeNode('div');
    const renderDiffSection = sandbox['renderDiffSection'] as (
      t: ShimNode,
      d: unknown,
    ) => void;

    const diff = makeDiff(30);
    renderDiffSection(target, diff);

    const expand = target.querySelectorAll('button').find((b) => b.text() === '展开全部');
    assert.ok(expand);
    expand.click();

    const rows = target.querySelectorAll('.diff-file');
    assert.equal(rows.length, 30);
    // 最后一行（展开后才出现的）必须是真内容
    const last = rows[rows.length - 1];
    assert.ok(
      last.text().includes(diff.files[29].path),
      '展开出来的行必须带上正确的路径',
    );
  });

  it('没有文件改动时不给「展开全部」（没有东西可展开）', () => {
    const sandbox = loadAppJs();
    const target = makeNode('div');
    const renderDiffSection = sandbox['renderDiffSection'] as (
      t: ShimNode,
      d: unknown,
    ) => void;

    renderDiffSection(target, {
      baseRef: null,
      baseNote: '',
      filesChanged: 0,
      addedLines: 0,
      deletedLines: 0,
      files: [],
    });

    assert.equal(target.querySelectorAll('button').length, 0, '不该有按钮');
    assert.ok(target.text().includes('没有查到文件级改动'));
  });
});
