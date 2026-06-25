// functions/_lib/mediafire.js
// MediaFire helper — direct redirect + proxy route နှစ်ခုလုံးသုံး
// API first, HTML scrape fallback, KV cache TTL, stale refresh

export const DIRECT_CACHE_TTL = 600; // 10 minutes — MediaFire CDN link expire ဖြစ်တတ်လို့ တိုတိုထား
export const NAME_CACHE_TTL = 86400; // 1 day
export const LINK_TTL = 60 * 60 * 24 * 30; // /api/resolve က add လုပ်တဲ့ original MF link TTL: 30 days

export const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:131.0) " +
  "Gecko/20100101 Firefox/131.0";

export const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET,HEAD,POST,OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type,Range",
};

// ─────────────────────────────────────────────
// ID validate — KV key injection ကာကွယ်
export function isValidId(id) {
  return /^[a-zA-Z0-9_-]{1,80}$/.test(id || "");
}

// ─────────────────────────────────────────────
// path segments → { id, urlFilename }
export function parsePath(params) {
  let segments = params.path;
  if (typeof segments === "string") segments = [segments];
  if (!Array.isArray(segments) || segments.length === 0) return null;

  let id = segments[0] || "";
  if (id.includes(".")) id = id.substring(0, id.lastIndexOf("."));

  let urlFilename = "";
  if (segments.length >= 2) {
    urlFilename = cleanFilename(segments[segments.length - 1]);
  }

  return { id, urlFilename };
}

// ─────────────────────────────────────────────
// KV 3 keys ကို one operation နဲ့ဖတ်
export async function readLinkRecord(env, id) {
  const keys = [id, "name:" + id, "direct:" + id];

  // Workers KV supports get(array) => Map
  const map = await env.LINKS.get(keys);

  return {
    mfUrl: map.get(id) || null,
    customName: map.get("name:" + id) || "",
    cachedDirect: map.get("direct:" + id) || "",
  };
}

// ─────────────────────────────────────────────
// direct link ရယူ — cached direct first, မရမှ resolve
// return: { direct, filename, fromCache }
export async function getDirectLink(
  env,
  ctx,
  id,
  mfUrl,
  cachedDirect = "",
  customName = "",
  options = {}
) {
  const forceFresh = !!options.forceFresh;

  if (!forceFresh && cachedDirect && looksLikeMediafireDirect(cachedDirect)) {
    return {
      direct: cachedDirect,
      filename: customName || "",
      fromCache: true,
    };
  }

  const meta = await resolveMediafire(mfUrl, id);
  if (!meta || !meta.direct) return null;

  cacheResolved(env, ctx, id, meta.direct, meta.filename, customName);

  return {
    direct: meta.direct,
    filename: meta.filename || "",
    fromCache: false,
  };
}

// ─────────────────────────────────────────────
// cache link expire ဖြစ်ရင် re-resolve
export async function reResolve(env, ctx, id, mfUrl, customName = "") {
  const meta = await resolveMediafire(mfUrl, id);
  if (!meta || !meta.direct) return null;

  cacheResolved(env, ctx, id, meta.direct, meta.filename, customName);
  return meta.direct;
}

// ─────────────────────────────────────────────
// background cache writes — KV 429 ဖြစ်လည်း response မပျက်အောင် catch
export function cacheResolved(env, ctx, id, direct, filename = "", customName = "") {
  if (!env?.LINKS || !ctx?.waitUntil) return;

  ctx.waitUntil(
    putSafe(
      env.LINKS.put("direct:" + id, direct, {
        expirationTtl: DIRECT_CACHE_TTL,
      })
    )
  );

  if (filename && !customName) {
    ctx.waitUntil(
      putSafe(
        env.LINKS.put("name:" + id, filename, {
          expirationTtl: NAME_CACHE_TTL,
        })
      )
    );
  }
}

export async function putSafe(promise) {
  try {
    return await promise;
  } catch (_) {
    return null;
  }
}

// ─────────────────────────────────────────────
// filename ဆုံးဖြတ် priority
export function pickFilename(urlFilename, customName, metaFilename, mfUrl, direct) {
  const name =
    cleanFilename(urlFilename) ||
    cleanFilename(customName) ||
    cleanFilename(metaFilename) ||
    extractFilename(mfUrl, direct);

  return name || "download.mp4";
}

