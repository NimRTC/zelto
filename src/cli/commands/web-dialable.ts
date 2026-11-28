/**
 * 驾驶舱对外可达时，打印**手机上真正能拨的地址**。
 *
 * ── 为什么需要这个文件 ──────────────────────────────────────────────────
 *
 * `zelto web --host 0.0.0.0` 之后，启动横幅打印的是
 * `http://0.0.0.0:4321`。**这个地址手机拨不通** ——
 * `0.0.0.0` 是「绑定到所有网卡」的**服务端**通配，不是客户端可拨的目标地址。
 *
 * 实测（本机物理网卡 172.16.33.44）：
 *   - `http://172.16.33.44:62096/` → **200 可达**
 *   - `http://0.0.0.0:62096/`       → **连接失败**
 *
 * 所以人看到 `0.0.0.0` 之后，必须自己想办法知道台式机的局域网 IP
 * （看路由器 / 看 `ipconfig`），然后自己拼 URL。
 * 这是 ADR-109 落地后的**实测可用性缺口** —— 决策本身是对的，
 * 但「显式 --host」这条链路的最后一步（把地址告诉人）还差一截。
 *
 * ── 为什么放在 `cli/` 而不是 `core/` ────────────────────────────────────
 *
 * C2：`core/` 零第三方运行时依赖、且不得 import `adapters/`。
 * 这里只读网卡信息，只用 Node 内置（`node:os` / `node:child_process`），
 * 不涉及任何判定，也不写任何状态 —— 放 `cli/` 是合适的。
 *
 * ── 「物理网卡」怎么判 ──────────────────────────────────────────────────
 *
 * **不用名字猜**（`vEthernet` / `WSL` / `Hyper-V` 关键字那套）——
 * 名字是**厂商自由发挥**的：ZeroTier 的虚拟口叫「ZeroTier One」，
 * 不含任何「虚拟」字样，按名字猜会把它当物理网卡。
 *
 * 实测证据（本机）：
 *   - `Win32_NetworkAdapter` 说 ZeroTier 是 `PhysicalAdapter = TRUE` ← **不可信**
 *   - `Get-NetAdapter` 说 ZeroTier 是 `Virtual = True` ← **可信**
 *   - 唯一物理网卡是 `Realtek PCIe GbE Family Controller`（以太网）
 *
 * 所以判据按平台分：
 *   - **Windows**：`Get-NetAdapter` 的 `Virtual` 属性（系统自己的权威判定）
 *   - **Linux**：`/sys/class/net/<if>/device` 符号链接存在 = 真实设备
 *   - **macOS**：`networksetup -listallhardwareports` 列出的硬件端口
 *   - **其它 / 探测失败**：退回「不排除」—— 见下
 *
 * ── 探测失败时为什么不退回「按名字猜」 ──────────────────────────────────
 *
 * 猜名字 = 猜错 = 人拿到一个连不上的地址。
 * 探测失败时的正确做法是**列全部候选并标注「无法确认是否物理」**，
 * 让人自己认领 —— 这与 ADR-109「把选择权交还给人」的口径一致。
 */

import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { networkInterfaces, type NetworkInterfaceInfo } from 'node:os';

/** 单个候选地址。 */
export interface DialableAddress {
  /** 地址本身。 */
  address: string;
  /** 网卡名 —— 让人能认出「这个是 ZeroTier 的」。 */
  iface: string;
  /**
   * 是否**确认**是物理网卡。
   *
   * `true` = 系统明确说它是真实硬件（网卡名会带「(物理)」标记）。
   * `false` = 虚拟网卡，**或**探测失败没能确认。
   */
  physical: boolean;
  /** 探测是否**成功** —— 区分「确认是虚拟」与「没探测出来」。 */
  probed: boolean;
}

// ── 平台探测 ─────────────────────────────────────────────────────────────

/**
 * 探测结果：**哪些网卡名是虚拟的**。
 *
 * 用集合返回而不是逐个布尔，是为了在探测失败时能**区分**
 * 「确认虚拟」与「不知道」—— 这两种情况在输出里的措辞完全不同。
 */
export interface VirtualProbe {
  /** 探测成功了吗？ */
  ok: boolean;
  /** 确认是虚拟网卡的网卡名。 */
  virtualIfaces: Set<string>;
}

