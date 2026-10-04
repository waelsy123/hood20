import { useCallback, useEffect, useState } from "react";
import type { Address } from "viem";
import { CHAIN } from "../config";
import { injected } from "./chain";
import { DEMO_USER } from "./mock";
import type { Source } from "./types";

const HEX_CHAIN = `0x${CHAIN.id.toString(16)}`;

export type Wallet = {
  address: Address | null;
  chainId: number | null;
  wrongChain: boolean;
  connect: () => Promise<void>;
  disconnect: () => void;
  switchChain: () => Promise<void>;
};

export function useWallet(source: Source): Wallet {
  const [address, setAddress] = useState<Address | null>(null);
  const [chainId, setChainId] = useState<number | null>(null);

  // A wallet the user already connected stays authorised across reloads; eth_accounts reports it without
  // prompting, so the header shows the address again instead of asking every time.
  useEffect(() => {
    if (source.mock) return;
    const eth = injected();
    if (!eth) return;
    let alive = true;
    void (async () => {
      try {
        const accounts = (await eth.request({ method: "eth_accounts" })) as string[];
        if (!alive || !accounts?.[0]) return;
        setAddress(accounts[0] as Address);
        setChainId(parseInt((await eth.request({ method: "eth_chainId" })) as string, 16));
      } catch {
        /* no wallet, or it refuses to answer without a prompt */
      }
    })();
    return () => {
      alive = false;
    };
  }, [source]);

  useEffect(() => {
    if (source.mock) return;
    const eth = injected();
    if (!eth?.on) return;
    const onAccounts = (a: string[]) => setAddress((a[0] as Address) ?? null);
    const onChain = (c: string) => setChainId(parseInt(c, 16));
    eth.on("accountsChanged", onAccounts);
    eth.on("chainChanged", onChain);
    return () => {
      eth.removeListener?.("accountsChanged", onAccounts);
      eth.removeListener?.("chainChanged", onChain);
    };
  }, [source]);

  const connect = useCallback(async () => {
    if (source.mock) {
      setAddress(DEMO_USER);
      setChainId(CHAIN.id);
      return;
    }
    const eth = injected();
    if (!eth) throw new Error("No wallet found. Install Rabby, MetaMask or Robinhood Wallet.");
    const accounts = (await eth.request({ method: "eth_requestAccounts" })) as string[];
    setAddress((accounts[0] as Address) ?? null);
    setChainId(parseInt((await eth.request({ method: "eth_chainId" })) as string, 16));
  }, [source]);

  const switchChain = useCallback(async () => {
    if (source.mock) return;
    const eth = injected();
    if (!eth) return;
    try {
      await eth.request({ method: "wallet_switchEthereumChain", params: [{ chainId: HEX_CHAIN }] });
    } catch (e) {
      if ((e as { code?: number }).code !== 4902) throw e;
      await eth.request({
        method: "wallet_addEthereumChain",
        params: [{ chainId: HEX_CHAIN, chainName: CHAIN.name, nativeCurrency: CHAIN.nativeCurrency, rpcUrls: [CHAIN.rpc], blockExplorerUrls: [CHAIN.explorer] }],
      });
    }
  }, [source]);

  return { address, chainId, wrongChain: chainId !== null && chainId !== CHAIN.id, connect, disconnect: () => setAddress(null), switchChain };
}
