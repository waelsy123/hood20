import type { Address } from "viem";

export const ZERO: Address = "0x0000000000000000000000000000000000000000";

/** Robinhood Chain mainnet. */
export const CHAIN = {
  id: 4663,
  name: "Robinhood Chain",
  rpc: "https://rpc.mainnet.chain.robinhood.com",
  explorer: "https://explorer.mainnet.chain.robinhood.com",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  blockTimeSeconds: 0.1,
} as const;

/**
 * Deployed contracts. Leave both at ZERO until the contracts are live: the app then runs in demo mode with
 * mocked vaults so the whole flow can be exercised. Set them after `DeployFactory.s.sol` and reload.
 */
export const ADDRESSES: { factory: Address; config: Address } = {
  factory: ZERO,
  config: ZERO,
};

export const MOCK = ADDRESSES.factory === ZERO;

export const LINKS = {
  repo: "https://github.com/waelsy123/hood20",
  chainDocs: "https://docs.robinhood.com/chain/",
  feeds: "https://reference-data-directory.vercel.app/feeds-robinhood-mainnet.json",
};
