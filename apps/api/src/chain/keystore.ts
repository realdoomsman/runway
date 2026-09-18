// agent_keys rows: the only place agent secrets are persisted (encrypted) and read back.
import { eq } from 'drizzle-orm';
import type { DbLike } from '../db/client.js';
import { agentKeys } from '../db/schema.js';
import { notFound } from '../lib/errors.js';
import { decryptSecret, encryptSecret, pubkeyOfSecret, wipeSecret } from './keys.js';

export async function storeAgentKey(db: DbLike, keyHex: string, agentId: string, secret: Uint8Array): Promise<void> {
  const { enc, iv, tag } = encryptSecret(secret, keyHex);
  await db.insert(agentKeys).values({ agentId, pubkey: pubkeyOfSecret(secret), secretEnc: enc, iv, tag });
}

export async function loadAgentSecret(db: DbLike, keyHex: string, agentId: string): Promise<Uint8Array> {
  const [row] = await db.select().from(agentKeys).where(eq(agentKeys.agentId, agentId)).limit(1);
  if (!row) throw notFound(`Key for agent ${agentId}`);
  return decryptSecret({ enc: row.secretEnc, iv: row.iv, tag: row.tag }, keyHex);
}

// Decrypt, run one chain operation, zero the buffer. Callers never hold the secret beyond `fn`.
export async function withAgentSecret<T>(db: DbLike, keyHex: string, agentId: string, fn: (secret: Uint8Array) => Promise<T>): Promise<T> {
  const secret = await loadAgentSecret(db, keyHex, agentId);
  try {
    return await fn(secret);
  } finally {
    wipeSecret(secret);
  }
}
