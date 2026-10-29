
const { firefox } = require("playwright");
const fs = require("node:fs/promises");
const crypto = require("node:crypto");
const path = require("node:path");

// ==================================================
// CONFIG
// ==================================================

const CONFIG = {
  city: "Shiraz",
  country: "Iran",

  category: "مشاور املاک",
  cityFa: "شیراز",

  zoom: 15,
  limit: 30,
  cellOverlap: 0.6,
  searchInBound: false,

  warmupMs: 5000,
  debug: true,

  variants: [
    "مشاور املاک",
    "آژانس املاک"
  ],

  boundary: {
    requiredType: "administrative",

    nameMatches: [
      "Shiraz",
      "شیراز"
    ],

    preferredNames: [
      "Shiraz",
      "شیراز"
    ],

    allowedGeometryTypes: [
      "Polygon",
      "MultiPolygon"
    ],

    resultLimit: 10
  },

  cellSizeMeters: 1200,

  maxResultsPerSearch: 60,
  maxUnchangedScrolls: 5,

  scrollDelayMs: 1400,
  detailDelayMs: 1000,
  searchDelayMs: 1800,

  headless: false,

  userAgent:
    "BusinessResearch/1.0 (contact: YOUR_REAL_EMAIL)"
};

// ==================================================
// OUTPUT DIRECTORY AND FILES
// ==================================================

const OUTPUT_DIR = path.join(__dirname, "output");

const FILES = {
  boundary: path.join(OUTPUT_DIR, "city-boundary.json"),
  output: path.join(OUTPUT_DIR, "businesses.json"),
  contacts: path.join(OUTPUT_DIR, "contacts.json"),
  progress: path.join(OUTPUT_DIR, "progress.json"),
  debug: path.join(OUTPUT_DIR, "neshan-last-response.txt")
};

const sleep = (ms) =>
  new Promise((resolve) => setTimeout(resolve, ms));

// ==================================================
// FILE HELPERS
// ==================================================

