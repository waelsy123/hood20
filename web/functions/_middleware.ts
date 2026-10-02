// hood20.xyz is the canonical host. The legacy fleet hostname keeps serving the same deployment but redirects, so
// there is one URL for links, search and the Open Graph card. Pages Functions see every request, API routes included.
const CANONICAL = "hood20.xyz";
const LEGACY = new Set(["hood20.wael.today", "www.hood20.xyz"]);

export const onRequest = async ({ request, next }: { request: Request; next: () => Promise<Response> }): Promise<Response> => {
  const url = new URL(request.url);
  if (LEGACY.has(url.hostname) && request.method === "GET") {
    url.hostname = CANONICAL;
    return Response.redirect(url.toString(), 301);
  }
  return next();
};
