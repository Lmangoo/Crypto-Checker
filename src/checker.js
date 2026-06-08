/**
 * DeBank Checker — Derive + Check Balance
 * Intercepts responses from the browser when loading a DeBank profile page.
 * No API key required, no extra fetches — data is taken directly
 * from responses already present in the browser.
 *
 * Usage: node index.js
 */

import { HDNodeWallet, Wallet, Mnemonic } from "ethers";
import { chromium } from "playwright";
import * as cheerio from "cheerio";
import { readFileSync, mkdirSync, writeFileSync, appendFileSync, existsSync } from "fs";
import { resolve } from "path";
import * as readline from "readline";

// ─── Load .env ────────────────────────────────────────────────
function loadEnv(filePath) {
  try {
    const raw = readFileSync(filePath, "utf-8");
    for (const line of raw.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const idx = trimmed.indexOf("=");
      if (idx === -1) continue;
      const key = trimmed.slice(0, idx).trim();
      const val = trimmed.slice(idx + 1).trim().replace(/^["']|["']$/g, "");
      if (key && !(key in process.env)) process.env[key] = val;
    }
  } catch { /* no .env file */ }
}

loadEnv(resolve(process.cwd(), ".env"));

let MNEMONIC_FILE    = process.env.MNEMONIC_FILE    || "";
let PRIVATE_KEY_FILE = process.env.PRIVATE_KEY_FILE || "";
let ADDRESS_SINGLE   = process.env.ADDRESS          || "";
const DERIVE_COUNT     = parseInt(process.env.DERIVE_COUNT || "10", 10);
const DERIVE_PATH      = process.env.DERIVE_PATH || "m/44'/60'/0'/0";
let MODE               = (process.env.FETCH_MODE || "balance").trim();
const CURRENCY         = (process.env.CURRENCY || "usd").toLowerCase();
const MIN_BALANCE      = parseFloat(process.env.MIN_BALANCE || "1");
const CONCURRENCY      = parseInt(process.env.CONCURRENCY || "1", 10); // DeBank is sensitive to concurrency
const BROWSER_COUNT    = parseInt(process.env.BROWSER_COUNT || "1", 10); // number of parallel browsers

// ─── Format ───────────────────────────────────────────────────
function formatMoney(value) {
  const upper = CURRENCY.toUpperCase();
  if (["USD","EUR","GBP","AUD","CAD","NZD","CHF"].includes(upper)) {
    return new Intl.NumberFormat("en-US", {
      style: "currency", currency: upper, minimumFractionDigits: 2,
    }).format(value || 0);
  }
  return `${(value || 0).toFixed(6)} ${upper}`;
}

// ─── Read file ────────────────────────────────────────────────
function readLines(filePath) {
  const full = resolve(process.cwd(), filePath);
  if (!existsSync(full)) {
    console.error(`[ERROR] File not found: ${filePath}`);
    process.exit(1);
  }
  return readFileSync(full, "utf-8")
    .split("\n").map((l) => l.trim()).filter((l) => l && !l.startsWith("#"));
}

// ─── Derive ───────────────────────────────────────────────────
function deriveAll() {
  const wallets = [];

  if (MNEMONIC_FILE) {
    const phrases = readLines(MNEMONIC_FILE);
    let invalid = 0;
    for (const phrase of phrases) {
      try {
        const mn = Mnemonic.fromPhrase(phrase.trim());
        for (let i = 0; i < DERIVE_COUNT; i++) {
          const path = `${DERIVE_PATH}/${i}`;
          const w    = HDNodeWallet.fromMnemonic(mn, path);
          wallets.push({ address: w.address, privateKey: w.privateKey, mnemonic: phrase.trim(), path, source: "mnemonic" });
        }
      } catch { invalid++; }
    }
    wallets._invalidCount = (wallets._invalidCount || 0) + invalid;
    wallets._sourceLabel  = `mnemonics.txt  : ${phrases.length} mnemonic × ${DERIVE_COUNT} = ${phrases.length * DERIVE_COUNT} addresses (${invalid} invalid)`;
  }

  if (PRIVATE_KEY_FILE) {
    const keys = readLines(PRIVATE_KEY_FILE);
    wallets._sourceLabel = `privatekey.txt : ${keys.length} key(s)`;
    for (const key of keys) {
      try {
        const w = new Wallet(key.startsWith("0x") ? key : `0x${key}`);
        wallets.push({ address: w.address, privateKey: w.privateKey, mnemonic: null, path: "-", source: "privatekey" });
      } catch (e) { console.warn(`  [SKIP] invalid key: ${e.message}`); }
    }
  }

  if (ADDRESS_SINGLE && /^0x[a-fA-F0-9]{40}$/.test(ADDRESS_SINGLE)) {
    wallets._sourceLabel = `ADDRESS        : ${ADDRESS_SINGLE}`;
    wallets.push({ address: ADDRESS_SINGLE, privateKey: null, mnemonic: null, path: "-", source: "address" });
  }

  return wallets;
}

// ─── Result file ──────────────────────────────────────────────
let resultFilePath = null;

function initResultFile() {
  const dir = resolve(process.cwd(), "Result");
  mkdirSync(dir, { recursive: true });
  const ts = new Date()
    .toLocaleString("id-ID", { timeZone: "Asia/Jakarta" })
    .replace(/[/:]/g, "-").replace(/,\s*/g, "-").replace(/\s/g, "");
  const modeName = MODE.replace(/_/g, "-");
  const filename = `${modeName}-${ts}.txt`;
  resultFilePath = resolve(dir, filename);
  writeFileSync(resultFilePath, "", "utf-8");
  // printed async by caller
  return filename;
}

function saveResult(lines) {
  if (!resultFilePath) return;
  appendFileSync(resultFilePath, lines.join("\n") + "\n", "utf-8");
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ─── Scrape a single address via response intercept ───────────
async function scrapeAddress(context, address) {
  const addr = address.toLowerCase();
  const page = await context.newPage();

  try {
    const responses = {};
    let lastActivityAt = Date.now();

    // Use CDP to intercept responses — requestId as key
    const client = await page.context().newCDPSession(page);
    await client.send("Network.enable");

    // Map requestId → full URL from requestWillBeSent
    const reqIdToUrl = {};

    client.on("Network.requestWillBeSent", (e) => {
      if (e.request.url.includes("api.debank.com")) {
        reqIdToUrl[e.requestId] = e.request.url;
        lastActivityAt = Date.now();
      }
    });

    client.on("Network.responseReceived", (e) => {
      const url = reqIdToUrl[e.requestId];
      if (!url) return;
      if (!responses[url]) responses[url] = { url, status: e.response.status };
    });

    client.on("Network.loadingFinished", async (e) => {
      const url = reqIdToUrl[e.requestId];
      if (!url) return;
      try {
        const body = await client.send("Network.getResponseBody", { requestId: e.requestId });
        if (responses[url]) responses[url].body = body.body;
        lastActivityAt = Date.now();
      } catch { /* skip */ }
    });

    // Block unnecessary resources via CDP (not using page.route so CDP can capture body)
    await client.send("Network.setBlockedURLs", {
      urls: [
        // Images
        "*.png", "*.jpg", "*.jpeg", "*.gif", "*.webp", "*.svg", "*.ico", "*.avif",
        // Media
        "*.mp4", "*.webm", "*.mp3", "*.ogg",
        // Fonts
        "*.woff", "*.woff2", "*.ttf", "*.eot",
        "fonts.googleapis.com", "fonts.gstatic.com",
        // Analytics & tracking
        "analytics.google.com", "www.google-analytics.com",
        "festats.debank.com",
        "*.sentry.io", "sentry.io",
        "hotjar.com", "*.hotjar.com",
        "clarity.ms", "*.clarity.ms",
        // Ads
        "doubleclick.net", "*.doubleclick.net",
        "*.googlesyndication.com",
        // Live chat / support widgets
        "intercom.io", "*.intercom.io",
        "*.intercomcdn.com",
      ],
    });

    await page.goto(`https://debank.com/profile/${addr}`, {
      waitUntil: "domcontentloaded", timeout: 30000,
    });

    // Scroll to trigger lazy load
    await sleep(800);
    await page.evaluate(() => window.scrollTo(0, 300));
    await sleep(400);
    await page.evaluate(() => window.scrollTo(0, 0));

    // Wait until network is idle (no new api.debank.com activity for 2s) or max 20s
    const IDLE_THRESHOLD = 2000;  // ms of silence = "done"
    const MAX_WAIT       = 20000; // hard cap
    const waitStart      = Date.now();
    lastActivityAt       = Date.now();

    while (Date.now() - waitStart < MAX_WAIT) {
      await sleep(300);
      const vals        = Object.values(responses);
      const hasCurve    = vals.some((r) => r.url.includes("total_net_curve") && r.body);
      const hasTokens   = vals.some((r) => r.url.includes("token/balance_list") && r.body);
      const hasProjects = vals.some((r) => r.url.includes("project_list") && r.body);

      // Must have minimum data first
      const hasMinData = MODE === "balance_defi"
        ? hasCurve && hasTokens && hasProjects
        : hasCurve && hasTokens;

      // Then wait for network idle
      if (hasMinData && Date.now() - lastActivityAt >= IDLE_THRESHOLD) break;
    }

    // Parse all token balances per chain
    const chainBalances = {};   // chain → usd_value
    let   grandTotal    = 0;

    // Get total from asset/total_net_curve (latest value)
    for (const r of Object.values(responses)) {
      if (!r.body || !r.url.includes("total_net_curve")) continue;
      try {
        const json = JSON.parse(r.body);
        const list = json?.data?.usd_value_list;
        if (list?.length) grandTotal = list[list.length - 1][1];
      } catch { /* skip */ }
    }

    // Calculate per chain from token/balance_list
    for (const r of Object.values(responses)) {
      if (!r.body || !r.url.includes("token/balance_list")) continue;
      try {
        const chainMatch = r.url.match(/chain=([^&]+)/);
        if (!chainMatch) continue;
        const chain = chainMatch[1];
        const json  = JSON.parse(r.body);
        if (!json?.data) continue;
        const chainTotal = json.data.reduce((sum, t) => {
          if (t.is_core && !t.is_scam && !t.is_suspicious) {
            return sum + (t.amount * (t.price || 0));
          }
          return sum;
        }, 0);
        if (chainTotal >= 0.01) chainBalances[chain] = (chainBalances[chain] || 0) + chainTotal;
      } catch { /* skip */ }
    }

    // Parse DeFi protocols from portfolio/project_list
    const protocols = {};
    for (const r of Object.values(responses)) {
      if (!r.body || !r.url.includes("portfolio/project_list")) continue;
      try {
        const json = JSON.parse(r.body);
        if (!json?.data) continue;
        for (const p of json.data) {
          const name  = p.name || p.id || "Unknown";
          const value = p.portfolio_item_list
            ?.reduce((s, i) => s + (i.stats?.net_usd_value || 0), 0) || 0;
          if (Math.abs(value) >= 0.01) protocols[name] = (protocols[name] || 0) + value;
        }
      } catch { /* skip */ }
    }

    // Fallback: parse HTML with cheerio if no data found
    if (grandTotal === 0 && Object.keys(chainBalances).length === 0) {
      const html = await page.content();
      const $    = cheerio.load(html);
      const text = $("[class*='totalAssets'], [class*='total-assets'], [class*='TotalBalance']").first().text();
      const match = text.match(/[\d,]+\.?\d*/);
      grandTotal = match ? parseFloat(match[0].replace(/,/g, "")) : 0;
    }

    const totalWallet = Object.values(chainBalances).reduce((a, b) => a + b, 0);
    const totalDeFi   = Object.values(protocols).reduce((a, b) => a + b, 0);

    // If grandTotal from curve is missing, calculate from tokens + defi
    if (grandTotal === 0) grandTotal = totalWallet + totalDeFi;

    // For balance: if project_list hasn't loaded, estimate DeFi from difference
    const effectiveDeFi = totalDeFi > 0 ? totalDeFi : Math.max(0, grandTotal - totalWallet);

    return {
      grandTotal,
      chainBalances,
      protocols,
      totalWallet,
      totalDeFi: effectiveDeFi,
    };

  } finally {
    await page.close().catch(() => {});
  }
}

// ─── Build output ─────────────────────────────────────────────
function buildOutput(wallet, { grandTotal, chainBalances, protocols, totalWallet, totalDeFi }) {
  const lines = [];

  if (MODE === "balance_by_chain") {
    const entries = Object.entries(chainBalances).sort((a, b) => b[1] - a[1]);
    const colW = Math.max(...(entries.length ? entries.map(([c]) => c.length) : [5]), "BALANCE".length) + 2;
    const pad  = (l) => l.padEnd(colW);
    lines.push("─".repeat(50));
    if (wallet.mnemonic)   lines.push(`Mnemonic : ${wallet.mnemonic}`);
    if (wallet.privateKey) lines.push(`PrivKey  : ${wallet.privateKey}`);
    lines.push(`Address  : ${wallet.address}`);
    lines.push("BALANCE BY CHAIN");
    for (const [chain, value] of entries) lines.push(`${pad(chain)}${formatMoney(value)}`);
    lines.push(`${pad("BALANCE")}${formatMoney(totalWallet)}`);
    lines.push("─".repeat(50));

  } else if (MODE === "balance") {
    const colW = Math.max("WALLET".length, "DeFi".length, "BALANCE".length) + 2;
    const pad  = (l) => l.padEnd(colW);
    lines.push("─".repeat(45));
    if (wallet.mnemonic)   lines.push(`Mnemonic : ${wallet.mnemonic}`);
    if (wallet.privateKey) lines.push(`PrivKey  : ${wallet.privateKey}`);
    lines.push(`Address  : ${wallet.address}`);
    lines.push(`${pad("WALLET")}${formatMoney(totalWallet)}`);
    lines.push(`${pad("DeFi")}${formatMoney(totalDeFi)}`);
    lines.push(`${pad("BALANCE")}${formatMoney(grandTotal)}`);
    lines.push("─".repeat(45));

  } else { // balance_defi
    const protocolEntries = Object.entries(protocols).sort((a, b) => b[1] - a[1]);
    const allLabels = [...protocolEntries.map(([n]) => n), "WALLET", "DeFi", "Protocol count", "BALANCE"];
    const colW = Math.max(...allLabels.map((l) => l.length), 1) + 2;
    const pad  = (l) => l.padEnd(colW);
    lines.push("─".repeat(52));
    if (wallet.mnemonic)   lines.push(`Mnemonic : ${wallet.mnemonic}`);
    if (wallet.privateKey) lines.push(`PrivKey  : ${wallet.privateKey}`);
    lines.push(`Address  : ${wallet.address}`);
    if (totalWallet > 0) lines.push(`${pad("WALLET")}${formatMoney(totalWallet)}`);
    if (protocolEntries.length > 0) {
      lines.push("PROTOCOL / DeFi");
      for (const [name, value] of protocolEntries) lines.push(`${pad(name)}${formatMoney(value)}`);
      lines.push(`${pad("DeFi")}${formatMoney(totalDeFi)}`);
      lines.push(`${pad("Protocol count")}${protocolEntries.length}`);
    }
    lines.push(`${pad("BALANCE")}${formatMoney(grandTotal)}`);
    lines.push("─".repeat(52));
  }

  return { lines, grandTotal: MODE === "balance_by_chain" ? totalWallet : grandTotal };
}

// ─── Create browser context ────────────────────────────────────
async function createContext(browser) {
  return browser.newContext({
    userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
    locale: "en-US",
  });
}

// ─── Typewriter effect ────────────────────────────────────────
async function typewrite(text, delay = 18) {
  for (const char of text) {
    process.stdout.write(char);
    await sleep(delay);
  }
  process.stdout.write("\n");
}

// ─── Footer donate banner ─────────────────────────────────────
async function printFooter() {
  await sleep(300);
  await printLine("─".repeat(52), 0);
  await typewrite("  💛 Donate — if this tool has been useful:");
  await typewrite("  ETH  : 0x134991f6A3f2F166383bA6B26a6a232e5729e46e");
  await typewrite("  BTC  : bc1qnjlsdaq9egzzdsuq5l2s55698607g7jfrp6vqf");
  await typewrite("  SOL  : 46V4wFh4EcpgUsYegkmzv3dC7NXTkcoZhVFNTTTCSbZz");
  await typewrite("  TG   : t.me/FIREFLY2X2  |  @Lmangoo");
  await printLine("─".repeat(52), 0);
}
async function printLine(line, delay = 40) {
  process.stdout.write(line + "\n");
  await sleep(delay);
}

async function printLines(lines, delay = 40) {
  for (const line of lines) await printLine(line, delay);
}

// ─── Donate banner ────────────────────────────────────────────
async function printDonate() {
  await printLines([
    "─".repeat(52),
    "  💛 Donate — if this tool has been useful:",
    "  ETH  : 0x134991f6A3f2F166383bA6B26a6a232e5729e46e",
    "  BTC  : bc1qnjlsdaq9egzzdsuq5l2s55698607g7jfrp6vqf",
    "  SOL  : 46V4wFh4EcpgUsYegkmzv3dC7NXTkcoZhVFNTTTCSbZz",
    "  TG   : t.me/FIREFLY2X2  |  @Lmangoo",
    "─".repeat(52),
    "",
  ], 40);
}

// ─── Ask wallet source interactively ─────────────────────────
async function askSource() {
  await printLines([
    "Select wallet source:",
    "  1. mnemonics.txt    — mnemonic file",
    "  2. privatekey.txt   — private key file",
    "",
  ], 30);
  return new Promise((res) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    let attempts = 0;
    const ask = () => {
      rl.question("Enter choice [1/2]: ", (answer) => {
        const val = answer.trim();
        if (val === "1" || val === "2") {
          rl.close();
          res(val);
        } else {
          attempts++;
          if (attempts >= 3) {
            rl.close();
            console.error("\n[ERROR] Too many invalid attempts. Exiting.");
            process.exit(1);
          }
          console.log(`Invalid choice. Please enter 1 or 2. (${3 - attempts} attempt${3 - attempts === 1 ? "" : "s"} left)`);
          ask();
        }
      });
    };
    ask();
  });
}

function askText(prompt) {
  return new Promise((res) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(prompt, (answer) => { rl.close(); res(answer.trim()); });
  });
}

// ─── Ask fetch mode interactively ────────────────────────────
async function askMode() {
  await printLines([
    "Select fetch mode:",
    "  1. Balance           — total balance across all chains",
    "  2. Balance by Chain  — balance broken down per chain",
    "  3. Balance DeFi      — total + DeFi protocol breakdown",
    "",
  ], 30);
  return new Promise((res) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    let attempts = 0;
    const map = { "1": "balance", "2": "balance_by_chain", "3": "balance_defi" };
    const ask = () => {
      rl.question("Enter choice [1/2/3]: ", (answer) => {
        const val = answer.trim();
        if (val === "1" || val === "2" || val === "3") {
          rl.close();
          res(map[val]);
        } else {
          attempts++;
          if (attempts >= 3) {
            rl.close();
            console.error("\n[ERROR] Too many invalid attempts. Exiting.");
            process.exit(1);
          }
          console.log(`Invalid choice. Please enter 1, 2, or 3. (${3 - attempts} attempt${3 - attempts === 1 ? "" : "s"} left)`);
          ask();
        }
      });
    };
    ask();
  });
}

