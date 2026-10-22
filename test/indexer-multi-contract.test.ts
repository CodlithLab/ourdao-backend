// Issue #289: one indexer process tailing more than one Soroban contract at
// once, each with its own independent cursor row keyed by contract_id.
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { pool, query } from '../src/db/index.js'
import { assertContractsConfigured, resolveConfig } from '../src/config.js'
import {
  fetchOnce,
  getCursorWriteFailure,
  getCursorWriteFailures,
  resetCursorWriteFailuresForTests,
} from '../src/indexer/poller.js'
import { closeDb, resetDb } from './db.js'
import { decodedEvent } from './fixtures.js'
import type { DecodedEvent } from '../src/stellar/events.js'

vi.mock('../src/stellar/events.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/stellar/events.js')>()
  return { ...actual, decodeEvent: (raw: unknown) => raw as DecodedEvent }
})

const getEventsMock = vi.fn()
vi.mock('../src/stellar/rpc.js', () => ({
  server: { getEvents: (...args: unknown[]) => getEventsMock(...(args as [unknown])) },
  getLatestLedger: vi.fn().mockResolvedValue(100_000),
  getLatestLedgerInfo: vi.fn().mockResolvedValue({ sequence: 100_000, hash: 'HASH_TIP' }),
  getLedgerHash: vi.fn().mockResolvedValue('HASH_FOR_LEDGER'),
}))

async function cursorFor(contractId: string) {
  return query<{ last_ledger: number | null; paging_token: string | null; contract_id: string }>(
    'SELECT last_ledger, paging_token, contract_id FROM indexer_cursor WHERE contract_id = $1',
    [contractId]
  ).then((rows) => rows[0] ?? null)
}

describe('config: assertContractsConfigured (issue #289)', () => {
  it('splits CONTRACT_IDS on commas, trimming whitespace and dropping blanks', () => {
    const cfg = resolveConfig({ CONTRACT_IDS: ' CONE, CTWO ,, CTHREE' })
    expect(assertContractsConfigured(cfg)).toEqual(['CONE', 'CTWO', 'CTHREE'])
  })

  it('falls back to a single CONTRACT_ID when CONTRACT_IDS is unset', () => {
    const cfg = resolveConfig({ CONTRACT_ID: 'CSINGLE' })
    expect(assertContractsConfigured(cfg)).toEqual(['CSINGLE'])
  })

  it('rejects a duplicate contract id in CONTRACT_IDS', () => {
    const cfg = resolveConfig({ CONTRACT_IDS: 'CONE,CTWO,CONE' })
    expect(() => assertContractsConfigured(cfg)).toThrow(/more than once.*CONE/)
  })

  it('throws when neither CONTRACT_IDS nor CONTRACT_ID is set', () => {
    const cfg = resolveConfig({})
    expect(() => assertContractsConfigured(cfg)).toThrow(/CONTRACT_ID is not set/)
  })
})

describe('indexer: multi-contract event tailing (issue #289)', () => {
  beforeEach(async () => {
    await resetDb()
    getEventsMock.mockReset()
  })
  afterAll(closeDb)

  it('maintains an independent cursor per contract', async () => {
    const eventA = decodedEvent('joined', { member: 'GA', fee: '10' })
    const eventB = decodedEvent('joined', { member: 'GB', fee: '20' })
    getEventsMock
      .mockResolvedValueOnce({ events: [eventA], cursor: 'tok-a', latestLedger: 100_000 })
      .mockResolvedValueOnce({ events: [eventB], cursor: 'tok-b', latestLedger: 100_000 })

    await fetchOnce('CCONTRACT_A')
    await fetchOnce('CCONTRACT_B')

    const rows = await query<{ contract_id: string }>('SELECT contract_id FROM indexer_cursor ORDER BY contract_id')
    expect(rows.map((r) => r.contract_id)).toEqual(['CCONTRACT_A', 'CCONTRACT_B'])

    const cursorA = await cursorFor('CCONTRACT_A')
    const cursorB = await cursorFor('CCONTRACT_B')
    expect(cursorA?.paging_token).toBe(eventA.id)
    expect(cursorB?.paging_token).toBe(eventB.id)

    const members = await query<{ address: string }>('SELECT address FROM members ORDER BY address')
    expect(members.map((m) => m.address)).toEqual(['GA', 'GB'])
  })

  it("a failure on one contract's poll doesn't affect the other contract's cursor", async () => {
    const eventA = decodedEvent('joined', { member: 'GA', fee: '10' })
    // loan_dflt with no penalty field throws deterministically (issue #42).
    const badB = decodedEvent('loan_dflt', { loan_id: 1, borrower: 'GB' })
    getEventsMock
      .mockResolvedValueOnce({ events: [eventA], cursor: 'tok-a', latestLedger: 100_000 })
      .mockResolvedValueOnce({ events: [badB], cursor: 'tok-b', latestLedger: 100_000 })

    await fetchOnce('CCONTRACT_A')
    await expect(fetchOnce('CCONTRACT_B')).rejects.toThrow(/penalty/)

    const cursorA = await cursorFor('CCONTRACT_A')
    expect(cursorA?.paging_token).toBe(eventA.id)
    // B never got far enough to write a cursor row at all — the whole-page
    // transaction rolled back below the quarantine threshold.
    expect(await cursorFor('CCONTRACT_B')).toBeNull()
  })

  it('resetForContractChange wipes every tailed contract\'s cursor row, not just one', async () => {
    await pool.query(
      `INSERT INTO indexer_cursor (paging_token, last_ledger, contract_id) VALUES ('tok', 100, 'CCONTRACT_A'), ('tok', 200, 'CCONTRACT_B')`
    )
    const { resetForContractChange } = await import('../src/indexer/poller.js')
    await resetForContractChange()
    expect(await query('SELECT * FROM indexer_cursor')).toEqual([])
  })
})

