// Cloudflare Workers entry point.
// Requests to /api/... go to the price API; everything else is the website in ./public.
import { onRequestGet } from "./functions/api/[[path]].js";

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
    return env.ASSETS.fetch(request);
  },
};
