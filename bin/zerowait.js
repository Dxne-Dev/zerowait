#!/usr/bin/env node
"use strict";

const { spawn, execSync } = require("child_process");
const fs = require("fs");
const path = require("path");
const readline = require("readline");

const TEMPLATES_DIR = path.join(__dirname, "..", "templates");
const MAX_RETRIES = 8;
const BASE_DELAY_MS = 4000; // backoff de base, multiplie a chaque tentative
const MAX_DELAY_MS = 60000;
const STALL_TIMEOUT_MS = 45000; // si node_modules ne grossit plus pendant ce temps, on considere que c'est bloque

// ---------- Couleurs (ANSI, sans dependance externe) ----------

const COLOR_ENABLED = process.stdout.isTTY && !process.env.NO_COLOR;

function paint(code, text) {
  if (!COLOR_ENABLED) return text;
  return `\x1b[${code}m${text}\x1b[0m`;
}

const c = {
  green: (t) => paint("32", t),
  red: (t) => paint("31", t),
  yellow: (t) => paint("33", t),
  cyan: (t) => paint("36", t),
  gray: (t) => paint("90", t),
  bold: (t) => paint("1", t),
};

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
      process.stdout.write(`  ${c.yellow(label)} — nouvelle tentative dans ${remaining}s...`);
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

function formatDuration(ms) {
  const totalSeconds = Math.round(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes === 0) return `${seconds}s`;
  return `${minutes}min ${seconds}s`;
}

// ---------- Spinner + barre de progression ----------

const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