async function readJson(file, fallback) {
  try {
    return JSON.parse(await fs.readFile(file, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return fallback;
    throw error;
  }
}

async function saveJson(file, data) {
  await fs.mkdir(path.dirname(file), {
    recursive: true
  });

  const temp = `${file}.tmp`;

  await fs.writeFile(
    temp,
    JSON.stringify(data, null, 2),
    "utf8"
  );

  await fs.rename(temp, file);
}

function norm(value) {
  return String(value ?? "")
    .replace(/\s+/g, " ")
    .trim();
}

function toEnDigits(value) {
  return String(value ?? "")
    .replace(/[۰-۹]/g, (d) =>
      "۰۱۲۳۴۵۶۷۸۹".indexOf(d)
    )
    .replace(/[٠-٩]/g, (d) =>
      "٠١٢٣٤٥٦٧٨٩".indexOf(d)
    );
}

// ==================================================
// DUPLICATE DETECTION
// ==================================================

function normalizeName(value) {
  return norm(value)
    .replace(/[يى]/g, "ی")
    .replace(/ك/g, "ک")
    .replace(/\u200c/g, " ")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function normalizePhone(value) {
  let phone = toEnDigits(value)
    .replace(/[^\d+]/g, "");

  if (phone.startsWith("+98")) {
    phone = "0" + phone.slice(3);
  } else if (phone.startsWith("0098")) {
    phone = "0" + phone.slice(4);
  }

  return phone;
}

function businessKeys(item) {
  const keys = [];

  const id = norm(item.neshanId);
  const name = normalizeName(item.name);
  const phone = normalizePhone(item.phone);
  const address = normalizeName(item.address);

  if (id) {
    keys.push(`id:${id}`);
  }

  if (name && phone) {
    keys.push(`name-phone:${name}|${phone}`);
  }

  // Only use name + address when no phone is available.
  if (name && address && !phone) {
    keys.push(`name-address:${name}|${address}`);
  }

  return keys;
}

function buildBusinessIndex(businesses) {
  const index = new Map();

  function indexBusiness(item) {
    for (const key of businessKeys(item)) {
      if (!index.has(key)) {
        index.set(key, item);
      }
    }
  }

  function findDuplicate(record) {
    for (const key of businessKeys(record)) {
      const existing = index.get(key);
      if (existing) return existing;
    }

    return null;
  }

  function mergeBusiness(previous, record) {
    // Keep the existing name unless it is missing.
    if (!previous.name && record.name) {
      previous.name = record.name;
    }

    if (!previous.phone && record.phone) {
      previous.phone = record.phone;
    }

    if (!previous.address && record.address) {
      previous.address = record.address;
    }

    if (!previous.category && record.category) {
      previous.category = record.category;
    }

    if (!previous.neshanId && record.neshanId) {
      previous.neshanId = record.neshanId;
    }

    if (!previous.crowdId && record.crowdId) {
      previous.crowdId = record.crowdId;
    }

    if (
      !Number.isFinite(previous.latitude) ||
      !Number.isFinite(previous.longitude)
    ) {
      previous.latitude = record.latitude;
      previous.longitude = record.longitude;
    }

    previous.phones = [
      ...new Set(
        [
          ...(previous.phones || []),
          ...(record.phones || [])
        ]
          .map(normalizePhone)
          .filter(Boolean)
      )
    ];

    if (!previous.phone && previous.phones.length) {
      previous.phone = previous.phones[0];
    }

    previous.lastCheckedAt = record.lastCheckedAt;

    // Register any newly acquired keys.
    indexBusiness(previous);
  }

  for (const item of businesses) {
    indexBusiness(item);
  }

  return {
    index,
    indexBusiness,
    findDuplicate,
    mergeBusiness
  };
}

// ==================================================
// GEOJSON VALIDATION
// ==================================================

function isValidGeometry(geometry) {
  if (
    !geometry ||
    !Array.isArray(geometry.coordinates)
  ) {
    return false;
  }

  if (
    !["Polygon", "MultiPolygon"].includes(
      geometry.type
    )
  ) {
    return false;
  }

  const polygons =
    geometry.type === "Polygon"
      ? [geometry.coordinates]
      : geometry.coordinates;

  if (!polygons.length) return false;

  return polygons.every(
    (polygon) =>
      Array.isArray(polygon) &&
      polygon.length > 0 &&
      polygon.every(
        (ring) =>
          Array.isArray(ring) &&
          ring.length >= 4 &&
          ring.every(
            (point) =>
              Array.isArray(point) &&
              Number.isFinite(point[0]) &&
              Number.isFinite(point[1]) &&
              point[0] >= -180 &&
              point[0] <= 180 &&
              point[1] >= -90 &&
              point[1] <= 90
          )
      )
  );
}

// ==================================================
// GET CITY BOUNDARY
// ==================================================

async function getCityBoundary() {
  const cached = await readJson(
    FILES.boundary,
    null
  );

  if (
    cached &&
    cached.city === CONFIG.city &&
    cached.country === CONFIG.country &&
    isValidGeometry(cached.geometry)
  ) {
    console.log(
      "Using cached boundary:",
      cached.name
    );

    return cached;
  }

  const query = encodeURIComponent(
    `${CONFIG.city}, ${CONFIG.country}`
  );

  const url =
    "https://nominatim.openstreetmap.org/search" +
    `?q=${query}` +
    "&format=jsonv2" +
    "&polygon_geojson=1" +
    `&limit=${CONFIG.boundary.resultLimit}`;

  console.log(
    `Requesting boundary for ${CONFIG.city}, ${CONFIG.country}...`
  );

  let response;

  try {
    response = await fetch(url, {
      headers: {
        "User-Agent": CONFIG.userAgent,
        Accept: "application/json"
      },
      signal: AbortSignal.timeout(30000)
    });
  } catch (error) {
    throw new Error(
      `Nominatim connection failed: ${error.message}`
    );
  }

  if (!response.ok) {
    throw new Error(
      `Nominatim HTTP ${response.status}. ` +
      "Try again later or provide a valid GeoJSON boundary."
    );
  }

  const results = await response.json();

  console.log(
    "Nominatim results:",
    JSON.stringify(
      results.map((item) => ({
        name: item.display_name,
        class: item.class,
        type: item.type,
        geometryType: item.geojson?.type
      })),
      null,
      2
    )
  );

  const boundaryConfig = CONFIG.boundary;

  const candidates = results.filter((item) => {
    const name = norm(
      item.display_name
    ).toLowerCase();

    const matchesName =
      boundaryConfig.nameMatches.some((term) =>
        name.includes(term.toLowerCase())
      );

    const matchesType =
      item.type === boundaryConfig.requiredType;

    const matchesGeometry =
      boundaryConfig.allowedGeometryTypes.includes(
        item.geojson?.type
      ) &&
      isValidGeometry(item.geojson);

    return (
      matchesName &&
      matchesType &&
      matchesGeometry
    );
  });

  const boundary =
    candidates.find((item) => {
      const name = norm(
        item.display_name
      ).toLowerCase();

      return boundaryConfig.preferredNames.some(
        (term) => name.startsWith(term.toLowerCase())
      );
    }) || candidates[0];

  if (!boundary) {
    throw new Error(
      `No suitable boundary found for ${CONFIG.city}. ` +
      "Check CONFIG.boundary or provide a valid GeoJSON boundary."
    );
  }

  const result = {
    city: CONFIG.city,
    country: CONFIG.country,
    name: boundary.display_name,
    osmType: boundary.osm_type,
    osmId: boundary.osm_id,
    geometry: boundary.geojson,
    attribution: "© OpenStreetMap contributors"
  };

  await saveJson(FILES.boundary, result);

  console.log("Boundary saved:", result.name);
  console.log("Boundary file:", FILES.boundary);

  return result;
}

// ==================================================
// POINT-IN-POLYGON
// ==================================================

function pointInRing(lon, lat, ring) {
  let inside = false;

  for (
    let i = 0, j = ring.length - 1;
    i < ring.length;
    j = i++
  ) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];

    const crosses =
      (yi > lat) !== (yj > lat) &&
      lon <
        ((xj - xi) * (lat - yi)) /
          (yj - yi) +
          xi;

    if (crosses) inside = !inside;
  }

  return inside;
}

function pointInPolygon(lon, lat, polygon) {
  if (
    !polygon?.length ||
    !pointInRing(lon, lat, polygon[0])
  ) {
    return false;
  }

  for (let i = 1; i < polygon.length; i++) {
    if (pointInRing(lon, lat, polygon[i])) {
      return false;
    }
  }

  return true;
}

function pointInGeometry(lon, lat, geometry) {
  if (geometry.type === "Polygon") {
    return pointInPolygon(
      lon,
      lat,
      geometry.coordinates
    );
  }

  if (geometry.type === "MultiPolygon") {
    return geometry.coordinates.some(
      (polygon) =>
        pointInPolygon(lon, lat, polygon)
    );
  }

  return false;
}

// ==================================================
// BUILD GRID
// ==================================================

function buildGrid(geometry) {
  if (!isValidGeometry(geometry)) {
    throw new Error(
      "Invalid city boundary geometry."
    );
  }

  const polygons =
    geometry.type === "Polygon"
      ? [geometry.coordinates]
      : geometry.coordinates;

  const allPoints = polygons.flat(2);

  const longitudes = allPoints.map((p) => p[0]);
  const latitudes = allPoints.map((p) => p[1]);

  const minLon = Math.min(...longitudes);
  const maxLon = Math.max(...longitudes);
  const minLat = Math.min(...latitudes);
  const maxLat = Math.max(...latitudes);

  const centerLat = (minLat + maxLat) / 2;

  const latStep =
    CONFIG.cellSizeMeters / 111320;

  const lonStep =
    CONFIG.cellSizeMeters /
    (
      111320 *
      Math.max(
        0.1,
        Math.cos(
          (centerLat * Math.PI) / 180
        )
      )
    );

  const points = [];
  let row = 0;

  for (
    let lat = minLat + latStep / 2;
    lat < maxLat;
    lat += latStep
  ) {
    let col = 0;

    for (
      let lon = minLon + lonStep / 2;
      lon < maxLon;
      lon += lonStep
    ) {
      if (
        pointInGeometry(lon, lat, geometry)
      ) {
        points.push({
          id: `r${row}-c${col}`,
          latitude: Number(lat.toFixed(6)),
          longitude: Number(lon.toFixed(6))
        });
      }

      col++;
    }

    row++;
  }

  return points;
}

// ==================================================
// DECODE NESHAN SEARCH RESPONSE
// ==================================================

function readObjectEnd(text, start) {
  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let i = start; i < text.length; i++) {
    const c = text[i];

    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (c === "\\") {
        escaped = true;
      } else if (c === '"') {
        inString = false;
      }

      continue;
    }

    if (c === '"') {
      inString = true;
    } else if (c === "{") {
      depth++;
    } else if (c === "}") {
      depth--;

      if (depth === 0) {
        return i + 1;
      }
    }
  }

  return -1;
}

