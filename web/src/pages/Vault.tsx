import { useCallback, useEffect, useMemo, useState } from "react";
import { formatUnits, parseUnits, type Address } from "viem";
import { CHAIN, MOCK } from "../config";
import { useApp } from "../lib/context";
import { amount, blocksToTime, pct, short, usd } from "../lib/format";
import { depositAmounts, gaps, incentiveSplit, navPerShare, redeemAmounts, sharesForUsd, WAD } from "../lib/math";
import { Link } from "../lib/router";
import { rebalanceState } from "../lib/status";
import type { Position, VaultInfo } from "../lib/types";
import { StatePill } from "./Vaults";

function parseDecimal(s: string, decimals: number): bigint | null {
  if (!s.trim()) return null;
  try {
    const v = parseUnits(s.trim(), decimals);
    return v > 0n ? v : null;
  } catch {
    return null;
  }
}

function txLink(hash: string) {
  return MOCK ? <span className="mono muted">simulated {short(hash)}</span> : <a className="mono" href={`${CHAIN.explorer}/tx/${hash}`} target="_blank" rel="noreferrer">{short(hash)}</a>;
}

export function Vault({ address }: { address: Address }) {
  const { source, wallet, config, block, setError } = useApp();
  const [v, setV] = useState<VaultInfo | null>(null);
  const [pos, setPos] = useState<Position | null>(null);
  const [tab, setTab] = useState<"deposit" | "redeem">("deposit");
  const [usdIn, setUsdIn] = useState("");
  const [sharesIn, setSharesIn] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [done, setDone] = useState<{ text: string; hash: string } | null>(null);

  const refresh = useCallback(async () => {
    try {
      const vault = await source.getVault(address);
      setV(vault);
      if (wallet.address) setPos(await source.getPosition(vault, wallet.address));
      else setPos(null);
    } catch (e) {
      setError((e as Error).message);
    }
  }, [source, address, wallet.address, setError]);

  useEffect(() => {
    void refresh();
    const id = setInterval(refresh, 15_000);
    return () => clearInterval(id);
  }, [refresh]);

  const g = useMemo(() => (v ? gaps(v) : null), [v]);
  const state = v ? rebalanceState(v, config, block) : null;

  // deposit preview
  const usdWanted = parseDecimal(usdIn, 18);
  const sharesWanted = v && usdWanted ? sharesForUsd(v, usdWanted) : 0n;
  const depositNeeds = v && sharesWanted > 0n ? depositAmounts(v, sharesWanted) : null;
  const shortAssets = v && depositNeeds && pos ? depositNeeds.map((n, i) => n > pos.balances[i]) : [];
  const canDeposit = !!(v && depositNeeds && pos && sharesWanted > 0n && !shortAssets.some(Boolean) && !busy);

  // redeem preview
  const sharesOut = parseDecimal(sharesIn, 18);
  const redeemPreview = v && config && sharesOut ? redeemAmounts(v, config, sharesOut) : null;
  const canRedeem = !!(v && pos && sharesOut && sharesOut <= pos.shares && !busy);

  const run = async (label: string, fn: () => Promise<{ hash: string }>) => {
    setBusy(label);
    setDone(null);
    try {
      const r = await fn();
      setDone({ text: `${label} confirmed`, hash: r.hash });
      await refresh();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  };

  const doDeposit = async () => {
    if (!v || !depositNeeds || !pos || !wallet.address) return;
    const user = wallet.address;
    setBusy("Approving");
    setDone(null);
    try {
      for (let i = 0; i < v.assets.length; i++) {
        if (pos.allowances[i] < depositNeeds[i]) {
          setBusy(`Approving ${v.assets[i].symbol}`);
          await source.approve(v, i, depositNeeds[i], user);
        }
      }
      setBusy("Depositing");
      const minShares = (sharesWanted * 995n) / 1000n; // 0.5% slack for rounding and mix changes in flight
      const r = await source.deposit(v, depositNeeds, minShares, user);
      setDone({ text: "Deposit confirmed", hash: r.hash });
      setUsdIn("");
      await refresh();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  };

  if (!v) return <main className="container section"><p className="muted">Loading vault…</p></main>;

  const pps = navPerShare(v);
  const myValue = pos ? (pos.shares * pps) / WAD : 0n;
  const split = config ? incentiveSplit(v, config) : { budget: 0n, rebalancer: 0n, creator: 0n };

  return (
    <main className="container" style={{ minHeight: "60vh" }}>
      <div className="page-head">
        <div>
          <Link to="/app" className="muted small">← all vaults</Link>
          <h2 style={{ marginTop: 6 }}>{v.name} <span className="muted mono small">{v.symbol}</span></h2>
          <span className="muted mono small">{v.address} · created by {short(v.creator)}</span>
        </div>
        <StatePill v={v} />
      </div>

      <div className="grid cols-4">
        <div className="card stat"><span className="label">NAV</span><span className="value sm">{usd(v.nav)}</span></div>
        <div className="card stat"><span className="label">Per share</span><span className="value sm">{usd(pps, 4)}</span></div>
        <div className="card stat"><span className="label">Supply</span><span className="value sm">{amount(v.totalSupply, 18, 2)}</span></div>
        <div className="card stat"><span className="label">Max deviation</span><span className="value sm">{pct(v.deviationBps)}</span></div>
      </div>

      <div className="grid cols-2" style={{ marginTop: 16, alignItems: "start" }}>
        <div className="grid" style={{ gap: 16 }}>
          <div className="card">
            <h3>Holdings</h3>
            <div className="table-wrap">
              <table className="table">
                <thead><tr><th>Asset</th><th className="num">Weight</th><th className="num">Balance</th><th className="num">Value</th><th className="num">Target</th><th className="num">Gap</th></tr></thead>
                <tbody>
                  {v.assets.map((a, i) => {
                    const gp = g!.perAsset[i];
                    return (
                      <tr key={a.token}>
                        <td><span className="sym">{a.symbol}</span> <span className="muted small">{usd(a.unitValue)}</span></td>
                        <td className="num">{pct(a.weightBps, 1)}</td>
                        <td className="num">{amount(a.balance, a.decimals, 4)}</td>
                        <td className="num">{usd(a.value)}</td>
                        <td className="num">{usd(gp.target)}</td>
                        <td className="num" style={{ color: gp.gap === 0n ? "inherit" : gp.over ? "var(--warn)" : "var(--good)" }}>{gp.gap === 0n ? "—" : `${gp.over ? "+" : "−"}${usd(gp.gap)}`}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>

          <div className="card">
            <div className="row between"><h3 style={{ margin: 0 }}>Rebalance</h3>{state && <span className="muted small">{state.label}</span>}</div>
            <div style={{ margin: "12px 0 6px" }} className="row between small">
              <span className="muted">Deviation {pct(v.deviationBps)} of NAV · threshold {config ? pct(config.thresholdBps) : "—"}</span>
            </div>
            <div className={`bar ${state?.kind === "balanced" ? "good" : ""}`}><div style={{ width: `${Math.min(100, config ? (v.deviationBps / Math.max(1, config.thresholdBps)) * 100 : 0)}%` }} /></div>
            <dl className="kv" style={{ marginTop: 14 }}>
              <dt>Rebalancer keeps up to</dt><dd>{usd(split.rebalancer)} <span className="muted">(holders pay {config ? pct(config.incentiveBps) : "—"} of {usd(g!.misplaced)} misplaced)</span></dd>
              <dt>Creator earns</dt><dd>{usd(split.creator)} <span className="muted">({config ? pct(config.creatorShareBps, 0) : "—"} of the rebalancer's take, as {v.symbol})</span></dd>
              <dt>Interval</dt>
              <dd>
                {state?.kind === "cooldown"
                  ? `${state.blocksLeft.toLocaleString()} blocks left (~${blocksToTime(state.blocksLeft, CHAIN.blockTimeSeconds)})`
                  : config ? `${config.rebalanceInterval.toLocaleString()} blocks between rebalances` : "—"}
              </dd>
              <dt>Last rebalance</dt><dd>{v.lastRebalanceBlock === 0n ? "never" : `block ${v.lastRebalanceBlock.toLocaleString()}`}</dd>
              <dt>Moves</dt>
              <dd>
                {g!.perAsset.map((gp, i) => (gp.gap === 0n ? null : <span key={i} style={{ marginRight: 10 }}>{gp.over ? "pull" : "push"} {v.assets[i].symbol} {usd(gp.gap)}</span>))}
              </dd>
            </dl>
            <p className="muted small" style={{ marginBottom: 0 }}>Rebalancing is a contract call, see the <Link to="/docs">rebalancer guide</Link>. Any contract may do it once the vault is open.</p>
          </div>
        </div>

        <div className="grid" style={{ gap: 16 }}>
          <div className="card">
            <h3>Your position</h3>
            {!wallet.address ? (
              <p className="muted">Connect a wallet to deposit or redeem.</p>
            ) : (
              <dl className="kv">
                <dt>Shares</dt><dd>{amount(pos?.shares ?? 0n, 18, 4)} {v.symbol}</dd>
                <dt>Value</dt><dd>{usd(myValue)}</dd>
                {pos && config && pos.shares > 0n && (
                  <>
                    <dt>Redeemable</dt>
                    <dd>{redeemAmounts(v, config, pos.shares).amounts.map((x, i) => `${amount(x, v.assets[i].decimals, 4)} ${v.assets[i].symbol}`).join(" · ")}</dd>
                  </>
                )}
              </dl>
            )}
          </div>

          <div className="card">
            <div className="tabs">
              <button className={tab === "deposit" ? "active" : ""} onClick={() => setTab("deposit")}>Deposit</button>
              <button className={tab === "redeem" ? "active" : ""} onClick={() => setTab("redeem")}>Redeem</button>
            </div>
            {tab === "deposit" ? (
              <>
                <div className="field">
                  <label>Amount to deposit</label>
                  <div className="input"><input inputMode="decimal" placeholder="1000" value={usdIn} onChange={(e) => setUsdIn(e.target.value)} /><span className="suffix">USD</span></div>
                </div>
                {depositNeeds && pos && (
                  <div className="preview">
                    <div className="line"><span>You receive</span><span>{amount(sharesWanted, 18, 4)} {v.symbol}</span></div>
                    {v.assets.map((a, i) => (
                      <div className="line" key={a.token} style={{ color: shortAssets[i] ? "var(--bad)" : "inherit" }}>
                        <span>{a.symbol}</span>
                        <span>{amount(depositNeeds[i], a.decimals, 6)} <span className="muted">/ {amount(pos.balances[i], a.decimals, 4)} held</span></span>
                      </div>
                    ))}
                  </div>
                )}
                <p className="muted small">Deposits pull every asset in the vault's current ratio. Approvals are requested per asset, then one deposit call.</p>
                {!wallet.address ? (
                  <button className="btn primary" onClick={() => wallet.connect().catch((e) => setError((e as Error).message))}>Connect wallet</button>
                ) : (
                  <button className="btn primary" disabled={!canDeposit} onClick={doDeposit}>{busy ?? "Approve & deposit"}</button>
                )}
              </>
            ) : (
              <>
                <div className="field">
                  <label>Shares to redeem</label>
                  <div className="input">
                    <input inputMode="decimal" placeholder="0.0" value={sharesIn} onChange={(e) => setSharesIn(e.target.value)} />
                    <button className="btn sm" style={{ marginRight: -6 }} onClick={() => pos && setSharesIn(formatUnits(pos.shares, 18))}>max</button>
                  </div>
                </div>
                {redeemPreview && (
                  <div className="preview">
                    {redeemPreview.fee > 0n && <div className="line"><span>Redeem fee</span><span>{amount(redeemPreview.fee, 18, 4)} {v.symbol}</span></div>}
                    {v.assets.map((a, i) => (
                      <div className="line" key={a.token}><span>{a.symbol}</span><span>{amount(redeemPreview.amounts[i], a.decimals, 6)}</span></div>
                    ))}
                  </div>
                )}
                <p className="muted small">You receive your pro-rata slice of every asset{config && config.redeemFeeBps > 0 ? `, minus a ${pct(config.redeemFeeBps)} fee kept as ${v.symbol}` : ""}.</p>
                {!wallet.address ? (
                  <button className="btn primary" onClick={() => wallet.connect().catch((e) => setError((e as Error).message))}>Connect wallet</button>
                ) : (
                  <button className="btn primary" disabled={!canRedeem} onClick={() => sharesOut && wallet.address && run("Redeem", () => source.redeem(v, sharesOut, wallet.address!)).then(() => setSharesIn(""))}>{busy ?? "Redeem"}</button>
                )}
              </>
            )}
            {done && <div className="status ok">{done.text} · {txLink(done.hash)}</div>}
          </div>

          {config && (
            <div className="card">
              <h3>Shared config</h3>
              <dl className="kv">
                <dt>Threshold</dt><dd>{pct(config.thresholdBps)} of NAV</dd>
                <dt>Incentive</dt><dd>{pct(config.incentiveBps)} of misplaced value</dd>
                <dt>Interval</dt><dd>{config.rebalanceInterval.toLocaleString()} blocks (~{blocksToTime(config.rebalanceInterval, CHAIN.blockTimeSeconds)})</dd>
                <dt>Redeem fee</dt><dd>{config.redeemFeeBps === 0 ? "none" : pct(config.redeemFeeBps)}</dd>
                <dt>Config</dt><dd className="small">{short(config.address)}</dd>
              </dl>
            </div>
          )}
        </div>
      </div>
    </main>
  );
}
