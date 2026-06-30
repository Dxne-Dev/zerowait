# zerowait

**L'install qui survit aux coupures de connexion.**

Un CLI pour scaffolder ou installer un projet Node.js de façon résiliente, pensé pour les connexions lentes ou instables (4G capricieuse, coupures fréquentes, etc.).

```bash
npm install -g zerowait
zerowait init mon-projet --stack react-tailwind
```

---

## Le problème

Sur une connexion faible, `npm install` peut prendre 5 à 30 minutes — parfois plus. Une coupure en cours de route force généralement à tout relancer depuis zéro. Et un install lent ressemble souvent à un install figé, ce qui pousse à l'annuler par frustration (`Ctrl+C`) alors qu'il avançait simplement à son rythme.

zerowait ne réinvente pas npm. C'est une fine couche de résilience autour d'un install classique :

- **Bun en moteur** quand disponible — beaucoup moins de requêtes réseau que npm
- **Retry automatique avec backoff progressif** sur échec — chaque tentative reprend ce qui manque (grâce au lockfile + cache local), au lieu de tout retélécharger
- **Signe de vie régulier** pendant l'install, pour ne jamais laisser penser que ça a planté
- **Fallback npm transparent** si Bun n'est pas installé sur la machine

---

## Installation

```bash
npm install -g zerowait
```

Ou sans installation globale :

```bash
npx zerowait <commande>
```

---

## Cas d'utilisation

### 1. Démarrer un nouveau projet depuis un template

```bash
zerowait init mon-app --stack react-tailwind
zerowait init mon-api --stack express-ts
```

Crée le dossier, copie un template prêt à l'emploi (`package.json`, config, structure de base), puis installe les dépendances avec la logique de retry.

```bash
cd mon-app
npm run dev   # ou bun dev si Bun est installe
```

### 2. Installer les dépendances d'un projet déjà cloné

Le cas le plus courant : tu viens de `git clone` un repo qui a déjà son propre `package.json`, et tu veux juste démarrer vite sans te soucier d'une coupure réseau en plein milieu.

```bash
git clone https://github.com/quelquun/un-projet.git
cd un-projet
zerowait install
```

`zerowait install` n'écrase rien et ne touche à aucun fichier du repo — il se contente d'installer les dépendances avec retry/backoff à partir du `package.json` existant.

### 3. Connexion qui coupe en plein install

C'est le scénario que zerowait gère explicitement. Si l'install échoue (timeout, coupure réseau), zerowait :

1. Affiche un message clair (pas une erreur cryptique)
2. Attend un délai progressif (4s, 8s, 12s... jusqu'à 60s max)
3. Relance l'install — qui reprend là où elle s'était arrêtée
4. Répète jusqu'à 8 tentatives avant d'abandonner proprement

Si les 8 tentatives échouent, rien n'est perdu : ce qui a déjà été téléchargé reste en cache, et il suffit de relancer `zerowait install` (ou `zerowait init`) plus tard.

### 4. Machine sans Bun installé

zerowait fonctionne avec npm seul. Si Bun n'est pas détecté, il affiche simplement comment l'installer (optionnel) et continue avec npm — aucun blocage.

---

## Stacks disponibles (pour `init`)

| Stack | Description |
|---|---|
| `express-ts` | API Express + TypeScript, prête pour `npm run dev` |
| `react-tailwind` | App React + Tailwind + Vite |

D'autres stacks sont prévues (voir [Roadmap](#roadmap)).

---

## Commandes

| Commande | Description |
|---|---|
| `zerowait init <nom> --stack <stack>` | Crée un nouveau projet à partir d'un template |
| `zerowait install` (alias `i`) | Installe les dépendances du projet présent dans le dossier courant |

---

## Pourquoi pas juste Bun, pnpm ou Yarn Zero-Installs ?

| Outil | Ce qu'il résout | Ce qu'il ne résout pas |
|---|---|---|
| **Bun** | Réduit drastiquement le nombre de requêtes réseau | Pas de reprise automatique sur coupure, pas de feedback "ça avance encore" |
| **pnpm** | Évite de re-télécharger un paquet déjà présent ailleurs sur la machine | Ne change rien au tout premier install sur une machine neuve |
| **Yarn Zero-Installs** | Élimine l'install au clone (cache commité dans Git) | Alourdit le repo, contraignant à mettre en place, peu adopté en pratique |

zerowait s'appuie sur Bun quand c'est possible et ajoute la couche qui manque partout ailleurs : la résilience face à une connexion qui coupe ou qui rame, avec une UX qui rassure plutôt que d'inquiéter.

---

## Comment ça marche techniquement

- La détection de Bun/npm se fait via `execSync` (plus fiable cross-platform que `spawnSync`, notamment sur Windows où `npm`/`bun` sont des `.cmd`)
- Le retry s'appuie sur le comportement natif du gestionnaire de paquets : un lockfile + un cache local font qu'un `install` relancé ne retélécharge que ce qui manque, jamais l'intégralité
- Le backoff est volontairement progressif (4s × tentative, plafonné à 60s) pour laisser le temps à une connexion de se stabiliser sans pour autant attendre indéfiniment
- Aucune dépendance externe : zerowait est un script Node.js pur, donc son propre install est quasi instantané

---

## Roadmap

- [ ] Stacks supplémentaires (Next.js, NestJS)
- [ ] Cache régional partagé (option Verdaccio)
- [ ] Détection automatique de la qualité réseau pour ajuster dynamiquement le backoff
- [ ] Tests automatisés (simulation de coupure réseau en CI)

---

## Contribuer

Les PR sont les bienvenues, en particulier pour :
- de nouveaux templates de stack
- des retours d'usage sur connexion instable (logs, captures, contexte réseau)
- des améliorations à la logique de retry

```bash
git clone https://github.com/<ton-compte>/zerowait.git
cd zerowait
npm link
zerowait init test --stack react-tailwind   # pour tester en local
```

---

## Licence

MIT — voir [LICENSE](./LICENSE).
