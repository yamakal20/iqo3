// functions/v/[[path]].js
// ★ PROXY route — /v/{id}.mp4 ၊ Cloudflare ကနေ stream/download
// ★ KV cache + parallel reads + background writes
// ★ Range/seek/resume, attachment force-download

import {
  CACHE_TTL,
  UA,
  isValidId,
  parsePath,
  getDirectLink,
  reResolve,
  pickFilename,
  sanitizeAscii,
} from "../_lib/mediafire.js";

export async function onRequest(context) {
  const { request, params, env } = context;

  if (request.method !== "GET" && request.method !== "HEAD") {
    return new Response("Method not allowed", { status: 405 });
  }

  const parsed = parsePath(params);
  if (!parsed) return new Response("Invalid path", { status: 400 });
  const { id, urlFilename } = parsed;
  if (!isValidId(id)) return new Response("Invalid ID", { status: 400 });

  // ★ KV reads parallel
  const [mfUrl, customName, cachedDirect] = await Promise.all([
    env.LINKS.get(id),
    env.LINKS.get("name:" + id),
    env.LINKS.get("direct:" + id),
  ]);
  if (!mfUrl) return new Response("ID ရှာမတွေ့ပါ", { status: 404 });

  const result = await getDirectLink(
    env, context, id, mfUrl, cachedDirect, customName
  );
  if (!result) return new Response("Direct link ရှာမတွေ့ပါ", { status: 502 });
  let direct = result.direct;

  const filename = pickFilename(
    urlFilename, customName, result.filename, mfUrl, direct
  );

  // upstream fetch (Range forward)
  const fwdHeaders = new Headers();
  const range = request.headers.get("Range");
  if (range) fwdHeaders.set("Range", range);
  fwdHeaders.set("User-Agent", UA);
  const method = request.method === "HEAD" ? "HEAD" : "GET";

  let upstream = await fetch(direct, { method, headers: fwdHeaders, redirect: "follow" });

  // cache link expire → re-resolve
  if ([403, 404, 410].includes(upstream.status)) {
    const fresh = await reResolve(env, context, id, mfUrl);
    if (fresh) {
      direct = fresh;
      upstream = await fetch(direct, { method, headers: fwdHeaders, redirect: "follow" });
    }
  }

  const respHeaders = new Headers();
  for (const h of ["content-length", "content-range", "accept-ranges", "last-modified", "etag"]) {
    const v = upstream.headers.get(h);
    if (v) respHeaders.set(h, v);
  }
  respHeaders.set("Access-Control-Allow-Origin", "*");
  respHeaders.set("Accept-Ranges", "bytes");
  respHeaders.set("Cache-Control", "public, max-age=60");
  respHeaders.set("Content-Type", "application/octet-stream");
  respHeaders.set(
    "Content-Disposition",
    `attachment; filename="${sanitizeAscii(filename)}"; ` +
      `filename*=UTF-8''${encodeURIComponent(filename)}`
  );

  return new Response(method === "HEAD" ? null : upstream.body, {
    status: upstream.status,
    headers: respHeaders,
  });
}
