# hood20 — permissionless fixed-weight index vault for Robinhood Chain

[`src/IndexVault.sol`](src/IndexVault.sol): an ERC-20 index token (`INDEX`) backed by N tokenized assets held at
fixed target weights (e.g. 50/50, or 50/30/20) by oracle value. The vault custodies, accounts and verifies. It never
trades. When prices move the mix off target, the imbalance becomes a public arbitrage that anyone can settle
directly against the vault. **The protocol does not rebalance the portfolio. The market does.**
Three small companions: [`ChainlinkAdapter`](src/ChainlinkAdapter.sol) prices one asset behind the
[`IValuer`](src/IValuer.sol) interface, [`IndexVaultFactory`](src/IndexVaultFactory.sol) deploys and seeds vaults,
and [`IndexConfig`](src/IndexConfig.sol) holds the owner-managed settings every vault reads.

## How it works

Assets are passed to the constructor as an array of structs; the weights must sum to 100% and each valuer must
be bound to its token:

```solidity
struct Asset {
    IERC20 token;        // the ERC-20 held
    IValuer valuer;      // prices it in USD (18 decimals); immutable for the vault's life
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
take a Uniswap v2 flash swap, use its own inventory. It may keep up to **0.5% of the misplaced value** (the total
value sitting above target before the call).

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

Worked example (WETH +3% on a $1M 50/50 vault): $515,000 vs $500,000 → $7,500 sits above target → the rebalancer
may keep $37.50. Brief-style exchange: send in $7,500 of stock, take $7,537.50 of WETH, pull-rights requested over
WETH only. The vault ends $18.75 under target on WETH, far inside the tolerance
(`test_RebalanceBriefStyleExchangeKeepsTheIncentive`). With three assets one callback settles all of them
(`test_ThreeAssets_RebalanceLandsOnTargetKeepingTheIncentive`).

## Price sources

The vault never talks to an oracle directly. Each asset carries an [`IValuer`](src/IValuer.sol), one immutable
contract that answers `valueOf(amount)` in USD and must revert when its source is stale, invalid or closed:

```solidity
interface IValuer {
    function token() external view returns (address);
    function valueOf(uint256 amount) external view returns (uint256);
}
```

[`ChainlinkAdapter`](src/ChainlinkAdapter.sol) is the shipped implementation: one per (token, feed), holding the
decimals scale and a `maxStale` limit capped at 7 days. Robinhood Chain's equity feeds publish nothing from
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
| `incentiveBps` | 50 (0.5%) | 100 | share of the misplaced value a rebalancer may keep |
| `rebalanceInterval` | 18,000 blocks (~30 min on Robinhood Chain) | 1,000,000 | minimum blocks between two rebalances of a vault |
| `redeemFeeBps` | 0 (disabled) | 500 | slice of redeemed `INDEX` sent to `feeRecipient` instead of being burned |
| `feeRecipient` | none | must be set when the fee is > 0 | receives the fee as `INDEX` |

The fee is taken in shares: redeeming 250,000 INDEX at a 1% fee moves 2,500 INDEX to the recipient and redeems
the remaining 247,500 pro-rata (`test_RedeemFeeGoesToRecipientAsShares`). The caps are constants, so the owner
can never take more than 5% of a redemption or hand rebalancers more than 1% of the misplaced value.

## Security properties

- **Minimal trust, bounded by constants.** The vault and factory have no owner and no upgradeability; the asset
  list and weights are fixed at construction (weights must sum to 100%, no zero weights, no duplicate tokens).
  The only privileged party is the config owner, who can move the threshold, incentive and redeem fee within
  the hard caps above and nothing else. Ownership transfers are two-step.
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

## Gas (10-asset vault)

| Call | Gas | USD today |
|---|---|---|
| `factory.create` (deploy + seed; adapters deployed beforehand) | ~3.21M | $0.36 |
| `deposit` | ~289k | $0.032 |
| `redeem` | ~247k | $0.028 |
| `rebalance` (10 assets listed, callback moves all 10) | ~657k | $0.073 |
| `snapshot`, `deviationBps`, `assets` | views | free |

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
forge test -vv          # 25 tests incl. two fuzz properties (1,000 runs each)
forge fmt --check
slither .               # optional static analysis
```

## Deploy to Robinhood Chain (chain id 4663)

```sh
cp .env.example .env    # OWNER for the config; FACTORY, ASSETS, FEEDS, WEIGHTS_BPS, SEED_AMOUNTS for a vault
source .env
forge script script/DeployFactory.s.sol --rpc-url robinhood --account <keystore-name> --broadcast   # config + factory, once
forge script script/CreateVault.s.sol --rpc-url robinhood --account <keystore-name> --broadcast     # adapters + one seeded vault
```

WETH on Robinhood Chain: `0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73` (from Uniswap v2 Router02.WETH()).
Chainlink feeds there (all 8 decimals): ETH/USD `0x78F3556b67E17Df817D51Ef5a990cDaF09E8d3A9`,
AAPL `0x6B22A786bAa607d76728168703a39Ea9C99f2cD0`, NVDA `0x379EC4f7C378F34a1B47E4F3cbeBCbAC3E8E9F15`,
TSLA `0x4A1166a659A55625345e9515b32adECea5547C38`. Full list:
https://reference-data-directory.vercel.app/feeds-robinhood-mainnet.json