/** Windows：用 `Get-NetAdapter` 的 `Virtual` 属性。 */
function probeWindows(): VirtualProbe {
  // 为什么用 `-not $_.Virtual` 而不是取反的名字列表 ——
  // `Get-NetAdapter` 的 `Virtual` 属性是系统自己的权威判定，
  // 覆盖 Hyper-V / WSL / VPN / 桥接等等所有虚拟网卡。
  //
  // 为什么输出「IP|名字」而不是 JSON —— 网卡名可能是中文，
  // 经过 PowerShell → Node 的编码链路容易出乱码；
  // 而这条命令只在 Windows 上跑（本仓库主要开发环境），
  // 出乱码时人仍能从 IP 那半边认出是哪个地址。
  const ps = [
    '[Console]::OutputEncoding=[Text.Encoding]::UTF8;',
    'Get-NetAdapter | ForEach-Object {',
    '  $n=$_.Name; $v=$_.Virtual; $s=$_.Status;',
    '  "$v|$s|$n"',
    '}',
  ].join(' ');
  try {
    const out = execFileSync('powershell', ['-NoProfile', '-Command', ps], {
      encoding: 'utf8',
      timeout: 8000,
      windowsHide: true,
    });
    const virtualIfaces = new Set<string>();
    for (const line of out.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      // 格式：`True|Up|网卡名` —— 名字里可能含 `|`，所以只拆前两段
      const first = trimmed.indexOf('|');
      if (first === -1) continue;
      const second = trimmed.indexOf('|', first + 1);
      if (second === -1) continue;
      const isVirtual = trimmed.slice(0, first) === 'True';
      const name = trimmed.slice(second + 1);
      if (isVirtual) virtualIfaces.add(name);
    }
    return { ok: true, virtualIfaces };
  } catch {
    return { ok: false, virtualIfaces: new Set() };
  }
}

/** Linux：`/sys/class/net/<if>/device` 符号链接存在 = 真实设备。 */
function probeLinux(ifaceNames: string[]): VirtualProbe {
  const virtualIfaces = new Set<string>();
  for (const name of ifaceNames) {
    if (!existsSync(`/sys/class/net/${name}/device`)) {
      virtualIfaces.add(name);
    }
  }
  return { ok: true, virtualIfaces };
}

/** macOS：`networksetup -listallhardwareports` 列出的是硬件端口。 */
function probeDarwin(ifaceNames: string[]): VirtualProbe {
  try {
    const out = execFileSync('networksetup', ['-listallhardwareports'], {
      encoding: 'utf8',
      timeout: 8000,
    });
    // 输出形如：
    //   Hardware Port: Wi-Fi
    //   Device: en0
    //   Ethernet Address: ...
    const hardwareDevices = new Set<string>();
    for (const line of out.split(/\r?\n/)) {
      const m = line.match(/^\s*Device:\s*(\S+)/);
      if (m) hardwareDevices.add(m[1]);
    }
    const virtualIfaces = new Set<string>();
    for (const name of ifaceNames) {
      if (!hardwareDevices.has(name)) virtualIfaces.add(name);
    }
    return { ok: true, virtualIfaces };
  } catch {
    return { ok: false, virtualIfaces: new Set() };
  }
}

/**
 * 探测哪些网卡是虚拟的。
 *
 * @param ifaceNames 本机所有网卡名
 */
export function probeVirtualIfaces(ifaceNames: string[]): VirtualProbe {
  if (process.platform === 'win32') return probeWindows();
  if (process.platform === 'linux') return probeLinux(ifaceNames);
  if (process.platform === 'darwin') return probeDarwin(ifaceNames);
  return { ok: false, virtualIfaces: new Set() };
}

// ── 探测失败时的兜底：名字关键字 ─────────────────────────────────────────
//
// 为什么需要兜底：主判据是**系统权威**（`Get-NetAdapter` 的 `Virtual`），
// 但它可能失败（老系统、权限不足、命令被策略禁用）。
//
// 兜底**只用来「保守地排除」**，不用来「保守地认定物理」：
// 命中关键字的 → 排除（宁可不列，也不把虚拟网卡说成物理）；
// 没命中的 → **仍然列为「未能确认」**，不硬说它是物理。
//
// 这样两层的行为一致：**任何一层都不会把虚拟网卡标成物理**。
const VIRTUAL_NAME_FALLBACK = [
  /vethernet/i,
  /hyper-v/i,
  /\bwsl\b/i,
  /docker/i,
  /vmware/i,
  /virtualbox/i,
  /bluetooth/i,
  /loopback/i,
  /zerotier/i,
  /tailscale/i,
  /wireguard/i,
  /openvpn/i,
  /tap|tun\d/i,
  /singfor|ssl\s*vpn/i,
];

/**
 * 探测失败时用名字关键字兜底。
 *
 * @returns 兜底后「确认虚拟」的网卡名集合
 */
export function fallbackVirtualIfaces(ifaceNames: string[]): Set<string> {
  const out = new Set<string>();
  for (const name of ifaceNames) {
    if (VIRTUAL_NAME_FALLBACK.some((re) => re.test(name))) out.add(name);
  }
  return out;
}

// ── 地址枚举 ─────────────────────────────────────────────────────────────

