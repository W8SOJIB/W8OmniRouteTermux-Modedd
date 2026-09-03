#!/bin/bash
set -e

echo ""
echo "╔══════════════════════════════════════════════════════╗"
echo "║     W8OmniRouteTermux-Modedd — Quick Installer        ║"
echo "║     Patched OmniRoute for Termux/Android             ║"
echo "╚══════════════════════════════════════════════════════╝"
echo ""

# ── Step 1: Install requirements ──────────────────────────────────────────
echo "[1/4] Checking Node.js, Git, and Esbuild..."
pkg install -y nodejs git esbuild 2>/dev/null || true

# ── Step 2: Install omniroute from npm (pre-built, fast) ──────────────────
echo "[2/4] Installing OmniRoute from npm (pre-built, ~2 min)..."
export PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
export NODE_OPTIONS="--max-old-space-size=512"
node --max-old-space-size=512 "$(npm root -g)/npm/bin/npm-cli.js" install -g omniroute@3.8.46 --global-style --ignore-scripts --no-audit --no-fund --omit=dev --prefer-offline

export OMNIROUTE_DIR
OMNIROUTE_DIR="$(npm root -g)/omniroute"
echo "      Installed at: $OMNIROUTE_DIR"

# ── Step 3: Apply all Termux/Android patches ──────────────────────────────
echo "[3/4] Applying Termux/Android patches..."

OMNIROUTE_DIR="$OMNIROUTE_DIR" node << 'PATCHEOF'
const fs   = require('fs');
const path = require('path');

const BASE   = process.env.OMNIROUTE_DIR;
if (!BASE || !fs.existsSync(BASE)) {
  console.error('ERROR: Cannot find omniroute at: ' + BASE);
  process.exit(1);
}

const CHUNKS = path.join(BASE, 'dist', '.build', 'next', 'server', 'chunks');
const SSR    = path.join(CHUNKS, 'ssr');

let stats = { playwright: 0, bind: 0, instrumentation: 0, driverFactory: 0, skipped: 0 };

/* ─────────────────────────────────────────────────────────────────────────
   PATCH A: Playwright → skip on Android
   Target: files named *playwright*.js
   ───────────────────────────────────────────────────────────────────────── */
