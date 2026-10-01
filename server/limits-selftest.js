#!/usr/bin/env node
/**
 * Tiny self-check for classifySimklResponse + NY midnight helper.
 * Run: node limits-selftest.js
 */
process.env.SIMKL_SELFTEST = "1";
await import("./index.js");
