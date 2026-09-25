import { parseUnits, type Address } from "viem";
import type { AssetInfo, ConfigInfo, CreateInput, CuratedAsset, Position, Source, TxResult, VaultInfo } from "./types";
import { depositAmounts, redeemAmounts, gaps } from "./math";
import { CHAIN } from "../config";

export const DEMO_USER: Address = "0xD3110000000000000000000000000000000000d0";
const CONFIG_ADDR: Address = "0xC0DF000000000000000000000000000000000001";
const TEAM: Address = "0x7EA0000000000000000000000000000000000001";

const addr = (prefix: number, i: number): Address => `0x${prefix.toString(16).padStart(2, "0")}${"0".repeat(36)}${i.toString(16).padStart(2, "0")}` as Address;

/** Demo catalog with today's prices; the on-chain catalog lives in config.ts. */
const CATALOG: (CuratedAsset & { price: number })[] = [
  { key: "SPY", symbol: "SPY", name: "S&P 500 ETF (Robinhood Stock Token)", price: 662.4, decimals: 18, token: addr(0xa0, 1), valuer: addr(0xb0, 1), unitValue: 0n },
  { key: "NVDA", symbol: "NVDA", name: "NVIDIA (Robinhood Stock Token)", price: 185.4, decimals: 18, token: addr(0xa0, 2), valuer: addr(0xb0, 2), unitValue: 0n },
  { key: "AAPL", symbol: "AAPL", name: "Apple (Robinhood Stock Token)", price: 338.1, decimals: 18, token: addr(0xa0, 3), valuer: addr(0xb0, 3), unitValue: 0n },
  { key: "MSFT", symbol: "MSFT", name: "Microsoft (Robinhood Stock Token)", price: 522.7, decimals: 18, token: addr(0xa0, 4), valuer: addr(0xb0, 4), unitValue: 0n },
  { key: "AMZN", symbol: "AMZN", name: "Amazon (Robinhood Stock Token)", price: 228.9, decimals: 18, token: addr(0xa0, 5), valuer: addr(0xb0, 5), unitValue: 0n },
  { key: "GOOG", symbol: "GOOG", name: "Alphabet (Robinhood Stock Token)", price: 251.3, decimals: 18, token: addr(0xa0, 6), valuer: addr(0xb0, 6), unitValue: 0n },
  { key: "TSLA", symbol: "TSLA", name: "Tesla (Robinhood Stock Token)", price: 431.2, decimals: 18, token: addr(0xa0, 7), valuer: addr(0xb0, 7), unitValue: 0n },
  { key: "WETH", symbol: "WETH", name: "Wrapped Ether", price: 2662, decimals: 18, token: addr(0xa0, 8), valuer: addr(0xb0, 8), unitValue: 0n },
].map((a) => ({ ...a, unitValue: parseUnits(a.price.toString(), 18) }));

const byKey = (k: string) => CATALOG.find((a) => a.key === k)!;

function holding(key: string, weightBps: number, wholeUnits: number): AssetInfo {
  const a = byKey(key);
  const balance = parseUnits(wholeUnits.toString(), a.decimals);
  return {
    token: a.token,
    valuer: a.valuer,
    weightBps,
    symbol: a.symbol,
    name: a.name,
    decimals: a.decimals,
    balance,
    value: (balance * a.unitValue) / 10n ** BigInt(a.decimals),
    unitValue: a.unitValue,
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
    creatorShareBps: 1_000,
    rebalanceInterval: 18_000,
    redeemFeeBps: 0,
    feeRecipient: "0x0000000000000000000000000000000000000000",
  };
  vaults: VaultInfo[] = [
    withNav({
      address: "0x20A0000000000000000000000000000000000001",
      creator: TEAM,
      name: "hood20 Core",
      symbol: "h20CORE",
      totalSupply: parseUnits("1200000", 18),
      lastRebalanceBlock: START_BLOCK - 21_000n,
      // ~$1.2M: SPY 30 / NVDA 20 / AAPL 15 / MSFT 15 / AMZN 10 / GOOG 10, NVDA slightly rich after a good day
      assets: [holding("SPY", 3000, 543), holding("NVDA", 2000, 1_312), holding("AAPL", 1500, 532), holding("MSFT", 1500, 344), holding("AMZN", 1000, 524), holding("GOOG", 1000, 477)],
    }),
  ];
  shares = new Map<string, bigint>([[this.vaults[0].address, parseUnits("25000", 18)]]);
  wallet = new Map<string, bigint>(CATALOG.map((a) => [a.token, parseUnits({ SPY: "30", NVDA: "120", AAPL: "60", MSFT: "40", AMZN: "90", GOOG: "80", TSLA: "50", WETH: "8" }[a.key] ?? "0", 18)]));
  allowances = new Map<string, bigint>();
  nextVault = 2;
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
  async listAssets(): Promise<CuratedAsset[]> {
    return CATALOG.map(({ price: _p, ...a }) => ({ ...a }));
  }
  async walletBalances(assets: CuratedAsset[], _user: Address): Promise<bigint[]> {
    return assets.map((a) => this.w.wallet.get(a.token) ?? 0n);
  }
  async createVault(input: CreateInput, user: Address): Promise<TxResult & { vault: Address }> {
    await sleep(1200);
    const assets: AssetInfo[] = input.picks.map(({ asset, weightBps }, i) => {
      const amt = input.seedAmounts[i];
      const bal = this.w.wallet.get(asset.token) ?? 0n;
      if (bal < amt) throw new Error(`Insufficient ${asset.symbol} balance`);
      this.w.wallet.set(asset.token, bal - amt);
      return { ...asset, weightBps, balance: amt, value: (amt * asset.unitValue) / 10n ** BigInt(asset.decimals) };
    });
    const address = addr(0x20, this.w.nextVault++);
    const v = withNav({ address, creator: user, name: input.name, symbol: input.symbol, totalSupply: 0n, lastRebalanceBlock: 0n, assets });
    v.totalSupply = v.nav; // first deposit: 1 INDEX per USD
    this.w.vaults.push(v);
    this.w.shares.set(address, v.totalSupply);
    return { hash: hash(), vault: address };
  }
}
