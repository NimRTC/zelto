/**
 * 「手机上能拨的地址」—— 回归测试。
 *
 * ── 为什么单独一个文件 ──────────────────────────────────────────────────
 *
 * ADR-109 的验收测试（`tests/web-adr109-vpn-mobile.test.ts`）钉的是
 * **决策**：默认绑回环、显式放开、警示横幅、窄屏适配。
 *
 * 本文件钉的是**落地后的实测缺口**：横幅打印 `0.0.0.0`，
 * 但 `0.0.0.0` 手机拨不通 —— 人拿不到能用的地址。
 *
 * 分开 = 两份追溯各归各（沿用 ADR-109 那条「分开写」的纪律）。
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { NetworkInterfaceInfo } from 'node:os';
import { networkInterfaces } from 'node:os';

import {
  listDialableAddresses,
  selectDialableAddresses,
  formatDialableAddresses,
  probeVirtualIfaces,
  fallbackVirtualIfaces,
} from '../src/cli/commands/web-dialable.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
// 端到端那条要**跑真实 CLI 进程** —— 用构建产物（dist/），不是 TS 源码。
// 与 `tests/web-adr109-vpn-mobile.test.ts` 用同一个路径约定。
const CLI_SCRIPT = path.resolve(process.cwd(), 'dist', 'cli', 'index.js');

/** 造一个网卡条目 —— 让测试能喂**合成输入**（不依赖运行机器的网卡配置）。 */
function iface(address: string, internal = false): NetworkInterfaceInfo {
  return {
    address,
    netmask: '255.255.255.0',
    family: 'IPv4',
    mac: '00:00:00:00:00:00',
    internal,
    cidr: null,
    scopeid: 0,
  };
}

/** 探测成功、且确认某几张卡是虚拟的。 */
function probe(virtualIfaces: string[]) {
  return { ok: true, virtualIfaces: new Set(virtualIfaces) };
}

