import { parseUnits, type Address } from "viem";
import type { AssetInfo, BuyQuote, ConfigInfo, CreateInput, CuratedAsset, Position, Source, TxResult, VaultInfo } from "./types";
import { depositAmounts, redeemAmounts, gaps, mulDivCeil } from "./math";
import { CHAIN, CURATED_ASSETS, USDG } from "../config";

export const DEMO_USER: Address = "0xD3110000000000000000000000000000000000d0";
const CONFIG_ADDR: Address = "0xC0DF000000000000000000000000000000000001";
const TEAM: Address = "0x7EA0000000000000000000000000000000000001";

const addr = (prefix: number, i: number): Address => `0x${prefix.toString(16).padStart(2, "0")}${"0".repeat(36)}${i.toString(16).padStart(2, "0")}` as Address;

/** Demo catalog: the real feed-backed assets and today's Chainlink prices, with placeholder valuer addresses. */
const CATALOG: (CuratedAsset & { price: number })[] = CURATED_ASSETS.map((a, i) => ({
  key: a.key,
  symbol: a.symbol,
  name: a.name,
  price: a.price,
  decimals: a.decimals,
  token: a.token,
  valuer: addr(0xb0, i + 1),
  unitValue: parseUnits(a.price.toFixed(8), 18),
}));

const byKey = (k: string) => CATALOG.find((a) => a.key === k)!;

/** Holding worth `navUsd * weightBps / 1e4` at today's price, times `drift` (1 = exactly on target). */
function holding(key: string, weightBps: number, navUsd: number, drift = 1): AssetInfo {
  const a = byKey(key);
  const units = ((navUsd * weightBps) / 10_000 / a.price) * drift;
  const balance = parseUnits(units.toFixed(6), a.decimals);
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
    pendingOwner: "0x0000000000000000000000000000000000000000",
  };
  vaults: VaultInfo[] = [
    withNav({
      address: "0x20A0000000000000000000000000000000000001",
      creator: TEAM,
      name: "hood20 Core",
      symbol: "h20CORE",
      totalSupply: parseUnits("1200000", 18),
      lastRebalanceBlock: START_BLOCK - 21_000n,
      // ~$1.2M: SPY 30 / NVDA 20 / AAPL 15 / MSFT 15 / AMZN 10 / GOOGL 10 at today's feed prices, NVDA a touch rich
      assets: [holding("SPY", 3000, 1_200_000), holding("NVDA", 2000, 1_200_000, 1.011), holding("AAPL", 1500, 1_200_000, 0.997), holding("MSFT", 1500, 1_200_000), holding("AMZN", 1000, 1_200_000, 0.996), holding("GOOGL", 1000, 1_200_000)],
    }),
  ];
  shares = new Map<string, bigint>([[this.vaults[0].address, parseUnits("25000", 18)]]);
  // the demo wallet holds about $25,000 of every asset
  wallet = new Map<string, bigint>(CATALOG.map((a) => [a.token, parseUnits((25_000 / a.price).toFixed(6), a.decimals)]));
  allowances = new Map<string, bigint>();
  usdg = parseUnits("50000", USDG.decimals); // and $50,000 of USDG to buy with
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
  async usdgBalance(_user: Address) {
    return this.w.usdg;
  }
  async acceptConfigOwnership(_user: Address): Promise<TxResult> {
    throw new Error("No ownership transfer is pending in demo mode");
  }
  /** Demo "Uniswap": fills at the Chainlink price plus 30 bps, with the same 0.5% maximum as the real quotes. */
  async quoteBuy(vault: VaultInfo, legs: bigint[], _user: Address): Promise<BuyQuote> {
    await sleep(400);
    const out: BuyQuote = { legs: [], usdgIn: 0n, usdgMax: 0n, raw: [] };
    legs.forEach((amt, i) => {
      if (amt === 0n) return;
      const a = vault.assets[i];
      const usdValue = (amt * a.unitValue) / 10n ** BigInt(a.decimals); // 18 decimals
      const usdgIn = mulDivCeil(usdValue * 10_030n, 1n, 10_000n * 10n ** BigInt(18 - USDG.decimals));
      const usdgMax = mulDivCeil(usdgIn * 10_050n, 1n, 10_000n);
      out.legs.push({ index: i, amountOut: amt, usdgIn, usdgMax, routing: "CLASSIC" });
      out.usdgIn += usdgIn;
      out.usdgMax += usdgMax;
    });
    return out;
  }
  async buy(vault: VaultInfo, legs: bigint[], user: Address, onStep: (label: string) => void): Promise<TxResult & { quote: BuyQuote }> {
    const quote = await this.quoteBuy(vault, legs, user);
    if (quote.legs.length === 0) return { hash: "", quote };
    if (this.w.usdg < quote.usdgIn) throw new Error("Insufficient USDG balance");
    onStep("Swapping on Uniswap");
    await sleep(900);
    this.w.usdg -= quote.usdgIn;
    quote.legs.forEach((l) => {
      const t = vault.assets[l.index].token;
      this.w.wallet.set(t, (this.w.wallet.get(t) ?? 0n) + l.amountOut);
    });
    return { hash: hash(), quote };
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
