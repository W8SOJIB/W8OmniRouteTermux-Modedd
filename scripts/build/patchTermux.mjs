#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { homedir } from "node:os";

const BIND_HELPER = `
function __w8bindParams(p) {
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

export function applyTermuxPatches(baseDir) {
  const base = path.resolve(baseDir);
  if (!fs.existsSync(base)) {
    throw new Error(`Target directory does not exist: ${base}`);
  }

  const stats = {
    playwright: 0,
    bind: 0,
    instrumentation: 0,
    serve: 0,
    cache: 0,
    skipped: 0,
  };

  // 1. Ensure ~/.cache exists
  try {
    const home = process.env.HOME || homedir();
    const cacheDir = process.env.XDG_CACHE_HOME || path.join(home, ".cache");
    if (!fs.existsSync(cacheDir)) {
      fs.mkdirSync(cacheDir, { recursive: true });
      stats.cache++;
    }
  } catch {}

  // 2. Locate chunks
  const chunksDir = path.join(base, "dist", ".build", "next", "server", "chunks");
  const ssrDir = path.join(chunksDir, "ssr");

  function patchPlaywright(fp) {
    let c = fs.readFileSync(fp, "utf8");
    if (c.includes("process.platform==='android'")) {
      stats.skipped++;
      return;
    }
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

  function patchBind(fp, fileName) {
    if (fileName.includes("sql-wasm") || fileName.startsWith("node_modules_sql_js")) return;
    let c = fs.readFileSync(fp, "utf8");
    if (c.includes("__w8bindParams")) {
      stats.skipped++;
      return;
    }

    const isSqljsAdapter =
      (c.includes("sqljsAdapter") || c.includes("SqlJsAdapter") || c.includes("sql.js")) &&
      c.includes(".prepare(") &&
      c.includes(".free()") &&
      !fileName.startsWith("node_modules");

    if (!isSqljsAdapter) return;

    c = BIND_HELPER + c;
    c = c.replace(/\.bind\((\w+)\)/g, ".bind(__w8bindParams($1))");

    const closeRegex =
      /close\s*\(\)\s*\{\s*if\s*\(\s*clearInterval\([\w$]+\)\s*,\s*[\w$]+\s*&&\s*clearTimeout\([\w$]+\)\s*,\s*[\w$]+\s*\)\s*try\s*\{\s*[\w$]+\(\)\s*\}\s*catch(?:\([\w$]+\))?\s*\{\s*\}\s*try\s*\{\s*[\w$]+\.close\(\)\s*\}\s*catch(?:\([\w$]+\))?\s*\{\s*\}\s*[\w$]+\s*=\s*\!1\s*\}/g;
    c = c.replace(closeRegex, "close(){}");

    fs.writeFileSync(fp, c);
    stats.bind++;
  }

  function patchInstrumentation(fp) {
    let c = fs.readFileSync(fp, "utf8");
    if (c.includes("__w8dbPreInit")) {
      stats.skipped++;
      return;
    }
    if (!c.includes("registerNodejs") || !c.includes("ensureDbInitialized")) return;
    c = c.replace(
      /(async function registerNodejs\s*\(\s*\)\s*\{)/,
      "$1if(process.platform==='android'){try{Object.defineProperty(process,'platform',{value:'linux',configurable:true});}catch(e){}}try{await ensureDbInitialized();}catch(__w8dbPreInit){console.warn('[w8-init]',__w8dbPreInit?.message);}"
    );
    fs.writeFileSync(fp, c);
    stats.instrumentation++;
  }

  function walkDir(dir) {
    if (!fs.existsSync(dir)) return;
    const files = fs.readdirSync(dir).filter((f) => f.endsWith(".js"));
    for (const file of files) {
      const fp = path.join(dir, file);
      try {
        if (file.includes("playwright")) patchPlaywright(fp);
        patchBind(fp, file);
        patchInstrumentation(fp);
      } catch {}
    }
  }

  walkDir(chunksDir);
  walkDir(ssrDir);

  // 3. Patch main instrumentation.js entrypoint if present
  const instrJs = path.join(base, "dist", ".build", "next", "server", "instrumentation.js");
  if (fs.existsSync(instrJs)) {
    let c = fs.readFileSync(instrJs, "utf8");
    if (!c.includes("process.platform==='android'")) {
      c =
        "if(process.platform==='android'){try{Object.defineProperty(process,'platform',{value:'linux',configurable:true});}catch(e){}}\n" +
        c;
      fs.writeFileSync(instrJs, c);
      stats.instrumentation++;
    }
  }

  // 4. Patch bin/cli/commands/serve.mjs to bypass better-sqlite3 native binary check
  const serveMjs = path.join(base, "bin", "cli", "commands", "serve.mjs");
  if (fs.existsSync(serveMjs)) {
    let c = fs.readFileSync(serveMjs, "utf8");
    if (!c.includes('platform() !== "android"')) {
      c = c.replace(
        /if\s*\((\s*existsSync\(sqliteBinary\)\s*&&\s*!isNativeBinaryCompatible\(sqliteBinary\)\s*)\)/,
        'if (platform() !== "android" && $1)'
      );
      c = c.replace(
        /if\s*\(\s*!process\.versions\.bun\s*&&\s*existsSync\(sqliteBinary\)\s*&&\s*!isNativeBinaryCompatible\(sqliteBinary\)\s*\)/,
        'if (platform() !== "android" && !process.versions.bun && existsSync(sqliteBinary) && !isNativeBinaryCompatible(sqliteBinary))'
      );
      fs.writeFileSync(serveMjs, c);
      stats.serve++;
    }
  }

  // 5. Ensure sql.js and its WASM are available inside dist/node_modules
  const distNodeModules = path.join(base, "dist", "node_modules");
  const sqlJsSrc = path.join(base, "node_modules", "sql.js");
  const sqlJsDest = path.join(distNodeModules, "sql.js");
  if (fs.existsSync(sqlJsSrc)) {
    if (!fs.existsSync(distNodeModules)) {
      try {
        fs.mkdirSync(distNodeModules, { recursive: true });
      } catch {}
    }
    if (!fs.existsSync(sqlJsDest)) {
      try {
        fs.symlinkSync(sqlJsSrc, sqlJsDest, "junction");
      } catch {
        try {
          fs.cpSync(sqlJsSrc, sqlJsDest, { recursive: true });
        } catch {}
      }
    }
  }

  return stats;
}

// CLI execution
if (process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, "/"))) {
  const target = process.argv[2] || process.env.OMNIROUTE_DIR || process.cwd();
  console.log(`[TermuxPatcher] Patching OmniRoute at: ${target}`);
  try {
    const res = applyTermuxPatches(target);
    console.log("[TermuxPatcher] Done!", res);
  } catch (err) {
    console.error("[TermuxPatcher] Failed:", err.message);
    process.exit(1);
  }
}
