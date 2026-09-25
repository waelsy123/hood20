import { parseUnits, type Address } from "viem";
import type { AssetInfo, ConfigInfo, Position, Source, TxResult, VaultInfo } from "./types";
import { depositAmounts, redeemAmounts, gaps, WAD } from "./math";
import { CHAIN } from "../config";

export const DEMO_USER: Address = "0xD3110000000000000000000000000000000000d0";
const CONFIG_ADDR: Address = "0xC0DF000000000000000000000000000000000001";

type Tok = { symbol: string; name: string; decimals: number; price: number; token: Address; valuer: Address };
const tok = (symbol: string, name: string, price: number, i: number): Tok => ({
  symbol,
  name,
  decimals: 18,
  price,
  token: `0x${(0xa0 + i).toString(16).padStart(2, "0")}${"0".repeat(36)}0${i}` as Address,
  valuer: `0x${(0xb0 + i).toString(16).padStart(2, "0")}${"0".repeat(36)}0${i}` as Address,
});
const T = {
  WETH: tok("WETH", "Wrapped Ether", 2662, 1),
  AAPL: tok("AAPL", "Apple (Robinhood Stock Token)", 338.1, 2),
  NVDA: tok("NVDA", "NVIDIA (Robinhood Stock Token)", 185.4, 3),
  MSFT: tok("MSFT", "Microsoft (Robinhood Stock Token)", 522.7, 4),
  GOOG: tok("GOOG", "Alphabet (Robinhood Stock Token)", 251.3, 5),
  AMZN: tok("AMZN", "Amazon (Robinhood Stock Token)", 228.9, 6),
};

function asset(t: Tok, weightBps: number, wholeUnits: number): AssetInfo {
  const balance = parseUnits(wholeUnits.toString(), t.decimals);
  const unitValue = parseUnits(t.price.toString(), 18);
  return {
    token: t.token,
    valuer: t.valuer,
    weightBps,
    symbol: t.symbol,
    name: t.name,
    decimals: t.decimals,
    balance,
    value: (balance * unitValue) / 10n ** BigInt(t.decimals),
    unitValue,
  };
}

function withNav(v: Omit<VaultInfo, "nav" | "deviationBps">): VaultInfo {
  const nav = v.assets.reduce((s, a) => s + a.value, 0n);
  const full = { ...v, nav, deviationBps: 0 };
  full.deviationBps = gaps(full).maxBps;
  return full;
}

const START_BLOCK = 72_400_000n;
const START_MS = Date.now();
export function mockBlock(): bigint {
  return START_BLOCK + BigInt(Math.floor((Date.now() - START_MS) / 1000 / CHAIN.blockTimeSeconds));
}

/** In-memory world for demo mode. Balances move exactly like the contracts would. */
class World {
  config: ConfigInfo = {
    address: CONFIG_ADDR,
    owner: "0x0000000000000000000000000000000000000ADD",
    thresholdBps: 50,
    incentiveBps: 50,
    rebalanceInterval: 18_000,
    redeemFeeBps: 0,
    feeRecipient: "0x0000000000000000000000000000000000000000",
  };
  vaults: VaultInfo[] = [
    withNav({
      address: "0x20A0000000000000000000000000000000000001",
      name: "hood20 Core 50/50",
      symbol: "h20CORE",
      totalSupply: parseUnits("650000", 18),
      lastRebalanceBlock: START_BLOCK - 25_000n,
      assets: [asset(T.WETH, 5000, 130), asset(T.AAPL, 5000, 940)],
    }),
    withNav({
      address: "0x20A0000000000000000000000000000000000002",
      name: "hood20 Mag 5",
      symbol: "h20MAG5",
      totalSupply: parseUnits("500000", 18),
      lastRebalanceBlock: START_BLOCK - 3_000n,
      assets: [
        asset(T.NVDA, 2000, 540),
        asset(T.AAPL, 2000, 296),
        asset(T.MSFT, 2000, 191),
        asset(T.GOOG, 2000, 398),
        asset(T.AMZN, 2000, 437),
      ],
    }),
  ];
  shares = new Map<string, bigint>([[this.vaults[0].address, parseUnits("12500", 18)]]);
  wallet = new Map<string, bigint>(
    Object.values(T).map((t) => [t.token, parseUnits({ WETH: "5", AAPL: "40", NVDA: "30", MSFT: "10", GOOG: "25", AMZN: "25" }[t.symbol] ?? "0", 18)]),
  );
  allowances = new Map<string, bigint>();
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const hash = () => `0x${Array.from({ length: 64 }, () => "0123456789abcdef"[Math.floor(Math.random() * 16)]).join("")}`;

export class MockSource implements Source {
  readonly mock = true;
  private w = new World();

