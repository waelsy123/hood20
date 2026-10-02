# hood20 — permissionless fixed-weight index vault for Robinhood Chain

[`src/IndexVault.sol`](src/IndexVault.sol): an ERC-20 index token (`INDEX`) backed by N tokenized assets held at
fixed target weights (e.g. 50/50, or 50/30/20) by oracle value. The vault custodies, accounts and verifies. It never
trades. When prices move the mix off target, the imbalance becomes a public arbitrage that anyone can settle
directly against the vault. **The protocol does not rebalance the portfolio. The market does.**
Three small companions: [`ChainlinkAdapter`](src/ChainlinkAdapter.sol) prices one asset behind the
[`IValuer`](src/IValuer.sol) interface, [`IndexVaultFactory`](src/IndexVaultFactory.sol) deploys and seeds vaults,
and [`IndexConfig`](src/IndexConfig.sol) holds the owner-managed settings every vault reads.

## How it works

Assets are passed to the constructor as an array of structs; the weights must sum to 100% and every token must
be registered in the shared config, which supplies the immutable valuer the vault stores for its whole life:

```solidity
struct AssetInput {
    IERC20 token;        // a token the config owner has registered
    uint256 weightBps;   // target share of NAV; all weights sum to 10_000
}
```

| Call | What happens | Who |
|---|---|---|
| `deposit(maxAmounts, minShares, to)` | Every asset in the vault's current ratio (the scarcest offer binds); mints `INDEX` pro-rata. The first deposit must include every asset and fixes 1 INDEX = 1 USD. | anyone |
| `redeem(shares, to)` | Burns `INDEX`, returns a pro-rata slice of every asset. | anyone |
| `rebalance(assetIds, data)` | Allowed once any asset is ≥ 0.5% of NAV off target and the configured block interval since the vault's last rebalance has passed. **Allow max → callback → allow zero → verify**: the vault sets unlimited allowance for the caller on the listed assets, calls `onRebalance(data)` on the caller, revokes the allowances, and reverts unless the vault is balanced again with at most the incentive missing. | any contract |

Inside the callback the rebalancer does whatever it likes: pull the excess of overweight assets with
`transferFrom(vault, …)`, send in the shortfall of underweight ones with `transfer(vault, …)`, route through a DEX,
take a Uniswap v2 flash swap, use its own inventory. Holders pay at most **0.5% of the misplaced value** (the total
value sitting above target before the call). That budget is shared: the rebalancer keeps up to 0.5% ÷ 1.1 ≈ 0.45%,
and the **index creator** receives INDEX worth 10% of whatever the rebalancer actually kept, minted after the
balance check. Creators earn on every rebalance of their index without raising the cost to holders.

```solidity
interface IRebalancer {
    function onRebalance(bytes calldata data) external;
}
```

Valuation: `value_i = balance_i × price_i`, `NAV = Σ value_i`, `target_i = NAV × weight_i`.
Deviation in basis points is `max_i |value_i − target_i| / NAV`. "Balanced" after a rebalance means every asset is
less than 0.01% of NAV away from its target at the post-rebalance NAV. To land there exactly, compute targets on
`NAV − profit` (the NAV the vault will hold after you keep `profit ≤ 0.5% × misplaced`); the test helper `_plan`
does this.

Worked example (WETH +3% on a $1M 50/50 vault): $515,000 vs $500,000 → $7,500 sits above target → holders pay at
most $37.50: the rebalancer keeps up to $34.09 and the creator receives INDEX worth $3.41
(`test_RebalanceSplitsTheIncentiveWithTheCreator`). With the creator share off, a brief-style exchange sends in
$7,500 of stock and takes $7,537.50 of WETH with pull-rights over WETH only; the vault ends $18.75 under target on
WETH, far inside the tolerance (`test_RebalanceBriefStyleExchangeKeepsTheIncentive`). With three assets one callback
settles all of them (`test_ThreeAssets_RebalanceLandsOnTargetKeepingTheIncentive`).

## Price sources and the asset registry

The vault never talks to an oracle directly. Each asset carries an [`IValuer`](src/IValuer.sol), one immutable
contract that answers `valueOf(amount)` in USD and must revert when its source is stale, invalid or closed. The
config owner curates them: `IndexConfig.registerAsset(token, feed, maxStale)` deploys a `ChainlinkAdapter` for the
triple at a deterministic address (registering the same triple again is a no-op) and records it as the token's
valuer. New vaults may only hold registered tokens and copy the valuer at construction, so re-registering a token
with a new feed changes nothing for vaults that already exist. `script/RegisterAssets.s.sol` registers every
verified pair from the feed directory in one run:

