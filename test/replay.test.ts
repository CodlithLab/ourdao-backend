import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { replayFailedEvent } from '../src/indexer/replay.js'
import { reindexFromEventLog } from '../src/indexer/reindex.js'
import { query, queryOne } from '../src/db/index.js'
import { closeDb, resetDb } from './db.js'

describe('failed_events resolution tracking (issue #395)', () => {
  beforeEach(resetDb)
  afterAll(closeDb)

  it('sets resolution to "resolved" and resolved_at to now when replay succeeds', async () => {
    await query(
      `INSERT INTO events (id, ledger, closed_at, contract_id, symbol, topics, data)
       VALUES ('1-0', 100, now(), 'CTEST', 'unknown_symbol', '[]', '[]')`
    )
    await query(
      `INSERT INTO failed_events (event_id, symbol, ledger, error)
       VALUES ('1-0', 'unknown_symbol', 100, 'boom')`
    )

    const outcome = await replayFailedEvent('1-0')
    expect(outcome.status).toBe('replayed')

    const row = await queryOne<{ resolved_at: string | null; resolution: string | null }>(
      'SELECT resolved_at, resolution FROM failed_events WHERE event_id = $1',
      ['1-0']
    )
    expect(row?.resolved_at).not.toBeNull()
    expect(row?.resolution).toBe('resolved')
  })

  it('supports custom resolution (e.g. "ignored") in replayFailedEvent', async () => {
    await query(
      `INSERT INTO events (id, ledger, closed_at, contract_id, symbol, topics, data)
       VALUES ('2-0', 100, now(), 'CTEST', 'unknown_symbol', '[]', '[]')`
    )
    await query(
      `INSERT INTO failed_events (event_id, symbol, ledger, error)
       VALUES ('2-0', 'unknown_symbol', 100, 'boom')`
    )

    const outcome = await replayFailedEvent('2-0', 'ignored')
    expect(outcome.status).toBe('replayed')

    const row = await queryOne<{ resolved_at: string | null; resolution: string | null }>(
      'SELECT resolved_at, resolution FROM failed_events WHERE event_id = $1',
      ['2-0']
    )
    expect(row?.resolved_at).not.toBeNull()
    expect(row?.resolution).toBe('ignored')
  })

  it('sets resolution to "resolved" when replaying an already-folded event', async () => {
    await query(
      `INSERT INTO events (id, ledger, closed_at, contract_id, symbol, topics, data, folded_at)
       VALUES ('3-0', 100, now(), 'CTEST', 'unknown_symbol', '[]', '[]', now())`
    )
    await query(
      `INSERT INTO failed_events (event_id, symbol, ledger, error)
       VALUES ('3-0', 'unknown_symbol', 100, 'boom')`
    )

    const outcome = await replayFailedEvent('3-0')
    expect(outcome.status).toBe('already_resolved')

    const row = await queryOne<{ resolved_at: string | null; resolution: string | null }>(
      'SELECT resolved_at, resolution FROM failed_events WHERE event_id = $1',
      ['3-0']
    )
    expect(row?.resolved_at).not.toBeNull()
    expect(row?.resolution).toBe('resolved')
  })

  it('sets resolution to "resolved" on unresolved failed_events during reindex', async () => {
    await query(
      `INSERT INTO events (id, ledger, closed_at, contract_id, symbol, topics, data)
       VALUES ('4-0', 100, now(), 'CTEST', 'unknown_symbol', '[]', '[]')`
    )
    await query(
      `INSERT INTO failed_events (event_id, symbol, ledger, error)
       VALUES ('4-0', 'unknown_symbol', 100, 'boom')`
    )

    await reindexFromEventLog()

    const row = await queryOne<{ resolved_at: string | null; resolution: string | null }>(
      'SELECT resolved_at, resolution FROM failed_events WHERE event_id = $1',
      ['4-0']
    )
    expect(row?.resolved_at).not.toBeNull()
    expect(row?.resolution).toBe('resolved')
  })
})
