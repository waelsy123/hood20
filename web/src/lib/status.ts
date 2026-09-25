import type { ConfigInfo, VaultInfo } from "./types";

export type RebalanceState = { kind: "open" | "balanced" | "cooldown" | "unknown"; label: string; blocksLeft: number };

/** Whether a rebalance would be accepted right now, mirroring the checks in IndexVault._minNavAfter. */
export function rebalanceState(v: VaultInfo, cfg: ConfigInfo | null, block: bigint | null): RebalanceState {
  if (!cfg || block === null) return { kind: "unknown", label: "loading", blocksLeft: 0 };
  if (v.lastRebalanceBlock !== 0n) {
    const opensAt = v.lastRebalanceBlock + BigInt(cfg.rebalanceInterval);
    if (block < opensAt) return { kind: "cooldown", label: "interval running", blocksLeft: Number(opensAt - block) };
  }
  if (v.deviationBps < cfg.thresholdBps) return { kind: "balanced", label: "balanced", blocksLeft: 0 };
  return { kind: "open", label: "rebalance open", blocksLeft: 0 };
}
