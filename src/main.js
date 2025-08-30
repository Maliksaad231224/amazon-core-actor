// Amazon Core Scraper — Apify SDK v3 (Actor.*) + PuppeteerCrawler (Crawlee)
// Drop-in replacement for src/main.js

// ───────────────────────────────────────────────────────────────────────────────
// Imports & setup
// ───────────────────────────────────────────────────────────────────────────────
const { Actor, log } = require('apify');               // v3 API (Actor.* helpers)
const { PuppeteerCrawler } = require('crawlee');       // crawler runtime
require('dotenv').config();

const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
puppeteer.use(StealthPlugin());                        // stealth against bot checks

// Supabase
const { createClient } = require('@supabase/supabase-js');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

let supabase = null;
if (SUPABASE_URL && SUPABASE_SERVICE_ROLE_KEY) {
  supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
} else {
  log.warning('Supabase env vars missing — upserts will be skipped.');
}

// ───────────────────────────────────────────────────────────────────────────────
// Small helpers
// ───────────────────────────────────────────────────────────────────────────────
const sleep = (ms) => new Promise((res) => setTimeout(res, ms));

async function randomDelay(minMs = 500, maxMs = 1500) {
  const ms = Math.floor(minMs + Math.random() * (maxMs - minMs + 1));
  await sleep(ms);
}

async function waitForPageLoad(page) {
  try {
    await page.waitForSelector('body', { timeout: 30_000 });
    if (page.waitForNetworkIdle) {
      await page.waitForNetworkIdle({ timeout: 10_000 });
    } else {
      // Older Puppeteer fallback
      await page.waitForNavigation({ waitUntil: 'networkidle0', timeout: 10_000 }).catch(() => {});
    }
  } catch {
    log.debug('waitForPageLoad: timed out; continuing.');
  }
}

function extractASIN(url) {
  if (!url) return null;
  const patterns = [
    /\/dp\/([A-Z0-9]{10})/i,
    /\/gp\/product\/([A-Z0-9]{10})/i,
    /[?&]ASIN=([A-Z0-9]{10})/i,
  ];
  for (const re of patterns) {
    const m = url.match(re);
    if (m) return m[1];
  }
  return null;
}

async function extractSellerLink(page) {
  // Try several locations on product page to find the seller profile/storefront
  return page.evaluate(() => {
    const anchors = Array.from(document.querySelectorAll('a[href]'));
    const ok = (href) => {
      return (
        /seller=|\/sp\?|\/gp\/aag\/main|\/stores\//i.test(href) ||
        /sellerProfileTriggerId/.test(href)
      );
    };
    const candidates = anchors
      .filter(a => ok(a.getAttribute('href')))
      .map(a => a.href);

    // De-duplicate but prefer aag/storefront links
    const uniq = Array.from(new Set(candidates));
    const pref = uniq.find(u => /\/gp\/aag\/main|seller=/.test(u));
    return pref || uniq[0] || null;
  });
}

async function extractPriceData(page) {
  // Extract price text + currency. Handles multiple selectors.
  return page.evaluate(() => {
    const qs = (sel) => document.querySelector(sel);
    const txt = (el) => (el && el.textContent ? el.textContent.trim() : null);

    const selectors = [
      '#priceblock_ourprice',
      '#priceblock_dealprice',
      '#corePrice_feature_div .a-price .a-offscreen',
      '.a-price .a-offscreen',
      '[data-a-color="price"] .a-offscreen',
      '#tp_price_block_total_price_ww',
    ];

    let priceText = null;
    for (const s of selectors) {
      const t = txt(qs(s));
      if (t) { priceText = t; break; }
    }
    if (!priceText) return { price: null, currency: null };

    // Normalize decimal separators and currency detection
    const symbol = priceText.replace(/[0-9.,\s]/g, '').trim() || null;
    const currencyMap = { '€':'EUR', '£':'GBP', '$':'USD' };
    const currency = currencyMap[symbol] || null;

    // Find number; Europeans often use comma decimal
    const m = priceText.match(/([0-9]+(?:[.,][0-9]{2})?)/);
    let num = null;
    if (m) {
      const raw = m[1];
      if (raw.includes(',') && !raw.includes('.')) {
        num = parseFloat(raw.replace(/\./g,'').replace(',','.'));
      } else {
        num = parseFloat(raw.replace(/,/g,''));
      }
    }

    return { price: Number.isFinite(num) ? num : null, currency };
  });
}