function renderProgressBar(current, total, width = 24) {
  const ratio = total > 0 ? Math.min(current / total, 1) : 0;
  const filled = Math.round(ratio * width);
  const bar = "█".repeat(filled) + "░".repeat(width - filled);
  const pct = Math.round(ratio * 100);
  return `${c.cyan(bar)} ${pct}%`;
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
  log(c.yellow("⚠️  Bun n'est pas installe sur cette machine."));
  log(c.gray("   Bun reduit fortement le nombre de requetes reseau par rapport a npm,"));
  log(c.gray("   ce qui aide beaucoup sur une connexion lente ou instable."));
  log("");
  log(c.gray("   Pour l'installer (une seule fois, sur Linux/Mac) :"));
  log("   curl -fsSL https://bun.sh/install | bash");
  log("");
  log(c.gray("   zerowait peut quand meme continuer avec npm, mais ce sera plus lent"));
  log(c.gray("   et moins resilient aux coupures."));
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

// ---------- Mesure de progression ----------

function countInstalledFiles(cwd) {
  try {
    const nodeModules = path.join(cwd, "node_modules");
    if (!fs.existsSync(nodeModules)) return 0;
    return fs.readdirSync(nodeModules).length;
  } catch {
    return -1; // dossier en cours d'ecriture, lecture impossible a cet instant precis
  }
}

/**
 * Le nombre de dossiers dans node_modules depasse largement le nombre de
 * dependances declarees dans package.json (deps transitives, hoisting).
 * Utiliser package.json comme total donnerait un pourcentage qui explose
 * bien avant la fin. On utilise plutot le lockfile (genere des la premiere
 * tentative), qui liste le nombre reel de paquets a installer.
 */
function getTotalPackagesTarget(cwd) {
  const npmLock = path.join(cwd, "package-lock.json");
  if (fs.existsSync(npmLock)) {
    try {
      const lock = JSON.parse(fs.readFileSync(npmLock, "utf8"));
      if (lock.packages) {
        const keys = Object.keys(lock.packages).filter((k) => k !== "");
        if (keys.length > 0) return keys.length;
      }
    } catch {
      // lockfile en cours d'ecriture, on ignore
    }
  }
  const bunLock = path.join(cwd, "bun.lock");
  if (fs.existsSync(bunLock)) {
    try {
      const raw = fs.readFileSync(bunLock, "utf8");
      const matches = raw.match(/^\s{2}"[^"]+":\s*\[/gm);
      if (matches && matches.length > 0) return matches.length;
    } catch {
      // idem
    }
  }
  return null; // pas encore de cible fiable connue
}

// ---------- Coeur : install resilient avec retry/resume ----------

/**
 * Lance `bun install` (ou `npm install` en repli) dans cwd.
 * En cas d'echec (coupure reseau, timeout, etc.), reessaie avec un
 * backoff progressif. Comme le gestionnaire de paquets ne re-telecharge
 * que ce qui manque (lockfile + cache local), chaque tentative reprend
 * la ou la precedente s'est arretee au lieu de tout recommencer.
 *
 * Retourne { success, attempts, elapsedMs, finalCount } pour permettre
 * un resume final honnete et informatif.
 */
async function resilientInstall(cwd, useBun) {
  const cmd = useBun ? "bun" : "npm";
  const args = ["install"];
  const startedAt = Date.now();

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    log(`\n${c.bold("📦 Installation des dependances")} ${c.gray(`avec ${cmd} (tentative ${attempt}/${MAX_RETRIES})`)}`);

    const success = await runInstallOnce(cmd, args, cwd);
    const elapsedMs = Date.now() - startedAt;

    if (success) {
      log(c.green("✅ Dependances installees."));
      return { success: true, attempts: attempt, elapsedMs, finalCount: countInstalledFiles(cwd) };
    }

    if (attempt === MAX_RETRIES) {
      log("");
      log(c.red("❌ Echec apres plusieurs tentatives. Rien n'est perdu :"));
      log(c.gray("   ce qui a deja ete telecharge reste en cache."));
      log(c.gray(`   Relance simplement : cd ${path.basename(cwd)} && ${cmd} install`));
      return { success: false, attempts: attempt, elapsedMs, finalCount: countInstalledFiles(cwd) };
    }

    const delay = Math.min(BASE_DELAY_MS * attempt, MAX_DELAY_MS);
    log(c.yellow("⚠️  Connexion interrompue ou trop lente."));
    await countdown(Math.round(delay / 1000), "Reprise automatique");
  }

  return { success: false, attempts: MAX_RETRIES, elapsedMs: Date.now() - startedAt, finalCount: countInstalledFiles(cwd) };
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

    let settled = false;
    let lastCount = countInstalledFiles(cwd);
    let msSinceGrowth = 0;
    let spinnerFrame = 0;
    let total = getTotalPackagesTarget(cwd);

    // Rendu rapide (spinner fluide) toutes les 150ms.
    const render = setInterval(() => {
      spinnerFrame = (spinnerFrame + 1) % SPINNER_FRAMES.length;
      const count = Math.max(lastCount, 0);
      clearLine();
      if (total) {
        process.stdout.write(`  ${c.cyan(SPINNER_FRAMES[spinnerFrame])} ${renderProgressBar(count, total)} ${c.gray(`(${count}/${total})`)}`);
      } else {
        process.stdout.write(`  ${c.cyan(SPINNER_FRAMES[spinnerFrame])} ${c.gray(`${count} paquets ecrits...`)}`);
      }
    }, 150);

    // Verification de la progression reelle + detection de blocage toutes les 5s.
    //
    // npm reste souvent silencieux une fois les warnings initiaux passes, donc
    // on ne peut pas se fier au texte de sortie pour prouver que ca avance —
    // on observe la croissance reelle de node_modules. npm peut aussi rester
    // accroche indefiniment sur une connexion morte sans jamais crasher, donc
    // sans jamais declencher le retry (qui ne reagit qu'a un code d'erreur).
    // On force un arret si node_modules ne grossit plus pendant STALL_TIMEOUT_MS.
    const watchdog = setInterval(() => {
      const count = countInstalledFiles(cwd);
      const growing = count > lastCount;

      if (growing) {
        msSinceGrowth = 0;
      } else {
        msSinceGrowth += 5000;
      }
      lastCount = count >= 0 ? count : lastCount;

      if (!total) {
        total = getTotalPackagesTarget(cwd);
      }

      if (msSinceGrowth >= STALL_TIMEOUT_MS) {
        clearInterval(render);
        clearInterval(watchdog);
        clearLine();
        log("");
        log(c.yellow("⏱️  Aucune progression detectee depuis 45s — connexion probablement bloquee."));
        log(c.gray("   Arret de cette tentative, nouvelle tentative dans quelques secondes..."));
        child.kill();
      }
    }, 5000);

    child.stdout.on("data", () => {});
    child.stderr.on("data", () => {});

    child.on("error", () => {
      if (settled) return;
      settled = true;
      clearInterval(render);
      clearInterval(watchdog);
      clearLine();
      resolve(false);
    });

    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearInterval(render);
      clearInterval(watchdog);
      clearLine();
      resolve(code === 0);
    });
  });
}