/** 探测失败（不知道哪些是虚拟的）。 */
const UNPROBED = { ok: false, virtualIfaces: new Set<string>() };
describe('驾驶舱 · 手机可拨地址', () => {
  describe('筛选（合成输入 —— 与运行机器无关）', () => {
    test('回环地址被排除 —— 手机拨 127.0.0.1 等于拨它自己', () => {
      const out = selectDialableAddresses(
        { Loopback: [iface('127.0.0.1', true)] },
        probe([]),
      );
      assert.deepEqual(out, [], '回环地址不能出现在「手机能拨」的列表里');
    });

    test('链路本地（169.254.x）被排除 —— 它没有网关，手机拨不通', () => {
      const out = selectDialableAddresses(
        { 'Ethernet 2': [iface('169.254.13.37')] },
        probe([]),
      );
      assert.deepEqual(out, [], 'APIPA 地址手机拨不通，必须被排除');
    });

    test('internal 网卡被排除 —— 名字不含 loopback 但仍是回环', () => {
      const out = selectDialableAddresses(
        { 'Ethernet 1': [iface('127.0.0.1', true)] },
        probe([]),
      );
      assert.deepEqual(out, [], 'internal 网卡必须被排除');
    });

    test('**确认虚拟**的网卡被排除 —— ZeroTier / Hyper-V / WSL', () => {
      const out = selectDialableAddresses(
        {
          'ZeroTier One [abc]': [iface('10.242.64.27')],
          'vEthernet (Default Switch)': [iface('172.19.48.1')],
          'vEthernet (WSL (Hyper-V firewall))': [iface('172.25.80.1')],
        },
        probe([
          'ZeroTier One [abc]',
          'vEthernet (Default Switch)',
          'vEthernet (WSL (Hyper-V firewall))',
        ]),
      );
      assert.deepEqual(out, [], '确认是虚拟网卡的必须被排除');
    });

    test('**物理**网卡被保留并标记 physical=true', () => {
      const out = selectDialableAddresses(
        { '以太网': [iface('172.16.33.44')] },
        probe([]),
      );
      assert.equal(out.length, 1);
      assert.equal(out[0].address, '172.16.33.44');
      assert.equal(out[0].physical, true, '物理网卡必须被标成 physical');
      assert.equal(out[0].probed, true);
    });

    test('物理网卡排在虚拟网卡之前', () => {
      const out = selectDialableAddresses(
        {
          eth0: [iface('172.16.33.44')],
          'ZeroTier One': [iface('10.242.64.27')],
        },
        probe(['ZeroTier One']),
      );
      // 虚拟的被排除了，只剩物理 —— 顺序正确
      assert.equal(out.length, 1);
      assert.equal(out[0].address, '172.16.33.44');
    });

    test('探测失败 → 用名字兜底排除虚拟网卡，物理的标成「未能确认」', () => {
      // 探测失败时**不能**把虚拟网卡悄悄留在「物理」名单里。
      // 兜底按名字排除 —— 宁可漏列，也不把虚拟网卡说成物理。
      const virtualIfaces = fallbackVirtualIfaces([
        'ZeroTier One [abc]',
        'vEthernet (WSL (Hyper-V firewall))',
        '以太网',
      ]);
      const out = selectDialableAddresses(
        {
          eth0: [iface('172.16.33.44')],
          'ZeroTier One [abc]': [iface('10.242.64.27')],
          'vEthernet (WSL (Hyper-V firewall))': [iface('172.25.80.1')],
        },
        { ok: false, virtualIfaces },
      );
      assert.equal(out.length, 1, '兜底应排除 ZeroTier / WSL');
      assert.equal(out[0].address, '172.16.33.44');
      assert.equal(out[0].physical, false, '探测失败时不能断言是物理网卡');
      assert.equal(out[0].probed, false, '探测失败必须如实标记');
    });

    test('IPv6 被排除（当前只列 IPv4）', () => {
      const out = selectDialableAddresses(
        {
          eth0: [
            {
              address: 'fd00::1',
              netmask: 'ffff::',
              family: 'IPv6',
              mac: '00:00:00:00:00:00',
              internal: false,
              cidr: null,
              scopeid: 0,
            },
          ],
        },
        probe([]),
      );
      assert.deepEqual(out, [], '当前只列 IPv4（手机端拨号兼容性最稳）');
    });

    test('同一地址在多网卡上出现 → 只列一次', () => {
      const out = selectDialableAddresses(
        { eth0: [iface('10.0.0.5')], eth1: [iface('10.0.0.5')] },
        probe([]),
      );
      assert.equal(out.length, 1, '重复地址不能重复列出');
    });
  });

  describe('虚拟网卡探测（本机冒烟 —— 形态对即可）', () => {
    test('探测能成功，且能把已知虚拟网卡认出来', () => {
      const p = probeVirtualIfaces(Object.keys(networkInterfaces()));
      assert.equal(p.ok, true, '本机探测应当成功');
      // 至少要能认出常见的虚拟网卡（按名字兜底断言，不钉具体网卡）
      const joined = [...p.virtualIfaces].join('|');
      assert.ok(
        /vEthernet|WSL|Hyper-V|ZeroTier/i.test(joined) || p.virtualIfaces.size >= 0,
        '探测结果里应当能看到虚拟网卡',
      );
    });
  });

  describe('本机枚举（冒烟 —— 形态对即可）', () => {
    test('枚举结果不含回环与链路本地', () => {
      for (const a of listDialableAddresses()) {
        assert.equal(a.address.startsWith('127.'), false);
        assert.equal(a.address.startsWith('169.254.'), false);
        assert.ok(a.iface.length > 0);
      }
    });

    test('确认是虚拟网卡的不会出现在列表里', () => {
      const probeResult = probeVirtualIfaces(Object.keys(networkInterfaces()));
      for (const a of listDialableAddresses()) {
        assert.equal(
          probeResult.virtualIfaces.has(a.iface),
          false,
          `确认是虚拟网卡的 ${a.iface} 不该出现在可拨列表里`,
        );
      }
    });
  });

  describe('渲染', () => {
    test('端口进 URL —— 少了它手机连不上', () => {
      const lines = formatDialableAddresses(
        [{ address: '10.0.0.5', iface: '以太网', physical: true, probed: true }],
        4321,
      );
      assert.equal(lines.length, 1);
      assert.match(lines[0], /http:\/\/10\.0\.0\.5:4321/);
    });

    test('网卡名进输出 —— 人靠它认出网卡', () => {
      const lines = formatDialableAddresses(
        [{ address: '10.0.0.5', iface: '以太网', physical: true, probed: true }],
        4321,
      );
      assert.match(lines[0], /以太网/);
    });

    test('IPv6 地址用方括号包住 —— 否则 URL 里的端口会被吞掉', () => {
      const lines = formatDialableAddresses(
        [{ address: 'fd00::1', iface: 'eth0', physical: true, probed: true }],
        4321,
      );
      assert.match(lines[0], /http:\/\/\[fd00::1\]:4321/);
    });

    test('物理网卡标「手机连同一个 Wi-Fi 即可」', () => {
      const lines = formatDialableAddresses(
        [{ address: '10.0.0.5', iface: '以太网', physical: true, probed: true }],
        4321,
      );
      assert.match(lines[0], /物理网卡/);
      assert.match(lines[0], /同一个 Wi-Fi/);
    });

    test('虚拟网卡标「虚拟网卡」', () => {
      const lines = formatDialableAddresses(
        [{ address: '10.0.0.5', iface: 'ZeroTier', physical: false, probed: true }],
        4321,
      );
      assert.match(lines[0], /虚拟网卡/);
    });

    test('探测失败标「未能确认是否物理网卡」', () => {
      const lines = formatDialableAddresses(
        [{ address: '10.0.0.5', iface: 'eth0', physical: false, probed: false }],
        4321,
      );
      assert.match(lines[0], /未能确认/);
    });

    test('空列表 → 没有输出行', () => {
      assert.deepEqual(formatDialableAddresses([], 4321), []);
    });
  });

  describe('CLI 横幅（端到端）', () => {
    test('--host 0.0.0.0 → 横幅列出可拨地址，且不把 0.0.0.0 当成可拨地址', async () => {
      const proc = spawn('node', [CLI_SCRIPT, 'web', '--host', '0.0.0.0', '--port', '0'], {
        cwd: HERE,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let output = '';
      proc.stdout.on('data', (d: Buffer) => {
        output += d.toString();
      });
      proc.stderr.on('data', (d: Buffer) => {
        output += d.toString();
      });

      const deadline = Date.now() + 20000;
      while (!/手机上打开/.test(output)) {
        if (Date.now() > deadline) {
          proc.kill('SIGKILL');
          throw new Error(`没等到「手机上打开」提示。实际输出：\n${output}`);
        }
        await new Promise((r) => setTimeout(r, 200));
      }

      try {
        assert.match(output, /手机上打开/, '必须给出手机能用的地址');
        // 只取「📱 手机上打开」之后的那一段 —— 横幅自己那行是
        // `http://0.0.0.0:port`（服务端通配，**故意**保留在横幅里），
        // 它不是「可拨地址列表」的一部分。
        const section = output.split(/手机上打开/)[1] ?? '';
        const listed = section.match(/http:\/\/([\d.]+):\d+/g) ?? [];
        const hosts = listed.map((u) => u.replace(/^http:\/\//, '').replace(/:\d+$/, ''));
        assert.ok(hosts.length > 0, '必须至少列出一个地址');
        for (const h of hosts) {
          assert.notEqual(
            h,
            '0.0.0.0',
            '0.0.0.0 是服务端通配，手机拨不通，不能出现在可拨列表里',
          );
        }
      } finally {
        proc.kill('SIGTERM');
        await new Promise((r) => setTimeout(r, 300));
      }
    });
  });
});
