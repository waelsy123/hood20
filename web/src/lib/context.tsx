import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { MOCK } from "../config";
import { ChainSource } from "./chain";
import { MockSource } from "./mock";
import type { ConfigInfo, Source } from "./types";
import { useWallet, type Wallet } from "./wallet";

type Ctx = {
  source: Source;
  wallet: Wallet;
  config: ConfigInfo | null;
  block: bigint | null;
  error: string | null;
  setError: (e: string | null) => void;
};

const AppContext = createContext<Ctx | null>(null);

export function AppProvider({ children }: { children: ReactNode }) {
  const source = useMemo<Source>(() => (MOCK ? new MockSource() : new ChainSource()), []);
  const wallet = useWallet(source);
  const [config, setConfig] = useState<ConfigInfo | null>(null);
  const [block, setBlock] = useState<bigint | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    const tick = async () => {
      try {
        const [c, b] = await Promise.all([source.getConfig(), source.blockNumber()]);
        if (alive) {
          setConfig(c);
          setBlock(b);
        }
      } catch (e) {
        // a failed background refresh keeps the last good data; only a failed first load is worth a banner
        if (alive && config === null) setError((e as Error).message);
        else console.warn("config refresh failed", e);
      }
    };
    void tick();
    const id = setInterval(tick, 15_000);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, [source]);

  return <AppContext.Provider value={{ source, wallet, config, block, error, setError }}>{children}</AppContext.Provider>;
}

export function useApp(): Ctx {
  const c = useContext(AppContext);
  if (!c) throw new Error("AppProvider missing");
  return c;
}