// ─── Main (single address) ────────────────────────────────────
export async function mainSingleAddress(addr) {
  await printDonate();

  if (!addr || !/^0x[a-fA-F0-9]{40}$/.test(addr)) {
    console.error("[ERROR] Invalid address format. Usage: node index.js 0x...");
    process.exit(1);
  }

  MODE = await askMode();
  const modeLabel = { balance: "Balance", balance_by_chain: "Balance by Chain", balance_defi: "Balance DeFi" };
  await printLine(`\nCrypto Checker | Mode: ${modeLabel[MODE]} | Currency: ${CURRENCY.toUpperCase()} | Min: ${formatMoney(MIN_BALANCE)}\n`, 0);

  const filename1 = initResultFile();
  await printLine(`File : Result/${filename1}\n`, 30);

  const browser = await chromium.launch({ headless: true, args: ["--disable-blink-features=AutomationControlled"] });
  const ctx     = await createContext(browser);

  const wallet = { address: addr, privateKey: null, mnemonic: null, path: "-", source: "address" };

  try {
    const data = await scrapeAddress(ctx, addr);
    const { lines } = buildOutput(wallet, data);
    for (const l of lines) await printLine(l, 30);
    saveResult(lines);
  } catch (err) {
    console.error(`[ err  ] ${addr}  ${err.message}`);
  }

  await ctx.close();
  await browser.close();
  if (resultFilePath) await printLine(`\nResults saved to: ${resultFilePath}`, 0);
  await printFooter();
}