function decodeNeshanText(raw) {
  const match = String(raw).match(
    /^[A-Za-z0-9+/]+/
  );

  if (!match) return "";

  const payload = match[0];

  let best = {
    score: -1,
    text: ""
  };

  for (let offset = 0; offset < 64; offset++) {
    const part = payload.slice(offset);

    const aligned = part.slice(
      0,
      part.length - (part.length % 4)
    );

    const text = Buffer.from(
      aligned,
      "base64"
    ).toString("utf8");

    const score = (
      text.match(/"crowdId"/g) || []
    ).length;

    if (score > best.score) {
      best = { score, text };
    }
  }

  return best.text;
}

function phonesOf(item) {
  const phones = [];

  for (const action of item.actions || []) {
    if (action.type !== "CALL") continue;

    try {
      const meta = JSON.parse(
        action.metaData
      );

      if (meta.phone) {
        phones.push(
          normalizePhone(meta.phone)
        );
      }
    } catch {
      // Ignore invalid action metadata.
    }
  }

  return [...new Set(phones.filter(Boolean))];
}

function decodeNeshanSearch(raw) {
  const text = decodeNeshanText(raw);
  const marker = '{"id":"';

  const items = [];
  const incomplete = [];

  let firstStart = -1;
  let pos = 0;

  while (true) {
    const start = text.indexOf(
      marker,
      pos
    );

    if (start < 0) break;

    pos = start + 1;

    const end = readObjectEnd(
      text,
      start
    );

    let parsed = null;

    if (end > 0) {
      try {
        parsed = JSON.parse(
          text.slice(start, end)
        );
      } catch {
        // The response may contain a partial object.
      }
    }

    if (parsed && parsed.title) {
      if (firstStart < 0) {
        firstStart = start;
      }

      items.push(parsed);
      pos = end;
    } else if (
      /^.{0,200}"title"/s.test(
        text.slice(start, start + 260)
      )
    ) {
      incomplete.push(
        text.slice(start)
      );
    }
  }

  // Attempt to reconstruct a rotated final object.
  if (
    incomplete.length &&
    firstStart > 0
  ) {
    const tail =
      incomplete[incomplete.length - 1];

    const head = text.slice(
      0,
      firstStart
    );

    const quotes = [];

    for (
      let i = 0;
      i < Math.min(head.length, 80);
      i++
    ) {
      if (head[i] === '"') {
        quotes.push(i);
      }
    }

    let rebuilt = null;

    outer: for (const q of quotes) {
      for (const glue of [
        'i":',
        '":',
        ":",
        ""
      ]) {
        const candidate =
          tail + glue + head.slice(q);

        const end = readObjectEnd(
          candidate,
          0
        );

        if (end < 0) continue;

        try {
          const parsed = JSON.parse(
            candidate.slice(0, end)
          );

          if (parsed.title) {
            rebuilt = parsed;
            break outer;
          }
        } catch {
          // Try the next reconstruction candidate.
        }
      }
    }

    if (rebuilt) {
      items.push(rebuilt);
    } else {
      console.warn(
        "Warning: rotated item could not be reconstructed."
      );
    }
  }

  // Avoid duplicate items inside the same response.
  const seen = new Set();

  return items.filter((item) => {
    const key = item.id
      ? `id:${item.id}`
      : `${normalizeName(item.title)}|${normalizeName(item.subtitle)}`;

    if (seen.has(key)) return false;

    seen.add(key);
    return true;
  });
}

