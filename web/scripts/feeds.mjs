// Builds ../../data/robinhood-chain-feeds.json: every Chainlink feed on Robinhood Chain (from Chainlink's
// reference-data directory) merged with Robinhood's stock-token registry, each checked live on-chain.
// Run from web/: `node scripts/feeds.mjs` (uses web's viem).
import { writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createPublicClient, http, parseAbi } from "viem";

const RPC = "https://rpc.mainnet.chain.robinhood.com";
const CHAIN_ID = 4663;
const EXPLORER = "https://explorer.mainnet.chain.robinhood.com";
const RDD_URL = "https://reference-data-directory.vercel.app/feeds-robinhood-mainnet.json";
const RHJ_URL = "https://api.robinhood.com/rhj/assets";
const KNOWN_TOKENS = {
  // non-registry ERC-20s with a USD feed; verified on-chain below
  ETH: { address: "0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73", note: "WETH (UniswapV2Router02.WETH())" },
  USDG: { address: "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168", note: "Global Dollar (Paxos), 6 decimals" },
};

const feedAbi = parseAbi([
  "function decimals() view returns (uint8)",
  "function description() view returns (string)",
  "function version() view returns (uint256)",
  "function aggregator() view returns (address)",
  "function latestRoundData() view returns (uint80,int256,uint256,uint256,uint80)",
]);
const erc20Abi = parseAbi(["function symbol() view returns (string)", "function name() view returns (string)", "function decimals() view returns (uint8)"]);

// The public RPC rejects JSON-RPC batches, so calls go one by one with a small concurrency cap.
const client = createPublicClient({ transport: http(RPC, { retryCount: 3, retryDelay: 400 }) });
let active = 0;
const queue = [];
const limit = (fn) =>
  new Promise((res, rej) => {
    const run = () => {
      active++;
      fn().then(res, rej).finally(() => {
        active--;
        queue.shift()?.();
      });
    };
    active < 6 ? run() : queue.push(run);
  });
const read = (address, abi, functionName, args = []) =>
  limit(() => client.readContract({ address, abi, functionName, args })).catch((e) => ({ error: String(e.shortMessage ?? e.message).slice(0, 80) }));

function parseName(name) {
  // "Robinhood AAPL / USD", "Robinhood SGOV-USD", "ETH / USD", "SYRUPUSDC / USDC Exchange Rate"
  const robinhood = name.startsWith("Robinhood ");
  let rest = robinhood ? name.slice("Robinhood ".length) : name;
  const exchangeRate = /Exchange Rate$/i.test(rest);
  rest = rest.replace(/ Exchange Rate$/i, "");
  const m = rest.match(/^(.+?)\s*[\/-]\s*(\w+)$/);
  return { base: (m ? m[1] : rest).trim(), quote: (m ? m[2] : "USD").trim(), robinhood, exchangeRate };
}

const now = Math.floor(Date.now() / 1000);
const [rdd, rhj] = await Promise.all([
  fetch(RDD_URL).then((r) => r.json()),
  fetch(RHJ_URL, { headers: { "user-agent": "Mozilla/5.0 hood20-feeds" } }).then((r) => r.json()),
]);
const registry = rhj.assets.map((a) => {
  const d = a.deployments.find((x) => x.chainId === CHAIN_ID) ?? a.deployments[0];
  return {
    symbol: a.tokenSymbol,
    name: a.tokenName,
    address: d?.contractAddress ?? null,
    chainId: d?.chainId ?? null,
    decimals: a.tokenDecimals,
    isin: a.isin,
    status: a.status,
    uiMultiplier: a.currentMultiplier,
    tradable: a.tradingCapabilities,
    logo: a.logoUrl,
  };
});
const bySymbol = new Map(registry.map((t) => [t.symbol, t]));

