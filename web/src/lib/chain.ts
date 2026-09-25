import { createPublicClient, createWalletClient, custom, defineChain, http, type Address, type WalletClient } from "viem";
import { ADDRESSES, CHAIN } from "../config";
import { ChainlinkAdapterAbi, IndexConfigAbi, IndexVaultAbi, IndexVaultFactoryAbi, erc20Abi } from "../abi";
import type { ConfigInfo, Position, Source, TxResult, VaultInfo } from "./types";

export const robinhoodChain = defineChain({
  id: CHAIN.id,
  name: CHAIN.name,
  nativeCurrency: CHAIN.nativeCurrency,
  rpcUrls: { default: { http: [CHAIN.rpc] } },
  blockExplorers: { default: { name: "Explorer", url: CHAIN.explorer } },
});

export const publicClient = createPublicClient({ chain: robinhoodChain, transport: http(CHAIN.rpc) });

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

  blockNumber() {
    return publicClient.getBlockNumber();
  }

  async getConfig(): Promise<ConfigInfo> {
    const c = { address: ADDRESSES.config, abi: IndexConfigAbi } as const;
    const [owner, thresholdBps, incentiveBps, rebalanceInterval, redeemFeeBps, feeRecipient] = await Promise.all([
      publicClient.readContract({ ...c, functionName: "owner" }),
      publicClient.readContract({ ...c, functionName: "thresholdBps" }),
      publicClient.readContract({ ...c, functionName: "incentiveBps" }),
      publicClient.readContract({ ...c, functionName: "rebalanceInterval" }),
      publicClient.readContract({ ...c, functionName: "redeemFeeBps" }),
      publicClient.readContract({ ...c, functionName: "feeRecipient" }),
    ]);
    return {
      address: ADDRESSES.config,
      owner,
      thresholdBps: Number(thresholdBps),
      incentiveBps: Number(incentiveBps),
      rebalanceInterval: Number(rebalanceInterval),
      redeemFeeBps: Number(redeemFeeBps),
      feeRecipient,
    };
  }

  async listVaults(): Promise<VaultInfo[]> {
    const addrs = await publicClient.readContract({ address: ADDRESSES.factory, abi: IndexVaultFactoryAbi, functionName: "all" });
    return Promise.all(addrs.map((a) => this.getVault(a)));
  }

  async getVault(address: Address): Promise<VaultInfo> {
    const v = { address, abi: IndexVaultAbi } as const;
    const [name, symbol, totalSupply, count, snap, deviationBps, lastRebalanceBlock] = await Promise.all([
      publicClient.readContract({ ...v, functionName: "name" }),
      publicClient.readContract({ ...v, functionName: "symbol" }),
      publicClient.readContract({ ...v, functionName: "totalSupply" }),
      publicClient.readContract({ ...v, functionName: "assetCount" }),
      publicClient.readContract({ ...v, functionName: "snapshot" }),
      publicClient.readContract({ ...v, functionName: "deviationBps" }),
      publicClient.readContract({ ...v, functionName: "lastRebalanceBlock" }),
    ]);
    const [vals, nav] = snap;
    const raw = await Promise.all(
      Array.from({ length: Number(count) }, (_, i) => publicClient.readContract({ ...v, functionName: "assets", args: [BigInt(i)] })),
    );
    const assets = await Promise.all(
      raw.map(async ([token, valuer, weightBps], i) => {
        const t = { address: token, abi: erc20Abi } as const;
        const [sym, nm, dec, balance] = await Promise.all([
          publicClient.readContract({ ...t, functionName: "symbol" }),
          publicClient.readContract({ ...t, functionName: "name" }),
          publicClient.readContract({ ...t, functionName: "decimals" }),
          publicClient.readContract({ ...t, functionName: "balanceOf", args: [address] }),
        ]);
        const unitValue = await publicClient.readContract({ address: valuer, abi: ChainlinkAdapterAbi, functionName: "valueOf", args: [10n ** BigInt(dec)] });
        return { token, valuer, weightBps: Number(weightBps), symbol: sym, name: nm, decimals: dec, balance, value: vals[i], unitValue };
      }),
    );
    return { address, name, symbol, totalSupply, nav, deviationBps: Number(deviationBps), lastRebalanceBlock, assets };
  }

  async getPosition(vault: VaultInfo, user: Address): Promise<Position> {
    const shares = await publicClient.readContract({ address: vault.address, abi: IndexVaultAbi, functionName: "balanceOf", args: [user] });
    const balances = await Promise.all(vault.assets.map((a) => publicClient.readContract({ address: a.token, abi: erc20Abi, functionName: "balanceOf", args: [user] })));
    const allowances = await Promise.all(vault.assets.map((a) => publicClient.readContract({ address: a.token, abi: erc20Abi, functionName: "allowance", args: [user, vault.address] })));
    return { shares, balances, allowances };
  }

  approve(vault: VaultInfo, i: number, amount: bigint, user: Address) {
    return send(user, () => wallet().writeContract({ account: user, chain: robinhoodChain, address: vault.assets[i].token, abi: erc20Abi, functionName: "approve", args: [vault.address, amount] }));
  }
  deposit(vault: VaultInfo, maxAmounts: bigint[], minShares: bigint, user: Address) {
    return send(user, () => wallet().writeContract({ account: user, chain: robinhoodChain, address: vault.address, abi: IndexVaultAbi, functionName: "deposit", args: [maxAmounts, minShares, user] }));
  }
  redeem(vault: VaultInfo, shares: bigint, user: Address) {
    return send(user, () => wallet().writeContract({ account: user, chain: robinhoodChain, address: vault.address, abi: IndexVaultAbi, functionName: "redeem", args: [shares, user] }));
  }
}
