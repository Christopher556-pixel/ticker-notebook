// Cloudflare Workers entry point.
// /api/... goes to the price API in [[path]].js; the home page is index.html.
import { onRequestGet } from "./[[path]].js";
import PAGE from "./index.html";

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.pathname.startsWith("/api/")) {
      if (request.method !== "GET" && request.method !== "HEAD") {
        return new Response(JSON.stringify({ error: { code: "method_not_allowed", message: "Only GET is supported." } }), {
          status: 405, headers: { "Content-Type": "application/json" },
        });
      }
      const path = url.pathname.slice("/api/".length).split("/").filter(Boolean);
      return onRequestGet({ request, env, params: { path }, waitUntil: p => ctx.waitUntil(p) });
    }
    if (url.pathname === "/" || url.pathname === "/index.html") {
      return new Response(PAGE, { headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "public, max-age=300" } });
    }
    return new Response("Not found", { status: 404, headers: { "Content-Type": "text/plain" } });
  },
};
