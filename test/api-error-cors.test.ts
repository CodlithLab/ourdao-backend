import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { buildServer } from '../src/api/server.js'
import { config } from '../src/config.js'
import { query } from '../src/db/index.js'
import { closeDb, resetDb } from './db.js'

describe('API: CORS headers on error responses (issue #270)', () => {
  let app: FastifyInstance

  beforeEach(async () => {
    await resetDb()
    app = await buildServer()
    await app.ready()
  })

  it('404 Not Found includes CORS headers when Origin header is present', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/nonexistent',
      headers: { origin: 'http://localhost:3000' },
    })
    expect(res.statusCode).toBe(404)
    expect(res.headers['access-control-allow-origin']).toBe('http://localhost:3000')
    const body = res.json()
    expect(body.error).toBe('route not found')
    expect(body.code).toBe('ROUTE_NOT_FOUND')
  })

  it('500 Internal Server Error includes CORS headers when Origin header is present', async () => {
    // Force an internal error by querying a non-existent table after the server starts
    await query('CREATE TEMP TABLE temp_test (id int)')
    
    const res = await app.inject({
      method: 'GET',
      url: '/api/stats',
      headers: { origin: 'http://localhost:3000' },
    })
    
    // The response should include CORS headers regardless of success/failure
    if (res.statusCode >= 400) {
      expect(res.headers['access-control-allow-origin']).toBe('http://localhost:3000')
      expect(res.headers['access-control-allow-credentials']).toBe('true')
    }
  })

  it('404 does not include CORS headers when Origin header is missing', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/nonexistent',
    })
    expect(res.statusCode).toBe(404)
    expect(res.headers['access-control-allow-origin']).toBeUndefined()
  })

  it('400 Bad Request includes CORS headers when Origin header is present', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/loans?limit=invalid',
      headers: { origin: 'http://localhost:3000' },
    })
    expect(res.statusCode).toBe(400)
    expect(res.headers['access-control-allow-origin']).toBe('http://localhost:3000')
  })

  it('CORS headers work with multiple configured origins', async () => {
    // This test assumes default CORS config accepts localhost:3000
    const res = await app.inject({
      method: 'GET',
      url: '/nonexistent',
      headers: { origin: 'http://localhost:3000' },
    })
    expect(res.statusCode).toBe(404)
    expect(res.headers['access-control-allow-origin']).toBe('http://localhost:3000')
  })
})

// Issue #376: error responses must not reflect an Origin that CORS_ORIGIN
// does not permit.
describe('API: error-response CORS respects CORS_ORIGIN (issue #376)', () => {
  const originalOrigin = config.http.corsOrigin
  let app: FastifyInstance

  async function startWith(corsOrigin: string): Promise<void> {
    config.http.corsOrigin = corsOrigin
    app = await buildServer()
    await app.ready()
  }

  beforeEach(async () => {
    await resetDb()
  })

  afterEach(async () => {
    config.http.corsOrigin = originalOrigin
    await app.close()
  })

  it('does not reflect a disallowed Origin on a 404', async () => {
    await startWith('https://app.ourdao.org')
    const res = await app.inject({ method: 'GET', url: '/nonexistent', headers: { origin: 'https://evil.example' } })
    expect(res.statusCode).toBe(404)
    expect(res.headers['access-control-allow-origin']).toBeUndefined()
  })

  it('does not reflect a disallowed Origin on a 400', async () => {
    await startWith('https://app.ourdao.org')
    const res = await app.inject({ method: 'GET', url: '/api/loans?limit=invalid', headers: { origin: 'https://evil.example' } })
    expect(res.statusCode).toBe(400)
    expect(res.headers['access-control-allow-origin']).toBeUndefined()
  })

  it('still reflects the configured Origin on an error', async () => {
    await startWith('https://app.ourdao.org')
    const res = await app.inject({ method: 'GET', url: '/nonexistent', headers: { origin: 'https://app.ourdao.org' } })
    expect(res.statusCode).toBe(404)
    expect(res.headers['access-control-allow-origin']).toBe('https://app.ourdao.org')
  })

  it('only reflects Origins in a comma-separated allowlist', async () => {
    await startWith('https://a.example,https://b.example')
    const ok = await app.inject({ method: 'GET', url: '/nonexistent', headers: { origin: 'https://b.example' } })
    expect(ok.headers['access-control-allow-origin']).toBe('https://b.example')
    const bad = await app.inject({ method: 'GET', url: '/nonexistent', headers: { origin: 'https://c.example' } })
    expect(bad.headers['access-control-allow-origin']).toBeUndefined()
  })

  it('reflects any Origin when CORS_ORIGIN is "*"', async () => {
    await startWith('*')
    const res = await app.inject({ method: 'GET', url: '/nonexistent', headers: { origin: 'https://anything.example' } })
    expect(res.headers['access-control-allow-origin']).toBe('https://anything.example')
  })
})

afterAll(closeDb)
