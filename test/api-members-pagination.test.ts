import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { Keypair } from '@stellar/stellar-sdk'
import { buildServer } from '../src/api/server.js'
import { query } from '../src/db/index.js'
import { closeDb, resetDb } from './db.js'

describe('API: GET /api/members pagination', () => {
  let app: FastifyInstance

  beforeEach(async () => {
    await resetDb()
    app = await buildServer()
    await app.ready()
  })
  afterAll(closeDb)

  it('supports cursor pagination across members larger than limit', async () => {
    for (let i = 1; i <= 5; i++) {
      const addr = Keypair.random().publicKey()
      await query(
        `INSERT INTO members (address, name, joined_ledger, joined_at, contribution, stake, exited, voting_power)
         VALUES ($1, $2, $3, NOW() - make_interval(secs => $4), '100', '0', false, '1')`,
        [addr, `Member ${i}`, 100 + i, i * 10]
      )
    }

    const res1 = await app.inject({ method: 'GET', url: '/api/members?limit=2' })
    expect(res1.statusCode).toBe(200)
    const body1 = res1.json()
    expect(body1.data).toHaveLength(2)
    expect(body1.pagination.has_more).toBe(true)
    expect(body1.pagination.next_cursor).toBeTruthy()

    const res2 = await app.inject({ method: 'GET', url: `/api/members?limit=2&before=${encodeURIComponent(body1.pagination.next_cursor)}` })
    expect(res2.statusCode).toBe(200)
    const body2 = res2.json()
    expect(body2.data).toHaveLength(2)
    expect(body2.pagination.has_more).toBe(true)

    const res3 = await app.inject({ method: 'GET', url: `/api/members?limit=2&before=${encodeURIComponent(body2.pagination.next_cursor)}` })
    expect(res3.statusCode).toBe(200)
    const body3 = res3.json()
    expect(body3.data).toHaveLength(1)
    expect(body3.pagination.has_more).toBe(false)
    expect(body3.pagination.next_cursor).toBeNull()
  })
})
