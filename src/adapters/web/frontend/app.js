
'use strict';

const TOKEN = window.__ZELTO_TOKEN__;
const main = document.getElementById('main');
const summaryLine = document.getElementById('summary-line');
const projectName = document.getElementById('project-name');
const projectRoot = document.getElementById('project-root');
const refreshLine = document.getElementById('refresh-line');
// 连接状态条 —— **与动作横幅分开**（见下方 noteDisconnected）。
// 分开的原因：动作横幅是「追加」语义（一次签字要显示两条），
// 连接状态是「独占」语义（一条状态，反复更新）。
// 混在一个容器里，连接提示的 textContent 赋值会把动作横幅冲掉。
const conn = document.getElementById('conn');
// 出过错的提示 —— **独立**于 conn（连接状态）。
// 两件事必须分开：conn 说「服务没了，该重启」，
// crashLine 说「服务还在，但出过错，数据可能不新鲜」。
const crashLine = document.getElementById('crash-line');
let currentView = 'overview';
// ── ADR-112：当前详情页看的是哪个「根」上的那片 ──────────────────────
//
// 同一个 id 可能同时存在于仓库根和版本目录里（基线切片实测 4 份）。
// 详情页、事件、审计、签字、门禁……必须**都落在同一个根**上 ——
// 否则「详情里说的」和「列表里看的」不是同一份事实。
// 路由凭据就是列表行上的 scope/label，不靠 id 去猜（ADR-112 决策三）。
let currentLocation = { scope: 'root', label: null };

/** 把 scope/label 拼成查询串 / 请求体里那两项（不传时返回空）。 */
function locQuery(loc) {
  if (!loc || !loc.scope) return '';
  var q = '?scope=' + encodeURIComponent(loc.scope);
  if (loc.label) q += '&label=' + encodeURIComponent(loc.label);
  return q;
}
function locBody(loc) {
  if (!loc || !loc.scope) return {};
  return { scope: loc.scope, label: loc.label || null };
}

/**
 * 根的人类可读名 —— 「仓库根」或「版本目录 v3」。
 *
 * 版本目录的名字必须出现在列表上：它回答的是「这片在哪个目录里等人」，
 * 而签字、门禁、开跑都得去那个目录（或经驾驶舱路由过去）。
 */
function rootName(scope, label) {
  if (scope === 'version') return '版本目录 ' + (label || '?');
  return '仓库根';
}
// 当前是否停在**切片详情页**。
//
// 为什么单独一个变量，而不是看 currentView：
// 详情页是从总览/切片列表点进去的 —— 那时 currentView 仍然是 'overview'，
// 靠它判断「在不在详情页」会判错，于是轮询把详情页整个换掉
// （实测：进详情后 4 秒被刷回总览，人正在看的东西被抢走）。
let inDetail = false;
let pollTimer = null;

// ── 轮询在飞标记 ────────────────────────────────────────────────────────
//
// 病灶（实测本仓库 2026-11-27，机器满载时更明显）：
// 轮询是 `setInterval(…, 5000)`，而**每一轮要等 3 个请求**
// （`/api/summary` + `/api/plan-coverage` + `/api/pending-actions`），
// 慢的一轮能跑十几秒。于是**新的一轮在旧的还没结束时又发起了** ——
// 请求越堆越多，服务端越堵，人看到的页面越旧。
//
// 实测：一次首屏加载期间 `/api/summary` 被发了 **4 次**，
// 30 秒稳态里 `/api/summary` 发了 **8 次**（5 秒一轮 = 6 次，
// 多出来的就是重叠的那些）。
//
// 这不是「刷新勤一点」，是**自我拥塞**：每一轮都比上一轮更堵，
// 于是永远追不上。慢的那个不是 git，是**自己叠自己**。
//
// 修法：上一轮没跑完就不发起新一轮（**跳过**，不是排队 ——
// 排队会让延迟越积越长）。
//
// 为什么不用「等上一轮结束再计时 5 秒」：那会让空闲时也慢半拍。
// 「跳过」在空闲时行为完全不变（上一轮早就结束了），
// 只在堵的时候止住雪崩。
let pollInFlight = false;

// ── 改动段的展示限额 ────────────────────────────────────────────────────
//
// 一次改动动到几百个文件是常事。全渲染出来会把总览页撑爆 ——
// 而驾驶舱是**总览**，人在这儿要回答的是「这个改动该不该签」，
// 不是逐行读 diff。
//
// 与 CLI `zelto sign --review` 同一套限额思路（ADR-070 §5.3）：
// 给前 N 个 + 一行「还有 M 个」。
const DIFF_FILE_BUDGET = 20;

// 当前详情页看的切片 id —— 「看全部」那行提示要指名道姓。
let currentSliceId = null;

// ── HTTP ───────────────────────────────────────────────────────────────

/**
 * 把 fetch 的底层异常翻译成人能直接行动的话。
 *
 * 为什么必须翻译：fetch 失败时抛的是 TypeError: Failed to fetch ——
 * 这句话对人**毫无帮助**。人看到它只知道「失败了」，
 * 不知道是「服务器停了」还是「网络断了」还是「我地址打错了」。
 * 实际排查时最容易踩的坑恰恰是：
 * **浏览器还开着上一个会话的页面，但那个服务早就退了**
 * （服务是前台进程，Ctrl+C 就停；标签页却留在那儿）。
 * 这时人看到的是一句没有指向的「Failed to fetch」，
 * 得自己想到「哦那个服务可能已经关了」。
 *
 * 所以这里把最常见的两种区分开：
 * - TypeError（fetch 本身抛的）→ 连接根本建立不起来
 *   → 明确告诉人「服务可能已经停了，去终端重新跑 zelto web」
 * - 其它异常（HTTP 层的）→ 保留原话，那是服务端给的正经错误
 */
function friendlyError(err) {
  if (err instanceof TypeError) {
    return '连不上 zelto 服务（' + err.message + '）。' +
      '多半是服务已经停了 —— 回到终端重新跑 zelto web，然后刷新本页。';
  }
  return err && err.message ? err.message : String(err);
}

/**
 * 标记「这是连接层面的失败」。
 *
 * 为什么需要标记而不是靠 instanceof TypeError 判断：
 * apiGet 会把 fetch 的 TypeError **包装**成普通 Error 再抛，
 * 一路传到 UI 时早就不是 TypeError 了 —— 判断依据必须跟着错误走。
 *
 * 用一个自定义属性而不是子类：UI 侧的判断只需要一个布尔，
 * 子类会让人误以为可以在上面 catch 出更精确的类型。
 */
function markConnectionError(err) {
  err.isConnectionError = true;
  return err;
}

function isConnectionError(err) {
  return !!(err && err.isConnectionError);
}

async function apiGet(path) {
  let res;
  try {
    res = await fetch(path, { headers: { 'Accept': 'application/json' } });
  } catch (err) {
    // fetch 连不上时抛 TypeError —— 先翻译再抛，别把裸异常漏给 UI
    throw markConnectionError(new Error(friendlyError(err)));
  }
  const body = await res.json().catch(function () { return { error: '响应不是 JSON' }; });
  if (!res.ok) throw new Error(body.error || ('HTTP ' + res.status));
  return body;
}

async function apiPost(path, payload) {
  let res;
  try {
    res = await fetch(path, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Zelto-Token': TOKEN
      },
      body: JSON.stringify(payload || {})
    });
  } catch (err) {
    throw markConnectionError(new Error(friendlyError(err)));
  }
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

/**
 * 把一段文本复制到剪贴板。
 *
 * 为什么用 `navigator.clipboard` 而不是自己写 `document.execCommand('copy')`：
 * 前者是标准 API（且剪贴板写权限要**用户手势**才给 —— 点击正好是手势）。
 * 后者在现代浏览器里被废弃，且要临时造一个 textarea 来兜底。
 *
 * 拿不到剪贴板权限时**不静默失败**：给个提示，
 * 否则人点了没反应，以为自己看漏了。
 */
function copyText(text) {
  const value = String(text == null ? '' : text);
  if (!value) return;
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(value).then(function () {
      flashHint('已复制：' + value);
    }).catch(function () {
      flashHint('复制失败 —— 请手动选中命令文本复制');
    });
    return;
  }
  flashHint('复制失败 —— 请手动选中命令文本复制');
}

/**
 * 一个「值」可以是文本，也可以是一个已经建好的 DOM 节点。
 *
 * 为什么需要它：el(tag, cls, text) 只收文本 —— 传节点进去会被
 * String(text) 变成 "[object HTMLSpanElement]"。
 * （2026-11-19 实测：预算页的「状态」、详情页的活性徽标真的这么显示过。）
 *
 * 判据是 nodeType 而不是 instanceof Node —— 后者在假 DOM / 跨窗口
 * 场景下不可靠。数字 0、空串仍然照常当文本。
 */
function setValue(parent, value) {
  if (value && typeof value === 'object' && typeof value.nodeType === 'number') {
    parent.appendChild(value);
  } else {
    parent.appendChild(el('span', null, value));
  }
}

/**
 * 造一张表格。
 *
 * ── 窄屏适配（ADR-109 决策四）──────────────────────────────────────
 *
 * 每个 `td` 挂一个 `data-label`（值 = 对应列名）——
 * 窄屏下表格整体转成**卡片**（CSS `display: block`），
 * 列名靠 `td::before { content: attr(data-label) }` 显示出来。
 *
 * **为什么用 CSS 断点而不是渲染两套 DOM**：
 * `table()` 是**唯一**的表格构造入口，驾驶舱 13 处表格全由它生成 ——
 * 所以一个断点就能覆盖全部。而两套 DOM 会让「桌面版与手机版内容不一致」
 * 成为可能（改了一处忘了另一处）。CSS 断点是**同一份 DOM 的两种排版**。
 *
 * **为什么用 data 属性而不是改可见结构**：
 * 不改 DOM 结构 = 不改 XSS 防线（前端只用 textContent）、
 * 不改事件流契约、不改 API 契约。
 *
 * ── 键盘可达（2026-11-28 实测补齐）──────────────────────────────────
 *
 * 实测：驾驶舱列表页有 **154 个可点击行**，但一个都没有 `tabindex`、
 * 一个都没有 `role` —— 也就是说**键盘用户和读屏用户完全进不去**。
 *
 * 驾驶舱的主交互恰恰是键盘（签字 / 拒签 / 拉闸 / 回答提问，
 * 全是「Tab 到某个按钮 → 回车」）。行不可聚焦 = 列表页对键盘用户
 * 只是一堆静态文字。
 *
 * ── 2026-11-28 修正：不要在 `<tr>` 上挂 `role="button"` ──────────────
 *
 * 第一版修法是「`tabindex="0"` + `role="button"` 挂在 `<tr>` 上」。
 * 实测**这是错的，而且错得很隐蔽**：
 *
 * `role="button"` 会**顶掉** `<tr>` 原生的 `row` 角色。
 * 无障碍树实测（CDP `Accessibility.getFullAXTree`）：
 *   改动前：row=6,  cell=15,   columnheader=23,  table=3
 *   改动后：row=6,  cell=15,   button=164,        table=3
 * 154 个可点击行全部变成了「按钮」，而表格的**行/单元格结构几乎消失**
 * （cell 只剩 15 个 —— 读屏软件再也没法按行按列浏览表格）。
 *
 * 也就是说：第一版修法把「键盘用户进不去」换成了
 * 「**读屏用户没法浏览表格**」—— 一个换另一个，没修好。
 *
 * 正确做法（W3C 的标准建议）：**在第一格里放一个真 `<button>`**。
 *   - 原生按钮自带焦点、Enter/Space 触发、role=button ——
 *     不用手写任何键盘语义
 *   - `<tr>` 保持原生 `row` 角色 → 表格结构完好，读屏可按行按列浏览
 *   - 整行仍然可点（鼠标用户的肌肉记忆不丢）
 *
 * 为什么放**第一格**：第一格是「标识列」（切片 id / 版本号 / 路径），
 * 它本来就是这一行唯一需要「点进去」的东西 ——
 * 语义上与 W3C 建议一致，也符合「每行一个主链接」的表格惯例。
 */
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
      // 整行可点（鼠标）。但**第一格里的真按钮**自己处理点击 ——
      // 否则行处理器与按钮处理器会**各触发一次**（点一下打开两次）。
      tr.addEventListener('click', function (ev) {
        if (ev.target && ev.target.closest && ev.target.closest('.row-open')) return;
        r.onClick(ev);
      });
      // 注意：`<tr>` 上**不挂** tabindex / role / keydown ——
      // 键盘语义由第一格里的真按钮承担（见上面的说明）。
    }
    r.cells.forEach(function (cell, i) {
      const td = el('td');
      // 列名挂进 data-label —— 窄屏转卡片时用 ::before 显示
      if (headers[i] !== undefined) td.setAttribute('data-label', String(headers[i]));
      if (cell instanceof Node) td.appendChild(cell);
      else td.textContent = cell === null || cell === undefined ? '' : String(cell);
      // 第一格 → 包一个真按钮（键盘可达 + 读屏可辨）。
      // 按钮里放原本的单元格内容 —— 不改内容，只改「怎么触达它」。
      if (r.onClick && i === 0) {
        const btn = el('button', 'row-open');
        btn.type = 'button';
        if (td.firstChild) {
          while (td.firstChild) btn.appendChild(td.firstChild);
        } else {
          btn.textContent = td.textContent;
        }
        if (!btn.textContent.trim() && !btn.firstChild) {
          // 标识列是空的 —— 给个能念出来的名字
          btn.textContent = '打开详情';
        }
        btn.addEventListener('click', function (ev) {
          ev.stopPropagation();
          r.onClick(ev);
        });
        td.appendChild(btn);
      }
      tr.appendChild(td);
    });
    tbody.appendChild(tr);
  }
  t.appendChild(tbody);
  return t;
}

/**
 * 状态徽标。
 *
 * 第二参 `slice` 可选：传进来时，若这片**停机过**（`stalled`）就在状态
 * 徽标后追加一个「⚠ 停机(分类)」标记。
 *
 * 为什么必须标：停机（stall）与状态（state）是**两件事** ——
 * `run.aborted` 之后切片回到 `frozen`（可重跑），但 `stall` 仍记着
 * 「上次跑挂了」这一事实（ADR-047）。只显示 `frozen` 而不说停机，
 * 人会以为「这片还没开始跑」，实际是「跑了、挂了、可重跑」。
 * 实测（2026-11-26，v1-rtcp-processor-collaborator）：agent 因未登录
 * exit 1，列表行只显示 `frozen` + 活性「—」，看不出它跑挂过。
 */
function stateBadge(state, slice) {
  var wrap = el('span');
  wrap.appendChild(el('span', 'badge state-' + state, state));
  if (slice && slice.stalled) {
    var s = el('span', 'badge live-stale', '⚠ 停机');
    s.title = '上次运行被停机（' + (slice.stallClass || '原因未分类') + '）—— 可重跑 / 续跑，不是「还没跑」';
    wrap.appendChild(document.createTextNode(' '));
    wrap.appendChild(s);
  }
  return wrap;
}

/**
 * 分支证据徽标（ADR-114）—— 「完成」是在盘上完成，还是在版本分支里完成。
 *
 * 为什么必须有这一列：实测 nimrtc-v14 的 v3 目录 15 片全 completed，
 * 而 `version/v3` 分支只跟踪了 3 片基线 —— 另外 12 片的「完成」
 * 只存在于那台机器的磁盘上（`.zelto/` 在 .gitignore 里）。
 * 只显示盘上状态，页面就在说一句**没有分支依据**的话。
 *
 * 三态（与 API 同口径）：
 * - true：状态文件已进所属根的 git 跟踪（提交里的 state 一并给出）
 * - false：只在盘上 —— 换台机器就查不到
 * - null：拿不到 git 证据（目录不是 git 仓库）—— 说「未知」，不说「没有」
 */
function branchCell(s) {
  if (s.onBranch === true) {
    var b = el('span', 'badge live-active', '✔ 在分支');
    if (s.committedState && s.committedState !== s.state) {
      b.appendChild(el('span', 'muted small', ' (提交里: ' + s.committedState + ')'));
    }
    return b;
  }
  if (s.onBranch === false) {
    var b2 = el('span', 'badge live-stale', '⚠ 仅在盘上');
    b2.title = '状态文件没有提交进所属分支（.zelto/ 在 .gitignore 里）—— 换台机器或换 worktree 就查不到';
    return b2;
  }
  return el('span', 'muted', '未知');
}

