import { useEffect, useState } from "react";
import { MOCK } from "../config";
import { useApp } from "../lib/context";
import { pct, usd, usdCompact } from "../lib/format";
import { navPerShare } from "../lib/math";
import { Link } from "../lib/router";
import { rebalanceState } from "../lib/status";
import type { VaultInfo } from "../lib/types";

function Flagship({ v }: { v: VaultInfo }) {
  const { config, block } = useApp();
  const s = rebalanceState(v, config, block);
  const max = Math.max(...v.assets.map((a) => a.weightBps));
  return (
    <div className="flag">
      <div className="top">
        <div><div className="name">{v.name}</div><div className="sub mono">{v.symbol} · {v.assets.length} assets</div></div>
        <span className={`pill ${s.kind === "open" ? "warn" : "good"}`}><span className="dot" />{s.kind === "open" ? "rebalance open" : "on target"}</span>
      </div>
      <div className="big">{usd(navPerShare(v), 4)}</div>
      <div className="sub">per share · {usdCompact(v.nav)} in the vault · max drift {pct(v.deviationBps)}</div>
      <div className="comp">
        {v.assets.map((a) => (
          <div className="r" key={a.token}>
            <span className="sym">{a.symbol}</span>
            <span className="track"><i style={{ width: `${(a.weightBps / max) * 100}%` }} /></span>
            <span className="pct">{pct(a.weightBps, 0)}</span>
          </div>
        ))}
      </div>
      <div className="cta">
        <Link to={`/app/vault/${v.address}`} className="btn primary">Get {v.symbol}</Link>
        <Link to={`/app/vault/${v.address}`} className="btn">Details</Link>
      </div>
    </div>
  );
}

export function Landing() {
  const { source } = useApp();
  const [vaults, setVaults] = useState<VaultInfo[]>([]);
  useEffect(() => {
    source.listVaults().then(setVaults).catch(() => setVaults([]));
  }, [source]);
  const flagship = vaults[0];

  return (
    <main>
      <section className="hero2">
        <div className="container">
          <div>
            <div className="eyebrow" style={{ color: "var(--accent)", fontWeight: 700, letterSpacing: ".12em", textTransform: "uppercase", fontSize: ".8rem" }}>Robinhood Chain</div>
            <h1 style={{ marginTop: 10 }}>The market's heaviest names, <span className="glow">in one token.</span></h1>
            <p className="lead">
              hood20 Core holds SPY, NVDA, AAPL, MSFT, AMZN and GOOGL at fixed weights. Buy it, hold it, redeem the real assets whenever you like.
              It stays on target by itself.
            </p>
            <div className="cta-row">
              {flagship ? <Link to={`/app/vault/${flagship.address}`} className="btn primary lg">Get {flagship.symbol}</Link> : <Link to="/app" className="btn primary lg">Open the app</Link>}
              <Link to="/create" className="btn lg">Create your own index</Link>
            </div>
            {MOCK && <p className="muted small" style={{ marginTop: 18 }}>Demo mode: contracts are not deployed yet, so every number here is simulated. The flows are real.</p>}
          </div>
          <div>{flagship ? <Flagship v={flagship} /> : <div className="flag"><div className="name">Loading…</div></div>}</div>
        </div>
      </section>

      <section className="container">
        <div className="outcomes">
          <div className="outcome"><div className="k">always on target</div><h3>Rebalanced by the market</h3><p>Whenever the mix drifts, arbitrageurs are paid to bring it back. No manager, no protocol trades, no waiting.</p></div>
          <div className="outcome"><div className="k">fully backed</div><h3>Redeem the real assets</h3><p>Every token is backed one-to-one by the basket. Redeem for your share of each asset at any moment.</p></div>
          <div className="outcome"><div className="k">creators earn</div><h3>Launch your own index</h3><p>Pick the assets, set the weights, seed it. You earn 10% of every rebalancer's fee on your index, forever.</p></div>
        </div>
      </section>

      <section className="container">
        <div className="create-cta">
          <div>
            <h2>Your index, your weights.</h2>
            <p className="muted" style={{ marginTop: 0 }}>Three steps and a seed deposit. The factory deploys the vault and makes the first deposit in one transaction, so nobody can front-run your launch.</p>
            <Link to="/create" className="btn primary">Build an index</Link>
          </div>
          <div className="steps">
            <div className="s"><b>01</b><span>Pick from the curated stocks and crypto</span></div>
            <div className="s"><b>02</b><span>Set weights that add up to 100%</span></div>
            <div className="s"><b>03</b><span>Seed it and share the token</span></div>
          </div>
        </div>
      </section>
    </main>
  );
}