export function sanitizeAscii(name) {
  return String(name || "download.mp4")
    .replace(/["\\\r\n]/g, "_")
    .replace(/[^\x20-\x7E]/g, "_");
}

// ─────────────────────────────────────────────
// MediaFire original URL normalize/validate
export function normalizeMediafireUrl(input) {
  let url = String(input || "").trim();

  if (!url) return "";
  if (!/^https?:\/\//i.test(url)) url = "https://" + url;

  try {
    const u = new URL(url);
    const host = u.hostname.toLowerCase();

    if (host !== "mediafire.com" && host !== "www.mediafire.com") return "";

    const key = extractQuickKey(url);
    if (!key) return "";

    return u.toString();
  } catch (_) {
    return "";
  }
}

// ─────────────────────────────────────────────
// quick_key extract
export function extractQuickKey(mfUrl) {
  try {
    const u = new URL(mfUrl);
    const path = u.pathname;

    // /file/{quick_key}/filename/file
    // /file_premium/{quick_key}/...
    let m = path.match(/\/(?:file|file_premium)\/([a-zA-Z0-9]+)(?:\/|$)/i);
    if (m?.[1]) return m[1];

    // fallback
    m = mfUrl.match(/mediafire\.com\/(?:file|file_premium)\/([a-zA-Z0-9]+)/i);
    if (m?.[1]) return m[1];

    return "";
  } catch (_) {
    return "";
  }
}

// ─────────────────────────────────────────────
// stable short id for /api/resolve
export async function idFromUrl(mfUrl) {
  const key = extractQuickKey(mfUrl);
  if (key) return key;

  const data = new TextEncoder().encode(mfUrl);
  const digest = await crypto.subtle.digest("SHA-256", data);
  const bytes = Array.from(new Uint8Array(digest));
  return bytes.map((b) => b.toString(16).padStart(2, "0")).join("").slice(0, 16);
}

// ─────────────────────────────────────────────
// MediaFire resolve — API first, HTML scrape fallback
export async function resolveMediafire(mfUrl, idHint = "") {
  mfUrl = normalizeMediafireUrl(mfUrl) || mfUrl;

  let key = extractQuickKey(mfUrl) || idHint;
  let apiFilename = "";
  let apiNormal = "";

  // 1) Official API — filename + normal_download ရယူ
  if (key && /^[a-zA-Z0-9]+$/.test(key)) {
    try {
      const apiUrl =
        "https://www.mediafire.com/api/file/get_info.php?quick_key=" +
        encodeURIComponent(key) +
        "&response_format=json";

      const apiRes = await fetchWithTimeout(
        apiUrl,
        {
          headers: {
            "User-Agent": UA,
            Accept: "application/json,text/plain,*/*",
          },
          redirect: "follow",
        },
        7000
      );

      if (apiRes.ok) {
        const data = await apiRes.json();
        const info = data?.response?.file_info;

        apiFilename = cleanFilename(info?.filename || "");
        apiNormal = info?.links?.normal_download || "";

        if (apiNormal) {
          const direct = await followToDirect(apiNormal);
          if (direct) return { direct, filename: apiFilename };
        }
      }
    } catch (_) {}
  }

  // 2) HTML scrape fallback — original page
  try {
    const direct = await followToDirect(mfUrl);
    if (direct) {
      return {
        direct,
        filename: apiFilename || extractFilename(mfUrl, direct),
      };
    }
  } catch (_) {}

  return null;
}

// ─────────────────────────────────────────────
// URL fetch → real CDN direct link
export async function followToDirect(url) {
  const res = await fetchWithTimeout(
    url,
    {
      method: "GET",
      headers: {
        "User-Agent": UA,
        Accept:
          "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.9",
      },
      redirect: "follow",
    },
    9000
  );

  const finalUrl = res.url || url;
  const ctype = res.headers.get("content-type") || "";
  const dispo = res.headers.get("content-disposition") || "";

  // fetch result ကိုယ်တိုင် CDN/file ဖြစ်နေပြီ
  if (
    looksLikeMediafireDirect(finalUrl) ||
    dispo.toLowerCase().includes("attachment") ||
    (ctype && !ctype.toLowerCase().includes("text/html"))
  ) {
    return finalUrl;
  }

  const html = await res.text();
  const direct = extractDirectFromHtml(html);
  return direct || "";
}

// ─────────────────────────────────────────────
// HTML ထဲက download*.mediafire.com link ကို robust extract
export function extractDirectFromHtml(html) {
  if (!html) return "";

  const raw = String(html);
  const decodedHtml = decodeHtmlEntities(raw);
  const unescaped = decodedHtml.replace(/\\\//g, "/").replace(/\\/g, "");

  // 1) data-scrambled-url="base64..."
  let m = raw.match(/data-scrambled-url\s*=\s*["']([^"']+)["']/i);
  if (m?.[1]) {
    try {
      const v = atob(m[1].trim());
      if (looksLikeMediafireDirect(v)) return decodeHtmlEntities(v);
    } catch (_) {}
  }

  // 2) direct download domain anywhere
  const patterns = [
    /href\s*=\s*["'](https?:\/\/download[^"']+mediafire\.com\/[^"']+)["']/gi,
    /data-href\s*=\s*["'](https?:\/\/download[^"']+mediafire\.com\/[^"']+)["']/gi,
    /["'](https?:\/\/download[^"']+mediafire\.com\/[^"']+)["']/gi,
    /(https?:\/\/download[^\s"'<>]+mediafire\.com\/[^\s"'<>]+)/gi,
  ];

  for (const text of [decodedHtml, unescaped]) {
    for (const re of patterns) {
      re.lastIndex = 0;
      while ((m = re.exec(text))) {
        const candidate = cleanupUrl(m[1]);
        if (looksLikeMediafireDirect(candidate)) return candidate;
      }
    }
  }

  // 3) JS location fallback
  m = unescaped.match(/window\.location(?:\.href)?\s*=\s*["']([^"']+)["']/i);
  if (m?.[1]) {
    const candidate = cleanupUrl(m[1]);
    if (looksLikeMediafireDirect(candidate)) return candidate;
  }

  return "";
}

// ─────────────────────────────────────────────
export function looksLikeMediafireDirect(url) {
  try {
    const u = new URL(cleanupUrl(url));
    const host = u.hostname.toLowerCase();

    return (
      /^download\d*\.mediafire\.com$/i.test(host) ||
      /^download[^.]*\.mediafire\.com$/i.test(host)
    );
  } catch (_) {
    return false;
  }
}

// ─────────────────────────────────────────────
export function cleanupUrl(url) {
  return decodeHtmlEntities(String(url || ""))
    .replace(/\\\//g, "/")
    .replace(/&amp;/g, "&")
    .trim();
}

// ─────────────────────────────────────────────
export function extractFilename(mfUrl, directUrl = "") {
  try {
    const parts = new URL(mfUrl).pathname.split("/").filter(Boolean);

    // /file/{id}/{filename}/file
    if ((parts[0] === "file" || parts[0] === "file_premium") && parts.length >= 3) {
      const name = cleanFilename(parts[2]);
      if (name && name.includes(".")) return name;
    }
  } catch (_) {}

  try {
    const dParts = new URL(directUrl).pathname.split("/").filter(Boolean);
    const last = cleanFilename(dParts[dParts.length - 1] || "");
    if (last && last.includes(".")) return last;
  } catch (_) {}

  return "download.mp4";
}

// double-encoded name တွေ %255B → %5B → [ ဖြစ်အောင်
export function cleanFilename(name) {
  let s = String(name || "").trim();
  if (!s) return "";

  s = s.replace(/\+/g, " ");

  for (let i = 0; i < 3; i++) {
    try {
      const d = decodeURIComponent(s);
      if (d === s) break;
      s = d;
    } catch (_) {
      break;
    }
  }

  return s.replace(/[/\\?%*:|"<>]/g, "_").trim();
}

// ─────────────────────────────────────────────
function decodeHtmlEntities(str) {
  return String(str || "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#x27;/gi, "'")
    .replace(/&#x2F;/gi, "/");
}

// ─────────────────────────────────────────────
async function fetchWithTimeout(url, init = {}, ms = 8000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort("timeout"), ms);

  try {
    return await fetch(url, {
      ...init,
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }
}