// ==================================================
// BUILD SEARCH URL
// ==================================================

function buildSearchUrl(term, point) {
  const latHalf =
    (
      CONFIG.cellSizeMeters *
      CONFIG.cellOverlap
    ) / 111320;

  const lonHalf =
    (
      CONFIG.cellSizeMeters *
      CONFIG.cellOverlap
    ) /
    (
      111320 *
      Math.cos(
        (point.latitude * Math.PI) / 180
      )
    );

  const west = point.longitude - lonHalf;
  const east = point.longitude + lonHalf;
  const south = point.latitude - latHalf;
  const north = point.latitude + latHalf;

  const body = {
    uuid: `web_${crypto.randomUUID()}`,
    term,
    zoom: CONFIG.zoom,
    limit: CONFIG.limit,
    filters: {},
    night: false,
    location: null,

    center: {
      x: point.longitude,
      y: point.latitude
    },

    boundary: {
      south_west: {
        x: west,
        y: south
      },

      south_east: {
        x: east,
        y: south
      },

      north_east: {
        x: east,
        y: north
      },

      north_west: {
        x: west,
        y: north
      }
    }
  };

  const encoded = Buffer.from(
    encodeURIComponent(
      JSON.stringify(body)
    ),
    "ascii"
  ).toString("base64");

  return (
    "https://neshan.org/maps/pwa-api/neshan-search" +
    `?body=${encodeURIComponent(encoded)}` +
    `&search-in-bound=${CONFIG.searchInBound}`
  );
}

