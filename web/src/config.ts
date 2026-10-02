import type { Address } from "viem";
import feedsFile from "../../data/robinhood-chain-feeds.json";

export const ZERO: Address = "0x0000000000000000000000000000000000000000";

/** Robinhood Chain mainnet. */
export const CHAIN = {
  id: 4663,
  name: "Robinhood Chain",
  rpc: "https://rpc.mainnet.chain.robinhood.com", // the official endpoint, used for wallet_addEthereumChain
  // Reads go through PublicNode first (fast, tolerant of bursts) and fall back to the official RPC (429 after ~10
  // rapid calls); every refresh is folded into one Multicall3 call.
  rpcRead: ["https://robinhood-rpc.publicnode.com", "https://rpc.mainnet.chain.robinhood.com"],
  multicall3: "0xcA11bde05977b3631167028862bE2a173976CA11" as Address,
  explorer: "https://robin.etherscan.io", // Etherscan for Robinhood Chain; the contracts' sources are verified there
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  // Robinhood Chain is an Arbitrum-stack rollup: `block.number` inside the EVM is the Ethereum L1 block number
  // (~12 s), not the 0.1 s L2 block. The vault's rebalance interval and lastRebalanceBlock count those L1 blocks.
  blockTimeSeconds: 12,
} as const;

/** Hard caps of IndexConfig.set, mirrored from src/IndexConfig.sol. */
export const CONFIG_CAPS = {
  thresholdBps: 1000,
  incentiveBps: 100,
  creatorShareBps: 5000,
  rebalanceInterval: 1000000,
  redeemFeeBps: 500,
} as const;

/**
 * Deployed contracts. Leave both at ZERO until the contracts are live: the app then runs in demo mode with
 * mocked vaults so the whole flow can be exercised. Set them after `DeployFactory.s.sol` and reload.
 */
export const ADDRESSES: { factory: Address; config: Address } = {
  // Deployed 2026-10-02 (block 78306880 area) by 0xDf62…49E7; IndexConfig ownership handed to 0x3FB9…3D58.
  factory: "0x0a9c469B0f56EDb6a7d67bDB71a76567F6cae2B1",
  config: "0x543A25b213ABa3aCce7747B392273a4751B5D297",
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

/** Global Dollar, the quote currency of the purchase flow (6 decimals; verified on-chain in the feed directory). */
const usdgFeed = FEEDS.find((f) => f.symbol === "USDG" && f.token?.address)!;
export const USDG = { symbol: "USDG", address: usdgFeed.token!.address as Address, decimals: usdgFeed.token!.onchain?.decimals ?? usdgFeed.token!.decimals ?? 6 };
export const isUsdg = (token: string) => token.toLowerCase() === USDG.address.toLowerCase();

/**
 * Uniswap on Robinhood Chain (Uniswap Labs deployments, github.com/Uniswap/contracts deployments/4663.md). The dapp
 * never routes: Uniswap's Trading API picks the pools and returns Universal Router calldata, which the dapp only
 * sends to this router address. The API key stays server-side in web/functions/api/uniswap (secret UNISWAP_API_KEY).
 */
export const UNISWAP = {
  universalRouter: "0x204FAca1764B154221e35c0d20aBb3c525710498" as Address,
  universalRouterVersion: "2.1.2", // the Trading API encodes for this build when asked (x-universal-router-version)
  permit2: "0x000000000022D473030F116dDEE9F6B43aC78BA3" as Address,
  tradingApi: "https://trade-api.gateway.uniswap.org/v1",
  slippagePct: 0.5,
};

export const LINKS = {
  repo: "https://github.com/waelsy123/hood20",
  chainDocs: "https://docs.robinhood.com/chain/",
  feeds: "https://reference-data-directory.vercel.app/feeds-robinhood-mainnet.json",
};
