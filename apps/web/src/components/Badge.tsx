import type { AgentPhase, AgentPublic, BountyStatus } from '@runway/shared';
export type BadgeKind = AgentPhase | BountyStatus | 'sim';

interface BadgeProps {
  kind: BadgeKind;
  /** Override the uppercased kind text (e.g. "SPAWNING…"). */
  label?: string;
  className?: string;
}

/** Status/phase badge (D30): text uppercased, class = kind. */
export function Badge({ kind, label, className }: BadgeProps) {
  return (
    <span className={['badge', kind, className ?? ''].filter(Boolean).join(' ')}>
      <i />
      {(label ?? kind).toUpperCase()}
    </span>
  );
}

/** Phase badge plus the dashed SIM chip for mock-driven agents (D29). */
export function AgentBadges({ agent, label }: { agent: Pick<AgentPublic, 'phase' | 'simulated'>; label?: string }) {
  return (
    <>
      <Badge kind={agent.phase} label={label} />
      {agent.simulated && <Badge kind="sim" />}
    </>
  );
}
