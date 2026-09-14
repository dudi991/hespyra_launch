#!/usr/bin/env node
// HESPYRA — Abnahme mit einem Befehl.
//
//   node tools/abnahme.js                         Startseite DE, 1280×800 und 390×844
//   node tools/abnahme.js index.html index-en.html artikel-dienstag.html
//   node tools/abnahme.js --breiten 1440x900,390x844 --moment 3 --out _abnahme/t5
//
// Liefert pro Seite und Breite:
//   - Screenshot der ganzen Seite (PNG)
//   - Kopfzeilen-Wert bei Scroll 0 und nach dem Scroll unter das Foto (Hero bzw. Aufmacher)
//   - Kopfzeilenhöhe
//   - Hero-Unterkante gegen Viewport-Unterkante (Startseite)
// Ergebnis: Tabelle in der Konsole und in <out>/bericht.md. Standard-Ausgabe: _abnahme/<Datum_Uhrzeit>/ (nicht im Git).
//
// Voraussetzungen: Node 22+ (fetch und WebSocket eingebaut), Google Chrome oder Chromium.
// Chrome wird automatisch gesucht; sonst Pfad in der Umgebungsvariable CHROME angeben.
// Keine Pakete, kein Build. Die Seite wird über einen eigenen lokalen Server aus dem Repo-Ordner geladen.
// Jede Seite/Breite läuft in einer frischen Browser-Sitzung (eigener sessionStorage).

"use strict";
const fs = require("fs"), path = require("path"), http = require("http"), os = require("os");
const { spawn, execSync } = require("child_process");

const ROOT = path.resolve(__dirname, "..");
const sleep = ms => new Promise(r => setTimeout(r, ms));

// ---------- Argumente ----------
const args = process.argv.slice(2);
const opt = { seiten: [], breiten: "1280x800,390x844", moment: null, out: null };
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (a === "--breiten") opt.breiten = args[++i];
  else if (a === "--moment") opt.moment = args[++i];
  else if (a === "--out") opt.out = args[++i];
  else if (a === "-h" || a === "--help") { console.log(fs.readFileSync(__filename, "utf8").split("\n").slice(1, 18).map(l => l.replace(/^\/\/ ?/, "")).join("\n")); process.exit(0); }
  else opt.seiten.push(a);
}
if (!opt.seiten.length) opt.seiten = ["index.html"];
const BREITEN = opt.breiten.split(",").map(s => s.trim().split("x").map(Number));
if (BREITEN.some(([w, h]) => !w || !h)) { console.error("--breiten bitte als 1280x800,390x844"); process.exit(2); }
if (opt.moment !== null && !/^[0-3]$/.test(opt.moment)) { console.error("--moment bitte 0 bis 3 (Position in momente)"); process.exit(2); }
for (const s of opt.seiten) if (!fs.existsSync(path.join(ROOT, s))) { console.error("Seite nicht gefunden: " + s); process.exit(2); }
if (typeof WebSocket === "undefined") { console.error("Node 22 oder neuer nötig (WebSocket fehlt). Aktuell: " + process.version); process.exit(2); }

const jetzt = new Date(), zwei = n => String(n).padStart(2, "0");
const stempel = `${jetzt.getFullYear()}-${zwei(jetzt.getMonth() + 1)}-${zwei(jetzt.getDate())}_${zwei(jetzt.getHours())}-${zwei(jetzt.getMinutes())}-${zwei(jetzt.getSeconds())}`;
const OUT = path.resolve(ROOT, opt.out || path.join("_abnahme", stempel));
fs.mkdirSync(OUT, { recursive: true });

// ---------- Chrome finden ----------
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

// ---------- lokaler Server ----------
const TYPEN = { ".html": "text/html; charset=utf-8", ".css": "text/css", ".js": "text/javascript", ".woff2": "font/woff2", ".webp": "image/webp", ".png": "image/png", ".jpg": "image/jpeg", ".svg": "image/svg+xml", ".txt": "text/plain" };
function starteServer() {
  return new Promise(resolve => {
    const srv = http.createServer((req, res) => {
      let p = decodeURIComponent(new URL(req.url, "http://x").pathname); if (p.endsWith("/")) p += "index.html";
      const f = path.join(ROOT, p);
      if (!f.startsWith(ROOT) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); return res.end(); }
      res.writeHead(200, { "Content-Type": TYPEN[path.extname(f)] || "application/octet-stream", "Cache-Control": "no-store" });
      fs.createReadStream(f).pipe(res);
    }).listen(0, "127.0.0.1", () => resolve(srv));
  });
}

