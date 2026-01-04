import express from "express";
import fetch from "node-fetch";
import path from "path";
import { fileURLToPath } from "url";

const app = express();
app.use(express.json());

/* ================== PATH ================== */
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PUBLIC_DIR = path.resolve(__dirname, "../public");

/* ================== CONFIG ================== */
const PORT = 5050;
const BASE_URL = "https://www.nahdionline.com";
const USER = "mhmdyxt";
const PASS = "uknownothing";
const MAX_RESULTS = 50;

/* ================== ALGOLIA (CONFIRMED) ================== */
const ALGOLIA_APP_ID = "H9X4IH7M99";
const ALGOLIA_API_KEY = "2bbce1340a1cab2ccebe0307b1310881";
const ALGOLIA_AGENT =
  "Algolia for JavaScript (4.23.3); Browser (lite); autocomplete-core (1.9.2); autocomplete-js (1.9.2)";

const PRODUCT_INDICES = ["prod_en_products", "prod_ar_products"];

/* ================== HELPERS ================== */
function normalize(s = "") {
  return s
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s\*\?_-]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}
function containsArabic(s = "") {
  return /[\u0600-\u06FF]/.test(s);
}
const AR_BRAND_MAP = {
  "بيوديرما": "bioderma",
  "فيشي": "vichy",
  "سيرافي": "cerave",
  "لاروش": "laroche",
  "لا روش": "laroche",
  "يورياج": "uriage",
  "افين": "avene",
  "نيفيا": "nivea"
};
function applyArabicAliases(raw = "") {
  let out = raw;
  for (const [ar, en] of Object.entries(AR_BRAND_MAP)) {
    out = out.replace(new RegExp(ar, "g"), en);
  }
  return out;
}
function escapeRegExp(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
function wildcardToRegexParts(query) {
  const tokens = normalize(query).split(" ").filter(Boolean);
  return tokens.map((t) => {
    const re = escapeRegExp(t).replace(/\\\*/g, ".*").replace(/\\\?/g, ".");
    return new RegExp(re, "i");
  });
}
function toAlgoliaAndQuery(raw) {
  const tokens = normalize(raw).split(" ").filter(Boolean);
  const cleaned = tokens.map((t) => t.replace(/[*?]/g, ""));
  const usable = cleaned.filter(Boolean);
  if (!usable.length) return raw;
  return usable.map((t) => `+${t}`).join(" ");
}
function strictFilter(rawQuery, items) {
  const regs = wildcardToRegexParts(rawQuery);
  return items.filter((p) => {
    const title = p.title || "";
    for (const rg of regs) if (!rg.test(title)) return false;
    return true;
  });
}
function dedupe(items, limit = MAX_RESULTS) {
  const seen = new Set();
  const out = [];
  for (const it of items) {
    const key = `${it.title}||${it.url}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(it);
    if (out.length >= limit) break;
  }
  return out;
}

/* ================== "AI" Lines (Bioderma) ================== */
const BIODERMA_LINE_AI = {
  atoderm: "Dry/Atopic skin • ترطيب قوي وتهدئة الحكة",
  sensibio: "Sensitive skin • للبشرة الحساسة والاحمرار",
  sebium: "Oily/Acne • للبشرة الدهنية وحب الشباب",
  photoderm: "Sun protection • واقي شمس وحماية UV",
  hydrabio: "Dehydrated • ترطيب عميق للجفاف المائي",
  cicabio: "Repair • ترميم وتهدئة بعد التهيّج",
  abcderm: "Baby/Kids • للأطفال والرضّع",
  node: "Scalp/Hair • للشعر وفروة الرأس"
};
function smartLineInfo(brand, line) {
  if (brand === "bioderma") {
    const k = (line || "").toLowerCase();
    return BIODERMA_LINE_AI[k] || "Line products • مجموعة منتجات";
  }
  return "Line products • مجموعة منتجات";
}
function groupLinesWithAI(rawQuery, results) {
  const q = normalize(rawQuery);
  const brand = q.split(" ")[0];
  if (!brand || brand.length < 3) return [];

  const map = {};
  for (const r of results) {
    const t = normalize(r.title);
    if (!t.includes(brand)) continue;
    const parts = t.split(" ").filter(Boolean);
    const idx = parts.indexOf(brand);
    const line = parts[idx + 1] || "other";
    map[line] = (map[line] || 0) + 1;
  }

  return Object.entries(map)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 12)
    .map(([line, count]) => ({ line, count, info: smartLineInfo(brand, line) }));
}

/* ================== URL CLEAN ================== */
function cleanNahdiUrl(url) {
  if (!url) return "";
  let u = String(url).trim();

  // force main domain
  u = u.replace(/^https?:\/\/ecombe\.nahdionline\.com/i, "https://www.nahdionline.com");
  u = u.replace(/^https?:\/\/ecom\.nahdionline\.com/i, "https://www.nahdionline.com");

  // remove hash
  u = u.split("#")[0];

  // fix double locale: /en-sa/en/ -> /en-sa/
  u = u.replace("/en-sa/en/", "/en-sa/");
  u = u.replace("/en-sa/ar/", "/en-sa/");
  u = u.replace("/ar-sa/en/", "/ar-sa/");
  u = u.replace("/ar-sa/ar/", "/ar-sa/");

  // normalize locale
  u = u.replace("/en/", "/en-sa/");
  u = u.replace("/ar/", "/ar-sa/");

  // remove duplicate slashes
  u = u.replace(/\/{2,}/g, "/");
  u = u.replace("https:/", "https://");

  return u;
}
function extractSkuFromUrl(url) {
  const u = cleanNahdiUrl(url || "");
  const m = u.match(/\/pdp\/(\d{6,})/i);
  return m ? m[1] : "";
}
function pickSku(hit) {
  const candidates = [
    hit?.sku,
    hit?.SKU,
    hit?.productSku,
    hit?.product_sku,
    hit?.product_id,
    hit?.productId,
    hit?.magento_id,
    hit?.id,
    hit?.objectID
  ]
    .map((x) => (x == null ? "" : String(x)))
    .filter(Boolean);

  const numeric = candidates.find((c) => /^\d{6,}$/.test(c));
  if (numeric) return numeric;

  const urlish = hit?.url || hit?.pdpUrl || hit?.link || "";
  const fromUrl = extractSkuFromUrl(urlish);
  if (fromUrl) return fromUrl;

  const obj = String(hit?.objectID || "");
  if (/^\d{6,}$/.test(obj)) return obj;

  return "";
}
function pickSlug(hit) {
  return (
    hit?.slug ||
    hit?.url_key ||
    hit?.urlKey ||
    hit?.product_url_key ||
    hit?.productUrlKey ||
    ""
  );
}
function canonicalPdpUrl(slug, sku) {
  if (!slug || !sku) return "";
  const s = String(slug).replace(/^\/+/, "");
  return `${BASE_URL}/en-sa/${s}/pdp/${sku}`;
}
function pickTitle(hit) {
  return hit?.name || hit?.title || hit?.productName || hit?.shortName || "";
}
function pickImage(hit) {
  return (
    hit?.image ||
    hit?.imageUrl ||
    hit?.thumbnail ||
    hit?.thumbnailUrl ||
    (Array.isArray(hit?.images) ? hit.images[0] : "") ||
    ""
  );
}

/* ================== SKU Resolver from product page ================== */
const SKU_CACHE = new Map(); // slug -> sku
async function resolveSkuFromProductPage(slug) {
  if (!slug) return "";
  const key = slug.toLowerCase();
  if (SKU_CACHE.has(key)) return SKU_CACHE.get(key);

  const pageUrl = `${BASE_URL}/en-sa/${slug}`;
  try {
    const r = await fetch(pageUrl, {
      headers: {
        "User-Agent": "Mozilla/5.0",
        "Accept": "text/html,application/xhtml+xml"
      }
    });

    const html = await r.text();

    const m =
      html.match(/"sku"\s*:\s*"(\d{6,})"/i) ||
      html.match(/"productSku"\s*:\s*"(\d{6,})"/i) ||
      html.match(/"product_sku"\s*:\s*"(\d{6,})"/i) ||
      html.match(/"code"\s*:\s*"(\d{6,})"/i) ||
      html.match(/"id"\s*:\s*"(\d{6,})"/i) ||
      html.match(/\/pdp\/(\d{6,})/i);

    const sku = m ? m[1] : "";
    if (sku) SKU_CACHE.set(key, sku);
    return sku;
  } catch {
    return "";
  }
}

function pickFinalUrl(hit) {
  const direct = hit?.url || hit?.pdpUrl || hit?.link || "";
  const cleaned = cleanNahdiUrl(direct);

  // sku from fields or from url
  const sku = pickSku(hit) || extractSkuFromUrl(cleaned);

  // slug from fields
  let slug = pickSlug(hit);

  // derive slug from url if missing
  if (!slug && cleaned) {
    const parts = cleaned.split("?")[0].split("/").filter(Boolean);
    const idx = parts.indexOf("en-sa");
    if (idx !== -1 && parts[idx + 1]) slug = parts[idx + 1];
  }

  // remove leftovers like "en" prefix
  slug = String(slug || "").replace(/^en-sa\//, "").replace(/^en\//, "").replace(/^ar\//, "").replace(/^\/+/, "");

  // if we already have sku, return canonical pdp immediately
  if (slug && sku) return canonicalPdpUrl(slug, sku);

  // else return slug-only (we will resolve sku from page)
  if (slug) return `${BASE_URL}/en-sa/${slug}`;

  return "";
}

/* ================== ALGOLIA CALL ================== */
async function algoliaMultiQuery(requests) {
  const url =
    `https://${ALGOLIA_APP_ID}-dsn.algolia.net/1/indexes/*/queries` +
    `?x-algolia-agent=${encodeURIComponent(ALGOLIA_AGENT)}` +
    `&x-algolia-api-key=${ALGOLIA_API_KEY}` +
    `&x-algolia-application-id=${ALGOLIA_APP_ID}`;

  const r = await fetch(url, {
    method: "POST",
    headers: {
      accept: "*/*",
      "content-type": "application/x-www-form-urlencoded",
      Referer: BASE_URL
    },
    body: JSON.stringify({ requests })
  });

  const text = await r.text();
  if (!r.ok) throw new Error(`Algolia HTTP ${r.status}: ${text.slice(0, 240)}`);
  return JSON.parse(text);
}

/* ================== ROUTES ================== */
app.post("/api/login", (req, res) => {
  const { username, password } = req.body || {};
  res.json({ ok: username === USER && password === PASS });
});

app.get("/api/search", async (req, res) => {
  const rawOriginal = (req.query.q || "").toString().trim();
  if (!rawOriginal || rawOriginal.length < 2) {
    return res.json({ ok: true, results: [], groups: [], count: 0 });
  }

  // Arabic brand aliases → english for search
  const rawForSearch = applyArabicAliases(rawOriginal);
  const filterQuery = containsArabic(rawOriginal) ? rawForSearch : rawOriginal;

  // direct pdp
  if (rawOriginal.startsWith("http") && rawOriginal.includes("/pdp/")) {
    return res.json({
      ok: true,
      results: [{ title: "Open product page", url: cleanNahdiUrl(rawOriginal), image: "" }],
      groups: [],
      count: 1
    });
  }

  try {
    const andQuery = toAlgoliaAndQuery(rawForSearch);

    const requests = PRODUCT_INDICES.map((idx) => ({
      indexName: idx,
      query: andQuery,
      params: new URLSearchParams({
        hitsPerPage: "350",
        typoTolerance: "true",
        removeStopWords: "true",
        queryType: "prefixAll",
        advancedSyntax: "true"
      }).toString()
    }));

    const data = await algoliaMultiQuery(requests);

    let hitsAll = [];
    for (const r of data?.results || []) {
      if (Array.isArray(r?.hits) && r.hits.length) hitsAll = hitsAll.concat(r.hits);
    }

    // Map hits
    let mapped = hitsAll
      .map((h) => {
        const title = pickTitle(h);
        const image = pickImage(h);
        const url = cleanNahdiUrl(pickFinalUrl(h)); // could be slug-only
        let slug = "";

        if (url && !url.includes("/pdp/")) {
          const parts = url.split("?")[0].split("/").filter(Boolean);
          const idx = parts.indexOf("en-sa");
          if (idx !== -1 && parts[idx + 1]) slug = parts[idx + 1];
        }
        return { title, image, url, slug };
      })
      .filter((x) => x.title && (x.url || x.slug));

    // Apply strict wildcard/AND filter on titles
    const filtered = strictFilter(filterQuery, mapped);

    // Resolve missing SKU by fetching product page (slug)
    for (const item of filtered) {
      if (item.url && item.url.includes("/pdp/")) continue;

      let slug = item.slug;
      if (!slug && item.url) {
        const parts = item.url.split("?")[0].split("/").filter(Boolean);
        const idx = parts.indexOf("en-sa");
        if (idx !== -1 && parts[idx + 1]) slug = parts[idx + 1];
      }
      if (!slug) continue;

      const sku = await resolveSkuFromProductPage(slug);
      if (sku) item.url = canonicalPdpUrl(slug, sku);
    }

    // Keep only valid PDP links to avoid 404
    const fixed = filtered.filter((x) => x.url && x.url.includes("/pdp/"));

    const out = dedupe(
      fixed.map(({ title, image, url }) => ({ title, image, url })),
      MAX_RESULTS
    );

    const groups = groupLinesWithAI(filterQuery, out);

    res.json({ ok: true, results: out, groups, count: out.length });
  } catch (e) {
    res.json({ ok: false, message: String(e.message || e), results: [], groups: [], count: 0 });
  }
});

app.use(express.static(PUBLIC_DIR));
app.listen(PORT, () => console.log(`✅ Running http://localhost:${PORT}`));
