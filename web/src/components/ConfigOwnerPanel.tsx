import { useState } from "react";
import { CHAIN, CONFIG_CAPS } from "../config";
import { useApp } from "../lib/context";
import { pct, short } from "../lib/format";
import type { ConfigInput } from "../lib/types";

/// Owner-only: the shared parameters every vault reads live, each within the contract's hard cap. Collapsed by
/// default, because it is rarely touched and the page is about vaults.
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
      <div className="input">
        <input inputMode="numeric" value={f[k]} onChange={(e) => setForm({ ...f, [k]: Math.max(0, Math.min(cap, Number(e.target.value) || 0)) })} />
        <span className="suffix">{hint}</span>
      </div>
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
    <details className="card" style={{ marginBottom: 16 }}>
      <summary>
        <h3>Shared config <span className="muted" style={{ fontWeight: 400 }}>· you are the owner</span></h3>
        <span className="muted small">
          threshold {pct(config.thresholdBps)} · incentive {pct(config.incentiveBps)} · every{" "}
          {Math.round((config.rebalanceInterval * CHAIN.blockTimeSeconds) / 60).toLocaleString()} min · fee{" "}
          {config.redeemFeeBps === 0 ? "none" : pct(config.redeemFeeBps)}
        </span>
      </summary>

      <div className="fields">
        {num("thresholdBps", CONFIG_CAPS.thresholdBps, "Rebalance threshold", "bps of NAV")}
        {num("incentiveBps", CONFIG_CAPS.incentiveBps, "Rebalancer incentive", "bps of misplaced")}
        {num("creatorShareBps", CONFIG_CAPS.creatorShareBps, "Creator share", "bps of the take")}
        {num("rebalanceInterval", CONFIG_CAPS.rebalanceInterval, "Rebalance interval", `≈ ${minutes} min`)}
        {num("redeemFeeBps", CONFIG_CAPS.redeemFeeBps, "Redeem fee", "bps")}
      </div>
      <div className="field">
        <label>Fee recipient <span className="muted">· required once the redeem fee is above zero</span></label>
        <div className="input">
          <input className="mono" spellCheck={false} value={f.feeRecipient} onChange={(e) => setForm({ ...f, feeRecipient: e.target.value as ConfigInput["feeRecipient"] })} />
        </div>
      </div>

      <p className="muted small">
        Every vault reads these live, and a change applies to all of them at once. Intervals count the block number
        contracts see, which on Robinhood Chain is the Ethereum L1 block of about 12 seconds, so 150 is roughly half an
        hour. Config{" "}
        <a className="mono" href={`${CHAIN.explorer}/address/${config.address}`} target="_blank" rel="noreferrer">{short(config.address)}</a>.
      </p>
      <div className="row" style={{ gap: 10 }}>
        <button className="btn primary" disabled={busy || !form} onClick={save}>{busy ? "Saving…" : "Save config"}</button>
        {form && <button className="btn" onClick={() => setForm(null)}>Reset</button>}
        {done && <span className="muted small">saved · {short(done)}</span>}
      </div>
    </details>
  );
}
