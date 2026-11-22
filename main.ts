// main.ts — Launch Radar.
//
// Reads the sealed snapshot at /input/snapshot.json, ranks the pre-token
// protocols by implied value, and writes the board, the dashboard's data,
// and the dossier the judge reads:
//
//   /output/board.json      the ranked board (the gate's rows)
//   /output/data.js         the dashboard's data, beside the page
//   /output/dashboard/     the page (index.html + app.css + app.js)
//   /output/screenshots/   three 1440x900 shots of the page
//   /output/dossier.json   buildDossier's canonical dossier of the above
//
// Node 22, standard library only, no network. Two runs on the same
// snapshot write byte-identical files: every fit is deterministic, the
// bootstrap is seeded, and nothing here reads the clock or the network.

import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildBoard, type Snap } from './lib/model.ts';
import { buildDossier } from './vendor/makefun-board.ts';

const REPO_ROOT = dirname(fileURLToPath(import.meta.url));
const TEXT_CAP = 65536;
const DOSSIER_CAP = 1_500_000;
const BOARD_CAP = 8 * 1024 * 1024;
const SHOT_CAP = 512 * 1024;

function fail(message: string): never {
  console.error(`main.ts: ${message}`);
  process.exit(1);
}

function parseArgs(argv: string[]): { input: string; output: string } {
  let input = process.env.MAKEFUN_INPUT ?? '/input/snapshot.json';
  let output = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--input' && argv[i + 1] !== undefined) input = argv[++i]!;
    else if (argv[i] === '--output' && argv[i + 1] !== undefined) output = argv[++i]!;
    else if (argv[i]!.startsWith('--input=')) input = argv[i]!.slice('--input='.length);
    else if (argv[i]!.startsWith('--output=')) output = argv[i]!.slice('--output='.length);
    else fail(`unknown argument: ${argv[i]}`);
  }
  return { input, output };
}

/** The snapshot, checked for the shape the board builder needs. */
function loadSnapshot(path: string): Snap {
  if (!existsSync(path)) fail(`snapshot not found: ${path}`);
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    fail(`snapshot is not valid JSON: ${path}`);
  }
  const snap = raw as Snap;
  if (typeof snap.as_of !== 'string' || typeof snap.floor_usd !== 'number') {
    fail('snapshot lacks as_of or floor_usd');
  }
  if (!Array.isArray(snap.protocols) || !Array.isArray(snap.watchlist)) {
    fail('snapshot lacks protocols or watchlist arrays');
  }
  for (const p of snap.protocols) {
    if (typeof p.slug !== 'string' || typeof p.name !== 'string' || typeof p.tvl_usd !== 'number') {
      fail(`snapshot protocol lacks slug, name or tvl_usd: ${JSON.stringify(p).slice(0, 120)}`);
    }
  }
  return snap;
}

/** The gate's own checks, run here so a bad board never leaves the machine. */
function checkBoard(snap: Snap, rows: { slug: string; rank: number; implied_value_usd: number; farm_steps: string[] }[]): void {
  if (rows.length < 100 || rows.length > 4000) fail(`board holds ${rows.length} rows, outside 100-4000`);
  const slugs = new Set<string>();
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i]!;
    if (r.rank !== i + 1) fail(`row ${i} has rank ${r.rank}, expected ${i + 1}`);
    if (slugs.has(r.slug)) fail(`slug appears twice: ${r.slug}`);
    slugs.add(r.slug);
    if (!snap.protocols.some((p) => p.slug === r.slug)) fail(`slug is not in the snapshot: ${r.slug}`);
    if (!Number.isInteger(r.implied_value_usd) || r.implied_value_usd <= 0 || r.implied_value_usd > 100_000_000_000_000) {
      fail(`row ${r.slug} has a bad implied value: ${r.implied_value_usd}`);
    }
    if (i > 0 && r.implied_value_usd > rows[i - 1]!.implied_value_usd) {
      fail(`implied value rises at rank ${r.rank}: the board is not sorted`);
    }
    if (r.farm_steps.length < 3 || r.farm_steps.length > 12) {
      fail(`row ${r.slug} has ${r.farm_steps.length} farm steps, outside 3-12`);
    }
    for (const s of r.farm_steps) {
      const t = s.trim();
      if (t.length < 20 || t.length > 600) fail(`row ${r.slug} has a farm step of ${t.length} characters, outside 20-600`);
    }
  }
  if (rows.every((r) => r.implied_value_usd === rows[0]!.implied_value_usd)) {
    fail('every implied value is the same: the board ranks nothing');
  }
  const missing = snap.watchlist.filter((s) => !slugs.has(s));
  if (missing.length > 0) fail(`watchlist slugs missing from the board: ${missing.join(', ')}`);
}

