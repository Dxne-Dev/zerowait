#!/usr/bin/env node
"use strict";

const { spawnSync, spawn, execSync } = require("child_process");
const fs = require("fs");
const path = require("path");
const readline = require("readline");

const TEMPLATES_DIR = path.join(__dirname, "..", "templates");
const MAX_RETRIES = 8;
const BASE_DELAY_MS = 4000; // backoff de base, multiplie a chaque tentative
const MAX_DELAY_MS = 60000;

// ---------- Utilitaires d'affichage ----------

function log(msg) {
  process.stdout.write(msg + "\n");
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function clearLine() {
  if (process.stdout.isTTY) {
    readline.clearLine(process.stdout, 0);
    readline.cursorTo(process.stdout, 0);
  }
}

function countdown(seconds, label) {
  return new Promise((resolve) => {
    let remaining = seconds;
    const tick = () => {
      clearLine();
      process.stdout.write(`  ${label} — nouvelle tentative dans ${remaining}s...`);
      remaining -= 1;
      if (remaining < 0) {
        clearLine();
        resolve();
      } else {
        setTimeout(tick, 1000);
      }
    };
    tick();
  });
}

// ---------- Detection de l'environnement ----------

const IS_WINDOWS = process.platform === "win32";

function commandExists(cmd) {
  try {
    execSync(`${cmd} --version`, { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

function hasBun() {
  return commandExists("bun");
}

function hasCommand(cmd) {
  return commandExists(cmd);
}

function suggestBunInstall() {
  log("");
  log("⚠️  Bun n'est pas installe sur cette machine.");
  log("   Bun reduit fortement le nombre de requetes reseau par rapport a npm,");
  log("   ce qui aide beaucoup sur une connexion lente ou instable.");
  log("");
  log("   Pour l'installer (une seule fois, sur Linux/Mac) :");
  log("   curl -fsSL https://bun.sh/install | bash");
  log("");
  log("   zerowait peut quand meme continuer avec npm, mais ce sera plus lent");
  log("   et moins resilient aux coupures.");
  log("");
}

// ---------- Copie de template ----------

function copyDir(src, dest) {
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      copyDir(srcPath, destPath);
    } else {
      fs.copyFileSync(srcPath, destPath);
    }
  }
}

function applyProjectName(targetDir, projectName) {
  const pkgPath = path.join(targetDir, "package.json");
  if (!fs.existsSync(pkgPath)) return;
  const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"));
  pkg.name = projectName
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "-")
    .replace(/-+/g, "-");
  fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + "\n");
}

// ---------- Coeur : install resilient avec retry/resume ----------

/**
 * Lance `bun install` (ou `npm install` en repli) dans cwd.
 * En cas d'echec (coupure reseau, timeout, etc.), reessaie avec un
 * backoff progressif. Comme le gestionnaire de paquets ne re-telecharge
 * que ce qui manque (lockfile + cache local), chaque tentative reprend
 * la ou la precedente s'est arretee au lieu de tout recommencer.
 */
async function resilientInstall(cwd, useBun) {
  const cmd = useBun ? "bun" : "npm";
  const args = ["install"];

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    log(`\n📦 Installation des dependances avec ${cmd} (tentative ${attempt}/${MAX_RETRIES})...`);

    const success = await runInstallOnce(cmd, args, cwd);

    if (success) {
      log("✅ Dependances installees.");
      return true;
    }

    if (attempt === MAX_RETRIES) {
      log("\n❌ Echec apres plusieurs tentatives. Rien n'est perdu :");
      log("   ce qui a deja ete telecharge reste en cache.");
      log(`   Relance simplement : cd ${path.basename(cwd)} && ${cmd} install`);
      return false;
    }

    const delay = Math.min(BASE_DELAY_MS * attempt, MAX_DELAY_MS);
    log("⚠️  Connexion interrompue ou trop lente.");
    await countdown(Math.round(delay / 1000), "Reprise automatique");
  }

  return false;
}

function countInstalledFiles(cwd) {
  try {
    const nodeModules = path.join(cwd, "node_modules");
    if (!fs.existsSync(nodeModules)) return 0;
    return fs.readdirSync(nodeModules).length;
  } catch {
    return -1; // dossier en cours d'ecriture, lecture impossible a cet instant precis
  }
}

