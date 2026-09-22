#!/usr/bin/env node
// HESPYRA — Staging-Paket für einen IONOS-Unterordner.
//
//   node tools/staging.js --pass <passwort>     baut dist-staging/ samt .htaccess und .htpasswd
//   node tools/staging.js                       baut dist-staging/ ohne .htpasswd (Hinweis am Ende)
//
// Das Repo bleibt unverändert; alles Folgende passiert nur in der Kopie:
//   1 alle HTML-Seiten mit <meta name="robots" content="noindex, nofollow"> im <head>
//   2 Umami-Script und Umami-Helfer entfernt (kein Tracking auf Staging)
//   3 absolute Pfade (href/src mit führendem „/") gemeldet und relativ umgeschrieben
//   4 .htaccess mit Basic Auth und X-Robots-Tag; der Serverpfad bleibt Platzhalter
//   5 .htpasswd mit Benutzer „abend" (APR1-MD5, wie htpasswd -m; ohne Zusatzpakete)
//
// Danach: Inhalt von dist-staging/ per SFTP in den Staging-Ordner legen — siehe tools/README.md.

"use strict";
const fs = require("fs"), path = require("path"), crypto = require("crypto");

const ROOT = path.resolve(__dirname, "..");
const ZIEL = path.join(ROOT, "dist-staging");
const MIT = ["img", "uploads", "fonts"];          // Ordner, die mitgehen
const OHNE = new Set(["dist-staging", "tools", "_abnahme", ".git", "node_modules"]);
const PLATZHALTER = "[ABSOLUTER_SERVERPFAD]";

const ARGS = process.argv.slice(2);
const passIdx = ARGS.indexOf("--pass");
const PASS = passIdx >= 0 ? ARGS[passIdx + 1] : null;

// ---------- APR1 (Apache MD5), wie htpasswd -m ----------
function apr1(pw, salt) {
  const md5 = b => crypto.createHash("md5").update(b).digest();
  const p = Buffer.from(pw, "binary"), s = Buffer.from(salt, "binary");
  const stueck = [Buffer.from("$apr1$"), s];
  const alt = md5(Buffer.concat([p, s, p]));
  for (let pl = p.length; pl > 0; pl -= 16) stueck.push(alt.subarray(0, Math.min(pl, 16)));
  for (let i = p.length; i; i >>= 1) stueck.push(i & 1 ? Buffer.from([0]) : p.subarray(0, 1));
  let final = md5(Buffer.concat([p, ...stueck]));
  for (let i = 0; i < 1000; i++) {
    const teile = [];
    teile.push(i & 1 ? p : final);
    if (i % 3) teile.push(s);
    if (i % 7) teile.push(p);
    teile.push(i & 1 ? final : p);
    final = md5(Buffer.concat(teile));
  }
  const ZEICHEN = "./0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
  const to64 = (v, n) => { let o = ""; while (--n >= 0) { o += ZEICHEN[v & 0x3f]; v >>>= 6; } return o; };
  const paare = [[0, 6, 12], [1, 7, 13], [2, 8, 14], [3, 9, 15], [4, 10, 5]];
  let out = paare.map(([a, b, c]) => to64((final[a] << 16) | (final[b] << 8) | final[c], 4)).join("");
  out += to64(final[11], 2);
  return `$apr1$${salt}$${out}`;
}

// ---------- kopieren ----------
fs.rmSync(ZIEL, { recursive: true, force: true });
fs.mkdirSync(ZIEL, { recursive: true });

function kopiereOrdner(rel) {
  const von = path.join(ROOT, rel), nach = path.join(ZIEL, rel);
  if (!fs.existsSync(von)) return;
  fs.mkdirSync(nach, { recursive: true });
  for (const e of fs.readdirSync(von, { withFileTypes: true })) {
    if (e.isDirectory()) kopiereOrdner(path.join(rel, e.name));
    else fs.copyFileSync(path.join(von, e.name), path.join(nach, e.name));
  }
}
for (const o of MIT) kopiereOrdner(o);

const seiten = fs.readdirSync(ROOT).filter(f => f.endsWith(".html") && !OHNE.has(f));
const absolute = [];   // {datei, zeile, treffer}
let nMeta = 0, nUmami = 0, nPfade = 0;

for (const f of seiten) {
  let t = fs.readFileSync(path.join(ROOT, f), "utf8");
  const NL = t.includes("\r\n") ? "\r\n" : "\n";

  // 1 noindex (nur ergänzen, wenn nicht schon vorhanden)
  if (!/<meta name="robots"[^>]*noindex/i.test(t)) {
    t = t.replace(/<head>(\r?\n)?/, m => m + `<meta name="robots" content="noindex, nofollow">` + NL);
    nMeta++;
  }

  // 2 Umami raus: Script-Tag und der Helfer-Block aus T59; die Aufrufe laufen ohne window.umami ins Leere,
  //   der Newsletter-Handler bleibt damit unangetastet.
  const vorher = t;
  t = t.replace(/[ \t]*<script defer src="https:\/\/cloud\.umami\.is\/script\.js"[^>]*><\/script>\r?\n?/g, "");
  t = t.replace(/[ \t]*\/\/ T59 Umami:[\s\S]*?\r?\n[ \t]*\}\)\(\);\r?\n/, "");
  if (t !== vorher) nUmami++;

  // 3 absolute Pfade finden und relativ machen (die Seiten liegen alle flach im Wurzelordner des Pakets)
  t = t.replace(/(href|src)="\/(?!\/)([^"]*)"/g, (m, attr, rest, off) => {
    const zeile = t.slice(0, off).split(/\r?\n/).length;
    absolute.push({ datei: f, zeile, treffer: m });
    nPfade++;
    return `${attr}="${rest}"`;
  });

  fs.writeFileSync(path.join(ZIEL, f), t);
}

// ---------- 4 .htaccess ----------
fs.writeFileSync(path.join(ZIEL, ".htaccess"), [
  "AuthType Basic",
  'AuthName "HESPYRA"',
  `AuthUserFile ${PLATZHALTER}/.htpasswd`,
  "Require valid-user",
  'Header set X-Robots-Tag "noindex, nofollow, noarchive"',
  "",
].join("\n"));

// ---------- 5 .htpasswd ----------
let passHinweis = "";
if (PASS) {
  const ZEICHEN = "./0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
  const salt = Array.from(crypto.randomBytes(8)).map(b => ZEICHEN[b & 0x3f]).join("");
  fs.writeFileSync(path.join(ZIEL, ".htpasswd"), `abend:${apr1(PASS, salt)}\n`);
} else {
  passHinweis = "Ohne --pass keine .htpasswd geschrieben. Für den Upload: node tools/staging.js --pass <passwort>";
}

// ---------- Bericht ----------
console.log(`dist-staging/: ${seiten.length} Seiten, ${MIT.filter(o => fs.existsSync(path.join(ROOT, o))).join(", ")} kopiert`);
console.log(`noindex ergänzt: ${nMeta} · Umami entfernt: ${nUmami} · absolute Pfade umgeschrieben: ${nPfade}`);
for (const a of absolute) console.log(`  ${a.datei}:${a.zeile}  ${a.treffer}`);
console.log(`.htaccess geschrieben (Serverpfad bleibt ${PLATZHALTER})`);
if (passHinweis) console.log(passHinweis);
