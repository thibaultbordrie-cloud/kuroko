// Builds the tests and the single-file game page. No network, no runtime dependency.
import { build } from "esbuild";
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";

const mode = process.argv[2] ?? "all";
mkdirSync("build/test", { recursive: true });
mkdirSync("dist", { recursive: true });

if (mode === "all" || mode === "test") {
  const tests = readdirSync("test").filter((f) => f.endsWith(".test.ts")).map((f) => `test/${f}`);
  await build({ entryPoints: tests, bundle: true, platform: "node", format: "esm", outdir: "build/test", outExtension: { ".js": ".mjs" }, logLevel: "warning" });
}

if (mode === "all" || mode === "tools") {
  await build({ entryPoints: ["src/tools/kpack.ts"], bundle: true, platform: "node", format: "esm", outfile: "build/kpack.mjs", logLevel: "warning" });
}

if (mode === "all" || mode === "page") {
  const out = await build({ entryPoints: ["src/main.ts"], bundle: true, format: "iife", target: "es2022", minify: true, write: false, legalComments: "none", logLevel: "warning" });
  const js = out.outputFiles[0].text.replace(/<\/script/gi, "<\\/script");
  const css = readFileSync("src/ui/style.css", "utf8");
  const body = readFileSync("src/ui/shell.html", "utf8");
  const version = JSON.parse(readFileSync("package.json", "utf8")).version;
  // 1) The artifact page: content only, the host adds the skeleton; Google Fonts allowed there.
  const fonts = '<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin><link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Chakra+Petch:wght@500;700&family=IBM+Plex+Sans:wght@400;500;600&family=IBM+Plex+Mono:wght@400;500&display=swap">';
  const head = `<title>Kuroko</title>\n<meta name="claude:viewport-fit-sides" content="cover">\n`;
  writeFileSync("dist/artifact.html", `${head}${fonts}\n<style>${css}</style>\n${body}\n<script>${js}</script>\n`);
  // 2) The standalone page for the repository: no request leaves the page, strict CSP by hash.
  const hash = (s) => `'sha256-${createHash("sha256").update(s).digest("base64")}'`;
  const csp = `default-src 'none'; script-src ${hash(js)}; style-src ${hash(css)}; img-src data: blob:; base-uri 'none'; form-action 'none'`;
  writeFileSync(
    "dist/kuroko.html",
    `<!doctype html>\n<html lang="fr">\n<head>\n<meta charset="utf-8">\n<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">\n<meta http-equiv="Content-Security-Policy" content="${csp}">\n<meta name="referrer" content="no-referrer">\n<title>Kuroko ${version}</title>\n<style>${css}</style>\n</head>\n<body>\n${body}\n<script>${js}</script>\n</body>\n</html>\n`,
  );
  console.log(`page: ${(js.length / 1024).toFixed(0)} KB of script`);
}

if (mode === "all" || mode === "site") {
  // The reader, as an installable offline site (GitHub Pages) and as a single playtest page.
  mkdirSync("dist/site", { recursive: true });
  const version = JSON.parse(readFileSync("package.json", "utf8")).version;
  if (!existsSync("build/kpack.mjs")) await build({ entryPoints: ["src/tools/kpack.ts"], bundle: true, platform: "node", format: "esm", outfile: "build/kpack.mjs", logLevel: "warning" });
  const builtin = [];
  for (const f of readdirSync("packs").filter((x) => x.endsWith(".txt"))) {
    const out = `build/${f.replace(/\.txt$/, ".kuroko")}`;
    execFileSync("node", ["build/kpack.mjs", "seal", `packs/${f}`, out], { stdio: "ignore" });
    builtin.push(readFileSync(out, "utf8"));
  }
  const out = await build({ entryPoints: ["src/play/main.ts"], bundle: true, format: "iife", target: "es2022", minify: true, write: false, legalComments: "none", logLevel: "warning", define: { __BUILTIN_PACKS__: JSON.stringify(builtin) } });
  const js = out.outputFiles[0].text.replace(/<\/script/gi, "<\\/script");
  const css = readFileSync("src/play/style.css", "utf8");
  const body = readFileSync("src/play/shell.html", "utf8");
  const hash = (x) => `'sha256-${createHash("sha256").update(x).digest("base64")}'`;
  const csp = `default-src 'none'; script-src ${hash(js)}; style-src ${hash(css)}; img-src 'self' data:; manifest-src 'self'; worker-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'none'`;
  writeFileSync("dist/site/index.html", `<!doctype html>\n<html lang="fr">\n<head>\n<meta charset="utf-8">\n<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">\n<meta http-equiv="Content-Security-Policy" content="${csp}">\n<meta name="referrer" content="no-referrer">\n<meta name="theme-color" content="#07080c">\n<link rel="manifest" href="manifest.webmanifest">\n<link rel="icon" href="icon-192.png">\n<link rel="apple-touch-icon" href="icon-192.png">\n<meta name="apple-mobile-web-app-capable" content="yes">\n<title>Kuroko</title>\n<style>${css}</style>\n</head>\n<body>\n${body}\n<script>${js}</script>\n</body>\n</html>\n`);
  writeFileSync("dist/site/manifest.webmanifest", JSON.stringify({ name: "Kuroko", short_name: "Kuroko", lang: "fr", start_url: "./", scope: "./", display: "standalone", background_color: "#0d0f12", theme_color: "#0d0f12", icons: [{ src: "icon-192.png", sizes: "192x192", type: "image/png" }, { src: "icon-512.png", sizes: "512x512", type: "image/png", purpose: "any maskable" }] }, null, 2));
  writeFileSync("dist/site/sw.js", readFileSync("src/play/sw.js", "utf8").replace("__VERSION__", `${version}-${createHash("sha256").update(js + css).digest("hex").slice(0, 8)}`));
  copyFileSync("src/play/icons/icon-192.png", "dist/site/icon-192.png");
  copyFileSync("src/play/icons/icon-512.png", "dist/site/icon-512.png");
  if (existsSync("dist/kuroko.html")) copyFileSync("dist/kuroko.html", "dist/site/infiltration.html");
  writeFileSync("dist/reader-artifact.html", `<title>Kuroko Lecteur</title>\n<meta name="claude:viewport-fit-sides" content="cover">\n<style>${css}</style>\n${body}\n<script>${js}</script>\n`);
  console.log(`site: ${(js.length / 1024).toFixed(0)} KB of script, ${builtin.length} built-in pack(s)`);
}