// ==================================================
// FETCH SEARCH RESPONSE
// ==================================================

async function fetchSearch(page, url) {
  return page.evaluate(async (u) => {
    const response = await fetch(u, {
      credentials: "include"
    });

    return {
      status: response.status,
      text: await response.text()
    };
  }, url);
}

// ==================================================
// MAIN
// ==================================================

async function main() {
  await fs.mkdir(OUTPUT_DIR, {
    recursive: true
  });

  console.log(
    "=== neshan2.js ==="
  );

  console.log(
    `City: ${CONFIG.city}, ${CONFIG.country}`
  );

  console.log(
    `Category: ${CONFIG.category}`
  );

  console.log(
    "Output directory:",
    OUTPUT_DIR
  );

  const boundary = await getCityBoundary();

  const points = buildGrid(
    boundary.geometry
  );

  if (!points.length) {
    throw new Error(
      "No grid points were generated inside the city boundary."
    );
  }

  console.log(
    `Grid points: ${points.length}`
  );

  // Load previous businesses.
  const output = await readJson(
    FILES.output,
    { businesses: [] }
  );

  const businesses = Array.isArray(
    output.businesses
  )
    ? output.businesses
    : [];

  // Remove duplicates already present in the old output.
  const originalCount = businesses.length;

  const dedupe = buildBusinessIndex([]);

  const uniqueBusinesses = [];

  for (const item of businesses) {
    const previous = dedupe.findDuplicate(
      item
    );

    if (previous) {
      dedupe.mergeBusiness(
        previous,
        item
      );
    } else {
      uniqueBusinesses.push(item);
      dedupe.indexBusiness(item);
    }
  }

  businesses.splice(
    0,
    businesses.length,
    ...uniqueBusinesses
  );

  console.log(
    `Existing records: ${originalCount}; after deduplication: ${businesses.length}`
  );

  const businessIndex = buildBusinessIndex(
    businesses
  );

  const progress = await readJson(
    FILES.progress,
    {
      completed: [],
      failed: [],
      saturated: []
    }
  );

  progress.completed ||= [];
  progress.failed ||= [];
  progress.saturated ||= [];

  // Save both output files and progress.
  async function save() {
    const contacts = businesses
      .filter((b) => b.name)
      .map((b) => {
        const latitude =
          Number.isFinite(b.latitude)
            ? b.latitude
            : null;

        const longitude =
          Number.isFinite(b.longitude)
            ? b.longitude
            : null;

        const phones = [
          ...new Set(
            [
              ...(b.phones || []),
              b.phone
            ]
              .map(normalizePhone)
              .filter(Boolean)
          )
        ];

        return {
          name: b.name,
          phone: phones[0] || null,
          phones,

          location: {
            address: b.address || null,
            latitude,
            longitude,

            mapUrl:
              latitude !== null &&
              longitude !== null
                ? `https://neshan.org/maps/@${latitude},${longitude},17z`
                : null
          }
        };
      });

    await saveJson(
      FILES.output,
      {
        city: CONFIG.city,
        country: CONFIG.country,
        category: CONFIG.category,
        boundary: boundary.name,
        gridCellSizeMeters:
          CONFIG.cellSizeMeters,
        totalBusinesses:
          businesses.length,
        withPhone: businesses.filter(
          (b) => b.phone
        ).length,
        updatedAt:
          new Date().toISOString(),
        attribution:
          boundary.attribution,
        businesses
      }
    );

    await saveJson(
      FILES.contacts,
      contacts
    );

    await saveJson(
      FILES.progress,
      progress
    );
  }

  let browser;

  try {
    browser = await firefox.launch({
      headless: CONFIG.headless
    });

    const context = await browser.newContext({
      viewport: {
        width: 1365,
        height: 900
      },
      locale: "fa-IR"
    });

    const page = await context.newPage();

    await page.goto(
      "https://neshan.org/maps/",
      {
        waitUntil: "domcontentloaded",
        timeout: 60000
      }
    );

    await sleep(CONFIG.warmupMs);

    let debugSaved = false;

    for (const point of points) {
      for (const variant of CONFIG.variants) {
        const key = `${point.id}|${variant}`;

        if (
          progress.completed.includes(key)
        ) {
          continue;
        }

        console.log(
          `\nSearching: ${key}`
        );

        try {
          const response = await fetchSearch(
            page,
            buildSearchUrl(
              variant,
              point
            )
          );

          if (
            CONFIG.debug &&
            !debugSaved
          ) {
            debugSaved = true;

            await fs.writeFile(
              FILES.debug,
              response.text,
              "utf8"
            );
          }

          if (response.status !== 200) {
            throw new Error(
              `HTTP ${response.status}`
            );
          }

          const items = decodeNeshanSearch(
            response.text
          );

          if (
            !items.length &&
            response.text.length > 200
          ) {
            throw new Error(
              "Response received but decoding returned no results. " +
              "Check output/neshan-last-response.txt."
            );
          }

          if (!items.length) {
            console.warn(
              `No results for ${key} ` +
              `(HTTP ${response.status}, ${response.text.length} characters)`
            );
          }

          let added = 0;
          let merged = 0;

          for (const item of items) {
            const lon = item.location?.x;
            const lat = item.location?.y;

            if (
              !Number.isFinite(lon) ||
              !Number.isFinite(lat) ||
              !pointInGeometry(
                lon,
                lat,
                boundary.geometry
              )
            ) {
              continue;
            }

            const phones = phonesOf(item);

            const record = {
              name: norm(item.title),

              phone:
                phones[0] || null,

              phones,

              address:
                norm(item.subtitle) || null,

              category:
                item.typeTitle || null,

              latitude: lat,
              longitude: lon,

              neshanId:
                item.id || null,

              crowdId:
                item.crowdId || null,

              isAd:
                Boolean(item.isAd),

              gridCell: point.id,
              searchTerm: variant,
              source: "Neshan",

              lastCheckedAt:
                new Date().toISOString()
            };

            const previous =
              businessIndex.findDuplicate(
                record
              );

            if (previous) {
              businessIndex.mergeBusiness(
                previous,
                record
              );

              merged++;

              console.log(
                `Merged: ${record.name}`
              );
            } else {
              businesses.push(record);

              businessIndex.indexBusiness(
                record
              );

              added++;

              console.log(
                `Saved: ${record.name} | ` +
                `${record.phone || "No phone"}`
              );
            }
          }

          if (items.length >= CONFIG.limit) {
            console.warn(
              `Warning: ${key} reached the ` +
              `${CONFIG.limit}-result limit. ` +
              "Consider reducing cellSizeMeters."
            );

            if (
              !progress.saturated.includes(key)
            ) {
              progress.saturated.push(key);
            }
          }

          if (
            !progress.completed.includes(key)
          ) {
            progress.completed.push(key);
          }

          progress.failed =
            progress.failed.filter(
              (entry) => entry.key !== key
            );

          // Persist after each successful search.
          await save();

          console.log(
            `Completed ${key}: ` +
            `${items.length} raw, ` +
            `${added} new, ${merged} merged`
          );
        } catch (error) {
          progress.failed =
            progress.failed.filter(
              (entry) => entry.key !== key
            );

          progress.failed.push({
            key,
            error: error.message,
            time: new Date().toISOString()
          });

          await save();

          console.error(
            `Search error ${key}: ${error.message}`
          );
        }

        await sleep(
          CONFIG.searchDelayMs
        );
      }
    }

    await page.close();
    await context.close();
  } finally {
    if (browser) {
      await browser.close();
    }

    // Save the latest data even if execution fails.
    await save();
  }

  console.log("\nFinished.");

  console.log(
    `Businesses: ${businesses.length}`
  );

  console.log(
    `With phone: ${
      businesses.filter((b) => b.phone).length
    }`
  );

  console.log(
    `Businesses JSON: ${FILES.output}`
  );

  console.log(
    `Contacts JSON: ${FILES.contacts}`
  );

  console.log(
    `Progress JSON: ${FILES.progress}`
  );
}

// ==================================================
// EXPORTS AND ENTRY POINT
// ==================================================

module.exports = {
  decodeNeshanSearch,
  decodeNeshanText,
  buildSearchUrl,
  businessKeys,
  normalizePhone,
  normalizeName,
  CONFIG
};

if (require.main === module) {
  main().catch((error) => {
    console.error(
      "Fatal error:",
      error.message
    );

    process.exitCode = 1;
  });
}
