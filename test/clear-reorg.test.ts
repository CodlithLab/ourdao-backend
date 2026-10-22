import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { clearRecordedReorg } from '../src/indexer/clear-reorg.js'
import { query } from '../src/db/index.js'
import { buildServer } from '../src/api/server.js'
import { closeDb, resetDb } from './db.js'
import type { AdminAuditLogRow } from '../src/types.js'

describe('clearRecordedReorg and POST /api/admin/clear-reorg audit trail (issue #402)', () => {
  let app: FastifyInstance

  beforeEach(async () => {
    await resetDb()
    app = await buildServer()
    await app.ready()
  })

  afterAll(async () => {
    if (app) await app.close()
    await closeDb()
  })

  it('records an entry in admin_audit_log when clearing an uncleared reorg halt', async () => {
    await query(
      `INSERT INTO reorg_halts (contract_id, last_ledger, last_ledger_hash, detail)
       VALUES ('CTESTCONTRACT', 12345, 'HASH_ABC', 'ledger 12345 hash mismatch')`
    )

    const result = await clearRecordedReorg({
      adminAddress: 'GADMIN123',
      ipAddress: '192.168.1.10',
    })

    expect(result.cleared).toBe(1)
    expect(result.halt).not.toBeNull()
    expect(result.halt?.contract_id).toBe('CTESTCONTRACT')
    expect(result.halt?.last_ledger).toBe(12345)

    const auditLogs = await query<AdminAuditLogRow>(
      "SELECT * FROM admin_audit_log WHERE action = 'clear_reorg' ORDER BY id DESC"
    )
    expect(auditLogs).toHaveLength(1)
    const log = auditLogs[0]!
    expect(log.admin_address).toBe('GADMIN123')
    expect(log.ip_address).toBe('192.168.1.10')
    expect(log.action).toBe('clear_reorg')
    expect(log.payload).toMatchObject({
      contract_id: 'CTESTCONTRACT',
      last_ledger: 12345,
      last_ledger_hash: 'HASH_ABC',
      detail: 'ledger 12345 hash mismatch',
      cleared: 1,
    })
  })

  it('defaults to operator when no admin address is provided to clearRecordedReorg', async () => {
    await query(
      `INSERT INTO reorg_halts (contract_id, last_ledger, last_ledger_hash, detail)
       VALUES ('CTESTCONTRACT', 54321, 'HASH_XYZ', 'reorg detail')`
    )

    const result = await clearRecordedReorg()
    expect(result.cleared).toBe(1)

    const auditLogs = await query<AdminAuditLogRow>(
      "SELECT * FROM admin_audit_log WHERE action = 'clear_reorg' ORDER BY id DESC"
    )
    expect(auditLogs).toHaveLength(1)
    expect(auditLogs[0]!.admin_address).toBe('operator')
    expect(auditLogs[0]!.ip_address).toBeNull()
  })

  it('does not write an audit log entry if there is no uncleared halt', async () => {
    const result = await clearRecordedReorg({ adminAddress: 'GADMIN123' })
    expect(result.cleared).toBe(0)
    expect(result.halt).toBeNull()

    const auditLogs = await query<AdminAuditLogRow>(
      "SELECT * FROM admin_audit_log WHERE action = 'clear_reorg'"
    )
    expect(auditLogs).toHaveLength(0)
  })

  it('POST /api/admin/clear-reorg clears the reorg and writes to admin_audit_log', async () => {
    await query(
      `INSERT INTO reorg_halts (contract_id, last_ledger, last_ledger_hash, detail)
       VALUES ('CCONTRACT', 9999, 'HASH_9999', 'rpc ledger rewind')`
    )

    const res = await app.inject({
      method: 'POST',
      url: '/api/admin/clear-reorg',
      headers: {
        'x-admin-address': 'GOPERATOR',
      },
    })

    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.cleared).toBe(1)
    expect(body.halt.contract_id).toBe('CCONTRACT')

    const auditLogs = await query<AdminAuditLogRow>(
      "SELECT * FROM admin_audit_log WHERE action = 'clear_reorg' ORDER BY id DESC"
    )
    expect(auditLogs).toHaveLength(1)
    expect(auditLogs[0]!.admin_address).toBe('GOPERATOR')
    expect(auditLogs[0]!.payload).toMatchObject({
      contract_id: 'CCONTRACT',
      last_ledger: 9999,
    })
  })
})
