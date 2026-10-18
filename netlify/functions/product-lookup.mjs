// Product link lookup — fetches a retailer page server-side and extracts
// name / brand / price / image / dimensions for the Kitchen Designer's
// custom-product form. Best effort: anything not found comes back null.
//
// GET /.netlify/functions/product-lookup?url=<encoded product page URL>
// → { ok:true, name, brand, price, image, wIn, dIn, hIn }  (inches, 1 decimal)
// → { ok:false, error } on bad input or a page we could not read.

const MAX_BYTES = 2 * 1024 * 1024; // ~2MB read cap
const TIMEOUT_MS = 10000;
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

const round1 = (n) => (Number.isFinite(n) ? Math.round(n * 10) / 10 : null);

function convert(val, unit) {
  if (!Number.isFinite(val)) return null;
  const u = (unit || "in").toLowerCase();
  if (u === "mm") return round1(val / 25.4);
  if (u === "cm") return round1(val / 2.54);
  if (u === "ft" || u === "feet" || u === "'") return round1(val * 12);
  return round1(val);
}

// Parses "35", "35.79", and "35 7/8" style numbers.
function parseNum(s) {
  if (s == null) return null;
  const str = String(s).trim().replace(/,/g, "");
  const frac = str.match(/^(\d+(?:\.\d+)?)\s+(\d+)\s*\/\s*(\d+)$/);
  if (frac) {
    const d = parseFloat(frac[3]);
    if (!d) return null;
    return parseFloat(frac[1]) + parseFloat(frac[2]) / d;
  }
  const n = parseFloat(str);
  return Number.isFinite(n) ? n : null;
}

// JSON-LD dimension values arrive as numbers, strings ("35.8 in"), or
// QuantitativeValue objects ({ value, unitText / unitCode }).
function toInches(v) {
  if (v == null) return null;
  if (typeof v === "object") {
    const val = parseNum(v.value != null ? v.value : v.name);
    if (val == null) return null;
    let unit = String(v.unitText || v.unitCode || "").toLowerCase();
    if (unit === "in" || unit === "inch" || unit === "inr") unit = "in";
    if (unit === "mm" || unit === "mmt") unit = "mm";
    if (unit === "cm" || unit === "cmt") unit = "cm";
    if (unit === "ft" || unit === "fto" || unit === "ftu") unit = "ft";
    return convert(val, unit || "in");
  }
  if (typeof v === "number") return round1(v);
  const m = String(v).match(
    /(\d+(?:\.\d+)?(?:\s+\d+\s*\/\s*\d+)?)\s*(mm|cm|in|inch|inches|ft|feet|"|″)?/i
  );
  if (!m) return null;
  return convert(parseNum(m[1]), m[2] || "in");
}

function deEnt(s) {
  if (s == null) return null;
  return String(s)
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;|&apos;/g, "'")
    .replace(/&#x27;/gi, "'")
    .replace(/\s+/g, " ")
    .trim();
}

// ---- meta tag fallbacks (og:, product:, twitter:) ----
function metaContent(html, keys) {
  const tags = html.match(/<meta\b[^>]*>/gi) || [];
  for (const tag of tags) {
    const prop =
      (tag.match(/(?:property|name)\s*=\s*"([^"]+)"/i) ||
        tag.match(/(?:property|name)\s*=\s*'([^']+)'/i) ||
        [])[1] || "";
    if (!keys.includes(prop.toLowerCase())) continue;
    const content =
      (tag.match(/content\s*=\s*"([^"]*)"/i) ||
        tag.match(/content\s*=\s*'([^']*)'/i) ||
        [])[1];
    if (content) return deEnt(content);
  }
  return null;
}

// ---- JSON-LD Product extraction ----
function findProducts(node, out) {
  if (!node || typeof node !== "object") return;
  if (Array.isArray(node)) {
    for (const item of node) findProducts(item, out);
    return;
  }
  const type = node["@type"];
  const types = Array.isArray(type) ? type : [type];
  if (types.some((t) => String(t || "").toLowerCase() === "product")) out.push(node);
  for (const key of ["@graph", "mainEntity", "itemListElement", "item"]) {
    if (node[key]) findProducts(node[key], out);
  }
}

