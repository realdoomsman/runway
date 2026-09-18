import { NavLink } from 'react-router-dom';
import { fmtUsd } from '@runway/shared';
import { navItems } from './nav';
import { WalletButton } from './WalletButton';
import { chainBadge } from '../lib/mode';
import { useAppStore } from '../store/app';

export function Topbar() {
  const stats = useAppStore((s) => s.stats);
  const treasury = useAppStore((s) => s.treasury);

  return (
    <header className="topbar">
      <span className="kv">
        <span className="k">TREASURY</span>
        <span className="v mono-num">{treasury ? fmtUsd(treasury.usdcMicro) : '—'}</span>
      </span>
      <span className="kv">
        <span className="k">ALIVE</span>
        <span className="v mono-num pos">{stats?.alive ?? '—'}</span>
      </span>
      <span className="kv optional">
        <span className="k">DEAD</span>
        <span className="v mono-num">{stats?.dead ?? '—'}</span>
      </span>
      <span className="kv optional">
        <span className="k">EXT REV</span>
        <span className="v mono-num">{stats ? fmtUsd(stats.revenueExternalMicro) : '—'}</span>
      </span>
      <span className="chip">{chainBadge(stats)}</span>
      <span className="spacer" />
      <WalletButton />
    </header>
  );
}

/** Scroll row of the 7 nav links; CSS shows it only at ≤900px where the rail is hidden (D39). */
export function TopbarNav() {
  return (
    <nav className="topbar-nav">
      {navItems().map((it) => (
        <NavLink key={it.idx} to={it.to} end={it.end} className={({ isActive }) => (isActive ? 'active' : undefined)}>
          <span className="idx">{it.idx}</span>
          {it.label}
        </NavLink>
      ))}
    </nav>
  );
}
