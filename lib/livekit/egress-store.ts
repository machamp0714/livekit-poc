export type EgressStatus = 'starting' | 'active' | 'ended' | 'failed';

export interface EgressRecord {
  egressId: string;
  roomName: string;
  status: EgressStatus;
  filepath: string;
  startedAt: number;
  endedAt?: number;
  durationSec?: number;
  fileSize?: number;
}

const byId = new Map<string, EgressRecord>();
const latestIdByRoom = new Map<string, string>();

export function recordStart(
  init: Omit<EgressRecord, 'startedAt'> & { startedAt?: number },
): EgressRecord {
  const rec: EgressRecord = { ...init, startedAt: init.startedAt ?? Date.now() };
  byId.set(rec.egressId, rec);
  latestIdByRoom.set(rec.roomName, rec.egressId);
  return rec;
}

export function recordUpdate(
  egressId: string,
  patch: Partial<EgressRecord>,
): EgressRecord | null {
  const cur = byId.get(egressId);
  if (!cur) return null;
  const next = { ...cur, ...patch };
  byId.set(egressId, next);
  return next;
}

export function getByRoom(roomName: string): EgressRecord | null {
  const id = latestIdByRoom.get(roomName);
  return id ? byId.get(id) ?? null : null;
}

export function clearStore(): void {
  byId.clear();
  latestIdByRoom.clear();
}

