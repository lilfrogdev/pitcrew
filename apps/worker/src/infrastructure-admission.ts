// Conservative reservations, not measured billing or an account spending cap.
// Every operation must run inside the repository DO's transactionSync callback.
export interface Reservation {
  runId: string;
  fingerprint: string;
  month: string;
  cents: number;
  deadline: number;
  state: "active" | "stopping" | "quarantined" | "released";
  cleanupAttempts?: number;
}
export interface AdmissionState {
  paused: boolean;
  reservations: Reservation[];
}
export interface AdmissionStore {
  transaction<T>(operation: () => T): T;
  read(): AdmissionState | undefined;
  write(state: AdmissionState): void;
}
export const INITIAL_ADMISSION = Object.freeze({
  monthlyReservationCents: 7500,
  perRunReservationCents: 500,
  maxActiveRuns: 1,
  maxRunMs: 10 * 60 * 1000,
});
export async function boundedCleanupRpc<T>(operation: Promise<T>, timeoutMs = 5000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(Error("cleanup_rpc_timeout")), timeoutMs);
  });
  try {
    return await Promise.race([operation, timeout]);
  } finally {
    clearTimeout(timer);
  }
  // Timing out observation does not cancel remote work. Its slot remains held.
}
export function sqliteAdmission(storage: DurableObjectStorage, now = () => Date.now()) {
  storage.sql.exec(
    "CREATE TABLE IF NOT EXISTS infrastructure_admission(id INTEGER PRIMARY KEY CHECK(id=1),value TEXT NOT NULL)",
  );
  return new InfrastructureAdmission(
    {
      transaction: (operation) => storage.transactionSync(operation),
      read: () => {
        const [row] = storage.sql
          .exec<{ value: string }>("SELECT value FROM infrastructure_admission WHERE id=1")
          .toArray();
        return row ? (JSON.parse(row.value) as AdmissionState) : undefined;
      },
      write: (state) => {
        storage.sql.exec(
          "INSERT INTO infrastructure_admission VALUES(1,?) ON CONFLICT(id) DO UPDATE SET value=excluded.value",
          JSON.stringify(state),
        );
      },
    },
    now,
  );
}
export class InfrastructureAdmission {
  constructor(
    private store: AdmissionStore,
    private now = () => Date.now(),
  ) {}
  reserve(runId: string, fingerprint: string, enabled: boolean) {
    if (!enabled) return { allowed: false as const, reason: "disabled" };
    if (!runId || runId.length > 128 || !fingerprint || fingerprint.length > 128)
      throw Error("invalid_admission_identity");
    return this.store.transaction(() => {
      const state = this.store.read() ?? { paused: false, reservations: [] };
      const timestamp = this.now();
      const previous = state.reservations.find((item) => item.runId === runId);
      if (previous) {
        if (previous.fingerprint !== fingerprint) throw Error("admission_identity_conflict");
        if (previous.state === "released")
          return { allowed: false as const, reason: "already_finished" };
        if (previous.state !== "active" || timestamp >= previous.deadline || state.paused)
          return { allowed: false as const, reason: "stop_required" };
        return { allowed: true as const, reservation: structuredClone(previous) };
      }
      if (state.paused) return { allowed: false as const, reason: "paused" };
      if (state.reservations.some((item) => item.state === "quarantined"))
        return { allowed: false as const, reason: "reconciliation_required" };
      // Uncertain or expired work continues to own its slot across UTC month rollover.
      if (
        state.reservations.filter((item) => item.state !== "released").length >=
        INITIAL_ADMISSION.maxActiveRuns
      )
        return { allowed: false as const, reason: "busy" };
      const month = new Date(timestamp).toISOString().slice(0, 7);
      const reserved = state.reservations
        .filter((item) => item.month === month)
        .reduce((sum, item) => sum + item.cents, 0);
      if (
        reserved + INITIAL_ADMISSION.perRunReservationCents >
        INITIAL_ADMISSION.monthlyReservationCents
      )
        return { allowed: false as const, reason: "monthly_reservations_exhausted" };
      const reservation: Reservation = {
        runId,
        fingerprint,
        month,
        cents: INITIAL_ADMISSION.perRunReservationCents,
        deadline: timestamp + INITIAL_ADMISSION.maxRunMs,
        state: "active",
      };
      state.reservations.push(reservation);
      this.store.write(state);
      return { allowed: true as const, reservation: structuredClone(reservation) };
    });
  }
  stopRequired(runId: string, executionEnabled: boolean) {
    return this.store.transaction(() => {
      const state = this.store.read();
      const reservation = state?.reservations.find((item) => item.runId === runId);
      if (!state || !reservation || ["released", "quarantined"].includes(reservation.state))
        return false;
      if (
        !executionEnabled ||
        state.paused ||
        this.now() >= reservation.deadline ||
        reservation.state === "stopping"
      ) {
        reservation.state = "stopping";
        this.store.write(state);
        return true;
      }
      return false;
    });
  }
  release(runId: string, cleanupVerified: boolean) {
    if (!cleanupVerified) throw Error("cleanup_not_verified");
    this.store.transaction(() => {
      const state = this.store.read();
      const reservation = state?.reservations.find((item) => item.runId === runId);
      if (!state || !reservation) throw Error("admission_not_found");
      reservation.state = "released";
      // Retain the charge reservation through the month: never pretend this is a refund.
      this.store.write(state);
    });
  }
  pause() {
    this.store.transaction(() => {
      const state = this.store.read() ?? { paused: false, reservations: [] };
      state.paused = true;
      this.store.write(state);
    });
  }
  active() {
    return this.store.transaction(() =>
      (this.store.read()?.reservations ?? [])
        .filter((item) => item.state !== "released")
        .map((item) => structuredClone(item)),
    );
  }
  monitored() {
    return this.active().filter((item) => item.state !== "quarantined");
  }
  beginCleanupAttempt(runId: string) {
    return this.store.transaction(() => {
      const state = this.store.read();
      const reservation = state?.reservations.find((item) => item.runId === runId);
      if (
        !state ||
        !reservation ||
        reservation.state === "released" ||
        reservation.state === "quarantined"
      )
        return false;
      const attempts = reservation.cleanupAttempts ?? 0;
      if (attempts >= 12) {
        reservation.state = "quarantined";
        this.store.write(state);
        return false;
      }
      reservation.cleanupAttempts = attempts + 1;
      this.store.write(state);
      return true;
    });
  }
}
