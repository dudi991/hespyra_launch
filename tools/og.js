#!/usr/bin/env node
// HESPYRA — og-image erzeugen.
//
//   node tools/og.js                 schreibt img/og-image.png (1200×630)
//
// Inhalt: Fläche --paper (#fbfbf9), Hero-Glas rechts, Wortmarke HESPYRA links oben in ink (#14140f). Sonst nichts.
// Glasbild und Wortmarke kommen aus index.html (src des Hero-Glases, <svg class="wm"> der Kopfzeile) — ändert sich der Hero,
// genügt ein neuer Lauf.
//
// Weder sharp noch canvas sind installiert; gerendert wird deshalb wie in tools/abnahme.js mit headless Chrome über CDP.
// Voraussetzungen: Node 22+ (fetch und WebSocket eingebaut), Google Chrome oder Chromium (sonst Pfad in CHROME).

"use strict";
const fs = require("fs"), path = require("path"), os = require("os");
const { spawn, execSync } = require("child_process");

const ROOT = path.resolve(__dirname, "..");
const ZIEL = path.join(ROOT, "img", "og-image.png");
const B = 1200, H = 630;
const sleep = ms => new Promise(r => setTimeout(r, ms));

// ---------- Maße ----------
// Render 1122×1402; das Glas liegt im Bild bei y 22,3–80,2 % und x 22,3–77,6 % (Mitte 49,3 %), wie im Hero gespiegelt.
const GLAS_OBEN = .223, GLAS_UNTEN = .802, GLAS_MITTE_X = 1 - .493, BILD_VERH = 1122 / 1402;
const glasHoehe = .80 * H;                               // Glas ≈ 80 % der Fläche
const bildH = glasHoehe / (GLAS_UNTEN - GLAS_OBEN);
const bildB = bildH * BILD_VERH;
const grundlinie = .90 * H;                              // Glas-Unterkante im unteren Drittel
const bildTop = grundlinie - GLAS_UNTEN * bildH;
const bildLeft = .72 * B - GLAS_MITTE_X * bildB;         // Glasmitte bei 72 % der Breite (wie im Hero)
const RAND = 64, WM_H = 28;                              // Wortmarke: Kopfzeile 21 px bei 1280, hier auf 630 px Höhe skaliert

// ---------- Quellen aus der Startseite ----------
const start = fs.readFileSync(path.join(ROOT, "index.html"), "utf8");
const src = (start.match(/<div class="glas"><img src="([^"]+)"/) || [])[1];
const wm = (start.match(/<svg class="wm"[\s\S]*?<\/svg>/) || [])[0];
if (!src || !wm) { console.error("Hero-Glas oder Wortmarke in index.html nicht gefunden."); process.exit(2); }
const bildDatei = path.join(ROOT, src);
const bildUrl = "data:image/" + path.extname(bildDatei).slice(1) + ";base64," + fs.readFileSync(bildDatei).toString("base64");

const html = `<!doctype html><html><head><meta charset="utf-8"><style>
  html,body{margin:0;width:${B}px;height:${H}px;overflow:hidden;background:#fbfbf9;color:#14140f}
  .wm{position:absolute;left:${RAND}px;top:${RAND}px;height:${WM_H}px;width:auto;display:block}
  .glas{position:absolute;left:${bildLeft.toFixed(1)}px;top:${bildTop.toFixed(1)}px;width:${bildB.toFixed(1)}px;height:${bildH.toFixed(1)}px;
    transform:scaleX(-1);mix-blend-mode:multiply;filter:brightness(1.01);
    -webkit-mask-image:linear-gradient(to right,transparent,#000 20%);mask-image:linear-gradient(to right,transparent,#000 20%)}
</style></head><body>
${wm.replace(/style="[^"]*"/, "")}
<img class="glas" src="${bildUrl}" alt="">
</body></html>`;

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

(async () => {
  const chrome = findeChrome();
  if (!chrome) { console.error("Chrome/Chromium nicht gefunden. Pfad bitte in CHROME setzen."); process.exit(2); }
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "hespyra-og-"));
  const seite = path.join(tmp, "og.html");
  fs.writeFileSync(seite, html);
  const port = 9800 + Math.floor(Math.random() * 150);
  const ch = spawn(chrome, ["--headless=new", "--disable-gpu", "--hide-scrollbars", "--no-first-run", "--no-default-browser-check",
    `--remote-debugging-port=${port}`, `--user-data-dir=${path.join(tmp, "profil")}`, "about:blank"], { stdio: "ignore" });
  let ver;
  for (let i = 0; i < 75 && !ver; i++) { try { ver = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json(); } catch { await sleep(200); } }
  if (!ver) { console.error("Chrome antwortet nicht auf dem Debug-Port."); ch.kill(); process.exit(1); }
  const ws = new WebSocket(ver.webSocketDebuggerUrl); await new Promise(r => ws.onopen = r);
  let id = 0; const offen = new Map();
  ws.onmessage = m => { const d = JSON.parse(m.data); if (d.id && offen.has(d.id)) { offen.get(d.id)(d); offen.delete(d.id); } };
  const cmd = (method, params = {}, sessionId) => new Promise(r => { const i = ++id; offen.set(i, r); ws.send(JSON.stringify({ id: i, method, params, sessionId })); });
  try {
    const tgt = (await cmd("Target.createTarget", { url: "about:blank" })).result.targetId;
    const sid = (await cmd("Target.attachToTarget", { targetId: tgt, flatten: true })).result.sessionId;
    const c = (m, p) => cmd(m, p, sid);
    await c("Page.enable"); await c("Runtime.enable");
    await c("Emulation.setDeviceMetricsOverride", { width: B, height: H, deviceScaleFactor: 1, mobile: false });
    await c("Page.navigate", { url: "file:///" + seite.replace(/\\/g, "/") });
    await c("Runtime.evaluate", { expression: "(async()=>{await new Promise(r=>document.readyState==='complete'?r():addEventListener('load',r));await document.querySelector('.glas').decode().catch(()=>{});await new Promise(r=>setTimeout(r,300))})()", awaitPromise: true });
    const shot = await c("Page.captureScreenshot", { format: "png", clip: { x: 0, y: 0, width: B, height: H, scale: 1 } });
    fs.writeFileSync(ZIEL, Buffer.from(shot.result.data, "base64"));
    console.log(`${path.relative(ROOT, ZIEL)} geschrieben (${B}×${H}, Glas aus ${src})`);
  } finally {
    ws.close(); ch.kill();
    await sleep(300); try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
  }
})();
