// 前端静态资源 —— CSS 与 JS 的内嵌字符串（ADR-072）
//
// 拆成两个文件是为了让 `frontend.ts` 保持可读 ——
// 样式与脚本都很长，混在一个模板字符串里没法读。
//
// 这里是**前端代码**，不是 TypeScript —— 它跑在浏览器里。
// 里面有 `any` 味道的东西是正常的（浏览器 API 的类型不在 TS 的世界里）。
//
// XSS 纪律（贯穿整个脚本）：**来自 API 的数据一律用 `textContent`**。

/** 样式表 —— 深色终端风，与 `zelto dashboard` 的 HTML 看板同一套视觉语言。 */
export function renderStyles(): string {
  return `
:root {
  --bg: #0d1117;
  --panel: #161b22;
  --border: #21262d;
  --fg: #e6edf3;
  --muted: #8b949e;
  --accent: #58a6ff;
  --ok: #3fb950;
  --warn: #d29922;
  --bad: #f85149;
}
* { box-sizing: border-box; }
body {
  margin: 0;
  background: var(--bg);
  color: var(--fg);
  font-family: ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace;
  font-size: 13px;
  line-height: 1.6;
}
header {
  border-bottom: 1px solid var(--border);
  padding: 14px 20px;
  background: var(--panel);
  position: sticky;
  top: 0;
  z-index: 10;
}
h1 { font-size: 16px; margin: 0 0 10px; font-weight: 600; }
h1 small { color: var(--muted); font-weight: 400; font-size: 12px; }
nav { display: flex; gap: 6px; }
nav button {
  background: transparent;
  color: var(--muted);
  border: 1px solid var(--border);
  border-radius: 6px;
  padding: 4px 12px;
  cursor: pointer;
  font: inherit;
}
nav button:hover { color: var(--fg); border-color: var(--accent); }
nav button.active { color: var(--fg); border-color: var(--accent); background: #1f2937; }
main { padding: 20px; max-width: 1200px; }
#banner { padding: 0 20px; max-width: 1200px; }
#banner .notice { margin: 10px 0; }
h2 { font-size: 14px; margin: 22px 0 10px; font-weight: 600; }
h2:first-child { margin-top: 0; }
table { border-collapse: collapse; width: 100%; margin-bottom: 8px; }
th, td {
  text-align: left;
  padding: 6px 10px;
  border-bottom: 1px solid var(--border);
  vertical-align: top;
}
th { color: var(--muted); font-weight: 600; font-size: 11px; text-transform: uppercase; }
tr.clickable { cursor: pointer; }
tr.clickable:hover td { background: #161b22; }
.muted { color: var(--muted); }
.cards { display: flex; gap: 10px; flex-wrap: wrap; margin-bottom: 14px; }
.card {
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 10px 14px;
  min-width: 120px;
  background: var(--panel);
}
.card .n { font-size: 22px; font-weight: 600; }
.card .l { color: var(--muted); font-size: 11px; }
.badge {
  display: inline-block;
  padding: 1px 8px;
  border-radius: 9px;
  font-size: 11px;
  font-weight: 600;
  color: #fff;
}
.state-draft { background: #6e7681; }
.state-clarifying { background: #a371f7; }
.state-frozen { background: #58a6ff; }
.state-running { background: #d29922; }
.state-completed { background: #3fb950; }
.state-abandoned { background: #f85149; }
.check { display: flex; gap: 8px; padding: 6px 0; border-bottom: 1px solid var(--border); }
.check:last-child { border-bottom: none; }
.check .mark { font-weight: 700; width: 16px; }
.check.ok .mark { color: var(--ok); }
.check.no .mark { color: var(--bad); }
.check .label { font-weight: 600; min-width: 120px; }
.check .ev { color: var(--muted); }
.check .adr { color: #484f58; font-size: 11px; margin-left: auto; white-space: nowrap; }
.btn {
  border: 1px solid var(--border);
  background: #21262d;
  color: var(--fg);
  border-radius: 6px;
  padding: 6px 14px;
  cursor: pointer;
  font: inherit;
}
.btn:hover:not(:disabled) { border-color: var(--accent); }
.btn:disabled { opacity: .45; cursor: not-allowed; }
.btn.ok { background: #1a7f37; border-color: #2ea043; }
.btn.ok:hover:not(:disabled) { background: #2ea043; }
.notice {
  border-left: 3px solid var(--warn);
  background: #1c2128;
  padding: 8px 12px;
  margin: 10px 0;
  border-radius: 0 6px 6px 0;
}
.notice.bad { border-left-color: var(--bad); }
.notice.ok { border-left-color: var(--ok); }
pre {
  background: var(--panel);
  border: 1px solid var(--border);
  border-radius: 6px;
  padding: 10px;
  overflow-x: auto;
  font-size: 12px;
}
.back {
  background: none;
  border: none;
  color: var(--accent);
  cursor: pointer;
  font: inherit;
  padding: 0 0 10px;
  display: block;
}
.kv { display: grid; grid-template-columns: 130px 1fr; gap: 2px 12px; }
.kv dt { color: var(--muted); }
.kv dd { margin: 0; }
.tag {
  display: inline-block;
  background: #21262d;
  border: 1px solid var(--border);
  border-radius: 4px;
  padding: 0 6px;
  margin: 1px 3px 1px 0;
  font-size: 11px;
}
`;
}