```solidity
interface IValuer {
    function token() external view returns (address);
    function valueOf(uint256 amount) external view returns (uint256);
}
```

[`ChainlinkAdapter`](src/ChainlinkAdapter.sol) is the shipped implementation: one per (token, feed, maxStale),
holding the decimals scale and a `maxStale` limit capped at 7 days. Robinhood Chain's equity feeds publish nothing from
Friday's last tick until Sunday 8pm ET (52 to 76 hour gaps measured, holidays included) while on-chain pools
keep trading, so the suggested `maxStale` of 90,000 s (25 h) makes vaults fail closed over weekends. Do not
raise it past the weekend gap. Swapping a source (Chainlink Data Streams with a market-status flag, a TWAP for a
crypto leg) means deploying a new adapter and a successor vault; no live vault can have its valuer changed.

## Factory

[`src/IndexVaultFactory.sol`](src/IndexVaultFactory.sol) (45 lines, no owner, holds nothing between transactions)
is bound to one `IndexConfig` at construction and hands it to every vault. It deploys a vault **and makes its
first deposit in the same transaction**, so nobody can front-run a launch with a dust deposit that fixes a
skewed initial mix. Deploy one adapter per asset, approve the factory for the seed amounts, then:

```solidity
IndexVault vault = factory.create(name, symbol, assets, seedAmounts); // INDEX minted to msg.sender
factory.all();                                                        // every vault it deployed
```

## Config

[`src/IndexConfig.sol`](src/IndexConfig.sol) (38 lines, `Ownable2Step`) is deployed once, passed to the factory's
constructor and from there to every vault as an immutable reference. Vaults read it live, so one `set` call
applies to all of them:

| Setting | Default | Hard cap | Used by |
|---|---|---|---|
| `thresholdBps` | 50 (0.5%) | 1,000 | drift required before `rebalance` |
| `incentiveBps` | 50 (0.5%) | 100 | what holders pay per rebalance, as a share of the misplaced value |
| `creatorShareBps` | 1,000 (10%) | 5,000 | the index creator's cut of what the rebalancer kept, minted as INDEX |
| `rebalanceInterval` | 18,000 blocks (~30 min on Robinhood Chain) | 1,000,000 | minimum blocks between two rebalances of a vault |
| `redeemFeeBps` | 0 (disabled) | 500 | slice of redeemed `INDEX` sent to `feeRecipient` instead of being burned |
| `feeRecipient` | none | must be set when the fee is > 0 | receives the fee as `INDEX` |

The fee is taken in shares: redeeming 250,000 INDEX at a 1% fee moves 2,500 INDEX to the recipient and redeems
the remaining 247,500 pro-rata (`test_RedeemFeeGoesToRecipientAsShares`). The caps are constants, so the owner
can never take more than 5% of a redemption or hand rebalancers more than 1% of the misplaced value.

## Security properties

- **Minimal trust, bounded by constants.** The vault and factory have no owner and no upgradeability; the asset
  list and weights are fixed at construction (weights must sum to 100%, no zero weights, no duplicate tokens,
  only registered tokens). The only privileged party is the config owner, who can move the threshold, incentive,
  creator share, interval and redeem fee within the hard caps above and register assets for future vaults, and
  nothing else: no setting or registration can touch a vault that already exists. Ownership transfers are
  two-step. The index creator is recorded at launch and only ever receives newly minted INDEX; it has no powers.
- **Only curated assets.** Because vaults resolve valuers from the registry, nobody can launch a vault on a fake
  token or a fake feed through the factory; the catalog users see is the one enforced on-chain.
- **Deposits/redemptions are pro-rata in every asset**, so they cannot tilt the portfolio and never touch oracle
  prices. That closes the classic "mint with the stale-priced asset, redeem the others" oracle-latency arbitrage
  that value-based single-asset minting would open. The only oracle-priced mint is the very first one.
