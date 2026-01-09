import { Queue, QueueEvents } from 'bullmq';
import IORedis from 'ioredis';
import { config } from '../config/index.js';

// Shared BullMQ connection for queue producers (controllers) and the scheduler worker.
export const taskQueueConnection = new IORedis(config.redis.url, {
  maxRetriesPerRequest: null,
});

export const taskQueue = new Queue('scrape-tasks', { connection: taskQueueConnection });

// Used by controllers that want to await job completion (e.g. manual cart scrape).
export const taskQueueEvents = new QueueEvents('scrape-tasks', { connection: taskQueueConnection });
