// reservation 命令 — 查看与释放写集预约
//
// 预约是「切片只允许写自己 writes 内路径」这件事的运行时凭据（C9）。
// agent 跑的时候 hook 读它来判定越界；跑完了由 zelto 释放。
//
// 这个命令存在的原因是：预约落在 .zelto/locks/<sliceId>.json 里，
// 如果 zelto 崩了，预约会留在盘上 —— 下一个切片就取不到预约了。
// `zelto reservation reap` 按 pid 判定僵尸预约并清理。

import { resolve } from 'node:path';
import {
  ReservationStore,
  isProcessAlive,
  reapStaleReservations,
} from '../../core/sched/index.js';
import { events } from './shared.js';

function store(): ReservationStore {
  return new ReservationStore(resolve(process.cwd(), '.zelto', 'locks'));
}

function printReservation(r: {
  sliceId: string;
  writes: string[];
  worktree: string | null;
  projectRoot: string;
  acquiredAt: string;
  releasedAt: string | null;
  pid: number;
}): void {
  const status = r.releasedAt
    ? `released ${r.releasedAt}`
    : isProcessAlive(r.pid)
      ? `active (pid ${r.pid})`
      : `STALE (pid ${r.pid} is gone)`;
  console.log(`  ${r.sliceId}`);
  console.log(`    status:   ${status}`);
  console.log(`    writes:   ${r.writes.join(', ') || '(empty)'}`);
  console.log(`    worktree: ${r.worktree ?? '(project root)'}`);
  console.log(`    acquired: ${r.acquiredAt}`);
}

export async function reservationCommand(args: string[]): Promise<number> {
  const [action = 'list', target] = args;
  const reservations = store();

  switch (action) {
    case 'list': {
      const all = await reservations.list();
      if (all.length === 0) {
        console.log('No write-set reservations.');
        return 0;
      }
      console.log('Write-set reservations:');
      for (const r of all) printReservation(r);
      return 0;
    }

    case 'active': {
      const active = await reservations.active();
      if (active.length === 0) {
        console.log('No active write-set reservations.');
        return 0;
      }
      console.log('Active write-set reservations:');
      for (const r of active) printReservation(r);
      return 0;
    }

    case 'show': {
      if (!target) {
        console.error('Usage: zelto reservation show <slice-id>');
        return 1;
      }
      const r = await reservations.read(target);
      if (!r) {
        console.error(`No reservation for slice "${target}".`);
        return 1;
      }
      printReservation(r);
      return 0;
    }

    case 'release': {
      if (!target) {
        console.error('Usage: zelto reservation release <slice-id>');
        return 1;
      }
      const released = await reservations.release(target);
      if (!released) {
        console.error(`No reservation for slice "${target}".`);
        return 1;
      }
      await events.append(target, 'reservation.released', 'cli', {
        sliceId: target, reason: 'manual release',
      });
      console.log(`✅ Released reservation for "${target}".`);
      return 0;
    }

    case 'reap': {
      const reaped = await reapStaleReservations(reservations);
      if (reaped.length === 0) {
        console.log('No stale reservations.');
        return 0;
      }
      for (const id of reaped) {
        await events.append(id, 'reservation.released', 'cli', {
          sliceId: id, reason: 'stale — owning process is gone',
        });
        console.log(`✅ Reaped stale reservation for "${id}".`);
      }
      return 0;
    }

    default:
      console.error('Usage: zelto reservation [list|active|show|release|reap] [slice-id]');
      return 1;
  }
}
