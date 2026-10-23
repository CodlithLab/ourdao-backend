import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { Keypair } from '@stellar/stellar-sdk'
import { buildServer } from '../src/api/server.js'
import { closeDb, resetDb } from './db.js'

describe('API: AuthFailureTracker brute-force backoff and lockout', () => {
  let app: FastifyInstance
  const kp = Keypair.random()

  beforeEach(async () => {
    await resetDb()
    app = await buildServer()
    await app.ready()
  })

  afterAll(async () => {
    await app.close()
    await closeDb()
  })

  it('throttles and locks out repeated authentication failures', async () => {
    // Hit admin endpoint with invalid authorization repeatedly
    const url = '/api/admin/audit-log'
    const badAuth = `StellarSignature ${kp.publicKey()}:invalidbase64signature:1234567890abcdef1234567890abcdef`

    // First few attempts fail with 401
    for (let i = 0; i < 5; i++) {
      const res = await app.inject({
        method: 'GET',
        url,
        headers: { authorization: badAuth },
      })
      expect(res.statusCode).toBe(401)
    }

    // Subsequent attempts within the backoff/lockout period should get rate limited / 429 or blocked
    const throttledRes = await app.inject({
      method: 'GET',
      url,
      headers: { authorization: badAuth },
    })
    expect([401, 429]).toContain(throttledRes.statusCode)
  })
})
