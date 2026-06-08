#!/usr/bin/env node
/**
 * index.js — Entry point Crypto Checker
 * Usage:
 *   node index.js                        — interactive mode (mnemonic / privatekey)
 *   node index.js --address 0x123...     — check a single address
 */

import { main, mainSingleAddress } from "./src/checker.js";

const args = process.argv.slice(2);

// Only support: node index.js --address 0x...
const addrFlagIdx = args.indexOf("--address");
const singleAddress = addrFlagIdx !== -1 ? args[addrFlagIdx + 1] || null : null;

// Reject unrecognized arguments
if (args.length > 0 && addrFlagIdx === -1) {
  console.error(`[ERROR] Unknown argument: "${args[0]}"`);
  console.error("Usage:");
  console.error("  node index.js                          — interactive mode");
  console.error("  node index.js --address 0x...          — single address");
  process.exit(1);
}

if (singleAddress) {
  mainSingleAddress(singleAddress).catch(console.error);
} else {
  main().catch(console.error);
}