- **Pull-rights cannot drain the vault.** They exist only inside the callback, are revoked right after, and the
  call reverts unless (a) every asset is within 0.01% of NAV of its target and (b) NAV is at least NAV-before
  minus 0.5% of the value that was above target. The NAV floor is what stops a caller from pulling 99% of every
  asset in proportion and still reading as "balanced". Pulling without pushing, pushing without pulling, or
  keeping more than the incentive all revert. `deposit`, `redeem` and `rebalance` share the reentrancy guard,
  so nothing else can be called mid-callback.
- **Bounded oracle risk.** A mispriced or lagging source can cost holders at most *(misplaced value ×
  mispricing)* per rebalance, never the vault.
- **Oracle safety lives in the adapter**: a positive answer younger than `maxStale` (capped at 7 days), and the
  vault checks at construction that every valuer is bound to its token. Prices are constant within a
  transaction, and a manipulated price cannot drain the vault because the rebalancer always receives the side
  the price overvalues. There is no L2 sequencer-uptime feed on this chain, so none is checked.
- **Rounding always favours the vault**: deposits round pulled amounts up, redemptions round down. Share count is
  derived first and amounts from it, so donation/inflation attacks cannot make a depositor overpay by more than
  one raw unit; `minShares` guards deposits against front-running.
- `nonReentrant` on every state-changing entry point, `SafeERC20` everywhere, 512-bit `mulDiv` math.

Assumptions: standard ERC-20s (no fee-on-transfer, no rebasing; Robinhood Stock Tokens qualify — their
uiMultiplier is display-only and the Chainlink "Robinhood X / USD" total-return feeds price the raw unit).
Issuer controls on tokenized stocks (blocklist, pause, adminBurn) are an external risk the vault cannot
remove: if the vault address were blocked for one asset, redemptions of every asset would stall.

## Simplifications versus the brief

- No separate "signal" step or pre-rebalance cooldown: prices are read at execution either way, so a delay before
  a rebalance adds no safety. Throttling is done after the fact instead: the config's `rebalanceInterval`
  (default ~30 minutes of blocks) must pass between two rebalances of the same vault.
- No management or mint fee; the redeem fee (off by default) is the only revenue switch and lives in the config.
- No explicit max-price-deviation check; the balance requirement plus the NAV floor make it unnecessary.
- No live oracle replacement: valuers are immutable per vault, so retiring a source means a successor vault.
- Deposits are pro-rata rather than oracle-valued (deliberate, see above).
- Rebalancers must be contracts (the vault calls them back); an EOA cannot rebalance directly.
- Seed the vault in the deployment run (`SEED_AMOUNTS`) so nobody can front-run the first deposit with a dust
  deposit that sets a skewed initial mix. Dust would be fixable via a rebalance, but avoid the churn.

## Price feeds and tokens on Robinhood Chain

[`data/robinhood-chain-feeds.json`](data/robinhood-chain-feeds.json) is the single reference for oracle and token
addresses: every Chainlink feed on the chain (proxy, current aggregator, decimals, heartbeat, deviation trigger,
Chainlink risk tier, market hours) merged with Robinhood's stock-token registry (address, decimals, ISIN, ERC-8056
multiplier, trading status), each checked live on-chain (price, last update, aggregator match, token symbol).
Regenerate with `cd web && node scripts/feeds.mjs`; the dapp's curated catalog reads token and feed addresses from it.

## Buying an index with USDG: Uniswap routes, two wallet transactions

Vaults only take pro-rata deposits of every constituent, and there is deliberately no zap or router contract in front
of them: a periphery that holds user funds mid-transaction needs an owner-curated router allowlist and its own audit
surface, and routing is a problem Uniswap already solves. The dapp's **Pay with USDG** flow therefore outsources the
swaps entirely:

1. For the shares you want, the dapp computes the exact amount of every constituent the vault will pull
   (`depositAmounts`, the same ceil rounding as the contract) and asks Uniswap's hosted Trading API for an
   **exact-output** quote per asset you are short of (`type: EXACT_OUTPUT`, `protocols: [V2, V3, V4]` so the answer
   is an on-chain swap, never a UniswapX order). Uniswap picks the pools and returns Universal Router calldata per leg.
2. Your wallet sends **one** Universal Router `execute` with all legs appended (the dapp only concatenates the
   commands Uniswap returned and refuses to send them anywhere but the router), paid through Permit2. Two one-time
   approvals are requested when missing: USDG → Permit2 and Permit2 → Universal Router.