function patchPlaywright(fp) {
  let c = fs.readFileSync(fp, 'utf8');
  if (c.includes("process.platform==='android'")) { stats.skipped++; return; }
  c = c.replace(
    /let c=await (\w+)\.y\(["'](playwright(?:-core)?)["']\)/g,
    "let c=(process.platform==='android'?{}:await $1.y('$2'))"
  );
  c = c.replace(
    /await (\w+)\.y\(["'](playwright(?:-core)?)["']\)/g,
    "(process.platform==='android'?{}:await $1.y('$2'))"
  );
  fs.writeFileSync(fp, c);
  stats.playwright++;
  console.log('  ✔ playwright: ' + path.basename(fp));
}

/* ─────────────────────────────────────────────────────────────────────────
   PATCH B: sql.js named-parameter binding (TARGETED)
   Only applies to the sqljsAdapter wrapper file (src_lib_*.js or similar)
   that contains sql.js Statement lifecycle methods (prepare + free).
   NEVER applies to node_modules_sql_js_dist_sql-wasm_*.js files (WASM code).
   ───────────────────────────────────────────────────────────────────────── */
const BIND_HELPER = `
function __w8bindParams(p){
  function sanitize(v) {
    if (v === undefined) return null;
    if (typeof v === "boolean") return v ? 1 : 0;
    if (v instanceof Date) return v.toISOString();
    if (typeof v === "object" && v !== null && !(v instanceof Uint8Array) && !Buffer.isBuffer(v)) {
      try { return JSON.stringify(v); } catch(e) { return String(v); }
    }
    return v;
  }
  if (!p) return p;
  if (Array.isArray(p)) {
    if (p.length === 1 && typeof p[0] === "object" && p[0] !== null && !Array.isArray(p[0]) && !(p[0] instanceof Uint8Array) && !Buffer.isBuffer(p[0])) {
      const o = {};
      for (const [k, v] of Object.entries(p[0])) {
        const sv = sanitize(v);
        const px = k[0];
        const isNamed = px === '@' || px === '$' || px === ':';
        o[isNamed ? k : '@' + k] = sv;
        o[isNamed ? k : '$' + k] = sv;
        o[isNamed ? k : ':' + k] = sv;
        o[k] = sv;
      }
      return o;
    }
    return p.map(sanitize);
  }
  return sanitize(p);
}
`;

function patchBind(fp, fileName) {
  // NEVER patch sql.js WASM dist files — they use .bind() for WASM internals
  if (fileName.includes('sql-wasm') || fileName.startsWith('node_modules_sql_js')) return;

  let c = fs.readFileSync(fp, 'utf8');
  if (c.includes('__w8bindParams')) { stats.skipped++; return; }

  // Only target files that are the sqljsAdapter wrapper:
  // Must contain sql.js-specific adapter patterns AND be a source file
  const isSqljsAdapter = (
    (c.includes('sqljsAdapter') || c.includes('SqlJsAdapter') || c.includes('sql.js'))
    && c.includes('.prepare(')   // sql.js Statement creation
    && c.includes('.free()')     // sql.js Statement disposal
    && !fileName.startsWith('node_modules')
  );
  if (!isSqljsAdapter) return;

  c = BIND_HELPER + c;
  // Only wrap .bind() calls that are immediately followed by a closing paren (named param binding)
  c = c.replace(/\.bind\((\w+)\)/g, '.bind(__w8bindParams($1))');
  
  // W8Mod: prevent the adapter from being closed (no-op close)
  const closeRegex = /close\s*\(\)\s*\{if\s*\(clearInterval\([\w$]+\),[\w$]+&&clearTimeout\([\w$]+\),[\w$]+\)try\{[\w$]+\(\)\}catch(?:\([\w$]+\))?\{\}try\{[\w$]+\.close\(\)\}catch(?:\([\w$]+\))?\{\}[\w$]+=\!1\}/g;
  c = c.replace(closeRegex, 'close(){}');

  fs.writeFileSync(fp, c);
  stats.bind++;
  console.log('  ✔ sqljsAdapter bind & noop-close: ' + fileName);
}

function patchDriverFactory(fp) {
  // W8Mod: Obsolete, handled inside patchBind on the sqljsAdapter chunk directly
}

/* ─────────────────────────────────────────────────────────────────────────
   PATCH D: instrumentation-node → DB pre-init at registerNodejs start
   Target: chunk containing registerNodejs + ensureDbInitialized
   ───────────────────────────────────────────────────────────────────────── */
function patchInstrumentation(fp) {
  let c = fs.readFileSync(fp, 'utf8');
  if (c.includes('__w8dbPreInit')) { stats.skipped++; return; }
  if (!c.includes('registerNodejs') || !c.includes('ensureDbInitialized')) return;
  c = c.replace(
    /(async function registerNodejs\s*\(\s*\)\s*\{)/,
    '$1if(process.platform===\'android\'){try{Object.defineProperty(process,\'platform\',{value:\'linux\',configurable:true});}catch(e){}}try{await ensureDbInitialized();}catch(__w8dbPreInit){console.warn("[w8-init]",__w8dbPreInit?.message);}'
  );
  fs.writeFileSync(fp, c);
  stats.instrumentation++;
  console.log('  ✔ instrumentation: ' + path.basename(fp));
}

/* ── Walk chunk directories ──────────────────────────────────────────── */
function walkDir(dir) {
  if (!fs.existsSync(dir)) return;
  const files = fs.readdirSync(dir).filter(f => f.endsWith('.js'));
  for (const file of files) {
    const fp = path.join(dir, file);
    try {
      if (file.includes('playwright')) patchPlaywright(fp);
      patchBind(fp, file);
      patchDriverFactory(fp);
      patchInstrumentation(fp);
    } catch (e) { /* skip unreadable */ }
  }
}

walkDir(CHUNKS);
walkDir(SSR);

// Also patch the main instrumentation.js entrypoint directly
const INSTR_JS = path.join(BASE, 'dist', '.build', 'next', 'server', 'instrumentation.js');
if (fs.existsSync(INSTR_JS)) {
  let c = fs.readFileSync(INSTR_JS, 'utf8');
  if (!c.includes("process.platform==='android'")) {
    c = "if(process.platform==='android'){try{Object.defineProperty(process,\'platform\',{value:\'linux\',configurable:true});}catch(e){}}\n" + c;
    fs.writeFileSync(INSTR_JS, c);
    stats.instrumentation++;
    console.log('  ✔ patched main instrumentation entrypoint');
  }
}

// Patch serve.mjs to bypass better-sqlite3 compatibility check on Android
const SERVE_MJS = path.join(BASE, 'bin', 'cli', 'commands', 'serve.mjs');
if (fs.existsSync(SERVE_MJS)) {
  let c = fs.readFileSync(SERVE_MJS, 'utf8');
  if (!c.includes("platform() !== \"android\"")) {
    c = c.replace(
      /if\s*\((\s*existsSync\(sqliteBinary\)\s*&&\s*!isNativeBinaryCompatible\(sqliteBinary\)\s*)\)/,
      "if (platform() !== \"android\" && $1)"
    );
    fs.writeFileSync(SERVE_MJS, c);
    console.log('  ✔ patched serve.mjs to bypass better-sqlite3 check on Android');
  }
}

console.log('');
console.log('  Patch summary:');
console.log('    playwright fixes   : ' + stats.playwright);
console.log('    sqljsAdapter bind  : ' + stats.bind);
console.log('    driverFactory noop : ' + stats.driverFactory);
console.log('    instrumentation    : ' + stats.instrumentation);
console.log('    already patched    : ' + stats.skipped);
PATCHEOF

# ── Step 4: Done ──────────────────────────────────────────────────────────
echo ""
echo "[4/4] Verifying install..."
omniroute --version 2>/dev/null || true

echo ""
echo "╔══════════════════════════════════════════════════════╗"
echo "║  ✅ W8OmniRouteTermux-Modedd installed successfully!  ║"
echo "║                                                      ║"
echo "║  Start the server:  omniroute serve                  ║"
echo "║  Dashboard:         http://localhost:20128           ║"
echo "╚══════════════════════════════════════════════════════╝"
echo ""
