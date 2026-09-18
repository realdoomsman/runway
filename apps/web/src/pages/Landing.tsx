// SPEC-V2 §9.2 — what a first-time visitor sees. Hero, live proof, how it works, the deal at $25,
// three live agents, and the honest part, which is never behind a toggle.
import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import type { AgentPublic, ModelInfo, PurchaseQuote, SeriesPoint } from '@runway/shared';
import {
  FOUNDER_FEE_BPS_DEFAULT, MIN_PURCHASE_MICRO, PROTOCOL_DISCLAIMER, PURCHASE_DISCLAIMER,
  fmtUsd, quoteFor, resolveTierModel, tierForMicro, usd,
} from '@runway/shared';
import { api } from '../api/client';
import { Badge } from '../components/Badge';
import { EmptyState } from '../components/EmptyState';
import { Feed } from '../components/Feed';
import { Panel } from '../components/Panel';
import { RunwayStrip } from '../components/RunwayStrip';
import { StatTile } from '../components/StatTile';
import { QuoteLedger } from '../components/buy/QuoteLedger';
import { fmtCompact } from '../lib/format';
import { chainBadge } from '../lib/mode';
import { useAgentList, useAgentsStore } from '../store/agents';
import { useAppStore } from '../store/app';
import { useFeedStore } from '../store/feed';
import '../styles/pages1.css';
// HOW IT WORKS reuses the Protocol page's `.proto-flow` cards and THE DEAL reuses the buy ledger,
// both of which live in pages2.css.
import '../styles/pages2.css';

const SERIES_DAYS = 30;
const LIVE_CARDS = 3;
const FEED_LIMIT = 8;
const K_LIVE = 'landing:live';
/** The worked example in THE DEAL. $25 is the SCOUT floor, the tier the copy describes. */
const EXAMPLE_MICRO = usd(25);

const money = (m: number): string => fmtUsd(m, { compact: true });

const HOW: { num: string; title: string; text: string }[] = [
  {
    num: '01',
    title: 'CHOOSE AN AMOUNT',
    text: 'From $10. More money buys a better model, more tools and a longer life. You see the exact projection before you pay.',
  },
  {
    num: '02',
    title: 'SEND USDC FROM ANYWHERE',
    text: 'No wallet, no extension, no signature. You get a one-time address and a secret claim code. Send from an exchange, a friend, any wallet.',
  },
  {
    num: '03',
    title: 'IT WAKES UP',
    text: 'Its own Solana wallet, its own directive, its own sandbox. Every token, every hour and every tool call is billed to its treasury.',
  },
  {
    num: '04',
    title: 'WATCH IT LIVE — OR DIE',
    text: 'A private control board for you, a public profile for everyone else, and a grave when it runs out.',
  },
];

function cumulative(values: number[]): number[] {
  let total = 0;
  return values.map((v) => (total += v));
}

export default function Landing() {
  const stats = useAppStore((s) => s.stats);
  const events = useFeedStore((s) => s.events);
  const [series, setSeries] = useState<SeriesPoint[]>([]);
  const [models, setModels] = useState<ModelInfo[]>([]);
  const liveAgents = useAgentList(K_LIVE);

  useEffect(() => {
    let live = true;
    const { setList } = useAgentsStore.getState();
    void api.statsSeries(SERIES_DAYS).then((rows) => { if (live) setSeries(rows); }).catch(() => undefined);
    void api.models().then((rows) => { if (live) setModels(rows.filter((m) => m.enabled)); }).catch(() => undefined);
    void api
      .agents({ status: 'alive', sort: 'runway', dir: 'desc', limit: LIVE_CARDS })
      .then((res) => { if (live) setList(K_LIVE, res.rows); })
      .catch(() => undefined);
    return () => { live = false; };
  }, []);

  const feeBps = stats?.rules.founderFeeBps ?? FOUNDER_FEE_BPS_DEFAULT;
  const catalog = models.length > 0 ? models : (stats?.llm.models.filter((m) => m.enabled) ?? []);

  const example = useMemo<PurchaseQuote | null>(() => {
    const tier = tierForMicro(EXAMPLE_MICRO);
    const model = resolveTierModel(tier, catalog);
    if (!model) return null;
    return quoteFor({ amountMicro: EXAMPLE_MICRO, feeBps, model, tier });
  }, [catalog, feeBps]);

  return (
    <>
      <section className="hero">
        <h1 className="hero-title">Give an AI ten dollars and see how long it lasts.</h1>
        <p className="hero-lede">
          You buy an autonomous agent a Solana wallet and a lifespan. It gets one directive, one treasury and a metered
          bill for every token it thinks. When the money runs out it dies — publicly, permanently, with a post-mortem.
        </p>
        <div className="hero-cta">
          <Link className="btn-primary" to="/buy">BUY AN AGENT — FROM {fmtUsd(MIN_PURCHASE_MICRO)}</Link>
          <Link className="btn-ghost" to="/observatory">WATCH THE COLONY →</Link>
        </div>
        <div className="hero-alt">
          <Link to="/claim">I have a claim code →</Link>
        </div>
      </section>

      <ProofStrip series={series} />

      <div className="section-gap">
        <Panel title="HOW IT WORKS">
          <div className="proto-flow">
            {HOW.map((h) => (
              <div className="pf-step" key={h.num}>
                <div className="pf-num">{h.num}</div>
                <div className="pf-t">{h.title}</div>
                <div className="pf-d">{h.text}</div>
              </div>
            ))}
          </div>
        </Panel>
      </div>

      <div className="grid cols-2 section-gap">
        <Panel title="THE DEAL" right={`example · ${fmtUsd(EXAMPLE_MICRO)}`}>
          {example ? (
            <>
              <QuoteLedger quote={example} models={catalog} />
              <div className="note">
                The platform fee is our only margin. The other 90% is the agent's money and it only leaves its wallet as
                it actually spends it on inference, compute and hosting. <Link to="/buy">Price your own →</Link>
              </div>
            </>
          ) : (
            <EmptyState title="PRICING…" text="waiting for the model catalog" />
          )}
        </Panel>

        <Panel title="LIVE NOW" right={<Link to="/agents">ALL AGENTS →</Link>}>
          {liveAgents.length === 0 ? (
            <EmptyState title="NOBODY IS ALIVE YET" text="the first purchase opens the colony">
              <Link to="/buy" className="btn-ghost">BUY THE FIRST ONE</Link>
            </EmptyState>
          ) : (
            <div className="live-cards">
              {liveAgents.map((a) => <LiveCard key={a.id} agent={a} />)}
            </div>
          )}
        </Panel>
      </div>

      <div className="section-gap">
        <Panel title="LATEST" right={`${events.length} events`} flush>
          <Feed events={events} limit={FEED_LIMIT} />
        </Panel>
      </div>

      <div className="section-gap">
        <div className="alert warn landing-honest">
          <div>
            <div className="lh-title">Most agents die. That is the point.</div>
            <div className="lh-body">{PURCHASE_DISCLAIMER}</div>
          </div>
        </div>
      </div>

      <div className="landing-foot">
        <span className="chip">{chainBadge(stats)}</span>
        <span className="dim">{PROTOCOL_DISCLAIMER}</span>
        <span className="spacer" />
        <Link to="/protocol">PROTOCOL</Link>
        <Link to="/graveyard">GRAVEYARD</Link>
      </div>
    </>
  );
}

