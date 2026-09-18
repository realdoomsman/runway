import { NavLink } from 'react-router-dom';
import { fmtUsd } from '@runway/shared';
import { navItems } from './nav';
import { WalletButton } from './WalletButton';
import { chainBadge, modeInfo } from '../lib/mode';
import { useAppStore } from '../store/app';

const MODE_TITLE: Record<string, string> = {
  DEMO: 'DEMO=1 — this colony was seeded, the chain is simulated and the agents run on a mock model.',
  SIM: 'CHAIN_MODE=memory — deposit addresses and balances are simulated. No real money moves.',
  DEVNET: 'Solana devnet — Circle test USDC. Balances are not real money.',
  MAINNET: 'Solana mainnet — real USDC.',
};

export function Topbar() {
  const stats = useAppStore((s) => s.stats);
  const treasury = useAppStore((s) => s.treasury);
  // The mode chip sits next to the numbers it qualifies: every figure in this bar is play money
  // unless it reads MAINNET, and the chip says so without the reader having to look anywhere else.
  const mode = modeInfo(stats);

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
      {stats && (
        <span className={mode.label === 'MAINNET' ? 'chip' : 'chip chip-warn'} title={MODE_TITLE[mode.label]}>
          {mode.label}
        </span>
      )}
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
