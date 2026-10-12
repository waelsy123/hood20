import { createPublicClient, createWalletClient, custom, defineChain, fallback, http, parseAbi, type Address, type WalletClient } from "viem";
import { ADDRESSES, CHAIN, UNISWAP, USDG, isUsdg } from "../config";
import { ChainlinkAdapterAbi, IndexConfigAbi, IndexVaultAbi, IndexVaultFactoryAbi, erc20Abi } from "../abi";
import type { AssetInfo, BuyQuote, ConfigInfo, ConfigInput, CreateInput, CuratedAsset, Position, Source, TxResult, VaultInfo } from "./types";
import { gaps } from "./math";
import { MAX_UINT160, maxInput, mergeSwaps, permit2Abi, quoteExactOutput, swapTransaction, type ApiQuote } from "./uniswap";

export const robinhoodChain = defineChain({
  id: CHAIN.id,
  name: CHAIN.name,
  nativeCurrency: CHAIN.nativeCurrency,
  rpcUrls: { default: { http: [CHAIN.rpc] } },
  blockExplorers: { default: { name: "Etherscan", url: CHAIN.explorer } },
  contracts: { multicall3: { address: CHAIN.multicall3 } },
});

// Concurrent reads are folded into Multicall3 calls (one request per refresh instead of dozens); endpoints fall over
// to the next one on failure.
export const publicClient = createPublicClient({
  chain: robinhoodChain,
  transport: fallback(CHAIN.rpcRead.map((url) => http(url, { retryCount: 2, retryDelay: 300 }))),
  batch: { multicall: { wait: 16 } },
});
const MAX_UINT256 = 2n ** 256n - 1n;

const aggregatorAbi = parseAbi([
  "function latestRoundData() view returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound)",
]);

type Price = { answer: bigint; scale: bigint; updatedAt: number; stale: boolean };

/**
 * The last price a valuer's feed published, read from the feed itself rather than through the valuer.
 * ChainlinkAdapter reverts StalePrice once an answer is past its window, deliberately, so a vault can never settle
 * on a stale price. A closed market is not missing data though: the feed still holds Friday's close, and that is
 * what the interface should show, marked with its age.
 */
async function priceOf(valuer: Address): Promise<Price | null> {
  try {
    const a = { address: valuer, abi: ChainlinkAdapterAbi } as const;
    const [feed, scale, maxStale] = await Promise.all([
      publicClient.readContract({ ...a, functionName: "feed" }),
      publicClient.readContract({ ...a, functionName: "scale" }),
      publicClient.readContract({ ...a, functionName: "maxStale" }),
    ]);
    const round = await publicClient.readContract({ address: feed, abi: aggregatorAbi, functionName: "latestRoundData" });
    const answer = round[1];
    if (answer <= 0n) return null;
    const updatedAt = Number(round[3]);
    return { answer, scale, updatedAt, stale: BigInt(updatedAt) + maxStale < BigInt(Math.floor(Date.now() / 1000)) };
  } catch {
    return null;
  }
}

/** ChainlinkAdapter.valueOf's own arithmetic, so a fresh price here equals what the vault would compute. */
const valueAt = (p: Price | null, amount: bigint) => (p === null ? null : (amount * p.answer * 10n ** 18n) / p.scale);
const multicall3Abi = parseAbi(["function getBlockNumber() view returns (uint256)"]);

type Eip1193 = { request: (a: { method: string; params?: unknown[] }) => Promise<unknown>; on?: Function; removeListener?: Function };
export function injected(): Eip1193 | undefined {
  return (window as unknown as { ethereum?: Eip1193 }).ethereum;
}

function wallet(): WalletClient {
  const eth = injected();
  if (!eth) throw new Error("No wallet found. Install Rabby, MetaMask or Robinhood Wallet.");
  return createWalletClient({ chain: robinhoodChain, transport: custom(eth) });
}

async function send(user: Address, fn: () => Promise<`0x${string}`>): Promise<TxResult> {
  void user;
  const hash = await fn();
  await publicClient.waitForTransactionReceipt({ hash });
  return { hash };
}

/** Reads and writes against the deployed contracts. */
export class ChainSource implements Source {
  readonly mock = false;

  /** The block number contracts see (the L1 block on this rollup), which is what lastRebalanceBlock counts. */
  blockNumber() {
    return publicClient.readContract({ address: CHAIN.multicall3, abi: multicall3Abi, functionName: "getBlockNumber" });
  }

