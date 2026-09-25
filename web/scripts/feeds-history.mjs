// Samples 7 days of round history for every feed in ../../data/robinhood-chain-feeds.json and writes
// ../../data/robinhood-chain-feeds-history.json (update cadence, gaps, weekend behaviour, price range).
import { readFileSync, writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createPublicClient, http, parseAbi } from "viem";

const here = dirname(fileURLToPath(import.meta.url));
const dir = JSON.parse(readFileSync(resolve(here, "../../data/robinhood-chain-feeds.json"), "utf8"));
const client = createPublicClient({ transport: http(dir.rpc, { retryCount: 3, retryDelay: 400 }) });
const abi = parseAbi([
  "function latestRoundData() view returns (uint80,int256,uint256,uint256,uint80)",
  "function getRoundData(uint80) view returns (uint80,int256,uint256,uint256,uint80)",
]);
let active = 0;
const queue = [];
const limit = (fn) => new Promise((res, rej) => { const run = () => { active++; fn().then(res, rej).finally(() => { active--; queue.shift()?.(); }); }; active < 8 ? run() : queue.push(run); });

const now = Math.floor(Date.now() / 1000);
const WINDOW = 7 * 86400;
const MAX_ROUNDS = 400;

async function history(feed) {
  const rounds = [];
  try {
    const latest = await limit(() => client.readContract({ address: feed.proxy, abi, functionName: "latestRoundData" }));
    let id = latest[0];
    rounds.push({ ts: Number(latest[3]), price: Number(latest[1]) / 10 ** feed.decimals });
    for (let k = 1; k < MAX_ROUNDS; k++) {
      let r;
      try {
        r = await limit(() => client.readContract({ address: feed.proxy, abi, functionName: "getRoundData", args: [id - BigInt(k)] }));
      } catch {
        break; // phase boundary or missing round
      }
      const ts = Number(r[3]);
      if (ts === 0) break;
      rounds.push({ ts, price: Number(r[1]) / 10 ** feed.decimals });
      if (ts < now - WINDOW) break;
    }
  } catch (e) {
    return { symbol: feed.symbol, error: String(e.shortMessage ?? e.message).slice(0, 80) };
  }
  rounds.sort((a, b) => a.ts - b.ts);
  const inWindow = rounds.filter((r) => r.ts >= now - WINDOW);
  const gaps = [];
  for (let i = 1; i < rounds.length; i++) gaps.push({ from: rounds[i - 1].ts, to: rounds[i].ts, h: (rounds[i].ts - rounds[i - 1].ts) / 3600 });
  const gapsInWindow = gaps.filter((g) => g.to >= now - WINDOW);
  const maxGap = gapsInWindow.reduce((m, g) => (g.h > m.h ? g : m), { h: 0, from: 0, to: 0 });
  const day = (ts) => new Date(ts * 1000).getUTCDay();
  const weekendRounds = inWindow.filter((r) => day(r.ts) === 6 || (day(r.ts) === 0 && new Date(r.ts * 1000).getUTCHours() < 24)).length; // Sat + Sun UTC
  const prices = inWindow.map((r) => r.price);
  return {
    symbol: feed.symbol,
    kind: feed.kind,
    rounds7d: inWindow.length,
    sampledRounds: rounds.length,
    truncated: rounds.length >= MAX_ROUNDS,
    firstInWindowIso: inWindow.length ? new Date(inWindow[0].ts * 1000).toISOString() : null,
    lastIso: new Date(rounds[rounds.length - 1].ts * 1000).toISOString(),
    avgGapMinutes: gapsInWindow.length ? Math.round((gapsInWindow.reduce((s, g) => s + g.h, 0) / gapsInWindow.length) * 60) : null,
    medianGapMinutes: gapsInWindow.length ? Math.round([...gapsInWindow].sort((a, b) => a.h - b.h)[Math.floor(gapsInWindow.length / 2)].h * 60) : null,
    maxGapHours: Math.round(maxGap.h * 10) / 10,
    maxGapFromIso: maxGap.from ? new Date(maxGap.from * 1000).toISOString() : null,
    maxGapToIso: maxGap.to ? new Date(maxGap.to * 1000).toISOString() : null,
    weekendRounds,
    price7dMin: prices.length ? Math.min(...prices) : null,
    price7dMax: prices.length ? Math.max(...prices) : null,
    price7dFirst: prices[0] ?? null,
    priceLast: rounds[rounds.length - 1].price,
    change7dPct: prices.length > 1 ? Math.round(((prices[prices.length - 1] / prices[0]) - 1) * 10000) / 100 : null,
  };
}

const t0 = Date.now();
const results = [];
for (const f of dir.feeds) results.push(history(f)); // limiter bounds concurrency
const out = { generatedAt: new Date().toISOString(), windowDays: 7, maxRoundsSampled: MAX_ROUNDS, feeds: await Promise.all(results) };
writeFileSync(resolve(here, "../../data/robinhood-chain-feeds-history.json"), JSON.stringify(out, null, 2) + "\n");
console.log(`done in ${Math.round((Date.now() - t0) / 1000)}s;`, out.feeds.filter((f) => !f.error).length, "feeds;", out.feeds.reduce((s, f) => s + (f.sampledRounds ?? 0), 0), "rounds sampled");
