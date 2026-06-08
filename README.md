# Crypto Checker

![Node.js](https://img.shields.io/badge/node-%3E%3D18-brightgreen)
![Stars](https://img.shields.io/github/stars/Lmangoo/Crypto-Checker?style=social)
![License](https://img.shields.io/github/license/Lmangoo/Crypto-Checker)
![Last Commit](https://img.shields.io/github/last-commit/Lmangoo/Crypto-Checker)

Wallet balance checker via DeBank — supports 100+ chains, DeFi protocols, mnemonic & private key derivation. No API key required.

---

## Features

- Derives wallet addresses from BIP-39 mnemonics or raw private keys
- Checks balances by intercepting DeBank browser responses
- Supports 100+ chains and DeFi protocol breakdown
- Interactive mode selection from console (wallet source + fetch mode)
- Parallel processing with multi-browser and multi-tab concurrency
- Filters results by minimum balance
- Saves output to timestamped files in `Result/`

---

## Requirements

- [Node.js](https://nodejs.org) **v18 or higher**
- npm (comes with Node.js)

---

## Installation

### 1. Navigate into the folder

```bash
cd "Crypto Checker"
```

### 2. Install dependencies

```bash
npm install
```

### 3. Install Playwright browser

```bash
npx playwright install chromium
```

> Only Chromium is needed (~150MB download).

### 4. Add your wallets

**Mnemonics** — create `mnemonics.txt`, one phrase per line:
```
word1 word2 word3 ... word12
word1 word2 word3 ... word12
```

**Private keys** — create `privatekey.txt`, one key per line:
```
0xabc123...
0xdef456...
```

### 5. Configure `.env` (optional)

```env
# Number of addresses to derive per mnemonic
DERIVE_COUNT=1
DERIVE_PATH=m/44'/60'/0'/0

# Currency
CURRENCY=usd

# Only save wallets with balance above this value (USD)
MIN_BALANCE=1

# Concurrency
BROWSER_COUNT=2
CONCURRENCY=3
```

---

## Usage

### Interactive mode — mnemonic or private key file

```bash
node index.js
# or
npm start
```

You will be prompted to select:
1. Wallet source (`mnemonics.txt` or `privatekey.txt`)
2. Fetch mode (Balance, Balance by Chain, or Balance DeFi)

Console will show invalid mnemonic count and total valid wallets before starting.

Output files are saved to `Result/` with format: `grand-total-defi-8-6-2026-02.04.58.txt`

### Single address mode

```bash
node index.js --address 0x4d26f0e78c154f8fda7acf6646246fa135507017
```

You will be prompted to select fetch mode only.

---

## Fetch Modes

| # | Mode | Description |
|---|------|-------------|
| 1 | Balance | Balance across all chains |
| 2 | Balance by Chain | Balance broken down per chain |
| 3 | Balance DeFi | Balance + per-protocol DeFi breakdown |

### Mode 1 — Balance

```
─────────────────────────────────────────────
Mnemonic : word1 word2 ... word12
PrivKey  : 0xabc123...
Address  : 0x7cad...e18
WALLET      $18.43
DeFi        $27.81
BALANCE     $46.24
─────────────────────────────────────────────
```

### Mode 2 — Balance by Chain

```
──────────────────────────────────────────────────
Mnemonic : word1 word2 ... word12
PrivKey  : 0xabc123...
Address  : 0x7cad...e18
BALANCE BY CHAIN
eth      $21.14
arb      $14.37
op       $8.92
base     $3.61
matic    $1.20
BALANCE  $49.24
──────────────────────────────────────────────────
```

### Mode 3 — Balance DeFi

```
────────────────────────────────────────────────────
Mnemonic : word1 word2 ... word12
PrivKey  : 0xabc123...
Address  : 0x7cad...e18
WALLET             $18.43
PROTOCOL / DeFi
Aave V3            $15.22
Uniswap V3         $9.44
Curve              $3.15
DeFi               $27.81
Protocol count     3
BALANCE            $46.24
────────────────────────────────────────────────────
```

> See `Result/example-*.txt` for full example output files.

---

## Concurrency Guide

| `BROWSER COUNT` | `CONCURRENCY` | Parallel | Notes |
|---|---|---|---|
| 1 | 1 | 1 | Safest, slowest |
| 1 | 3 | 3 | Good default |
| 2 | 3 | 6 | Fast, low risk |
| 3 | 3 | 9 | Faster, may hit rate limits |
| 3 | 5 | 15 | Aggressive, use with caution |

> Start with `BROWSER COUNT=2` and `CONCURRENCY=3`. Increase gradually if stable.

---

## Project Structure

```
Crypto Checker/
├── index.js              ← entry point
├── src/
│   └── checker.js        ← core logic
├── .env                  ← configuration
├── mnemonics.txt         ← list of mnemonics (one per line)
├── privatekey.txt        ← list of private keys (one per line)
└── Result/               ← output files saved here
```

---

## Donate

If this tool has been useful, consider sending a tip:

**ETH :** `0x134991f6A3f2F166383bA6B26a6a232e5729e46e`  
**BTC :** `bc1qnjlsdaq9egzzdsuq5l2s55698607g7jfrp6vqf`  
**SOL :** `46V4wFh4EcpgUsYegkmzv3dC7NXTkcoZhVFNTTTCSbZz`  
**TG  :** [t.me/FIREFLY2X2](https://t.me/FIREFLY2X2) · `@Lmangoo`

---

## Troubleshooting

**`File not found: mnemonics.txt`**
→ Create the file in the `Crypto Checker/` folder and add your mnemonics.

**`npx playwright install` fails**  
→ Make sure Node.js 18+ is installed.  
→ **macOS/Linux:** try with `sudo npx playwright install chromium`  
→ **Windows:** run Command Prompt or PowerShell as Administrator, then retry

**All wallets show `$0.00`**
→ DeBank may be rate-limiting. Lower `CONCURRENCY` and `BROWSER_COUNT`, or wait a few minutes before retrying.

**Browser crashes or hangs**
→ Set `BROWSER_COUNT=1` and `CONCURRENCY=1` to isolate the issue.

**`[ERROR] Unknown argument`**
→ Use the correct format: `node index.js --address 0x...`
