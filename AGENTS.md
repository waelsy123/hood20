# hood20 — agent notes

Fixed-weight index vaults on Robinhood Chain (chain id 4663). Contracts in `src/` (Foundry), dapp in `web/` (Vite + React + viem).

## Layout
- `src/IndexVault.sol` — the vault (pro-rata deposit/redeem, allow→callback→revoke→verify rebalance). `IndexVaultFactory.sol` deploys + seeds vaults, `IndexConfig.sol` holds owner-managed settings with hard caps, `ChainlinkAdapter.sol` implements `IValuer`.
- `test/` — 25 Forge tests incl. fuzz; `test/Gas.t.sol` feeds the README gas table (`forge test --match-contract GasTest --isolate --gas-report`).
- `script/DeployFactory.s.sol` (config + factory), `script/CreateVault.s.sol` (adapters + seeded vault). Nothing is deployed yet.
- `web/` — landing page + dapp. `npm run build` regenerates `web/src/abi.ts` from `out/` (run `forge build` first). Contract addresses live in `web/src/config.ts`; both zero = **demo mode** with mocked vaults (`web/src/lib/mock.ts`). Set them after deploying and the same UI talks to the chain (`web/src/lib/chain.ts`).

## Hosting (Cloudflare Pages, fleet standard)
- Pages project `hood20` (account 342195c06981a49d1bc55dbf483274f1) → https://hood20.pages.dev and custom domain **https://hood20.wael.today** (zone wael.today `3bea3dd08c6aa6d38e02088b67df72c8`, `CNAME hood20 → hood20.pages.dev`, proxied — Pages is the origin).
- Push-to-deploy: `.github/workflows/deploy-pages.yml` builds contracts + web on every push to `main` and runs `wrangler pages deploy web/dist`. Secrets `CLOUDFLARE_API_TOKEN` (Pages:Edit-only token) and `CLOUDFLARE_ACCOUNT_ID` are set on the GitHub repo.
- Manual deploy: `cd web && npm run build && npx wrangler@4 pages deploy dist --project-name hood20 --branch main` with the same two env vars.
- Monitoring: cert-watch (fleet) covers hood20.wael.today; UptimeRobot monitor 804085577 (HTTPS, 5 min, contact 8714660). No error tracking on the frontend.

## Conventions
- Keep the contract, README and dapp math in sync: `web/src/lib/math.ts` mirrors `IndexVault` rounding (deposit ceil, redeem floor, gaps).
- Do not hand-edit `web/src/abi.ts`.
- Fleet runbook: `~/my-coolify-devops/server/README.md` § hood20.