const feeds = await Promise.all(
  rdd.map(async (f) => {
    const { base, quote, robinhood, exchangeRate } = parseName(f.name);
    const proxy = f.proxyAddress;
    const [decimals, description, version, aggregator, round] = await Promise.all([
      read(proxy, feedAbi, "decimals"),
      read(proxy, feedAbi, "description"),
      read(proxy, feedAbi, "version"),
      read(proxy, feedAbi, "aggregator"),
      read(proxy, feedAbi, "latestRoundData"),
    ]);
    const ok = Array.isArray(round);
    const answer = ok ? round[1] : null;
    const updatedAt = ok ? Number(round[3]) : null;
    const docs = f.docs ?? {};
    const registryToken = robinhood ? bySymbol.get(base) ?? null : null;
    const known = !robinhood && KNOWN_TOKENS[base] ? KNOWN_TOKENS[base] : null;
    return {
      symbol: base,
      pair: `${base}/${quote}`,
      name: f.name,
      kind: exchangeRate ? "exchange-rate" : docs.assetClass === "Equity" || robinhood ? "equity" : "crypto",
      proxy,
      aggregator: f.contractAddress,
      secondaryProxy: f.secondaryProxyAddress ?? null,
      decimals: f.decimals,
      heartbeatSeconds: f.heartbeat,
      deviationThresholdPct: f.threshold,
      riskCategory: f.feedCategory || null,
      contractVersion: f.contractVersion,
      path: f.path,
      marketHours: docs.marketHours ?? null,
      assetClass: docs.assetClass ?? null,
      productType: docs.productTypeCode ?? null,
      explorer: `${EXPLORER}/address/${proxy}`,
      onchain: ok
        ? {
            decimals: typeof decimals === "number" ? decimals : null,
            description: typeof description === "string" ? description : null,
            version: typeof version === "bigint" ? Number(version) : null,
            aggregator: typeof aggregator === "string" ? aggregator : null,
            aggregatorMatchesDirectory: typeof aggregator === "string" && aggregator.toLowerCase() === String(f.contractAddress).toLowerCase(),
            answer: answer.toString(),
            price: Number(answer) / 10 ** f.decimals,
            updatedAt,
            updatedAtIso: new Date(updatedAt * 1000).toISOString(),
            ageSeconds: now - updatedAt,
            freshWithinHeartbeat: now - updatedAt <= f.heartbeat,
          }
        : { error: round?.error ?? "call failed" },
      token: registryToken
        ? { source: "robinhood-registry", ...registryToken }
        : known
          ? { source: "known", symbol: base === "ETH" ? "WETH" : base, address: known.address, note: known.note }
          : null,
    };
  }),
);

// verify matched tokens on-chain
await Promise.all(
  feeds
    .filter((f) => f.token?.address)
    .map(async (f) => {
      const [symbol, name, decimals] = await Promise.all([
        read(f.token.address, erc20Abi, "symbol"),
        read(f.token.address, erc20Abi, "name"),
        read(f.token.address, erc20Abi, "decimals"),
      ]);
      f.token.onchain = { symbol, name, decimals, symbolMatches: typeof symbol === "string" && symbol.toUpperCase() === String(f.token.symbol).toUpperCase() };
    }),
);

feeds.sort((a, b) => (a.kind === b.kind ? a.symbol.localeCompare(b.symbol) : a.kind.localeCompare(b.kind)));
const withFeed = new Set(feeds.filter((f) => f.token?.source === "robinhood-registry").map((f) => f.token.symbol));
const out = {
  generatedAt: new Date().toISOString(),
  chainId: CHAIN_ID,
  rpc: RPC,
  explorer: EXPLORER,
  sources: { chainlinkDirectory: RDD_URL, robinhoodRegistry: RHJ_URL },
  notes: [
    "proxy is the address to read (AggregatorV3 latestRoundData); aggregator is the current implementation behind it and can change.",
    "All feeds are 8 decimals with a 24h heartbeat and 0.5% deviation trigger. Equity feeds (marketHours us_equities_24/5) publish nothing from Friday's last tick until Sunday 8pm ET and over US holidays, so a staleness limit of ~25h fails closed over weekends; do not raise it past the weekend gap.",
    "Robinhood equity feeds are 'tokenized price' feeds (total return); the stock tokens' uiMultiplier is display-only and the raw on-chain unit is what the feed prices (confirm with Robinhood before relying on it).",
    "riskCategory is Chainlink's feed tier (low/medium/high risk; 'custom' = custom/tokenized product feeds; 'new' = recently launched).",
    "secondaryProxy, where present, is the SVR (Smart Value Recapture) variant of the feed; use proxy unless you integrate SVR.",
    "token is null where no verified ERC-20 for the base asset is known on Robinbood Chain; exchange-rate feeds quote a token, not USD.",
  ],
  counts: {
    feeds: feeds.length,
    equity: feeds.filter((f) => f.kind === "equity").length,
    crypto: feeds.filter((f) => f.kind === "crypto").length,
    exchangeRate: feeds.filter((f) => f.kind === "exchange-rate").length,
    feedsResponding: feeds.filter((f) => !f.onchain.error).length,
    freshWithinHeartbeat: feeds.filter((f) => f.onchain.freshWithinHeartbeat).length,
    feedsWithVerifiedToken: feeds.filter((f) => f.token?.onchain?.symbolMatches).length,
    registryTokens: registry.length,
    registryTokensWithFeed: withFeed.size,
  },
  feeds,
  stockTokens: registry.map((t) => ({ ...t, feed: withFeed.has(t.symbol) ? feeds.find((f) => f.token?.symbol === t.symbol)?.proxy : null })),
};
const here = dirname(fileURLToPath(import.meta.url));
const target = resolve(here, "../../data/robinhood-chain-feeds.json");
writeFileSync(target, JSON.stringify(out, (_k, v) => (typeof v === "bigint" ? v.toString() : v), 2) + "\n");
console.log(JSON.stringify(out.counts));
console.log("wrote", target);
