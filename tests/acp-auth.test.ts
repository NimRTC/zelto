// ACP 的鉴权层 —— 「认出需要登录，并给出可执行的修法」（ADR-133 落地补充）
//
// 这个文件钉住的是**实测得来的**事实（2026-11-27，`cursor-agent acp`）：
//
//   - `initialize` 回包里带 `authMethods`（cursor-agent 报 `cursor_login`）；
//   - 没登录时 `session/new` 返回
//     「Authentication required. Please run 'agent login' first, ...」。
//
// 原来的实现把这句话原样透传成「ACP 会话失败：Authentication required」——
// 说的是事实，但人不知道该做什么。
//
// 另外钉住一条**边界**：zelto **不替用户登录**。
// 登录是浏览器授权流程（`agent login`），涉及人自己的账号 ——
// zelto 抢在前面做既看不见弹窗也点不了。

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  describeAuthMethods,
  detectAuthRequired,
  extractAuthMethods,
} from '../src/adapters/acp/auth.js';

describe('extractAuthMethods —— 从 initialize 回包里抽鉴权方式', () => {
  it('抽到 cursor-agent 那种回包', () => {
    const methods = extractAuthMethods({
      authMethods: [
        {
          id: 'cursor_login',
          name: 'Cursor Login',
          description: "Authenticate using existing Cursor login credentials. Run 'agent login' first if not logged in.",
        },
      ],
    });
    assert.equal(methods.length, 1);
    assert.equal(methods[0].id, 'cursor_login');
    assert.equal(methods[0].name, 'Cursor Login');
    assert.match(String(methods[0].description), /agent login/);
  });

  it('agent 不报 authMethods → 空数组（不是「要登录」）', () => {
    assert.deepEqual(extractAuthMethods({}), []);
    assert.deepEqual(extractAuthMethods({ authMethods: null }), []);
    assert.deepEqual(extractAuthMethods(null), []);
    assert.deepEqual(extractAuthMethods(undefined), []);
  });

  it('丢掉没有 id 的条目（不能拿空 id 去 authenticate）', () => {
    const methods = extractAuthMethods({
      authMethods: [{ id: '', name: 'bad' } as never, { id: 'ok', name: 'OK' }],
    });
    assert.equal(methods.length, 1);
    assert.equal(methods[0].id, 'ok');
  });

  it('缺 name 时用 id 顶上', () => {
    const methods = extractAuthMethods({ authMethods: [{ id: 'x' } as never] });
    assert.equal(methods[0].name, 'x');
  });
});

describe('detectAuthRequired —— 认出「需要登录」并给修法', () => {
  it('认出 cursor-agent 的原话', () => {
    const msg =
      "Authentication required. Please run 'agent login' first, then call authenticate() with methodId 'cursor_login'.";
    const hint = detectAuthRequired(msg, [
      { id: 'cursor_login', name: 'Cursor Login', description: 'Run agent login' },
    ]);
    assert.ok(hint, '应认出是鉴权问题');
    assert.match(hint, /需要先登录/);
    assert.match(hint, /cursor_login/, '要把登录方式说出来');
    assert.match(hint, /agent login/, '要把 agent 自己的说明带出来');
  });

  it('说明「zelto 不代你登录」', () => {
    const hint = detectAuthRequired('Authentication required', []);
    assert.ok(hint);
    assert.match(hint, /不代你登录|不替/i);
  });

  it('不是鉴权问题 → 返回 null（照原样报错，不猜）', () => {
    assert.equal(detectAuthRequired('Connection reset', []), null);
    assert.equal(detectAuthRequired('protocol version mismatch', []), null);
    assert.equal(detectAuthRequired('tool call failed', []), null);
  });

  it('其它常见措辞也认得', () => {
    for (const m of ['not authenticated', 'Unauthenticated', 'AUTHENTICATION REQUIRED']) {
      assert.ok(detectAuthRequired(m, []), `应认出：${m}`);
    }
  });

  it('没有 authMethods 时也认得出（只是没有具体方式）', () => {
    const hint = detectAuthRequired('Authentication required', []);
    assert.ok(hint);
    assert.match(hint, /需要先登录/);
    assert.doesNotMatch(hint, /methodId/, '没报方式就不该编一个');
  });
});

describe('describeAuthMethods —— 几条就说几条', () => {
  it('多条登录方式都列出来', () => {
    const text = describeAuthMethods([
      { id: 'a', name: 'A', description: null },
      { id: 'b', name: 'B', description: 'desc B' },
    ]);
    assert.match(text, /a/);
    assert.match(text, /b/);
    assert.match(text, /desc B/);
  });

  it('空 → 空字符串', () => {
    assert.equal(describeAuthMethods([]), '');
  });
});
