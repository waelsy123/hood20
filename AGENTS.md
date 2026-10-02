# hood20 — agent notes

Fixed-weight index vaults on Robinhood Chain (chain id 4663). Contracts in `src/` (Foundry), dapp in `web/` (Vite + React + viem).

## Layout
- `src/IndexVault.sol` — the vault (pro-rata deposit/redeem, allow→callback→revoke→verify rebalance). `IndexVaultFactory.sol` deploys + seeds vaults, `IndexConfig.sol` holds owner-managed settings with hard caps AND the curated asset registry (`registerAsset` deploys a `ChainlinkAdapter` per (token, feed, maxStale) via CREATE2; vaults resolve `valuerOf(token)` at construction and keep it forever), `ChainlinkAdapter.sol` implements `IValuer`.
- `test/` — 29 Forge tests incl. fuzz (`test/DepositFuzz.t.sol`: 10-asset exact-purchase and direct-deposit fuzzes); `test/Gas.t.sol` feeds the README gas table (`forge test --match-contract GasTest --isolate --gas-report`).
- No zap / periphery contract by design. Buying with USDG = Uniswap Trading API exact-output quotes per constituent (`web/src/lib/uniswap.ts`), ONE Universal Router `execute` merged from the returned calldata (sent only to the router address in `config.ts UNISWAP`), then `deposit`. The API key lives in the Pages Function `web/functions/api/uniswap/[[path]].ts` (secret `UNISWAP_API_KEY`; `web/.dev.vars` + `npm run preview:pages` locally). Deploy runs wrangler from `web/` so the function ships.
- `script/DeployFactory.s.sol` (config + factory), `script/RegisterAssets.s.sol` (adapters for every verified feed in `data/robinhood-chain-feeds.json`; needs the `fs_permissions` read on `./data`), `script/CreateVault.s.sol` (seeded vault from registered assets). `script/verify-etherscan.sh` verifies on robin.etherscan.io (Etherscan V2; forge's verifier rejects chain 4663).
- **Deployed 2026-10-02 on Robinhood Chain**: IndexConfig `0x543A25b213ABa3aCce7747B392273a4751B5D297` (owner → Wael's wallet `0x3FB96501caB94F33C7Db15229D78198A3F893D58` via Ownable2Step; accept button on the Vaults page), IndexVaultFactory `0x0a9c469B0f56EDb6a7d67bDB71a76567F6cae2B1`, 37 ChainlinkAdapters (maxStale 90000). All verified on Etherscan. Deployer keystore `hood20-deployer` (`0xDf62…49E7`, password in 1Password). An earlier pair `0xE93B…8a1c` / `0x0D8d…4592` is abandoned: its config is owned by Foundry's default script sender (the `msg.sender`-outside-broadcast footgun, since fixed in DeployFactory).
- `web/` — landing page + dapp. `npm run build` regenerates `web/src/abi.ts` from `out/` (run `forge build` first). Contract addresses live in `web/src/config.ts` (set since 2026-10-02, so the live site talks to the chain via `web/src/lib/chain.ts`); both zero = **demo mode** with mocked vaults (`web/src/lib/mock.ts`).

## Feed directory
- `data/robinhood-chain-feeds.json` = Chainlink reference-data directory for Robinhood Chain + Robinhood `rhj/assets`
  registry + live on-chain checks. Regenerate: `cd web && node scripts/feeds.mjs` (plain RPC calls; the public RPC
  rejects JSON-RPC batches). `web/src/config.ts` derives `CURATED_ASSETS` token/feed addresses from it.

## Hosting (Cloudflare Pages, fleet standard)
- Pages project `hood20` (account 342195c06981a49d1bc55dbf483274f1) → https://hood20.pages.dev and custom domain **https://hood20.wael.today** (zone wael.today `3bea3dd08c6aa6d38e02088b67df72c8`, `CNAME hood20 → hood20.pages.dev`, proxied — Pages is the origin).
- Push-to-deploy: `.github/workflows/deploy-pages.yml` builds contracts + web on every push to `main` and runs `wrangler pages deploy web/dist`. Secrets `CLOUDFLARE_API_TOKEN` (Pages:Edit-only token) and `CLOUDFLARE_ACCOUNT_ID` are set on the GitHub repo.
- Manual deploy: `cd web && npm run build && npx wrangler@4 pages deploy dist --project-name hood20 --branch main` with the same two env vars.
- Monitoring: cert-watch (fleet) covers hood20.wael.today; UptimeRobot monitor 804085577 (HTTPS, 5 min, contact 8714660). No error tracking on the frontend.

## Conventions
- Keep the contract, README and dapp math in sync: `web/src/lib/math.ts` mirrors `IndexVault` rounding (deposit ceil, redeem floor, gaps).
- Do not hand-edit `web/src/abi.ts`.
- `block.number` on Robinhood Chain is the Ethereum L1 block (~12 s), not the 0.1 s L2 block: `rebalanceInterval`/`lastRebalanceBlock` count L1 blocks (live config 150 ≈ 30 min; the contract default 18,000 would be ~60 h). The dapp reads the block via Multicall3.getBlockNumber and uses `CHAIN.blockTimeSeconds = 12`. Reads go through PublicNode with the official RPC as fallback, batched with Multicall3; the official RPC 429s after ~10 rapid calls.
- Fleet runbook: `~/my-coolify-devops/server/README.md` § hood20.