// ---------- Messung im Browser ----------
const MESSUNG_OBEN = `(async()=>{
  await document.fonts.ready; await new Promise(r=>setTimeout(r,500));
  const oz=document.querySelector('.bar .ortszeit'), bar=document.getElementById('bar'), hero=document.querySelector('.hero');
  const bild=document.querySelector('[data-ort][data-zeit]');
  return {
    kopf: oz ? (oz.style.display==='none' ? '(ausgeblendet)' : oz.innerText.replace(/\\s+/g,' ').trim()) : '(keine Ortszeit)',
    kopfHoehe: bar ? Math.round(bar.getBoundingClientRect().height*10)/10 : null,
    heroUnterkante: hero ? Math.round(hero.getBoundingClientRect().bottom*10)/10 : null,
    viewport: innerHeight,
    fotoUnterkante: bild ? Math.round(bild.getBoundingClientRect().bottom + scrollY) : null,
    moment: window.hespyraMoment ? window.hespyraMoment[0]+' · '+window.hespyraMoment[1] : null,
    seitenHoehe: document.documentElement.scrollHeight
  };
})()`;
const FUER_SCREENSHOT = `(async()=>{
  const bar=document.getElementById('bar'); if(bar) bar.style.position='static';   // sticky Kopfzeile nur einmal oben im Bild
  document.querySelectorAll('.reveal').forEach(e=>e.classList.add('in'));
  document.querySelectorAll('img[loading=lazy]').forEach(i=>i.loading='eager');
  await Promise.all([...document.images].map(i=>i.decode().catch(()=>{})));
  document.querySelectorAll('.photo img').forEach(i=>i.classList.add('ld'));
  await new Promise(r=>setTimeout(r,700));
  return document.documentElement.scrollHeight;
})()`;
const MESSUNG_UNTEN = y => `(async()=>{
  window.scrollTo({top:${y},behavior:'instant'}); await new Promise(r=>setTimeout(r,900));
  const oz=document.querySelector('.bar .ortszeit');
  return oz ? (oz.style.display==='none' ? '(ausgeblendet)' : oz.innerText.replace(/\\s+/g,' ').trim()) : '(keine Ortszeit)';
})()`;

