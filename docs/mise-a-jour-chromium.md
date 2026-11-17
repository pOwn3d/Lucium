# Mettre à jour Chromium (Electron)

Lucium suit Chromium en suivant Electron. La ligne principale tourne sur l'Electron officiel, épinglé à une version exacte dans `package.json` ; la variante DRM tourne sur l'Electron de castLabs (`docs/drm.md`). Cette page décrit la chaîne « détecter → préparer → essayer → déployer » et ses outils.

Principes :

- Une veille hébergée (GitHub Actions) détecte et prévient ; elle ne signe rien et n'a aucun secret.
- La préparation, la signature et la notarisation se font sur le Mac de construction : l'identité Developer ID, la session EVS et le profil de notarisation restent dans son trousseau, jamais dans un fichier suivi ni dans la CI.
- Aucune télémétrie, aucun compte : rien ne part de l'application installée pour cette chaîne.

## 1. Les rythmes à connaître

- **Chromium** publie une version stable toutes les deux semaines, avec des correctifs de sécurité entre deux stables.
- **Electron** publie une majeure toutes les huit semaines, le jour de la version stable de Chromium à un ou deux jours près ; une majeure couvre plusieurs jalons de Chromium. Les trois dernières majeures sont soutenues : la plus récente reçoit tous les correctifs, la plus ancienne seulement ceux de sécurité. Les correctifs de sécurité de Chromium sont rétroportés tous les quelques jours. Entre deux majeures, Electron reste sur un jalon : les fonctions nouvelles de Chromium attendent la majeure suivante. Sources : `releases.json` et `schedule.json` de <https://releases.electronjs.org>, `docs/tutorial/electron-timelines.md` d'Electron.
- **castLabs** suit d'ordinaire une version d'Electron à un à cinq jours, par lots mensuels, sans engagement (« best-effort ») et pas pour chaque version ; la première version stable d'une nouvelle majeure peut arriver plusieurs semaines après Electron. Quand castLabs ne publie pas une version précise, la variante DRM passe à la suivante.

D'où la règle : **la ligne principale suit Electron sans attendre ; la variante DRM suit castLabs quand il publie.**

## 2. Ce qui, dans le code, dépend de Chromium

- Le User-Agent des pages est dérivé de `process.versions.chrome` (`chromeUserAgent`, `src/main/engine/electron-engine.ts`, avec un garde-fou qui journalise une version inattendue).
- La page du Chrome Web Store se voit annoncer une version de référence quand le Chromium réel dépasse un seuil (`STORE_TRUST_THRESHOLD`, `src/shared/web-store.ts`) : à revérifier à chaque jalon.
- La référence de l'API des extensions (`compat/baseline-electron-<version>.json`) et la procédure « Comment mettre à jour Chromium sans casse » de `docs/architecture.md`.
- `electron-chrome-extensions` et `electron-chrome-web-store` ne déclarent aucune plage d'Electron : leur compatibilité avec une majeure ne se connaît qu'à l'essai.

## 3. Les outils

| Fichier | Rôle |
|---|---|
| `src/main/electron-watch.ts` | Logique pure : versions (semver avec préversions et métadonnées `+wvcus`), lecture stricte des flux, comparaison, alertes (version castLabs absente, avis de sécurité, fin de vie), rapport texte. Aucune lecture réseau ni écriture : la fonction de lecture est passée en paramètre. Tests : `src/main/electron-watch.test.ts`. |
| `scripts/electron-watch.mjs` (`pnpm electron:watch`) | Lecture seule : `node scripts/electron-watch.mjs [--json] [--timeout=ms] [--installed=X]`. Codes de sortie : **0** à jour, **10** mineure ou correctif, **20** majeure, **30** flux illisible (message sur stderr), **2** arguments ou version déclarée illisibles. |
| `scripts/electron-upgrade.mjs` (`pnpm electron:upgrade`) | Préparation en étapes rejouables (section 5). Ne committe pas, ne pousse pas, ne publie pas, ne lit ni n'écrit aucun secret. |
| `scripts/chromium-watch-issue.mjs` | L'issue de la veille : `node scripts/chromium-watch-issue.mjs --report=report.json --text=report.txt --repo=propriétaire/nom [--dry-run [--offline]]`. Une seule issue ouverte : créée s'il n'y en a pas, sinon réécrite. La version, le Chromium et la version déclarée sont vérifiés avant d'entrer dans le titre. Logique dans `src/main/chromium-watch-issue.ts`, tests dans `src/main/chromium-watch-issue.test.ts`. |
| `.github/workflows/chromium-watch.yml` | Veille quotidienne (06:17 UTC). Permissions `contents: read` et `issues: write`, actions épinglées par SHA, aucun secret. Code 10 ou 20 : une issue créée ou réécrite (un commentaire seulement quand la version change). Code 30 ou 2 : la tâche échoue. |