3. Your wallet sends `deposit(amounts, minShares, you)` with exactly what was bought; `minShares` guards the quote.
   The vault exposes the same math on-chain: `previewDeposit(shares)` is what a depositor must hold and approve
   for exactly `shares`, `previewShares(maxAmounts)` what a deposit would mint, `previewRedeem(shares)` what a
   redemption pays.
   Per-asset approvals to the vault are requested once per vault. Buying exact outputs means no dust: the vault pulls
   precisely what arrived.

Routing never touches the contracts, so nothing on-chain has to be trusted with it, and the dapp carries no pool
knowledge. The API key stays server-side: [`web/functions/api/uniswap/[[path]].ts`](web/functions/api/uniswap/%5B%5Bpath%5D%5D.ts)
is a Cloudflare Pages Function proxying `/quote`, `/swap` and `/check_approval` with the `UNISWAP_API_KEY` secret
(set on the hood20 project; locally `web/.dev.vars` and `npm run preview:pages`). Requests carry
`x-universal-router-version: 2.1.2`, the router build deployed on this chain, and are spaced to stay under the key's
6 requests per second. Verified against the live API on 2026-10-02: exact-output quotes for Robinhood stock tokens
come back `CLASSIC` through v4 pools, `/swap` returns `execute` calldata for the Universal Router, and two legs merge
into one call with their inputs intact. Without the key the purchase tab reports that quotes are unavailable;
depositing assets you already hold always works.

## Gas (10-asset vault)

| Call | Gas | USD today |
|---|---|---|
| `factory.create` (deploy + seed; assets registered beforehand) | ~3.33M | $0.37 |
| `deposit` | ~289k | $0.032 |
| `redeem` | ~247k | $0.028 |
| `rebalance` (10 assets listed, callback moves all 10, creator paid) | ~671k | $0.075 |
| `snapshot`, `deviationBps`, `assets`, `previewDeposit`, `previewShares`, `previewRedeem` | views | free |

Measured by [`test/Gas.t.sol`](test/Gas.t.sol) with `forge test --match-contract GasTest --isolate --gas-report`
(each call its own transaction, cold storage, mock ERC-20s; Robinhood Stock Tokens run blocklist checks, so expect
a bit more per transfer). USD at Robinhood Chain's gas price of 0.042 gwei and ETH at $2,662 on 2026-09-24. The
chain currently charges no L1 data fee (`ArbGasInfo.getPricesInWei` per-byte price is 0), so 1M gas ≈ $0.11.

## Web app

[`web/`](web/) is the landing page and dapp, live at https://hood20.wael.today (Cloudflare Pages, push-to-deploy from
`main`). Until the contracts are deployed it runs in **demo mode** on mocked vaults; set the factory and config
addresses in `web/src/config.ts` and the same UI reads and writes the chain through viem. `npm run build` regenerates
the ABIs from the Forge artifacts so the dapp can never drift from the contracts.

## Develop

```sh
forge build
forge test -vv          # 29 tests incl. four fuzz properties (two at 1,000 runs, two 10-asset deposit fuzzes at 400)
forge fmt --check
slither .               # optional static analysis
```

## Deploy to Robinhood Chain (chain id 4663)

```sh
cp .env.example .env    # OWNER for the config; CONFIG to register assets; FACTORY, ASSETS, WEIGHTS_BPS, SEED_AMOUNTS for a vault
source .env
forge script script/DeployFactory.s.sol --rpc-url robinhood --account <keystore-name> --broadcast   # config + factory, once
forge script script/RegisterAssets.s.sol --rpc-url robinhood --account <keystore-name> --broadcast  # adapters for every verified feed, once
forge script script/CreateVault.s.sol --rpc-url robinhood --account <keystore-name> --broadcast     # one seeded vault
```

WETH on Robinhood Chain: `0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73` (from Uniswap v2 Router02.WETH()).
Chainlink feeds there (all 8 decimals): ETH/USD `0x78F3556b67E17Df817D51Ef5a990cDaF09E8d3A9`,
AAPL `0x6B22A786bAa607d76728168703a39Ea9C99f2cD0`, NVDA `0x379EC4f7C378F34a1B47E4F3cbeBCbAC3E8E9F15`,
TSLA `0x4A1166a659A55625345e9515b32adECea5547C38`. Full list:
https://reference-data-directory.vercel.app/feeds-robinhood-mainnet.json
