#!/usr/bin/env node
/**
 * Seeds the Worker's KV word-list store from content/wordlists/*.txt.
 *
 * Each file becomes its own `source` batch, POSTed to /api/admin/wordlist —
 * the same endpoint admin.html uses, so this is equivalent to pasting each
 * file's contents into the admin page by hand. Safe to re-run: each source
 * overwrites its own KV entry (reading:dustin:wordlist:{source}).
 *
 * Usage:
 *   ADMIN_PASSCODE=xxxx node scripts/seed-wordlists.mjs
 *   node scripts/seed-wordlists.mjs --passcode xxxx
 *   node scripts/seed-wordlists.mjs --worker-origin https://other-host --passcode xxxx
 */

import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WORDLISTS_DIR = path.join(__dirname, "..", "content", "wordlists");
const DEFAULT_WORKER_ORIGIN = "https://reader-app-worker.erica-jarman.workers.dev";

function parseArgs(argv) {
  const args = { passcode: process.env.ADMIN_PASSCODE || "", workerOrigin: DEFAULT_WORKER_ORIGIN };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--passcode") args.passcode = argv[++i];
    else if (argv[i] === "--worker-origin") args.workerOrigin = argv[++i];
  }
  return args;
}

async function main() {
  const { passcode, workerOrigin } = parseArgs(process.argv.slice(2));
  if (!passcode) {
    console.error("Missing admin passcode. Set ADMIN_PASSCODE or pass --passcode <value>.");
    process.exit(1);
  }

  const files = (await readdir(WORDLISTS_DIR)).filter((f) => f.endsWith(".txt"));
  if (!files.length) {
    console.error(`No .txt word list files found in ${WORDLISTS_DIR}`);
    process.exit(1);
  }

  let failures = 0;
  for (const file of files) {
    const source = path.basename(file, ".txt");
    const words = await readFile(path.join(WORDLISTS_DIR, file), "utf8");
    process.stdout.write(`Seeding "${source}"... `);
    try {
      const res = await fetch(`${workerOrigin}/api/admin/wordlist`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Admin-Passcode": passcode },
        body: JSON.stringify({ source, words }),
      });
      const data = await res.json();
      if (!res.ok) {
        failures++;
        console.log(`FAILED (${res.status}): ${data.error || "unknown error"}`);
      } else {
        console.log(`ok — ${data.wordCount} word(s)`);
      }
    } catch (err) {
      failures++;
      console.log(`FAILED: ${err.message}`);
    }
  }

  if (failures) {
    console.error(`\n${failures} of ${files.length} list(s) failed to seed.`);
    process.exit(1);
  }
  console.log(`\nAll ${files.length} word list(s) seeded successfully.`);
}

main();