  async blockNumber() {
    return mockBlock();
  }
  async getConfig() {
    return { ...this.w.config };
  }
  async listVaults() {
    return this.w.vaults.map((v) => structuredClone(v));
  }
  async getVault(address: Address) {
    const v = this.w.vaults.find((x) => x.address.toLowerCase() === address.toLowerCase());
    if (!v) throw new Error("Unknown vault");
    return structuredClone(v);
  }
  async getPosition(vault: VaultInfo, _user: Address): Promise<Position> {
    return {
      shares: this.w.shares.get(vault.address) ?? 0n,
      balances: vault.assets.map((a) => this.w.wallet.get(a.token) ?? 0n),
      allowances: vault.assets.map((a) => this.w.allowances.get(`${vault.address}:${a.token}`) ?? 0n),
    };
  }
  async approve(vault: VaultInfo, i: number, amount: bigint): Promise<TxResult> {
    await sleep(600);
    this.w.allowances.set(`${vault.address}:${vault.assets[i].token}`, amount);
    return { hash: hash() };
  }
  async deposit(vault: VaultInfo, maxAmounts: bigint[], minShares: bigint): Promise<TxResult> {
    await sleep(900);
    const v = this.w.vaults.find((x) => x.address === vault.address)!;
    // shares = min_i(maxAmounts[i] * supply / balance_i), then amounts = ceil(shares * balance_i / supply)
    let shares = maxAmounts.reduce((m, a, i) => {
      const s = (a * v.totalSupply) / v.assets[i].balance;
      return s < m ? s : m;
    }, 2n ** 255n);
    if (shares === 0n || shares < minShares) throw new Error("Slippage: fewer shares than requested");
    const amounts = depositAmounts(v, shares);
    amounts.forEach((amt, i) => {
      const a = v.assets[i];
      const bal = this.w.wallet.get(a.token) ?? 0n;
      if (bal < amt) throw new Error(`Insufficient ${a.symbol} balance`);
      if ((this.w.allowances.get(`${v.address}:${a.token}`) ?? 0n) < amt) throw new Error(`${a.symbol} not approved`);
      this.w.wallet.set(a.token, bal - amt);
      this.w.allowances.set(`${v.address}:${a.token}`, 0n);
      a.balance += amt;
      a.value = (a.balance * a.unitValue) / 10n ** BigInt(a.decimals);
    });
    v.totalSupply += shares;
    v.nav = v.assets.reduce((s, a) => s + a.value, 0n);
    v.deviationBps = gaps(v).maxBps;
    this.w.shares.set(v.address, (this.w.shares.get(v.address) ?? 0n) + shares);
    return { hash: hash() };
  }
  async redeem(vault: VaultInfo, shares: bigint): Promise<TxResult> {
    await sleep(900);
    const v = this.w.vaults.find((x) => x.address === vault.address)!;
    const have = this.w.shares.get(v.address) ?? 0n;
    if (shares > have) throw new Error("Insufficient shares");
    const { fee, amounts } = redeemAmounts(v, this.w.config, shares);
    amounts.forEach((amt, i) => {
      const a = v.assets[i];
      a.balance -= amt;
      a.value = (a.balance * a.unitValue) / 10n ** BigInt(a.decimals);
      this.w.wallet.set(a.token, (this.w.wallet.get(a.token) ?? 0n) + amt);
    });
    v.totalSupply -= shares - fee;
    v.nav = v.assets.reduce((s, a) => s + a.value, 0n);
    v.deviationBps = gaps(v).maxBps;
    this.w.shares.set(v.address, have - shares);
    return { hash: hash() };
  }
}

export const DEMO_ONE_USD = WAD;
