import type { VaultInfo, ConfigInfo } from "./types";

export const BPS = 10_000n;
export const WAD = 10n ** 18n;

export function mulDivCeil(a: bigint, b: bigint, d: bigint): bigint {
  return (a * b + d - 1n) / d;
}

/** Amounts of every asset the vault pulls for `shares`, mirroring IndexVault.deposit (ceil). */
export function depositAmounts(v: VaultInfo, shares: bigint): bigint[] {
  if (v.totalSupply === 0n) return v.assets.map(() => 0n);
  return v.assets.map((a) => mulDivCeil(shares, a.balance, v.totalSupply));
}

/** Amounts of every asset paid out for `shares`, mirroring IndexVault.redeem (fee first, then floor). */
export function redeemAmounts(v: VaultInfo, cfg: ConfigInfo, shares: bigint): { fee: bigint; amounts: bigint[] } {
  const fee = (shares * BigInt(cfg.redeemFeeBps)) / BPS;
  const net = shares - fee;
  if (v.totalSupply === 0n) return { fee, amounts: v.assets.map(() => 0n) };
  return { fee, amounts: v.assets.map((a) => (net * a.balance) / v.totalSupply) };
}

/** NAV per share in USD (18 decimals); 0 when the vault is empty, null when a price is unavailable. */
export function navPerShare(v: VaultInfo): bigint | null {
  if (v.nav === null) return null;
  return v.totalSupply === 0n ? 0n : (v.nav * WAD) / v.totalSupply;
}

/** Every constituent's price is available, so the USD figures below can be computed. */
export function isPriced(v: VaultInfo): boolean {
  return v.nav !== null;
}

/** Shares worth `usd` (18 decimals) at the current NAV per share; null while a price is unavailable. */
export function sharesForUsd(v: VaultInfo, usd: bigint): bigint | null {
  const pps = navPerShare(v);
  if (pps === null) return null;
  return pps === 0n ? 0n : (usd * WAD) / pps;
}

/** USD (18 dec) that `shares` are worth at the current NAV per share; null while a price is unavailable. */
export function usdForShares(v: VaultInfo, shares: bigint): bigint | null {
  const pps = navPerShare(v);
  return pps === null ? null : (shares * pps) / WAD;
}

/** Most shares the wallet can buy with the assets it already holds: the scarcest one binds, as IndexVault does. */
export function maxSharesFromAssets(v: VaultInfo, balances: bigint[]): bigint {
  if (v.totalSupply === 0n) return 0n;
  return v.assets.reduce((m, a, i) => {
    const s = a.balance === 0n ? 0n : ((balances[i] ?? 0n) * v.totalSupply) / a.balance;
    return s < m ? s : m;
  }, 2n ** 255n);
}

/**
 * USDG (raw) the purchase flow spends for `shares`: every asset the wallet is short of is bought at the oracle
 * price with `slipBps` of headroom, and a USDG constituent is pulled from the same balance. An estimate for sizing
 * only; Uniswap's quote is what the deposit actually pays.
 */
export function usdgNeededFor(
  v: VaultInfo,
  shares: bigint,
  balances: bigint[],
  usdg: { address: string; decimals: number },
  slipBps: bigint,
): bigint {
  const needs = depositAmounts(v, shares);
  const toUsdg = 10n ** BigInt(18 - usdg.decimals);
  let buyUsd = 0n;
  let direct = 0n;
  v.assets.forEach((a, i) => {
    if (a.token.toLowerCase() === usdg.address.toLowerCase()) {
      direct += needs[i];
      return;
    }
    const short = needs[i] > (balances[i] ?? 0n) ? needs[i] - (balances[i] ?? 0n) : 0n;
    if (short > 0n) buyUsd += (short * a.unitValue!) / 10n ** BigInt(a.decimals);
  });
  return (buyUsd * (BPS + slipBps)) / BPS / toUsdg + direct;
}

/** Most shares the wallet can buy with its USDG, spending the assets it already holds first. */
export function maxSharesWithUsdg(
  v: VaultInfo,
  balances: bigint[],
  usdgBalance: bigint,
  usdg: { address: string; decimals: number },
  slipBps: bigint,
): bigint {
  const pps = navPerShare(v);
  if (v.totalSupply === 0n || pps === null || pps === 0n) return 0n;
  // upper bound: everything the wallet is worth, valued at NAV per share
  const held = v.assets.reduce((s, a, i) => s + ((balances[i] ?? 0n) * a.unitValue!) / 10n ** BigInt(a.decimals), 0n);
  let lo = 0n;
  let hi = ((usdgBalance * 10n ** BigInt(18 - usdg.decimals) + held) * WAD) / pps + 1n;
  while (lo < hi) {
    const mid = (lo + hi + 1n) / 2n;
    if (usdgNeededFor(v, mid, balances, usdg, slipBps) <= usdgBalance) lo = mid;
    else hi = mid - 1n;
  }
  return lo;
}

export type Gap = { target: bigint; gap: bigint; over: boolean; gapBps: number };

/** Per-asset target and gap, mirroring IndexVault._gaps; null while any price is unavailable. */
export function gaps(v: VaultInfo): { perAsset: Gap[]; misplaced: bigint; maxBps: number } | null {
  const nav = v.nav;
  if (nav === null) return null;
  let misplaced = 0n;
  let maxBps = 0;
  const perAsset = v.assets.map((a) => {
    const value = a.value ?? 0n;
    const target = (nav * BigInt(a.weightBps)) / BPS;
    const over = value > target;
    const gap = over ? value - target : target - value;
    if (over) misplaced += gap;
    const gapBps = nav === 0n ? 0 : Number((gap * BPS) / nav);
    if (gapBps > maxBps) maxBps = gapBps;
    return { target, gap, over, gapBps };
  });
  return { perAsset, misplaced, maxBps };
}

/** What holders pay at most on the next rebalance, and how it splits between rebalancer and creator (USD, 18 dec). */
export function incentiveSplit(v: VaultInfo, cfg: ConfigInfo): { budget: bigint; rebalancer: bigint; creator: bigint } | null {
  const g = gaps(v);
  if (g === null) return null;
  const misplaced = g.misplaced;
  const budget = (misplaced * BigInt(cfg.incentiveBps)) / BPS;
  const rebalancer = (misplaced * BigInt(cfg.incentiveBps)) / (BPS + BigInt(cfg.creatorShareBps));
  return { budget, rebalancer, creator: (rebalancer * BigInt(cfg.creatorShareBps)) / BPS };
}

/** Seed amounts (raw units) for a new vault: `usd` split by weight, priced by each asset's unit value, rounded up. */
export function seedAmountsFor(picks: { unitValue: bigint | null; decimals: number; weightBps: number }[], usd: bigint): bigint[] {
  return picks.map((p) => {
    const value = (usd * BigInt(p.weightBps)) / BPS;
    const unit = 10n ** BigInt(p.decimals);
    return !p.unitValue ? 0n : mulDivCeil(value, unit, p.unitValue);
  });
}