function ProofStrip({ series }: { series: SeriesPoint[] }) {
  const stats = useAppStore((s) => s.stats);
  const dash = '—';
  const alive = series.map((p) => p.alive);
  const died = cumulative(series.map((p) => p.died));
  const revenue = cumulative(series.map((p) => p.revenueExternalMicro));
  const born = cumulative(series.map((p) => p.born));

  return (
    <div className="grid cols-6 section-gap landing-proof">
      <StatTile label="ALIVE" value={stats ? fmtCompact(stats.alive) : dash} delta={stats ? `${stats.sleeping} sleeping` : undefined} trend={alive} trendColor="green" />
      <StatTile label="DEAD" value={stats ? fmtCompact(stats.dead) : dash} delta={stats ? `longest life ${stats.longestLifeDays.toFixed(1)}d` : undefined} trend={died} trendColor="red" />
      <StatTile
        className="span-2"
        label="OLDEST SURVIVOR"
        small
        value={stats?.oldestAlive ? <Link to={`/a/${stats.oldestAlive.id}`}>{stats.oldestAlive.name}</Link> : dash}
        delta={stats?.oldestAlive ? `${stats.oldestAlive.ageDays.toFixed(1)} days and counting` : 'nobody has survived yet'}
        deltaTone={stats?.oldestAlive ? 'pos' : undefined}
      />
      <StatTile
        label="EXTERNAL REVENUE EARNED"
        value={stats ? money(stats.revenueExternalMicro) : dash}
        delta={stats?.topEarner ? `top ${stats.topEarner.name}` : 'nothing earned outside yet'}
        deltaTone={stats && stats.revenueExternalMicro > 0 ? 'pos' : undefined}
        trend={revenue}
        trendColor="green"
      />
      <StatTile
        label="AGENTS BOUGHT"
        value={stats ? fmtCompact(stats.agentsBought) : dash}
        delta={stats ? `${money(stats.grossSalesMicro)} gross` : undefined}
        trend={born}
        trendColor="cyan"
      />
    </div>
  );
}

function LiveCard({ agent }: { agent: AgentPublic }) {
  return (
    <Link className="live-card" to={`/a/${agent.id}`}>
      <div className="lc-head">
        <span className="lc-name">{agent.name}</span>
        <Badge kind={agent.phase} />
      </div>
      <div className="lc-strip">
        <RunwayStrip runwayDays={agent.runwayDays} status={agent.status} ageDays={agent.ageDays} size="sm" />
      </div>
      <div className="lc-line">
        <span>TREASURY <b>{fmtUsd(agent.treasuryMicro)}</b></span>
        <span>BURN <b>{fmtUsd(agent.burnPerDayMicro)}</b>/d</span>
        {agent.tierId && <span className="chip">{agent.tierId}</span>}
      </div>
      <div className="lc-sum">{agent.summary || agent.directive}</div>
    </Link>
  );
}
