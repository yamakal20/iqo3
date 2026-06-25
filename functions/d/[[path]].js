// functions/d/[[path]].js
// ★ DIRECT route — /d/{id}.mp4 ၊ MediaFire CDN direct link ကို 302 redirect
// ★ proxy မပါ၊ Cloudflare bandwidth မကုန်၊ browser က MediaFire ကို တန်းသွား
// ★ KV cache + parallel reads + background writes (resolve မြန်)

import {
  isValidId,
  parsePath,
  getDirectLink,
} from "../_lib/mediafire.js";

export async function onRequest(context) {
  const { request, params, env } = context;

  if (request.method !== "GET" && request.method !== "HEAD") {
    return new Response("Method not allowed", { status: 405 });
  }

  const parsed = parsePath(params);
  if (!parsed) return new Response("Invalid path", { status: 400 });
  const { id } = parsed;
  if (!isValidId(id)) return new Response("Invalid ID", { status: 400 });

  // ★ KV reads parallel — round-trip တစ်ခါတည်း
  const [mfUrl, cachedName, cachedDirect] = await Promise.all([
    env.LINKS.get(id),
    env.LINKS.get("name:" + id),
    env.LINKS.get("direct:" + id),
  ]);
  if (!mfUrl) return new Response("ID ရှာမတွေ့ပါ", { status: 404 });

  const result = await getDirectLink(
    env, context, id, mfUrl, cachedDirect, cachedName
  );
  if (!result) return new Response("Direct link ရှာမတွေ့ပါ", { status: 502 });

  // ★★★ proxy မလုပ်ဘဲ direct link ကို တန်း redirect ★★★
  return new Response(null, {
    status: 302,
    headers: {
      Location: result.direct,
      // direct link expire နိုင်လို့ browser/CDN မှာ cache မလုပ်
      "Cache-Control": "no-store",
      "Access-Control-Allow-Origin": "*",
    },
  });
}
