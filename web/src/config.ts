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

/**
 * Assets creators may pick from. Each needs a token and a deployed ChainlinkAdapter (valuer). In demo mode the
 * mock world supplies its own catalog with prices, so these placeholders are only read once contracts are live.
 */
export const CURATED_ASSETS: { key: string; symbol: string; name: string; token: Address; valuer: Address; decimals: number }[] = [
  { key: "SPY", symbol: "SPY", name: "S&P 500 ETF (Robinhood Stock Token)", token: ZERO, valuer: ZERO, decimals: 18 },
  { key: "NVDA", symbol: "NVDA", name: "NVIDIA (Robinhood Stock Token)", token: ZERO, valuer: ZERO, decimals: 18 },
  { key: "AAPL", symbol: "AAPL", name: "Apple (Robinhood Stock Token)", token: ZERO, valuer: ZERO, decimals: 18 },
  { key: "MSFT", symbol: "MSFT", name: "Microsoft (Robinhood Stock Token)", token: ZERO, valuer: ZERO, decimals: 18 },
  { key: "AMZN", symbol: "AMZN", name: "Amazon (Robinhood Stock Token)", token: ZERO, valuer: ZERO, decimals: 18 },
  { key: "GOOG", symbol: "GOOG", name: "Alphabet (Robinhood Stock Token)", token: ZERO, valuer: ZERO, decimals: 18 },
  { key: "TSLA", symbol: "TSLA", name: "Tesla (Robinhood Stock Token)", token: ZERO, valuer: ZERO, decimals: 18 },
  { key: "WETH", symbol: "WETH", name: "Wrapped Ether", token: "0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73", valuer: ZERO, decimals: 18 },
];

export const LINKS = {
  repo: "https://github.com/waelsy123/hood20",
  chainDocs: "https://docs.robinhood.com/chain/",
  feeds: "https://reference-data-directory.vercel.app/feeds-robinhood-mainnet.json",
};