/**
 * 产物证据徽标（ADR-126）—— 这一片的**产物**在所属版本分支上吗。
 *
 * 与「分支证据」（ADR-114）是两件事：
 *   - 分支证据：切片**状态文件**是否已提交进所属分支
 *     （`.zelto/` 在 .gitignore 里 → 这一项通常恒为「仅在盘上」）；
 *   - 产物证据：这一片有没有在所属版本分支上留下过 `Refs-Slice:` 提交
 *     —— 那才是「这版做完没有」的**可查证凭据**。
 *
 * 三态（与 API 同口径）：
 * - true：分支上有产物提交（给出短哈希与标题）
 * - false：查不到 —— 可能合到了别的分支（归属错位），也可能还没合
 * - null：拿不到证据（不是 git 仓库 / 分支不存在）—— 说「未知」，不说「没有」
 */
function artifactCell(planIndex, id) {
  var p = planIndex && planIndex[id];
  if (!p) return el('span', 'muted', '—');
  if (p.artifactOnBranch === true) {
    var b = el('span', 'badge live-active', '✔ 有产物');
    if (p.artifactCommit) {
      b.title = (p.artifactSubject ? p.artifactSubject + '\n' : '') +
        '提交 ' + p.artifactCommit + '（分支 ' + (p.versionBranch || '?') + '）';
    }
    return b;
  }
  if (p.artifactOnBranch === false) {
    // ADR-126r2：栈式版本里，本版自己没有这一片的 trailer 提交，
    // 但它随祖先版本进了本版 —— 那不是「查不到」，是「在祖先上」。
    if (p.artifactOnAncestor === true) {
      var b3 = el('span', 'badge live-active', '✔ 随祖先版本并入');
      b3.title = '本版分支上没有这一片自己的 Refs-Slice 提交，但它在**祖先版本分支**上'
        + (p.artifactAncestorCommit ? '（提交 ' + p.artifactAncestorCommit + '）' : '')
        + ' —— 产物已随栈进入本版';
      return b3;
    }
    var b2 = el('span', 'badge live-stale', '⚠ 分支上查不到');
    b2.title = '所属版本分支（' + (p.versionBranch || '?') + '）和它的祖先分支上都没有这一片的 Refs-Slice 提交'
      + ' —— 可能合到了别的分支（归属错位），也可能还没合';
    return b2;
  }
  return el('span', 'muted', '未知');
}

/**
 * 一个切片的「计划对照」单元格（ADR-114）—— 计划里的状态 vs 盘上。
 *
 * 数据来自 `/api/plan-coverage`（按 id 索引后递进来）；不在任何计划里时
 * 如实显示「不在计划」—— 不在计划里本身是事实，不是错误。
 */
function planCell(planIndex, id) {
  var p = planIndex && planIndex[id];
  if (!p) return el('span', 'muted', '不在计划');
  var txt = (p.version || '?') + ' · 计划 ' + (p.plannedState || '?');
  if (p.status && p.status !== 'planned') txt += '（版本 ' + p.status + '）';
  return el('span', 'small', txt);
}

/**
 * 被动活性徽标（D-30）：running 到底活没活，一眼看出来。
 * 非 running 片没有活性概念 —— 显示 muted 的「—」，别误导人。
 */
function liveBadge(s) {
  if (s.state !== 'running') return el('span', 'muted', '—');
  const st = s.liveness || 'unknown';
  if (st === 'active') return el('span', 'badge live-active', '🔄 active');
  if (st === 'stale') return el('span', 'badge live-stale', '⚠️ stale');
  if (st === 'dead') return el('span', 'badge live-dead', '💀 dead');
  return el('span', 'badge live-finished', s.state);
}

/** idle 毫秒说成人话 —— 服务端给数字，前端只做展示（不判定）。 */
function formatIdleMs(ms) {
  if (typeof ms !== 'number' || !isFinite(ms) || ms < 0) return '—';
  const sec = Math.floor(ms / 1000);
  if (sec < 60) return sec + ' 秒';
  const min = Math.floor(sec / 60);
  if (min < 60) return min + ' 分 ' + (sec % 60) + ' 秒';
  return Math.floor(min / 60) + ' 小时 ' + (min % 60) + ' 分';
}

/**
 * 实时进度 —— 「在跑多久了 · 最后一条输出」。
 *
 * 解决的问题：一个 active 的切片，如果界面只显示「最后活动 3 秒前」，
 * 人盯几分钟看不到任何变化，就会怀疑它卡死了（本可避免的焦虑）。
 * 页面上必须有一个**每轮都在变**的东西：已运行时长在走秒，
 * 最后一条输出在推进 —— 那才是「它还活着」的直接证据。
 *
 * 数据全部来自服务端（进度行是 agent 的真实输出），前端不猜。
 */
function progressCell(s) {
  if (s.state !== 'running') return el('span', 'muted', '—');
  const box = el('div');
  const head = el('div', 'small');
  if (typeof s.elapsedMs === 'number') {
    head.appendChild(el('span', null, '已跑 ' + formatIdleMs(s.elapsedMs)));
  }
  if (s.progressAt) {
    head.appendChild(el('span', 'muted', (head.firstChild ? ' · ' : '') + '更新于 ' + new Date(s.progressAt).toLocaleTimeString()));
  }
  // 输出静默时长（ADR-074）：agent 活着但很久没吐字 —— 如实说，不留空白让人猜。
  // 不是「死了」（死了有活性徽标说），而是「在跑，只是没产出」。
  if (typeof s.elapsedIdleMs === 'number' && s.elapsedIdleMs >= 60000) {
    head.appendChild(el('span', 'muted', ' · ' + formatIdleMs(s.elapsedIdleMs) + '无输出'));
  }
  if (!head.firstChild) head.appendChild(el('span', 'muted', '等待 agent 输出…'));
  box.appendChild(head);
  if (s.progressLine) {
    box.appendChild(el('div', 'progress-line', s.progressLine));
  } else if (s.state === 'running' && s.liveness !== 'dead') {
    // 没输出 ≠ 没在跑：claude --output-format json 下 agent 只在结束时吐一次 stdout。
    // 说清这一点，人才不会把「安静的进度行」当成「死掉」。
    const hint = s.liveness === 'stale'
      ? '很久没有动静 —— 看一眼 zelto status'
      : 'agent 运行中（当前模式下输出会在结束时一次性给出）';
    box.appendChild(el('div', 'progress-line muted', hint));
  }
  return box;
}

// ── 视图 ───────────────────────────────────────────────────────────────

/**
 * 把 `/api/plan-coverage` 的结果摊平成「切片 id → 计划位置」的索引（ADR-114）。
 *
 * 同一 id 出现在多份计划里时（少见：仓库根与版本目录各有一份计划），
 * 取**第一份**（服务端顺序：仓库根在前）—— 这是展示，不参与判定；
 * 真正消歧归 CLI（`resolveSliceOwnership` 命中多个会明确报错）。
 */
function buildPlanIndex(coverage) {
  var idx = {};
  var plans = (coverage && coverage.plans) || [];
  for (var i = 0; i < plans.length; i++) {
    var plan = plans[i];
    for (var j = 0; j < (plan.versions || []).length; j++) {
      var v = plan.versions[j];
      for (var k = 0; k < (v.slices || []).length; k++) {
        var row = v.slices[k];
        if (idx[row.id]) continue;
        idx[row.id] = {
          planId: plan.id,
          version: v.version,
          versionStatus: v.status,
          plannedState: row.plannedState,
          onDisk: row.onDisk,
          actualState: row.actualState,
          onBranch: row.onBranch,
          // ADR-126：产物证据（所属版本分支上有没有 Refs-Slice 提交）
          artifactOnBranch: row.artifactOnBranch,
          artifactCommit: row.artifactCommit,
          artifactSubject: row.artifactSubject,
          artifactOnAncestor: row.artifactOnAncestor,
          artifactAncestorCommit: row.artifactAncestorCommit,
          versionBranch: v.branch
        };
      }
    }
  }
  return idx;
}

/**
 * 计划对照表（ADR-114）—— 「这一版还差什么」的三个口径并排。
 *
 * 为什么每版一行而不是把切片全铺开：版本层面的人问的是「这一版推得怎样」，
 * 展开到片会让页面淹没；切片级的「计划 vs 盘上」在切片列表的「计划」列里。
 *
 * 计数口径（与 API 同口径，**不做合成**）：
 *   计划 N 片 · 盘上 M 片 · 盘上完成 C 片 · 分支上有产物 A 片
 *
 * **为什么「分支上有产物」取代了 ADR-114 那列「分支上完成」**（ADR-126）：
 * ADR-114 问的是「切片**状态文件**是否已提交进所属分支」——
 * 但 `.zelto/` 整体在 `.gitignore` 里，状态文件**永远**不进版本分支，
 * 于是那列恒为 0。它不仅没有信息量，还给出误导性结论：
 * 「分支上完成 0 / 盘上完成 10」读起来像「这版什么都没做完」，
 * 而真相是「这版的产物**就在**分支上，只是状态文件没进 git」。
 *
 * 产物证据问的是另一件事：**这个切片 id 有没有在所属版本的分支上
 * 留下过 `Refs-Slice:` 标记的提交** —— 那才是「这版做完没有」的
 * 可查证凭据，且不依赖 `.zelto/` 是否进 git。
 *
 * ADR-114 那列**保留**（叫「状态文件进分支」）—— 它仍是事实，
 * 只是它现在诚实地说自己是 0，而不是冒充「完成度」。
 */
function renderPlanCoverage(target, coverage) {
  var plans = (coverage && coverage.plans) || [];
  if (plans.length === 0) return;

  target.appendChild(el('h2', null, '版本计划（' + plans.length + ' 份）'));
  target.appendChild(el('p', 'muted small',
    '计划 vs 盘上 vs 分支：分开数、不合成。计划里的状态来自 .zelto/versions，' +
    '盘上是切片状态文件，「分支上有产物」= 该片在所属版本分支上留过 ' +
    'Refs-Slice 标记的提交（ADR-126）。'));

  for (var i = 0; i < plans.length; i++) {
    var plan = plans[i];
    var where = plan.scope === 'version' ? '（版本目录 ' + plan.label + '）' : '（仓库根）';
    target.appendChild(el('h3', null, plan.title + ' ' + where + ' · ' + plan.id));

    var rows = (plan.versions || []).map(function (v) {
      var c = v.counts || {};
      var gap = (c.completed || 0) - (c.artifactOnBranch || 0) - (c.artifactOnAncestor || 0);
      var cells = [
        v.version,
        String(v.status || '?'),
        String(c.planned || 0),
        String(c.onDisk || 0),
        String(c.completed || 0),
        artifactCountCell(c.artifactOnBranch || 0, c.artifactOnAncestor || 0, gap),
        String(c.onBranch || 0),
        (v.dependsOn || []).join(', ') || '—',
        v.branch || '—'
      ];
      return { cells: cells };
    });
    target.appendChild(table(
      ['版本', '版本状态', '计划片数', '盘上有片', '盘上完成', '本版分支有产物', '随祖先版本并入', '状态文件进分支', '依赖', '分支'],
      rows
    ));
  }
}

/**
 * 「分支上有产物」单元格 —— 本版分支命中 / 随祖先版本并入 / 盘上完成却两边都查不到。
 *
 * 为什么拆两列（ADR-126r2）：栈式版本（v2 从 v1 切出）里，本版**没有**
 * 祖先片的 trailer 提交 —— 只报「本版 0 片」会把「这版什么都没做」当成结论。
 * 实测 nimrtc-v14 v3：本版命中 1 片，祖先分支上另有 20 片。
 *
 * 两边都查不到**不是**坏事：产物可能在别的版本分支上（归属错位），
 * 或者这版还没合。这一格只说事实，不下结论（ADR-114 决策二的精神）。
 */
function artifactCountCell(own, anc, gap) {
  var box = el('span', null, String(own));
  if (anc > 0) {
    var a = el('span', 'badge live-active', '+ ' + anc + ' 随祖先版本');
    a.title = '这些片的产物在祖先版本分支上（栈式版本的常态）—— 已随祖先进入本版';
    box.appendChild(document.createTextNode(' '));
    box.appendChild(a);
  }
  if (gap > 0) {
    var w = el('span', 'badge live-stale', gap + ' 片两边都查不到');
    w.title = '这些片在盘上是 completed，但所属版本分支与它的祖先分支上都没有它们的 Refs-Slice 提交'
      + '—— 可能合到了别的分支（归属错位），也可能还没合。逐片看产物证据列。';
    box.appendChild(document.createTextNode(' '));
    box.appendChild(w);
  }
  return box;
}

/**
 * 「眼下该做什么」—— 总览页的第一块。
 *
 * **判定不在前端**：服务端给的是 `core/pending/` 排好序的清单
 * （与 CLI 的 `zelto next` / `zelto suggest` / `zelto dashboard` 同一份）。
 * 这里只渲染 —— 前端不重排、不自己判断「什么更急」。
 *
 * 为什么这么设计：
 *
 *   1. **一处结论**：以前驾驶舱首屏只有状态（在跑几片、待签几片），
 *      没有动作 —— 人看到「3 片待签」还得自己回想该敲哪条命令。
 *   2. **异常优先**：zelto 的北极星是无人值守完成率 —— 人来得越少越好，
 *      来了只看需要人管的事。清单按「越该人管越靠前」排，
 *      「正在顺利跑」排在最后（core/pending/types.ts 的优先级表）。
 *   3. **不编**：拿不到清单就整块不显示，不自己编一份出来。
 *
 * @param pending `/api/pending-actions` 的返回；null = 拿不到
 */
function renderNextActions(target, pending) {
  if (!pending || !Array.isArray(pending.items)) return;

  const items = pending.items;
  const block = el('div', 'next-block' + (pending.top ? ' top' : ''));

  if (items.length === 0) {
    // 「没事要做」是**好消息**，值得明说 —— 别让人对着空页面猜。
    block.appendChild(el('div', 'next-top', '眼下没有需要人管的事'));
    block.appendChild(el('p', 'next-why', 'agent 自己跑着；跑完会出现在这一页。'));
    target.appendChild(block);
    return;
  }

  // ── 大号提示：就这一件 ──
  const top = pending.top;
  if (top) {
    const line = el('div', 'next-top');
    line.appendChild(el('span', 'next-kind ' + top.kind, pendingKindLabel(top.kind)));
    line.appendChild(el('span', 'what', top.prepare || top.title));
    if (top.id) line.appendChild(el('span', 'who', top.id));
    block.appendChild(line);

    // 命令做成可点的 —— 人看完就该能开工，而不是抄一行命令。
    if (top.action) {
      const cmd = el('code', 'next-cmd', top.action);
      cmd.title = '点一下复制这条命令';
      cmd.addEventListener('click', function () { copyText(cmd.textContent); });
      block.appendChild(cmd);
    }
    if (top.reason) block.appendChild(el('p', 'next-why', top.reason));
  }

  // ── 其余待办 ──
  const rest = items.slice(1);
  if (rest.length > 0) {
    const list = el('div', 'next-list');
    for (const it of rest) {
      const row = el('div', 'next-item');
      row.appendChild(el('span', 'next-kind ' + it.kind, pendingKindLabel(it.kind)));
      row.appendChild(el('span', 'id', it.id || it.title));
      row.appendChild(el('span', 'prep', it.prepare || ''));
      if (it.action) {
        const cmd = el('code', 'next-cmd', it.action);
        cmd.title = '点一下复制这条命令';
        cmd.addEventListener('click', function () { copyText(cmd.textContent); });
        row.appendChild(cmd);
      }
      list.appendChild(row);
    }
    block.appendChild(list);
  }

  target.appendChild(block);

  // ── 其它根的待办（ADR-112）──
  //
  // 仓库根之外的版本目录各有各的待办 —— 不列出来，人不知道「那边也有活」。
  // 折叠成一行计数，点开才看 —— 别让它抢首屏的注意力。
  if (Array.isArray(pending.byRoot)) {
    const others = pending.byRoot.filter(function (r) {
      return r.scope !== 'root' && r.items && r.items.length > 0;
    });
    for (const r of others) {
      const details = el('details');
      details.appendChild(el('summary', 'muted small',
        '版本目录 ' + (r.label || '?') + '：还有 ' + r.items.length + ' 件待办'));
      const list = el('div', 'next-list');
      for (const it of r.items) {
        const row = el('div', 'next-item');
        row.appendChild(el('span', 'next-kind ' + it.kind, pendingKindLabel(it.kind)));
        row.appendChild(el('span', 'id', it.id || it.title));
        row.appendChild(el('span', 'prep', it.prepare || ''));
        list.appendChild(row);
      }
      details.appendChild(list);
      target.appendChild(details);
    }
  }
}

