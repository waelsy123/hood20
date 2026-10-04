import { formatUnits } from "viem";

/** An unavailable price prints as a dash: the equity feeds stop publishing outside market hours. */
export function usd(value: bigint | null, digits = 2): string {
  if (value === null) return "—";
  const n = Number(formatUnits(value, 18));
  return n.toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: digits, minimumFractionDigits: digits });
}

export function usdCompact(value: bigint | null): string {
  if (value === null) return "—";
  const n = Number(formatUnits(value, 18));
  if (n >= 1e6) return `$${(n / 1e6).toFixed(2)}M`;
  if (n >= 1e3) return `$${(n / 1e3).toFixed(1)}k`;
  return `$${n.toFixed(2)}`;
}

export function amount(value: bigint, decimals: number, digits = 4): string {
  const n = Number(formatUnits(value, decimals));
  return n.toLocaleString("en-US", { maximumFractionDigits: digits });
}

export function pct(bps: number | null, digits = 2): string {
  return bps === null ? "—" : `${(bps / 100).toFixed(digits)}%`;
}

export function short(addr: string): string {
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`;
}

export function blocksToTime(blocks: number, blockTime: number): string {
  const s = Math.max(0, Math.round(blocks * blockTime));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.round(s / 60)} min`;
  return `${(s / 3600).toFixed(1)} h`;
}
