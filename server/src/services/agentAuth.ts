import { randomBytes } from 'crypto';
import IORedis from 'ioredis';
import { config } from '../config/index.js';

const redis = new IORedis(config.redis.url, { maxRetriesPerRequest: null });

const PAIR_CODE_TTL_SEC = 120;
const KEY_PREFIX = 'taobao:agent:';
const PAIR_KEY_PREFIX = `${KEY_PREFIX}pair:`;
const TOKEN_KEY_PREFIX = `${KEY_PREFIX}token:`;

const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

function randomCode(len = 8): string {
  const buf = randomBytes(len);
  let out = '';
  for (let i = 0; i < len; i++) {
    out += CODE_ALPHABET[buf[i] % CODE_ALPHABET.length];
  }
  return out;
}

function randomToken(): string {
  return randomBytes(24).toString('base64url');
}

type PairCodePayload = {
  userId: string;
  setAsDefault: boolean;
  createdAt: string;
};

type AgentTokenPayload = {
  userId: string;
  agentId: string;
  createdAt: string;
  lastUsedAt: string | null;
};

export class AgentAuthService {
  async createPairCode(userId: string, options?: { setAsDefault?: boolean }): Promise<{ code: string; expiresInSec: number }> {
    const setAsDefault = options?.setAsDefault !== false;
    for (let i = 0; i < 5; i++) {
      const code = randomCode(8);
      const key = `${PAIR_KEY_PREFIX}${code}`;
      const payload: PairCodePayload = { userId, setAsDefault, createdAt: new Date().toISOString() };
      const ok = await redis.set(key, JSON.stringify(payload), 'EX', PAIR_CODE_TTL_SEC, 'NX');
      if (ok) return { code, expiresInSec: PAIR_CODE_TTL_SEC };
    }
    throw new Error('Failed to create pair code, please retry');
  }

  async redeemPairCode(code: string, agentId: string): Promise<{ userId: string; token: string; setAsDefault: boolean }> {
    const normalized = String(code || '').trim().toUpperCase();
    if (!normalized) throw new Error('Missing code');

    const key = `${PAIR_KEY_PREFIX}${normalized}`;
    const raw = await redis.get(key);
    if (!raw) throw new Error('Invalid or expired pair code');

    await redis.del(key);

    const payload = JSON.parse(raw) as PairCodePayload;
    const userId = String(payload?.userId || '').trim();
    if (!userId) throw new Error('Invalid pair code');

    const setAsDefault = payload?.setAsDefault !== false;
    const token = randomToken();
    const tokenKey = `${TOKEN_KEY_PREFIX}${token}`;

    const tokenPayload: AgentTokenPayload = {
      userId,
      agentId,
      createdAt: new Date().toISOString(),
      lastUsedAt: null,
    };

    await redis.set(tokenKey, JSON.stringify(tokenPayload));
    return { userId, token, setAsDefault };
  }

  async verifyAgentToken(agentId: string, token: string): Promise<{ userId: string } | null> {
    const t = String(token || '').trim();
    if (!t) return null;

    const tokenKey = `${TOKEN_KEY_PREFIX}${t}`;
    const raw = await redis.get(tokenKey);
    if (!raw) return null;

    try {
      const payload = JSON.parse(raw) as AgentTokenPayload;
      if (String(payload?.agentId || '').trim() !== String(agentId || '').trim()) return null;
      const userId = String(payload?.userId || '').trim();
      if (!userId) return null;

      const updated: AgentTokenPayload = { ...payload, lastUsedAt: new Date().toISOString() };
      await redis.set(tokenKey, JSON.stringify(updated));
      return { userId };
    } catch {
      return null;
    }
  }
}

export const agentAuthService = new AgentAuthService();