/** 待办类别的中文标签 —— 与 CLI 的 `PENDING_KIND_LABEL` 同一份事实。 */
function pendingKindLabel(kind) {
  const map = {
    stalled: '停机',
    draft: '草稿',
    rerun: '退回',
    sign: '待签',
    requestSign: '待发签',
    merge: '待合',
    version: '版本',
    autoResolved: '自愈过',
    sliceState: '未开始',
    longRunning: '长跑'
  };
  return map[kind] || kind;
}

/**
 * 改动段 —— 文件级清单（与 CLI `zelto sign --review` 同一份事实）。
 *
 * **为什么给文件而不只给数字**：
 * 「改了 3 个文件 +120 -10」回答不了「这个改动该不该签」；
 * 「哪些文件被改了」才回答得了（ADR-072 §5.2）。
 *
 * **为什么不给全文 diff**：
 * 驾驶舱是**总览**，不是代码评审器 —— 全文 diff 会把这一页撑爆，
 * 反而让人看不见其它该看的。人要看全文去终端 `zelto diff <id>`。
 *
 * @param diff `facts.diff`；null = 拿不到（整节不显示，不编）
 */
function renderDiffSection(target, diff) {
  if (!diff || typeof diff.filesChanged !== 'number') return;

  target.appendChild(el('h2', null,
    '改了什么（' + diff.filesChanged + ' 文件 · +' + diff.addedLines + ' -' + diff.deletedLines + '）'));

  if (diff.baseNote) {
    target.appendChild(el('p', 'muted small', '基准：' + diff.baseNote));
  }

  const files = diff.files || [];
  if (files.length === 0) {
    target.appendChild(el('p', 'muted',
      diff.filesChanged === 0
        ? '没有查到文件级改动。'
        : '查到 ' + diff.filesChanged + ' 个文件，但没有文件级明细。'));
    return;
  }

  // ── 只渲染前 N 个文件 ──────────────────────────────────────────────
  //
  // 一次改动动到几百个文件是常事（重构、批量搬迁）。全渲染出来
  // 这一页就撑爆了 —— 而驾驶舱是**总览**，人在这儿要回答的是
  // 「这个改动该不该签」，不是逐行读 diff。
  //
  // 与 CLI `zelto sign --review` 同一套限额思路（ADR-070 §5.3）：
  // **给前 N 个 + 一行「还有 M 个」**。
  //
  // 但**不能只有上限没有出口**：真要看全部（比如要逐个核对某个
  // 大重构动了哪些文件）时，人不该被迫切回终端 ——
  // 驾驶舱是给人看东西的地方，不是给人「只许看一半」的地方。
  //
  // 所以给一个「展开全部」按钮：点了就地渲染剩余的，
  // 再点收起回到封顶视图。
  //
  // 注意「展开」是**纯前端**行为 —— 文件清单已经在 payload 里了
  // （`facts.diff.files`），不需要再请求一次服务端
  // （服务端那份已经是全部，只是渲染时截了）。
  const budget = DIFF_FILE_BUDGET;

  const list = el('div', 'diff-list');
  target.appendChild(list);

  /** 渲染一批文件行（追加到 list）。 */
  const renderRows = function (items) {
    for (const f of items) {
      const row = el('div', 'diff-file');
      row.appendChild(el('span', 'diff-status ' + f.status, diffStatusLabel(f.status)));
      row.appendChild(el('code', 'diff-path', f.path));
      const delta = el('span', 'diff-delta');
      if (f.added) delta.appendChild(el('span', 'add', '+' + f.added));
      if (f.deleted) delta.appendChild(el('span', 'del', '-' + f.deleted));
      row.appendChild(delta);
      list.appendChild(row);
    }
  };

  let expanded = false;
  renderRows(files.slice(0, budget));

  if (files.length > budget) {
    // 文本与按钮**分成两个节点**。
    //
    // 为什么不能写成「一个 <p>，点的时候 note.textContent = '...'」：
    // 在真 DOM 里赋 `textContent` 会**替换掉所有子节点** ——
    // 按钮自己也被抹掉了，于是点第一次能展开、再点就没得可点了。
    // （这是那种「浏览器里一用就露馅、但代码读起来完全合理」的坑。）
    //
    // 所以：文本在 span 里改，按钮独立存在。
    const note = el('p', 'muted small');
    const noteText = el('span');
    const toggle = el('button', 'btn link', '展开全部');
    const countText = '还有 ' + (files.length - budget) + ' 个文件。';

    toggle.addEventListener('click', function () {
      if (expanded) {
        // 收起 —— 把超出封顶的行删掉，回到首屏友好的样子。
        const rows = list.querySelectorAll('.diff-file');
        for (let i = budget; i < rows.length; i++) rows[i].remove();
        expanded = false;
        toggle.textContent = '展开全部';
        noteText.textContent = countText + ' 想看全部：';
      } else {
        renderRows(files.slice(budget));
        expanded = true;
        toggle.textContent = '收起';
        noteText.textContent = '已展开全部 ' + files.length + ' 个文件。';
      }
    });

    noteText.textContent = countText + ' 想看全部：';
    note.appendChild(noteText);
    note.appendChild(toggle);
    note.appendChild(
      document.createTextNode(' 或终端跑 zelto diff ' + (currentSliceId || '<id>')),
    );
    target.appendChild(note);
  }
}

/** 改动类型 → 中文标签。 */
function diffStatusLabel(status) {
  const map = {
    added: '新增',
    modified: '修改',
    deleted: '删除',
    renamed: '改名',
    copied: '复制',
    untracked: '未跟踪',
    unknown: '未知'
  };
  return map[status] || status;
}

/**
 * 执行目录脉络（多工作区进展）—— 总览页的一节。
 *
 * 为什么要有它：ADR-112 只让人看见「仓库根 + 版本集成目录」这两种根；
 * 但同一个仓库在盘上常常还有**别的检出**——
 *
 *   - `.zelto/worktrees/<sliceId>/`：`zelto run` 建的切片执行目录规；
 *   - `git worktree list` 里那些**不是 zelto 建的**工作区
 *     （实测 nimrtc-v14：`D:/MyOpen/_wt_v14_code`、`D:/MyOpen/_wt_v14_docs`）。
 *
 * 看不见它们 = 人在那条工作区里做的事情，驾驶舱一个字也不会提。
 * 这一节只**摆事实**（种类 / 路径 / 分支 / HEAD / 它名下的切片），
 * 不判定「哪条好、哪条该收」。
 */
function renderWorktreeMap(target, map) {
  if (!map || !Array.isArray(map.entries) || map.entries.length === 0) return;
  const kindName = {
    root: '仓库根',
    version: '版本集成目录',
    slice: '切片执行目录',
    extra: '额外工作区'
  };
  target.appendChild(el('h2', null, '执行目录脉络（' + map.entries.length + '）'));
  target.appendChild(el('p', 'muted small',
    '同一个仓库在盘上有几份检出 —— 仓库根、版本集成目录（version/<v>）、' +
    '切片执行目录（slice/<id>，zelto run 建的）、以及 git 记录的额外工作区。' +
    '切片状态只从 .zelto 根读；执行目录里的是基线快照，不当状态用。'));
  target.appendChild(table(
    ['种类', '路径', '分支 / HEAD', '本目录状态', '本片位置'],
    map.entries.map(function (e) {
      const kindCell = el('span', 'badge', kindName[e.kind] || e.kind);
      const bh = el('span');
      if (e.branch) bh.appendChild(el('code', null, e.branch));
      else bh.appendChild(el('span', 'muted', e.head ? 'detached' : '未知'));
      if (e.head) bh.appendChild(el('span', 'muted small', ' @' + String(e.head).slice(0, 8)));
      // 「这条战线的活是否已在主干里」—— 只是 git 祖先关系（HEAD ⊆ 主干），
      // 不是版本交付状态。全列出来的时候 v1/v2/v3 早就合进主干，
      // 不标的话人会把「5 条版本战线」读成「5 个版本在并行」。
      if (e.kind === 'version') {
        if (e.mergedIntoTrunk === 'merged') {
          bh.appendChild(el('span', 'badge', ' 已并入主干'));
        } else if (e.mergedIntoTrunk === 'diverged') {
          // 中性徽标，不是告警色：版本分支比主干跑得快是常态（v3 delivered 时
          // 可能还领先主干几十个提交）。红字会让人读成「和 delivered 矛盾」。
          // 真正该警惕的是「有未合并提交**且**版本状态说已交付」—— 那种由
          // 版本状态单元格自己去对照，这里只摆 git 事实。
          const d = el('span', 'badge', ' 主干之外');
          d.title = '这条版本分支/HEAD 有主干还没有的提交（git 祖先关系）'
            + (e.version ? '；版本状态是 ' + e.version : '')
            + ' —— 只是 git 事实，不代表台账错了';
          bh.appendChild(d);
        }
      }
      const stateCell = el('span', 'muted small', e.hasZeltoState ? '有 .zelto 状态' : '无');
      const sliceCell = el('span');
      if (!e.slices || e.slices.length === 0) {
        sliceCell.textContent = '—';
      } else if (e.kind === 'slice') {
        const s = e.slices[0];
        sliceCell.appendChild(stateBadge(s.state, s));
        sliceCell.appendChild(el('span', null, ' ' + s.id));
        // 执行目录自己的 .zelto 只是基线快照 —— 状态借自它真正所在的根
        sliceCell.appendChild(el('span', 'muted small',
          '（状态取自' + rootName(s.scope, s.label) + '）'));
      } else {
        sliceCell.appendChild(el('span', null, e.slices.length + ' 片 · ' +
          e.slices.filter(function (s) { return s.state === 'completed'; }).length + ' 完成'));
        // 状态分布：一眼看出这条战线卡在哪一段（frozen = 待跑，running = 在跑）
        const dist = {};
        e.slices.forEach(function (s) { dist[s.state] = (dist[s.state] || 0) + 1; });
        const parts = Object.keys(dist).map(function (k) { return k + ' ' + dist[k]; });
        if (parts.length > 0) {
          const line = el('div', 'muted small', parts.join(' · '));
          sliceCell.appendChild(line);
        }
      }
      const row = {
        cells: [kindCell, el('code', null, e.dir), bh, stateCell, sliceCell]
      };
      if (e.slices && e.slices.length > 0) {
        row.onClick = function () {
          const s = e.slices[0];
          showSliceDetail(s.id, false, { scope: s.scope, label: s.label });
        };
      }
      return row;
    })
  ));
}

