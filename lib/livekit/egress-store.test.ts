import { beforeEach, describe, expect, it } from 'vitest';
import {
  clearStore,
  getByRoom,
  recordStart,
  recordUpdate,
} from './egress-store';

beforeEach(() => clearStore());

describe('egress-store', () => {
  it('start で room→record を引ける', () => {
    recordStart({
      egressId: 'eg-1',
      roomName: 'r1',
      status: 'starting',
      filepath: 'livekit-poc/r1/1.mp4',
    });
    expect(getByRoom('r1')?.egressId).toBe('eg-1');
  });

  it('update で部分更新される', () => {
    recordStart({
      egressId: 'eg-2',
      roomName: 'r2',
      status: 'starting',
      filepath: 'p.mp4',
    });
    recordUpdate('eg-2', { status: 'ended', durationSec: 12.5 });
    const rec = getByRoom('r2');
    expect(rec?.status).toBe('ended');
    expect(rec?.durationSec).toBe(12.5);
    expect(rec?.filepath).toBe('p.mp4'); // 残っていること
  });

  it('未知の egressId への update は null を返す', () => {
    expect(recordUpdate('missing', { status: 'ended' })).toBeNull();
  });

  it('同一ルームに2回 start すると最新が引ける', () => {
    recordStart({
      egressId: 'eg-a',
      roomName: 'r3',
      status: 'starting',
      filepath: 'a.mp4',
    });
    recordStart({
      egressId: 'eg-b',
      roomName: 'r3',
      status: 'starting',
      filepath: 'b.mp4',
    });
    expect(getByRoom('r3')?.egressId).toBe('eg-b');
  });
});

