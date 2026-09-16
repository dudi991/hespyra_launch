#!/usr/bin/env node
// HESPYRA — Bilder verkleinern.
//
//   node tools/resize.js            verkleinert img/ und uploads/, setzt width/height in allen HTML-Seiten
//
// Regel: längste Kante > 2000 px → 2000 px, WebP Qualität 80, Dateiname unverändert.
// Ausgenommen: img/og-image.png und das Hero-Glas (src aus index.html sowie uploads/hero-glas*.webp).
// Originale werden nach ../hespyra-img-src/<ordner>/ verschoben (außerhalb des Repos). Liegt dort schon eine Datei gleichen
// Namens, bleibt sie stehen (das erste Original gewinnt).
//
// sharp ist nicht installiert; kodiert wird wie in tools/og.js mit headless Chrome (canvas, imageSmoothingQuality high,
// toBlob image/webp 0.80). Voraussetzungen: Node 22+, Google Chrome oder Chromium (sonst Pfad in CHROME).
// Nur .webp-Dateien werden ersetzt — bei .jpg/.png würde „Dateiname unverändert“ einen falschen Dateityp ergeben; die meldet das Script.

"use strict";
const fs = require("fs"), path = require("path"), os = require("os"), http = require("http");
const { spawn, execSync } = require("child_process");

const ROOT = path.resolve(__dirname, "..");
const ORDNER = ["img", "uploads"];
const ZIEL = path.resolve(ROOT, "..", "hespyra-img-src");
const MAX = 2000, QUALITAET = 0.80;
const sleep = ms => new Promise(r => setTimeout(r, ms));

function masse(p) {
  const b = fs.readFileSync(p);
  if (b.slice(0, 8).toString("hex") === "89504e470d0a1a0a") return [b.readUInt32BE(16), b.readUInt32BE(20)];
  if (b.slice(0, 4).toString() === "RIFF" && b.slice(8, 12).toString() === "WEBP") {
    const c = b.slice(12, 16).toString();
    if (c === "VP8X") return [1 + b.readUIntLE(24, 3), 1 + b.readUIntLE(27, 3)];
    if (c === "VP8 ") return [b.readUInt16LE(26) & 0x3fff, b.readUInt16LE(28) & 0x3fff];
    if (c === "VP8L") { const v = b.readUInt32LE(21); return [1 + (v & 0x3fff), 1 + ((v >> 14) & 0x3fff)]; }
  }
  if (b[0] === 0xff && b[1] === 0xd8) {
    let i = 2;
    while (i < b.length) {
      if (b[i] !== 0xff) { i++; continue; }
      const m = b[i + 1], len = b.readUInt16BE(i + 2);
      if (m >= 0xc0 && m <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(m)) return [b.readUInt16BE(i + 7), b.readUInt16BE(i + 5)];
      i += 2 + len;
    }
  }
  return null;
}

function findeChrome() {
  if (process.env.CHROME) return process.env.CHROME;
  const kandidaten = [
    "C:/Program Files/Google/Chrome/Application/chrome.exe",
    "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
    path.join(os.homedir(), "AppData/Local/Google/Chrome/Application/chrome.exe"),
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
  ];
  for (const k of kandidaten) if (fs.existsSync(k)) return k;
  for (const n of ["google-chrome", "google-chrome-stable", "chromium", "chromium-browser"]) {
    try { return execSync(`command -v ${n}`, { stdio: ["ignore", "pipe", "ignore"] }).toString().trim(); } catch {}
  }
  return null;
}

// ---------- Kandidaten ----------
const start = fs.readFileSync(path.join(ROOT, "index.html"), "utf8");
const heroSrc = (start.match(/<div class="glas"><img src="([^"]+)"/) || [])[1];
const ausgenommen = f => f === "img/og-image.png" || f === heroSrc || /(^|\/)hero-glas[^/]*\.webp$/.test(f);
const liste = [];
for (const o of ORDNER) for (const n of fs.readdirSync(path.join(ROOT, o))) {
  const rel = `${o}/${n}`;
  if (!/\.(webp|png|jpe?g)$/i.test(n) || ausgenommen(rel)) continue;
  const m = masse(path.join(ROOT, rel));
  if (!m || Math.max(...m) <= MAX) continue;
  if (!/\.webp$/i.test(n)) { console.log(`übersprungen (kein .webp): ${rel} ${m.join("×")}`); continue; }
  liste.push({ rel, alt: m, bytesAlt: fs.statSync(path.join(ROOT, rel)).size });
}
if (!liste.length) { console.log("Nichts zu verkleinern."); process.exit(0); }

