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

/** NAV per share in USD (18 decimals); 0 when the vault is empty. */
export function navPerShare(v: VaultInfo): bigint {
  return v.totalSupply === 0n ? 0n : (v.nav * WAD) / v.totalSupply;
}

/** Shares worth `usd` (18 decimals) at the current NAV per share. */
export function sharesForUsd(v: VaultInfo, usd: bigint): bigint {
  const pps = navPerShare(v);
  return pps === 0n ? 0n : (usd * WAD) / pps;
}

export type Gap = { target: bigint; gap: bigint; over: boolean; gapBps: number };

/** Per-asset target and gap, mirroring IndexVault._gaps. */
export function gaps(v: VaultInfo): { perAsset: Gap[]; misplaced: bigint; maxBps: number } {
  let misplaced = 0n;
  let maxBps = 0;
  const perAsset = v.assets.map((a) => {
    const target = (v.nav * BigInt(a.weightBps)) / BPS;
    const over = a.value > target;
    const gap = over ? a.value - target : target - a.value;
    if (over) misplaced += gap;
    const gapBps = v.nav === 0n ? 0 : Number((gap * BPS) / v.nav);
    if (gapBps > maxBps) maxBps = gapBps;
    return { target, gap, over, gapBps };
  });
  return { perAsset, misplaced, maxBps };
}

/** Largest incentive a rebalancer may keep right now, in USD (18 decimals). */
export function incentiveAvailable(v: VaultInfo, cfg: ConfigInfo): bigint {
  return (gaps(v).misplaced * BigInt(cfg.incentiveBps)) / BPS;
}
