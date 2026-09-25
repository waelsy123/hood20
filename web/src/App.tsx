import { AppProvider, useApp } from "./lib/context";
import { Link, usePath } from "./lib/router";
import { Landing } from "./pages/Landing";
import { Vaults } from "./pages/Vaults";
import { Vault } from "./pages/Vault";
import { Create } from "./pages/Create";
import { Docs } from "./pages/Docs";
import { MOCK, LINKS } from "./config";
import { short } from "./lib/format";

function Header() {
  const path = usePath();
  const { wallet, setError } = useApp();
  const is = (p: string) => (p === "/" ? path === "/" : path.startsWith(p));
  const connect = () => wallet.connect().catch((e) => setError((e as Error).message));
  return (
    <header className="header">
      <div className="container">
        <Link to="/" className="brand">
          <img className="mark" src="/favicon.svg" alt="" />
          hood20
        </Link>
        <nav className="nav">
          <Link to="/app" className={is("/app") || is("/create") ? "active" : ""}>Vaults</Link>
          <Link to="/docs" className={is("/docs") ? "active" : ""}>Docs</Link>
        </nav>
        <div className="spacer" />
        {MOCK && <span className="pill warn"><span className="dot" />demo mode</span>}
        {wallet.address ? (
          wallet.wrongChain ? (
            <button className="btn sm" onClick={() => wallet.switchChain().catch((e) => setError((e as Error).message))}>Switch to Robinhood Chain</button>
          ) : (
            <button className="btn sm mono" onClick={wallet.disconnect} title="Disconnect">{short(wallet.address)}</button>
          )
        ) : (
          <button className="btn sm primary" onClick={connect}>{MOCK ? "Connect demo wallet" : "Connect wallet"}</button>
        )}
      </div>
    </header>
  );
}

function Footer() {
  return (
    <footer className="footer">
      <div className="container">
        <span>hood20 — fixed-weight index vaults on Robinhood Chain. The protocol never trades; the market rebalances it.</span>
        <span className="row">
          <Link to="/docs">Docs</Link>
          <a href={LINKS.repo} target="_blank" rel="noreferrer">GitHub</a>
          <a href={LINKS.chainDocs} target="_blank" rel="noreferrer">Robinhood Chain</a>
        </span>
      </div>
    </footer>
  );
}

function Routes() {
  const path = usePath();
  if (path === "/") return <Landing />;
  if (path === "/docs") return <Docs />;
  if (path === "/create") return <Create />;
  if (path === "/app" || path === "/app/") return <Vaults />;
  const m = path.match(/^\/app\/vault\/(0x[0-9a-fA-F]{40})$/);
  if (m) return <Vault address={m[1] as `0x${string}`} />;
  return (
    <main className="container section">
      <h2>Not found</h2>
      <p className="muted">Nothing lives at <code>{path}</code>.</p>
      <Link to="/" className="btn">Back home</Link>
    </main>
  );
}

function Shell() {
  const { error, setError } = useApp();
  return (
    <>
      <Header />
      {error && (
        <div className="container">
          <div className="banner bad row between">
            <span>{error}</span>
            <button className="btn sm" onClick={() => setError(null)}>dismiss</button>
          </div>
        </div>
      )}
      <Routes />
      <Footer />
    </>
  );
}

export function App() {
  return (
    <AppProvider>
      <Shell />
    </AppProvider>
  );
}
