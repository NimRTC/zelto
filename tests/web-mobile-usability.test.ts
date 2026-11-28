// 驾驶舱移动端可用性守卫 —— 触摸目标 / 键盘可达 / 焦点可见 / 窄屏导航折叠
//
// ── 为什么要有这个 ────────────────────────────────────────────────────
//
// 2026-11-28 实测（Chrome DevTools，390×844 视口，iPhone 尺寸）：
//
//   ① `.q-option`（提问候选答案按钮）只有 **57×27px**
//      —— 而它恰恰是「手机回答 agent 提问」时**最常点的元素**。
//   ② `← 返回` 按钮只有 **42×31px**。
//   ③ 整份 CSS 里**一条 `:focus-visible` 规则都没有**
//      —— 键盘用户 Tab 过去不知道自己站在哪。
//   ④ 列表页 **154 个可点击行**，一个都没有 tabindex、一个都没有 role
//      —— 键盘与读屏用户完全进不去。
//   ⑤ 9 个视图按钮 + 拉闸在 390px 下占 **3 行**（实测截图），
//      把首屏内容挤到屏幕外。
//
// 前四条是**缺陷**（该做而没做），第五条是**优化**（做了更好）。
// 但它们有一个共同点：**都是回归**。修好之后，谁改坏了都会重新坏掉。
//
// ── 为什么用「读源码断言」而不是跑端到端 ──────────────────────────────
//
// 端到端测触摸目标要真的模拟手机视口 —— 本仓库没有浏览器自动化依赖，
// 而且真机尺寸在 CI 上不稳定。
//
// 所以这里守**结构**：CSS 里有没有那条规则、JS 里有没有那个属性。
// 这些能一眼看出「改没改」，比数字更不会假绿。
//
// 但只看源码有个风险：断言写错了也会绿。所以每条断言都指向
// 一段**具体的、可读的**代码形状，不是脆弱的字符串匹配。
//
// ── 与既有测试的分工 ──────────────────────────────────────────────────
//
//   web-adr109-vpn-mobile.test.ts  钉 ADR-109 的**决策**（绑定面、同源、窄屏断点）
//   本文件                        钉 ADR-109 落地后的**实测缺口**（可点得准、键盘能用）
//
// 分开 = 两份追溯各归各（沿用 ADR-109 那条「分开写」的纪律）。

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));

function readSrc(...parts: string[]): string {
  let dir = here;
  for (let i = 0; i < 10; i++) {
    try {
      readFileSync(join(dir, 'package.json'));
      return readFileSync(join(dir, 'src', ...parts), 'utf-8');
    } catch {
      dir = dirname(dir);
    }
  }
  throw new Error('找不到仓库根');
}

const APP_JS = readSrc('adapters', 'web', 'frontend', 'app.js');
const CSS = readSrc('adapters', 'web', 'frontend', 'styles.css');
const FRONTEND_TS = readSrc('adapters', 'web', 'frontend.ts');

/** 取出窄屏媒体查询那一段 —— 断点内的规则才是手机上的规则。 */
function mobileBlock(css: string): string {
  const start = css.indexOf('@media (max-width: 720px)');
  assert.notEqual(start, -1, '必须有窄屏媒体查询');
  return css.slice(start);
}

/** 在一段 CSS 里找某个选择器的声明块。 */
function rule(css: string, selector: string): string {
  const idx = css.indexOf(selector + ' {');
  if (idx === -1) return '';
  const end = css.indexOf('}', idx);
  return css.slice(idx, end);
}

