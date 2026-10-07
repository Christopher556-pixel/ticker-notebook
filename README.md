# Ticker Notebook: public website

A free stock tracker anyone can use. Visitors add their own tickers and get, for each one:

- a live price that refreshes every 15 seconds while the market is open,
- a one-year price chart with their own buy, sell and stop-loss lines,
- key stats (market cap, P/E, EPS, beta, dividend yield, 52-week range),
- a thesis box, a dated journal, and recent company news.

Each visitor's list is saved in their own browser. Nothing they type is stored on your server, and there are no accounts. A "Download backup" button lets visitors save their list to a file and restore it later.

## How it works

```
Visitor's browser ──► your-site.pages.dev/api/...  ──►  Finnhub      (live quotes, search, stats, news)
  (public/index.html)    Cloudflare Pages Function   ──►  Twelve Data  (daily price history)
                         holds your API keys and caches answers
```

The page never sees your API keys. They live in Cloudflare and are used only by the small server function in `functions/api/[[path]].js`. Every answer is cached, so a thousand visitors watching AAPL cost about the same as one: each quote is fetched from Finnhub at most once every 10 seconds per stock. If a provider is busy, visitors get the last price it sent instead of an error.

## What you need (all free)

| Service | What it's for | Sign up |
|---|---|---|
| Finnhub | live US quotes, search, company stats, news | https://finnhub.io/register |
| Twelve Data | one year of daily closing prices | https://twelvedata.com/register |
| GitHub | stores the site's files | https://github.com/signup |
| Cloudflare | hosts the site and the key-holding function | https://dash.cloudflare.com/sign-up |

Setup takes about 20 minutes. You don't need a credit card or any software on your computer.

## Step 1: Get your two API keys

1. **Finnhub:** sign up, then copy the API key shown on your dashboard.
2. **Twelve Data:** sign up, then open **API Keys** in your account and copy the key.

Keep both handy for step 3. Don't paste them into any file in this folder.

## Step 2: Put the files on GitHub

1. Unzip `ticker-notebook-site.zip`.
2. On GitHub, click **New repository**. Name it `ticker-notebook`. Public or private both work. Click **Create repository**.
3. On the new repository's page, click **uploading an existing file**.
4. Open the unzipped folder and drag its **contents** onto the page: the `public` folder, the `functions` folder and `README.md`. Drag the folders themselves, not the zip. Chrome and Edge keep the folder structure; if your browser doesn't, use one of those.
5. Click **Commit changes**.

Check that the repository shows `public/index.html` and `functions/api/[[path]].js` at those exact paths.

## Step 3: Publish on Cloudflare Pages

1. In the Cloudflare dashboard, open **Workers & Pages** and choose **Create**. Pick the **Pages** option and **Connect to Git**. Cloudflare's wording changes from time to time; if it offers a Workers setup first, look for the link to create a Pages project instead.
2. Connect your GitHub account and select the `ticker-notebook` repository.
3. Under build settings:
   - **Framework preset:** None
   - **Build command:** leave empty
   - **Build output directory:** `public`
4. Open **Environment variables** and add two variables. Mark each one as **Encrypt** or **Secret** if offered:
   - `FINNHUB_KEY` = your Finnhub key
   - `TWELVEDATA_KEY` = your Twelve Data key
5. Click **Save and Deploy**. The first deploy takes a minute or two.

Your site is now live at `https://<project-name>.pages.dev`.

## Step 4: Check it works

1. Open `https://<project-name>.pages.dev/api/quote?symbol=AAPL`. You should see a short block of text containing `"price"`.
   - If you see "needs to add the Finnhub API key", the variable is missing or misspelled. Fix it under **Settings → Variables and Secrets**, then go to **Deployments** and **Retry deployment**. Key changes only apply to new deployments.
2. Open `https://<project-name>.pages.dev`. First-time visitors start with AAPL, MSFT and NVDA so they can see how it works, and they can remove those.

## Updating the site

Edit or upload files in the GitHub repository, and Cloudflare redeploys automatically within a minute or two.

To use your own domain, open the Pages project and go to **Custom domains**.

## Limits on the free plans

| | Free allowance | How the site stays inside it |
|---|---|---|
| Finnhub | about 60 calls a minute | quotes cached 10 s per stock, shared by all visitors; stats cached 12 h, company profiles 7 days, news 15 min |
| Twelve Data | 800 calls a day, 8 a minute | each stock's history cached 6 h |
| Cloudflare Pages Functions | 100,000 requests a day | browsers also cache answers for a few seconds |

These allowances fit a personal site with a modest audience. If the site gets popular, the first sign will be the "data provider busy" note next to prices. That's when to move to paid plans.

## Read this before you promote the site

Free market-data plans are generally licensed for **personal, non-commercial use**. Showing their prices to the public can count as redistributing the data. Before you advertise the site, add ads, or charge for it, read the Finnhub and Twelve Data terms and switch to plans that allow public display.

The footer credits both providers and says the site isn't financial advice. Keep both.

## Files

| Path | What it is |
|---|---|
| `public/index.html` | the whole website: one page, no build step |
| `functions/api/[[path]].js` | the server function that holds your keys, calls the providers and caches results |
| `README.md` | this guide |

## Troubleshooting

- **"Prices are unavailable" banner:** a key is missing or wrong. See step 4.
- **Chart says "Loading price history…" for a long time:** Twelve Data's per-minute limit was reached. Wait a minute and reload.
- **"No US stock found":** the free plans cover US-listed stocks. Use the US ticker (for example `BRK.B`, `TSM`).
- **Prices stop moving after 4 PM New York time:** that's expected. Outside market hours the site checks for a new price every 10 minutes.

## Optional: run it on your own computer

If you have Node.js installed:

```
# in the project folder
echo 'FINNHUB_KEY=your-key'    >  .dev.vars
echo 'TWELVEDATA_KEY=your-key' >> .dev.vars
npx wrangler pages dev public
```

Then open the address it prints. Don't upload `.dev.vars` to GitHub.

You can also deploy without GitHub using `npx wrangler pages deploy public`. You'd then add the two keys under the project's **Settings → Variables and Secrets** in Cloudflare.
