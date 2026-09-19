#!/bin/bash
set -e

# ==============================================================================
# W8OmniRouteTermux-Modedd — Auto-Updater for Termux / Android
# Checks for updates from upstream/npm, installs, and re-applies Termux patches.
# Usage:
#   ./update.sh           (interactive / manual update)
#   ./update.sh --auto    (non-interactive, suitable for cron / boot tasks)
#   ./update.sh --force   (force reinstall/re-patch even if version is current)
# ==============================================================================

AUTO_MODE=0
FORCE_MODE=0

for arg in "$@"; do
  case "$arg" in
    --auto|--yes|-y) AUTO_MODE=1 ;;
    --force|-f) FORCE_MODE=1 ;;
  esac
done

if [ "$AUTO_MODE" -eq 0 ]; then
  echo ""
  echo "╔══════════════════════════════════════════════════════╗"
  echo "║     W8OmniRouteTermux-Modedd — Updater for Termux    ║"
  echo "╚══════════════════════════════════════════════════════╝"
  echo ""
fi

# Ensure ~/.cache exists for Next.js on Android/Termux
mkdir -p "$HOME/.cache"
export XDG_CACHE_HOME="${XDG_CACHE_HOME:-$HOME/.cache}"
export PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
export NODE_OPTIONS="--max-old-space-size=512"

# 1. Detect environment
IS_SOURCE=0
if [ -f "./package.json" ] && [ -d "./src" ]; then
  IS_SOURCE=1
fi

OMNIROUTE_GLOBAL_DIR=""
if command -v npm >/dev/null 2>&1; then
  NPM_ROOT="$(npm root -g 2>/dev/null || true)"
  if [ -n "$NPM_ROOT" ] && [ -d "$NPM_ROOT/omniroute" ]; then
    OMNIROUTE_GLOBAL_DIR="$NPM_ROOT/omniroute"
  fi
fi

# 2. Check current version
CURRENT_VERSION="unknown"
if command -v omniroute >/dev/null 2>&1; then
  CURRENT_VERSION="$(omniroute --version 2>/dev/null || echo "unknown")"
elif [ "$IS_SOURCE" -eq 1 ]; then
  CURRENT_VERSION="$(node -p "try { require('./package.json').version } catch(e) { 'unknown' }" 2>/dev/null || echo "unknown")"
fi

# 3. Check latest version from npm
LATEST_VERSION=""
if command -v npm >/dev/null 2>&1; then
  LATEST_VERSION="$(npm view omniroute version 2>/dev/null || true)"
fi

if [ -z "$LATEST_VERSION" ]; then
  echo "⚠️  Could not fetch latest version from npm registry."
  if [ "$FORCE_MODE" -eq 0 ]; then
    echo "    Check internet connection or use --force to retry."
    exit 1
  fi
  LATEST_VERSION="latest"
fi

if [ "$AUTO_MODE" -eq 0 ]; then
  echo "  Current version: $CURRENT_VERSION"
  echo "  Latest version:  $LATEST_VERSION"
fi

# Check if update is needed
if [ "$FORCE_MODE" -eq 0 ] && [ "$CURRENT_VERSION" != "unknown" ] && [ "$CURRENT_VERSION" = "$LATEST_VERSION" ]; then
  if [ "$AUTO_MODE" -eq 0 ]; then
    echo "  ✔ Already on the latest version ($CURRENT_VERSION). No update needed."
  fi
  exit 0
fi

if [ "$AUTO_MODE" -eq 0 ]; then
  echo ""
  echo "🚀 Updating to v$LATEST_VERSION..."
fi

# 4. Perform Update
if [ "$IS_SOURCE" -eq 1 ] && [ -d "./.git" ]; then
  # Source checkout update
  echo "  [1/3] Fetching and merging latest code..."
  git fetch --tags origin 2>/dev/null || git fetch --tags upstream 2>/dev/null || true
  git checkout "v$LATEST_VERSION" 2>/dev/null || git pull --ff-only 2>/dev/null || true

  echo "  [2/3] Installing dependencies and building..."
  npm install --omit=dev --legacy-peer-deps --prefer-offline 2>/dev/null || npm install --legacy-peer-deps
  npm run build

  echo "  [3/3] Applying Termux compatibility patches..."
  if [ -f "./scripts/build/patchTermux.mjs" ]; then
    node ./scripts/build/patchTermux.mjs "$PWD"
  fi
