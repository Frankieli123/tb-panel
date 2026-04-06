import { Job } from 'bullmq';
import { taskQueue } from './taskQueue.js';

const ACTIVE_STATES = ['waiting', 'prioritized', 'active', 'delayed'] as const;

export async function findExistingCartScrapeJob(accountId: string): Promise<Job | null> {
  const target = String(accountId || '').trim();
  if (!target) return null;

  const groups = await Promise.all(ACTIVE_STATES.map((state) => taskQueue.getJobs([state], 0, -1).catch(() => [] as Job[])));
  for (const jobs of groups) {
    for (const job of jobs) {
      if (String(job?.name || '') !== 'cart-scrape') continue;
      if (String((job?.data as any)?.accountId || '').trim() !== target) continue;
      return job;
    }
  }

  return null;
}
