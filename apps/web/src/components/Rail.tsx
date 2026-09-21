import { useEffect, useState } from 'react';
import { Link, NavLink } from 'react-router-dom';
import { PROTOCOL_DISCLAIMER } from '@runway/shared';
import { Badge } from './Badge';
import { navItems } from './nav';
import { RunwayStrip } from './RunwayStrip';
import { modeInfo } from '../lib/mode';
import { useAgentsStore } from '../store/agents';
import { useAppStore } from '../store/app';

const WORDMARK_LIGHTS = 5;
const RAIL_AGENTS = 4;

export function Rail() {
  const stats = useAppStore((s) => s.stats);
  const items = navItems();

  return (
    <aside className="rail">
      <Wordmark alive={stats?.alive ?? 0} dead={stats?.dead ?? 0} />
      <nav className="nav">
        {items.map((it) => (
          <NavLink key={it.idx} to={it.to} end={it.end} className={({ isActive }) => (isActive ? 'active' : undefined)}>
            <span className="idx">{it.idx}</span>
            {it.label}
          </NavLink>
        ))}
      </nav>
      <RailMine />
      <RailFoot />
    </aside>
  );
}

/** Every agent this identity owns, each with its own strip and control-board link (SPEC-V2 §9.1). */
function RailMine() {
  const me = useAppStore((s) => s.me);
  const byId = useAgentsStore((s) => s.byId);
  if (!me) return null;

  const mine = me.agents.map((a) => byId[a.id] ?? a);
  const shown = mine.slice(0, RAIL_AGENTS);

  return (
    <div className="rail-mine">
      <div className="rm-label">
        MY AGENTS
        {mine.length > 0 && <span className="faint"> · {mine.length}</span>}
      </div>
      {shown.length === 0 ? (
        <Link className="rm-spawn" to="/buy">BUY ONE →</Link>
      ) : (
        <>
          {shown.map((a) => (
            <div className="rm-agent" key={a.id}>
              <div className="rm-name">
                <Link to={`/control/${a.id}`}>{a.name}</Link>
                <Badge kind={a.phase} />
              </div>
              <div className="rm-strip">
                <RunwayStrip runwayDays={a.runwayDays} status={a.status} ageDays={a.ageDays} size="sm" />
              </div>
            </div>
          ))}
          <Link className="rm-spawn" to="/mine">ALL MY AGENTS →</Link>
        </>
      )}
    </div>
  );
}

/** "SCALE▌" with 5 lights: round(5 × alive / max(1, alive + dead)) green, rest end-dead (D31). */
function Wordmark({ alive, dead }: { alive: number; dead: number }) {
  const lit = Math.round((WORDMARK_LIGHTS * alive) / Math.max(1, alive + dead));
  return (
    <div className="wordmark">
      SCALE
      <span className="cursor" />
      <span className="wordmark-lights rw-lights" aria-hidden>
        {Array.from({ length: WORDMARK_LIGHTS }, (_, i) => (
          <i key={i} className={i < lit ? 'on-green' : 'end-dead'} />
        ))}
      </span>
    </div>
  );
}

function RailFoot() {
  const stats = useAppStore((s) => s.stats);
  const wsState = useAppStore((s) => s.wsState);
  const lastSyncAt = useAppStore((s) => s.lastSyncAt);
  const version = useAppStore((s) => s.version);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);

  const mode = modeInfo(stats);
  const synced = lastSyncAt === null ? '—' : `${Math.max(0, Math.round((now - lastSyncAt) / 1000))}s ago`;
  const cluster = stats ? (stats.chain.mode === 'memory' ? 'memory' : stats.chain.cluster) : '…';

  return (
    <div className="rail-foot">
      {mode.banner && <div><b>{mode.banner}</b></div>}
      <div>Most agents die. Buying one buys it compute, not a return.</div>
      <div title={PROTOCOL_DISCLAIMER}>
        WS {wsState === 'open' ? '●' : '○'} · synced {synced} · v{version ?? '?'} · {cluster}
      </div>
    </div>
  );
}
