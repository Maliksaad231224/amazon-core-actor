# Amazon EU/UK Core Scraper

This Apify actor crawls the public Amazon websites for the EU6 countries (DE, FR, IT, ES, NL, SE) and the UK.  It extracts product details from listing pages, follows links to seller storefronts and captures seller information, deduplicating each seller–product pair on a per‑run basis.  The actor then upserts the data into a Supabase database using the provided service role key.

## Features

- **Playwright stealth scraping** via [`puppeteer-extra`](https://github.com/berstend/puppeteer-extra) and the stealth plugin to reduce block rates.
- **Concurrent crawling** with automatic session pooling and proxy rotation using Apify’s [`PuppeteerCrawler`](https://sdk.apify.com/docs/api/puppeteer-crawler).
- **Retries with jitter/backoff** to gracefully handle transient network errors and bot checks.
- **Deduplication** of seller/product pairs during a run to avoid redundant upserts.
- **Supabase upsert logic** for `sellers`, `products` and `listings` tables, maintaining `first_seen` and `last_seen` timestamps.
- **Configurable input** via `input_schema.json` for domains, categories, concurrency and proxy options.
- **Run metrics logging** (processed records, block pages, parse errors) to Apify dataset at the end of each run.

## Folder Structure

```
amazon_core_scraper/
├── src/
│   └── main.js            # Actor source code
├── input_schema.json      # Apify input schema
├── .env.sample            # Example environment variables
├── contracts/
│   └── core_output.json   # Example output contract
├── docs/
│   └── ops_runbook.md     # Operational notes and clarifications
└── README.md              # This file
```

## Prerequisites

- **Node.js 18+** and npm.
- A Supabase project with the following tables (simplified):

```sql
create table if not exists sellers (
  seller_id text primary key,
  name text,
  rating text,
  location text,
  url text,
  first_seen timestamp with time zone,
  last_seen timestamp with time zone
);

create table if not exists products (
  asin text primary key,
  title text,
  brand text,
  category text,
  first_seen timestamp with time zone,
  last_seen timestamp with time zone
);

create table if not exists listings (
  id text primary key,
  seller_id text references sellers(seller_id),
  asin text references products(asin),
  price numeric,
  currency text,
  scraped_at timestamp with time zone,
  first_seen timestamp with time zone,
  last_seen timestamp with time zone
);
```

Populate your `.env` with the Supabase URL and service role key.  The service role key is used because only it allows row‑level upserts.  Keep this key secure and never commit it to version control.

## Usage

1. **Install dependencies**

   ```bash
   npm install
   ```

2. **Prepare environment variables**

   Create a `.env` file in the root of the actor based on `.env.sample` and fill in your Supabase credentials and proxy configuration if needed.

3. **Run the actor locally**

   ```bash
   node src/main.js --input '{"domains":["amazon.co.uk","amazon.de"],"categories":[],"maxItems":100,"maxConcurrency":5}'
   ```

4. **Deploy on Apify**

   - Zip the `amazon_core_scraper` directory or push it to a GitHub repository linked to your Apify account.
   - On the Apify platform, set environment variables (`SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `APIFY_PROXY_PASSWORD` if needed) in the actor settings.
   - Configure input in the Apify UI based on `input_schema.json`.

## Input Parameters

Refer to [`input_schema.json`](./input_schema.json) for full definitions.  The most important fields are:

- **`domains`**: Array of Amazon domains to crawl (e.g. `amazon.co.uk`, `amazon.de`).  Required.
- **`categories`**: Optional array of category slugs (e.g. `electronics`).  If omitted the actor starts from the root page and follows any visible product links.
- **`maxItems`**: Maximum number of seller/product pairs to process before terminating the run.  Default: 1,000.
- **`maxConcurrency`**: Maximum number of concurrent browser tabs.  Default: 5.
- **`proxy`**: Object defining proxy options for Apify.  Use residential proxies to reduce block rates.

## Output

During the run, each processed seller–product pair is upserted into Supabase.  After the crawl finishes, a summary of the run metrics is pushed into the Apify dataset.  An example record in the dataset looks like:

```json
{
  "runStartedAt": "2025-08-19T12:00:00.000Z",
  "sellersProcessed": 42,
  "productsProcessed": 42,
  "listingsProcessed": 42,
  "blockedPages": 3,
  "parseErrors": 1
}
```

## Notes and Limitations

1. **Selector Stability**: Amazon continually tweaks its frontend.  If selectors start breaking, update the CSS selectors in `src/main.js` accordingly.
2. **Proxy Use**: Without residential proxies the crawl might encounter captchas or be throttled.  Use Apify’s RESIDENTIAL proxy group or your own proxy pool.
3. **Pricing Extraction**: The current implementation leaves `price` and `currency` as `null`.  Extend the product parsing logic to extract price and currency from the product or listing page if needed.
4. **Categories**: The actor builds category URLs by slugifying the supplied category names.  Some categories have unique URLs; provide fully qualified relative paths if slugification fails.
5. **Error Handling**: The crawler retries failed requests automatically.  Persistent failures are recorded in the metrics under `parseErrors` and `blockedPages`.

## License

This project is provided under the [MIT License](https://opensource.org/licenses/MIT).