async function upsertToSupabase({ seller, product, listing }) {
  if (!supabase) return; // No-op if not configured

  const nowIso = new Date().toISOString();

  // Sellers
  const sellerPayload = {
    ...seller,
    first_seen: seller.first_seen || nowIso,
    last_seen: nowIso,
  };
  const { error: sellerErr } = await supabase
    .from('sellers')
    .upsert(sellerPayload, { onConflict: 'seller_id' });
  if (sellerErr) throw sellerErr;

  // Products
  const productPayload = {
    ...product,
    first_seen: product.first_seen || nowIso,
    last_seen: nowIso,
  };
  const { error: productErr } = await supabase
    .from('products')
    .upsert(productPayload, { onConflict: 'asin' });
  if (productErr) throw productErr;

  // Listings
  const listingPayload = {
    ...listing,
    first_seen: listing.first_seen || nowIso,
    last_seen: nowIso,
  };
  const { error: listingErr } = await supabase
    .from('listings')
    .upsert(listingPayload, { onConflict: 'id' });
  if (listingErr) throw listingErr;

  // Queue for enrichment
  try {
    await supabase.rpc('queue_seller_for_enrichment', { p_seller_id: seller.seller_id });
  } catch (e) {
    // Non-fatal
    log.warning(`queue_seller_for_enrichment failed for ${seller.seller_id}: ${e.message}`);
  }
}

