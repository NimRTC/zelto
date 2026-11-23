
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
// 当前是否停在**切片详情页**。
//
// 为什么单独一个变量，而不是看 currentView：
// 详情页是从总览/切片列表点进去的 —— 那时 currentView 仍然是 'overview'，
// 靠它判断「在不在详情页」会判错，于是轮询把详情页整个换掉
// （实测：进详情后 4 秒被刷回总览，人正在看的东西被抢走）。
let inDetail = false;
let pollTimer = null;

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
            onClick: function () { showSliceDetail(x.id); },
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
}

async function viewSlices(target) {
  const slices = await apiGet('/api/slices');
  clear(target);
  target.appendChild(el('h2', null, '全部切片（' + slices.length + '）'));
  target.appendChild(table(
    ['切片', '标题', '状态', '活性 / 进度', '追溯(需/契/测)', '写集', '运行', '花费', '更新'],
    slices.map(function (s) {
      var wd = '';
      if (s.escalated) wd = ' 🚨已上报';
      else if (s.recoveries > 0) wd = ' 自愈' + s.recoveries + '次';
      return {
        onClick: function () { showSliceDetail(s.id); },
        cells: [
          s.id,
          s.title,
          stateBadge(s.state),
          livenessCell(s),
          traceCounts(s.trace),
          String(s.writeCount),
          s.runCount === 0 ? '—' : (s.lastRunOk ? '✅ ' + s.runCount : '❌ ' + s.runCount) + wd,
          costCell(s),
          new Date(s.updatedAt).toLocaleString()
        ]
      };
    })
  ));
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
    const btn = el('button', 'btn ok', '查看并签字');
    btn.addEventListener('click', function () { showSliceDetail(r.sliceId, true); });
    target.appendChild(btn);
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

async function showSliceDetail(id, forSign) {
  clear(main);
  inDetail = true;
  const back = el('button', 'back', '← 返回');
  back.addEventListener('click', function () { stopDetailPolling(); render(currentView); });
  main.appendChild(back);

  let d;
  try {
    d = await apiGet('/api/slices/' + encodeURIComponent(id));
  } catch (err) {
    main.appendChild(el('p', 'notice bad', '加载失败：' + friendlyError(err)));
    if (isConnectionError(err)) noteDisconnected(err);
    return;
  }

  const slice = d.slice;
  main.appendChild(el('h2', null, id + ' — ' + slice.title));

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
    const pending = await apiGet('/api/questions?status=pending&slice=' + encodeURIComponent(id));
    if (pending && pending.length > 0) {
      main.appendChild(el('h2', null, 'agent 在问你'));
      for (const q of pending) {
        const box = el('div', 'notice');
        box.appendChild(el('div', null, q.question || q.text || q.prompt || '(问题内容为空)'));
        const row = el('div', 'answer-row');
        const input = el('input', 'answer-input');
        input.type = 'text';
        input.placeholder = '你的回答…';
        const send = el('button', 'btn', '提交答案');
        send.addEventListener('click', function () { doAnswer(id, input, send); });
        row.appendChild(input);
        row.appendChild(send);
        box.appendChild(row);
        main.appendChild(box);
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

  // ── 审计 ────────────────────────────────────────────────────────────
  //
  // ADR-072 §1 摘要里驾驶舱含「审计」，§6 端点表也列了
  // GET /api/slices/:id/audit —— 但之前前端从没调用过它。
  // 端点实现了却没人用，等于没实现（ADR-010 §5.4 详情页的「📋 审计」按钮）。
  main.appendChild(el('h2', null, '审计'));
  try {
    const audit = await apiGet('/api/slices/' + encodeURIComponent(id) + '/audit');
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

  // 先找这条切片的 pending 签字请求
  const reqs = await apiGet('/api/sign-requests?status=pending');
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
    { checks: checks || [] }
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

  const reqs = await apiGet('/api/sign-requests?status=pending');
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
    { comment: comment }
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

  const res = await apiPost('/api/slices/' + encodeURIComponent(sliceId) + '/answer', {
    answer: text
  });
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
    apiGet('/api/slices/' + encodeURIComponent(sliceId)).then(function (d) {
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
    refreeze ? { refreeze: true } : {});
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
  const res = await apiPost('/api/slices/' + encodeURIComponent(sliceId) + '/gate', {});
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
  const res = await apiPost('/api/slices/' + encodeURIComponent(sliceId) + '/run', {});
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
    choice ? {} : { abandon: true });
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
  for (const b of document.querySelectorAll('nav button')) {
    b.className = b.getAttribute('data-view') === view ? 'active' : '';
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
 */
async function refreshSilently(view) {
  const holder = document.createElement('div');
  try {
    await VIEWS[view](holder);
  } catch (err) {
    // 渲染失败 —— 保留屏幕上原有的内容，别把人正在看的东西弄没
    noteDisconnected(err);
    return;
  }
  clear(main);
  while (holder.firstChild) main.appendChild(holder.firstChild);
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
  conn.dataset.msg = '';
  conn.textContent = '';
  conn.className = 'banner';
  conn.style.display = 'none';
}

async function refreshSummary() {
  // 工程名只在还没拿到时才重试 —— 第一次可能赶上服务/文件没就绪，
  // 一次性失败不该让标题永远停在「…」（函数内部由 projectLoaded 防重）
  if (!projectLoaded) void loadProjectInfo();
  try {
    const s = await apiGet('/api/summary');
    summaryLine.textContent = s.totalSlices + ' 切片 · ' + s.pendingSignCount + ' 待签字 · ' + s.stalledCount + ' 停机' +
      (s.live && s.live.active && s.live.active.length ? ' · ' + s.live.active.length + ' 在跑' : '');
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

for (const b of document.querySelectorAll('nav button')) {
  b.addEventListener('click', function () { render(b.getAttribute('data-view')); });
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
  refreshSilently(currentView);
}, 5000);