else
  # Global npm package update
  echo "  [1/3] Installing omniroute@$LATEST_VERSION globally..."
  node --max-old-space-size=512 "$(npm root -g)/npm/bin/npm-cli.js" install -g "omniroute@$LATEST_VERSION" \
    --global-style --ignore-scripts --no-audit --no-fund --omit=dev --prefer-offline 2>/dev/null || \
  npm install -g "omniroute@$LATEST_VERSION" --global-style --ignore-scripts --no-audit --no-fund --omit=dev

  OMNIROUTE_DIR="$(npm root -g)/omniroute"

  echo "  [2/3] Applying Termux compatibility patches to $OMNIROUTE_DIR..."
  
  # Use patchTermux.mjs if available in current dir or script dir
  SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
  if [ -f "$SCRIPT_DIR/scripts/build/patchTermux.mjs" ]; then
    node "$SCRIPT_DIR/scripts/build/patchTermux.mjs" "$OMNIROUTE_DIR"
  else
    # Inline fallback patcher
    OMNIROUTE_DIR="$OMNIROUTE_DIR" node - <<'INLINE_PATCH'
    const fs = require('fs');
    const path = require('path');
    const base = process.env.OMNIROUTE_DIR;
    if (!base || !fs.existsSync(base)) process.exit(0);

    const chunks = path.join(base, 'dist', '.build', 'next', 'server', 'chunks');
    const ssr = path.join(chunks, 'ssr');

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

    function walkDir(dir) {
      if (!fs.existsSync(dir)) return;
      for (const f of fs.readdirSync(dir).filter(x => x.endsWith('.js'))) {
        const fp = path.join(dir, f);
        try {
          let c = fs.readFileSync(fp, 'utf8');
          let m = false;
          if (f.includes('playwright') && !c.includes("process.platform==='android'")) {
            c = c.replace(/let c=await (\w+)\.y\(["'](playwright(?:-core)?)["']\)/g, "let c=(process.platform==='android'?{}:await $1.y('$2'))");
            c = c.replace(/await (\w+)\.y\(["'](playwright(?:-core)?)["']\)/g, "(process.platform==='android'?{}:await $1.y('$2'))");
            m = true;
          }
          if ((c.includes('sqljsAdapter') || c.includes('SqlJsAdapter')) && c.includes('.prepare(')) {
            if (c.includes('__w8bindParams')) {
              const bindRegex = /(?:^|\n)function __w8bindParams\s*\([\s\S]*?\n\}\n/;
              if (bindRegex.test(c)) {
                c = c.replace(bindRegex, () => "\n" + BIND_HELPER.trim() + "\n");
                m = true;
              }
            } else {
              c = BIND_HELPER + c;
              c = c.replace(/\.bind\((\w+)\)/g, '.bind(__w8bindParams($1))');
              const closeRegex = /close\s*\(\)\s*\{\s*if\s*\(\s*clearInterval\([\w$]+\)\s*,\s*[\w$]+\s*&&\s*clearTimeout\([\w$]+\)\s*,\s*[\w$]+\s*\)\s*try\s*\{\s*[\w$]+\(\)\s*\}\s*catch(?:\([\w$]+\))?\s*\{\s*\}\s*try\s*\{\s*[\w$]+\.close\(\)\s*\}\s*catch(?:\([\w$]+\))?\s*\{\s*\}\s*[\w$]+\s*=\s*\!1\s*\}/g;
              c = c.replace(closeRegex, 'close(){}');
              m = true;
            }
          }
          if (c.includes('registerNodejs') && c.includes('ensureDbInitialized') && !c.includes('__w8dbPreInit')) {
            c = c.replace(/(async function registerNodejs\s*\(\s*\)\s*\{)/, "$1if(process.platform==='android'){try{Object.defineProperty(process,'platform',{value:'linux',configurable:true});}catch(e){}}try{await ensureDbInitialized();}catch(__w8dbPreInit){console.warn('[w8-init]',__w8dbPreInit?.message);}");
            m = true;
          }
          if (m) fs.writeFileSync(fp, c);
        } catch(e) {}
      }
    }
    walkDir(chunks);
    walkDir(ssr);

    const serveMjs = path.join(base, 'bin', 'cli', 'commands', 'serve.mjs');
    if (fs.existsSync(serveMjs)) {
      let c = fs.readFileSync(serveMjs, 'utf8');
      if (!c.includes('platform() !== "android"')) {
        c = c.replace(/if\s*\((\s*existsSync\(sqliteBinary\)\s*&&\s*!isNativeBinaryCompatible\(sqliteBinary\)\s*)\)/, 'if (platform() !== "android" && $1)');
        c = c.replace(/if\s*\(\s*!process\.versions\.bun\s*&&\s*existsSync\(sqliteBinary\)\s*&&\s*!isNativeBinaryCompatible\(sqliteBinary\)\s*\)/, 'if (platform() !== "android" && !process.versions.bun && existsSync(sqliteBinary) && !isNativeBinaryCompatible(sqliteBinary))');
        fs.writeFileSync(serveMjs, c);
      }
    }

    // Ensure sql.js WASM is reachable inside dist/node_modules
    const distNodeModules = path.join(base, 'dist', 'node_modules');
    const sqlJsSrc = path.join(base, 'node_modules', 'sql.js');
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
INLINE_PATCH
  fi
fi

# 5. Restart service if running under PM2
if command -v pm2 >/dev/null 2>&1; then
  if pm2 list 2>/dev/null | grep -q "omniroute"; then
    echo "  Restarting OmniRoute under PM2..."
    pm2 restart omniroute --update-env 2>/dev/null || true
  fi
fi

echo ""
NEW_VER="$(omniroute --version 2>/dev/null || echo "$LATEST_VERSION")"
echo "╔══════════════════════════════════════════════════════╗"
echo "║  ✅ OmniRoute updated successfully to v$NEW_VER!      ║"
echo "╚══════════════════════════════════════════════════════╝"
echo ""
