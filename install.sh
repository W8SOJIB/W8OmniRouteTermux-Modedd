#!/bin/bash
set -e

echo ""
echo "╔══════════════════════════════════════════════════════╗"
echo "║     W8OmniRouteTermux-Modedd — Quick Installer        ║"
echo "║     Patched OmniRoute for Termux/Android             ║"
echo "╚══════════════════════════════════════════════════════╝"
echo ""

# Target version: use argument $1 if provided, otherwise latest
TARGET_VERSION="${1:-latest}"

# Ensure ~/.cache exists for Next.js on Android/Termux
mkdir -p "$HOME/.cache"
export XDG_CACHE_HOME="${XDG_CACHE_HOME:-$HOME/.cache}"

# ── Step 1: Install requirements ──────────────────────────────────────────
echo "[1/4] Checking Node.js, Git, and Esbuild..."
pkg install -y nodejs git esbuild 2>/dev/null || true

# ── Step 2: Install omniroute from npm (pre-built, fast) ──────────────────
echo "[2/4] Installing OmniRoute ($TARGET_VERSION) from npm..."
export PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
export NODE_OPTIONS="--max-old-space-size=512"

node --max-old-space-size=512 "$(npm root -g)/npm/bin/npm-cli.js" install -g "omniroute@$TARGET_VERSION" \
  --global-style --ignore-scripts --no-audit --no-fund --omit=dev --prefer-offline 2>/dev/null || \
npm install -g "omniroute@$TARGET_VERSION" --global-style --ignore-scripts --no-audit --no-fund --omit=dev

export OMNIROUTE_DIR
OMNIROUTE_DIR="$(npm root -g)/omniroute"
echo "      Installed at: $OMNIROUTE_DIR"

# ── Step 3: Apply all Termux/Android patches ──────────────────────────────
echo "[3/4] Applying Termux/Android patches..."

OMNIROUTE_DIR="$OMNIROUTE_DIR" node << 'PATCHEOF'
const fs   = require('fs');
const path = require('path');

const BASE = process.env.OMNIROUTE_DIR;
if (!BASE || !fs.existsSync(BASE)) {
  console.error('ERROR: Cannot find omniroute at: ' + BASE);
  process.exit(1);
}

const CHUNKS = path.join(BASE, 'dist', '.build', 'next', 'server', 'chunks');
const SSR    = path.join(CHUNKS, 'ssr');

let stats = { playwright: 0, bind: 0, instrumentation: 0, serve: 0, skipped: 0 };

/* ── PATCH A: Playwright → skip on Android ─────────────────────────────── */
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
}

