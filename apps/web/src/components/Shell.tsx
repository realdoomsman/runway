import type { ReactNode } from 'react';
import { Outlet } from 'react-router-dom';
import { EnvBanner } from './EnvBanner';
import { Rail } from './Rail';
import { Ticker } from './Ticker';
import { Topbar, TopbarNav } from './Topbar';

/** rail + topbar + env banner + (≤900px) topbar-nav + content + ticker. */
export function Shell({ children }: { children: ReactNode }) {
  return (
    <div className="shell">
      <Rail />
      <div className="main">
        <Topbar />
        <EnvBanner />
        <TopbarNav />
        <main className="content">{children}</main>
      </div>
      <Ticker />
    </div>
  );
}

/** Route layout: everything except the full-screen control board renders inside the Shell. */
export function ShellLayout() {
  return (
    <Shell>
      <Outlet />
    </Shell>
  );
}
