// functions/_lib/mediafire.js
// ★ proxy route ရော direct route ရော နှစ်ခုလုံး မျှသုံးတဲ့ helper
// ★ MediaFire OFFICIAL API ဦးစားပေး → normal_download HTML → data-scrambled-url decode
// ★ direct link မြန်အောင် KV cache + background write

export const CACHE_TTL = 1200;       // direct link cache — 20 မိနစ်
export const NEG_TTL   = 30;          // resolve fail negative-cache — 30 စက္ကန့်
export const NAME_TTL  = 86400;       // filename cache — 1 ရက် (filename မပြောင်းလို့ ကြာကြာထား)

export const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:131.0) " +
  "Gecko/20100101 Firefox/131.0";

// ──────────────────────────────────────────────────
// id validate (KV key injection ကာကွယ်)
export function isValidId(id) {
  return /^[a-zA-Z0-9_-]{1,64}$/.test(id);
}

// ──────────────────────────────────────────────────
// MediaFire quick_key (11 လုံး alnum) ထုတ်
export function extractQuickKey(mfUrl, idHint) {
  const m = (mfUrl || "").match(
    /mediafire\.com\/(?:file|file_premium|view|download|\?)\/?([a-zA-Z0-9]{11,15})/i
  );
  if (m && m[1]) return m[1];
  // ?quickkey= / ?<key> pattern
  const m2 = (mfUrl || "").match(/[?&]([a-zA-Z0-9]{11,15})(?:[&,]|$)/);
  if (m2 && m2[1]) return m2[1];
  if (idHint && /^[a-zA-Z0-9]{11,15}$/.test(idHint)) return idHint;
  return null;
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
export async function getDirectLink(env, ctx, id, mfUrl, cachedDirect, cachedName) {
  if (cachedDirect) {
    return { direct: cachedDirect, filename: cachedName || "", fromCache: true };
  }

  const meta = await resolveMediafire(mfUrl, id);
  if (!meta || !meta.direct) return null;

  // ★ KV write ကို background (response မစောင့်)
  ctx.waitUntil(
    env.LINKS.put("direct:" + id, meta.direct, { expirationTtl: CACHE_TTL })
  );
  // filename ကို custom မရှိမှသာ cache (custom ရှိရင် override မလုပ်)
  if (meta.filename && !cachedName) {
    ctx.waitUntil(
      env.LINKS.put("name:" + id, meta.filename, { expirationTtl: NAME_TTL })
    );
  }
  return {
    direct: meta.direct,
    filename: cachedName || meta.filename || "",
    fromCache: false,
  };
}

// ──────────────────────────────────────────────────
// re-resolve (cache link expire ဖြစ်ရင်) — direct ပြန်ပေး
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
    if ((parts[0] === "file" || parts[0] === "file_premium") && parts.length >= 3) {
      let name = decodeURIComponent(parts[2]);
      // MediaFire တစ်ခါတစ်ခါ double-encode (%255B) ဖြစ်တတ်
      if (name.includes("%")) {
        try { name = decodeURIComponent(name); } catch (_) {}
      }
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
export async function resolveMediafire(mfUrl, idHint) {
  const key = extractQuickKey(mfUrl, idHint);

  // (1) Official API — filename + normal_download page ရ
  if (key) {
    try {
      const apiUrl =
        "https://www.mediafire.com/api/1.5/file/get_info.php?quick_key=" +
        key + "&response_format=json";
      const apiRes = await fetch(apiUrl, {
        headers: { "User-Agent": UA, Accept: "application/json" },
      });
      if (apiRes.ok) {
        const data = await apiRes.json().catch(() => null);
        const info = data?.response?.file_info;
        const fname = info?.filename || "";
        const normal = info?.links?.normal_download;
        // ★ normal_download က HTML download-page → scrape လုပ်မှ direct
        if (normal) {
          const direct = await followToDirect(normal);
          if (direct) return { direct, filename: fname };
        }
        // API ရပေမယ့် link မရရင် filename တော့ မှတ်ထား → HTML fallback
        const direct2 = await followToDirect(mfUrl);
        if (direct2) return { direct: direct2, filename: fname };
        return null;
      }
    } catch (_) {}
  }

  // (2) HTML scrape fallback (API fail / key မရ)
  const direct = await followToDirect(mfUrl);
  return direct ? { direct, filename: "" } : null;
}

// ──────────────────────────────────────────────────
// URL ကို fetch → တကယ့် direct file link ရအောင်
// MediaFire download-page မှ data-scrambled-url (base64) ကို decode
async function followToDirect(url, depth = 0) {
  if (depth > 3) return null; // redirect loop ကာကွယ်

  let res;
  try {
    res = await fetch(url, {
      headers: {
        "User-Agent": UA,
        Accept: "text/html,application/xhtml+xml,*/*",
        "Accept-Language": "en-US,en;q=0.9",
      },
      redirect: "follow",
    });
  } catch (_) {
    return null;
  }

  const ctype = (res.headers.get("content-type") || "").toLowerCase();

  // ★ HTML မဟုတ်ရင် = ကိုယ်တိုင် direct file ဖြစ်နေပြီ
  if (!ctype.includes("text/html")) {
    return res.url || url;
  }

  let html;
  try {
    html = await res.text();
  } catch (_) {
    return null;
  }

  const link = extractLinkFromHtml(html);
  if (!link) return null;

  // scrambled link က တစ်ခါတစ်ခါ download-page တစ်ဆင့်ထပ်ဖြစ်တတ် → recurse
  if (/mediafire\.com\/(file|view|download)/i.test(link) && link !== url) {
    const deeper = await followToDirect(link, depth + 1);
    if (deeper) return deeper;
  }
  return link;
}

// ──────────────────────────────────────────────────
// HTML ထဲမှ direct link ထုတ် (pattern များစွာ စမ်း)
function extractLinkFromHtml(html) {
  let link = null;

  // (a) ★ အဓိက — id="downloadButton" data-scrambled-url="BASE64"
  let m = html.match(
    /id=["']downloadButton["'][^>]*\bdata-scrambled-url=["']([^"']+)["']/i
  );
  if (!m) {
    // attribute order ပြောင်းနေရင်လည်း ဖမ်း
    m = html.match(/\bdata-scrambled-url=["']([^"']+)["']/i);
  }
  if (m && m[1]) {
    const decoded = safeAtob(m[1].trim());
    if (decoded && /^https?:\/\//i.test(decoded)) link = decoded;
  }

  // (b) downloadButton href တိုက်ရိုက် (scramble မပါတဲ့ case)
  if (!link) {
    m = html.match(/id=["']downloadButton["'][^>]*\bhref=["'](https?:[^"']+)["']/i);
    if (m && m[1]) link = m[1];
  }
  if (!link) {
    m = html.match(/\bhref=["'](https?:[^"']+)["'][^>]*id=["']downloadButton["']/i);
    if (m && m[1]) link = m[1];
  }

  // (c) download.mediafire.com တိုက်ရိုက် link
  if (!link) {
    m = html.match(/href=["'](https?:\/\/download[^"']+)["']/i);
    if (m && m[1]) link = m[1];
  }

  // (d) JS redirect: window.location.href = '...'
  if (!link) {
    m = html.match(/window\.location\.href\s*=\s*["'](https?:[^"']+)["']/i);
    if (m && m[1]) link = m[1];
  }

  if (link) link = decodeHtmlEntities(link.trim());
  return link;
}

// ──────────────────────────────────────────────────
// base64 → string (atob fail-safe, URL-safe base64 လည်း ထောက်ပံ့)
function safeAtob(b64) {
  try {
    let s = b64.replace(/-/g, "+").replace(/_/g, "/");
    const pad = s.length % 4;
    if (pad) s += "=".repeat(4 - pad);
    return atob(s);
  } catch (_) {
    return null;
  }
}

// ──────────────────────────────────────────────────
function decodeHtmlEntities(str) {
  return str
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/&#x2F;/gi, "/");
}
