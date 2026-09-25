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

export type VaultInfo = {
  address: Address;
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
}