/**
 * 前端脚本。
 *
 * 纪律：
 *   1. API 数据一律 `textContent` 写入（不拼 innerHTML）—— XSS 防线
 *   2. 写操作带 `X-Zelto-Token` 头 —— CSRF 防线（ADR-072 §3）
 *   3. 签字按钮的启用条件由**服务端返回的判定**决定 —— 前端只是呈现
 */
export function renderAppJs(): string {
  return `
'use strict';

const TOKEN = window.__ZELTO_TOKEN__;
const main = document.getElementById('main');
const summaryLine = document.getElementById('summary-line');
let currentView = 'overview';
// 当前是否停在**切片详情页**。
//
// 为什么单独一个变量，而不是看 currentView：
// 详情页是从总览/切片列表点进去的 —— 那时 currentView 仍然是 'overview'，
// 靠它判断「在不在详情页」会判错，于是轮询把详情页整个换掉
// （实测：进详情后 4 秒被刷回总览，人正在看的东西被抢走）。
let inDetail = false;
let pollTimer = null;

// ── HTTP ───────────────────────────────────────────────────────────────

async function apiGet(path) {
  const res = await fetch(path, { headers: { 'Accept': 'application/json' } });
  const body = await res.json().catch(function () { return { error: '响应不是 JSON' }; });
  if (!res.ok) throw new Error(body.error || ('HTTP ' + res.status));
  return body;
}

async function apiPost(path, payload) {
  const res = await fetch(path, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Zelto-Token': TOKEN
    },
    body: JSON.stringify(payload || {})
  });
  const body = await res.json().catch(function () { return { error: '响应不是 JSON' }; });
  return { ok: res.ok, status: res.status, body: body };
}

// ── DOM 帮手 ───────────────────────────────────────────────────────────
//
// 只用 createElement + textContent —— 不用 innerHTML 拼数据。

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined && text !== null) node.textContent = String(text);
  return node;
}

function clear(node) {
  while (node.firstChild) node.removeChild(node.firstChild);
}

function table(headers, rows) {
  const t = el('table');
  const thead = el('thead');
  const htr = el('tr');
  for (const h of headers) htr.appendChild(el('th', null, h));
  thead.appendChild(htr);
  t.appendChild(thead);
  const tbody = el('tbody');
  for (const r of rows) {
    const tr = el('tr');
    if (r.onClick) {
      tr.className = 'clickable';
      tr.addEventListener('click', r.onClick);
    }
    for (const cell of r.cells) {
      const td = el('td');
      if (cell instanceof Node) td.appendChild(cell);
      else td.textContent = cell === null || cell === undefined ? '' : String(cell);
      tr.appendChild(td);
    }
    tbody.appendChild(tr);
  }
  t.appendChild(tbody);
  return t;
}

function stateBadge(state) {
  return el('span', 'badge state-' + state, state);
}

// ── 视图 ───────────────────────────────────────────────────────────────

async function viewOverview(target) {
  const s = await apiGet('/api/summary');
  clear(target);

  const cards = el('div', 'cards');
  const card = function (n, l) {
    const c = el('div', 'card');
    c.appendChild(el('div', 'n', n));
    c.appendChild(el('div', 'l', l));
    return c;
  };
  cards.appendChild(card(s.totalSlices, '切片'));
  cards.appendChild(card(s.pendingSignCount, '待签字'));
  cards.appendChild(card(s.stalledCount, '停机'));
  const states = Object.keys(s.byState || {});
  for (const st of states) cards.appendChild(card(s.byState[st], st));
  target.appendChild(cards);

  target.appendChild(el('h2', null, '待签字'));
  if (!s.pendingSigns || s.pendingSigns.length === 0) {
    target.appendChild(el('p', 'muted', '没有待签字的切片。'));
  } else {
    target.appendChild(table(
      ['切片', '请求时间'],
      s.pendingSigns.map(function (p) {
        return {
          onClick: function () { showSliceDetail(p.sliceId); },
          cells: [p.sliceId, new Date(p.requestedAt).toLocaleString()]
        };
      })
    ));
  }

  if (s.stalledSlices && s.stalledSlices.length > 0) {
    target.appendChild(el('h2', null, '停机'));
    target.appendChild(table(
      ['切片', '分类'],
      s.stalledSlices.map(function (x) {
        return { onClick: function () { showSliceDetail(x.id); }, cells: [x.id, x.stallClass] };
      })
    ));
  }
}

async function viewSlices(target) {
  const slices = await apiGet('/api/slices');
  clear(target);
  target.appendChild(el('h2', null, '全部切片（' + slices.length + '）'));
  target.appendChild(table(
    ['切片', '标题', '状态', '追溯(需/契/测)', '写集', '运行', '更新'],
    slices.map(function (s) {
      return {
        onClick: function () { showSliceDetail(s.id); },
        cells: [
          s.id,
          s.title,
          stateBadge(s.state),
          s.trace.requirements + '/' + s.trace.contracts + '/' + s.trace.tests,
          String(s.writeCount),
          s.runCount === 0 ? '—' : (s.lastRunOk ? '✅ ' + s.runCount : '❌ ' + s.runCount),
          new Date(s.updatedAt).toLocaleString()
        ]
      };
    })
  ));
}

async function viewSigns(target) {
  const reqs = await apiGet('/api/sign-requests?status=pending');
  clear(target);
  target.appendChild(el('h2', null, '待签字（' + reqs.length + '）'));
  if (reqs.length === 0) {
    target.appendChild(el('p', 'muted', '没有待签字的切片。'));
    return;
  }
  for (const r of reqs) {
    target.appendChild(el('h2', null, r.sliceId));
    const btn = el('button', 'btn ok', '查看并签字');
    btn.addEventListener('click', function () { showSliceDetail(r.sliceId, true); });
    target.appendChild(btn);
  }
}

async function viewEvents(target) {
  const events = await apiGet('/api/events?limit=200');
  clear(target);
  target.appendChild(el('h2', null, '最近事件（' + events.length + '）'));
  target.appendChild(table(
    ['时间', '切片', '类型', '操作者'],
    events.map(function (e) {
      return {
        onClick: function () { showSliceDetail(e.slice); },
        cells: [new Date(e.ts).toLocaleString(), e.slice, e.type, e.actor]
      };
    })
  ));
}

async function showSliceDetail(id, forSign) {
  clear(main);
  inDetail = true;
  const back = el('button', 'back', '← 返回');
  back.addEventListener('click', function () { render(currentView); });
  main.appendChild(back);

  let d;
  try {
    d = await apiGet('/api/slices/' + encodeURIComponent(id));
  } catch (err) {
    main.appendChild(el('p', 'notice bad', '加载失败：' + err.message));
    return;
  }

  const slice = d.slice;
  main.appendChild(el('h2', null, id + ' — ' + slice.title));

  const dl = el('dl', 'kv');
  const kv = function (k, v) {
    dl.appendChild(el('dt', null, k));
    dl.appendChild(el('dd', null, v));
  };
  kv('状态', slice.state);
  kv('类型', slice.type || '—');
  kv('写集', String((slice.writes || []).length) + ' 项');
  kv('运行', String((slice.runs || []).length) + ' 次');
  kv('创建', new Date(slice.createdAt).toLocaleString());
  kv('更新', new Date(slice.updatedAt).toLocaleString());
  main.appendChild(dl);

  // ── 签字前确认项 ────────────────────────────────────────────────────
  main.appendChild(el('h2', null, '签字前请确认四件事'));
  const allOk = d.checks.every(function (c) { return c.ok; });
  for (const c of d.checks) {
    const row = el('div', 'check ' + (c.ok ? 'ok' : 'no'));
    row.appendChild(el('span', 'mark', c.ok ? '✓' : '✗'));
    row.appendChild(el('span', 'label', c.label));
    row.appendChild(el('span', 'ev', c.evidence));
    row.appendChild(el('span', 'adr', c.adrRef));
    main.appendChild(row);
  }

  // ── 签字 ────────────────────────────────────────────────────────────
  if (forSign) {
    const btn = el('button', 'btn ok', '确认签字');
    // 前端这道只是「看过才解锁」；真正的门在服务端（ADR-072 §5.2）
    btn.disabled = !allOk;
    if (!allOk) {
      main.appendChild(el('p', 'notice bad', '有确认项未通过 —— 服务端也会拒绝签字。'));
    }
    btn.addEventListener('click', function () { doApprove(id, btn); });
    main.appendChild(btn);
  }

  // ── 追溯链 ──────────────────────────────────────────────────────────
  main.appendChild(el('h2', null, '追溯链'));
  const trace = d.trace || { requirements: [], contracts: [], tests: [] };
  const tdl = el('dl', 'kv');
  const tk = function (k, list) {
    tdl.appendChild(el('dt', null, k));
    const dd = el('dd');
    if (!list || list.length === 0) dd.appendChild(el('span', 'muted', '（空）'));
    for (const item of list) dd.appendChild(el('span', 'tag', item));
    tdl.appendChild(dd);
  };
  tk('需求', trace.requirements);
  tk('契约', trace.contracts);
  tk('测试', trace.tests);
  main.appendChild(tdl);

  // ── 写集 ────────────────────────────────────────────────────────────
  main.appendChild(el('h2', null, '写集'));
  const wdiv = el('div');
  for (const w of (d.writes || [])) wdiv.appendChild(el('span', 'tag', w));
  if ((d.writes || []).length === 0) wdiv.appendChild(el('span', 'muted', '（空）'));
  main.appendChild(wdiv);

  // ── 事件 ────────────────────────────────────────────────────────────
  main.appendChild(el('h2', null, '事件'));
  try {
    const events = await apiGet('/api/slices/' + encodeURIComponent(id) + '/events?limit=100');
    main.appendChild(table(
      ['时间', '类型', '操作者'],
      events.map(function (e) {
        return { cells: [new Date(e.ts).toLocaleString(), e.type, e.actor] };
      })
    ));
  } catch (err) {
    main.appendChild(el('p', 'muted', '事件加载失败：' + err.message));
  }
}

async function doApprove(sliceId, btn) {
  btn.disabled = true;
  btn.textContent = '签字中…';

  // 先找这条切片的 pending 签字请求
  const reqs = await apiGet('/api/sign-requests?status=pending');
  const req = reqs.find(function (r) { return r.sliceId === sliceId; });
  if (!req) {
    main.appendChild(el('p', 'notice bad', '找不到这条切片的待签字请求。'));
    btn.disabled = false;
    btn.textContent = '确认签字';
    return;
  }

  const res = await apiPost('/api/sign-requests/' + encodeURIComponent(req.id) + '/approve', {});
  if (res.ok && res.body && res.body.ok) {
    // 提示必须在视图切换**之后**追加 —— 切换会 clear(main)，
    // 追加在前面的话提示会被一起清掉，人点了按钮却什么都没看到
    // （实测：签字成功了，但「已签字」的提示一闪就没）。
    //
    // 用一个**独立的横幅容器**放提示，而不是插进主区域 ——
    // 主区域会被轮询刷新清空，横幅不会。这样提示至少活过一次轮询。
    await render('signs');
    showBanner('notice ok', '✅ 已签字。');
    showBanner('notice', res.body.nextStep);
    return;
  }
  const msg = (res.body && (res.body.error || res.body.reason)) || ('HTTP ' + res.status);
  showBanner('notice bad', '签字被拒绝：' + msg);
  btn.disabled = false;
  btn.textContent = '确认签字';
}

/**
 * 在主区域**上方**追加一条横幅。
 *
 * 为什么单独一个容器而不是插进主区域：
 * 主区域每 5 秒被轮询刷新清空一次 —— 插进去的提示活不过一轮。
 * 横幅容器在主区域外面，轮询碰不到它。
 *
 * 为什么是**追加**而不是「先清空再放」：
 * 一次签字要显示两条（已签字 + 签字不等于合并），
 * 清空式的写法会让后一条把前一条冲掉 —— 实测只剩最后一条。
 */
function showBanner(className, text) {
  const banner = document.getElementById('banner');
  banner.appendChild(el('p', className, text));
}

/** 清空横幅 —— 用户主动切换视图时调用（轮询刷新不清，否则提示活不过一轮）。 */
function clearBanner() {
  clear(document.getElementById('banner'));
}

// ── 路由与轮询 ──────────────────────────────────────────────────────────

const VIEWS = {
  overview: viewOverview,
  slices: viewSlices,
  signs: viewSigns,
  events: viewEvents
};

async function render(view) {
  currentView = view;
  // 回到列表视图 —— 详情页的状态不再成立
  inDetail = false;
  // 用户主动切换视图 → 旧提示过期，清掉。
  // （轮询刷新走 refreshSilently，不经过这里 —— 提示要活过轮询。）
  clearBanner();
  for (const b of document.querySelectorAll('nav button')) {
    b.className = b.getAttribute('data-view') === view ? 'active' : '';
  }
  clear(main);
  main.appendChild(el('p', 'muted', '加载中…'));
  try {
    await VIEWS[view](main);
  } catch (err) {
    clear(main);
    main.appendChild(el('p', 'notice bad', '加载失败：' + err.message));
  }
  await refreshSummary();
}

/**
 * 轮询用的刷新 —— **不清空主区域**。
 *
 * 为什么不用 render()：render() 会先 clear(main) 再放「加载中…」，
 * 于是每 5 秒页面塌陷成一行字再重建 —— 表格行会跳、滚动位置会丢。
 * （实测：MutationObserver 抓到每 5 秒一次「加载中」闪现。）
 *
 * 这里改成：先把新内容构建到**离屏容器**里，成功了再整体替换。
 * 失败就保留旧内容 —— 一次网络抖动不该把屏幕清空。
 */
async function refreshSilently(view) {
  const holder = document.createElement('div');
  try {
    await VIEWS[view](holder);
  } catch (err) {
    // 渲染失败 —— 保留屏幕上原有的内容，别把人正在看的东西弄没
    return;
  }
  clear(main);
  while (holder.firstChild) main.appendChild(holder.firstChild);
  await refreshSummary();
}

async function refreshSummary() {
  try {
    const s = await apiGet('/api/summary');
    summaryLine.textContent = s.totalSlices + ' 切片 · ' + s.pendingSignCount + ' 待签字 · ' + s.stalledCount + ' 停机';
  } catch (err) { /* 概况拿不到不影响主视图 */ }
}

for (const b of document.querySelectorAll('nav button')) {
  b.addEventListener('click', function () { render(b.getAttribute('data-view')); });
}

render('overview');

// 轮询（不是 SSE —— ADR-072 §6：服务端不留连接状态）
pollTimer = setInterval(function () {
  // 停在切片详情页时不轮询 —— 免得把人正在看的内容刷掉
  if (inDetail) return;
  refreshSilently(currentView);
}, 5000);
`;
}