// ─── Main ─────────────────────────────────────────────────────
export async function main() {
  await printDonate();

  MODE = await askMode();

  const modeLabel = { balance: "Balance", balance_by_chain: "Balance by Chain", balance_defi: "Balance DeFi" };
  await sleep(200);
  await printLine(`\nCrypto Checker | Mode: ${modeLabel[MODE]} | Currency: ${CURRENCY.toUpperCase()} | Min: ${formatMoney(MIN_BALANCE)}\n`, 0);

  // Ask wallet source
  const srcChoice = await askSource();
  if (srcChoice === "1") {
    MNEMONIC_FILE    = "mnemonics.txt";
    PRIVATE_KEY_FILE = "";
    ADDRESS_SINGLE   = "";
  } else if (srcChoice === "2") {
    PRIVATE_KEY_FILE = "privatekey.txt";
    MNEMONIC_FILE    = "";
    ADDRESS_SINGLE   = "";
  } else if (srcChoice === "3") {
    const addr = await askText("Enter address (0x...): ");
    ADDRESS_SINGLE   = addr;
    MNEMONIC_FILE    = "";
    PRIVATE_KEY_FILE = "";
  }
  await printLine("", 0);

  const wallets = deriveAll();
  if (wallets.length === 0) {
    console.error("[ERROR] No wallets found. Set MNEMONIC_FILE, PRIVATE_KEY_FILE, or ADDRESS in .env");
    process.exit(1);
  }
  if (wallets._sourceLabel) await printLine(wallets._sourceLabel, 30);
  await printLine(`Total wallets  : ${wallets.length}`, 30);
  await printLine(`Concurrency    : ${CONCURRENCY} tab(s) × ${BROWSER_COUNT} browser(s) = ${CONCURRENCY * BROWSER_COUNT} parallel`, 30);
  await printLine("", 0);
  const filename2 = initResultFile();
  await printLine(`File : Result/${filename2}\n`, 30);

  // Launch multiple browsers at once
  const browsers = await Promise.all(
    Array.from({ length: BROWSER_COUNT }, () =>
      chromium.launch({
        headless: true,
        args: ["--disable-blink-features=AutomationControlled"],
      })
    )
  );

  // Distribute wallets evenly across browsers
  const chunkSize = Math.ceil(wallets.length / BROWSER_COUNT);
  const chunks    = Array.from({ length: BROWSER_COUNT }, (_, bi) =>
    wallets.slice(bi * chunkSize, (bi + 1) * chunkSize)
  );

  const startTime = Date.now();
  let found   = 0;
  const total = wallets.length;

  // Each browser processes its own chunk
  const browserTasks = chunks.map(async (chunk, bi) => {
    if (chunk.length === 0) return;
    const ctx = await createContext(browsers[bi]);

    for (let i = 0; i < chunk.length; i += CONCURRENCY) {
      const batch = chunk.slice(i, i + CONCURRENCY);

      const tasks = batch.map(async (wallet) => {
        try {
          const data = await scrapeAddress(ctx, wallet.address);
          const { lines, grandTotal } = buildOutput(wallet, data);
          return { wallet, lines, grandTotal };
        } catch (err) {
          return { wallet, error: err.message };
        }
      });

      const results = await Promise.all(tasks);

      // Print sequentially after all scraped
      for (const r of results) {
        if (r.error) {
          await printLine(`[ err  ] ${r.wallet.address}  ${r.error}`, 0);
        } else if (r.grandTotal >= MIN_BALANCE) {
          for (const l of r.lines) await printLine(l, 30);
          saveResult(r.lines);
          found++;
        } else {
          await printLine(`${r.wallet.address}  ${formatMoney(r.grandTotal)}`, 30);
        }
      }

      // Delay between batches to avoid rate limiting
      if (i + CONCURRENCY < chunk.length) await sleep(1000);
    }

    await ctx.close();
  });

  await Promise.all(browserTasks);

  // Close all browsers
  await Promise.all(browsers.map((b) => b.close()));

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  await printLine(`\nDone in ${elapsed}s | ${found}/${wallets.length} wallet(s) with balance`, 0);
  if (found > 0) await printLine(`Results saved to: ${resultFilePath}`, 0);
  await printFooter();
}
