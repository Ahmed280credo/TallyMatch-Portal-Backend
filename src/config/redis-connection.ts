import type { RedisOptions } from "ioredis";

export function redisConnectionOptions(redisUrl: string): RedisOptions {
  const url = new URL(redisUrl);
  const db = url.pathname ? Number(url.pathname.slice(1)) : 0;

  return {
    host: url.hostname,
    port: Number(url.port || 6379),
    username: url.username || undefined,
    password: url.password || undefined,
    db: Number.isFinite(db) ? db : 0,
    tls: url.protocol === "rediss:" ? {} : undefined,
    maxRetriesPerRequest: null
  };
}

