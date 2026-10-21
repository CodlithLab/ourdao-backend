// Issue #191: acknowledge a recorded ledger discontinuity without rebuilding.
//
// `npm run reorg:clear` — for a false alarm (an RPC that briefly served a
// wrong hash, a rewind the network itself corrected) confirmed per the triage
// steps in docs/REORG_RECOVERY.md. After a *real* divergence use
// `npm run reindex` instead: it rebuilds the derived tables and clears the
// halt in the same transaction. Either way the worker refuses to start until
// one of the two has run.
import { pool } from '../db/index.js'
import { clearReorgHalts, loadUnclearedReorgHalt, type ReorgHalt } from './poller.js'

export interface ClearReorgAdminContext {
  adminAddress?: string
  ipAddress?: string | null
}

export interface ClearReorgResult {
  /** The halt that was open before clearing, or null when there was none. */
  halt: ReorgHalt | null
  /** How many records were marked cleared. */
  cleared: number
}

/** Clear every uncleared halt on behalf of the operator. Logs what it did;
 *  a no-op (nothing recorded) is reported rather than treated as an error.
 *  Accepts admin context and writes to admin_audit_log (issue #402). */
export async function clearRecordedReorg(
  adminContextOrLog?: ClearReorgAdminContext | { log(msg: string): void },
  loggerArg?: { log(msg: string): void }
): Promise<ClearReorgResult> {
  const isLog = Boolean(
    adminContextOrLog &&
      typeof (adminContextOrLog as { log?: unknown }).log === 'function'
  )
  const context = isLog ? undefined : (adminContextOrLog as ClearReorgAdminContext | undefined)
  const log = isLog
    ? (adminContextOrLog as { log(msg: string): void })
    : (loggerArg ?? console)

  const halt = await loadUnclearedReorgHalt()
  if (!halt) {
    log.log('[reorg:clear] no uncleared ledger discontinuity recorded — nothing to do')
    return { halt: null, cleared: 0 }
  }
  log.log(
    `[reorg:clear] clearing the discontinuity recorded at ${new Date(halt.detected_at).toISOString()} ` +
      `on ${halt.contract_id} (last folded ledger ${halt.last_ledger ?? 'unknown'}): ${halt.detail}`
  )
  const clearedBy = context?.adminAddress ?? 'operator'
  const cleared = await clearReorgHalts(clearedBy)

  // Issue #402: record action in admin_audit_log
  try {
    await pool.query(
      `INSERT INTO admin_audit_log (admin_address, action, ip_address, payload)
       VALUES ($1, 'clear_reorg', $2, $3)`,
      [
        context?.adminAddress ?? 'operator',
        context?.ipAddress ?? null,
        JSON.stringify({
          halt_id: halt.id,
          contract_id: halt.contract_id,
          last_ledger: halt.last_ledger,
          last_ledger_hash: halt.last_ledger_hash,
          detail: halt.detail,
          detected_at: halt.detected_at,
          cleared,
        }),
      ]
    )
  } catch (err) {
    console.error('[reorg:clear] failed to record audit log:', err instanceof Error ? err.message : err)
  }

  log.log(`[reorg:clear] cleared ${cleared} record(s); the worker may be restarted`)
  return { halt, cleared }
}

// `npm run reorg:clear`
/* v8 ignore start -- run-directly entrypoint, exercised as a subprocess not by vitest (#79) */
if (import.meta.url === `file://${process.argv[1]}`) {
  clearRecordedReorg()
    .then(() => pool.end())
    .catch((err) => {
      console.error('[reorg:clear] failed:', err instanceof Error ? err.message : err)
      process.exit(1)
    })
}
/* v8 ignore stop */
