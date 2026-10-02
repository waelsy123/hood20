import { useEffect, useState } from "react";
import { MOCK } from "../config";
import { useApp } from "../lib/context";
import { amount, pct, usd, usdCompact } from "../lib/format";
import { navPerShare } from "../lib/math";
import { Link } from "../lib/router";
import { rebalanceState } from "../lib/status";
import type { VaultInfo } from "../lib/types";
import { ConfigOwnerPanel } from "../components/ConfigOwnerPanel";

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

function CreateCard() {
  const { config } = useApp();
  return (
    <Link to="/create" className="card link create-card">
      <span className="plus">+</span>
      <span>
        <span className="title">Create your own index</span>
        <span className="muted">Pick the assets, set the weights, seed it. You earn {config ? `${config.creatorShareBps / 100}%` : "10%"} of every rebalancer's fee on your index.</span>
      </span>
      <span className="btn primary">Build an index</span>
    </Link>
  );
}

/** Shown to the wallet named by a pending two-step ownership transfer of the shared config. */
function AcceptOwnership() {
  const { source, wallet, config, setError } = useApp();
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<string | null>(null);
  if (!config || !wallet.address || config.pendingOwner.toLowerCase() !== wallet.address.toLowerCase()) return null;
  const accept = async () => {
    setBusy(true);
    try {
      const r = await source.acceptConfigOwnership(wallet.address!);
      setDone(r.hash);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="card" style={{ marginBottom: 16 }}>
      <div className="row between">
        <span>Your wallet is the pending owner of the shared config <span className="mono muted small">{config.address}</span>. Accepting completes the handover; the deployer key then owns nothing.</span>
        {done ? <span className="muted small">accepted · {done.slice(0, 10)}…</span> : <button className="btn primary" disabled={busy} onClick={accept}>{busy ? "Accepting…" : "Accept ownership"}</button>}
      </div>
    </div>
  );
}

export function Vaults() {
  const { source, setError } = useApp();
  const [vaults, setVaults] = useState<VaultInfo[] | null>(null);
  useEffect(() => {
    let alive = true;
    const load = () =>
      source
        .listVaults()
        .then((v) => alive && setVaults(v))
        .catch((e) => {
          if (!alive) return;
          if (vaults === null) setError((e as Error).message);
          else console.warn("vault list refresh failed", e);
        });
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
      <AcceptOwnership />
      <ConfigOwnerPanel />
      {vaults === null ? (
        <p className="muted">Loading…</p>
      ) : (
        <div className="grid cols-2">
          {vaults.map((v) => (
            <VaultCard key={v.address} v={v} />
          ))}
          <CreateCard />
        </div>
      )}
    </main>
  );
}
