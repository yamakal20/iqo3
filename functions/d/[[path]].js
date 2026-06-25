// functions/d/[[path]].js
// DIRECT route — /d/{id}.mp4
// MediaFire CDN direct link ကို 302 redirect
// fastest mode: cached direct ရှိရင် ချက်ချင်း redirect
// force fresh: /d/{id}.mp4?fresh=1

import {
  CORS_HEADERS,
  isValidId,
  parsePath,
  readLinkRecord,
  getDirectLink,
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

  const { id } = parsed;
  if (!isValidId(id)) {
    return new Response("Invalid ID", { status: 400, headers: CORS_HEADERS });
  }

  const urlObj = new URL(request.url);
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

  return new Response(null, {
    status: 302,
    headers: {
      ...CORS_HEADERS,
      Location: result.direct,
      "Cache-Control": "no-store",
      "X-Direct-From-Cache": result.fromCache ? "1" : "0",
    },
  });
}
