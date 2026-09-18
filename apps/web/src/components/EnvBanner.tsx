import { modeInfo } from '../lib/mode';
import { useAppStore } from '../store/app';

/** Amber 24px banner under the topbar (D29); hidden only for mainnet + real router. */
export function EnvBanner() {
  const stats = useAppStore((s) => s.stats);
  const { banner } = modeInfo(stats);
  if (!banner) return null;
  return <div className="env-banner">{banner}</div>;
}
