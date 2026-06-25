// functions/api/resolve.js
// GET  /api/resolve?url={mediafire_url}&name=file.mp4&resolve=1
// POST /api/resolve  JSON: { url, name, resolve: true }

import {
  CORS_HEADERS,
  LINK_TTL,
  DIRECT_CACHE_TTL,
  normalizeMediafireUrl,
  idFromUrl,
  isValidId,
  cleanFilename,
  extractFilename,
  putSafe,
  getDirectLink,
} from "../_lib/mediafire.js";

export async function onRequest(context) {
  const { request, env } = context;

  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: CORS_HEADERS });
  }

  if (request.method !== "GET" && request.method !== "POST") {
    return json({ ok: false, error: "Method not allowed" }, 405);
  }

  let inputUrl = "";
  let customName = "";
  let resolveNow = false;

  const urlObj = new URL(request.url);

  if (request.method === "GET") {
    inputUrl = urlObj.searchParams.get("url") || "";
    customName = urlObj.searchParams.get("name") || "";
    resolveNow = urlObj.searchParams.get("resolve") === "1";
  } else {
    const ctype = request.headers.get("content-type") || "";

    if (ctype.includes("application/json")) {
      const body = await request.json().catch(() => ({}));
      inputUrl = body.url || "";
      customName = body.name || "";
      resolveNow = body.resolve === true || body.resolve === "1";
    } else {
      const form = await request.formData();
      inputUrl = form.get("url") || "";
      customName = form.get("name") || "";
      resolveNow = form.get("resolve") === "1";
    }
  }

  const mfUrl = normalizeMediafireUrl(inputUrl);

  if (!mfUrl) {
    return json({ ok: false, error: "Invalid MediaFire URL" }, 400);
  }

  const id = await idFromUrl(mfUrl);

  if (!isValidId(id)) {
    return json({ ok: false, error: "Invalid generated ID" }, 400);
  }

  customName = cleanFilename(customName);

  // original MediaFire URL ကို TTL နဲ့သိမ်း — KV မပြည့်အောင်
  await putSafe(
    env.LINKS.put(id, mfUrl, {
      expirationTtl: LINK_TTL,
    })
  );

  if (customName) {
    context.waitUntil(
      putSafe(
        env.LINKS.put("name:" + id, customName, {
          expirationTtl: LINK_TTL,
        })
      )
    );
  }

  const fallbackName = customName || extractFilename(mfUrl, "");
  const encodedName = encodeURIComponent(fallbackName || "download.mp4");
  const origin = urlObj.origin;

  const proxy = `${origin}/v/${id}/${encodedName}`;
  const redirect = `${origin}/d/${id}/${encodedName}`;

  let actualDirect = "";

  if (resolveNow) {
    const result = await getDirectLink(
      env,
      context,
      id,
      mfUrl,
      "",
      customName,
      { forceFresh: true }
    );

    actualDirect = result?.direct || "";

    // safety: direct cache TTL short
    if (actualDirect) {
      context.waitUntil(
        putSafe(
          env.LINKS.put("direct:" + id, actualDirect, {
            expirationTtl: DIRECT_CACHE_TTL,
          })
        )
      );
    }
  }

  return json({
    ok: true,
    id,
    mediafire: mfUrl,
    proxy,
    redirect,
    direct: actualDirect || null,
    note: resolveNow
      ? "direct is MediaFire CDN URL and may expire"
      : "use resolve=1 if you need actual MediaFire CDN direct URL now",
  });
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: {
      ...CORS_HEADERS,
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
    },
  });
}
