import { ADDRESSES, LINKS, MOCK, ZERO } from "../config";
import { useApp } from "../lib/context";
import { pct } from "../lib/format";

export function Docs() {
  const { config } = useApp();
  return (
    <main className="container docs" style={{ maxWidth: 820, paddingBottom: 64 }}>
      <div className="page-head"><h2 style={{ margin: 0 }}>How hood20 works</h2></div>
      <p className="muted">
        A hood20 vault is an ERC-20 index token backed by N tokenized assets held at fixed target weights by oracle value. The vault custodies,
        accounts and verifies. It never trades. When prices move the mix off target, the imbalance becomes a public arbitrage that anyone can
        settle directly against the vault.
      </p>

      <h2 id="deposit">Deposit and redeem</h2>
      <p>
        Deposits add every asset in the vault's current ratio and mint shares pro-rata; the scarcest amount you offer sets the share count. Redemptions
        burn shares for a pro-rata slice of every asset. Neither touches an oracle, so nobody can mint against a stale price or tilt the portfolio.
        The very first deposit into a new vault is made by the factory in the same transaction that deploys it, so a launch cannot be front-run.
      </p>

      <h2 id="rebalance">Rebalancing</h2>
      <p>
        Every asset is valued through its own immutable price adapter. Once any asset is at least {config ? pct(config.thresholdBps) : "0.5%"} of
        NAV away from its target, and the configured block interval since the last rebalance has passed, the vault is open. A rebalance is a single
        call:
      </p>
      <pre>{`vault.rebalance(uint256[] assetIds, bytes data)

// allow max  -> the vault sets unlimited allowance for you on the listed assets
// callback   -> it calls IRebalancer(msg.sender).onRebalance(data)
// allow zero -> allowances are revoked
// verify     -> reverts unless every asset is within 0.01% of NAV of its target
//               and NAV >= NAV_before - incentive * misplaced value`}</pre>
      <p>
        Inside the callback, pull the excess of overweight assets with <code>transferFrom(vault, …)</code>, send in the shortfall of underweight ones
        with <code>transfer(vault, …)</code>, and keep up to {config ? pct(config.incentiveBps) : "0.5%"} of the misplaced value. Where the assets
        come from is your business: inventory, a DEX route, or a Uniswap v2 flash swap. Only contracts can rebalance, because the vault calls back.
      </p>
      <h3>Landing exactly on target</h3>
      <pre>{`profit  <= incentiveBps/1e4 * misplaced          // misplaced = sum of value above target
target_i = (nav - profit) * weight_i / 1e4         // targets on the post-incentive NAV
pull_i   = floor((value_i - target_i) / price_i)   // overweight assets
push_i   = ceil((target_i - value_i) / price_i)    // underweight assets`}</pre>
      <p className="muted small">A second rebalance right after a successful one reverts: the vault is balanced and the interval is running.</p>

      <h2 id="config">Shared config</h2>
      <p>One owner-managed contract, read live by every vault, with hard caps so users know the worst case up front.</p>
      <div className="table-wrap">
        <table className="table">
          <thead><tr><th>Setting</th><th>Current</th><th>Hard cap</th><th>Used by</th></tr></thead>
          <tbody>
            <tr><td>Threshold</td><td className="num">{config ? pct(config.thresholdBps) : "—"}</td><td className="num">10%</td><td>drift required before a rebalance</td></tr>
            <tr><td>Incentive</td><td className="num">{config ? pct(config.incentiveBps) : "—"}</td><td className="num">1%</td><td>share of the misplaced value a rebalancer may keep</td></tr>
            <tr><td>Interval</td><td className="num">{config ? config.rebalanceInterval.toLocaleString() : "—"} blocks</td><td className="num">1,000,000</td><td>minimum blocks between two rebalances of a vault</td></tr>
            <tr><td>Redeem fee</td><td className="num">{config ? (config.redeemFeeBps ? pct(config.redeemFeeBps) : "off") : "—"}</td><td className="num">5%</td><td>slice of redeemed shares sent to the fee recipient</td></tr>
          </tbody>
        </table>
      </div>

      <h2 id="oracles">Price sources</h2>
      <p>
        Each asset carries a <code>ChainlinkAdapter</code> bound to one Chainlink USD feed with a staleness limit of about 25 hours. Robinhood Chain's
        equity feeds publish nothing from Friday's last tick until Sunday 8pm ET, so vaults holding stock tokens refuse to rebalance over weekends
        while on-chain pools keep trading. That is deliberate: a stale price is never settled against. Swapping a source means a new adapter and a
        successor vault; no live vault can have its valuer changed.
      </p>

      <h2 id="risks">What can still go wrong</h2>
      <ul style={{ lineHeight: 1.7 }}>
        <li>A paused or blocklisted stock token blocks redemptions of the whole vault until the issuer lifts it. A skip-and-forfeit redeem path is planned before mainnet.</li>
        <li>A lagging feed can cost holders at most the misplaced value times the mispricing per rebalance, never the whole vault.</li>
        <li>The config owner can move settings within the caps immediately; there is no timelock yet.</li>
        <li>The contracts are not audited yet. Treat any early deployment as experimental.</li>
      </ul>

      <h2 id="contracts">Contracts</h2>
      {MOCK ? (
        <p className="muted">Not deployed yet. This app runs in demo mode with mocked vaults. Source and tests: <a href={LINKS.repo} target="_blank" rel="noreferrer">GitHub</a>.</p>
      ) : (
        <dl className="kv">
          <dt>Factory</dt><dd>{ADDRESSES.factory}</dd>
          <dt>Config</dt><dd>{ADDRESSES.config === ZERO ? "—" : ADDRESSES.config}</dd>
        </dl>
      )}
      <p className="muted small">Chainlink feeds on Robinhood Chain: <a href={LINKS.feeds} target="_blank" rel="noreferrer">reference directory</a>.</p>
    </main>
  );
}