function runInstallOnce(cmd, args, cwd) {
  return new Promise((resolve) => {
    // Sur Windows, shell:true + tableau d'arguments declenche un warning Node
    // (DEP0190). On evite ca en construisant une seule chaine de commande —
    // sans risque ici car args est toujours une valeur fixe ("install"),
    // jamais une entree utilisateur.
    const command = IS_WINDOWS ? `${cmd} ${args.join(" ")}` : cmd;
    const commandArgs = IS_WINDOWS ? [] : args;

    const child = spawn(command, commandArgs, { cwd, stdio: ["ignore", "pipe", "pipe"], shell: IS_WINDOWS });

    let lastLine = "";
    let settled = false;
    let lastCount = countInstalledFiles(cwd);

    // npm reste souvent silencieux une fois les warnings initiaux passes
    // (rien n'est imprime avant le resume final). On ne peut donc pas se fier
    // uniquement au texte de sortie pour prouver que ca avance : on observe
    // aussi la croissance reelle de node_modules en parallele.
    const heartbeat = setInterval(() => {
      const count = countInstalledFiles(cwd);
      const growing = count > lastCount;
      lastCount = count >= 0 ? count : lastCount;
      clearLine();
      const status = growing ? `${count} paquets ecrits, ca avance` : "verification en cours";
      process.stdout.write(`  ... toujours en cours (${status})`);
    }, 5000);

    const onData = (data) => {
      const text = data.toString().trim();
      if (text) lastLine = text.split("\n").pop();
    };

    child.stdout.on("data", onData);
    child.stderr.on("data", onData);

    child.on("error", () => {
      if (settled) return;
      settled = true;
      clearInterval(heartbeat);
      clearLine();
      resolve(false);
    });

    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearInterval(heartbeat);
      clearLine();
      resolve(code === 0);
    });
  });
}

// ---------- Commande: install (projet existant) ----------

async function cmdInstall() {
  const cwd = process.cwd();
  const pkgPath = path.join(cwd, "package.json");

  if (!fs.existsSync(pkgPath)) {
    log(`Aucun package.json trouve dans ${cwd}.`);
    log("Lance cette commande depuis la racine du projet clone.");
    process.exit(1);
  }

  log(`\n🚀 zerowait — l'install qui survit aux coupures de connexion\n`);
  log(`Dossier: ${cwd}`);

  const useBun = hasBun();
  if (!useBun) {
    suggestBunInstall();
    if (!hasCommand("npm")) {
      log("npm n'est pas disponible non plus. Installe Node.js ou Bun pour continuer.");
      process.exit(1);
    }
  } else {
    log("✓ Bun detecte.");
  }

  const ok = await resilientInstall(cwd, useBun);

  log("");
  if (ok) {
    log("🎉 Dependances installees. Tu peux lancer ton projet normalement");
    log("   (npm run dev, bun dev, etc. selon ce que le repo attend).");
  } else {
    log("L'install n'a pas abouti — relance simplement `zerowait install` quand la connexion sera meilleure.");
  }
}

// ---------- Commande: init ----------

async function cmdInit(projectName, stack) {
  if (!projectName) {
    log("Usage: zerowait init <nom-du-projet> --stack <express-ts|react-tailwind>");
    process.exit(1);
  }

  const templatePath = path.join(TEMPLATES_DIR, stack);
  if (!fs.existsSync(templatePath)) {
    log(`Stack inconnue: "${stack}".`);
    log("Stacks disponibles: " + fs.readdirSync(TEMPLATES_DIR).join(", "));
    process.exit(1);
  }

  const targetDir = path.resolve(process.cwd(), projectName);
  if (fs.existsSync(targetDir)) {
    log(`Le dossier "${projectName}" existe deja. Choisis un autre nom.`);
    process.exit(1);
  }

  log(`\n🚀 zerowait — l'install qui survit aux coupures de connexion\n`);
  log(`Stack: ${stack}`);
  log(`Dossier: ${targetDir}`);

  copyDir(templatePath, targetDir);
  applyProjectName(targetDir, projectName);
  log("✓ Template copie.");

  const useBun = hasBun();
  if (!useBun) {
    suggestBunInstall();
    if (!hasCommand("npm")) {
      log("npm n'est pas disponible non plus. Installe Node.js ou Bun pour continuer.");
      process.exit(1);
    }
  } else {
    log("✓ Bun detecte.");
  }

  const ok = await resilientInstall(targetDir, useBun);

  log("");
  if (ok) {
    log("🎉 Projet pret !");
    log(`   cd ${projectName}`);
    log(useBun ? "   bun dev" : "   npm run dev");
  } else {
    log("Le projet est cree mais l'install n'a pas abouti — relance la commande ci-dessus quand la connexion sera meilleure.");
  }
}

// ---------- Entree CLI ----------

function parseArgs(argv) {
  const [cmd, projectName, ...rest] = argv;
  let stack = "express-ts";
  for (let i = 0; i < rest.length; i++) {
    if (rest[i] === "--stack" && rest[i + 1]) {
      stack = rest[i + 1];
      i++;
    }
  }
  return { cmd, projectName, stack };
}

async function main() {
  const argv = process.argv.slice(2);
  const { cmd, projectName, stack } = parseArgs(argv);

  if (cmd === "init") {
    await cmdInit(projectName, stack);
  } else if (cmd === "install" || cmd === "i") {
    await cmdInstall();
  } else {
    log("zerowait — l'install qui survit aux coupures de connexion\n");
    log("Usage:");
    log("  zerowait init <nom-du-projet> --stack <express-ts|react-tailwind>");
    log("    -> cree un nouveau projet a partir d'un template\n");
    log("  zerowait install");
    log("    -> installe les dependances d'un projet existant (deja clone,");
    log("       avec son propre package.json) depuis le dossier courant\n");
    log("Stacks disponibles (pour init): " + fs.readdirSync(TEMPLATES_DIR).join(", "));
  }
}

main();
