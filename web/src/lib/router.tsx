import { useEffect, useState, type MouseEvent, type ReactNode } from "react";

const EVT = "hood20:navigate";

export function navigate(to: string) {
  history.pushState(null, "", to);
  window.dispatchEvent(new Event(EVT));
  window.scrollTo({ top: 0 });
}

export function usePath(): string {
  const [path, setPath] = useState(location.pathname);
  useEffect(() => {
    const h = () => setPath(location.pathname);
    window.addEventListener("popstate", h);
    window.addEventListener(EVT, h);
    return () => {
      window.removeEventListener("popstate", h);
      window.removeEventListener(EVT, h);
    };
  }, []);
  return path;
}

export function Link({ to, children, className }: { to: string; children: ReactNode; className?: string }) {
  const onClick = (e: MouseEvent<HTMLAnchorElement>) => {
    if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
    e.preventDefault();
    navigate(to);
  };
  return (
    <a href={to} className={className} onClick={onClick}>
      {children}
    </a>
  );
}
