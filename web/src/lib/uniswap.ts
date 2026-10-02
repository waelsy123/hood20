// Uniswap Trading API client for the purchase flow. The API does the routing (v2/v3/v4, UniswapX excluded by asking
// for CLASSIC) and returns Universal Router calldata per leg; the dapp only merges the legs into one `execute`.
// Docs: https://developers.uniswap.org/docs/trading/swapping-api (POST /quote, /swap, /check_approval).
import { decodeFunctionData, encodeFunctionData, parseAbi, type Address, type Hex } from "viem";
import { CHAIN, UNISWAP, USDG } from "../config";

// Local development may call the API directly with VITE_UNISWAP_API_KEY; production goes through the Pages Function
// at /api/uniswap, which adds the key server-side.
const DIRECT_KEY = import.meta.env.VITE_UNISWAP_API_KEY as string | undefined;
const API = DIRECT_KEY ? UNISWAP.tradingApi : ((import.meta.env.VITE_UNISWAP_API_URL as string | undefined) ?? "/api/uniswap");

export type ApiQuote = {
  requestId?: string;
  routing: string; // CLASSIC | WRAP | UNWRAP | BRIDGE | DUTCH_V2 | DUTCH_V3 | PRIORITY
  quote: {
    input: { token: string; amount: string; maximumAmount?: string };
    output: { token: string; amount: string; minimumAmount?: string };
    slippage?: number;
    slippageTolerance?: number;
    priceImpact?: number;
    gasFeeUSD?: string;
    [k: string]: unknown;
  };
  permitData: unknown | null;
};
export type ApiSwap = { to: Address; from?: Address; data: Hex; value: string; gasLimit?: string; chainId: number };

// Keys are limited to 6 requests per second; a 10-asset purchase quotes 10 legs, so requests are spaced out.
let lastRequest = 0;
let queue: Promise<unknown> = Promise.resolve();
function throttle<T>(fn: () => Promise<T>): Promise<T> {
  const run = queue.then(async () => {
    const wait = lastRequest + 220 - Date.now();
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    lastRequest = Date.now();
  });
  queue = run.catch(() => undefined);
  return run.then(fn);
}

async function post<T>(path: string, body: unknown): Promise<T> {
  const r = await throttle(() =>
    fetch(`${API}/${path}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json",
        "x-universal-router-version": UNISWAP.universalRouterVersion, // calldata for the router build deployed on this chain
        ...(DIRECT_KEY ? { "x-api-key": DIRECT_KEY } : {}),
      },
      body: JSON.stringify(body),
    }),
  );
  const text = await r.text();
  if (!r.ok) throw new Error(`Uniswap ${path} failed (${r.status}): ${text.slice(0, 240)}`);
  return JSON.parse(text) as T;
}

/** Exact-output quote: how much USDG buys exactly `amountOut` of `tokenOut` for `swapper`, on classic AMM routes. */
export async function quoteExactOutput(swapper: Address, tokenOut: Address, amountOut: bigint): Promise<ApiQuote> {
  const q = await post<ApiQuote>("quote", {
    tokenIn: USDG.address,
    tokenOut,
    tokenInChainId: CHAIN.id,
    tokenOutChainId: CHAIN.id,
    amount: amountOut.toString(),
    type: "EXACT_OUTPUT",
    swapper,
    slippageTolerance: UNISWAP.slippagePct,
    routingPreference: "BEST_PRICE",
    protocols: ["V2", "V3", "V4"], // on-chain AMM swaps only (transaction calldata); UniswapX orders cannot be batched
  });
  if (q.routing !== "CLASSIC") throw new Error(`Uniswap routed ${tokenOut} as ${q.routing}, expected a classic swap`);
  if (q.quote.output.token.toLowerCase() !== tokenOut.toLowerCase()) throw new Error("Uniswap quote is for a different token");
  return q;
}

/** USDG the router may pull at most for this quote: the API's maximum, or the amount plus the slippage tolerance. */
export function maxInput(q: ApiQuote): bigint {
  if (q.quote.input.maximumAmount) return BigInt(q.quote.input.maximumAmount);
  const slipPct = q.quote.slippage ?? q.quote.slippageTolerance ?? UNISWAP.slippagePct;
  const bps = BigInt(Math.ceil(slipPct * 100));
  return (BigInt(q.quote.input.amount) * (10_000n + bps) + 9_999n) / 10_000n;
}

/** The transaction Uniswap would have the wallet send for one quote (requires the Permit2 allowance to exist). */
export async function swapTransaction(q: ApiQuote): Promise<ApiSwap> {
  if (q.permitData) throw new Error("Uniswap still expects a Permit2 signature; the router allowance is missing");
  const r = await post<{ swap: ApiSwap }>("swap", { quote: q.quote });
  if (r.swap.to.toLowerCase() !== UNISWAP.universalRouter.toLowerCase()) {
    throw new Error(`Uniswap returned calldata for ${r.swap.to}, not the Universal Router`);
  }
  return r.swap;
}

const routerAbi = parseAbi([
  "function execute(bytes commands, bytes[] inputs, uint256 deadline) payable",
  "function execute(bytes commands, bytes[] inputs) payable",
]);

/** Concatenates several Universal Router `execute` calls into one: commands and inputs append, the deadline is the earliest. */
export function mergeSwaps(swaps: ApiSwap[]): { to: Address; data: Hex; value: bigint } {
  let commands: Hex = "0x";
  const inputs: Hex[] = [];
  let deadline: bigint | null = null;
  let value = 0n;
  for (const s of swaps) {
    const d = decodeFunctionData({ abi: routerAbi, data: s.data });
    const [c, ins, dl] = d.args as readonly [Hex, readonly Hex[], bigint?];
    commands = `0x${commands.slice(2)}${c.slice(2)}`;
    inputs.push(...ins);
    if (dl !== undefined) deadline = deadline === null || dl < deadline ? dl : deadline;
    value += BigInt(s.value || "0");
  }
  const data =
    deadline === null
      ? encodeFunctionData({ abi: routerAbi, functionName: "execute", args: [commands, inputs] })
      : encodeFunctionData({ abi: routerAbi, functionName: "execute", args: [commands, inputs, deadline] });
  return { to: UNISWAP.universalRouter, data, value };
}

export const permit2Abi = parseAbi([
  "function allowance(address user, address token, address spender) view returns (uint160 amount, uint48 expiration, uint48 nonce)",
  "function approve(address token, address spender, uint160 amount, uint48 expiration)",
]);
export const MAX_UINT160 = (1n << 160n) - 1n;