`.github/dependabot.yml` propose aussi une PR par version d'Electron, chaque semaine ; la veille ajoute la vue castLabs, Chromium et sécurité.

Les deux scripts filtrent eux-mêmes l'avertissement `MODULE_TYPELESS_PACKAGE_JSON` que Node émet en chargeant du TypeScript depuis un paquet sans champ `"type"`. Les options passent derrière la commande pnpm, par exemple `pnpm electron:upgrade 45.3.0 --dry-run`.

## 4. Détection

La veille tourne chaque jour sur un runner GitHub ; elle contacte `releases.electronjs.org`, chromiumdash (`chromiumdash.appspot.com`, versions stables de Chromium) et `api.github.com`, jamais depuis le Mac de construction. Son issue « Electron X (Chromium Y) disponible » donne les notes de version, les changements cassants, la page castLabs et la commande de préparation. Pour un état à la main : `node scripts/electron-watch.mjs`.

## 5. Préparation : `node scripts/electron-upgrade.mjs <version>`

Étapes, dans l'ordre (chacune rejouable seule avec `--steps=`) :

1. **check** (réseau, lecture seule) : la version existe dans `releases.json`, est stable (ou `--allow-prerelease`) et plus récente que celle de `package.json` ; tableau Electron, Chromium, Node, V8 avant → après ; pour un nouveau jalon, les liens à lire (notes de version, `breaking-changes.md`) ; `v<version>+wvcus` existe chez castLabs, sinon arrêt (ou `--without-ecs` : la ligne principale avance seule, `ecs` et `build` sont sautées).
2. **branch** : `git switch -c chore/electron-<version>` (ou bascule si elle existe) ; l'arbre de travail est gardé tel quel ; `--no-branch` pour rester.
3. **bump** : réécriture de la seule ligne `"electron": "…"` de `package.json` (arrêt si elle n'est pas trouvée exactement une fois), puis `pnpm install` (le lockfile et le binaire d'Electron suivent).
4. **typecheck** : `tsc` sur `tsconfig.node.json` et `tsconfig.web.json` (une API retirée apparaît ici).
5. **test** : `vitest run` ; avec `--engine`, `electron-vite build` puis le contrat moteur (même liste de sondes que `pnpm test:engine`) dans un profil temporaire, et le rappel de comparer avec `compat/baseline-electron-<ancienne>.json` (`pnpm compat:compare` après un `pnpm test:engine`). Le contrat moteur ouvre de vraies fenêtres.
6. **ecs** : téléchargement de `electron-v<version>+wvcus-darwin-arm64.zip` dans `~/Library/Application Support/lucium-drm-tools/ecs-<version>/` (hors du dépôt), **refusé si `SHASUMS256.txt` (pièce jointe de la version) et `checksums.json` (fichier du dépôt de castLabs au même tag) ne donnent pas la même somme SHA-256, si `scripts/ecs-checksums.json` a enregistré une autre somme pour cette archive, ou si l'archive téléchargée a une autre somme** (`src/main/ecs-checksum.ts`). Pour une version pas encore enregistrée, l'étape affiche la ligne à ajouter à `scripts/ecs-checksums.json`, dans le commit de la montée ; extraction par `ditto` ; contrôle du fichier `version`. L'étape **build** passe ensuite par `scripts/package-drm.mjs`, qui refuse une préversion, un moteur sans `+wvcus` et une version autre que l'Electron épinglé (`docs/drm.md`, « Le garde-fou du moteur »).
7. **build** : `node scripts/package-drm.mjs --castlabs-fuses` sur ce moteur, comme `scripts/build-drm-release.sh` (EVS ne signe que les fusibles d'origine ou l'ensemble castLabs, `docs/drm.md`). Non signée par défaut ; `--sign` ajoute `--vmp --apple` (EVS demande le mot de passe dans le terminal ; `LUCIUM_SIGN_IDENTITY` est un nom d'identité, pas un secret) ; `--as-lucium` pour le nom de l'application normale.
8. **notarize** : avec `--sign --notarize` et `LUCIUM_NOTARY_PROFILE` (le nom d'un profil du trousseau, `docs/drm.md`, section « Notarisation »), zip jetable, `xcrun notarytool submit … --keychain-profile <nom> --wait`, refus si Apple ne répond pas `Accepted`, puis `xcrun stapler staple`, `stapler validate` et `spctl --assess`. Sans `--notarize`, l'étape dit seulement qu'elle est sautée. La constante `NOTARIZATION_ENABLED` du script la coupe entièrement.
9. **report** : le changement de versions, où est l'application, la commande d'essai (section 6), les fichiers modifiés (`package.json`, `pnpm-lock.yaml`) et la suite.

Autres options : `--dry-run` (affiche ce que chaque étape lancerait, n'écrit rien), `--timeout=ms` (attente de chaque flux, 15 s par défaut). Codes de sortie : 0 fait, 1 une étape a échoué (le message dit laquelle et pourquoi), 2 arguments faux.

### Ce qu'une majeure casse d'habitude

Lire `docs/breaking-changes.md` d'Electron pour la version visée, puis chercher chaque API citée dans `src/`. Une majeure demande en général de relire une liste de cinq à dix points et d'en corriger quelques-uns ; un correctif ne demande rien, sauf un changement de comportement de Chromium vu par le contrat moteur. Points connus pour Electron 46 :

- `capturePage()` rend une image à l'échelle de la page (tailles en DIP, plus en pixels) : les octets PNG ne changent pas, mais `getSize()`, `crop()` et `resize()` changent d'unité sur un écran Retina. À essayer : captures, vignettes de ⌃Tab, aperçus.
- `unload` ne s'exécute plus sur les pages http(s) : l'interface, en `file://`, n'est pas concernée.
- `safeStorage.encryptString/decryptString/isEncryptionAvailable` sont retirés au profit de versions asynchrones, `utilityProcess` `child.kill()` ne force plus l'arrêt, `--no-stdio-init` est retiré : Lucium n'utilise aucun des trois.

À chaque montée, majeure ou non : la fenêtre flottante des appels (`document-pip`) passe par l'événement interne `-add-new-contents`. Relire electron/electron#39633, l'écouteur de `-add-new-contents` dans `lib/browser/api/web-contents.ts` (la liste des dispositions qu'il garde, l'ordre de ses arguments) et `WebContents::AddNewContents` dans `shell/browser/api/electron_api_web_contents.cc`, puis lancer `LUCIUM_SMOKE_ONLY=docpip` : il dit ce qu'Electron transmet. Si Electron prend un jour en charge cette fenêtre (une disposition à lui, `EnterStandaloneDocumentPictureInPicture`), la reprise est à retirer.

## 6. Essai à côté de l'application installée

- **Application à côté** : sans `--as-lucium`, `package-drm.mjs` produit `dist-drm/mac-arm64/Lucium DRM.app`, identifiant `app.lucium.browser.drm` ; l'application installée n'est pas touchée. Les données, elles, seraient partagées (le nom interne, `Lucium`, est le même), d'où le point suivant.
- **Profil séparé, copie du vrai** (la build chiffre les cookies de la copie : ensemble castLabs) :

  ```sh
  rm -rf ~/Library/Application\ Support/lucium-next && ditto ~/Library/Application\ Support/Lucium ~/Library/Application\ Support/lucium-next
  open -na "dist-drm/mac-arm64/Lucium DRM.app" --args --user-data-dir="$HOME/Library/Application Support/lucium-next"
  ```

  L'étape `report` imprime ces commandes. Vérifier que le profil réel n'a pas bougé (`ls -lt` sur son `state.json`).

### Liste de contrôle

Dix à quinze minutes. Chaque point indique le test moteur qui le couvre déjà, quand il existe (`LUCIUM_SMOKE_ONLY=<nom>`).

| Point | À la main | Couvert par |
|---|---|---|
| Démarrage, profil copié reconnu, espaces et onglets restaurés | ouvrir, vérifier les espaces | `smoke-sessions`, `smoke-sidebar` |
| Netflix / Widevine (variante DRM) | lire 30 s d'un titre, vérifier la définition | aucun (il faut un abonnement) ; page de contrôle castLabs `wv-vmp-lab` |
| Vidéo sans DRM, image dans l'image, lecteur de la barre | une vidéo, bouton image dans l'image | `smoke-iso-media` |
| Extensions : Claude, Dashlane, une du Web Store | panneau latéral, remplissage, une installation | `smoke-extensions`, `smoke-extensions2`, `smoke-webstore`, `smoke-keyext` |
| Glisser d'onglets, vue scindée, dossiers | déplacer un onglet entre espaces, scinder | `smoke-tabsui`, `smoke-spaces2` |
| Fenêtres multiples, Mini-fenêtre, fenêtre privée | ⌘N, ⌥⌘-clic, ⇧⌘N | `smoke-windows`, `smoke-littlearc`, `smoke-extwindows` (hors chaîne : `pnpm test:engine:extwindows`) |
| Téléchargement, reprise | un fichier, quitter, reprendre | `smoke-downloads2`, `smoke-downloadresume` |
| Capture et annotation | capturer, annoter, coller | `smoke-capture` |
| Bloqueur, DNS chiffré, proxy | une page avec publicités, compteur du site | `smoke-blocker`, `smoke-privacy2`, `smoke-privacy3` |
| Mise à jour : « Rechercher des mises à jour… » | depuis les sources, avec `LUCIUM_UPDATE_FEED` pointé sur le flux du canal de test ; une build avec `--update-feed` : l'installation de bout en bout (docs/drm.md, section 12) | `src/shared/update-check.test.ts`, `src/main/shell/app-update.test.ts` (logique) |
| Mémoire et processeur au repos | `pnpm perf` contre `perf-budget.json` | `scripts/perf.mjs` |

Pour une majeure, lancer aussi le contrat moteur (`--engine`) et comparer la nouvelle référence de l'API des extensions à l'ancienne.

## 7. Déployer

**Qui.** La build de production et sa publication se font sur le Mac du mainteneur, par lui seul ([GOVERNANCE.fr.md](../GOVERNANCE.fr.md)). Aucun workflow ne signe, ne notarise ni ne publie, et aucun n'en a les secrets. La procédure complète est dans [`community/release-process.md`](community/release-process.md) ; cette section dit ce qui est propre à une montée de moteur.

**D'où vient une mise à jour.** Une variante DRM construite avec `--update-feed` **installe** la nouvelle version depuis l'adresse gravée à la build, par l'`autoUpdater` d'Electron (Squirrel.Mac), après un clic seulement (« Installer » dans la notice de la vérification automatique, ou Lucium › Rechercher les mises à jour…) : [docs/drm.md](drm.md), section 12. L'application construite n'installe depuis aucune autre adresse. Sans adresse gravée (depuis les sources, ou une build faite sans l'option), elle compare les versions et **ouvre la page de téléchargement** : réglages `autoUpdate` et `updateFeedUrl` (vide par défaut : rien ne se passe), variable `LUCIUM_UPDATE_FEED` (depuis les sources seulement) ; https obligatoire, redirection vers http refusée. La vérification automatique part 20 s après le lancement, puis une fois par jour. Il n'y a ni `electron-updater` ni `latest-mac.yml`.

**Deux canaux, tous deux sur lucium.app.** Un canal est un fichier de versions (`feed.json`, au format de Squirrel.Mac) et le dossier qui porte l'archive :

| Canal | Adresse gravée | Qui le suit |
|---|---|---|
| **Test** | `https://test.lucium.app/updates/darwin-arm64/feed.json` (`--test-feed`) | les installations où « Recevoir les versions de test » est coché (décoché par défaut) |
| **Stable** | `https://lucium.app/updates/darwin-arm64/feed.json` (`--update-feed`) | toutes les autres |

Les deux adresses sont gravées dans chaque build. GitHub ne sert aucun binaire : la Release d'une version porte le tag signé, les notes, les sommes SHA-256 et un lien vers lucium.app.

**Paliers** : le canal de test d'abord, puis la **même archive** sur le canal stable une fois la version essayée (`node scripts/publish-update.mjs`, puis `--channel stable`). Passer au stable ne demande ni nouvelle build ni nouvelle signature. Une mise à jour de sécurité critique peut passer au stable sans attendre, en le disant dans les notes. Un déploiement par pourcentage n'est pas possible avec un flux statique.

**Marche arrière** : il n'y en a pas par le flux. Squirrel refuse une version plus ancienne que celle qui tourne (`ElectronSquirrelPreventDowngrades`), et `compareVersions` n'offre que du plus récent. Une version fautive se remplace par une version plus haute (`X.Y.Z+1`, construite sur l'Electron précédent) ; ceux qui l'ont déjà installée la gardent jusque-là, ou réinstallent la précédente à la main.

**Correctif de sécurité urgent** (0-day de Chromium). Les délais des deux premières lignes sont ceux des projets en amont ; ceux de Lucium sont des objectifs, tenus par une seule personne :

| Étape | Délai |
|---|---|
| Chromium publie le correctif (jour J) | — |
| Electron le rétroporte sur les lignes soutenues | J à J+7 |
| Issue de veille | le lendemain matin au plus tard |
| castLabs | +1 à +5 jours, hors cycle pour un avis de sécurité |
| Préparation, tests, construction, signature (sections 5 et 6) | le jour même |
| Publication sur le canal de test, puis sur le stable sans attendre si l'avis est critique | à la suite |
| **Total, variante DRM (celle qui est publiée)** | **J+2 à J+13** |

**Qui fait quoi** :

| Tâche | Comment |
|---|---|
| Détection, issue | automatique : `chromium-watch.yml` |
| Préparation, tests, téléchargement vérifié, construction | une commande : `electron-upgrade.mjs` |
| Signature VMP | mot de passe EVS tapé dans le terminal (ou une session encore valable) : `--sign` |
| Signature Developer ID | automatique une fois le trousseau déverrouillé : `--sign` (`LUCIUM_SIGN_IDENTITY`) |
| Notarisation | `--notarize` avec `LUCIUM_NOTARY_PROFILE` |
| Archive de mise à jour, image disque | `scripts/build-drm-release.sh --notarize`, puis `node scripts/make-dmg.mjs` |
| Publication sur un canal, passage au stable | `node scripts/publish-update.mjs` (`--channel test`, puis `--channel stable`) |
| Tag signé, Release (notes, sommes, lien) | `git tag -s`, puis `release.yml` crée le brouillon sans fichier ; le mainteneur y ajoute les sommes et le publie |

## 8. Limites

- `--user-data-dir` sur une application empaquetée est à vérifier au premier essai (la fenêtre « À propos » ou `chrome://version` doit montrer le dossier `lucium-next`).
- La durée du contrat moteur pour une majeure n'est pas mesurée.
