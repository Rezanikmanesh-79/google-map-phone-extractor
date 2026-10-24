
const { firefox } = require("playwright");
const fs = require("node:fs/promises");
const path = require("node:path");

// ==================================================
// تنظیمات اصلی
// ==================================================

const CONFIG = {
  city: "Shiraz",
  country: "Iran",

  category: "Real estate agency",

  variants: [
    "real estate agency",
    "real estate office",
    "property agency",
    "realtor"
  ],

  // تنظیمات تشخیص مرز شهر
  boundary: {
    // نوع نتیجه مورد انتظار از Nominatim
    requiredType: "administrative",

    // نام‌های قابل قبول برای تشخیص شهر
    nameMatches: [
      "Shiraz",
      "شیراز"
    ],

    // نام‌هایی که برای انتخاب مرز اولویت دارند
    preferredNames: [
      "Shiraz",
      "شیراز"
    ],

    // هندسه‌های مجاز
    allowedGeometryTypes: [
      "Polygon",
      "MultiPolygon"
    ],

    // حداکثر نتایج درخواست مرز
    resultLimit: 10
  },

  // فاصله تقریبی نقاط شبکه بر حسب متر
  cellSizeMeters: 1200,

  // محدودیت جمع‌آوری لینک در هر جست‌وجو
  maxResultsPerSearch: 60,
  maxUnchangedScrolls: 5,

  scrollDelayMs: 1400,
  detailDelayMs: 1000,
  searchDelayMs: 1800,

  headless: false,

  // ایمیل واقعی خودت را جایگزین کن
  userAgent:
    "BusinessResearch/1.0 (contact: YOUR_REAL_EMAIL)"
};

// ==================================================
// ساخت نام فایل مستقل برای هر شهر
// ==================================================

function slugify(value) {
  return String(value)
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

const CITY_KEY =
  `${slugify(CONFIG.city)}-${slugify(CONFIG.country)}`;

const FILES = {
  boundary: path.join(
    __dirname,
    `city-boundary-${CITY_KEY}.json`
  ),
  output: path.join(
    __dirname,
    `businesses-${CITY_KEY}.json`
  ),
  progress: path.join(
    __dirname,
    `progress-${CITY_KEY}.json`
  )
};

const sleep = (ms) =>
  new Promise((resolve) => setTimeout(resolve, ms));

// ==================================================
// ابزار فایل
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
  const temp = `${file}.tmp`;

  await fs.writeFile(
    temp,
    JSON.stringify(data, null, 2),
    "utf8"
  );

  await fs.rename(temp, file);
}

