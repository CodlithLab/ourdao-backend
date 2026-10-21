/**
 * Test that all public GET /api/* endpoints have declared 200 response schemas.
 * This ensures the OpenAPI spec is complete for downstream consumers.
 * 
 * Note: This test does NOT use the database setup, so it can run without
 * a Postgres connection. The only file it needs is openapi.json.
 */

import { readFileSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'
import { describe, it, expect } from 'vitest'

// Bypass the normal test setup by reading the file directly without importing
// anything from src/ that would trigger database initialization
const __dirname = dirname(fileURLToPath(import.meta.url))
const OPENAPI_PATH = join(__dirname, '../openapi.json')

interface OpenAPISpec {
  paths: {
    [path: string]: {
      get?: {
        responses?: Record<string, unknown>
      }
      [method: string]: unknown
    }
  }
}

describe('API response schemas', () => {
  it('all public GET /api/* endpoints have a declared 200 response schema', () => {
    let spec: OpenAPISpec
    try {
      spec = JSON.parse(readFileSync(OPENAPI_PATH, 'utf-8')) as OpenAPISpec
    } catch (err) {
      throw new Error(`Failed to read openapi.json: ${(err as Error).message}`, { cause: err })
    }

    const failures: string[] = []

    for (const [path, pathObj] of Object.entries(spec.paths || {})) {
      // Only check /api/* paths, only GET operations
      if (!path.startsWith('/api/')) continue
      if (!pathObj.get) continue

      const responses = pathObj.get.responses
      const has200Response = responses?.['200']

      if (!has200Response) {
        failures.push(`${path} (GET) has no declared 200 response schema`)
      }
    }

    if (failures.length > 0) {
      throw new Error(
        `Found ${failures.length} public GET /api/* endpoint(s) without response schemas:\n` +
        failures.map((f) => `  - ${f}`).join('\n'),
      )
    }

    expect(failures).toHaveLength(0)
  })
})
