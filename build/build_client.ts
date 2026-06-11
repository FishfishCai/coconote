import { cp, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import * as path from "node:path";
import * as sass from "sass";

import * as esbuild from "esbuild";

// WebKit can't parse the lookbehind regex from a bundled dependency: swap
// it for a no-op so Safari users don't hit a syntax error at startup.
function patchBundledJS(code: string): string {
  return code.replaceAll("/(?<=\\n)/", "/()/");
}

// Worker-scope shims of the TC39 proposals pdf.js v6 depends on but
// Electron 36 / Chromium 136 hasn't shipped yet:
//   - Uint8Array to/from base64+hex (proposal-arraybuffer-base64)
//   - Map / WeakMap getOrInsert(Computed) (proposal-upsert)
// Mirrors client/core/uint8_base64_polyfill.ts but as a self-contained
// IIFE that runs at the very top of the worker before pdf.js code.
const PDF_WORKER_POLYFILL = `(()=>{
  var p=Uint8Array.prototype,c=Uint8Array;
  if(typeof p.toHex!=="function"){
    p.toHex=function(){var s="";for(var i=0;i<this.length;i++){var b=this[i];s+=(b<16?"0":"")+b.toString(16);}return s;};
  }
  if(typeof c.fromHex!=="function"){
    c.fromHex=function(h){if(h.length%2)throw new SyntaxError("Uint8Array.fromHex: even length");var o=new Uint8Array(h.length/2);for(var i=0;i<o.length;i++){var v=parseInt(h.substr(i*2,2),16);if(isNaN(v))throw new SyntaxError("Uint8Array.fromHex: non-hex");o[i]=v;}return o;};
  }
  if(typeof p.toBase64!=="function"){
    p.toBase64=function(opt){var b="";var K=32768;for(var i=0;i<this.length;i+=K)b+=String.fromCharCode.apply(null,this.subarray(i,i+K));var r=btoa(b);if(opt&&opt.alphabet==="base64url")r=r.replace(/\\+/g,"-").replace(/\\//g,"_").replace(/=/g,"");return r;};
  }
  if(typeof c.fromBase64!=="function"){
    c.fromBase64=function(s,opt){if(opt&&opt.alphabet==="base64url"){s=s.replace(/-/g,"+").replace(/_/g,"/");while(s.length%4)s+="=";}var b=atob(s),o=new Uint8Array(b.length);for(var i=0;i<b.length;i++)o[i]=b.charCodeAt(i);return o;};
  }
  function up(proto){
    if(typeof proto.getOrInsert!=="function"){
      proto.getOrInsert=function(k,v){if(this.has(k))return this.get(k);this.set(k,v);return v;};
    }
    if(typeof proto.getOrInsertComputed!=="function"){
      proto.getOrInsertComputed=function(k,fn){if(this.has(k))return this.get(k);var v=fn(k);this.set(k,v);return v;};
    }
  }
  up(Map.prototype);
  up(WeakMap.prototype);
  if(typeof Math.sumPrecise!=="function"){
    Math.sumPrecise=function(it){var s=0,c=0;for(var v of it){var n=Number(v),t=s+n;if(Math.abs(s)>=Math.abs(n))c+=s-t+n;else c+=n-t+s;s=t;}return s+c;};
  }
})();
`;

export async function buildClient(): Promise<void> {
  // Clear stale output so iCloud duplicates / removed chunks don't leak.
  await rm("embed/client", { recursive: true, force: true });

  await mkdir("embed/client", { recursive: true });

  console.log("Now ESBuilding the client...");

  await esbuild.build({
    outdir: "embed/client",
    absWorkingDir: process.cwd(),
    bundle: true,
    treeShaking: true,
    // Source maps add ~7MB to the embedded bundle. Flip locally to debug.
    sourcemap: false,
    minify: true,
    format: "esm",
    chunkNames: ".client/[name]-[hash]",
    jsx: "automatic",
    jsxImportSource: "preact",
    entryPoints: [{ in: "client/core/boot.ts", out: ".client/client" }],
    splitting: true,
  });

  await copyAssets("embed/client/.client");

  console.log("Built!");
}

async function copyAssets(dist: string) {
  await mkdir(dist, { recursive: true });
  await cp("client/assets/fonts", dist, { recursive: true });
  await cp("client/assets/html", dist, { recursive: true });
  // PDF.js worker, shipped alongside the client bundle so PdfViewer can set
  // GlobalWorkerOptions.workerSrc to `.client/pdf.worker.min.mjs`. pdf.js v6
  // calls Uint8Array.prototype.toHex() (TC39 proposal-arraybuffer-base64) in
  // the worker, and Electron 36 / older Chromium lack it ("a.toHex is not a
  // function"). The main-thread client/core/uint8_base64_polyfill.ts doesn't
  // reach the worker's separate global scope, so prepend the shim here.
  const workerSrc = await readFile(
    "node_modules/pdfjs-dist/build/pdf.worker.min.mjs",
    "utf-8",
  );
  await writeFile(
    path.join(dist, "pdf.worker.min.mjs"),
    PDF_WORKER_POLYFILL + workerSrc,
    "utf-8",
  );
  // Side-band resources pdf.js v6 needs for full-fidelity rendering (the
  // official viewer.html and zotero/reader ship all of them). Shipping just
  // the worker is why LaTeX PDFs once lost ligatures + math glyphs.
  //   - cmaps/          CID-keyed font glyph->Unicode tables
  //   - standard_fonts/ 14 built-in PDF font .pfb fallback data
  //   - iccs/           embedded ICC color profile (sRGB compat)
  //   - wasm/           JBIG2/JPEG2000/QCMS WebAssembly decoders
  // getDocument() is wired with matching URLs in pdf/pdf_viewer.tsx.
  for (const sub of ["cmaps", "standard_fonts", "iccs", "wasm"]) {
    await cp(`node_modules/pdfjs-dist/${sub}`, path.join(dist, sub), {
      recursive: true,
    });
  }

  const scssContent = await readFile("client/styles/main.scss", "utf-8");
  const result = sass.compileString(scssContent, {
    loadPaths: ["client/styles"],
    style: "compressed",
  });
  // Ship only woff2 KaTeX fonts to avoid 404s for ttf/woff src() entries.
  const katexCss = await readFile(
    "node_modules/katex/dist/katex.min.css",
    "utf-8",
  );
  await mkdir(`${dist}/fonts`, { recursive: true });
  const katexFontDir = "node_modules/katex/dist/fonts";
  for (const f of await readdir(katexFontDir)) {
    if (f.endsWith(".woff2")) {
      await cp(path.join(katexFontDir, f), path.join(`${dist}/fonts`, f));
    }
  }
  // Anchor on `}` not `;`: minified CSS omits the final `;` before `}`,
  // so `[^;]*;` would walk past the @font-face brace and eat the next rule.
  const slimmedKatexCss = katexCss.replace(
    /src:url\((fonts\/[^)]+\.woff2)\) format\(['"]woff2['"]\)[^}]*\}/g,
    `src:url($1) format('woff2')}`,
  );
  await writeFile(
    `${dist}/main.css`,
    result.css + "\n" + slimmedKatexCss,
    "utf-8",
  );

  let bundleJs = await readFile(`${dist}/client.js`, "utf-8");
  bundleJs = patchBundledJS(bundleJs);
  await writeFile(`${dist}/client.js`, bundleJs, "utf-8");
}

const isMain = process.argv[1] === fileURLToPath(import.meta.url);
if (isMain) {
  await buildClient();
  await esbuild.stop();
}
