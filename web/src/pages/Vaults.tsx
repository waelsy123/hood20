import { useEffect, useState } from "react";
import { MOCK } from "../config";
import { useApp } from "../lib/context";
import { amount, pct, usd, usdCompact } from "../lib/format";
import { navPerShare } from "../lib/math";
import { Link } from "../lib/router";
import { rebalanceState } from "../lib/status";
import type { VaultInfo } from "../lib/types";

export function StatePill({ v }: { v: VaultInfo }) {
  const { config, block } = useApp();
  const s = rebalanceState(v, config, block);
  const cls = s.kind === "open" ? "warn" : s.kind === "balanced" ? "good" : "";
  return (
    <span className={`pill ${cls}`}>
      <span className="dot" />
      {s.label} · {pct(v.deviationBps)} off
    </span>
  );
}

export function VaultCard({ v }: { v: VaultInfo }) {
  return (
    <Link to={`/app/vault/${v.address}`} className="card link">
      <div className="row between">
        <h3 style={{ margin: 0 }}>{v.name} <span className="muted mono small">{v.symbol}</span></h3>
        <StatePill v={v} />
      </div>
      <div className="grid cols-3" style={{ marginTop: 16 }}>
        <div className="stat"><span className="label">NAV</span><span className="value sm">{usdCompact(v.nav)}</span></div>
        <div className="stat"><span className="label">Per share</span><span className="value sm">{usd(navPerShare(v), 4)}</span></div>
        <div className="stat"><span className="label">Supply</span><span className="value sm">{amount(v.totalSupply, 18, 0)}</span></div>
      </div>
      <div className="assets-pills">
        {v.assets.map((a) => (
          <span key={a.token} className="pill">{a.symbol} <span className="muted">{pct(a.weightBps, 0)}</span></span>
        ))}
      </div>
    </Link>
  );
}

export function Vaults() {
  const { source, setError } = useApp();
  const [vaults, setVaults] = useState<VaultInfo[] | null>(null);
  useEffect(() => {
    let alive = true;
    const load = () => source.listVaults().then((v) => alive && setVaults(v)).catch((e) => alive && setError((e as Error).message));
    void load();
    const id = setInterval(load, 15_000);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, [source, setError]);

  return (
    <main className="container" style={{ minHeight: "60vh" }}>
      <div className="page-head">
        <div>
          <h2>Vaults</h2>
          <p className="muted" style={{ margin: 0 }}>Every vault deployed through the hood20 factory{MOCK ? " (mocked in demo mode)" : ""}.</p>
        </div>
      </div>
      {vaults === null ? (
        <p className="muted">Loading…</p>
      ) : vaults.length === 0 ? (
        <div className="card"><p className="muted">No vaults yet.</p></div>
      ) : (
        <div className="grid cols-2">
          {vaults.map((v) => (
            <VaultCard key={v.address} v={v} />
          ))}
        </div>
      )}
    </main>
  );
}