function fromJsonLd(html) {
  const result = { name: null, brand: null, price: null, image: null, wIn: null, dIn: null, hIn: null };
  const blocks =
    html.match(/<script\b[^>]*type\s*=\s*["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi) || [];
  const products = [];
  for (const block of blocks) {
    const jsonText = block
      .replace(/<script\b[^>]*>/i, "")
      .replace(/<\/script>\s*$/i, "");
    try {
      findProducts(JSON.parse(jsonText), products);
    } catch {
      /* malformed JSON-LD — skip */
    }
  }
  const p = products[0];
  if (!p) return result;

  if (p.name) result.name = deEnt(p.name);
  if (p.brand) {
    result.brand =
      typeof p.brand === "string" ? deEnt(p.brand) : deEnt(p.brand.name || null);
  }
  const offers = Array.isArray(p.offers) ? p.offers[0] : p.offers;
  if (offers && typeof offers === "object") {
    const price = parseNum(offers.price != null ? offers.price : offers.lowPrice);
    if (price != null) result.price = price;
  }
  const img = Array.isArray(p.image) ? p.image[0] : p.image;
  if (img) result.image = typeof img === "string" ? img : img.url || null;

  result.wIn = toInches(p.width);
  result.dIn = toInches(p.depth);
  result.hIn = toInches(p.height);

  if (Array.isArray(p.additionalProperty)) {
    for (const prop of p.additionalProperty) {
      if (!prop || typeof prop !== "object") continue;
      const pname = String(prop.name || "").toLowerCase();
      const val = toInches(prop.value);
      if (val == null) continue;
      if (result.wIn == null && /width/.test(pname)) result.wIn = val;
      else if (result.dIn == null && /depth/.test(pname)) result.dIn = val;
      else if (result.hIn == null && /height/.test(pname)) result.hIn = val;
    }
  }
  return result;
}

// ---- dimension heuristics over visible text ----
const NUM = "(\\d+(?:\\.\\d+)?(?:\\s+\\d+\\s*\\/\\s*\\d+)?)";
const UNIT = "(mm|cm|in|inch|inches|\"|″)";

function labelDim(text, label) {
  const re = new RegExp(
    "(?:overall\\s+|product\\s+|assembled\\s+)?" +
      label +
      "\\s*(?:\\([^)]*\\))?\\s*[:\\-]?\\s*" +
      NUM +
      "\\s*" +
      UNIT,
    "i"
  );
  const m = text.match(re);
  if (!m) return null;
  return convert(parseNum(m[1]), m[2]);
}

function textDims(html) {
  const text = html
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/\s+/g, " ");
  const dims = { wIn: null, dIn: null, hIn: null };

  // "35.5"W × 24"D × 33.5"H" (and WxD-only) combos
  const combo3 = text.match(
    new RegExp(
      NUM + "\\s*(?:in|\"|″)?\\s*W\\s*[×x]\\s*" +
      NUM + "\\s*(?:in|\"|″)?\\s*D\\s*[×x]\\s*" +
      NUM + "\\s*(?:in|\"|″)?\\s*H",
      "i"
    )
  );
  if (combo3) {
    dims.wIn = round1(parseNum(combo3[1]));
    dims.dIn = round1(parseNum(combo3[2]));
    dims.hIn = round1(parseNum(combo3[3]));
    return dims;
  }
  const combo2 = text.match(
    new RegExp(
      NUM + "\\s*(?:in|\"|″)?\\s*W\\s*[×x]\\s*" + NUM + "\\s*(?:in|\"|″)?\\s*D",
      "i"
    )
  );
  if (combo2) {
    dims.wIn = round1(parseNum(combo2[1]));
    dims.dIn = round1(parseNum(combo2[2]));
  }

  // 'Width: 36"' / "Depth 24 in" / "Height: 914 mm" style labels
  if (dims.wIn == null) dims.wIn = labelDim(text, "width");
  if (dims.dIn == null) dims.dIn = labelDim(text, "depth");
  if (dims.hIn == null) dims.hIn = labelDim(text, "height");
  return dims;
}

// ---- fetch with size cap ----
async function fetchCapped(url) {
  const res = await fetch(url, {
    headers: {
      "User-Agent": UA,
      Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      "Accept-Language": "en-US,en;q=0.9",
    },
    redirect: "follow",
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) throw new Error("page returned " + res.status);
  if (!res.body) return await res.text();
  const reader = res.body.getReader();
  const chunks = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > MAX_BYTES) {
      chunks.push(value.subarray(0, value.length - (total - MAX_BYTES)));
      try { await reader.cancel(); } catch { /* already capped */ }
      break;
    }
    chunks.push(value);
  }
  const buf = new Uint8Array(chunks.reduce((a, c) => a + c.length, 0));
  let off = 0;
  for (const c of chunks) { buf.set(c, off); off += c.length; }
  return new TextDecoder("utf-8", { fatal: false }).decode(buf);
}

export default async (req) => {
  const target = new URL(req.url).searchParams.get("url");
  if (!target) {
    return Response.json({ ok: false, error: "Missing url parameter." }, { status: 400 });
  }
  let parsed;
  try {
    parsed = new URL(target);
  } catch {
    return Response.json({ ok: false, error: "That link doesn't look valid." }, { status: 400 });
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return Response.json({ ok: false, error: "Only http(s) links can be looked up." }, { status: 400 });
  }

  let html;
  try {
    html = await fetchCapped(parsed.toString());
  } catch (e) {
    return Response.json({
      ok: false,
      error: "Couldn't fetch that page (" + (e && e.message ? e.message : "network error") + ").",
    });
  }

  const ld = fromJsonLd(html);
  const dims = textDims(html);
  const ogPrice = metaContent(html, ["product:price:amount", "og:price:amount", "product:pretax_price:amount"]);

  return Response.json({
    ok: true,
    name: ld.name || metaContent(html, ["og:title", "twitter:title"]),
    brand: ld.brand,
    price: ld.price != null ? ld.price : ogPrice != null ? parseNum(ogPrice) : null,
    image: ld.image || metaContent(html, ["og:image", "twitter:image"]),
    wIn: ld.wIn != null ? ld.wIn : dims.wIn,
    dIn: ld.dIn != null ? ld.dIn : dims.dIn,
    hIn: ld.hIn != null ? ld.hIn : dims.hIn,
  });
};
