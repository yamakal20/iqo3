// functions/v/[[path]].js
// PROXY route — /v/{id}.mp4
// Cloudflare ကနေ stream/download
// Range/seek/resume support
// inline mode: /v/{id}.mp4?inline=1

import {
  CORS_HEADERS,
  UA,
  isValidId,
  parsePath,
  readLinkRecord,
  getDirectLink,
  reResolve,
  pickFilename,
  sanitizeAscii,
} from "../_lib/mediafire.js";

export async function onRequest(context) {
  const { request, params, env } = context;

  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: CORS_HEADERS });
  }

  if (request.method !== "GET" && request.method !== "HEAD") {
    return new Response("Method not allowed", {
      status: 405,
      headers: CORS_HEADERS,
    });
  }

  const parsed = parsePath(params);
  if (!parsed) {
    return new Response("Invalid path", { status: 400, headers: CORS_HEADERS });
  }

  const { id, urlFilename } = parsed;

  if (!isValidId(id)) {
    return new Response("Invalid ID", { status: 400, headers: CORS_HEADERS });
  }

  const urlObj = new URL(request.url);
  const inline = urlObj.searchParams.get("inline") === "1";
  const fresh = urlObj.searchParams.get("fresh") === "1";

  const { mfUrl, customName, cachedDirect } = await readLinkRecord(env, id);

  if (!mfUrl) {
    return new Response("ID ရှာမတွေ့ပါ", {
      status: 404,
      headers: CORS_HEADERS,
    });
  }

  const result = await getDirectLink(
    env,
    context,
    id,
    mfUrl,
    fresh ? "" : cachedDirect,
    customName,
    { forceFresh: fresh }
  );

  if (!result?.direct) {
    return new Response("Direct link ရှာမတွေ့ပါ", {
      status: 502,
      headers: CORS_HEADERS,
    });
  }

  let direct = result.direct;

  const filename = pickFilename(
    urlFilename,
    customName,
    result.filename,
    mfUrl,
    direct
  );

  const method = request.method === "HEAD" ? "HEAD" : "GET";

  const fwdHeaders = new Headers();
  const range = request.headers.get("Range");

  if (range) fwdHeaders.set("Range", range);
  fwdHeaders.set("User-Agent", UA);
  fwdHeaders.set("Accept", "*/*");

  let upstream = await fetch(direct, {
    method,
    headers: fwdHeaders,
    redirect: "follow",
  });

  // cached direct stale/expired ဖြစ်ရင် fresh resolve
  if ([403, 404, 410].includes(upstream.status)) {
    const freshDirect = await reResolve(env, context, id, mfUrl, customName);

    if (freshDirect) {
      direct = freshDirect;
      upstream = await fetch(direct, {
        method,
        headers: fwdHeaders,
        redirect: "follow",
      });
    }
  }

  const respHeaders = new Headers();

  for (const h of [
    "content-length",
    "content-range",
    "accept-ranges",
    "last-modified",
    "etag",
  ]) {
    const v = upstream.headers.get(h);
    if (v) respHeaders.set(h, v);
  }

  const upstreamType = upstream.headers.get("content-type") || "";
  respHeaders.set("Access-Control-Allow-Origin", "*");
  respHeaders.set("Access-Control-Expose-Headers", "Content-Length,Content-Range,Accept-Ranges");
  respHeaders.set("Accept-Ranges", "bytes");
  respHeaders.set("Cache-Control", "public, max-age=60");
  respHeaders.set("Content-Type", upstreamType || "application/octet-stream");

  const dispositionType = inline ? "inline" : "attachment";

  respHeaders.set(
    "Content-Disposition",
    `${dispositionType}; filename="${sanitizeAscii(filename)}"; ` +
      `filename*=UTF-8''${encodeURIComponent(filename)}`
  );

  return new Response(method === "HEAD" ? null : upstream.body, {
    status: upstream.status,
    headers: respHeaders,
  });
}
