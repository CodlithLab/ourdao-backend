import { describe, it, expect, afterAll } from 'vitest';
import { redis, closeRedis } from '../src/cache/redis.js';

describe('Redis Cache Client', () => {
  afterAll(async () => {
    await closeRedis();
  });

  it('should export redis instance and close cleanly', async () => {
    expect(redis).toBeDefined();
    await closeRedis();
    expect(redis.status).toBe('end');
  });
});
