import type { Address } from "viem";
import feedsFile from "../../data/robinhood-chain-feeds.json";

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

/** Verified Chainlink feed and token addresses on Robinhood Chain (data/robinhood-chain-feeds.json, `node scripts/feeds.mjs`). */
type FeedEntry = { symbol: string; kind: string; proxy: string; token: { symbol?: string; address?: string | null; decimals?: number } | null };
const FEEDS = (feedsFile as { feeds: FeedEntry[] }).feeds;
const feedFor = (symbol: string) => FEEDS.find((f) => f.symbol === symbol && f.kind !== "exchange-rate");

/**
 * Assets creators may pick from. Token and feed addresses come from the verified feed directory; `valuer` is the
 * ChainlinkAdapter deployed for that pair and stays ZERO until adapters are live (the app then still runs in
 * demo mode because the factory address is ZERO).
 */
export const CURATED_ASSETS: { key: string; symbol: string; name: string; token: Address; feed: Address; valuer: Address; decimals: number }[] = (
  [
    ["SPY", "S&P 500 ETF (Robinhood Stock Token)"],
    ["NVDA", "NVIDIA (Robinhood Stock Token)"],
    ["AAPL", "Apple (Robinhood Stock Token)"],
    ["MSFT", "Microsoft (Robinhood Stock Token)"],
    ["AMZN", "Amazon (Robinhood Stock Token)"],
    ["GOOGL", "Alphabet (Robinhood Stock Token)"],
    ["TSLA", "Tesla (Robinhood Stock Token)"],
    ["ETH", "Wrapped Ether"],
  ] as const
).map(([symbol, name]) => {
  const f = feedFor(symbol);
  return {
    key: symbol === "ETH" ? "WETH" : symbol,
    symbol: symbol === "ETH" ? "WETH" : symbol,
    name,
    token: ((f?.token?.address as Address | undefined) ?? ZERO) as Address,
    feed: ((f?.proxy as Address | undefined) ?? ZERO) as Address,
    valuer: ZERO,
    decimals: f?.token?.decimals ?? 18,
  };
});

export const LINKS = {
  repo: "https://github.com/waelsy123/hood20",
  chainDocs: "https://docs.robinhood.com/chain/",
  feeds: "https://reference-data-directory.vercel.app/feeds-robinhood-mainnet.json",
};
