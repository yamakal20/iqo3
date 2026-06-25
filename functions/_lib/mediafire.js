// functions/_lib/mediafire.js
// ★ proxy route ရော direct route ရော နှစ်ခုလုံး မျှသုံးတဲ့ helper
// ★ MediaFire OFFICIAL API ဦးစားပေး resolve (HTML scrape ထက်မြန်+တည်ငြိမ်)

export const CACHE_TTL = 600; // direct link cache — 10 မိနစ်

export const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:131.0) " +
  "Gecko/20100101 Firefox/131.0";

// ──────────────────────────────────────────────────
// id validate (KV key injection ကာကွယ်)
export function isValidId(id) {
  return /^[a-zA-Z0-9_-]{1,64}$/.test(id);
}

// ──────────────────────────────────────────────────
// path segments → { id, urlFilename }
export function parsePath(params) {
  let segments = params.path;
  if (typeof segments === "string") segments = [segments];
  if (!Array.isArray(segments) || segments.length === 0) return null;

  let id = segments[0];
  if (id.includes(".")) id = id.substring(0, id.lastIndexOf("."));

  let urlFilename = "";
  if (segments.length >= 2) {
    try {
      urlFilename = decodeURIComponent(segments[segments.length - 1]);
    } catch (_) {
      urlFilename = segments[segments.length - 1];
    }
  }
  return { id, urlFilename };
}

// ──────────────────────────────────────────────────
// ★ direct link ရယူ — cache ဦးစားပေး၊ မရမှ resolve
// return: { direct, filename, fromCache }
export async function getDirectLink(env, ctx, id, mfUrl, cachedDirect, customName) {
  if (cachedDirect) {
    return { direct: cachedDirect, filename: customName || "", fromCache: true };
  }

  const meta = await resolveMediafire(mfUrl, id);
  if (!meta || !meta.direct) return null;

  const cacheKey = "direct:" + id;
  // ★ KV write ကို background (response မစောင့်)
  ctx.waitUntil(
    env.LINKS.put(cacheKey, meta.direct, { expirationTtl: CACHE_TTL })
  );
  if (meta.filename && !customName) {
    ctx.waitUntil(
      env.LINKS.put("name:" + id, meta.filename, { expirationTtl: CACHE_TTL })
    );
  }
  return { direct: meta.direct, filename: meta.filename || "", fromCache: false };
}

// ──────────────────────────────────────────────────
// re-resolve (cache link expire ဖြစ်ရင်)
export async function reResolve(env, ctx, id, mfUrl) {
  const meta = await resolveMediafire(mfUrl, id);
  if (!meta || !meta.direct) return null;
  ctx.waitUntil(
    env.LINKS.put("direct:" + id, meta.direct, { expirationTtl: CACHE_TTL })
  );
  return meta.direct;
}

// ──────────────────────────────────────────────────
// filename ဆုံးဖြတ် (priority order)
export function pickFilename(urlFilename, customName, metaFilename, mfUrl, direct) {
  return (
    urlFilename ||
    customName ||
    metaFilename ||
    extractFilename(mfUrl, direct)
  );
}

// ──────────────────────────────────────────────────
export function sanitizeAscii(name) {
  return name.replace(/["\\\r\n]/g, "_").replace(/[^\x20-\x7E]/g, "_");
}

// ──────────────────────────────────────────────────
function extractFilename(mfUrl, directUrl) {
  try {
    const parts = new URL(mfUrl).pathname.split("/").filter(Boolean);
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
export async function resolveMediafire(mfUrl, idHint) {
  let key = idHint;
  const km = mfUrl.match(
    /mediafire\.com\/(?:file|file_premium)\/([a-zA-Z0-9]+)/i
  );
  if (km && km[1]) key = km[1];

  // (1) Official API — အမြန်ဆုံး
  if (key && /^[a-zA-Z0-9]+$/.test(key)) {
    try {
      const apiUrl =
        "https://www.mediafire.com/api/file/get_info.php?quick_key=" +
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
          const direct = await followToDirect(normal);
          if (direct) return { direct, filename: fname };
        }
      }
    } catch (_) {}
  }

  // (2) HTML scrape fallback
  const direct = await followToDirect(mfUrl);
  return direct ? { direct, filename: "" } : null;
}

// ──────────────────────────────────────────────────
// URL ကို fetch → တကယ့် direct file link ရအောင်
async function followToDirect(url) {
  const res = await fetch(url, {
    headers: { "User-Agent": UA, Accept: "text/html,application/xhtml+xml" },
    redirect: "follow",
  });

  const ctype = res.headers.get("content-type") || "";
  if (!ctype.includes("text/html")) {
    return res.url || url; // ကိုယ်တိုင် direct ဖြစ်နေပြီ
  }

  const html = await res.text();
  let link = null;

  let m = html.match(/data-scrambled-url="([^"]+)"/i);
  if (m && m[1]) {
    try {
      const decoded = atob(m[1].trim());
      if (decoded.startsWith("http")) link = decoded;
    } catch (_) {}
  }
  if (!link) {
    m = html.match(/id="downloadButton"[^>]*\shref="([^"]+)"/i);
    if (m && m[1] && m[1].startsWith("http")) link = m[1];
  }
  if (!link) {
    m = html.match(/href="(https?:\/\/download[^"]+)"/i);
    if (m && m[1]) link = m[1];
  }
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