/* ── PATCH B: sql.js named-parameter binding & no-op close ─────────────── */
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
  function processObject(obj) {
    const o = {};
    for (const [k, v] of Object.entries(obj)) {
      const sv = sanitize(v);
      const px = k[0];
      const isNamed = px === '@' || px === '$' || px === ':';
      const bare = isNamed ? k.slice(1) : k;
      o['@' + bare] = sv;
      o['$' + bare] = sv;
      o[':' + bare] = sv;
      o[bare] = sv;
    }
    return o;
  }
  if (Array.isArray(p)) {
    if (p.length === 1 && typeof p[0] === "object" && p[0] !== null && !Array.isArray(p[0]) && !(p[0] instanceof Uint8Array) && !Buffer.isBuffer(p[0])) {
      return processObject(p[0]);
    }
    return p.map(sanitize);
  }
  if (typeof p === "object" && !(p instanceof Uint8Array) && !Buffer.isBuffer(p)) {
    return processObject(p);
  }
  return sanitize(p);
}
`;

function patchBind(fp, fileName) {
  if (fileName.includes('sql-wasm') || fileName.startsWith('node_modules_sql_js')) return;

  let c = fs.readFileSync(fp, 'utf8');
  if (c.includes('__w8bindParams')) {
    const bindRegex = /(?:^|\n)function __w8bindParams\s*\([\s\S]*?\n\}\n/;
    if (bindRegex.test(c)) {
      c = c.replace(bindRegex, () => "\n" + BIND_HELPER.trim() + "\n");
      fs.writeFileSync(fp, c);
      stats.bind++;
    } else {
      stats.skipped++;
    }
    return;
  }

  const isSqljsAdapter = (
    (c.includes('sqljsAdapter') || c.includes('SqlJsAdapter') || c.includes('sql.js'))
    && c.includes('.prepare(')
    && c.includes('.free()')
    && !fileName.startsWith('node_modules')
  );
  if (!isSqljsAdapter) return;

  c = BIND_HELPER + c;
  c = c.replace(/\.bind\((\w+)\)/g, '.bind(__w8bindParams($1))');

  const closeRegex = /close\s*\(\)\s*\{\s*if\s*\(\s*clearInterval\([\w$]+\)\s*,\s*[\w$]+\s*&&\s*clearTimeout\([\w$]+\)\s*,\s*[\w$]+\s*\)\s*try\s*\{\s*[\w$]+\(\)\s*\}\s*catch(?:\([\w$]+\))?\s*\{\s*\}\s*try\s*\{\s*[\w$]+\.close\(\)\s*\}\s*catch(?:\([\w$]+\))?\s*\{\s*\}\s*[\w$]+\s*=\s*\!1\s*\}/g;
  c = c.replace(closeRegex, 'close(){}');

  fs.writeFileSync(fp, c);
  stats.bind++;
}

/* ── PATCH C: instrumentation-node → DB pre-init at registerNodejs start ─ */
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
      patchInstrumentation(fp);
    } catch (e) {}
  }
}

walkDir(CHUNKS);
walkDir(SSR);

const INSTR_JS = path.join(BASE, 'dist', '.build', 'next', 'server', 'instrumentation.js');
if (fs.existsSync(INSTR_JS)) {
  let c = fs.readFileSync(INSTR_JS, 'utf8');
  if (!c.includes("process.platform==='android'")) {
    c = "if(process.platform==='android'){try{Object.defineProperty(process,\'platform\',{value:\'linux\',configurable:true});}catch(e){}}\n" + c;
    fs.writeFileSync(INSTR_JS, c);
    stats.instrumentation++;
  }
}

const SERVE_MJS = path.join(BASE, 'bin', 'cli', 'commands', 'serve.mjs');
if (fs.existsSync(SERVE_MJS)) {
  let c = fs.readFileSync(SERVE_MJS, 'utf8');
  if (!c.includes('platform() !== "android"')) {
    c = c.replace(
      /if\s*\((\s*existsSync\(sqliteBinary\)\s*&&\s*!isNativeBinaryCompatible\(sqliteBinary\)\s*)\)/,
      'if (platform() !== "android" && $1)'
    );
    c = c.replace(
      /if\s*\(\s*!process\.versions\.bun\s*&&\s*existsSync\(sqliteBinary\)\s*&&\s*!isNativeBinaryCompatible\(sqliteBinary\)\s*\)/,
      'if (platform() !== "android" && !process.versions.bun && existsSync(sqliteBinary) && !isNativeBinaryCompatible(sqliteBinary))'
    );
    fs.writeFileSync(SERVE_MJS, c);
    stats.serve++;
  }
}

// Ensure sql.js WASM is reachable inside dist/node_modules
const distNodeModules = path.join(BASE, 'dist', 'node_modules');
const sqlJsSrc = path.join(BASE, 'node_modules', 'sql.js');
const sqlJsDest = path.join(distNodeModules, 'sql.js');
if (fs.existsSync(sqlJsSrc)) {
  if (!fs.existsSync(distNodeModules)) {
    try { fs.mkdirSync(distNodeModules, { recursive: true }); } catch (e) {}
  }
  if (!fs.existsSync(sqlJsDest)) {
    try {
      fs.symlinkSync(sqlJsSrc, sqlJsDest, 'junction');
    } catch {
      try { fs.cpSync(sqlJsSrc, sqlJsDest, { recursive: true }); } catch (e) {}
    }
  }
}

console.log('  Patch summary:');
console.log('    playwright fixes   : ' + stats.playwright);
console.log('    sqljsAdapter bind  : ' + stats.bind);
console.log('    instrumentation    : ' + stats.instrumentation);
console.log('    serve bypass       : ' + stats.serve);
console.log('    already patched    : ' + stats.skipped);
PATCHEOF

# ── Step 4: Install omniroute-update helper in Termux ─────────────────────
if [ -n "$PREFIX" ] && [ -d "$PREFIX/bin" ]; then
  cat > "$PREFIX/bin/omniroute-update" << 'EOF'
#!/bin/bash
curl -fsSL "https://raw.githubusercontent.com/W8SOJIB/W8OmniRouteTermux-Modedd/main/update.sh" | bash -s -- "$@"
EOF
  chmod +x "$PREFIX/bin/omniroute-update" 2>/dev/null || true
  echo "      Installed update tool: omniroute-update"
fi

echo ""
echo "[4/4] Verifying install..."
omniroute --version 2>/dev/null || true

echo ""
echo "╔══════════════════════════════════════════════════════╗"
echo "║  ✅ W8OmniRouteTermux-Modedd installed successfully!  ║"
echo "║                                                      ║"
echo "║  Start server:      omniroute serve                  ║"
echo "║  Dashboard:         http://localhost:20128           ║"
echo "║  Update anytime:    omniroute-update                 ║"
echo "║  Auto-update:       Also available in Web Dashboard  ║"
echo "╚══════════════════════════════════════════════════════╝"
echo ""
