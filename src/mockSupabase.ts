// src/mockSupabase.ts
// In-Memory-Mock für Supabase — ausschließlich für NODE_ENV=test + SUPABASE_MOCK=true.
// Wird nie in Production-Code eingebunden.

interface LicenseRecord {
  id:                  number;
  code:                string;
  module:              string;
  duration:            string;
  activated:           boolean;
  device_id:           string | null;
  activated_at:        string | null;
  expires_at:          string | null;
  kundenname:          string | null;
  reset_requested_at:  string | null;
  created_at:          string;
}

// ─── Test-Fixtures ────────────────────────────────────────────────────────────

const INITIAL_LICENSES: LicenseRecord[] = [
  {
    id: 1,
    code: "TEST-ACTIVE-DEVICE-001",
    module: "complete",
    duration: "lifetime",
    activated: true,
    device_id: "known-test-device-id",
    activated_at: "2026-04-01T00:00:00.000Z",
    expires_at: null,
    kundenname: "Test Kunde A",
    reset_requested_at: null,
    created_at: "2026-04-01T00:00:00.000Z",
  },
  {
    id: 2,
    code: "TEST-NOTACT-NODEV-002",
    module: "property",
    duration: "monthly",
    activated: false,
    device_id: null,
    activated_at: null,
    expires_at: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(),
    kundenname: null,
    reset_requested_at: null,
    created_at: "2026-09-01T00:00:00.000Z",
  },
  {
    id: 3,
    code: "TEST-EXPIRED-LICS-003",
    module: "nk",
    duration: "monthly",
    activated: true,
    device_id: "expired-device",
    activated_at: "2026-05-01T00:00:00.000Z",
    expires_at: "2026-06-01T00:00:00.000Z",  // abgelaufen
    kundenname: null,
    reset_requested_at: null,
    created_at: "2026-05-01T00:00:00.000Z",
  },
  {
    id: 4,
    code: "TEST-RESETPEND-ACT-004",
    module: "complete",
    duration: "lifetime",
    activated: true,
    device_id: "pending-reset-device",
    activated_at: "2026-08-01T00:00:00.000Z",
    expires_at: null,
    kundenname: "Test Kunde B",
    reset_requested_at: "2026-09-10T10:00:00.000Z",
    created_at: "2026-08-01T00:00:00.000Z",
  },
];

let db: LicenseRecord[] = JSON.parse(JSON.stringify(INITIAL_LICENSES));
let nextId = 100;

export function resetMockDb(): void {
  db = JSON.parse(JSON.stringify(INITIAL_LICENSES));
  nextId = 100;
}

// ─── Mock-Query-Builder ───────────────────────────────────────────────────────

type Operation = "select" | "insert" | "update";
type FilterFn = (row: LicenseRecord) => boolean;

class MockBuilder {
  private op: Operation = "select";
  private filters: FilterFn[] = [];
  private insertData?: Partial<LicenseRecord>;
  private updateData?: Partial<LicenseRecord>;
  private selectFields?: string;
  private limitN?: number;
  private orderField?: string;
  private orderAsc = true;
  private returnSingle = false;
  private returnMaybe = false;

  // ── Mutations ──

  select(fields?: string): this {
    // select() nach insert()/update() setzt nur die Rückgabefelder, nicht den Op-Typ.
    // Nur beim ersten Aufruf (op=select default) wird op auf "select" gesetzt.
    if (this.op !== "insert" && this.op !== "update") {
      this.op = "select";
    }
    this.selectFields = fields;
    return this;
  }

  insert(data: Partial<LicenseRecord>): this {
    this.op = "insert";
    this.insertData = data;
    return this;
  }

  update(data: Partial<LicenseRecord>): this {
    this.op = "update";
    this.updateData = data;
    return this;
  }

  // ── Filter ──

  eq(col: string, val: unknown): this {
    this.filters.push((r: any) => r[col] === val);
    return this;
  }

  is(col: string, val: null): this {
    this.filters.push((r: any) => r[col] === null || r[col] === undefined);
    return this;
  }

  not(col: string, _op: string, val: null): this {
    this.filters.push((r: any) => r[col] !== null && r[col] !== undefined);
    return this;
  }

  // ── Result-Modifikatoren ──

  limit(n: number): this { this.limitN = n; return this; }

  order(col: string, opts?: { ascending?: boolean }): this {
    this.orderField = col;
    this.orderAsc = opts?.ascending ?? true;
    return this;
  }

  single(): Promise<{ data: any; error: null }> {
    this.returnSingle = true;
    return this.exec();
  }

  maybeSingle<T = LicenseRecord>(): Promise<{ data: T | null; error: null }> {
    this.returnMaybe = true;
    return this.exec() as Promise<{ data: T | null; error: null }>;
  }

  then(resolve: (v: any) => any, reject?: (e: any) => any) {
    return this.exec().then(resolve, reject);
  }

  // ── Ausführung ──

  private exec(): Promise<{ data: any; error: null }> {
    return Promise.resolve().then(() => {
      if (this.op === "insert" && this.insertData) {
        const rec: LicenseRecord = {
          id:                 nextId++,
          code:               this.insertData.code ?? "",
          module:             this.insertData.module ?? "",
          duration:           this.insertData.duration ?? "",
          activated:          this.insertData.activated ?? false,
          device_id:          this.insertData.device_id ?? null,
          activated_at:       this.insertData.activated_at ?? null,
          expires_at:         this.insertData.expires_at ?? null,
          kundenname:         this.insertData.kundenname ?? null,
          reset_requested_at: this.insertData.reset_requested_at ?? null,
          created_at:         new Date().toISOString(),
        };
        db.push(rec);
        const data = this.selectFields ? this.project(rec) : rec;
        return { data, error: null };
      }

      if (this.op === "update" && this.updateData) {
        let targets = db.filter(this.applyFilters.bind(this));
        targets.forEach(row => Object.assign(row, this.updateData));
        return { data: null, error: null };
      }

      // SELECT
      let rows = db.filter(this.applyFilters.bind(this));

      if (this.orderField) {
        const col = this.orderField;
        const asc = this.orderAsc;
        rows = rows.sort((a: any, b: any) => {
          const av = a[col], bv = b[col];
          if (av == null && bv == null) return 0;
          if (av == null) return asc ? 1 : -1;
          if (bv == null) return asc ? -1 : 1;
          return asc ? (av < bv ? -1 : av > bv ? 1 : 0) : (av > bv ? -1 : av < bv ? 1 : 0);
        });
      }

      if (this.limitN !== undefined) rows = rows.slice(0, this.limitN);

      const projected = this.selectFields ? rows.map(r => this.project(r)) : rows;

      if (this.returnSingle || this.returnMaybe) {
        return { data: projected[0] ?? null, error: null };
      }

      return { data: projected, error: null };
    });
  }

  private applyFilters(row: LicenseRecord): boolean {
    return this.filters.every(fn => fn(row));
  }

  private project(row: LicenseRecord): Partial<LicenseRecord> {
    if (!this.selectFields) return { ...row };
    const fields = this.selectFields.split(",").map(f => f.trim());
    const result: any = {};
    for (const f of fields) result[f] = (row as any)[f];
    return result;
  }
}

// ─── Mock-Client-Factory ──────────────────────────────────────────────────────

export function createMockSupabaseClient() {
  return {
    from: (_tableName: string) => new MockBuilder(),
  };
}
