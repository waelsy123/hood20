import { useEffect, useState } from "react";
import { MOCK } from "../config";
import { useApp } from "../lib/context";
import { pct, usdCompact } from "../lib/format";
import { Link } from "../lib/router";
import type { VaultInfo } from "../lib/types";
import { VaultCard } from "./Vaults";

export function Landing() {
  const { source, config } = useApp();
  const [vaults, setVaults] = useState<VaultInfo[]>([]);
  useEffect(() => {
    source.listVaults().then(setVaults).catch(() => setVaults([]));
  }, [source]);
  const tvl = vaults.reduce((s, v) => s + v.nav, 0n);

  return (
    <main>
      <section className="hero container">
        <div className="eyebrow">Robinhood Chain · tokenized stocks and crypto</div>
        <h1>Index vaults the market keeps balanced.</h1>
        <p className="lead">
          Fixed-weight baskets of tokenized stocks and crypto. Deposit and redeem pro-rata at any time. When prices drift,
          anyone can rebalance the vault at oracle prices for a fixed incentive. The protocol never trades.
        </p>
        <div className="cta-row">
          <Link to="/app" className="btn primary lg">Open the app</Link>
          <Link to="/docs" className="btn lg">How it works</Link>
        </div>
        {MOCK && (
          <div className="banner">
            Demo mode: the contracts are audited-in-progress and not deployed yet. The app runs on mocked vaults so every flow can be tried end to end.
          </div>
        )}
      </section>

      <section className="container">
        <div className="grid cols-4">
          <div className="card stat"><span className="label">Vaults</span><span className="value">{vaults.length}</span></div>
          <div className="card stat"><span className="label">Total value</span><span className="value">{usdCompact(tvl)}</span></div>
          <div className="card stat"><span className="label">Rebalance threshold</span><span className="value">{config ? pct(config.thresholdBps) : "—"}</span></div>
          <div className="card stat"><span className="label">Rebalancer incentive</span><span className="value">{config ? pct(config.incentiveBps) : "—"}</span></div>
        </div>
      </section>

      <section className="section container">
        <h2>How it works</h2>
        <p className="muted">Three moving parts. None of them is a manager.</p>
        <div className="grid cols-3" style={{ marginTop: 28 }}>
          <div className="card step"><span className="num">1</span><h3>Deposit pro-rata</h3><p className="muted">You add every asset in the vault's current ratio and receive INDEX shares. Redeem any time for your slice of each asset. No oracle is involved, so nobody can mint against a stale price.</p></div>
          <div className="card step"><span className="num">2</span><h3>Prices drift</h3><p className="muted">Each asset is valued through its own Chainlink adapter. Once any asset sits 0.5% of NAV away from its target weight, the vault is open for rebalancing.</p></div>
          <div className="card step"><span className="num">3</span><h3>The market rebalances</h3><p className="muted">Any contract can pull the excess of overweight assets and push in the shortfall of underweight ones, keeping 0.5% of the misplaced value. The call reverts unless the vault lands back on target.</p></div>
        </div>
        <div className="quote">The protocol does not rebalance the portfolio. The market does.</div>
      </section>

      <section className="section container" style={{ paddingTop: 0 }}>
        <div className="grid cols-2">
          <div className="card">
            <h3>Built to be hard to abuse</h3>
            <ul className="muted" style={{ lineHeight: 1.7, paddingLeft: 18 }}>
              <li>No owner on the vault, no upgrades, no protocol trades.</li>
              <li>Pull-rights exist only inside a rebalance callback and are revoked before the balance check.</li>
              <li>NAV may drop by at most the incentive on the misplaced value; anything else reverts.</li>
              <li>Feeds that are stale, invalid or closed make the vault refuse to rebalance. Weekends fail closed.</li>
              <li>Shared settings live in one config with hard caps: fee ≤ 5%, incentive ≤ 1%, threshold ≤ 10%.</li>
            </ul>
          </div>
          <div className="card">
            <h3>For arbitrageurs</h3>
            <p className="muted">Implement one function, <code>onRebalance(bytes)</code>, and do the exchange your way: inventory, a DEX route, or a Uniswap v2 flash swap. The vault lends you allowance over the assets you name, calls you back, revokes, and verifies.</p>
            <Link to="/docs" className="btn sm">Rebalancer guide</Link>
          </div>
        </div>
      </section>

      {vaults.length > 0 && (
        <section className="section container" style={{ paddingTop: 0 }}>
          <div className="page-head" style={{ marginTop: 0 }}>
            <h2>Vaults</h2>
            <Link to="/app" className="btn sm">See all</Link>
          </div>
          <div className="grid cols-2">
            {vaults.slice(0, 2).map((v) => (
              <VaultCard key={v.address} v={v} />
            ))}
          </div>
        </section>
      )}
    </main>
  );
}