  async getConfig(): Promise<ConfigInfo> {
    const c = { address: ADDRESSES.config, abi: IndexConfigAbi } as const;
    const [owner, thresholdBps, incentiveBps, creatorShareBps, rebalanceInterval, redeemFeeBps, feeRecipient, pendingOwner] = await Promise.all([
      publicClient.readContract({ ...c, functionName: "owner" }),
      publicClient.readContract({ ...c, functionName: "thresholdBps" }),
      publicClient.readContract({ ...c, functionName: "incentiveBps" }),
      publicClient.readContract({ ...c, functionName: "creatorShareBps" }),
      publicClient.readContract({ ...c, functionName: "rebalanceInterval" }),
      publicClient.readContract({ ...c, functionName: "redeemFeeBps" }),
      publicClient.readContract({ ...c, functionName: "feeRecipient" }),
      publicClient.readContract({ ...c, functionName: "pendingOwner" }),
    ]);
    return {
      address: ADDRESSES.config,
      owner,
      thresholdBps: Number(thresholdBps),
      incentiveBps: Number(incentiveBps),
      creatorShareBps: Number(creatorShareBps),
      rebalanceInterval: Number(rebalanceInterval),
      redeemFeeBps: Number(redeemFeeBps),
      feeRecipient,
      pendingOwner,
    };
  }

  acceptConfigOwnership(user: Address) {
    return send(user, () => wallet().writeContract({ account: user, chain: robinhoodChain, address: ADDRESSES.config, abi: IndexConfigAbi, functionName: "acceptOwnership" }));
  }

  setConfig(i: ConfigInput, user: Address) {
    return send(user, () =>
      wallet().writeContract({
        account: user,
        chain: robinhoodChain,
        address: ADDRESSES.config,
        abi: IndexConfigAbi,
        functionName: "set",
        args: [BigInt(i.thresholdBps), BigInt(i.incentiveBps), BigInt(i.creatorShareBps), BigInt(i.rebalanceInterval), BigInt(i.redeemFeeBps), i.feeRecipient],
      }),
    );
  }

  async listVaults(): Promise<VaultInfo[]> {
    const addrs = await publicClient.readContract({ address: ADDRESSES.factory, abi: IndexVaultFactoryAbi, functionName: "all" });
    return Promise.all(addrs.map((a) => this.getVault(a)));
  }

  async getVault(address: Address): Promise<VaultInfo> {
    const v = { address, abi: IndexVaultAbi } as const;
    const [name, symbol, totalSupply, count, lastRebalanceBlock, creator] = await Promise.all([
      publicClient.readContract({ ...v, functionName: "name" }),
      publicClient.readContract({ ...v, functionName: "symbol" }),
      publicClient.readContract({ ...v, functionName: "totalSupply" }),
      publicClient.readContract({ ...v, functionName: "assetCount" }),
      publicClient.readContract({ ...v, functionName: "lastRebalanceBlock" }),
      publicClient.readContract({ ...v, functionName: "creator" }),
    ]);
    const raw = await Promise.all(
      Array.from({ length: Number(count) }, (_, i) => publicClient.readContract({ ...v, functionName: "assets", args: [BigInt(i)] })),
    );
    const assets = await Promise.all(
      raw.map(async ([token, valuer, weightBps]) => {
        const t = { address: token, abi: erc20Abi } as const;
        const [sym, nm, dec, balance] = await Promise.all([
          publicClient.readContract({ ...t, functionName: "symbol" }),
          publicClient.readContract({ ...t, functionName: "name" }),
          publicClient.readContract({ ...t, functionName: "decimals" }),
          publicClient.readContract({ ...t, functionName: "balanceOf", args: [address] }),
        ]);
        const p = await priceOf(valuer);
        return {
          token, valuer, weightBps: Number(weightBps), symbol: sym, name: nm, decimals: dec, balance,
          value: valueAt(p, balance), unitValue: valueAt(p, 10n ** BigInt(dec)),
          priceUpdatedAt: p?.updatedAt ?? null, stale: p === null || p.stale,
        } satisfies AssetInfo;
      }),
    );
    const nav = assets.every((a) => a.value !== null) ? assets.reduce((s, a) => s + a.value!, 0n) : null;
    const vault: VaultInfo = {
      address, creator, name, symbol, totalSupply, nav, deviationBps: null, lastRebalanceBlock, assets,
      stale: assets.some((a) => a.stale),
    };
    // The contract's deviationBps() reverts whenever a feed is past its window, so compute it here with the same
    // arithmetic: at the last published prices it is still the honest drift, it just cannot be acted on yet.
    vault.deviationBps = gaps(vault)?.maxBps ?? null;
    return vault;
  }