function norm(value) {
  return String(value || "")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeUrl(value) {
  try {
    const url = new URL(value);
    url.search = "";
    url.hash = "";
    return url.href.replace(/\/$/, "");
  } catch {
    return norm(value);
  }
}

function businessKey(item) {
  const url = normalizeUrl(item.url);

  if (url) return `url:${url}`;

  if (item.phone) {
    return `phone:${norm(item.phone)}`;
  }

  return (
    norm(item.name).toLowerCase() +
    "|" +
    norm(item.address).toLowerCase()
  );
}

// ==================================================
// اعتبارسنجی GeoJSON
// ==================================================

function isValidGeometry(geometry) {
  if (
    !geometry ||
    !Array.isArray(geometry.coordinates)
  ) {
    return false;
  }

  if (
    !["Polygon", "MultiPolygon"].includes(geometry.type)
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
// دریافت و انتخاب مرز شهر
// ==================================================

async function getCityBoundary() {
  const cached = await readJson(FILES.boundary, null);

  if (
    cached &&
    cached.city === CONFIG.city &&
    cached.country === CONFIG.country &&
    isValidGeometry(cached.geometry)
  ) {
    console.log("Using cached boundary:", cached.name);
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
      `ارتباط با Nominatim ناموفق بود: ${error.message}`
    );
  }

  if (!response.ok) {
    throw new Error(
      `Nominatim HTTP ${response.status}. ` +
      "بعداً دوباره امتحان کن یا مرز معتبر GeoJSON تهیه کن."
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

  // فیلتر نتایج بر اساس تنظیمات
  const candidates = results.filter((item) => {
    const name = norm(item.display_name).toLowerCase();

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

  // اولویت‌بندی نام‌های ترجیحی
  const boundary =
    candidates.find((item) => {
      const name = norm(item.display_name).toLowerCase();

      return boundaryConfig.preferredNames.some(
        (term) => name.startsWith(term.toLowerCase())
      );
    }) || candidates[0];

  if (!boundary) {
    throw new Error(
      `مرز مناسب ${CONFIG.city} پیدا نشد. ` +
      "مقادیر CONFIG.boundary را بررسی کن."
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
// بررسی نقطه داخل حلقه
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

  // حذف نقاط داخل حفره‌های چندضلعی
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
    return geometry.coordinates.some((polygon) =>
      pointInPolygon(lon, lat, polygon)
    );
  }

  return false;
}

// ==================================================
// ساخت شبکه نقاط داخل محدوده
// ==================================================

function buildGrid(geometry) {
  if (!isValidGeometry(geometry)) {
    throw new Error("هندسه مرز شهر معتبر نیست.");
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

  const latStep = CONFIG.cellSizeMeters / 111320;

  const lonStep =
    CONFIG.cellSizeMeters /
    (
      111320 *
      Math.max(
        0.1,
        Math.cos((centerLat * Math.PI) / 180)
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
      if (pointInGeometry(lon, lat, geometry)) {
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
// جمع‌آوری لینک‌های Google Maps
// ==================================================

async function collectLinks(page, query) {
  const url =
    "https://www.google.com/maps/search/" +
    encodeURIComponent(query);

  await page.goto(url, {
    waitUntil: "domcontentloaded",
    timeout: 60000
  });

  await sleep(CONFIG.searchDelayMs);

  const feed = page.locator('div[role="feed"]').first();
  const found = new Map();

  let unchanged = 0;
  let previousCount = 0;

  while (
    unchanged < CONFIG.maxUnchangedScrolls
  ) {
    const anchors = await page
      .locator('a[href*="/maps/place/"]')
      .evaluateAll((nodes) =>
        nodes.map((a) => ({
          url: a.href,
          label: (
            a.getAttribute("aria-label") ||
            a.innerText ||
            ""
          ).trim()
        }))
      );

    for (const item of anchors) {
      const key = normalizeUrl(item.url);

      if (key && !found.has(key)) {
        found.set(key, item);
      }

      if (
        found.size >= CONFIG.maxResultsPerSearch
      ) {
        break;
      }
    }

    if (
      found.size >= CONFIG.maxResultsPerSearch
    ) {
      break;
    }

    if (found.size === previousCount) {
      unchanged++;
    } else {
      unchanged = 0;
      previousCount = found.size;
    }

    if (await feed.count()) {
      await feed.evaluate((el) => {
        el.scrollTop = el.scrollHeight;
      });
    } else {
      await page.mouse.wheel(0, 1200);
    }

    await sleep(CONFIG.scrollDelayMs);
  }

  return [...found.values()];
}

// ==================================================
// ابزار خواندن عناصر صفحه
// ==================================================

async function locatorText(locator) {
  try {
    if (await locator.count()) {
      return (
        norm(await locator.first().innerText()) ||
        null
      );
    }
  } catch {}

  return null;
}

async function locatorAttr(locator, attr) {
  try {
    if (await locator.count()) {
      return (
        norm(
          await locator.first().getAttribute(attr)
        ) || null
      );
    }
  } catch {}

  return null;
}

// ==================================================
// استخراج جزئیات کسب‌وکار
// ==================================================

async function getDetails(page, result, point, query) {
  await page.goto(result.url, {
    waitUntil: "domcontentloaded",
    timeout: 60000
  });

  await sleep(CONFIG.detailDelayMs);

  const name =
    (await locatorText(page.locator("h1"))) ||
    result.label ||
    null;

  let phone = await locatorAttr(
    page.locator('button[data-item-id^="phone:"]'),
    "aria-label"
  );

  if (!phone) {
    phone = await locatorText(
      page.locator('button[data-item-id^="phone:"]')
    );
  }

  let address = await locatorAttr(
    page.locator('button[data-item-id="address"]'),
    "aria-label"
  );

  if (!address) {
    address = await locatorText(
      page.locator('button[data-item-id="address"]')
    );
  }

  const website = await locatorAttr(
    page.locator('a[data-item-id="authority"]'),
    "href"
  );

  return {
    name,
    url: result.url,

    phone: phone
      ?.replace(
        /^(phone|telephone|call):\s*/i,
        ""
      ) || null,

    address: address
      ?.replace(/^address:\s*/i, "") || null,

    website,

    latitude: point.latitude,
    longitude: point.longitude,
    gridCell: point.id,

    searchQuery: query,
    source: "Google Maps",
    detailsChecked: true,
    lastCheckedAt: new Date().toISOString()
  };
}

// ==================================================
// اجرای اسکریپت
// ==================================================

async function main() {
  console.log(`City: ${CONFIG.city}, ${CONFIG.country}`);
  console.log(`Category: ${CONFIG.category}`);

  console.log("Files:");
  console.log("Boundary:", FILES.boundary);
  console.log("Output:", FILES.output);
  console.log("Progress:", FILES.progress);

  const boundary = await getCityBoundary();
  const points = buildGrid(boundary.geometry);

  if (!points.length) {
    throw new Error(
      "هیچ نقطه‌ای داخل مرز تولید نشد؛ " +
      "هندسه مرز انتخاب‌شده را بررسی کن."
    );
  }

  console.log(`Grid points: ${points.length}`);
  console.log(
    `Approximate cell size: ${CONFIG.cellSizeMeters} m`
  );

  const output = await readJson(FILES.output, {
    businesses: []
  });

  const businesses = Array.isArray(output.businesses)
    ? output.businesses
    : [];

  const progress = await readJson(FILES.progress, {
    completed: [],
    failed: []
  });

  if (!Array.isArray(progress.completed)) {
    progress.completed = [];
  }

  if (!Array.isArray(progress.failed)) {
    progress.failed = [];
  }

  const index = new Map();

  for (const item of businesses) {
    index.set(businessKey(item), item);
  }

  async function save() {
    await saveJson(FILES.output, {
      city: CONFIG.city,
      country: CONFIG.country,
      category: CONFIG.category,
      boundary: boundary.name,
      gridCellSizeMeters: CONFIG.cellSizeMeters,
      totalBusinesses: businesses.length,
      updatedAt: new Date().toISOString(),
      attribution: boundary.attribution,
      businesses
    });

    await saveJson(FILES.progress, progress);
  }

  const browser = await firefox.launch({
    headless: CONFIG.headless
  });

  try {
    const context = await browser.newContext({
      viewport: {
        width: 1365,
        height: 900
      },
      locale: "en-US"
    });

    const searchPage = await context.newPage();
    const detailPage = await context.newPage();

    for (const point of points) {
      for (const variant of CONFIG.variants) {
        const key = `${point.id}|${variant}`;

        if (progress.completed.includes(key)) {
          continue;
        }

        const query = [
          variant,
          `near ${point.latitude},${point.longitude}`,
          CONFIG.city,
          CONFIG.country
        ].join(" ");

        console.log(`\nSearching: ${key}`);

        try {
          const links = await collectLinks(
            searchPage,
            query
          );

          for (const result of links) {
            const normalized = normalizeUrl(
              result.url
            );

            const existing = businesses.find(
              (item) =>
                normalizeUrl(item.url) === normalized &&
                item.detailsChecked === true
            );

            if (existing) continue;

            try {
              const details = await getDetails(
                detailPage,
                result,
                point,
                query
              );

              const id = businessKey(details);
              const previous = index.get(id);

              if (previous) {
                Object.assign(previous, details);
              } else {
                businesses.push(details);
                index.set(id, details);
              }

              await save();

              console.log(
                `Saved: ${details.name || "Unknown"} | ` +
                `${details.phone || "No phone"}`
              );
            } catch (error) {
              console.error(
                "Detail error:",
                error.message
              );
            }

            await sleep(CONFIG.detailDelayMs);
          }

          if (!progress.completed.includes(key)) {
            progress.completed.push(key);
          }

          progress.failed = progress.failed.filter(
            (item) => item.key !== key
          );

          await save();

          console.log(
            `Completed ${key}: ${links.length} links`
          );
        } catch (error) {
          progress.failed = progress.failed.filter(
            (item) => item.key !== key
          );

          progress.failed.push({
            key,
            query,
            error: error.message,
            time: new Date().toISOString()
          });

          await save();

          console.error(
            `Search error ${key}: ${error.message}`
          );
        }

        await sleep(CONFIG.searchDelayMs);
      }
    }

    await searchPage.close();
    await detailPage.close();
  } finally {
    await browser.close();
    await save();
  }

  console.log("\nFinished.");
  console.log(`Businesses: ${businesses.length}`);
  console.log(`Output: ${FILES.output}`);
  console.log(`Progress: ${FILES.progress}`);
}

main().catch((error) => {
  console.error("Fatal error:", error.message);
  process.exitCode = 1;
});
