import type { Address } from "viem";

export type AssetInfo = {
  token: Address;
  valuer: Address;
  weightBps: number;
  symbol: string;
  name: string;
  decimals: number;
  balance: bigint; // vault holding, raw units
  value: bigint; // USD, 18 decimals
  unitValue: bigint; // USD value of one whole token, 18 decimals
};

export type CuratedAsset = {
  key: string;
  symbol: string;
  name: string;
  token: Address;
  valuer: Address;
  decimals: number;
  unitValue: bigint; // USD value of one whole token, 18 decimals
};

export type CreateInput = {
  name: string;
  symbol: string;
  picks: { asset: CuratedAsset; weightBps: number }[];
  seedAmounts: bigint[]; // raw units, one per pick
};

export type VaultInfo = {
  address: Address;
  creator: Address;
  name: string;
  symbol: string;
  totalSupply: bigint;
  nav: bigint; // USD, 18 decimals
  deviationBps: number;
  lastRebalanceBlock: bigint;
  assets: AssetInfo[];
};

export type ConfigInfo = {
  address: Address;
  owner: Address;
  thresholdBps: number;
  incentiveBps: number;
  creatorShareBps: number;
  rebalanceInterval: number;
  redeemFeeBps: number;
  feeRecipient: Address;
  pendingOwner: Address; // Ownable2Step: set by transferOwnership, cleared by acceptOwnership
};

/** The owner-settable parameters of IndexConfig.set, in the contract's order. */
export type ConfigInput = {
  thresholdBps: number;
  incentiveBps: number;
  creatorShareBps: number;
  rebalanceInterval: number;
  redeemFeeBps: number;
  feeRecipient: Address;
};

export type Position = {
  shares: bigint;
  balances: bigint[]; // user's wallet balance of each asset
  allowances: bigint[]; // allowance granted to the vault
};

export type TxResult = { hash: string };

/** One constituent bought with USDG through Uniswap: exact output, USDG in (expected and the max after slippage). */
export type LegQuote = { index: number; amountOut: bigint; usdgIn: bigint; usdgMax: bigint; routing: string };
export type BuyQuote = { legs: LegQuote[]; usdgIn: bigint; usdgMax: bigint; raw: unknown[] };

export interface Source {
  readonly mock: boolean;
  blockNumber(): Promise<bigint>;
  getConfig(): Promise<ConfigInfo>;
  listVaults(): Promise<VaultInfo[]>;
  getVault(address: Address): Promise<VaultInfo>;
  getPosition(vault: VaultInfo, user: Address): Promise<Position>;
  approve(vault: VaultInfo, assetIndex: number, amount: bigint, user: Address): Promise<TxResult>;
  deposit(vault: VaultInfo, maxAmounts: bigint[], minShares: bigint, user: Address): Promise<TxResult>;
  redeem(vault: VaultInfo, shares: bigint, user: Address): Promise<TxResult>;
  listAssets(): Promise<CuratedAsset[]>;
  walletBalances(assets: CuratedAsset[], user: Address): Promise<bigint[]>;
  createVault(input: CreateInput, user: Address): Promise<TxResult & { vault: Address }>;
  usdgBalance(user: Address): Promise<bigint>;
  /** Completes a two-step config ownership transfer; only the pending owner can call it. */
  acceptConfigOwnership(user: Address): Promise<TxResult>;
  /** IndexConfig.set, owner only. */
  setConfig(input: ConfigInput, user: Address): Promise<TxResult>;
  /** Quotes buying `legs[i]` of asset i with USDG (0 = nothing to buy) through Uniswap's Trading API. */
  quoteBuy(vault: VaultInfo, legs: bigint[], user: Address): Promise<BuyQuote>;
  /** Re-quotes, sets the one-time Permit2 approvals if missing, and buys every leg in ONE Universal Router call. */
  buy(vault: VaultInfo, legs: bigint[], user: Address, onStep: (label: string) => void): Promise<TxResult & { quote: BuyQuote }>;
}