(async () => {
  const chrome = findeChrome();
  if (!chrome) { console.error("Chrome/Chromium nicht gefunden. Pfad bitte in CHROME setzen."); process.exit(2); }
  const srv = await starteServer();
  const BASE = `http://127.0.0.1:${srv.address().port}/`;
  const profil = fs.mkdtempSync(path.join(os.tmpdir(), "hespyra-abnahme-"));
  const port = 9400 + Math.floor(Math.random() * 400);
  const ch = spawn(chrome, ["--headless=new", "--disable-gpu", "--hide-scrollbars", "--no-first-run", "--no-default-browser-check", `--remote-debugging-port=${port}`, `--user-data-dir=${profil}`, "about:blank"], { stdio: "ignore" });

  let ver;
  for (let i = 0; i < 75 && !ver; i++) { try { ver = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json(); } catch { await sleep(200); } }
  if (!ver) { console.error("Chrome antwortet nicht auf dem Debug-Port."); ch.kill(); srv.close(); process.exit(1); }
  const ws = new WebSocket(ver.webSocketDebuggerUrl); await new Promise(r => ws.onopen = r);
  let id = 0; const offen = new Map(), ereignisse = [];
  ws.onmessage = m => { const d = JSON.parse(m.data); if (d.id && offen.has(d.id)) { offen.get(d.id)(d); offen.delete(d.id); } else ereignisse.push(d); };
  const cmd = (method, params = {}, sessionId) => new Promise(r => { const i = ++id; offen.set(i, r); ws.send(JSON.stringify({ id: i, method, params, sessionId })); });

  const zeilen = [];
  try {
    for (const seite of opt.seiten) for (const [w, h] of BREITEN) {
      const ctx = (await cmd("Target.createBrowserContext")).result.browserContextId;
      const tgt = (await cmd("Target.createTarget", { url: "about:blank", browserContextId: ctx })).result.targetId;
      const sid = (await cmd("Target.attachToTarget", { targetId: tgt, flatten: true })).result.sessionId;
      const c = (m, p) => cmd(m, p, sid);
      const ev = async e => { const r = await c("Runtime.evaluate", { expression: e, awaitPromise: true, returnByValue: true }); if (r.result?.exceptionDetails) throw new Error(r.result.exceptionDetails.text); return r.result?.result?.value; };
      const lade = async () => { await c("Page.navigate", { url: BASE + seite }); for (let i = 0; i < 60; i++) { if (await ev("document.readyState") === "complete") break; await sleep(150); } };
      await c("Page.enable"); await c("Runtime.enable");
      await c("Emulation.setDeviceMetricsOverride", { width: w, height: h, deviceScaleFactor: 1, mobile: w < 768 });
      if (opt.moment !== null) await c("Page.addScriptToEvaluateOnNewDocument", { source: `try{sessionStorage.setItem('hespyra-moment','${opt.moment}')}catch(e){}` });

      await lade();
      const oben = await ev(MESSUNG_OBEN);
      const hoehe = await ev(FUER_SCREENSHOT);
      const datei = `${seite.replace(/\.html$/, "")}_${w}x${h}_ganze-seite.png`;
      const shot = await c("Page.captureScreenshot", { format: "png", captureBeyondViewport: true, clip: { x: 0, y: 0, width: w, height: hoehe, scale: 1 } });
      fs.writeFileSync(path.join(OUT, datei), Buffer.from(shot.result.data, "base64"));

      await lade(); // frischer Zustand für den Scroll-Test (gleiche Sitzung)
      const oben2 = await ev(MESSUNG_OBEN);
      const unten = oben2.fotoUnterkante !== null ? await ev(MESSUNG_UNTEN(oben2.fotoUnterkante + 40)) : "(kein Foto oben)";

      zeilen.push({
        seite, viewport: `${w}×${h}`, moment: oben.moment || "–",
        kopf0: oben.kopf, kopfUnten: unten, kopfHoehe: oben.kopfHoehe,
        hero: oben.heroUnterkante === null ? "–" : `${oben.heroUnterkante} / ${oben.viewport}${oben.heroUnterkante === oben.viewport ? " (=)" : " (≠)"}`,
        seitenHoehe: hoehe, datei,
      });
      await cmd("Target.disposeBrowserContext", { browserContextId: ctx });
    }
  } finally {
    ws.close(); ch.kill(); srv.close();
    try { fs.rmSync(profil, { recursive: true, force: true }); } catch {}
  }

  // ---------- Bericht ----------
  const kopf = ["Seite", "Viewport", "Sitzungsmoment", "Kopfzeile Scroll 0", "Kopfzeile unter dem Foto", "Kopfzeilenhöhe", "Hero-Unterkante / Viewport", "Seitenhöhe", "Screenshot"];
  const md = [
    `# Abnahme ${stempel.replace("_", " ")}`, "",
    `Commit: ${(() => { try { return execSync("git rev-parse --short HEAD", { cwd: ROOT }).toString().trim() + (execSync("git status --porcelain", { cwd: ROOT }).toString().trim() ? " + lokale Änderungen" : ""); } catch { return "–"; } })()}`, "",
    "| " + kopf.join(" | ") + " |", "|" + kopf.map(() => "---").join("|") + "|",
    ...zeilen.map(z => `| ${z.seite} | ${z.viewport} | ${z.moment} | ${z.kopf0} | ${z.kopfUnten} | ${z.kopfHoehe} px | ${z.hero} | ${z.seitenHoehe} px | ${z.datei} |`),
  ].join("\n");
  fs.writeFileSync(path.join(OUT, "bericht.md"), md + "\n");
  console.log(md);
  console.log(`\nAusgabe: ${OUT}`);
})().catch(e => { console.error(e); process.exit(1); });