describe('indexer: per-contract cursor write failure tracking (issue #383)', () => {
  // Fail only the cursor upsert for `failingContract`; every other query
  // (the page fold, the other contract's cursor write) goes through.
  function failCursorWriteFor(failingContract: string) {
    const realQuery = pool.query.bind(pool) as (...args: unknown[]) => Promise<unknown>
    return vi.spyOn(pool, 'query').mockImplementation(((text: unknown, params?: unknown[]) => {
      if (
        typeof text === 'string' &&
        text.includes('INSERT INTO indexer_cursor') &&
        params?.[4] === failingContract
      ) {
        return Promise.reject(new Error(`disk full for ${failingContract}`))
      }
      return realQuery(text, params)
    }) as typeof pool.query)
  }

  beforeEach(async () => {
    await resetDb()
    getEventsMock.mockReset()
    resetCursorWriteFailuresForTests()
  })
  afterAll(closeDb)

  it("a successful cursor write for one contract does not clear another contract's failure", async () => {
    getEventsMock
      .mockResolvedValueOnce({ events: [decodedEvent('joined', { member: 'GA', fee: '10' })], cursor: 'tok-a', latestLedger: 100_000 })
      .mockResolvedValueOnce({ events: [decodedEvent('joined', { member: 'GB', fee: '20' })], cursor: 'tok-b', latestLedger: 100_000 })

    const spy = failCursorWriteFor('CCONTRACT_A')
    try {
      await expect(fetchOnce('CCONTRACT_A')).rejects.toThrow(/Cursor write failed: disk full for CCONTRACT_A/)
      await fetchOnce('CCONTRACT_B')
    } finally {
      spy.mockRestore()
    }

    expect(await cursorFor('CCONTRACT_B')).not.toBeNull()
    expect(getCursorWriteFailure('CCONTRACT_A')).toMatchObject({ error: 'disk full for CCONTRACT_A' })
    expect(typeof getCursorWriteFailure('CCONTRACT_A')?.at).toBe('number')
    expect(getCursorWriteFailure('CCONTRACT_B')).toBeNull()
    expect([...getCursorWriteFailures().keys()]).toEqual(['CCONTRACT_A'])
  })

  it("records failures for each contract independently and clears only on that contract's own success", async () => {
    getEventsMock
      .mockResolvedValueOnce({ events: [decodedEvent('joined', { member: 'GA', fee: '10' })], cursor: 'tok-a', latestLedger: 100_000 })
      .mockResolvedValueOnce({ events: [decodedEvent('joined', { member: 'GB', fee: '20' })], cursor: 'tok-b', latestLedger: 100_000 })

    const failA = failCursorWriteFor('CCONTRACT_A')
    try {
      await expect(fetchOnce('CCONTRACT_A')).rejects.toThrow(/Cursor write failed/)
    } finally {
      failA.mockRestore()
    }
    const failB = failCursorWriteFor('CCONTRACT_B')
    try {
      await expect(fetchOnce('CCONTRACT_B')).rejects.toThrow(/Cursor write failed/)
    } finally {
      failB.mockRestore()
    }

    const failures = getCursorWriteFailures()
    expect(failures.get('CCONTRACT_A')?.error).toBe('disk full for CCONTRACT_A')
    expect(failures.get('CCONTRACT_B')?.error).toBe('disk full for CCONTRACT_B')

    // A's retry (same page refetched, events already folded) now persists
    // its cursor: A's failure clears, B's stays.
    getEventsMock.mockResolvedValueOnce({ events: [decodedEvent('joined', { member: 'GA', fee: '10' })], cursor: 'tok-a', latestLedger: 100_000 })
    await fetchOnce('CCONTRACT_A')

    expect(getCursorWriteFailure('CCONTRACT_A')).toBeNull()
    expect(getCursorWriteFailure('CCONTRACT_B')?.error).toBe('disk full for CCONTRACT_B')
  })

  it('getCursorWriteFailures returns a snapshot that callers cannot mutate into module state', async () => {
    getEventsMock.mockResolvedValueOnce({ events: [decodedEvent('joined', { member: 'GA', fee: '10' })], cursor: 'tok-a', latestLedger: 100_000 })
    const spy = failCursorWriteFor('CCONTRACT_A')
    try {
      await expect(fetchOnce('CCONTRACT_A')).rejects.toThrow(/Cursor write failed/)
    } finally {
      spy.mockRestore()
    }

    const snapshot = getCursorWriteFailures() as Map<string, unknown>
    snapshot.clear()
    expect(getCursorWriteFailure('CCONTRACT_A')).not.toBeNull()
  })
})