// ───────────────────────────────────────────────────────────────────────────────
// Main
// ───────────────────────────────────────────────────────────────────────────────
Actor.main(async () => {
  const input = await Actor.getInput();

  if (!input || !Array.isArray(input.domains) || input.domains.length === 0) {
    throw new Error('Input must include a non-empty "domains" array (e.g., ["amazon.co.uk","amazon.de"]).');
  }

  const {
    domains,
    categories = [],               // optional list of category paths or slugs
    maxItems = 1000,               // target listings
    maxConcurrency = 5,
    proxy = {},                    // Actor.createProxyConfiguration options
  } = input;

  const metrics = {
    sellersProcessed: 0,
    productsProcessed: 0,
    listingsProcessed: 0,
    blockedPages: 0,
    parseErrors: 0,
    pagesFetched: 0,
    successRate: 0,
  };

  const dedupeSet = new Set();     // sellerId-ASIN guard
  const proxyConfiguration = await Actor.createProxyConfiguration(proxy);
  const requestQueue = await Actor.openRequestQueue();

  // Crawler
  const crawler = new PuppeteerCrawler({
    requestQueue,
    proxyConfiguration,
    maxConcurrency,
    requestHandlerTimeoutSecs: 120,
    sameDomainDelaySecs: 1,
    useSessionPool: true,
    persistCookiesPerSession: true,
    launchContext: {
      launcher: puppeteer,         // puppeteer-extra with stealth
      launchOptions: {
        headless: 'new',
        args: [
          '--no-sandbox',
          '--disable-dev-shm-usage',
          '--disable-blink-features=AutomationControlled',
        ],
      },
    },
    preNavigationHooks: [
      async ({ page, request, session }) => {
        await page.setViewport({ width: 1280, height: 800 });
        // Light randomized UA
        const uas = [
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122 Safari/537.36',
          'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121 Safari/537.36',
        ];
        await page.setUserAgent(uas[Math.floor(Math.random() * uas.length)]);
      },
    ],
    postNavigationHooks: [
      async ({ page }) => { await waitForPageLoad(page); },
    ],
    failedRequestHandler: async ({ request, error }) => {
      log.warning(`Failed ${request.url} (${request.retryCount} retries): ${error?.message}`);
      metrics.parseErrors += 1;
    },
    requestHandler: async ({ request, page, log }) => {
      metrics.pagesFetched += 1;
      const { label, domain, product } = request.userData || {};
      await randomDelay(800, 2200); // be polite

      const url = page.url();
      log.info(`Processing [${label}] ${url}`);

      // Detect robot/captcha blocks
      if (/\/errors\/validateCaptcha|captcha|\/sorry/i.test(url)) {
        metrics.blockedPages += 1;
        throw new Error('Captcha / block page encountered');
      }
      const html = await page.content();
      if (/not a robot|enter the characters/i.test(html)) {
        metrics.blockedPages += 1;
        throw new Error('Robot check in content');
      }

      if (label === 'CATEGORY') {
        // Collect product links
        const links = await page.evaluate(() => {
          const sels = [
            'a[href*="/dp/"]',
            'a[href*="/gp/product/"]',
            '[data-asin] a[href*="/dp/"]',
            '.s-product-image-container a[href*="/dp/"]',
          ];
          const set = new Set();
          for (const s of sels) {
            document.querySelectorAll(s).forEach(a => {
              const href = a.href;
              if (href && /\/(dp|gp\/product)\//.test(href)) set.add(href.split('?')[0]);
            });
          }
          return Array.from(set);
        });

        // Limit per category to avoid explosion
        const toAdd = links.slice(0, 50);
        for (const l of toAdd) {
          await requestQueue.addRequest({
            url: l,
            userData: { label: 'PRODUCT', domain },
          });
        }

      } else if (label === 'PRODUCT') {
        const asin = extractASIN(url);
        if (!asin) {
          metrics.parseErrors += 1;
          log.warning('ASIN not found on product URL');
          return;
        }

        const title = await page.title();
        const brand = await page.evaluate(() => {
          const sels = [
            '#bylineInfo',
            '.a-spacing-none.po-brand .a-span9 span',
            '[data-feature-name="brand"] .a-size-base',
            '.author .a-link-normal',
          ];
          for (const s of sels) {
            const el = document.querySelector(s);
            if (el && el.textContent) return el.textContent.replace(/^by\s+/i,'').trim();
          }
          return null;
        });

        const priceData = await extractPriceData(page);
        const sellerUrl = await extractSellerLink(page);

        if (!sellerUrl) {
          metrics.parseErrors += 1;
          log.warning('Seller link not found on product page');
          return;
        }

        await requestQueue.addRequest({
          url: sellerUrl,
          userData: {
            label: 'SELLER',
            domain,
            product: {
              asin,
              title,
              brand,
              price: priceData.price,
              currency: priceData.currency,
            },
          },
        });

      } else if (label === 'SELLER') {
        // Grab simple seller info by scanning plausible locations
        const sellerInfo = await page.evaluate(() => {
          const getText = (el) => (el && el.textContent ? el.textContent.trim() : null);

          const sellerName = (() => {
            const sels = ['h1', '.a-spacing-medium h1', '#seller-name'];
            for (const s of sels) {
              const t = getText(document.querySelector(s));
              if (t) return t;
            }
            return null;
          })();

          const rating = (() => {
            const sels = ['.a-icon-star span', '.a-icon-alt', '[data-hook="rating-out-of-text"]'];
            for (const s of sels) {
              const t = getText(document.querySelector(s));
              if (t) {
                const m = t.match(/([\d.]+)/);
                if (m) return m[1];
              }
            }
            return null;
          })();

          // Heuristic: look for small text blocks mentioning dispatch/ship from
          const location = (() => {
            const cands = [
              '#storefront-redirect-message',
              '[data-hook="seller-info"] .a-size-small',
              '.a-spacing-mini',
            ];
            for (const s of cands) {
              const el = document.querySelector(s);
              if (el && /ship|dispatch|from|located/i.test(el.textContent || '')) {
                return el.textContent.trim();
              }
            }
            return null;
          })();

          return { sellerName, rating, location };
        });

        const sellerUrlObj = new URL(url);
        // Create a stable seller id: prefer seller param or path
        const sellerId =
          sellerUrlObj.searchParams.get('seller') ||
          sellerUrlObj.searchParams.get('sellerID') ||
          sellerUrlObj.pathname.replace(/[^A-Za-z0-9]+/g, '_').replace(/^_+|_+$/g,'').slice(0, 64);

        const seller = {
          seller_id: sellerId,
          name: sellerInfo.sellerName,
          rating: sellerInfo.rating,
          location: sellerInfo.location,
          url,
          domain,
          enrichment_status: 'pending',
        };

        const productData = request.userData.product || {};
        const product = {
          asin: productData.asin,
          title: productData.title,
          brand: productData.brand,
          category: null, // to be enriched later
        };

        const listingId = `${seller.seller_id}-${product.asin}`;
        const listing = {
          id: listingId,
          seller_id: seller.seller_id,
          asin: product.asin,
          price: productData.price,
          currency: productData.currency || 'EUR',
          scraped_at: new Date().toISOString(),
        };

        const dedupeKey = `${seller.seller_id}-${product.asin}`;
        if (!dedupeSet.has(dedupeKey)) {
          dedupeSet.add(dedupeKey);
          try {
            await upsertToSupabase({ seller, product, listing });
            metrics.sellersProcessed += 1;
            metrics.productsProcessed += 1;
            metrics.listingsProcessed += 1;
            metrics.successRate = Math.round(100 * (metrics.listingsProcessed / Math.max(1, metrics.pagesFetched)));
          } catch (e) {
            metrics.parseErrors += 1;
            log.warning(`Supabase upsert failed: ${e.message}`);
          }
        }
      }

      // Stop condition
      if (metrics.listingsProcessed >= maxItems) {
        log.info(`Reached maxItems=${maxItems}. Aborting run.`);
        await crawler.autoscaledPool?.abort();
      }
    },
  });

  // Seed queue
  for (const domain of domains) {
    if (categories && categories.length > 0) {
      for (let category of categories) {
        let categoryPath = category;
        if (!categoryPath.includes('/')) {
          categoryPath = category.replace(/\s+/g, '-').toLowerCase();
        }
        if (!categoryPath.endsWith('/')) categoryPath += '/';
        const url = `https://${domain}/${categoryPath}`;
        await requestQueue.addRequest({ url, userData: { label: 'CATEGORY', domain } });
      }
    } else {
      // No categories supplied: start from homepage and let CATEGORY handler work
      const url = `https://${domain}`;
      await requestQueue.addRequest({ url, userData: { label: 'CATEGORY', domain } });
    }
  }

  log.info(`Starting Amazon scraper for ${domains.length} domain(s); target maxItems=${maxItems}`);

  await crawler.run();

  const finalMetrics = {
    runStartedAt: new Date().toISOString(),
    runCompletedAt: new Date().toISOString(),
    sellersProcessed: metrics.sellersProcessed,
    productsProcessed: metrics.productsProcessed,
    listingsProcessed: metrics.listingsProcessed,
    blockedPages: metrics.blockedPages,
    parseErrors: metrics.parseErrors,
    pagesFetched: metrics.pagesFetched,
    successRate: `${metrics.successRate}%`,
    domainsProcessed: domains,
    categoriesProcessed: categories,
  };

  await Actor.pushData(finalMetrics);
  log.info(`Final metrics: ${JSON.stringify(finalMetrics, null, 2)}`);
});
