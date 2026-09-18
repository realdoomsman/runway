// wallet: read-only balance and ledger history. No arbitrary sends in v1 (SPEC §8.9).
import { desc, eq } from 'drizzle-orm';
import { z } from 'zod';
import { fmtUsd } from '@runway/shared';
import type { CoreDeps } from '../core/interfaces.js';
import { ledger } from '../db/schema.js';
import { freshAgent, ok } from './common.js';
import { defineTool, type ToolSpec } from './spec.js';

export const WALLET_HISTORY_ROWS = 25;

export function walletTools(deps: CoreDeps): ToolSpec[] {
  const wallet = defineTool({
    name: 'wallet',
    description:
      `Inspect your own wallet. "balance" returns your public key, on-chain USDC and SOL, the spend not yet ` +
      `settled on-chain and the cluster; "history" returns your last ${WALLET_HISTORY_ROWS} ledger entries ` +
      `(rent, inference, tools, revenue, payments). Call it when you need exact figures for a decision or to ` +
      `give a customer your address. Read-only, free; you cannot send funds directly (payments happen through ` +
      `call_service and post_bounty).`,
    params: z.strictObject({
      action: z.enum(['balance', 'history']).describe('"balance" or "history".'),
    }),
    parallelSafe: true,
    summarize: (i) => i.action,
    async run(ctx, input) {
      const agent = await freshAgent(deps.db, ctx.agent.id);
      if (input.action === 'balance') {
        const [usdcMicro, solLamports] = await Promise.all([
          deps.chain.getUsdcBalance(agent.walletPubkey),
          deps.chain.getSolBalance(agent.walletPubkey),
        ]);
        return ok(JSON.stringify({
          pubkey: agent.walletPubkey, usdcMicro, solLamports, unsettledMicro: agent.unsettledMicro, cluster: deps.chain.cluster,
        }));
      }
      const rows = await deps.db.select().from(ledger).where(eq(ledger.agentId, agent.id)).orderBy(desc(ledger.id)).limit(WALLET_HISTORY_ROWS);
      if (rows.length === 0) return ok('No ledger entries yet.');
      const lines = rows.map((r) => {
        const extra = [r.counterparty ? `to/from ${r.counterparty}` : '', r.txSig ? `tx ${r.txSig.slice(0, 8)}…` : ''].filter(Boolean).join(' ');
        return `${r.ts.toISOString()} ${r.kind.padEnd(16)} ${fmtUsd(r.amountMicro, { sign: true }).padStart(11)}  bal ${fmtUsd(r.balanceAfterMicro)}  ${r.memo}${extra ? ` (${extra})` : ''}`;
      });
      return ok(lines.join('\n'));
    },
  });

  return [wallet];
}