/**
 * 从网卡表里筛出**候选地址** —— 纯函数，不读操作系统状态。
 *
 * ── 为什么把筛选逻辑抽成纯函数 ──────────────────────────────────────────
 *
 * `networkInterfaces()` 的结果**依赖运行机器**：测试机上有没有
 * `169.254.x` 网卡、叫什么名字、有没有 ZeroTier —— 各不相同。
 *
 * 如果筛选逻辑直接写在读系统状态的函数里，那么
 * 「链路本地被排除了吗」这条断言在**大多数机器上是空的**
 * （压根没有 169.254 网卡 → 断言永远通过 → 改坏了也测不出来）。
 *
 * 抽成纯函数之后，测试可以**喂合成输入**：
 * 造一个叫 `Ethernet 2` 的 169.254 网卡进去，断言它被排掉 ——
 * 这条断言在任何机器上都**真的在测东西**。
 *
 * @param ifaces 网卡表 —— 形如 `node:os` 的 `networkInterfaces()` 返回值
 * @param probe 虚拟网卡探测结果
 */
export function selectDialableAddresses(
  ifaces: Record<string, NetworkInterfaceInfo[] | undefined>,
  probe: VirtualProbe,
): DialableAddress[] {
  const out: DialableAddress[] = [];
  const seen = new Set<string>();

  for (const [name, entries] of Object.entries(ifaces)) {
    if (!entries) continue;
    // 确认是虚拟网卡的直接跳过 —— 手机在同网段也拨不通它
    // （Hyper-V / WSL / Docker 的网关地址是给虚拟机用的；
    //  ZeroTier 那种 VPN 虚拟网卡也不该出现在「连同一个 Wi-Fi 即可」的清单里）
    //
    // 注意：**不看 `probe.ok`** —— `virtualIfaces` 在探测失败时
    // 已经由名字兜底填充过了。那种情况下也要排除，
    // 否则兜底就白做了。
    const confirmedVirtual = probe.virtualIfaces.has(name);
    if (confirmedVirtual) continue;
    for (const e of entries) {
      // Node 18+ 的 family 是字符串 'IPv4'；更早是数字 4。两种都认。
      if (e.family !== 'IPv4' && (e.family as unknown) !== 4) continue;
      if (e.internal) continue;
      // 链路本地（169.254.x）—— 手机拨不通（没有路由/网关）
      if (e.address.startsWith('169.254.')) continue;
      if (seen.has(e.address)) continue;
      seen.add(e.address);
      out.push({
        address: e.address,
        iface: name,
        physical: probe.ok && !confirmedVirtual,
        probed: probe.ok,
      });
    }
  }

  // 物理网卡优先，其余按地址字符串排序（稳定输出）
  out.sort((a, b) => {
    if (a.physical !== b.physical) return a.physical ? -1 : 1;
    return a.address.localeCompare(b.address);
  });

  return out;
}

/**
 * 枚举本机**手机可能拨通**的地址。
 *
 * 这是 `selectDialableAddresses` 的「读系统状态」外壳 ——
 * 判定逻辑全在纯函数里，本函数只负责取数。
 */
export function listDialableAddresses(): DialableAddress[] {
  const ifaces = networkInterfaces();
  const ifaceNames = Object.keys(ifaces);
  const probe = probeVirtualIfaces(ifaceNames);
  // 探测失败 → 用名字关键字兜底（保守排除，绝不硬说「物理」）
  const effective: VirtualProbe = probe.ok
    ? probe
    : { ok: false, virtualIfaces: fallbackVirtualIfaces(ifaceNames) };
  return selectDialableAddresses(ifaces, effective);
}

/**
 * 把候选地址渲染成**给人看的一行行**。
 *
 * 为什么单独抽一个函数：渲染逻辑要**能单测**，
 * 而 `networkInterfaces()` 的结果**依赖运行机器**（不可测）。
 * 拆开之后，渲染可以喂固定的输入测。
 */
export function formatDialableAddresses(
  addrs: DialableAddress[],
  port: number,
): string[] {
  if (addrs.length === 0) return [];
  const lines: string[] = [];
  for (const a of addrs) {
    // IPv6 要方括号 —— 否则 URL 里的端口会被当成 IPv6 地址的一部分
    const host = a.address.includes(':') ? `[${a.address}]` : a.address;
    // 三种措辞，必须让人一眼分清：
    //   - 物理网卡 → 「手机连这个」（有线上网，手机同 Wi-Fi 即可）
    //   - 虚拟网卡 → 标注虚拟（人知道那是 VPN / 虚拟网卡）
    //   - 没探测出来 → 标注「未确认」
    const mark = !a.probed
      ? ' ← 未能确认是否物理网卡'
      : a.physical
        ? ' ← 物理网卡（手机连同一个 Wi-Fi 即可）'
        : ' ← 虚拟网卡';
    lines.push(`      http://${host}:${port}   (${a.iface})${mark}`);
  }
  return lines;
}
