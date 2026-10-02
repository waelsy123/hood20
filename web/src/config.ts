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
type FeedEntry = {
  symbol: string;
  kind: string;
  proxy: string;
  onchain: { price?: number };
  token: { symbol?: string; name?: string; address?: string | null; decimals?: number; onchain?: { symbolMatches?: boolean; decimals?: number } } | null;
};
const FEEDS = (feedsFile as { feeds: FeedEntry[] }).feeds;

export type CatalogEntry = { key: string; symbol: string; name: string; token: Address; feed: Address; valuer: Address; decimals: number; price: number; kind: string };

/**
 * Assets creators may pick from: every USD feed on the chain whose token was verified on-chain (35 Robinhood stock
 * tokens plus WETH and USDG). `valuer` is the ChainlinkAdapter for that pair and stays ZERO until adapters are live.
 */
export const CURATED_ASSETS: CatalogEntry[] = FEEDS.filter((f) => f.kind !== "exchange-rate" && f.token?.address && f.token.onchain?.symbolMatches)
  .map((f) => {
    const sym = f.token!.symbol ?? f.symbol;
    return {
      key: sym,
      symbol: sym,
      name: (f.token!.name ?? f.symbol).replace(" • Robinhood Token", ""),
      token: f.token!.address as Address,
      feed: f.proxy as Address,
      valuer: ZERO,
      decimals: f.token!.onchain?.decimals ?? f.token!.decimals ?? 18,
      price: f.onchain.price ?? 0,
      kind: f.kind,
    };
  })
  .sort((a, b) => (a.kind === b.kind ? a.symbol.localeCompare(b.symbol) : a.kind === "equity" ? -1 : 1));

export const LINKS = {
  repo: "https://github.com/waelsy123/hood20",
  chainDocs: "https://docs.robinhood.com/chain/",
  feeds: "https://reference-data-directory.vercel.app/feeds-robinhood-mainnet.json",
};
