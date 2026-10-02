// Cloudflare Pages Function: same-origin proxy for Uniswap's Trading API so the API key never reaches the browser.
// Set the key once: `npx wrangler@4 pages secret put UNISWAP_API_KEY --project-name hood20` (or in the Pages
// dashboard); locally, put `UNISWAP_API_KEY=...` in web/.dev.vars and run `npm run preview:pages`.
type Env = { UNISWAP_API_KEY?: string };
type Ctx = { request: Request; env: Env; params: { path?: string | string[] } };

const UPSTREAM = "https://trade-api.gateway.uniswap.org/v1";
const ALLOWED = new Set(["quote", "swap", "check_approval"]);

export const onRequestPost = async ({ request, env, params }: Ctx): Promise<Response> => {
  const path = Array.isArray(params.path) ? params.path.join("/") : (params.path ?? "");
  if (!ALLOWED.has(path)) return new Response("not found", { status: 404 });
  if (!env.UNISWAP_API_KEY) {
    return Response.json({ error: "UNISWAP_API_KEY is not configured on this deployment" }, { status: 503 });
  }
  const upstream = await fetch(`${UPSTREAM}/${path}`, {
    method: "POST",
    headers: {
      "x-api-key": env.UNISWAP_API_KEY,
      "content-type": "application/json",
      accept: "application/json",
      "x-universal-router-version": request.headers.get("x-universal-router-version") ?? "2.1.2",
    },
    body: await request.text(),
  });
  return new Response(upstream.body, {
    status: upstream.status,
    headers: { "content-type": upstream.headers.get("content-type") ?? "application/json", "cache-control": "no-store" },
  });
};