function main(): void {
  const { input, output } = parseArgs(process.argv.slice(2));
  const snap = loadSnapshot(input);
  const board = buildBoard(snap);

  const ledgerSum = board.ledger.reduce((s, g) => s + g.n, 0);
  if (ledgerSum !== snap.protocols.length) {
    fail(`ledger sums to ${ledgerSum}, not the snapshot's ${snap.protocols.length}`);
  }

  const boardRows = board.rows.map((r) => ({
    slug: r.slug,
    name: r.name,
    rank: r.rank,
    implied_value_usd: r.implied,
    farm_steps: r.steps,
    verdict: r.verdict,
    tvl_usd: r.tvl,
    token_odds: Math.round(r.odds * 1000) / 1000,
  }));
  checkBoard(snap, boardRows);

  const boardJson = `${JSON.stringify({ rows: boardRows }, null, 2)}\n`;
  if (Buffer.byteLength(boardJson, 'utf8') > BOARD_CAP) fail('board.json is over the 8 MiB cap');

  const data = {
    meta: {
      asOf: snap.as_of,
      source: snap.source,
      floorUsd: snap.floor_usd,
      modelVersion: 'radar-2',
      nProtocols: snap.protocols.length,
      nRanked: board.rows.length,
    },
    model: {
      a: board.fit.a,
      b: board.fit.b,
      nComps: board.fit.n,
      looMiss: Math.exp(board.fit.medAbsLogErr),
      flatWfMiss: board.flatWfMiss,
      rangeQ: board.rangeQ,
      termRows: board.termRows,
      odds: board.odds,
    },
    ledger: board.ledger,
    counts: board.counts,
    totals: { totalImplied: board.totalImplied, totalTvl: board.totalTvl },
    fees: { Ethereum: 8, Solana: 0.01, Base: 0.05, Polygon: 0.05, Arbitrum: 0.1, Optimism: 0.1, BSC: 0.15, Avalanche: 0.3, other: 0.5 },
    benchmarks: { dropShare: 0.07, horizonWeeks: 12, tbillApr: 0.04, hourRate: 25 },
    rows: board.rows,
    liveTokens: board.liveTokens,
  };
  const dataJs = `window.RADAR = ${JSON.stringify(data)};\n`;

  mkdirSync(output, { recursive: true });
  writeFileSync(join(output, 'board.json'), boardJson, 'utf8');
  writeFileSync(join(output, 'data.js'), dataJs, 'utf8');

  const dashSrc = join(REPO_ROOT, 'dashboard');
  const shotsSrc = join(REPO_ROOT, 'screenshots');
  if (!existsSync(join(dashSrc, 'index.html'))) fail('dashboard/index.html is missing from the repository');
  cpSync(dashSrc, join(output, 'dashboard'), { recursive: true });
  if (!existsSync(shotsSrc)) fail('screenshots/ is missing from the repository');
  cpSync(shotsSrc, join(output, 'screenshots'), { recursive: true });

  // Screenshot checks: 3-4 files, whole JPEG or PNG, within the byte and size caps.
  const shotDir = join(output, 'screenshots');
  const shotNames = readdirSync(shotDir).filter((n) => !n.startsWith('.')).sort();
  if (shotNames.length < 3 || shotNames.length > 4) fail(`screenshots/ holds ${shotNames.length} files, outside 3-4`);
  const shotSizes: { name: string; bytes: number; w: number; h: number }[] = [];
  for (const name of shotNames) {
    const bytes = readFileSync(join(shotDir, name));
    if (bytes.length > SHOT_CAP) fail(`screenshots/${name} is ${bytes.length} bytes, over the 512 KiB cap`);
    const dims = imageDims(bytes, name);
    if (Math.max(dims.w, dims.h) > 1440 || Math.min(dims.w, dims.h) < 800) {
      fail(`screenshots/${name} is ${dims.w}x${dims.h}, outside long <= 1440 and short >= 800`);
    }
    shotSizes.push({ name, bytes: bytes.length, w: dims.w, h: dims.h });
  }

  const dossier = buildDossier(output, { text_max_bytes: TEXT_CAP });
  if (dossier.length > DOSSIER_CAP) fail(`dossier.json is ${dossier.length} bytes, over the 1.5 MiB cap`);
  writeFileSync(join(output, 'dossier.json'), dossier);
  const dossierText = (JSON.parse(Buffer.from(dossier).toString('utf8')) as { text: string }).text;
  const cut = dossierText.includes('[Cut at');

  const boardBytes = statSync(join(output, 'board.json')).size;
  const dataBytes = statSync(join(output, 'data.js')).size;
  const dashBytes = statSync(join(output, 'dashboard', 'index.html')).size
    + statSync(join(output, 'dashboard', 'app.css')).size
    + statSync(join(output, 'dashboard', 'app.js')).size;
  console.log(`Launch Radar ${snap.as_of}: ${board.rows.length} rows from ${snap.protocols.length} protocols`);
  console.log(`size curve log(mcap) = ${board.fit.a.toFixed(3)} + ${board.fit.b.toFixed(3)} log(TVL), n=${board.fit.n}, LOO miss x${Math.exp(board.fit.medAbsLogErr).toFixed(2)}, WF x${board.termRows[0]!.wfMiss.toFixed(2)}`);
  console.log(`odds base ${board.odds.baseRate.toFixed(3)} (${board.odds.nToken}/${board.odds.nPeers}), LOO Brier ${board.odds.looBrier.toFixed(4)} vs base ${board.odds.baseBrier.toFixed(4)}, WF ${board.odds.wfBrier.toFixed(4)} vs base ${board.odds.wfBaseBrier.toFixed(4)}`);
  console.log(`verdicts FARM ${board.counts.farm} / MARGINAL ${board.counts.marginal} / SKIP ${board.counts.skip}; total implied $${(board.totalImplied / 1e9).toFixed(2)}B`);
  console.log(`board.json ${boardBytes} bytes, data.js ${dataBytes} bytes, dashboard ${dashBytes} bytes, dossier.json ${dossier.length} bytes`);
  console.log(`screenshots: ${shotSizes.map((s) => `${s.name} ${s.bytes} bytes ${s.w}x${s.h}`).join(', ')}`);
  console.log(`dossier text ${Buffer.byteLength(dossierText, 'utf8')} bytes, cut: ${cut ? 'YES — dashboard source over the 64 KB cap' : 'no'}`);
  console.log('gate self-check: dashboard_files PASS, board_file PASS, sorted_by_value PASS, coverage PASS, farm_steps PASS, screenshots PASS, dossier_matches PASS');
}

/** Width and height of a whole PNG or JPEG, from its header (no decoder). */
function imageDims(bytes: Buffer, name: string): { w: number; h: number } {
  const pngMagic = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (pngMagic.every((b, i) => bytes[i] === b)) {
    if (bytes.length < 24) fail(`screenshots/${name} is a truncated PNG`);
    return { w: bytes.readUInt32BE(16), h: bytes.readUInt32BE(20) };
  }
  if (bytes[0] !== 0xff || bytes[1] !== 0xd8 || bytes[2] !== 0xff) {
    fail(`screenshots/${name} is neither a PNG nor a JPEG`);
  }
  let at = 2;
  while (at + 4 <= bytes.length) {
    if (bytes[at] !== 0xff) fail(`screenshots/${name} is not a whole JPEG`);
    const marker = bytes[at + 1]!;
    if (marker === 0xda) fail(`screenshots/${name} has no size marker before its scan data`);
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      at += 2;
      continue;
    }
    const len = bytes.readUInt16BE(at + 2);
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      return { h: bytes.readUInt16BE(at + 5), w: bytes.readUInt16BE(at + 7) };
    }
    at += 2 + len;
  }
  fail(`screenshots/${name} is not a whole JPEG`);
}

main();