(async () => {
  const chrome = findeChrome();
  if (!chrome) { console.error("Chrome/Chromium nicht gefunden. Pfad bitte in CHROME setzen."); process.exit(2); }
  const srv = await new Promise(r => { const s = http.createServer((q, res) => {
    if (q.url === "/") { res.writeHead(200, { "Content-Type": "text/html" }); return res.end("<!doctype html><title>resize</title>"); }
    const f = path.join(ROOT, decodeURIComponent(q.url.split("?")[0]));
    if (!f.startsWith(ROOT) || !fs.existsSync(f)) { res.writeHead(404); return res.end(); }
    res.writeHead(200, { "Content-Type": "image/webp", "Cache-Control": "no-store" }); fs.createReadStream(f).pipe(res);
  }).listen(0, "127.0.0.1", () => r(s)); });
  const base = `http://127.0.0.1:${srv.address().port}/`;
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "hespyra-resize-"));
  const port = 9700 + Math.floor(Math.random() * 90);
  const ch = spawn(chrome, ["--headless=new", "--disable-gpu", "--no-first-run", `--remote-debugging-port=${port}`, `--user-data-dir=${tmp}`, "about:blank"], { stdio: "ignore" });
  let ver; for (let i = 0; i < 75 && !ver; i++) { try { ver = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json(); } catch { await sleep(200); } }
  if (!ver) { console.error("Chrome antwortet nicht auf dem Debug-Port."); ch.kill(); srv.close(); process.exit(1); }
  const ws = new WebSocket(ver.webSocketDebuggerUrl); await new Promise(r => ws.onopen = r);
  let id = 0; const offen = new Map();
  ws.onmessage = m => { const d = JSON.parse(m.data); if (d.id && offen.has(d.id)) { offen.get(d.id)(d); offen.delete(d.id); } };
  const cmd = (method, params = {}, sessionId) => new Promise(r => { const i = ++id; offen.set(i, r); ws.send(JSON.stringify({ id: i, method, params, sessionId })); });

  const neueMasse = {};
  let summeAlt = 0, summeNeu = 0;
  try {
    const tgt = (await cmd("Target.createTarget", { url: base })).result.targetId;
    const sid = (await cmd("Target.attachToTarget", { targetId: tgt, flatten: true })).result.sessionId;
    await sleep(500);
    for (const b of liste) {
      const s = MAX / Math.max(...b.alt);
      const w = Math.round(b.alt[0] * s), h = Math.round(b.alt[1] * s);
      const r = await cmd("Runtime.evaluate", { awaitPromise: true, returnByValue: true, expression: `(async()=>{
        const img=new Image(); img.src=${JSON.stringify(base + b.rel + "?" + Date.now())}; await img.decode();
        const c=document.createElement('canvas'); c.width=${w}; c.height=${h};
        const x=c.getContext('2d'); x.imageSmoothingEnabled=true; x.imageSmoothingQuality='high'; x.drawImage(img,0,0,${w},${h});
        const blob=await new Promise(r=>c.toBlob(r,'image/webp',${QUALITAET}));
        const u=new Uint8Array(await blob.arrayBuffer()); let t=''; for(let i=0;i<u.length;i+=32768) t+=String.fromCharCode.apply(null,u.subarray(i,i+32768));
        return {typ:blob.type,data:btoa(t)};
      })()` }, sid);
      const v = r.result?.result?.value;
      if (!v || v.typ !== "image/webp") { console.error("Fehler bei " + b.rel); continue; }
      const sicher = path.join(ZIEL, path.dirname(b.rel), path.basename(b.rel));
      fs.mkdirSync(path.dirname(sicher), { recursive: true });
      if (!fs.existsSync(sicher)) fs.renameSync(path.join(ROOT, b.rel), sicher);
      const neu = Buffer.from(v.data, "base64");
      fs.writeFileSync(path.join(ROOT, b.rel), neu);
      neueMasse[b.rel] = [w, h];
      summeAlt += b.bytesAlt; summeNeu += neu.length;
      console.log(`${b.rel}  ${b.alt.join("×")} → ${w}×${h}  ${(b.bytesAlt / 1048576).toFixed(2)} → ${(neu.length / 1048576).toFixed(2)} MB`);
    }
  } finally { ws.close(); ch.kill(); srv.close(); }

  // ---------- width/height in allen Seiten ----------
  let nTags = 0;
  for (const f of fs.readdirSync(ROOT).filter(f => f.endsWith(".html"))) {
    const p = path.join(ROOT, f), t = fs.readFileSync(p, "utf8");
    const neu = t.replace(/<img [^>]*>/g, tag => {
      const src = (tag.match(/src="([^"]*)"/) || [])[1];
      if (!neueMasse[src]) return tag;
      nTags++;
      const [w, h] = neueMasse[src];
      return tag.replace(/\swidth="[^"]*"/, ` width="${w}"`).replace(/\sheight="[^"]*"/, ` height="${h}"`);
    });
    if (neu !== t) fs.writeFileSync(p, neu);
  }
  console.log(`${Object.keys(neueMasse).length} Bilder verkleinert, ${(summeAlt / 1048576).toFixed(2)} MB → ${(summeNeu / 1048576).toFixed(2)} MB, ${nTags} <img> angepasst. Originale: ${ZIEL}`);
})();
