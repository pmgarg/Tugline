/**
 * Liveness (EAG S16: "make sure your silence and your death never look the
 * same"). The daemon rewrites heartbeat.json every `heartbeatMs`; a reader
 * calls a heartbeat older than `staleMs` dead, so a missing beat is the alarm,
 * not an absence of news.
 */
import path from 'node:path';
import { readJson, scheduleDir, writeJsonAtomic } from './store.js';

export interface Heartbeat {
  pid: number;
  startedAt: string;
  beatAt: string;
  host?: string;
  url?: string;
}

export const heartbeatFile = (home: string) => path.join(scheduleDir(home), 'heartbeat.json');

export function beat(home: string, hb: Omit<Heartbeat, 'beatAt'>, now = new Date()): Heartbeat {
  const rec = { ...hb, beatAt: now.toISOString() };
  writeJsonAtomic(heartbeatFile(home), rec);
  return rec;
}

export function liveness(home: string, staleMs: number, now = new Date()): { ok: boolean; status: 'alive' | 'stale' | 'never'; ageMs?: number; heartbeat?: Heartbeat } {
  const hb = readJson<Heartbeat | undefined>(heartbeatFile(home), undefined);
  if (!hb) return { ok: false, status: 'never' };
  const ageMs = now.getTime() - new Date(hb.beatAt).getTime();
  return ageMs <= staleMs ? { ok: true, status: 'alive', ageMs, heartbeat: hb } : { ok: false, status: 'stale', ageMs, heartbeat: hb };
}
