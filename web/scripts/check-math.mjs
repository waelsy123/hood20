// Property check for src/lib/math.ts, the dapp's mirror of IndexVault's rounding. The contract side is covered by
// Forge; this covers the parts only the dapp has: deposit sizing and the "max" the wallet can fund.
// Run: node --experimental-strip-types scripts/check-math.mjs   (part of `npm run build`)
import {
  depositAmounts,
  maxSharesFromAssets,
  maxSharesWithUsdg,
  sharesForUsd,
  usdForShares,
  usdgNeededFor,
} from "../src/lib/math.ts";

const USDG = { address: "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168", decimals: 6 };
const RUNS = Number(process.argv[2] ?? 500);
const rnd = (n) => BigInt(Math.floor(Math.random() * n) + 1);
const fails = [];
const check = (ok, what, t) => !ok && fails.push(`${what} (vault ${t})`);

for (let t = 0; t < RUNS; t++) {
  const n = 2 + Math.floor(Math.random() * 6);
  const assets = Array.from({ length: n }, (_, i) => {
    const decimals = [6, 8, 18][Math.floor(Math.random() * 3)];
    const unitValue = rnd(5_000) * 10n ** 18n; // $1 .. $5,000 a whole token
    const balance = (rnd(10_000) * 10n ** BigInt(decimals)) / 10n;
    return {
      token: i === 0 && t % 3 === 0 ? USDG.address : `0x${(i + 10).toString(16).padStart(40, "0")}`,
      valuer: "0x", weightBps: Math.floor(10_000 / n), symbol: `T${i}`, name: "",
      decimals, balance, unitValue, value: (balance * unitValue) / 10n ** BigInt(decimals),
    };
  });
  const nav = assets.reduce((s, a) => s + a.value, 0n);
  const v = { address: "0x", creator: "0x", name: "", symbol: "", totalSupply: nav, nav, deviationBps: 0, lastRebalanceBlock: 0n, assets };
  const balances = assets.map((a) => (rnd(20_000) * 10n ** BigInt(a.decimals)) / 100n);
  // the wallet's USDG balance IS balances[usdgIdx] when USDG is a constituent: one token, read once on chain
  const usdgIdx = assets.findIndex((a) => a.token === USDG.address);
  const usdgBal = usdgIdx >= 0 ? balances[usdgIdx] : rnd(100_000) * 10n ** 6n;

  // the deposit the vault pulls never exceeds what was offered, at any size
  const some = maxSharesFromAssets(v, balances) / 3n;
  check(depositAmounts(v, some).every((a, i) => a <= balances[i]), "a sub-max deposit is affordable", t);

  // "max" in assets mode is affordable and is really the maximum
  const m = maxSharesFromAssets(v, balances);
  check(depositAmounts(v, m).every((a, i) => a <= balances[i]), "assets max is affordable", t);
  check(m === 0n || depositAmounts(v, m + 1n).some((a, i) => a > balances[i]), "assets max is maximal", t);

  // the USD the box shows for it never asks for more shares than that max
  check(sharesForUsd(v, usdForShares(v, m)) <= m, "usd round trip does not overshoot", t);

  // "max" in USDG mode is affordable, is the maximum, and is never worse than paying in kind
  const u = maxSharesWithUsdg(v, balances, usdgBal, USDG, 150n);
  check(usdgNeededFor(v, u, balances, USDG, 150n) <= usdgBal, "usdg max is affordable", t);
  check(usdgNeededFor(v, u + 1n, balances, USDG, 150n) > usdgBal, "usdg max is maximal", t);
  check(u >= m, "usdg max funds at least what the wallet's assets do", t);
}

if (fails.length) {
  console.error(`math check: ${fails.length} failure(s) over ${RUNS} random vaults`);
  for (const f of fails.slice(0, 10)) console.error("  " + f);
  process.exit(1);
}
console.log(`math check: ${RUNS} random vaults, all properties hold`);