  /** The config's curated registry is the catalog: every registered token with its current valuer and price. */
  async listAssets(): Promise<CuratedAsset[]> {
    const tokens = await publicClient.readContract({ address: ADDRESSES.config, abi: IndexConfigAbi, functionName: "registeredAssets" });
    return Promise.all(
      tokens.map(async (token) => {
        const t = { address: token, abi: erc20Abi } as const;
        const [valuer, symbol, name, decimals] = await Promise.all([
          publicClient.readContract({ address: ADDRESSES.config, abi: IndexConfigAbi, functionName: "valuerOf", args: [token] }),
          publicClient.readContract({ ...t, functionName: "symbol" }),
          publicClient.readContract({ ...t, functionName: "name" }),
          publicClient.readContract({ ...t, functionName: "decimals" }),
        ]);
        const p = await priceOf(valuer);
        return {
          key: symbol, symbol, name: name.replace(" • Robinhood Token", ""), token, valuer, decimals,
          unitValue: valueAt(p, 10n ** BigInt(decimals)), stale: p === null || p.stale,
        };
      }),
    );
  }

  walletBalances(assets: CuratedAsset[], user: Address) {
    return Promise.all(assets.map((a) => publicClient.readContract({ address: a.token, abi: erc20Abi, functionName: "balanceOf", args: [user] })));
  }

  async createVault(input: CreateInput, user: Address): Promise<TxResult & { vault: Address }> {
    const wc = wallet();
    for (let i = 0; i < input.picks.length; i++) {
      const a = input.picks[i].asset;
      const allowance = await publicClient.readContract({ address: a.token, abi: erc20Abi, functionName: "allowance", args: [user, ADDRESSES.factory] });
      if (allowance < input.seedAmounts[i]) {
        // unlimited: the factory only pulls inside the caller's own create(), and one approval per asset is enough for life
        const h = await wc.writeContract({ account: user, chain: robinhoodChain, address: a.token, abi: erc20Abi, functionName: "approve", args: [ADDRESSES.factory, MAX_UINT256] });
        await publicClient.waitForTransactionReceipt({ hash: h });
      }
    }
    const assets = input.picks.map((p) => ({ token: p.asset.token, weightBps: BigInt(p.weightBps) }));
    const hash = await wc.writeContract({ account: user, chain: robinhoodChain, address: ADDRESSES.factory, abi: IndexVaultFactoryAbi, functionName: "create", args: [input.name, input.symbol, assets, input.seedAmounts] });
    await publicClient.waitForTransactionReceipt({ hash });
    const all = await publicClient.readContract({ address: ADDRESSES.factory, abi: IndexVaultFactoryAbi, functionName: "all" });
    return { hash, vault: all[all.length - 1] };
  }

  async getPosition(vault: VaultInfo, user: Address): Promise<Position> {
    const shares = await publicClient.readContract({ address: vault.address, abi: IndexVaultAbi, functionName: "balanceOf", args: [user] });
    const balances = await Promise.all(vault.assets.map((a) => publicClient.readContract({ address: a.token, abi: erc20Abi, functionName: "balanceOf", args: [user] })));
    const allowances = await Promise.all(vault.assets.map((a) => publicClient.readContract({ address: a.token, abi: erc20Abi, functionName: "allowance", args: [user, vault.address] })));
    return { shares, balances, allowances };
  }

  /** Unlimited approval: the vault only pulls inside the caller's own deposit(), so one approval per asset lasts. */
  approve(vault: VaultInfo, i: number, _amount: bigint, user: Address) {
    return send(user, () => wallet().writeContract({ account: user, chain: robinhoodChain, address: vault.assets[i].token, abi: erc20Abi, functionName: "approve", args: [vault.address, MAX_UINT256] }));
  }
  deposit(vault: VaultInfo, maxAmounts: bigint[], minShares: bigint, user: Address) {
    return send(user, () => wallet().writeContract({ account: user, chain: robinhoodChain, address: vault.address, abi: IndexVaultAbi, functionName: "deposit", args: [maxAmounts, minShares, user] }));
  }
  redeem(vault: VaultInfo, shares: bigint, user: Address) {
    return send(user, () => wallet().writeContract({ account: user, chain: robinhoodChain, address: vault.address, abi: IndexVaultAbi, functionName: "redeem", args: [shares, user] }));
  }