// ---------- Resume final ----------

function printSummary(result) {
  const { attempts, elapsedMs, finalCount } = result;
  log("");
  log(c.gray(`   ${finalCount} paquets installes en ${formatDuration(elapsedMs)}.`));
  if (attempts === 1) {
    log(c.gray("   Installe du premier coup, aucune coupure detectee."));
  } else {
    log(c.gray(`   Installe apres ${attempts} tentatives — la reprise automatique a fait son travail.`));
  }
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

  log(`\n${c.bold("🚀 zerowait")} ${c.gray("— l'install qui survit aux coupures de connexion")}\n`);
  log(c.gray(`Dossier: ${cwd}`));

  const useBun = hasBun();
  if (!useBun) {
    suggestBunInstall();
    if (!hasCommand("npm")) {
      log(c.red("npm n'est pas disponible non plus. Installe Node.js ou Bun pour continuer."));
      process.exit(1);
    }
  } else {
    log(c.green("✓ Bun detecte."));
  }

  const result = await resilientInstall(cwd, useBun);

  if (result.success) {
    log("");
    log(c.green("🎉 Dependances installees.") + " Tu peux lancer ton projet normalement");
    log("   (npm run dev, bun dev, etc. selon ce que le repo attend).");
    printSummary(result);
  } else {
    log("");
    log(c.red("L'install n'a pas abouti") + " — relance simplement `zerowait install` quand la connexion sera meilleure.");
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
    log(c.red(`Stack inconnue: "${stack}".`));
    log("Stacks disponibles: " + fs.readdirSync(TEMPLATES_DIR).join(", "));
    process.exit(1);
  }

  const targetDir = path.resolve(process.cwd(), projectName);
  if (fs.existsSync(targetDir)) {
    log(c.red(`Le dossier "${projectName}" existe deja.`) + " Choisis un autre nom.");
    process.exit(1);
  }

  log(`\n${c.bold("🚀 zerowait")} ${c.gray("— l'install qui survit aux coupures de connexion")}\n`);
  log(c.gray(`Stack: ${stack}`));
  log(c.gray(`Dossier: ${targetDir}`));

  copyDir(templatePath, targetDir);
  applyProjectName(targetDir, projectName);
  log(c.green("✓ Template copie."));

  const useBun = hasBun();
  if (!useBun) {
    suggestBunInstall();
    if (!hasCommand("npm")) {
      log(c.red("npm n'est pas disponible non plus. Installe Node.js ou Bun pour continuer."));
      process.exit(1);
    }
  } else {
    log(c.green("✓ Bun detecte."));
  }

  const result = await resilientInstall(targetDir, useBun);

  if (result.success) {
    log("");
    log(c.green("🎉 Projet pret !"));
    log(`   cd ${projectName}`);
    log(useBun ? "   bun dev" : "   npm run dev");
    printSummary(result);
  } else {
    log("");
    log(c.red("Le projet est cree mais l'install n'a pas abouti") + " — relance la commande ci-dessus quand la connexion sera meilleure.");
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
    log(`${c.bold("zerowait")} ${c.gray("— l'install qui survit aux coupures de connexion")}\n`);
    log("Usage:");
    log("  zerowait init <nom-du-projet> --stack <express-ts|react-tailwind>");
    log(c.gray("    -> cree un nouveau projet a partir d'un template\n"));
    log("  zerowait install");
    log(c.gray("    -> installe les dependances d'un projet existant (deja clone,"));
    log(c.gray("       avec son propre package.json) depuis le dossier courant\n"));
    log("Stacks disponibles (pour init): " + fs.readdirSync(TEMPLATES_DIR).join(", "));
  }
}

main();
