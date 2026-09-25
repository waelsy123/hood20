import { useEffect, useMemo, useState } from "react";
import { parseUnits } from "viem";
import { MOCK } from "../config";
import { useApp } from "../lib/context";
import { amount, usd } from "../lib/format";
import { seedAmountsFor } from "../lib/math";
import { navigate } from "../lib/router";
import type { CuratedAsset } from "../lib/types";

export function Create() {
  const { source, wallet, config, setError } = useApp();
  const [catalog, setCatalog] = useState<CuratedAsset[]>([]);
  const [balances, setBalances] = useState<bigint[]>([]);
  const [name, setName] = useState("");
  const [symbol, setSymbol] = useState("");
  const [weights, setWeights] = useState<Record<string, number>>({});
  const [seedUsd, setSeedUsd] = useState("10000");
  const [busy, setBusy] = useState<string | null>(null);

  useEffect(() => {
    source.listAssets().then(setCatalog).catch((e) => setError((e as Error).message));
  }, [source, setError]);
  useEffect(() => {
    if (!wallet.address || catalog.length === 0) return;
    source.walletBalances(catalog, wallet.address).then(setBalances).catch(() => setBalances([]));
  }, [source, wallet.address, catalog]);

  const picks = useMemo(() => catalog.filter((a) => (weights[a.key] ?? 0) > 0).map((a) => ({ asset: a, weightBps: Math.round(weights[a.key] * 100) })), [catalog, weights]);
  const total = picks.reduce((s, p) => s + p.weightBps, 0);
  const seed = (() => {
    try {
      return parseUnits(seedUsd || "0", 18);
    } catch {
      return 0n;
    }
  })();
  const seedAmounts = useMemo(() => seedAmountsFor(picks.map((p) => ({ unitValue: p.asset.unitValue, decimals: p.asset.decimals, weightBps: p.weightBps })), seed), [picks, seed]);
  const shortfall = picks.map((p, i) => {
    const idx = catalog.indexOf(p.asset);
    return balances.length ? seedAmounts[i] > (balances[idx] ?? 0n) : false;
  });
  const ready = name.trim().length > 1 && symbol.trim().length > 1 && picks.length >= 2 && total === 10_000 && seed > 0n && !shortfall.some(Boolean) && !busy;

  const toggle = (a: CuratedAsset) => {
    setWeights((w) => {
      const next = { ...w };
      if (next[a.key]) delete next[a.key];
      else next[a.key] = 0;
      const keys = Object.keys(next);
      if (keys.length) {
        const even = Math.floor(100 / keys.length);
        keys.forEach((k, i) => (next[k] = i === 0 ? 100 - even * (keys.length - 1) : even));
      }
      return next;
    });
  };
  const setW = (key: string, v: string) => setWeights((w) => ({ ...w, [key]: Math.max(0, Math.min(100, Number(v) || 0)) }));

  const launch = async () => {
    if (!wallet.address) return wallet.connect().catch((e) => setError((e as Error).message));
    setBusy("Launching…");
    try {
      const r = await source.createVault({ name: name.trim(), symbol: symbol.trim().toUpperCase(), picks, seedAmounts }, wallet.address);
      navigate(`/app/vault/${r.vault}`);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  };

  return (
    <main className="container" style={{ maxWidth: 900, minHeight: "60vh" }}>
      <div className="page-head">
        <div>
          <h2>Create an index</h2>
          <p className="muted" style={{ margin: 0 }}>Pick assets, set weights, seed it. You earn {config ? `${config.creatorShareBps / 100}%` : "10%"} of every rebalancer's fee on your index.</p>
        </div>
      </div>

      <div className="grid cols-2" style={{ alignItems: "start" }}>
        <div className="card">
          <h3>1 · Assets and weights</h3>
          <div className="picker">
            {catalog.map((a) => {
              const on = weights[a.key] !== undefined;
              return (
                <label key={a.key} className={`pick ${on ? "on" : ""}`}>
                  <input type="checkbox" checked={on} onChange={() => toggle(a)} />
                  <span><span className="sym">{a.symbol}</span> <span className="muted small">{a.name.replace(" (Robinhood Stock Token)", "")}</span></span>
                  <span className="price">{usd(a.unitValue)}</span>
                  <span className="weight">{on ? <><input inputMode="numeric" value={weights[a.key]} onChange={(e) => setW(a.key, e.target.value)} />%</> : <span className="muted small">—</span>}</span>
                </label>
              );
            })}
          </div>
          <div className="row between" style={{ marginTop: 12 }}>
            <span className="muted small">{picks.length} assets selected (min 2)</span>
            <span className={`sum ${total === 10_000 ? "ok" : "bad"}`}>{(total / 100).toFixed(0)}% / 100%</span>
          </div>
        </div>

        <div className="grid" style={{ gap: 16 }}>
          <div className="card">
            <h3>2 · Name</h3>
            <div className="field"><label>Index name</label><div className="input"><input placeholder="Hood Tech 5" value={name} onChange={(e) => { setName(e.target.value); if (!symbol) setSymbol(""); }} /></div></div>
            <div className="field"><label>Token symbol</label><div className="input"><input placeholder="hTECH5" value={symbol} onChange={(e) => setSymbol(e.target.value)} /></div></div>
          </div>
          <div className="card">
            <h3>3 · Seed deposit</h3>
            <div className="field"><label>Initial value</label><div className="input"><input inputMode="decimal" value={seedUsd} onChange={(e) => setSeedUsd(e.target.value)} /><span className="suffix">USD</span></div></div>
            {picks.length > 0 && seed > 0n && (
              <div className="preview">
                {picks.map((p, i) => (
                  <div className="line" key={p.asset.key} style={{ color: shortfall[i] ? "var(--bad)" : "inherit" }}>
                    <span>{p.asset.symbol} · {p.weightBps / 100}%</span>
                    <span>{amount(seedAmounts[i], p.asset.decimals, 4)}</span>
                  </div>
                ))}
                <div className="line muted"><span>You receive</span><span>{amount(seed, 18, 0)} {symbol.trim().toUpperCase() || "shares"}</span></div>
              </div>
            )}
            <p className="muted small">The factory deploys the vault and makes this first deposit in the same transaction. One INDEX per dollar seeded.</p>
            <button className="btn primary" disabled={!ready && !!wallet.address} onClick={launch}>{busy ?? (wallet.address ? "Approve & launch" : MOCK ? "Connect demo wallet" : "Connect wallet")}</button>
          </div>
        </div>
      </div>
    </main>
  );
}
