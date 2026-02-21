import { Queue, QueueEvents } from 'bullmq';
import IORedis from 'ioredis';
import { config } from '../config/index.js';

function attachRedisDebugLogs(name: string, redis: any): void {
  if (!redis || typeof redis.on !== 'function') return;

  redis.on('ready', () => console.log(`[Redis] ready name=${name}`));
  redis.on('error', (err: any) => {
    const msg = err instanceof Error ? err.message : String(err ?? 'unknown');
    console.error(`[Redis] error name=${name}: ${msg}`);
  });
}

// Producer connection: fail-fast for HTTP requests (avoid "click with no response" when Redis is down).
export const taskQueueProducerConnection = new IORedis(config.redis.url, {
  enableOfflineQueue: false,
  connectTimeout: 5000,
  maxRetriesPerRequest: 1,
});

// Worker connection: allow long-lived retries so the scheduler can recover after Redis restarts.
export const taskQueueWorkerConnection = new IORedis(config.redis.url, {
  maxRetriesPerRequest: null,
});

attachRedisDebugLogs('queue:producer', taskQueueProducerConnection);
attachRedisDebugLogs('queue:worker', taskQueueWorkerConnection);

export const taskQueue = new Queue('scrape-tasks', { connection: taskQueueProducerConnection });

// Used by controllers that want to await job completion (e.g. manual cart scrape).
export const taskQueueEvents = new QueueEvents('scrape-tasks', { connection: taskQueueProducerConnection });
