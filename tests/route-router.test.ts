// Tests for Router

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { Router } from '../src/core/route/router.js';

describe('Router', () => {
  it('registers and dispatches a handler', async () => {
    const router = new Router();
    router.register('hello', async (args) => {
      assert.deepEqual(args, ['world']);
      return 0;
    });

    const code = await router.dispatch('hello', ['world']);
    assert.equal(code, 0);
  });

  it('throws on duplicate registration', () => {
    const router = new Router();
    router.register('test', async () => 0);
    assert.throws(() => router.register('test', async () => 0), /already registered/);
  });

  it('allows replace with registerOrReplace', async () => {
    const router = new Router();
    router.register('greet', async () => 0);
    router.registerOrReplace('greet', async () => 42);
    const code = await router.dispatch('greet', []);
    assert.equal(code, 42);
  });

  it('matches exact command', () => {
    const router = new Router();
    router.register('status', async () => 0);

    const match = router.match('status');
    assert.ok(match);
    assert.equal(match?.route.name, 'status');
    assert.deepEqual(match?.args, []);
  });

  it('matches command with args', () => {
    const router = new Router();
    router.register('require', async () => 0);

    const match = router.match('require confirm req-123');
    assert.ok(match);
    assert.equal(match?.route.name, 'require');
    assert.deepEqual(match?.args, ['confirm', 'req-123']);
  });

  it('returns null for unknown command', () => {
    const router = new Router();
    const match = router.match('nonexistent');
    assert.equal(match, null);
  });

  it('lists registered routes', () => {
    const router = new Router();
    router.register('a', async () => 0, 'Command A');
    router.register('b', async () => 0, 'Command B');
    router.register('c', async () => 0);

    const routes = router.list();
    assert.equal(routes.length, 3);
    assert.ok(routes.some((r) => r.name === 'a' && r.description === 'Command A'));
    assert.ok(routes.some((r) => r.name === 'c' && r.description === undefined));
  });

  it('checks route existence', () => {
    const router = new Router();
    router.register('exists', async () => 0);
    assert.equal(router.has('exists'), true);
    assert.equal(router.has('missing'), false);
  });

  it('removes a route', () => {
    const router = new Router();
    router.register('temp', async () => 0);
    assert.equal(router.has('temp'), true);

    const removed = router.remove('temp');
    assert.equal(removed, true);
    assert.equal(router.has('temp'), false);
  });

  it('clears all routes', () => {
    const router = new Router();
    router.register('x', async () => 0);
    router.register('y', async () => 0);
    assert.equal(router.size, 2);

    router.clear();
    assert.equal(router.size, 0);
  });

  it('throws on dispatch of unknown route', async () => {
    const router = new Router();
    await assert.rejects(
      () => router.dispatch('unknown', []),
      /Unknown command/,
    );
  });

  it('tracks route count', () => {
    const router = new Router();
    assert.equal(router.size, 0);
    router.register('a', async () => 0);
    assert.equal(router.size, 1);
    router.register('b', async () => 0);
    assert.equal(router.size, 2);
  });
});