async function viewOverview(target) {
  // 三个请求**并发**发出去，不是串行等。
  //
  // 病灶（实测本仓库 2026-11-27）：原来是
  //   `await summary` → `await plan-coverage` → `await pending-actions`
  // 三段**首尾相接**。而三段各自都要重新读一遍 149 片的事件流、
  // 问一遍 git —— 于是首屏总耗时是**三段之和**。
  //
  // 实测那一轮：summary 3.2s + plan-coverage 42s + pending-actions 7s
  // = **52 秒白屏**。
  //
  // 改成并发后总耗时 = **最慢的那一个**，其余与之重叠。
  // 判据没变、返回的内容也没变 —— 只是不再一个接一个地等。
  //
  // 注意：`plan-coverage` 与 `pending-actions` 各自 catch ——
  // 拿不到就整节不显示（不编一份计划出来），不影响其它两块。
  const [s, coverage, pending] = await Promise.all([
    getSummary(false),
    apiGet('/api/plan-coverage').catch(function () { return null; }),
    apiGet('/api/pending-actions').catch(function () { return null; }),
  ]);
  clear(target);

  // ── 眼下该做什么（首屏第一块）─────────────────────────────────
  //
  // 为什么放最上面：驾驶舱首屏要回答的是「**现在该干什么**」，
  // 不是「工程长什么样」。状态（计数、成本）在那之后。
  //
  // 排序是服务端给的（core/pending/rank.ts）—— 与终端里 `zelto next`
  // 看到的完全一致。这里只渲染，不重排（重排 = 两处结论可能不同）。
  renderNextActions(target, pending);

  const cards = el('div', 'cards');
  const card = function (n, l) {
    const c = el('div', 'card');
    c.appendChild(el('div', 'n', n));
    c.appendChild(el('div', 'l', l));
    return c;
  };

  // ── 开发切片 / 基线切片（分开数）────────────────────────────────
  //
  // 为什么必须分开：基线切片描述**现状**（接管既有项目时登记的），
  // 不是待办的活。两者都可能是 completed，混在一个计数里就说谎。
  //
  // 实测（nimrtc-v14，2026-11-25）：8 片 completed 里 3 片是基线，
  // 那轮实际只开发了 5 片 —— 混着数的话人看到「8 个切片都完成了」。
  //
  // 「开发切片」这一组是**这轮做了多少**的诚实口径。
  // 状态分布也只列开发切片的 —— 否则 completed 里混着基线，读不出进度。
  const dev = s.development || { total: 0, byState: {}, completed: 0 };
  const base = s.baseline || { total: 0, ids: [] };

  cards.appendChild(card(dev.total, '开发切片'));
  cards.appendChild(card(s.pendingSignCount, '待签字'));
  cards.appendChild(card(s.stalledCount, '停机'));
  const states = Object.keys(dev.byState || {});
  for (const st of states) cards.appendChild(card(dev.byState[st], st));

  // 基线切片单列一张卡 —— 它是**上下文**，不是进度。
  // 数字旁带一句说明，让人知道这数字是什么、为什么单列。
  const baseCard = el('div', 'card');
  baseCard.appendChild(el('div', 'n', base.total));
  baseCard.appendChild(el('div', 'l', '基线切片'));
  baseCard.title = '描述现状、不改代码的切片（接管既有项目时登记）—— 不计入开发进度';
  cards.appendChild(baseCard);

  target.appendChild(cards);

  // ── 执行目录脉络（多工作区进展）─────────────────────────────────
  //
  // 「同一个仓库在盘上有几份检出、每份各在哪、各承担什么」——
  // 之前列表里只有「仓库根 / 版本目录」，人在 D:/_wt_v14_code 这种
  // 手工并行工作区里签过的字，驾驶舱一个字也不会提。
  // 拿不到就整节不显示（不编）。
  var worktreeMap = null;
  try {
    worktreeMap = await apiGet('/api/worktrees');
  } catch (err) {
    worktreeMap = null;
  }
  renderWorktreeMap(target, worktreeMap);

  // ── 扫了哪些根（ADR-112）─────────────────────────────────────────
  //
  // 「看不见的根」本身就是信息：版本目录里有一整套独立状态（切片、
  // 签字请求、事件），驾驶舱不知道它存在就无从去那里签字。
  // 这里直说扫了哪几个目录、各有多少片 —— 比让人从总数里猜强。
  if (Array.isArray(s.roots) && s.roots.length > 0) {
    target.appendChild(el('h2', null, '扫描的根（' + s.roots.length + '）'));
    target.appendChild(el('p', 'muted small',
      '驾驶舱同时看仓库根和每个版本集成目录 —— 切片在版本目录里冻结、过门禁、签字，就落在那个目录里。'));
    target.appendChild(table(
      ['根', '切片数', '状态分布'],
      s.roots.map(function (r) {
        var dist = Object.keys(r.byState || {}).map(function (k) { return k + ' ' + r.byState[k]; }).join(' · ');
        return {
          cells: [rootName(r.scope, r.label), String(r.total), dist || '—']
        };
      })
    ));
  }

  // ── 计划对照（ADR-114）───────────────────────────────────────────
  //
  // 「这一版还差什么」必须把三个口径并排：
  //   计划（.zelto/versions）· 盘上（切片状态文件）· 版本分支（git 跟踪）。
  // 实测（nimrtc-v14，2026-11-25）三者的差是：计划 16 项全 draft、
  // 盘上 15 片全 completed、版本分支只跟踪 3 片 —— 只看其中一个都会误判。
  // 这里只呈现计数，不给「完成度」这种合成结论（合成会抹掉差别）。
  renderPlanCoverage(target, coverage);

  // ── 基线切片的清单 ──
  //
  // 直说「哪些是基线」而不是让人自己猜 —— 判据是内部的，
  // 人没有义务知道 `baseline` 字段缺失也算基线。
  if (base.total > 0) {
    target.appendChild(el('h2', null, '基线切片（' + base.total + '）'));
    target.appendChild(el('p', 'muted',
      '这些切片描述的是接管项目时已有的现状，不改代码 —— 所以不计入上面的开发进度。'));
    target.appendChild(table(
      ['切片'],
      (base.ids || []).map(function (id) {
        return {
          onClick: function () { showSliceDetail(id); },
          cells: [id]
        };
      })
    ));
  }

  // ── 正在运行（D-30 补）：不只说「活着」，要说「在干什么」 ──
  //
  // 这一节放在页面最上面，因为它回答的是人打开驾驶舱的第一问题：
  // 「agent 现在在干活吗」。活性徽标 + 已跑时长 + 最后一条输出，
  // 三者都在每轮轮询里更新 —— 页面不会看上去像死掉。
  try {
    const all = await apiGet('/api/slices');
    const runningRows = all.filter(function (x) { return x.state === 'running'; });
    target.appendChild(el('h2', null, '正在运行（' + runningRows.length + '）'));
    if (runningRows.length === 0) {
      target.appendChild(el('p', 'muted', '没有正在运行的切片。'));
    } else {
      target.appendChild(table(
        ['切片', '活性', '进度', '最后活动'],
        runningRows.map(function (x) {
          var last = formatIdleMs(x.idleMs) + '没动静';
          if (x.lastActivityAt) last = new Date(x.lastActivityAt).toLocaleTimeString() + ' · ' + last;
          return {
            onClick: function () { showSliceDetail(x.id, false, { scope: x.scope, label: x.label }); },
            cells: [x.id, liveBadge(x), progressCell(x), last]
          };
        })
      ));
    }
  } catch (err) {
    // 运行列表拿不到不影响概况本身 —— 但要记一笔连接失败
    if (isConnectionError(err)) noteDisconnected(err);
  }

  // ── 成本（ADR-072 §6：概况含「成本」）────────────────────────────
  target.appendChild(el('h2', null, '成本'));
  const cost = el('dl', 'kv');
  const ckv = function (k, v) {
    cost.appendChild(el('dt', null, k));
    const dd = el('dd');
    setValue(dd, v);
    cost.appendChild(dd);
  };
  ckv('已花费', formatUsd(s.spentUsd));
  // 没记账的切片列出来 —— 否则「已花费」看起来像完整总额，实际只算了一半的账。
  //
  // 三态分开（ADR-035 §3.5）：
  // - 「未记账切片」= 压根没查（一条成本事件都没有）
  // - 「未测到切片」= 查过了，但 agent 没报出用量
  //
  // 两者混在一行会让人以为「账是完整的」—— 那不是事实。
  if (s.unmeasuredSlices && s.unmeasuredSlices.length > 0) {
    ckv('未记账切片', el('span', 'muted', s.unmeasuredSlices.join('、') + '（无成本事件，未计入上面金额）'));
  }
  if (s.checkedNoUsageSlices && s.checkedNoUsageSlices.length > 0) {
    ckv('未测到切片', el('span', 'muted', s.checkedNoUsageSlices.join('、') + '（已核查，agent 未报出用量）'));
  }
  // 上限可能是「不限」（ADR-035 §3.6：budgetLimitUsd: 0 = 不限）。
  // 不限时服务端给 null + unlimited:true —— 不能显示成「$null」。
  ckv('预算上限', s.unlimited ? '不限' : formatUsd(s.limitUsd));
  if (s.exhausted) {
    ckv('状态', el('span', 'notice bad', '已超支'));
  } else if (typeof s.spendRatio === 'number') {
    ckv('占比', Math.round(s.spendRatio * 100) + '%');
  }
  target.appendChild(cost);

  target.appendChild(el('h2', null, '待签字'));
  if (!s.pendingSigns || s.pendingSigns.length === 0) {
    target.appendChild(el('p', 'muted', '没有待签字的切片。'));
  } else {
    target.appendChild(table(
      ['切片', '根', '请求时间'],
      s.pendingSigns.map(function (p) {
        return {
          onClick: function () { showSliceDetail(p.sliceId, true, { scope: p.scope, label: p.label }); },
          cells: [p.sliceId, rootName(p.scope, p.label), new Date(p.requestedAt).toLocaleString()]
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

  // ── 活 / 死 / 可疑（D-30）：running 到底活没活，一眼看出来 ──
  const live = s.live || {};
  const stale = live.stale || [];
  const dead = live.dead || [];
  const wd = s.watchdog || {};
  if (stale.length > 0 || dead.length > 0) {
    target.appendChild(el('h2', null, '活性（可疑 / 已死）'));
    const rows = [];
    for (const x of stale) {
      rows.push({ onClick: (function (id) { return function () { showSliceDetail(id); }; })(x.id), cells: [x.id, '⚠️ stale', formatIdleMs(x.idleMs) + '没动静', x.reason || ''] });
    }
    for (const x of dead) {
      const tag = x.escalated ? '💀 dead（已上报，需人看）' : '💀 dead（看门狗可自愈）';
      rows.push({ onClick: (function (id) { return function () { showSliceDetail(id); }; })(x.id), cells: [x.id, tag, x.reason || '', '已自愈 ' + (x.recoveries || 0) + ' 次'] });
    }
    target.appendChild(table(['切片', '活性', '现场', '说明'], rows));
  }
  // ── 看门狗上报（D-30）：超 3 次不再自救的，等人看 ──
  const escalated = wd.escalated || [];
  if (escalated.length > 0) {
    target.appendChild(el('p', 'notice bad', '🚨 看门狗已上报（假死超 3 次不再自救）：' + escalated.join('、') + ' —— 请看现场后 zelto resume 重跑'));
  }
  // ── 看门狗已放弃、状态却停在 running 的片 ──
  //
  // 它们既不在「停机」（stall.class 为 null，stalledSlices 里没有），
  // 也不该算「在跑」。不给这一节，总览就把尸体算成活的了。
  const gaveUp = live.gaveUp || [];
  if (gaveUp.length > 0) {
    target.appendChild(el('h2', null, '需人收（看门狗已停救）'));
    target.appendChild(el('p', 'muted small',
      '这些片的状态还是 running，但进程已经没了（或很久没动静），且自动自愈已经到头。'
      + '它们不属于任何停机分类，所以上面的「停机」数里没有它们。'
      + '处理：看现场后 zelto resume <id> 重跑，或 zelto abandon <id> 收掉。'));
    target.appendChild(table(
      ['切片', '活性', '自愈 / 上报', '最后活动', '现场'],
      gaveUp.map(function (x) {
        const tag = x.liveness === 'dead' ? '💀 dead' : '⚠️ stale';
        const rec = '已自愈 ' + (x.recoveries || 0) + ' 次' + (x.escalated ? ' · 已上报' : '');
        return {
          onClick: (function (id) { return function () { showSliceDetail(id); }; })(x.id),
          cells: [x.id, tag, rec, x.lastActivityAt ? new Date(x.lastActivityAt).toLocaleString() : '—', x.reason || '']
        };
      })
    ));
  }
}

async function viewSlices(target) {
  // ── 三个接口并发取（2026-11-28）────────────────────────────────────
  //
  // 原来这里是**串行**的：`slices` → `plan-coverage` → `worktrees`，
  // 实测三者相加约 840ms（197 + 539 + 100），一个接一个等。
  //
  // 但这三个接口**互不依赖** —— 切片列表不需要计划索引才能渲染，
  // 工作区脉络也不需要切片列表。所以直接并发。
  //
  // 口径与总览页一致（viewOverview 已经是 Promise.all）：
  // **能并发就并发**，不要把三个独立请求串成一条链。
  //
  // 注意「失败就当没有」的语义保持不变 —— 计划索引拿不到就不出「计划」列，
  // 工作区脉络拿不到就整节不显示（不编）。
  const [slices, planCoverage, worktrees] = await Promise.all([
    apiGet('/api/slices'),
    // ADR-114：计划索引（id → {version, plannedState, ...}）—— 拿不到就不出「计划」列
    apiGet('/api/plan-coverage').catch(function () { return null; }),
    apiGet('/api/worktrees').catch(function () { return null; }),
  ]);
  var planIndex = planCoverage ? buildPlanIndex(planCoverage) : null;
  clear(target);
  target.appendChild(el('h2', null, '全部切片（' + slices.length + '）'));

  // ── 执行目录脉络（多工作区进展）─────────────────────────────────
  //
  // 切片表只分「仓库根 / 版本目录」两类根；同一仓库在盘上还有别的工作区
  // （zelto run 建的执行目录、git 额外工作区）。先把「几条战线」摆出来，
  // 每条战线附上它名下的切片与分支/HEAD —— 再往下才是逐片明细。
  // 拿不到就整节不显示（不编）。
  var worktreeMap = worktrees;
  renderWorktreeMap(target, worktreeMap);

  // ── ADR-112：按「根」分组 ────────────────────────────────────────
  //
  // 合并后的总数会让人以为「都在一个地方」。实际上 v3 集成目录里的
  // 那十几片是**另一份 zelto 状态**（`zelto web` 以前根本看不到它们）——
  // 「哪片在哪个根」是一个要人去做决定的事实（签字/门禁去哪个目录）。
  //
  // 分组判据是列表行上的 scope + label（服务端给的归属），不按 id 猜。
  var byRoot = {};
  var rootOrder = [];
  for (const s of slices) {
    var key = (s.scope || 'root') + '/' + (s.label || '');
    if (!byRoot[key]) {
      byRoot[key] = { scope: s.scope || 'root', label: s.label || null, rows: [] };
      rootOrder.push(key);
    }
    byRoot[key].rows.push(s);
  }
  // 仓库根排第一，版本目录按 label 排 —— 与服务端根发现顺序一致
  rootOrder.sort(function (a, b) {
    var A = byRoot[a];
    var B = byRoot[b];
    if (A.scope !== B.scope) return A.scope === 'root' ? -1 : 1;
    return String(A.label || '') < String(B.label || '') ? -1 : String(A.label || '') > String(B.label || '') ? 1 : 0;
  });

  for (const key of rootOrder) {
    const group = byRoot[key];
    // 这一组里的开发 / 基线分开 —— 与全量口径同一套理由（基线不算进度）
    var devSlices = group.rows.filter(function (s) { return s.kind !== 'baseline'; });
    var baseSlices = group.rows.filter(function (s) { return s.kind === 'baseline'; });

    target.appendChild(el('h2', null, rootName(group.scope, group.label) + '（' + group.rows.length + '）'));
    if (group.scope === 'version') {
      target.appendChild(el('p', 'muted small',
        '这个版本集成目录里有自己独立的 .zelto 状态 —— 在这里冻结、过门禁、签字的切片，都落在这个目录里。'));
    }

    if (devSlices.length > 0) {
      target.appendChild(el('h3', null, '开发切片（' + devSlices.length + '）'));
      var devHeaders = ['切片', '标题', '状态'];
      if (planIndex) devHeaders.push('计划');
      devHeaders.push('分支证据', '产物证据', '活性 / 进度', '追溯(需/契/测)', '写集', '运行', '花费', '更新');
      target.appendChild(table(
        devHeaders,
        devSlices.map(function (s) {
          var wd = '';
          if (s.escalated) wd = ' 🚨已上报';
          else if (s.recoveries > 0) wd = ' 自愈' + s.recoveries + '次';
          var cells = [
            s.id,
            s.title,
            stateBadge(s.state, s)
          ];
          if (planIndex) cells.push(planCell(planIndex, s.id));
          cells.push(
            branchCell(s),
            artifactCell(planIndex, s.id),
            livenessCell(s),
            traceCounts(s.trace),
            String(s.writeCount),
            s.runCount === 0 ? '—' : (s.lastRunOk ? '✅ ' + s.runCount : '❌ ' + s.runCount) + wd,
            costCell(s),
            new Date(s.updatedAt).toLocaleString()
          );
          return {
            onClick: function () { showSliceDetail(s.id, false, { scope: s.scope, label: s.label }); },
            cells: cells
          };
        })
      ));
    }

    if (baseSlices.length > 0) {
      target.appendChild(el('h3', null, '基线切片（' + baseSlices.length + '）'));
      target.appendChild(el('p', 'muted',
        '描述接管项目时已有的现状，不改代码 —— 不计入开发进度。'));
      target.appendChild(table(
        ['切片', '标题', '状态', '追溯(需/契/测)', '写集', '更新'],
        baseSlices.map(function (s) {
          return {
            onClick: function () { showSliceDetail(s.id, false, { scope: s.scope, label: s.label }); },
            cells: [
              s.id,
              s.title,
              stateBadge(s.state, s),
              traceCounts(s.trace),
              String(s.writeCount),
              new Date(s.updatedAt).toLocaleString()
            ]
          };
        })
      ));
    }
  }
}

/**
 * 活性 + 最后活动 —— 一个单元格说清「活没活、多久没动」。
 *
 * 为什么不能只显示 updatedAt：那是**状态文件被写入**的时间，
 * 不是 agent 干活的时间。一个死掉 19 小时的空壳，updatedAt 也会
 * 停在它死前那一刻 —— 看着像"刚更新过"。活性判定 + 闲置时长
 * 才能让人一眼看出「这片已经没人在管了」。
 */
function livenessCell(s) {
  var box = el('span');
  if (s.state !== 'running') {
    // 非 running 片一般没有活性概念（显示「—」）。但**停机过**的片例外：
    // 它不是「没在运行」这么简单，而是「上次跑挂了、等人处理」。
    // 只显示「—」会让人误以为这片还没跑过（实测 2026-11-26）。
    if (s.stalled) {
      var warn = el('span', 'badge live-stale', '停机');
      warn.title = (s.stallClass || '原因未分类') + ' —— 可重跑 / 续跑';
      box.appendChild(warn);
      if (s.lastRunOk === false && typeof s.runCount === 'number') {
        box.appendChild(el('div', 'muted small', '上次运行失败（共 ' + s.runCount + ' 次）'));
      }
      return box;
    }
    box.appendChild(el('span', 'muted', '—'));
    return box;
  }
  box.appendChild(liveBadge(s));
  var parts = [];
  if (typeof s.idleMs === 'number') parts.push(formatIdleMs(s.idleMs) + '没动静');
  if (s.lastActivityAt) parts.push('最后活动 ' + new Date(s.lastActivityAt).toLocaleString());
  if (parts.length > 0) {
    box.appendChild(el('div', 'muted small', parts.join(' · ')));
  } else if (s.liveReason) {
    box.appendChild(el('div', 'muted small', s.liveReason));
  }
  // 进度（已跑时长 + 最后一条输出）—— 让「在推进」可见，
  // 不只是「没死」。列表页给紧凑版，总览页给完整表格。
  var prog = progressCell(s);
  if (prog) box.appendChild(prog);
  return box;
}

/**
 * 花费单元格 —— 「没记账」与「花到 0」严格分开（ADR-035 §3.5）。
 *
 * 老切片（事件流没保留）根本没有成本事件，服务端给 costMeasured=false。
 * 显示 $0.0000 等于告诉人「这片没花钱」，
 * 而真相是「账本里没有这片」—— 那是假数据。
 *
 * 三态（服务端给 costMeasurement）：
 * - unmeasured —— 压根没查 → 「未记账」
 * - unavailable —— 查过了但 agent 没报出用量 → 「未测到」
 * - measured —— 测到了 → 显示金额（哪怕正好是 $0.0000）
 *
 * unavailable 与 measured 差在「$0.0000」和「未测到」之间 ——
 * 一个说「确实没花钱」，一个说「没测出来」。混同就是假账。
 */
function costCell(s) {
  var state = s.costMeasurement;
  // 老服务端没有 costMeasurement 字段 → 退回布尔判据。
  if (state === undefined || state === null) {
    state = s.costMeasured ? 'measured' : 'unmeasured';
  }
  if (state === 'unmeasured') return el('span', 'muted', '未记账');
  if (state === 'unavailable') return el('span', 'muted', '未测到');
  return document.createTextNode(formatUsd(s.spentUsd));
}

/**
 * 追溯计数 —— 列表页显示「需/契/测」三个数字。
 *
 * 明细（具体是哪几个 REQ / 契约 / 测试）不在这里展开 ——
 * 列表页塞不下，也不该塞（那会让人没法扫读）。
 * 但**明细是可查的**：点进详情页看完整追溯链。
 */
function traceCounts(trace) {
  const c = (trace && trace.counts) || { requirements: 0, contracts: 0, tests: 0 };
  return c.requirements + '/' + c.contracts + '/' + c.tests;
}

/** 金额格式化 —— 保留 4 位小数（成本通常很小）。 */
function formatUsd(v) {
  if (typeof v !== 'number' || !isFinite(v)) return '—';
  return '$' + v.toFixed(4);
}

// ── 度量 / 停机 / 策略 / 预算 / 全链 ────────────────────────────────────
//
// 这几个视图对应 ADR-010 §5.3 里 ADR-072 §4 **没有砍掉**的只读端点。
// ADR-072 砍掉的只是**写操作**（run/gate/freeze/...）——
// 只读的度量与状态展示原本就在 ADR-010 的范围里，ADR-072 §1 的摘要
// 也写着「只读驾驶舱（切片总览 / 切片详情 / 事件流 / 审计 / 签字复查）」。
//
// （写操作后来由 ADR-084 / ADR-086 补上了，见上面的油门按钮组。）

async function viewMetrics(target) {
  const m = await apiGet('/api/metrics');
  clear(target);
  target.appendChild(el('h2', null, '度量'));
  target.appendChild(el('p', 'muted',
    '切片 ' + m.sliceCount + ' 片 · 事件 ' + m.eventCount + ' 条 · 生成于 ' +
    new Date(m.generatedAt).toLocaleString()));

  const metrics = m.metrics || [];
  if (metrics.length === 0) {
    target.appendChild(el('p', 'muted', '还没有度量数据。'));
    return;
  }

  // 按指标名分组 —— 同一个切片会产出好几个指标
  const byName = {};
  for (const x of metrics) {
    if (!byName[x.name]) byName[x.name] = [];
    byName[x.name].push(x);
  }
  for (const name of Object.keys(byName)) {
    target.appendChild(el('h2', null, name));
    target.appendChild(table(
      ['切片', '值', '单位', '时间'],
      byName[name].map(function (x) {
        return {
          onClick: function () { showSliceDetail(x.sliceId); },
          cells: [
            x.sliceId,
            formatMetricValue(x.value, x.unit),
            x.unit || '—',
            new Date(x.timestamp).toLocaleString()
          ]
        };
      })
    ));
  }
}

/** 度量值的显示 —— 比率转百分比，时间转可读时长。 */
function formatMetricValue(value, unit) {
  if (typeof value !== 'number') return String(value);
  if (unit === 'ratio') return (value * 100).toFixed(1) + '%';
  if (unit === 'seconds') return formatDuration(value);
  return String(value);
}

/** 秒 → 人看得懂的时长。 */
function formatDuration(seconds) {
  if (typeof seconds !== 'number' || !isFinite(seconds)) return '—';
  const s = Math.round(seconds);
  if (s < 60) return s + ' 秒';
  if (s < 3600) return Math.round(s / 60) + ' 分 ' + (s % 60) + ' 秒';
  const h = Math.floor(s / 3600);
  const m = Math.round((s % 3600) / 60);
  return h + ' 小时 ' + m + ' 分';
}

async function viewStalls(target) {
  const stalls = await apiGet('/api/stalls');
  clear(target);
  target.appendChild(el('h2', null, '停机（' + stalls.length + '）'));
  if (stalls.length === 0) {
    target.appendChild(el('p', 'muted', '没有停机的切片。'));
    return;
  }
  target.appendChild(table(
    ['切片', '标题', '分类', '状态', '更新'],
    stalls.map(function (x) {
      return {
        onClick: function () { showSliceDetail(x.id); },
        cells: [
          x.id,
          x.title,
          x.stallClass || '—',
          stateBadge(x.state),
          new Date(x.updatedAt).toLocaleString()
        ]
      };
    })
  ));
}

async function viewPolicy(target) {
  const p = await apiGet('/api/policy');
  clear(target);

  if (!p.exists) {
    target.appendChild(el('h2', null, '策略'));
    target.appendChild(el('p', 'muted', '本项目还没有 policy/policy.yaml。'));
    return;
  }

  target.appendChild(el('h2', null, '策略规则（' + p.rules.length + '）'));
  target.appendChild(el('p', 'muted', '来源：' + p.path + ' · 版本 ' + p.version));
  if (p.rules.length === 0) {
    target.appendChild(el('p', 'muted', '策略里没有规则。'));
  } else {
    target.appendChild(table(
      ['id', '动作', '匹配路径', '操作', '依据'],
      p.rules.map(function (r) {
        return {
          cells: [
            r.id,
            r.action,
            (r.match && r.match.path) || '—',
            (r.match && r.match.operation) || '—',
            r.basis || '—'
          ]
        };
      })
    ));
  }

  // arch: 段也是策略的一部分 —— 只给 rules 会让人以为策略只有一条规则
  if (p.arch && p.arch.length > 0) {
    target.appendChild(el('h2', null, '架构护栏（' + p.arch.length + '）'));
    target.appendChild(table(
      ['种类', '动作', '依据'],
      p.arch.map(function (a) {
        return { cells: [a.kind, a.action, a.basis || '—'] };
      })
    ));
  }
}

async function viewBudget(target) {
  const b = await apiGet('/api/budget');
  clear(target);
  target.appendChild(el('h2', null, '预算'));

  const dl = el('dl', 'kv');
  const kv = function (k, v) {
    dl.appendChild(el('dt', null, k));
    const dd = el('dd');
    setValue(dd, v);
    dl.appendChild(dd);
  };
  kv('已花费', formatUsd(b.spentUsd));
  kv('上限', b.unlimited ? '不限' : formatUsd(b.limitUsd));
  if (b.exhausted) {
    kv('状态', el('span', 'notice bad', '已超支'));
  } else if (typeof b.spendRatio === 'number') {
    kv('占比', Math.round(b.spendRatio * 100) + '%');
  }
  target.appendChild(dl);

  if (b.topSpenders && b.topSpenders.length > 0) {
    target.appendChild(el('h2', null, '花费最高的切片'));
    target.appendChild(table(
      ['切片', '标题', '花费'],
      b.topSpenders.map(function (x) {
        return {
          onClick: function () { showSliceDetail(x.id); },
          cells: [x.id, x.title, formatUsd(x.spentUsd)]
        };
      })
    ));
  }
}

async function viewPipeline(target) {
  const p = await apiGet('/api/pipeline');
  clear(target);
  target.appendChild(el('h2', null, '全链状态'));

  // 需求 → 设计 → 计划 → 版本 → 切片
  const stages = [
    ['需求', p.requirements],
    ['设计', p.designs],
    ['计划', p.plans],
    ['版本', p.versions],
    ['切片', p.slices]
  ];
  const cards = el('div', 'cards');
  for (const pair of stages) {
    const c = el('div', 'card');
    c.appendChild(el('div', 'n', pair[1] ? pair[1].count : 0));
    c.appendChild(el('div', 'l', pair[0]));
    cards.appendChild(c);
  }
  target.appendChild(cards);

  // 各版本的切片归属
  const byVersion = (p.slices && p.slices.byVersion) || {};
  const versionKeys = Object.keys(byVersion);
  if (versionKeys.length > 0) {
    target.appendChild(el('h2', null, '切片的版本归属'));
    target.appendChild(table(
      ['版本', '切片数'],
      versionKeys.map(function (k) {
        return { cells: [k, String(byVersion[k])] };
      })
    ));
  }

  // 不属于任何版本的切片 —— 直说，别让人以为漏了
  const unassigned = (p.slices && p.slices.unassigned) || [];
  if (unassigned.length > 0) {
    target.appendChild(el('h2', null, '未归属版本（' + unassigned.length + '）'));
    target.appendChild(el('p', 'muted', '这些切片没进任何版本计划，也不是版本切片。'));
    target.appendChild(table(
      ['切片'],
      unassigned.map(function (id) {
        return {
          onClick: function () { showSliceDetail(id); },
          cells: [id]
        };
      })
    ));
  }
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
    // ADR-112：签字请求在哪个根，就去哪个根的详情页签 —— 不靠 id 猜
    target.appendChild(el('p', 'muted small', '所在根：' + rootName(r.scope, r.label)));
    const btn = el('button', 'btn ok', '查看并签字');
    btn.addEventListener('click', function () {
      showSliceDetail(r.sliceId, true, { scope: r.scope, label: r.label });
    });    target.appendChild(btn);
  }
}

async function viewEvents(target) {
  const events = await apiGet('/api/events?limit=200');
  clear(target);
  target.appendChild(el('h2', null, '最近事件（' + events.length + '）'));

  // 去重说明必须写出来：服务端把「相邻的完全重复」折叠成一条（带次数），
  // 人得知道这一行代表 N 条，否则会以为事件真的只有这么少。
  const collapsed = events.filter(function (e) { return (e.count || 1) > 1; });
  if (collapsed.length > 0) {
    target.appendChild(el('p', 'muted small',
      '相同事件已折叠：一行代表 N 条连续的完全重复（展开看次数）。共折叠 ' +
      collapsed.reduce(function (n, e) { return n + ((e.count || 1) - 1); }, 0) + ' 条。'));
  }

  target.appendChild(table(
    ['时间', '切片', '类型', '操作者', '次数'],
    events.map(function (e) {
      var count = e.count || 1;
      return {
        onClick: function () { showSliceDetail(e.slice); },
        cells: [
          new Date(e.ts).toLocaleString(),
          e.slice,
          e.type,
          e.actor,
          count > 1 ? el('span', 'badge live-stale', '×' + count) : el('span', 'muted', '1')
        ]
      };
    })
  ));
}

async function showSliceDetail(id, forSign, loc) {
  clear(main);
  inDetail = true;
  currentSliceId = id;
  // ADR-112：记住这个详情页看的是哪个根 —— 轮询、签字、门禁都落回同一个根
  currentLocation = loc && loc.scope ? { scope: loc.scope, label: loc.label || null } : { scope: 'root', label: null };
  const back = el('button', 'back', '← 返回');
  back.addEventListener('click', function () { stopDetailPolling(); render(currentView); });
  main.appendChild(back);

  let d;
  let planIndexForDetail = null;
  // 切片详情与计划索引**互不依赖** —— 并发取（实测各约 200ms / 539ms）。
  // 口径与 viewSlices / viewOverview 一致：能并发就并发。
  //
  // 计划索引拿不到就**不显示那一行**（不编）—— 与原来的 try/catch 同语义。
  const [detailResult, planCoverage] = await Promise.all([
    apiGet('/api/slices/' + encodeURIComponent(id) + locQuery(currentLocation))
      .then(function (v) { return { ok: true, v: v }; })
      .catch(function (err) { return { ok: false, err: err }; }),
    apiGet('/api/plan-coverage')
      .then(function (v) { return v; })
      .catch(function () { return null; }),
  ]);
  if (!detailResult.ok) {
    main.appendChild(el('p', 'notice bad', '加载失败：' + friendlyError(detailResult.err)));
    if (isConnectionError(detailResult.err)) noteDisconnected(detailResult.err);
    return;
  }
  d = detailResult.v;
  const slice = d.slice;
  main.appendChild(el('h2', null, id + ' — ' + slice.title));

  // ADR-126：产物证据需要计划索引（所属版本分支从计划来）——
  // 拿不到就不显示这一行（不编）。
  if (planCoverage) {
    planIndexForDetail = buildPlanIndex(planCoverage);
  }
  // ADR-112：说清这片看的是哪个根 —— 同一个 id 可能在好几个根里都有副本
  if (d.summary && d.summary.scope) {
    const roots = (d.summary.roots || []).map(function (r) {
      return r === 'root' ? '仓库根' : '版本目录 ' + r;
    }).join('、');
    main.appendChild(el('p', 'muted small',
      '所在根：' + rootName(d.summary.scope, d.summary.label) +
      (roots ? ' · 这片在以下根有记录：' + roots : '')));
  }

  // ADR-114：分支证据 —— 「completed」是不是在版本分支里完成的
  if (d.summary) {
    var bLine = el('p', 'small');
    bLine.appendChild(el('span', null, '分支证据：'));
    bLine.appendChild(branchCell(d.summary));
    if (d.summary.onBranch === false) {
      bLine.appendChild(el('span', 'muted small',
        ' 状态文件 .zelto/slices/' + id + '.json 未提交进所属分支（.zelto/ 在 .gitignore 里）'
        + ' —— 这项恒为「仅在盘上」不是缺陷；产物证据见下一行。'));
    }
    main.appendChild(bLine);
  }

  // ADR-126：产物证据 —— 这一片的产物在所属版本分支上吗
  if (planIndexForDetail && planIndexForDetail[id]) {
    var aLine = el('p', 'small');
    aLine.appendChild(el('span', null, '产物证据：'));
    aLine.appendChild(artifactCell(planIndexForDetail, id));
    var pa = planIndexForDetail[id];
    if (pa.artifactOnBranch === false) {
      aLine.appendChild(el('span', 'muted small',
        pa.artifactOnAncestor === true
          ? ' 本版分支上没有它自己的 Refs-Slice 提交，但产物在**祖先版本分支**上'
            + (pa.artifactAncestorCommit ? '（提交 ' + pa.artifactAncestorCommit + '）' : '')
            + ' —— 已随栈进入本版。'
          : ' 所属版本分支（' + (pa.versionBranch || '?') + '）和它的祖先分支上都没有这一片的 Refs-Slice 提交'
            + ' —— 可能合到了别的分支（归属错位），也可能还没合。'));
    } else if (pa.artifactOnBranch === true && pa.artifactCommit) {
      aLine.appendChild(el('span', 'muted small',
        ' ' + pa.artifactCommit + (pa.artifactSubject ? ' ' + pa.artifactSubject : '')));
    }
    main.appendChild(aLine);
  }

  // ── ADR-086：油门 ────────────────────────────────────────────────────
  //
  // 驾驶舱从「只有刹车的看板」变成「能踩油门的驾驶舱」。
  //
  // 纪律不变（ADR-084 §2 / ADR-086 §1）：
  // **前端不重写任何判定** —— 按钮只发请求、只把服务端回来的话显示出来。
  // 能不能做、为什么不能做，全由服务端的 core 编排说了算。
  const throttleRow = el('div', 'throttle-row');
  main.appendChild(throttleRow);
  renderThrottleButtons(throttleRow, id, slice, d.summary);

  // ── ADR-086：详情页自己轮询「状态 / 活性 / 进度」────────────────────
  //
  // 为什么详情页要单独轮询：
  // 全局轮询在详情页上是**停用**的（免得把人正在看的内容刷掉）。
  // 但「点了开跑，然后盯着这一页看进度」正是驾驶舱最有用的场景 ——
  // 人盯着一个不动的页面，会怀疑 agent 卡死了（本可避免的焦虑）。
  //
  // 所以这里只轮询**一小块**（状态 / 活性 / 进度 / 花费），
  // 不动页面其余部分 —— 既给出「它还活着」的证据，又不抢人的视线。
  const liveBox = el('div', 'live-box');
  main.appendChild(liveBox);
  renderLiveBox(liveBox, d.summary);
  startDetailPolling(id, liveBox);

  const dl = el('dl', 'kv');
  const kv = function (k, v) {
    dl.appendChild(el('dt', null, k));
    const dd = el('dd');
    setValue(dd, v);
    dl.appendChild(dd);
  };
  kv('类型', slice.type || '—');
  kv('写集', String((slice.writes || []).length) + ' 项');
  kv('运行', String((slice.runs || []).length) + ' 次');
  kv('创建', new Date(slice.createdAt).toLocaleString());
  kv('更新', new Date(slice.updatedAt).toLocaleString());
  main.appendChild(dl);

  // ── 回答 agent 的提问（ADR-084）────────────────────────────────────
  //
  // 只在**有提问时**才显示 —— 没有提问就摆一个空输入框，
  // 是在给界面加噪音（而驾驶舱的噪音就是「看不出哪儿需要你」）。
  //
  // 答案只**记录**，不续跑：续跑要拉起 agent 会话，
  // 驾驶舱不该在 HTTP 请求里挂着它（ADR-084 §1.1）。
  try {
    // ADR-112：提问在仓库根的问题 store 里读 —— 不按切片根路由，
    // 版本目录里的提问暂不在驾驶舱归集（见 ADR-112 边界）。
    const pending = await apiGet('/api/questions?status=pending&slice=' + encodeURIComponent(id));
    if (pending && pending.length > 0) {
      main.appendChild(el('h2', null, 'agent 在问你（' + pending.length + '）'));
      for (const q of pending) {
        main.appendChild(renderQuestionBox(id, q));
      }
    }
  } catch (err) {
    // 拿不到提问不致命 —— 详情页其它内容照常显示
    void err;
  }

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

  // ── 改了什么（文件级清单）──────────────────────────────────────────
  //
  // 与 CLI `zelto sign --review` 的「改动」段**同一份事实**
  // （core/sign-review/diff.ts）—— 同一个结论，两处呈现。
  //
  // 为什么必须给**文件**而不只是三个数字：
  // 人签字时要回答的是「这个改动该不该签」，
  // 而「改了 3 个文件 +120 -10」回答不了这个问题 ——
  // 「哪些文件」才回答得了（ADR-072 §5.2）。
  renderDiffSection(main, d.facts && d.facts.diff);

  // ── 签字 ────────────────────────────────────────────────────────────
  if (forSign) {
    const btn = el('button', 'btn ok', '确认签字');
    // 前端这道只是「看过才解锁」；真正的门在服务端（ADR-072 §5.2）
    btn.disabled = !allOk;
    if (!allOk) {
      main.appendChild(el('p', 'notice bad', '有确认项未通过 —— 服务端也会拒绝签字。'));
    }
    // 把这四项传给服务端 —— 当「人确认过了」的凭据。
    // 服务端不信任内容（自己重算），但「有没有带」是信号：
    // 没带就说明人没在页面上看过这四项（ADR-072 §5.2）。
    btn.addEventListener('click', function () { doApprove(id, btn, d.checks); });
    main.appendChild(btn);

    // ADR-084：**拒签** —— 驾驶舱要能拒签，否则只能签不能拒，
    // 等于把人赶回终端（驾驶舱在最该起作用的时候失效）。
    //
    // 注意它**不受确认项的约束**：确认项是「批准前要核对的四件事」，
    // 拒签是「不批准」—— 没有要核对的东西。
    const rejBtn = el('button', 'btn bad', '拒签');
    rejBtn.addEventListener('click', function () { doReject(id, rejBtn); });
    main.appendChild(rejBtn);

    // ADR-094 §5.1：**退回重跑 / 退回上游** —— 「不批准」还有两档，
    // 只给「拒签」一个出口的话，人发现「方向不对但代码没错」时
    // 只能选拒签（把整片作废）或切回终端（驾驶舱在最该起作用时失效）。
    //
    // 两档的区别在**回哪个状态**：
    //   - 退回重跑 → frozen（规格不动，重跑即可）
    //   - 退回上游 → draft（规格要改，得重新走门禁① + 冻结）
    //
    // **意见是强制的**（服务端也强制）：不给意见就让人重跑
    // = 人自己也不清楚要改什么，重跑必然白跑。
    const revBtn = el('button', 'btn warn', '退回重跑…');
    revBtn.addEventListener('click', function () { doSendBack(id, revBtn, 'revise', '退回重跑'); });
    main.appendChild(revBtn);

    const retBtn = el('button', 'btn warn', '退回上游…');
    retBtn.addEventListener('click', function () { doSendBack(id, retBtn, 'return', '退回上游'); });
    main.appendChild(retBtn);
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
    const events = await apiGet('/api/slices/' + encodeURIComponent(id) + '/events?limit=100' + locQuery(currentLocation));
    main.appendChild(table(
      ['时间', '类型', '操作者'],
      events.map(function (e) {
        return { cells: [new Date(e.ts).toLocaleString(), e.type, e.actor] };
      })
    ));
  } catch (err) {
    main.appendChild(el('p', 'muted', '事件加载失败：' + err.message));
  }

  // ── 审计 ────────────────────────────────────────────────────────────
  //
  // ADR-072 §1 摘要里驾驶舱含「审计」，§6 端点表也列了
  // GET /api/slices/:id/audit —— 但之前前端从没调用过它。
  // 端点实现了却没人用，等于没实现（ADR-010 §5.4 详情页的「📋 审计」按钮）。
  main.appendChild(el('h2', null, '审计'));
  try {
    const audit = await apiGet('/api/slices/' + encodeURIComponent(id) + '/audit' + locQuery(currentLocation));
    const entries = (audit && audit.entries) || [];
    if (entries.length === 0) {
      main.appendChild(el('p', 'muted', '没有审计记录。'));
    } else {
      main.appendChild(table(
        ['序号', '时间', '事件', '摘要'],
        entries.map(function (e) {
          return {
            cells: [
              String(e.seq),
              new Date(e.timestamp).toLocaleString(),
              e.eventType,
              e.summary
            ]
          };
        })
      ));
    }
  } catch (err) {
    main.appendChild(el('p', 'muted', '审计加载失败：' + friendlyError(err)));
  }
}

async function doApprove(sliceId, btn, checks) {
  btn.disabled = true;
  btn.textContent = '签字中…';

  // 先找这条切片的 pending 签字请求 —— ADR-112：只在该切片所在的根里找
  const reqs = await apiGet('/api/sign-requests?status=pending' + locQuery(currentLocation));
  const req = reqs.find(function (r) { return r.sliceId === sliceId; });
  if (!req) {
    main.appendChild(el('p', 'notice bad', '找不到这条切片的待签字请求。'));
    btn.disabled = false;
    btn.textContent = '确认签字';
    return;
  }

  // 必须带上四项确认项 —— 服务端拿它当「人确认过了」的凭据。
  // 服务端不信任内容（自己重算一遍），但「有没有带」本身是信号。
  const res = await apiPost(
    '/api/sign-requests/' + encodeURIComponent(req.id) + '/approve',
    Object.assign({ checks: checks || [] }, locBody(currentLocation))
  );
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

// ── ADR-084：可接管的三个动作 ───────────────────────────────────────────
//
// 共同纪律：调用的是**服务端已有的 core 实现**，前端不重写任何判定。
// 前端只负责收集输入、发请求、把结果说清楚。

/**
 * **拒签** —— 签字卡片上「确认签字」旁边的第二个按钮。
 *
 * 为什么驾驶舱要能拒签：签字队列是「人在被交还控制权的那一刻」看的页面。
 * 只能签不能拒，就等于把人赶回终端 —— 驾驶舱在最该起作用的时候失效。
 */
async function doReject(sliceId, btn) {
  btn.disabled = true;
  btn.textContent = '拒签中…';

  const reqs = await apiGet('/api/sign-requests?status=pending' + locQuery(currentLocation));
  const req = reqs.find(function (r) { return r.sliceId === sliceId; });
  if (!req) {
    showBanner('notice bad', '找不到这条切片的待签字请求。');
    btn.disabled = false;
    btn.textContent = '拒签';
    return;
  }

  const comment = window.prompt('拒签理由（可留空）：') || null;
  const res = await apiPost(
    '/api/sign-requests/' + encodeURIComponent(req.id) + '/reject',
    Object.assign({ comment: comment }, locBody(currentLocation))
  );
  if (res.ok && res.body && res.body.ok) {
    await render('signs');
    showBanner('notice ok', '⛔ 已拒签' + (comment ? '：' + comment : '。'));
    return;
  }
  const msg = (res.body && (res.body.error || res.body.reason)) || ('HTTP ' + res.status);
  showBanner('notice bad', '拒签失败：' + msg);
  btn.disabled = false;
  btn.textContent = '拒签';
}

/**
 * **退回重跑 / 退回上游**（ADR-094 §5.1）—— 签字卡片上的两个按钮。
 *
 * 为什么驾驶舱要能「退回」而不只是「签 / 拒」：
 * 「不批准」有三档，各回不同的状态：
 *
 *   | 动作 | 切片回到 | 意思 |
 *   |---|---|---|
 *   | 退回重跑 | `frozen` | 方向对，代码有问题 → 带着意见重跑 |
 *   | 退回上游 | `draft` | 方向不对 → 规格要改，改完重新冻结 |
 *   | 拒签 | `abandoned` | 整片作废 |
 *
 * 只给「签 / 拒」两个按钮时，人遇到「方向不对但代码没错」只能选拒签
 * —— 把一片不该作废的片作废掉 —— 或者切回终端。
 * 驾驶舱在最该起作用的时候失效。
 *
 * **意见是强制的**：不给意见就让人重跑 = 人自己也不清楚要改什么，
 * 重跑必然白跑（agent 拿到的信息与上一轮完全等价）。
 * 前端也拦一道（空意见不发请求），但**服务端同样强制** ——
 * 前端拦是省一次往返，不是判据。
 *
 * @param mode 'revise' = 退回重跑；'return' = 退回上游
 */
async function doSendBack(sliceId, btn, mode, label) {
  const reqs = await apiGet('/api/sign-requests?status=pending' + locQuery(currentLocation));
  let req = reqs.find(function (r) { return r.sliceId === sliceId; });
  if (!req) {
    // 已批准也能退（ADR-094 D11）—— 「签了字又发现方向不对」才是最该退的。
    const approved = await apiGet('/api/sign-requests?status=approved' + locQuery(currentLocation));
    req = approved.find(function (r) { return r.sliceId === sliceId; });
  }
  if (!req) {
    showBanner('notice bad', '找不到这条切片的可退签字请求（待签或已批准都没有）。');
    return;
  }

  const promptText = mode === 'revise'
    ? '要改什么？（规格不动，带着这条意见重跑）'
    : '方向哪里不对？（片会回到 draft，规格可以改了）';
  const comment = window.prompt(promptText);
  if (comment === null) return; // 人取消了 —— 不当成空意见
  if (!comment.trim()) {
    showBanner('notice bad', label + '必须带意见 —— 没有意见，重跑必然白跑。');
    return;
  }

  btn.disabled = true;
  btn.textContent = label + '中…';

  const res = await apiPost(
    '/api/sign-requests/' + encodeURIComponent(req.id) + '/' + mode,
    Object.assign({ comment: comment.trim() }, locBody(currentLocation))
  );
  if (res.ok && res.body && res.body.ok) {
    await render(currentView);
    showBanner('notice ok', '↩️ 已' + label + '。');
    // 「批准被连带作废」这件事**必须明说** —— 不能悄悄做。
    if (res.body.revokedApproval) {
      showBanner('notice bad', '⚠️ 此前的批准已被作废 —— 否则它仍可被合并。');
    }
    if (res.body.nextStep) showBanner('notice', res.body.nextStep);
    return;
  }
  const msg = (res.body && (res.body.error || res.body.reason)) || ('HTTP ' + res.status);
  showBanner('notice bad', label + '失败：' + msg);
  btn.disabled = false;
  btn.textContent = label + '…';
}

/**
 * **回答 agent 的提问** —— 切片详情页里的一个输入框。
 *
 * 只**记录**答案，不续跑（ADR-084 §1.1）：
 * 续跑要拉起 agent 会话，驾驶舱不该在 HTTP 请求里挂着它。
 * 答案记下后，提示人去终端跑 zelto answer 完成续跑。
 */
async function doAnswer(sliceId, input, btn) {
  const text = input.value.trim();
  if (!text) {
    showBanner('notice bad', '答案为空。');
    return;
  }
  btn.disabled = true;
  btn.textContent = '提交中…';

  const res = await apiPost('/api/slices/' + encodeURIComponent(sliceId) + '/answer', Object.assign({
    answer: text
  }, locBody(currentLocation)));
  if (res.ok && res.body && res.body.ok) {
    input.value = '';
    showBanner('notice ok', '✅ 答案已记录。');
    showBanner('notice', res.body.nextStep || '');
    await render(currentView);
    return;
  }
  const msg = (res.body && (res.body.error || res.body.reason)) || ('HTTP ' + res.status);
  showBanner('notice bad', '提交答案失败：' + msg);
  btn.disabled = false;
  btn.textContent = '提交答案';
}

/**
 * 提问卡片 —— 带类型徽标、候选选项、恢复状态。
 *
 * 为什么要把 `type` / `options` 显示出来：
 *
 *  - **type**（`spec_gap` / `choice` / `blocker`）决定这件事**急不急** ——
 *    `blocker` 意味着 agent 已经卡住等这句话，
 *    而 `spec_gap` 可能只是一条记录。人分不出这个区别，
 *    就会把所有提问当成同一优先级 —— 那样「该先答哪个」又变成了人猜。
 *  - **options** 是 agent 给的**候选答案** ——
 *    只给一个空输入框，等于要人凭空想起有哪些可能。
 *    点一下就答，是最省步数的路径。
 *
 * 选候选项**不自动提交** —— 先填进输入框，让人确认/改写再发。
 * 直接一点就提交 = 人还没看清就把答案交出去了。
 */
function renderQuestionBox(sliceId, q) {
  const box = el('div', 'notice question-box');

  // ── 头部：类型 + 状态 ──
  const head = el('div', 'q-head');
  head.appendChild(el('span', 'q-type ' + (q.type || 'unknown'), questionTypeLabel(q.type)));
  if (q.severity) {
    head.appendChild(el('span', 'q-sev ' + q.severity, q.severity === 'blocking' ? '阻塞中' : '不阻塞'));
  }
  head.appendChild(el('span', 'muted small', '问于 ' + (q.askedAt ? new Date(q.askedAt).toLocaleString() : '—')));
  // 恢复状态 —— 答完之后能不能接着聊，靠的是会话 id 在不在。
  head.appendChild(el('span', 'muted small',
    q.agentSessionId ? '可恢复会话' : '无会话可恢复（只能记录答案）'));
  box.appendChild(head);

  box.appendChild(el('div', 'q-text', q.question || q.text || q.prompt || '(问题内容为空)'));

  // ── 候选答案 ──
  const options = Array.isArray(q.options) ? q.options : [];
  if (options.length > 0) {
    const opts = el('div', 'q-options');
    for (const opt of options) {
      const chip = el('button', 'q-option', opt);
      chip.type = 'button';
      chip.title = '点一下填进输入框（确认后再提交）';
      chip.addEventListener('click', function () {
        const input = box.querySelector('.answer-input');
        if (input) { input.value = opt; input.focus(); }
      });
      opts.appendChild(chip);
    }
    box.appendChild(opts);
  }

  // ── 回答 ──
  const row = el('div', 'answer-row');
  const input = el('input', 'answer-input');
  input.type = 'text';
  input.placeholder = '你的回答…';
  const send = el('button', 'btn', '提交答案');
  send.addEventListener('click', function () { doAnswer(sliceId, input, send); });
  row.appendChild(input);
  row.appendChild(send);
  box.appendChild(row);

  return box;
}

/** 提问类型 → 中文标签。 */
function questionTypeLabel(type) {
  const map = {
    spec_gap: '规格缺口',
    choice: '选择题',
    blocker: '阻塞'
  };
  return map[type] || type || '提问';
}

// ── ADR-086：油门（冻结 / 门禁 / 开跑 / 续跑）───────────────────────────
//
// 共同纪律（ADR-084 §2 / ADR-086 §1）：
// **前端不重写任何判定** —— 按钮只负责发请求、只负责把服务端回来的话显示出来。
// 「能不能做」「为什么不能做」全部由服务端的 core 编排决定。
//
// 前端**能**做的唯一一件事是「按状态把不该点的按钮置灰」——
// 那不是判定，那是把服务端一定会拒绝的动作提前说清楚，省人一次等待。

/**
 * 按切片状态渲染四个油门按钮。
 *
 * 置灰规则与服务端 core 的准入规则一一对应（ADR-086 §2）：
 *   - 冻结：draft / clarifying 可冻结；frozen 可「重新冻结」（改规格后）
 *   - 门禁：frozen 才能验（门禁要验的是「冻结基线上的产物」）
 *   - 开跑：frozen / completed 可跑
 *   - 续跑：只有停机片才需要续跑
 *
 * **置灰只是提示，不是门** —— 服务端照样会拒。前端猜错了也只是
 * 「按钮亮着但点了被拒」，反过来（该亮的没亮）才是真问题，
 * 所以规则宁可保守。
 */
function renderThrottleButtons(row, sliceId, slice, summary) {
  clear(row);
  const state = slice.state;
  const stalled = !!(summary && summary.stalled);

  // ── 冻结 ────────────────────────────────────────────────────────────
  if (state === 'draft' || state === 'clarifying') {
    const b = el('button', 'btn', '❄ 冻结规格');
    b.addEventListener('click', function () { doFreeze(sliceId, b, false); });
    row.appendChild(b);
  } else if (state === 'frozen') {
    // 已冻结 —— 「重新冻结」是改规格后的正常路径（最常见是扩写集）。
    // 不给这个路径，那个切片就永久卡住（规格改了、哈希对不上、又冻不了）。
    const b = el('button', 'btn', '❄ 重新冻结');
    b.addEventListener('click', function () { doFreeze(sliceId, b, true); });
    row.appendChild(b);
  }

  // ── 门禁 ────────────────────────────────────────────────────────────
  if (state === 'frozen') {
    const b = el('button', 'btn', '🛡 跑门禁');
    b.addEventListener('click', function () { doGate(sliceId, b); });
    row.appendChild(b);
  }

  // ── 开跑 ────────────────────────────────────────────────────────────
  if (state === 'frozen' || state === 'completed') {
    const b = el('button', 'btn ok', '▶ 开跑');
    b.addEventListener('click', function () { doRun(sliceId, b); });
    row.appendChild(b);
  }

  // ── 续跑 ────────────────────────────────────────────────────────────
  if (stalled) {
    const b = el('button', 'btn', '↻ 续跑');
    b.addEventListener('click', function () { doResume(sliceId, b); });
    row.appendChild(b);
  }

  // 一个按钮都不该出现时，说清为什么 —— 否则人以为驾驶舱坏了。
  if (row.childNodes.length === 0) {
    row.appendChild(el('span', 'muted',
      '当前状态（' + state + '）下没有可执行的动作 —— 动作按状态开放，不摆不能用的按钮。'));
  }
}

/**
 * 详情页的「状态 / 活性 / 进度 / 花费」小块。
 *
 * 与列表页同源（服务端算一次，前端不另猜）——
 * liveness / progressLine / elapsedMs 全是服务端读的现场。
 */
function renderLiveBox(box, summary) {
  clear(box);
  if (!summary) return;
  const row = el('div', 'check');
  row.appendChild(el('span', 'label', '状态'));
  row.appendChild(el('span', null, summary.state));
  // 停机是独立于 state 的事实（ADR-047）：state 回到 frozen 可重跑，
  // stall 仍记着上次跑挂了。详情页要说出来，否则「frozen」会被读成「没跑过」。
  if (summary.stalled) {
    row.appendChild(document.createTextNode(' '));
    const w = el('span', 'badge live-stale', '⚠ 停机');
    w.title = '上次运行被停机（' + (summary.stallClass || '原因未分类') + '）—— 可重跑 / 续跑';
    row.appendChild(w);
  }
  // liveBadge / costCell / progressCell 返回的是**节点**，不是文本 ——
  // 必须 appendChild。传给 el() 的 text 会被 String() 成 "[object HTMLSpanElement]"
  // （2026-11-19 实测：详情页那一块真的显示了这串东西）。
  row.appendChild(liveBadge(summary));
  box.appendChild(row);

  if (summary.state === 'running') {
    const prog = progressCell(summary);
    if (prog) {
      const r2 = el('div', 'check');
      r2.appendChild(el('span', 'label', '进度'));
      r2.appendChild(prog);
      box.appendChild(r2);
    }
  }

  const cost = el('div', 'check');
  cost.appendChild(el('span', 'label', '花费'));
  cost.appendChild(costCell(summary));
  box.appendChild(cost);
}

/**
 * 详情页的小轮询 —— 只刷新那一小块，不动页面其余部分。
 *
 * 为什么不复用全局轮询：全局轮询在详情页是停用的（免得刷掉人正在看的内容）。
 * 但「点了开跑然后盯着看」正是驾驶舱最有用的场景 ——
 * 人盯着一个不动的页面会怀疑 agent 卡死（本可避免的焦虑）。
 *
 * 轮询失败**保留旧内容** —— 一次抖动不该把现场清空。
 */
let detailPollTimer = null;
function startDetailPolling(sliceId, box) {
  stopDetailPolling();
  detailPollTimer = setInterval(function () {
    apiGet('/api/slices/' + encodeURIComponent(sliceId) + locQuery(currentLocation)).then(function (d) {
      renderLiveBox(box, d.summary);
      noteConnected();
    }).catch(function (err) {
      if (isConnectionError(err)) noteDisconnected(err);
    });
  }, 3000);
}
function stopDetailPolling() {
  if (detailPollTimer) {
    clearInterval(detailPollTimer);
    detailPollTimer = null;
  }
}

/**
 * **冻结** —— 把规格钉成基线。
 *
 * 与 CLI zelto freeze 同一份编排（服务端 core/lifecycle/freeze.ts）。
 */
async function doFreeze(sliceId, btn, refreeze) {
  btn.disabled = true;
  btn.textContent = refreeze ? '重新冻结中…' : '冻结中…';
  const res = await apiPost('/api/slices/' + encodeURIComponent(sliceId) + '/freeze',
    Object.assign(refreeze ? { refreeze: true } : {}, locBody(currentLocation)));
  if (res.ok && res.body && res.body.ok) {
    showBanner('notice ok', '✅ ' + (res.body.reason || '已冻结'));
    await showSliceDetail(sliceId);
    return;
  }
  showFreezeFailure(res, btn, refreeze);
}

/** 冻结失败时把「哪条写集被挡了」说出来 —— 那是人能直接动手的地方。 */
function showFreezeFailure(res, btn, refreeze) {
  const body = res.body || {};
  const details = body.details || [];
  const advisories = body.advisories || [];
  const msg = (body.error || body.reason) || ('HTTP ' + res.status);
  showBanner('notice bad', '❌ ' + msg);
  for (const d of details) showBanner('notice bad', '· ' + d);
  for (const a of advisories) showBanner('notice', '· ' + a);
  btn.disabled = false;
  btn.textContent = refreeze ? '❄ 重新冻结' : '❄ 冻结规格';
}

/**
 * **门禁** —— 验冻结基线上的产物。
 *
 * 与 CLI zelto gate 同一份编排（服务端 core/lifecycle/gate.ts）。
 */
async function doGate(sliceId, btn) {
  btn.disabled = true;
  btn.textContent = '门禁运行中…';
  const res = await apiPost('/api/slices/' + encodeURIComponent(sliceId) + '/gate', locBody(currentLocation));
  if (res.ok && res.body && res.body.ok) {
    showBanner('notice ok', '✅ ' + (res.body.reason || '门禁通过'));
    const facts = res.body.facts || {};
    if (facts.signRequestId) {
      showBanner('notice', '已发出签字请求 —— 去「待签字」页签逐片确认。');
    }
    await showSliceDetail(sliceId);
    return;
  }
  const body = res.body || {};
  const msg = (body.error || body.reason) || ('HTTP ' + res.status);
  showBanner('notice bad', '❌ ' + msg);
  for (const d of (body.details || [])) showBanner('notice bad', '· ' + d);
  btn.disabled = false;
  btn.textContent = '🛡 跑门禁';
}

/**
 * **开跑** —— 起一个后台 agent（fire-and-forget）。
 *
 * 关键：**HTTP 请求不挂着 agent 会话**（ADR-086 §3）。
 * 服务端拉起独立的监督进程（zelto run --detach），
 * 请求立刻返回，进度在详情页那块小面板上自己更新。
 */
async function doRun(sliceId, btn) {
  btn.disabled = true;
  btn.textContent = '起跑中…';
  const res = await apiPost('/api/slices/' + encodeURIComponent(sliceId) + '/run', locBody(currentLocation));
  if (res.ok && res.body && res.body.ok) {
    showBanner('notice ok', '🚀 ' + (res.body.reason || '已在后台起跑'));
    if (res.body.nextStep) showBanner('notice', res.body.nextStep);
    await showSliceDetail(sliceId);
    return;
  }
  const body = res.body || {};
  const msg = (body.error || body.reason) || ('HTTP ' + res.status);
  showBanner('notice bad', '❌ 起跑失败：' + msg);
  btn.disabled = false;
  btn.textContent = '▶ 开跑';
}

/**
 * **续跑** —— 恢复一片停机的切片。
 *
 * 三个选项对应 CLI 的三个旗标。这里用 confirm 一次问清楚 ——
 * 「放弃」是不可逆的（abandoned 是终态），不该由一个误点的按钮决定。
 */
async function doResume(sliceId, btn) {
  btn.disabled = true;
  const choice = window.confirm(
    '续跑这片停机的切片：\n\n' +
    '确定 = 恢复以便重跑（保留停机记录）\n' +
    '取消 = 放弃这片（不可逆）\n\n' +
    '想「只标记已解决、不重跑」请用终端：zelto resume ' + sliceId + ' --skip'
  );
  if (choice === null) {
    btn.disabled = false;
    btn.textContent = '↻ 续跑';
    return;
  }
  const res = await apiPost('/api/slices/' + encodeURIComponent(sliceId) + '/resume',
    Object.assign(choice ? {} : { abandon: true }, locBody(currentLocation)));
  if (res.ok && res.body && res.body.ok) {
    showBanner('notice ok', '✅ ' + (res.body.reason || '已恢复'));
    for (const a of (res.body.advisories || [])) showBanner('notice', '· ' + a);
    await showSliceDetail(sliceId);
    return;
  }
  const body = res.body || {};
  const msg = (body.error || body.reason) || ('HTTP ' + res.status);
  showBanner('notice bad', '❌ 续跑失败：' + msg);
  btn.disabled = false;
  btn.textContent = '↻ 续跑';
}

/**
 * **拉闸** —— 顶栏按钮（ADR-084）。
 *
 * 拉闸是**刹车**：把控制权从 agent 手里收回来。
 *
 * 驾驶舱现在刹车油门都有（ADR-086 补上了 freeze / gate / run / resume），
 * 但**拉闸的语义没变** —— 它只交回控制权，不推进任何东西。
 */
async function doHalt(btn) {
  const reason = window.prompt('拉闸原因（可留空）：', '人工拉闸');
  // prompt 返回 null = 人点了「取消」—— 那就不该有任何副作用。
  if (reason === null) return;

  btn.disabled = true;
  const res = await apiPost('/api/halt', { scope: 'all', reason: reason || '人工拉闸' });
  if (res.ok && res.body && res.body.ok) {
    showBanner('notice ok', '⏸ 已拉闸 —— 批次暂停，控制权交回给你。');
    showBanner('notice', '处理完现场后：zelto halt --clear 解除暂停。');
    await render(currentView);
    return;
  }
  const msg = (res.body && (res.body.error || res.body.reason)) || ('HTTP ' + res.status);
  showBanner('notice bad', '拉闸失败：' + msg);
  btn.disabled = false;
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
  events: viewEvents,
  metrics: viewMetrics,
  stalls: viewStalls,
  policy: viewPolicy,
  budget: viewBudget,
  pipeline: viewPipeline
};

async function render(view) {
  currentView = view;
  // 回到列表视图 —— 详情页的状态不再成立
  inDetail = false;
  // 详情页自己的小轮询也要停 —— 离开详情页后它还在往一个已被清空的
  // DOM 节点里写，那只会白费一次请求（而且可能把连接状态误判为断了）。
  stopDetailPolling();
  // 用户主动切换视图 → 旧提示过期，清掉。
  // （轮询刷新走 refreshSilently，不经过这里 —— 提示要活过轮询。）
  clearBanner();
  // 视图按钮的高亮 —— 范围是 `#nav-list button[data-view]`。
  // 不能用 `nav button`：折叠后 nav 里还有 `#nav-current` 与 `#nav-toggle`，
  // 它们没有 data-view，会被这一句把 className 清空（连「当前视图名」都清掉）。
  for (const b of document.querySelectorAll('#nav-list button[data-view]')) {
    b.className = b.getAttribute('data-view') === view ? 'active' : '';
  }
  // 窄屏折叠态的「当前视图名」—— 人得知道自己站在哪个视图，
  // 否则展开菜单之前是盲的。
  //
  // 它是 `<span aria-live="polite">`（不是按钮）——
  // 2026-11-28 修正：它是**状态播报**，切视图时读屏软件念出新名字。
  // 但 aria-live 只播报「变化」，不解释「这是什么」——
  // 所以还要一个视觉隐藏的前缀（sr-only），让播报变成
  // 「当前视图：总览」而不是干巴巴一个「总览」。
  if (navCurrent) {
    var activeBtn = document.querySelector('#nav-list button[data-view].active');
    var label = activeBtn ? activeBtn.textContent : view;
    clear(navCurrent);
    navCurrent.appendChild(el('span', 'sr-only', '当前视图：'));
    navCurrent.appendChild(document.createTextNode(label));
  }
  clear(main);
  main.appendChild(el('p', 'muted', '加载中…'));
  try {
    await VIEWS[view](main);
  } catch (err) {
    clear(main);
    main.appendChild(el('p', 'notice bad', '加载失败：' + friendlyError(err)));
    // 连接层面的失败要在状态条上也说一声 —— 主区域会被下一次轮询换掉，
    // 但状态条会一直在
    if (isConnectionError(err)) noteDisconnected(err);
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
 *
 * 但整体替换有个副作用：**焦点会丢**（旧节点被丢弃）。
 * 所以替换前后要把焦点放回同一个位置 —— 见下面的 preserveFocus。
 */
/**
 * 记住「焦点落在哪个元素上」—— 用**路径**而不是元素引用。
 *
 * 为什么不用元素引用：轮询会把整块内容重建（clear(main) + 重新 append），
 * 重建后的元素是**新对象** —— 旧引用指向的是已被丢弃的节点。
 * 所以记引用没有意义，要记「位置」。
 *
 * 路径怎么算：从 main 往下数第几个子节点、每个节点第几个子节点。
 * 人正在看的那个表格行、那个按钮，重建后位置不变 ——
 * 于是可以把焦点放回**同一个位置的新节点**上。
 */
function focusPath(node) {
  if (!node || node === document.body) return null;
  const path = [];
  let cur = node;
  while (cur && cur !== document.body && cur.parentNode) {
    const parent = cur.parentNode;
    const idx = Array.prototype.indexOf.call(parent.childNodes, cur);
    path.unshift(idx);
    cur = parent;
  }
  return path.length ? path : null;
}

/** 按路径找回节点（重建后用）。 */
function nodeAtPath(path) {
  let cur = document.body;
  for (const idx of path) {
    if (!cur || !cur.childNodes || !cur.childNodes[idx]) return null;
    cur = cur.childNodes[idx];
  }
  return cur && cur !== document.body ? cur : null;
}

/**
 * 轮询刷新时**保住焦点**。
 *
 * 为什么必须做（2026-11-28 实测）：
 * 轮询每 5 秒把整块内容重建一次（clear(main) + 重新渲染）。
 * 重建 = 旧的 DOM 节点全被丢弃 —— 焦点跟着节点一起没了，
 * 浏览器把焦点退回 body。
 *
 * 实测后果：键盘用户 Tab 到第 12 个切片行，正准备回车打开详情，
 * 5 秒后焦点没了 —— 得重新 Tab 12 次。
 * 更糟的是**读屏用户**：焦点一丢，读屏软件直接停止朗读当前内容。
 *
 * 所以这里在替换内容**之前**记住焦点位置，替换**之后**放回去。
 *
 * 放不回去也没关系（页面结构变了）—— 那时焦点落回 body，
 * 与不加这段代码的现状一样，不算退步。
 */
function preserveFocus() {
  const path = focusPath(document.activeElement);
  return function restore() {
    if (!path) return;
    const node = nodeAtPath(path);
    if (!node || typeof node.focus !== 'function') return;
    try {
      node.focus({ preventScroll: true });
    } catch {
      // 老浏览器不支持 options —— 不带参数再试一次
      try { node.focus(); } catch { /* 放弃就算了 */ }
    }
  };
}

async function refreshSilently(view) {
  const holder = document.createElement('div');
  try {
    await VIEWS[view](holder);
  } catch (err) {
    // 渲染失败 —— 保留屏幕上原有的内容，别把人正在看的东西弄没
    noteDisconnected(err);
    return;
  }
  const restoreFocus = preserveFocus();
  clear(main);
  while (holder.firstChild) main.appendChild(holder.firstChild);
  restoreFocus();
  noteConnected();
  await refreshSummary();
}

// ── 连接状态 ───────────────────────────────────────────────────────────
//
// 为什么要有这个：服务是**前台进程**（ADR-072 §10，不是常驻 daemon），
// Ctrl+C 就停 —— 但浏览器标签页还留在那儿，屏幕上还是上一次渲染的样子。
// 人看着一个「看起来正常但其实已经不更新」的页面，
// 会以为那就是当前状态 —— **这比直接报错更危险**。
//
// 所以：连续若干次拿不到数据，就在横幅上明确说「连接断了」。
// 一次抖动不报（网络本来就会抖），连续失败才算数。

const OFFLINE_AFTER = 3; // 连续失败几次就判定为「断了」
let failStreak = 0;

function noteDisconnected(err) {
  failStreak++;
  if (failStreak < OFFLINE_AFTER) return;
  const msg = friendlyError(err);
  if (conn.dataset.msg === msg) return;
  conn.dataset.msg = msg;
  conn.textContent = '⚠️ 与 zelto 服务的连接已断开：' + msg;
  conn.className = 'banner bad';
  conn.style.display = '';
  // 顶端心跳也要变红 —— 页面中间的内容还是旧的，光靠底部横幅
  // 容易被忽略（尤其是滚动到下方时）
  refreshLine.className = 'small bad';
  clear(refreshLine);
  refreshLine.appendChild(el('span', 'dot'));
  refreshLine.appendChild(el('span', null, '已停止刷新（连接断开）'));
}

function noteConnected() {
  failStreak = 0;
  if (conn.dataset.msg === '') return;
  // 「已复制」那条提示不是连接状态 —— 断线重连后别把它抹掉。
  if (conn.dataset.msg.startsWith('已复制')) return;
  conn.dataset.msg = '';
  conn.textContent = '';
  conn.className = 'banner';
  conn.style.display = 'none';
}

/**
 * 闪一下提示（「已复制：…」）—— 3 秒后自动淡掉。
 *
 * 为什么不用 `window.alert`：它会打断人正在做的事，而且一次动作弹一次框很烦。
 *
 * 为什么不用 `conn` 那条横幅：那是**连接状态**（独占语义，反复更新）。
 * 但这里有个矛盾 —— `conn` 是现成的横幅容器，另造一个又要动 HTML。
 *
 * 折中：**只在连接正常时**借 `conn` 闪一下（连接正常时它本来就是空的），
 * 连接已经断了就不动它（那时它正在说更要紧的话）。
 */
let hintTimer = null;
function flashHint(msg) {
  if (!conn) return;
  // 连接已经断了 —— 那条横幅正在说更要紧的事，别覆盖它。
  if (failStreak > 0) return;
  clearTimeout(hintTimer);
  conn.dataset.msg = msg;
  conn.textContent = msg;
  conn.className = 'banner';
  conn.style.display = '';
  hintTimer = setTimeout(function () {
    // 只清掉自己写的那条 —— 别把期间发生的连接提示抹掉。
    if (conn.dataset.msg !== msg) return;
    conn.dataset.msg = '';
    conn.textContent = '';
    conn.style.display = 'none';
  }, 3000);
}

// ── 概况的共享取数 ──────────────────────────────────────────────────────
//
// 病灶（实测 2026-11-27）：一轮轮询里 `/api/summary` 被取了**两次** ——
//
//   ① `viewOverview()` 取一次（要 `s` 里的计数来渲染卡片）
//   ② `refreshSummary()` 又取一次（要同一份 `s` 里的计数来渲染顶栏那行字）
//
// 两边要的**是同一个响应**。而这个响应不便宜 ——
// 服务端要为 149 片读事件流 + 问 git。
//
// 修法：把取数收敛成**一次**，两个渲染点共用。
//
// 怎么做才不引入「读到过期数据」：
//   - **在飞共享**：同一时刻只发一个请求，后来者等它（`summaryInflight`）
//   - **极短 TTL**：取到后 1 秒内复用（`summaryCachedAt`）
//
// 为什么 TTL 只给 1 秒：`viewOverview` 与 `refreshSummary` 是**同一轮**
// 里前后脚调的，间隔远小于 1 秒 —— 复用窗口只需要覆盖「同一轮」。
// 1 秒之后一定重新取，所以「看到的是最新数据」这件事不受影响。
//
// 为什么不用更长的 TTL：那会把「页面在更新」变成假的 ——
// 顶栏的时间戳在跳，数字却是几十秒前的。
const SUMMARY_TTL_MS = 1000;
let summaryCached = null;
let summaryCachedAt = 0;
let summaryInflight = null;

/**
 * 取 `/api/summary` —— 同一时刻只发一个请求。
 *
 * @param {boolean} fresh 强制重新取（绕过缓存）。
 *   默认 false：短 TTL 内复用上一份。
 */
async function getSummary(fresh) {
  const now = Date.now();
  if (!fresh && summaryCached && now - summaryCachedAt < SUMMARY_TTL_MS) {
    return summaryCached;
  }
  if (summaryInflight) return summaryInflight;
  summaryInflight = apiGet('/api/summary')
    .then(function (s) {
      summaryCached = s;
      summaryCachedAt = Date.now();
      return s;
    })
    .finally(function () {
      summaryInflight = null;
    });
  return summaryInflight;
}

async function refreshSummary() {
  // 工程名只在还没拿到时才重试 —— 第一次可能赶上服务/文件没就绪，
  // 一次性失败不该让标题永远停在「…」（函数内部由 projectLoaded 防重）
  if (!projectLoaded) void loadProjectInfo();
  try {
    const s = await getSummary(false);
    // 在跑 / 可疑 / 已死分开说（D-30）：只报 active 的话，
    // 一片进程早就没了的 running 片会从总览行里彻底消失，人以为一切正常。
    const live = s.live || {};
    const gaveUp = (live.gaveUp || []).length;
    // 「在跑」只算看门狗没放弃的 —— gaveUp 那批进程都没了，算进在跑就是说谎
    const runningNow = (live.active || []).length + (live.stale || []).length - gaveUp;
    let line = s.totalSlices + ' 切片 · ' + s.pendingSignCount + ' 待签字 · ' + s.stalledCount + ' 停机'
      + (runningNow > 0 ? ' · ' + runningNow + ' 在跑' : '');
    if ((live.dead || []).length > 0) line += ' · ' + live.dead.length + ' 已死';
    if (gaveUp > 0) line += ' · ' + gaveUp + ' 需人收（看门狗已停救）';
    summaryLine.textContent = line;
    noteConnected();
  } catch (err) {
    // 概况拿不到不影响主视图 —— 但要记一笔，连续失败会判定为「断了」
    noteDisconnected(err);
    return;
  }
  // 刷新心跳 —— 「页面还在更新」的最直接证据。
  // 只更新时间戳不够显眼：配一个绿点 + 秒级时间，人一眼就能看出它在跳。
  // 断连时（noteDisconnected 已设样式）这一行由 markRefresh 覆盖成告警色。
  markRefresh(false);
  // 服务端自己报一下有没有出过错 —— 见下方 refreshHealth。
  void refreshHealth();
}

/**
 * 问服务端「你出过错没有」。
 *
 * ── 为什么需要这个 ──────────────────────────────────────────────────
 *
 * 人对着一个不动的页面时，有两种完全不同的处境：
 *
 *   ① **服务真的死了** —— 终端窗口被关了 / Ctrl+C 了。
 *      页面连不上，`noteDisconnected` 会报「连接已断开」。
 *   ② **服务活着，但出过一次错** —— 崩溃兜底接住了，
 *      服务继续跑、页面继续刷新，**但数据可能不新鲜**。
 *
 * 原来这两者在人眼里是**同一个画面**：一个不动的页面。
 * 于是人会做同一个动作：关标签页、重新跑 zelto web。
 * 对 ② 来说这是多余的 —— 而且**可能丢掉正开着的东西**
 * （比如那个已经起跑的 agent 的监控页面）。
 *
 * 所以这里让服务端自己报状态：出过错就把顶栏标黄，
 * 并说清「最后出错的时刻与原因」。人一眼能分清该重启还是该等等。
 *
 * 只在出错时才改 DOM —— 没出错就什么都不做，不打扰人。
 */
async function refreshHealth() {
  try {
    const h = await apiGet('/api/health');
    if (!h || !h.crashes) {
      noteHealthy();
      return;
    }
    const last = h.lastCrash || {};
    noteUnhealthy(h.crashes, last);
  } catch (err) {
    // 健康检查拿不到不算「不健康」—— 概况接口还通着就说明服务活着。
    // 这里静默即可，别把噪音混进断连判定。
    void err;
  }
}

/** 服务出过错的提示（顶栏独占一行 —— 与「连接断开」分开）。 */
function noteUnhealthy(count, last) {
  const key = 'crashes:' + count + ':' + (last.at || '');
  if (crashLine.dataset.crashKey === key) return;
  crashLine.dataset.crashKey = key;
  const when = last.at ? new Date(last.at).toLocaleTimeString() : '未知时刻';
  crashLine.textContent =
    '⚠️ 出过错 ' + count + ' 次（最后一次 ' + when + '：' +
    (last.message || '原因不明') +
    '）—— 服务仍在运行，数据可能不新鲜。完整栈见终端。';
  crashLine.className = 'small bad';
  crashLine.title = '驾驶舱出过错，但服务还活着 —— 不必重启 zelto web';
}

/** 服务没出错 —— 撤掉提示。 */
function noteHealthy() {
  if (!crashLine.dataset.crashKey) return;
  crashLine.dataset.crashKey = '';
  crashLine.textContent = '';
  crashLine.className = 'muted small';
}

/**
 * 更新顶端「最后刷新」行。
 *
 * 为什么必须有这件事：轮询是静默的（不清屏、不闪），代价是
 * **页面看起来一动不动**。一个内容没变化的驾驶舱，和一个死掉的页面，
 * 在视觉上完全一样 —— 这正是「误以为死掉」的根源。
 * 一个会走的心跳时间戳把「静默」和「死掉」区分开。
 */
function markRefresh(stale) {
  const now = new Date();
  refreshLine.className = stale ? 'muted small' : 'small';
  clear(refreshLine);
  refreshLine.appendChild(el('span', 'dot'));
  refreshLine.appendChild(el('span', null,
    '最后刷新 ' + now.toLocaleTimeString() + (stale ? '（内容未变）' : '')));
}

/**
 * 加载工程信息 —— 驾驶舱标题必须说清「这是哪个项目」。
 *
 * 同时开几个项目的驾驶舱（各自一个端口）时，标题若只有
 * 「zelto 驾驶舱」，切标签页就分不清哪个是哪个。
 * 只加载一次（工程名不会在会话中途变），失败也不影响其他内容。
 */
let projectLoaded = false;
async function loadProjectInfo() {
  if (projectLoaded) return;
  try {
    const p = await apiGet('/api/project');
    if (p.name) {
      projectName.textContent = p.name;
      document.title = p.name + ' · zelto 驾驶舱';
    }
    if (p.root) {
      projectRoot.textContent = p.root;
      projectRoot.title = p.root;
    }
    projectLoaded = true;
  } catch {
    // 拿不到工程名就保持「…」 —— 不编一个名字
  }
}

// 视图按钮的绑定范围是 `#nav-list button[data-view]` —— **不是** `nav button`。
//
// 为什么（2026-11-28 窄屏导航折叠时踩到的坑）：
// 折叠后 nav 里多了两个按钮 —— `#nav-current`（当前视图名）与 `#nav-toggle`（☰ 菜单）。
// 它们**没有 data-view**，如果用 `nav button` 选中它们，
// 点击就会 `render(null)` —— 直接把视图渲染搞崩。
const viewButtons = document.querySelectorAll('#nav-list button[data-view]');
for (const b of viewButtons) {
  b.addEventListener('click', function () {
    render(b.getAttribute('data-view'));
    // 窄屏下选完视图就收起菜单 —— 否则菜单一直占着屏幕，
    // 把刚选中的视图内容顶到屏幕外。
    closeNavMenu();
  });
}

// ── 窄屏导航折叠（ADR-109 决策四补充，2026-11-28）────────────────────
//
// 实测（390px）：9 个视图按钮 + 拉闸占 **3 行**（约 145px），
// 首屏内容被挤没了。所以窄屏折成「当前视图名 + ☰ 菜单」。
//
// 桌面端（≥721px）：`#nav-toggle` / `#nav-current` 被 CSS 隐藏，
// `#nav-list` 是普通 flex —— **排版与改动前完全一致**。
// 这里的 JS 只是把状态同步好，不影响桌面观感。
const nav = document.getElementById('nav');
const navToggle = document.getElementById('nav-toggle');
const navCurrent = document.getElementById('nav-current');

function closeNavMenu() {
  if (!nav) return;
  nav.classList.remove('open');
  if (navToggle) {
    navToggle.setAttribute('aria-expanded', 'false');
    navToggle.setAttribute('aria-label', '展开视图菜单');
  }
}

if (navToggle && nav) {
  navToggle.addEventListener('click', function () {
    var open = nav.classList.toggle('open');
    navToggle.setAttribute('aria-expanded', open ? 'true' : 'false');
    navToggle.setAttribute('aria-label', open ? '收起视图菜单' : '展开视图菜单');
  });
  // 点菜单外面就收起 —— 手机上没有「点外面」这个概念太别扭了。
  document.addEventListener('click', function (ev) {
    if (!nav.classList.contains('open')) return;
    if (nav.contains(ev.target)) return;
    closeNavMenu();
  });
  // Esc 也收起 —— 键盘用户的惯例。
  document.addEventListener('keydown', function (ev) {
    if (ev.key === 'Escape') closeNavMenu();
  });
}

// ADR-084：顶栏的拉闸按钮 —— 交回控制权是**随时可能需要**的动作，
// 不该藏在某个视图里让人先找到那个视图。
const haltBtn = document.getElementById('halt-btn');
if (haltBtn) {
  haltBtn.addEventListener('click', function () { doHalt(haltBtn); });
}

// 工程名先于一切加载 —— 标题得先正确，别让人看到「…」几分钟
markRefresh(false);
loadProjectInfo();
render('overview');

// 轮询（不是 SSE —— ADR-072 §6：服务端不留连接状态）
pollTimer = setInterval(function () {
  // 「刷新心跳」无条件走 —— 否则进详情页几分钟后顶端时间戳停住，
  // 看着又像页面死了。数据是否刷新是另一回事（下一行）。
  // 断连时**不能**把它刷成绿的：那等于用假心跳掩盖连接已断（比不刷更糟）。
  if (failStreak < OFFLINE_AFTER) markRefresh(false);
  // 停在切片详情页时不轮询 —— 免得把人正在看的内容刷掉
  if (inDetail) return;
  // 上一轮还没跑完就**不发起新一轮** —— 见下方 pollInFlight 的注释。
  if (pollInFlight) return;
  pollInFlight = true;
  refreshSilently(currentView).finally(function () {
    pollInFlight = false;
  });
}, 5000);