  // ───────────── buying constituents with USDG: Uniswap routes, the wallet sends one router call ─────────────

  usdgBalance(user: Address) {
    return publicClient.readContract({ address: USDG.address, abi: erc20Abi, functionName: "balanceOf", args: [user] });
  }

  async quoteBuy(vault: VaultInfo, legs: bigint[], user: Address): Promise<BuyQuote> {
    // A USDG constituent is paid from the wallet's USDG directly: nothing to swap. Other legs are quoted one by one so
    // a failure names the asset.
    const raw = await Promise.all(
      legs.map((amt, i) => {
        const a = vault.assets[i];
        if (amt === 0n || isUsdg(a.token)) return Promise.resolve(null);
        // Seed the input-sized fallback from the oracle price, for pairs with no exact-output route.
        const estimateIn = a.unitValue === null ? undefined : (amt * a.unitValue) / 10n ** BigInt(a.decimals + 18 - USDG.decimals);
        return quoteExactOutput(user, a.token, amt, estimateIn).catch((e) => {
          throw new Error(`${a.symbol}: ${(e as Error).message}`);
        });
      }),
    );
    const out: BuyQuote = { legs: [], usdgIn: 0n, usdgMax: 0n, raw };
    raw.forEach((q, i) => {
      if (!q) return;
      const usdgIn = BigInt(q.quote.input.amount);
      const usdgMax = maxInput(q);
      // an input-sized leg buys at least what was asked for, often a little more; show what will actually arrive
      out.legs.push({ index: i, amountOut: BigInt(q.quote.output.amount), usdgIn, usdgMax, routing: q.routing });
      out.usdgIn += usdgIn;
      out.usdgMax += usdgMax;
    });
    return out;
  }

  async buy(vault: VaultInfo, legs: bigint[], user: Address, onStep: (label: string) => void): Promise<TxResult & { quote: BuyQuote }> {
    const wc = wallet();
    const tx = async (label: string, fn: () => Promise<`0x${string}`>) => {
      onStep(label);
      const h = await fn();
      await publicClient.waitForTransactionReceipt({ hash: h });
      return h;
    };
    onStep("Quoting on Uniswap");
    let quote = await this.quoteBuy(vault, legs, user);
    if (quote.legs.length === 0) return { hash: "", quote };

    // One-time approvals a wallet sets once: USDG -> Permit2, then Permit2 -> Universal Router.
    const erc20Allowance = await publicClient.readContract({ address: USDG.address, abi: erc20Abi, functionName: "allowance", args: [user, UNISWAP.permit2] });
    if (erc20Allowance < quote.usdgMax) {
      await tx("Approving USDG for Permit2", () => wc.writeContract({ account: user, chain: robinhoodChain, address: USDG.address, abi: erc20Abi, functionName: "approve", args: [UNISWAP.permit2, 2n ** 256n - 1n] }));
    }
    const [p2Amount, p2Expiration] = await publicClient.readContract({ address: UNISWAP.permit2, abi: permit2Abi, functionName: "allowance", args: [user, USDG.address, UNISWAP.universalRouter] });
    const now = Math.floor(Date.now() / 1000);
    if (p2Amount < quote.usdgMax || p2Expiration <= now + 600) {
      await tx("Allowing Uniswap's router to spend USDG", () =>
        wc.writeContract({ account: user, chain: robinhoodChain, address: UNISWAP.permit2, abi: permit2Abi, functionName: "approve", args: [USDG.address, UNISWAP.universalRouter, MAX_UINT160, now + 30 * 24 * 3600] }),
      );
      onStep("Quoting on Uniswap");
      quote = await this.quoteBuy(vault, legs, user); // the API now sees the allowance and drops the permit signature
    }

    onStep("Building the swap");
    const swaps = await Promise.all((quote.raw as (ApiQuote | null)[]).filter((q): q is ApiQuote => q !== null).map(swapTransaction));
    const merged = mergeSwaps(swaps);
    const hash = await tx("Swapping on Uniswap", () => wc.sendTransaction({ account: user, chain: robinhoodChain, to: merged.to, data: merged.data, value: merged.value }));
    return { hash, quote };
  }
}
