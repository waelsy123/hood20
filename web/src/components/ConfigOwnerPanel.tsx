import { useState } from "react";
import { CHAIN, CONFIG_CAPS } from "../config";
import { useApp } from "../lib/context";
import type { ConfigInput } from "../lib/types";

/** Owner-only: the shared parameters every vault reads live, each within the contract's hard cap. */
export function ConfigOwnerPanel() {
  const { source, wallet, config, setError } = useApp();
  const [form, setForm] = useState<ConfigInput | null>(null);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<string | null>(null);
  if (!config || !wallet.address || config.owner.toLowerCase() !== wallet.address.toLowerCase()) return null;
  const f: ConfigInput = form ?? {
    thresholdBps: config.thresholdBps,
    incentiveBps: config.incentiveBps,
    creatorShareBps: config.creatorShareBps,
    rebalanceInterval: config.rebalanceInterval,
    redeemFeeBps: config.redeemFeeBps,
    feeRecipient: config.feeRecipient,
  };
  const num = (k: keyof Omit<ConfigInput, "feeRecipient">, cap: number, label: string, hint: string) => (
    <div className="field" key={k}>
      <label>{label} <span className="muted">· cap {cap.toLocaleString()}</span></label>
      <div className="input"><input inputMode="numeric" value={f[k]} onChange={(e) => setForm({ ...f, [k]: Math.max(0, Math.min(cap, Number(e.target.value) || 0)) })} /><span className="suffix">{hint}</span></div>
    </div>
  );
  const save = async () => {
    setBusy(true);
    setDone(null);
    try {
      const r = await source.setConfig(f, wallet.address!);
      setDone(r.hash);
      setForm(null);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const minutes = Math.round((f.rebalanceInterval * CHAIN.blockTimeSeconds) / 60);
  return (
    <div className="card" style={{ marginBottom: 16 }}>
      <div className="row between"><h3 style={{ margin: 0 }}>Shared config · you are the owner</h3><span className="muted small mono">{config.address}</span></div>
      <div className="grid cols-3" style={{ marginTop: 10 }}>
        {num("thresholdBps", CONFIG_CAPS.thresholdBps, "Rebalance threshold", "bps of NAV")}
        {num("incentiveBps", CONFIG_CAPS.incentiveBps, "Rebalancer incentive", "bps of misplaced")}
        {num("creatorShareBps", CONFIG_CAPS.creatorShareBps, "Creator share", "bps of the take")}
        {num("rebalanceInterval", CONFIG_CAPS.rebalanceInterval, "Rebalance interval", `L1 blocks ≈ ${minutes} min`)}
        {num("redeemFeeBps", CONFIG_CAPS.redeemFeeBps, "Redeem fee", "bps")}
        <div className="field"><label>Fee recipient <span className="muted">· needed when the fee is above 0</span></label><div className="input"><input value={f.feeRecipient} onChange={(e) => setForm({ ...f, feeRecipient: e.target.value as ConfigInput["feeRecipient"] })} /></div></div>
      </div>
      <p className="muted small">
        Every vault reads these live. Intervals count the block number contracts see, which on Robinhood Chain is the Ethereum L1 block (~12 s):
        150 ≈ 30 minutes. Changes take effect immediately for all vaults.
      </p>
      <div className="row" style={{ gap: 10 }}>
        <button className="btn primary" disabled={busy || !form} onClick={save}>{busy ? "Saving…" : "Save config"}</button>
        {form && <button className="btn" onClick={() => setForm(null)}>Reset</button>}
        {done && <span className="muted small">saved · {done.slice(0, 10)}…</span>}
      </div>
    </div>
  );
}

