// functions/v/[[path]].js
// ★ catch-all route — /v/{id}.mp4 ရော /v/{id}/{filename} ရော နှစ်မျိုးလုံး ဖမ်းနိုင်
// ★ MediaFire OFFICIAL API သုံး resolve (HTML scrape ထက် မြန် + တည်ငြိမ်)
// ★ KV reads ကို Promise.all နဲ့ parallel
// ★ KV writes ကို waitUntil() နဲ့ background (response နှေးမသွား)
// ★ direct link ကို KV မှာ cache (TTL)
// ★ Range/seek/resume support, attachment force-download

const CACHE_TTL = 600; // direct link cache — 10 မိနစ်

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:131.0) " +
  "Gecko/20100101 Firefox/131.0";

export async function onRequest(context) {
  const { request, params, env, waitUntil } = context;

  // GET / HEAD သာ ခွင့်ပြု
  if (request.method !== "GET" && request.method !== "HEAD") {
    return new Response("Method not allowed", { status: 405 });
  }

  // ─── path ပိုင်းခြား ──────────────────────────────
  let segments = params.path;
  if (typeof segments === "string") segments = [segments];
  if (!Array.isArray(segments) || segments.length === 0) {
    return new Response("Invalid path", { status: 400 });
  }

  // ID = ပထမ segment (extension ဖယ်)
  let id = segments[0];
  if (id.includes(".")) id = id.substring(0, id.lastIndexOf("."));

  // ★ id sanitize — KV key injection / malformed key ကာကွယ်
  if (!/^[a-zA-Z0-9_-]{1,64}$/.test(id)) {
    return new Response("Invalid ID", { status: 400 });
  }

  // URL path ထဲက filename (ဒုတိယ segment)
  let urlFilename = "";
  if (segments.length >= 2) {
    try {
      urlFilename = decodeURIComponent(segments[segments.length - 1]);
    } catch (_) {
      urlFilename = segments[segments.length - 1];
    }
  }

  // ─── ★ KV reads အားလုံး PARALLEL (waterfall မဖြစ်) ──
  const cacheKey = "direct:" + id;
  const [mfUrl, customName, cachedDirect] = await Promise.all([
    env.LINKS.get(id),
    env.LINKS.get("name:" + id),
    env.LINKS.get(cacheKey),
  ]);

  if (!mfUrl) {
    return new Response("ID ရှာမတွေ့ပါ", { status: 404 });
  }

  // ─── direct link ရယူ (cache ဦးစားပေး) ─────────────
  let direct = cachedDirect;
  let resolvedMeta = null; // API ကရတဲ့ filename (ရရင် သုံးမယ်)

  if (!direct) {
    try {
      resolvedMeta = await resolveMediafire(mfUrl, id);
    } catch (e) {
      return new Response("Resolve error: " + e.message, { status: 502 });
    }
    if (!resolvedMeta || !resolvedMeta.direct) {
      return new Response("Direct link ရှာမတွေ့ပါ", { status: 502 });
    }
    direct = resolvedMeta.direct;

    // ★ KV write ကို background — response မစောင့်ဘူး
    const toCache = direct;
    waitUntil(env.LINKS.put(cacheKey, toCache, { expirationTtl: CACHE_TTL }));
    // API က filename ပေးရင် နောက်တစ်ခါ မ resolve ဘဲ ရအောင် cache
    if (resolvedMeta.filename && !customName) {
      waitUntil(
        env.LINKS.put("name:" + id, resolvedMeta.filename, {
          expirationTtl: CACHE_TTL,
        })
      );
    }
  }

  // ─── filename ဆုံးဖြတ် (priority) ──────────────────
  //   1) URL path filename  2) KV custom  3) API meta  4) URL ကနေ
  const filename =
    urlFilename ||
    customName ||
    (resolvedMeta && resolvedMeta.filename) ||
    extractFilename(mfUrl, direct);

  // ─── upstream သို့ fetch (Range forward) ───────────
  const fwdHeaders = new Headers();
  const range = request.headers.get("Range");
  if (range) fwdHeaders.set("Range", range);
  fwdHeaders.set("User-Agent", UA);

  const method = request.method === "HEAD" ? "HEAD" : "GET";

  let upstream = await fetch(direct, {
    method,
    headers: fwdHeaders,
    redirect: "follow",
  });

  // ─── cache link expire (403/404/410) → re-resolve ─
  if (
    upstream.status === 403 ||
    upstream.status === 410 ||
    upstream.status === 404
  ) {
    try {
      const fresh = await resolveMediafire(mfUrl, id);
      if (fresh && fresh.direct) {
        direct = fresh.direct;
        waitUntil(
          env.LINKS.put(cacheKey, direct, { expirationTtl: CACHE_TTL })
        );
        upstream = await fetch(direct, {
          method,
          headers: fwdHeaders,
          redirect: "follow",
        });
      }
    } catch (_) {
      // re-resolve မအောင်ရင် မူရင်း upstream error ကို ပြန်ပြ
    }
  }

  // ─── response headers ─────────────────────────────
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
  respHeaders.set("Access-Control-Allow-Origin", "*");
  respHeaders.set("Accept-Ranges", "bytes");
  // browser cache ကို CDN edge မှာ ခဏ ထား (re-resolve ကို လျှော့)
  respHeaders.set("Cache-Control", "public, max-age=60");

  // ★★★ play မဖြစ်ဘဲ ဖိုင်တန်းဒေါင်း ★★★
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

// ──────────────────────────────────────────────────
// filename ထဲက အန္တရာယ်ရှိနိုင်တဲ့ char ဖယ်
function sanitizeAscii(name) {
  return name
    .replace(/["\\\r\n]/g, "_")
    .replace(/[^\x20-\x7E]/g, "_");
}

// ──────────────────────────────────────────────────
// MediaFire / direct URL ကနေ filename ဆွဲထုတ် (fallback)
function extractFilename(mfUrl, directUrl) {
  try {
    const parts = new URL(mfUrl).pathname.split("/").filter(Boolean);
    // .../file/{key}/{FILENAME}/file
    if (parts[0] === "file" && parts.length >= 3) {
      const name = decodeURIComponent(parts[2]);
      if (name.includes(".")) return name;
    }
  } catch (_) {}
  try {
    const dParts = new URL(directUrl).pathname.split("/").filter(Boolean);
    const last = decodeURIComponent(dParts[dParts.length - 1] || "");
    if (last.includes(".")) return last;
  } catch (_) {}
  return "download.mp4";
}

// ──────────────────────────────────────────────────
// ★ MediaFire resolve — API ဦးစားပေး၊ မရမှ HTML scrape
// return: { direct, filename } | null
async function resolveMediafire(mfUrl, idHint) {
  // (1) URL ကနေ file key ထုတ်
  let key = idHint;
  const km = mfUrl.match(
    /mediafire\.com\/(?:file|file_premium)\/([a-zA-Z0-9]+)/i
  );
  if (km && km[1]) key = km[1];

  // (2) ★ Official API — အမြန်ဆုံး၊ JSON small response
  if (key && /^[a-zA-Z0-9]+$/.test(key)) {
    try {
      const apiUrl =
        "https://www.mediafire.com/api/file/get_info.php" +
        "?quick_key=" +
        key +
        "&response_format=json";
      const apiRes = await fetch(apiUrl, {
        headers: { "User-Agent": UA, Accept: "application/json" },
      });
      if (apiRes.ok) {
        const data = await apiRes.json();
        const info = data?.response?.file_info;
        const normal = info?.links?.normal_download;
        const fname = info?.filename || "";
        if (normal) {
          // normal_download က interstitial ဖြစ်နိုင် → direct ဖြစ်အောင် resolve
          const direct = await followToDirect(normal);
          if (direct) return { direct, filename: fname };
        }
      }
    } catch (_) {
      // API ကျရင် HTML fallback ဆက်သွား
    }
  }

  // (3) HTML scrape fallback
  const direct = await followToDirect(mfUrl);
  return direct ? { direct, filename: "" } : null;
}

// ──────────────────────────────────────────────────
// URL တစ်ခုကို fetch လုပ်ပြီး တကယ့် direct file link ရအောင် လုပ်
// (scrambled-url / downloadButton / redirect အားလုံး handle)
async function followToDirect(url) {
  const res = await fetch(url, {
    headers: {
      "User-Agent": UA,
      Accept: "text/html,application/xhtml+xml",
    },
    redirect: "follow",
  });

  // redirect ပြီး တကယ့် file host ကို ရောက်သွားရင် (HTML မဟုတ်တော့)
  const ctype = res.headers.get("content-type") || "";
  if (!ctype.includes("text/html")) {
    // ဒီ url ကိုယ်တိုင် direct ဖြစ်နေပြီ (res.url = final redirected URL)
    return res.url || url;
  }

  const html = await res.text();
  let link = null;

  // ★ scrambled-url (base64) — အခု MediaFire ရဲ့ ပင်မ နည်းလမ်း
  let m = html.match(/data-scrambled-url="([^"]+)"/i);
  if (m && m[1]) {
    try {
      const decoded = atob(m[1].trim());
      if (decoded.startsWith("http")) link = decoded;
    } catch (_) {}
  }

  // downloadButton href
  if (!link) {
    m = html.match(/id="downloadButton"[^>]*\shref="([^"]+)"/i);
    if (m && m[1] && m[1].startsWith("http")) link = m[1];
  }

  // generic download host
  if (!link) {
    m = html.match(/href="(https?:\/\/download[^"]+)"/i);
    if (m && m[1]) link = m[1];
  }

  // JS redirect
  if (!link) {
    m = html.match(/window\.location\.href\s*=\s*['"]([^'"]+)['"]/i);
    if (m && m[1] && m[1].startsWith("http")) link = m[1];
  }

  if (link) link = decodeHtmlEntities(link);
  return link;
}

// ──────────────────────────────────────────────────
function decodeHtmlEntities(str) {
  return str
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#x2F;/gi, "/");
}
