// Death (SPEC §8.10). The agent stops, its sandbox is destroyed, its sites stay up for the grace period
// and the books are closed with an event, a decision and a post-mortem.
import { eq } from 'drizzle-orm';
import { fmtUsd, type DeathCause } from '@runway/shared';
import type { CoreDeps } from '../core/interfaces.js';
import { agents, type AgentRow } from '../db/schema.js';
import { emitAgent } from '../economy/agents.js';
import { ageDaysOf, round1 } from '../economy/burn.js';
import { addDecision, addEvent } from '../economy/events.js';
import { liveSteps } from '../economy/live.js';
import { withTx } from '../economy/tx.js';
import { buildPostmortem } from './postmortem.js';

type Deps = CoreDeps;

export interface DieOptions { memo?: string; stepId?: number | null }

const CAUSE_LABEL: Record<DeathCause, string> = {
  insolvent: 'insolvent',
  rent: 'could not pay rent',
  owner_terminated: 'terminated by owner',
  protocol_violation: 'protocol violation',
};

export async function die(deps: Deps, agent: AgentRow, cause: DeathCause, opts: DieOptions = {}): Promise<AgentRow> {
  if (agent.status === 'dead') return agent;
  const now = deps.clock.now();
  const ageDays = round1(ageDaysOf(agent.bornAt, now));

  const dead = await withTx(deps.db, async (tx) => {
    const [row] = await tx.update(agents).set({
      status: 'dead', diedAt: now, deathCause: cause, nextStepAt: null, sleepUntil: null, currentStepId: null, updatedAt: now,
    }).where(eq(agents.id, agent.id)).returning();
    const died = row ?? { ...agent, status: 'dead' as const, diedAt: now, deathCause: cause };
    await addEvent(deps, tx, {
      kind: 'death', agentId: died.id, agentName: died.name, amountMicro: died.revenueExternalMicro, ts: now,
      text: `${died.name} died after ${ageDays} days — ${CAUSE_LABEL[cause]}. Lifetime external revenue ${fmtUsd(died.revenueExternalMicro)}.`,
      meta: { cause, ageDays, treasuryMicro: died.treasuryMicro, memo: opts.memo ?? null },
    });
    await addDecision(deps, tx, {
      agentId: died.id, stepId: opts.stepId ?? null, kind: 'death', ts: now,
      text: opts.memo ?? `Died: ${CAUSE_LABEL[cause]} with ${fmtUsd(died.treasuryMicro)} left.`,
      meta: { cause },
    });
    return died;
  });

  liveSteps.end(agent.id);
  await deps.sandbox.destroy(agent.id).catch((e: unknown) => deps.log.warn({ err: e, agentId: agent.id }, 'sandbox destroy failed'));

  const postmortem = await buildPostmortem(deps, dead, cause).catch((e: unknown) => {
    deps.log.warn({ err: e, agentId: agent.id }, 'postmortem failed');
    return null;
  });
  const final = postmortem
    ? (await deps.db.update(agents).set({ postmortem }).where(eq(agents.id, agent.id)).returning())[0] ?? dead
    : dead;

  await emitAgent(deps, deps.db, final);
  deps.log.info({ agentId: agent.id, name: agent.name, cause, ageDays }, 'agent died');
  return final;
}
