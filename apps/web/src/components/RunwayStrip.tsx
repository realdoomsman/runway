import type { AgentStatus } from '@runway/shared';

const LIGHTS = 12;
const DAYS_PER_LIGHT = 2.5;

interface RunwayStripProps {
  runwayDays: number | null;
  status: AgentStatus;
  size?: 'sm' | 'lg';
  /** Used for the "DIED D+{age}" label on dead agents. */
  ageDays?: number;
  className?: string;
}

export type RunwayTone = 'green' | 'amber' | 'red';

/** >14d green, 3–14d amber, <3d red (D31). */
export function runwayTone(runwayDays: number | null): RunwayTone {
  if (runwayDays === null || runwayDays > 14) return 'green';
  if (runwayDays >= 3) return 'amber';
  return 'red';
}

/** 12 lights × 2.5 days; exact contract from AMENDMENTS D31. */
export function RunwayStrip({ runwayDays, status, size, ageDays, className }: RunwayStripProps) {
  const cls = ['rw-strip', size ?? '', className ?? ''].filter(Boolean).join(' ');
  const dead = status === 'dead';
  const lit = dead ? LIGHTS : runwayDays === null ? LIGHTS : Math.min(LIGHTS, Math.max(1, Math.ceil(runwayDays / DAYS_PER_LIGHT)));
  const lightClass = dead ? 'end-dead' : `on-${runwayTone(runwayDays)}`;

  return (
    <span className={cls}>
      <span className="rw-lights">
        {Array.from({ length: LIGHTS }, (_, i) => (
          <i key={i} className={i < lit ? lightClass : undefined} />
        ))}
      </span>
      <span className="rw-days">
        {dead ? (
          `DIED D+${Math.max(0, Math.floor(ageDays ?? 0))}`
        ) : runwayDays === null ? (
          '∞'
        ) : (
          <>
            <b>{runwayDays.toFixed(1)}</b>d
          </>
        )}
      </span>
    </span>
  );
}