describe('驾驶舱 · 移动端可用性', () => {
  describe('触摸目标 ≥ 44px（窄屏）', () => {
    it('.q-option 在窄屏被放大 —— 它是最常点的元素（实测曾只有 27px）', () => {
      const m = mobileBlock(CSS);
      const r = rule(m, '.q-option');
      assert.notEqual(r, '', '窄屏必须有 .q-option 规则');
      const pad = r.match(/padding:\s*([^;]+);/);
      assert.ok(pad, '.q-option 必须设 padding');
      const py = parseFloat(pad[1].split(/\s+/)[0]);
      // 内容高 = 13px 字 × 1.6 行高 ≈ 20.8px；上下各 12px + 2px 边框 = 46.8px
      assert.ok(py >= 11, `.q-option 上下内边距应 ≥11px，实际 ${py}px（27px→45px 的关键）`);
    });

    it('.back（返回按钮）在窄屏被放大 —— 实测曾只有 31px', () => {
      const r = rule(mobileBlock(CSS), '.back');
      assert.notEqual(r, '', '窄屏必须有 .back 规则');
      assert.match(r, /padding:\s*([^;]+);/, '.back 必须设 padding');
      const pad = r.match(/padding:\s*([^;]+);/)![1].split(/\s+/);
      const py = parseFloat(pad[0]);
      assert.ok(py >= 10, `.back 上下内边距应 ≥10px，实际 ${py}px`);
    });

    it('.next-cmd（待办里的命令行）在窄屏被放大 —— 实测曾只有 37px', () => {
      const r = rule(mobileBlock(CSS), '.next-cmd');
      assert.notEqual(r, '', '窄屏必须有 .next-cmd 规则');
      const pad = r.match(/padding:\s*([^;]+);/)!;
      const py = parseFloat(pad[1].split(/\s+/)[0]);
      assert.ok(py >= 10, `.next-cmd 上下内边距应 ≥10px，实际 ${py}px`);
    });

    it('回答输入框在窄屏 ≥44px 且字号 ≥16px（否则 iOS Safari 自动放大）', () => {
      const r = rule(mobileBlock(CSS), '.answer-input');
      assert.notEqual(r, '', '窄屏必须有 .answer-input 规则');
      assert.match(r, /min-height:\s*44px/, '输入框必须 min-height 44px');
      const fs = r.match(/font-size:\s*(\d+)px/);
      assert.ok(fs, '输入框必须设字号');
      assert.ok(
        parseInt(fs[1]) >= 16,
        `输入框字号应 ≥16px（小于会触发 iOS 自动放大），实际 ${fs[1]}px`,
      );
    });

    it('回答行在窄屏换行 —— 输入框与提交按钮各占一行，不挤成窄条', () => {
      const r = rule(mobileBlock(CSS), '.answer-row');
      assert.match(r, /flex-wrap:\s*wrap/, '.answer-row 必须允许换行');
    });
  });

  describe('焦点可见性', () => {
    it('有全局 :focus-visible 规则 —— 实测整份 CSS 一条都没有', () => {
      assert.match(CSS, /:focus-visible/, '必须有 :focus-visible 规则');
    });

    it('焦点环用 outline（不触发布局抖动，且高对比度模式下不被抹掉）', () => {
      const r = rule(CSS, ':focus-visible');
      assert.notEqual(r, '', '必须有 :focus-visible 规则');
      assert.match(r, /outline:\s*2px solid/, '焦点环应是 2px 实线 outline');
      assert.match(r, /outline-offset/, '焦点环应有偏移，不贴着元素边缘');
    });

    it('可点击行有专门的焦点环 —— overflow 裁不掉它', () => {
      assert.match(
        CSS,
        /tr\.clickable:focus-visible/,
        '必须有 tr.clickable:focus-visible 规则',
      );
    });

    it('输入框聚焦不再抹掉轮廓 —— 原来只有 border-color 变化', () => {
      const r = rule(CSS, '.answer-input:focus');
      assert.notEqual(r, '', '必须有 .answer-input:focus 规则');
      assert.doesNotMatch(
        r,
        /outline:\s*none/,
        '聚焦时不能把轮廓抹掉（键盘用户看不到焦点在哪）',
      );
    });
  });

  describe('表格行的键盘可达', () => {
    it('可点击行里有**真按钮** —— 不用在 <tr> 上挂 role=button', () => {
      // 2026-11-28 修正：上一版在 <tr> 上挂 role="button"，
      // 结果把 154 个行变成 154 个「按钮」，表格的行/列结构
      // 在无障碍树里几乎消失（实测 cell 从几百掉到 15）。
      // 正确做法是第一格放真 <button>（W3C 建议）。
      assert.match(
        APP_JS,
        /el\('button',\s*'row-open'\)/,
        'table() 必须在第一格放一个真按钮',
      );
      assert.doesNotMatch(
        APP_JS,
        /setAttribute\('role',\s*'button'\)/,
        '不能在 <tr> 上挂 role=button —— 会顶掉原生 row 角色',
      );
    });

    it('行本身不再挂 tabindex —— 键盘语义归真按钮', () => {
      assert.doesNotMatch(
        APP_JS,
        /setAttribute\('tabindex',\s*'0'\)/,
        '不该在 <tr> 上挂 tabindex —— 那是上一版的做法',
      );
    });

    it('真按钮自带键盘语义 —— 不用手写 keydown 处理 Enter/Space', () => {
      // 原生按钮自带 Enter/Space 触发与 focus ——
      // 手写 keydown 反而容易漏掉 preventDefault（Space 会滚页面）。
      assert.doesNotMatch(
        APP_JS,
        /tr\.addEventListener\('keydown'/,
        '不该在 <tr> 上手写 keydown',
      );
    });

    it('按钮的点击不会**同时**触发行处理器 —— 否则点一下打开两次', () => {
      assert.match(
        APP_JS,
        /ev\.stopPropagation\(\)/,
        '按钮点击必须 stopPropagation',
      );
      assert.match(
        APP_JS,
        /closest\('\.row-open'\)/,
        '行处理器必须放行来自 .row-open 的点击',
      );
    });
  });

  describe('窄屏导航折叠', () => {
    it('有折叠按钮与当前视图指示器', () => {
      assert.match(FRONTEND_TS, /id="nav-toggle"/, '必须有 #nav-toggle');
      assert.match(FRONTEND_TS, /id="nav-current"/, '必须有 #nav-current');
      assert.match(FRONTEND_TS, /id="nav-list"/, '必须有 #nav-list 容器');
    });

    it('视图按钮在 #nav-list 里，拉闸在**外面** —— 刹车不能藏在收起的菜单里', () => {
      const nav = FRONTEND_TS.match(/<nav id="nav">[\s\S]*?<\/nav>/);
      assert.ok(nav, '必须有 nav 元素');
      const body = nav[0];
      const listStart = body.indexOf('<div id="nav-list">');
      const listEnd = body.indexOf('</div>', listStart);
      assert.ok(listStart > -1 && listEnd > listStart, '必须有 #nav-list 容器');
      const listInner = body.slice(listStart, listEnd);
      const afterList = body.slice(listEnd);
      // 视图按钮在容器内
      assert.match(listInner, /data-view="overview"/, '视图按钮应在 #nav-list 内');
      // 拉闸在容器外
      assert.match(afterList, /id="halt-btn"/, '拉闸按钮必须在 #nav-list 之外');
      assert.doesNotMatch(listInner, /id="halt-btn"/, '拉闸按钮不能放在 #nav-list 内');
    });

    it('折叠按钮在桌面端隐藏 —— 桌面端一像素不变', () => {
      assert.match(
        CSS,
        /#nav-toggle\s*\{\s*display:\s*none/,
        '桌面端必须隐藏折叠按钮',
      );
      assert.match(
        CSS,
        /#nav-current\s*\{\s*display:\s*none/,
        '桌面端必须隐藏当前视图指示器',
      );
    });

    it('窄屏折叠态下菜单不显示', () => {
      assert.match(
        mobileBlock(CSS),
        /#nav:not\(\.open\)\s+#nav-list\s*\{\s*display:\s*none/,
        '折叠态必须隐藏菜单',
      );
    });

    it('视图按钮的绑定范围是 #nav-list button[data-view] —— 不是 nav button', () => {
      // 折叠后 nav 里多了 #nav-current 与 #nav-toggle，它们没有 data-view。
      // 若用 nav button 选中它们，点击就会 render(null) —— 把视图渲染搞崩。
      assert.match(
        APP_JS,
        /querySelectorAll\('#nav-list button\[data-view\]'\)/,
        '绑定范围必须是 #nav-list button[data-view]',
      );
      assert.doesNotMatch(
        APP_JS,
        /querySelectorAll\('nav button'\)/,
        '不能用 nav button —— 会把折叠按钮也算进去',
      );
    });

    it('切换视图后收起菜单 —— 否则菜单一直占着屏幕', () => {
      assert.match(APP_JS, /closeNavMenu\(\)/, '必须有 closeNavMenu');
    });

    it('Esc 能收起菜单 —— 键盘用户的惯例', () => {
      assert.match(APP_JS, /'Escape'/, 'Esc 必须收起菜单');
    });

    it('点菜单外面收起 —— 手机上没有「点外面」这个概念太别扭了', () => {
      assert.match(APP_JS, /nav\.contains\(ev\.target\)/, '必须处理点击外部收起');
    });

    it('菜单按钮同步 aria-expanded —— 读屏软件要知道开没开', () => {
      assert.match(APP_JS, /navToggle\.setAttribute\('aria-expanded'/, '必须同步 aria-expanded');
    });
  });

  describe('视图数据并发取', () => {
    it('viewSlices 三个接口并发 —— 原来串行约 840ms', () => {
      // 从 viewSlices 的定义开始，找到它自己的那个 Promise.all
      // （页面里还有 viewOverview 的那个 —— 不能混）
      const start = APP_JS.indexOf('async function viewSlices');
      assert.ok(start > -1, '必须有 viewSlices');
      const body = APP_JS.slice(start, start + 1200);
      assert.match(body, /Promise\.all\(/, 'viewSlices 必须用 Promise.all');
      for (const p of ['/api/slices', '/api/plan-coverage', '/api/worktrees']) {
        assert.ok(body.includes(p), `Promise.all 里必须含 ${p}`);
      }
    });

    it('切片详情与计划索引并发 —— 两者互不依赖', () => {
      const start = APP_JS.indexOf('async function showSliceDetail');
      assert.ok(start > -1, '必须有 showSliceDetail');
      const body = APP_JS.slice(start, start + 1500);
      assert.match(body, /Promise\.all\(/, 'showSliceDetail 必须用 Promise.all');
      assert.ok(body.includes('/api/plan-coverage'), '必须并发取计划索引');
    });

    it('并发取不改变「拿不到就不显示」的语义 —— 不编', () => {
      // 计划索引拿不到 → 不出「计划」列；工作区脉络拿不到 → 整节不显示。
      assert.match(
        APP_JS,
        /apiGet\('\/api\/plan-coverage'\)\s*\.catch\([\s\S]{0,80}?return null/,
        '计划索引失败必须返回 null（而不是抛出去）',
      );
    });
  });

  // ── 2026-11-28 第二轮：上一轮修完之后才发现的三个真问题 ──────────
  describe('轮询不能吃掉键盘焦点', () => {
    it('refreshSilently 替换内容前后要保存/恢复焦点', () => {
      // 实测：轮询每 5 秒 clear(main) + 重建 —— 旧节点被丢弃，
      // 焦点跟着没了，浏览器退回 body。
      // 键盘用户 Tab 到第 12 行正要回车，5 秒后得重新 Tab 12 次；
      // 读屏用户更糟：焦点一丢，读屏直接停止朗读当前内容。
      const start = APP_JS.indexOf('async function refreshSilently');
      assert.ok(start > -1, '必须有 refreshSilently');
      const body = APP_JS.slice(start, start + 900);
      assert.match(body, /preserveFocus/, 'refreshSilently 必须保存并恢复焦点');
      assert.match(body, /restoreFocus\(\)/, '替换内容后必须恢复焦点');
    });

    it('焦点位置用**路径**记 —— 元素引用在重建后无效', () => {
      assert.match(APP_JS, /function focusPath/, '必须有 focusPath');
      assert.match(APP_JS, /function nodeAtPath/, '必须有 nodeAtPath');
      assert.match(
        APP_JS,
        /childNodes/,
        '焦点路径必须基于 childNodes（重建后位置不变）',
      );
    });

    it('恢复焦点用 preventScroll —— 否则页面会跳回顶部', () => {
      assert.match(
        APP_JS,
        /preventScroll:\s*true/,
        '恢复焦点必须带 preventScroll（否则滚动位置被拉回焦点处）',
      );
    });
  });

  describe('当前视图指示器不是控件', () => {
    it('#nav-current 是 <span> 不是 <button>', () => {
      // 它只是「我在哪个视图」的状态播报。
      // 做成按钮的话：Tab 到它、按回车毫无反应 —— 是个坏控件。
      assert.match(
        FRONTEND_TS,
        /<span id="nav-current"/,
        '#nav-current 必须是 span（不是 button）',
      );
      assert.doesNotMatch(
        FRONTEND_TS,
        /<button id="nav-current"/,
        '#nav-current 不能是 button —— 它不是控件',
      );
    });

    it('#nav-current 不带 aria-expanded —— 折叠语义归 #nav-toggle 独占', () => {
      // 上一版把它做成 aria-expanded=false 的按钮 ——
      // 读屏软件播报「已折叠」，但按回车毫无反应（实测：菜单不动）。
      const m = FRONTEND_TS.match(/<[^>]*id="nav-current"[^>]*>/);
      assert.ok(m, '必须有 #nav-current 元素');
      assert.doesNotMatch(
        m[0],
        /aria-expanded/,
        '#nav-current 不能有 aria-expanded（它不是折叠控件）',
      );
      assert.doesNotMatch(
        m[0],
        /aria-controls/,
        '#nav-current 不能有 aria-controls（它不控制任何东西）',
      );
    });

    it('#nav-current 用 aria-live 播报 —— 切视图时读屏会念出视图名', () => {
      const m = FRONTEND_TS.match(/<[^>]*id="nav-current"[^>]*>/);
      assert.ok(m);
      assert.match(m[0], /aria-live="polite"/, '#nav-current 必须有 aria-live');
    });

    it('播报带「当前视图：」前缀 —— 否则读屏只念一个孤零零的「总览」', () => {
      assert.match(
        APP_JS,
        /当前视图：/,
        '必须给 aria-live 的内容加前缀',
      );
      assert.match(
        CSS,
        /\.sr-only/,
        '必须有 .sr-only 类（视觉隐藏但读屏可读）',
      );
    });
  });

  describe('状态变化要能被告警', () => {
    it('连接状态条是 aria-live —— 读屏用户要知道服务断了', () => {
      // 实测：aria-live 区域数为 0 —— 读屏用户完全不知道
      // 「连接已断开」这件事发生过。
      const m = FRONTEND_TS.match(/<[^>]*id="conn"[^>]*>/);
      assert.ok(m, '必须有 #conn');
      assert.match(m[0], /aria-live/, '#conn 必须有 aria-live');
      assert.match(m[0], /role="alert"/, '#conn 必须是 alert（最要紧的事立刻说）');
    });

    it('动作横幅是 aria-live —— 签字成功/失败要说得出来', () => {
      const m = FRONTEND_TS.match(/<[^>]*id="banner"[^>]*>/);
      assert.ok(m, '必须有 #banner');
      assert.match(m[0], /aria-live="polite"/, '#banner 必须有 aria-live');
    });
  });
});
