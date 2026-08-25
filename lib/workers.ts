/**
 * Manajemen Karyawan / Pekerja (tabel worker) dinamis.
 */
import { neon } from '@neondatabase/serverless';

type Sql = ReturnType<typeof neon>;

export interface WorkerInfo {
  id: number;
  name: string;
  role: 'produksi' | 'antar';
  rateType: 'per_resep' | 'per_pcs' | 'per_hari';
  rateRp: number;
  active: boolean;
  status: 'aktif' | 'rencana_belum_final';
}

export interface WorkerCtx {
  workers: WorkerInfo[];
  workerMap: Map<string, WorkerInfo>;
  productionWorkers: WorkerInfo[];
}

const TTL_MS = 30_000;
let _cachedWorkers: { at: number; rows: WorkerInfo[] } | null = null;

export async function getWorkers(sql: Sql, fresh = false): Promise<WorkerInfo[]> {
  if (!fresh && _cachedWorkers && Date.now() - _cachedWorkers.at < TTL_MS) {
    return _cachedWorkers.rows;
  }

  const rows = (await sql`
    SELECT id, name, role, rate_type, rate_rp, active, status
    FROM worker
    ORDER BY id
  `) as Record<string, unknown>[];

  const list: WorkerInfo[] = rows.map((r) => ({
    id: Number(r.id),
    name: String(r.name),
    role: (r.role === 'antar' ? 'antar' : 'produksi') as 'produksi' | 'antar',
    rateType: (r.rate_type === 'per_pcs' || r.rate_type === 'per_hari'
      ? r.rate_type
      : 'per_resep') as 'per_resep' | 'per_pcs' | 'per_hari',
    rateRp: Number(r.rate_rp ?? 0),
    active: r.active === true,
    status: (r.status === 'rencana_belum_final' ? 'rencana_belum_final' : 'aktif') as
      | 'aktif'
      | 'rencana_belum_final',
  }));

  _cachedWorkers = { at: Date.now(), rows: list };
  return list;
}

export function invalidateWorkers(): void {
  _cachedWorkers = null;
}

/**
 * Normalisasi alias panggilan pekerja
 */
export const WORKER_ALIASES: Record<string, string> = {
  adek: 'adek',
  aril: 'adek',
  adik: 'adek',
  'diri_sendiri': 'diri_sendiri',
  zummy: 'diri_sendiri',
  sendiri: 'diri_sendiri',
  saya: 'diri_sendiri',
  aku: 'diri_sendiri',
  ayah: 'ayah',
  bapak: 'ayah',
  papa: 'ayah',
  bibi: 'bibi',
  tante: 'bibi',
};

export function buildWorkerCtx(workers: WorkerInfo[]): WorkerCtx {
  const map = new Map<string, WorkerInfo>();
  for (const w of workers) {
    map.set(w.name.toLowerCase(), w);
  }

  // Tambahkan mapping alias
  for (const [alias, canonical] of Object.entries(WORKER_ALIASES)) {
    const target = map.get(canonical.toLowerCase());
    if (target && !map.has(alias.toLowerCase())) {
      map.set(alias.toLowerCase(), target);
    }
  }

  const productionWorkers = workers.filter(
    (w) => w.active && w.role === 'produksi' && w.status === 'aktif',
  );

  return {
    workers,
    workerMap: map,
    productionWorkers,
  };
}

/**
 * Hitung upah untuk tiap worker yang terlibat dalam produksi
 */
export function calculateWagesForProduction(
  assignedWorkers: WorkerInfo[],
  recipes: number,
  piecesPerRecipe: number,
): { workerAllocations: { workerId: number; recipes: number; wageRp: number }[]; totalWageRp: number } {
  const allocations = assignedWorkers.map((w) => {
    let wage = 0;
    if (w.rateType === 'per_resep') {
      wage = w.rateRp * recipes;
    } else if (w.rateType === 'per_pcs') {
      wage = w.rateRp * (recipes * piecesPerRecipe);
    }
    return {
      workerId: w.id,
      recipes,
      wageRp: Math.round(wage),
    };
  });

  const totalWageRp = allocations.reduce((sum, a) => sum + a.wageRp, 0);
  return { workerAllocations: allocations, totalWageRp };
}

export async function upsertWorker(
  sql: Sql,
  data: {
    name: string;
    role: 'produksi' | 'antar';
    rateType: 'per_resep' | 'per_pcs' | 'per_hari';
    rateRp: number;
    status?: 'aktif' | 'rencana_belum_final';
  },
): Promise<void> {
  const normName = data.name.trim().toLowerCase().replace(/\s+/g, '_');
  await sql`
    INSERT INTO worker (name, role, rate_type, rate_rp, active, status, updated_at)
    VALUES (${normName}, ${data.role}, ${data.rateType}, ${data.rateRp}, true, ${data.status ?? 'aktif'}, now())
    ON CONFLICT (name) DO UPDATE
      SET role = EXCLUDED.role,
          rate_type = EXCLUDED.rate_type,
          rate_rp = EXCLUDED.rate_rp,
          active = true,
          status = COALESCE(EXCLUDED.status, worker.status),
          updated_at = now()
  `;
  invalidateWorkers();
}

export async function setWorkerStatus(
  sql: Sql,
  name: string,
  status: 'aktif' | 'rencana_belum_final',
): Promise<boolean> {
  const normName = name.trim().toLowerCase().replace(/\s+/g, '_');
  const r = (await sql`
    UPDATE worker
    SET status = ${status},
        updated_at = now()
    WHERE lower(name) = ${normName}
    RETURNING id
  `) as Record<string, unknown>[];
  invalidateWorkers();
  return r.length > 0;
}
