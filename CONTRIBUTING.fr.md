# Contribuer à Lucium

Merci de vouloir aider. Lucium est un navigateur libre et communautaire, qui n'avance que par des contributions de toutes tailles : un rapport de bug précis, une mesure soigneuse, une coquille corrigée, une fonction construite.

[English](CONTRIBUTING.md) · Français (les deux versions disent la même chose et changent dans le même commit)

Vous pouvez écrire en français ou en anglais dans les issues, les discussions et les pull requests.

## Sommaire

- [Comment on collabore](#comment-on-collabore)
- [Signaler un bug](#signaler-un-bug)
- [Proposer une fonction](#proposer-une-fonction)
- [Exclu par décision](#exclu-par-décision)
- [La règle de non-reprise](#la-règle-de-non-reprise)
- [Mesurer un navigateur sans toucher à vos données](#mesurer-un-navigateur-sans-toucher-à-vos-données)
- [Préparer votre environnement](#préparer-votre-environnement)
- [Compiler l'application vous-même](#compiler-lapplication-vous-même)
- [Conventions du dépôt](#conventions-du-dépôt)
- [Commits et pull requests](#commits-et-pull-requests)
- [Licence de vos contributions](#licence-de-vos-contributions)

## Comment on collabore

Lucium a **un seul mainteneur** ([GOVERNANCE.fr.md](GOVERNANCE.fr.md)). Vous proposez un changement par une issue ou une pull request ; le mainteneur le relit, le corrige au besoin, l'intègre dans `main`, puis construit et publie la version. Personne d'autre ne publie.

**Tout changement entre dans `main` par une pull request, ceux du mainteneur compris.** Personne n'envoie directement sur `main` ; son historique est linéaire et ses commits sont signés ([les règles de `main`](GOVERNANCE.fr.md#les-règles-de-main)).

1. **Dupliquez** (fork) le dépôt sur GitHub.
2. Créez une **branche** dans votre fork, à partir d'un `main` à jour : `feat/nom-court`, `fix/nom-court`, `docs/nom-court`.
3. Faites votre modification, avec ses tests, et lancez les vérifications (voir plus bas). **Signez chaque commit** avec `git commit -s` ([pourquoi](#licence-de-vos-contributions)).
4. Ouvrez une **pull request** vers `main`, avec un titre au format [Conventional Commits](#commits-et-pull-requests), et remplissez le modèle. Laissez cochée « Allow edits by maintainers » : le mainteneur peut pousser de petites corrections sur votre branche plutôt que de vous les demander une à une.
5. **Les contrôles requis** tournent sur la pull request, sans aucun secret : le typage (le job `Type check`), le lint (`Lint`), les tests unitaires sous Linux et sous macOS (`Unit tests (Linux)`, `Unit tests (macOS)`), une build non signée de l'application sous macOS (`Build (macOS, unsigned)`), la signature (`Signed-off-by`) de chaque commit (`DCO`) et la forme du titre (`PR title`). Une pull request n'est intégrée que s'ils passent tous ; sur une pull request qui ne change que de la documentation (`*.md`, `docs/`), les deux jobs macOS sont sautés, et GitHub compte un job sauté comme réussi. Pour une première contribution, ils démarrent une fois que le mainteneur a approuvé leur lancement. Ce qui ouvre une fenêtre n'est pas requis sur une pull request : les tests de bout en bout (`pnpm test:e2e`) tournent chaque nuit sur `main` ; la chaîne moteur (`pnpm test:engine`) tourne chaque semaine, sur un tag de version et à la demande.
6. **Le mainteneur relit** votre travail, demande des changements ou approuve, puis l'intègre (squash). Une seule personne le fait, sur son temps libre : les délais visés sont dans [docs/community/maintainers.md](docs/community/maintainers.md) ; ce sont des objectifs, pas des garanties.
7. Votre contribution figure dans le [CHANGELOG](CHANGELOG.fr.md) et part avec la version suivante. Les versions sont construites, signées, notarisées et publiées par le seul mainteneur, depuis son Mac, après relecture de tout ce qui y entre ([GOVERNANCE.fr.md](GOVERNANCE.fr.md)) : une intégration dans `main` ne livre rien aux utilisateurs à elle seule.

Pour tout ce qui dépasse une petite correction, **ouvrez d'abord une issue ou une discussion** : personne ne doit passer des jours sur quelque chose qui ne pourra pas être intégré. Gardez les pull requests petites et centrées sur un seul sujet ; une pull request en brouillon permet de demander un avis tôt.

Nouveau venu ? Cherchez les issues `good first issue` et `help wanted`. Améliorer un document, un message ou un test est aussi bienvenu que du code.

Où discuter : les [Discussions GitHub](https://github.com/pOwn3d/Lucium/discussions) pour les questions et les idées, les [issues](https://github.com/pOwn3d/Lucium/issues) pour les bugs, les demandes de fonction et ce qui vous manque de votre ancien navigateur. Voir [SUPPORT.md](SUPPORT.md) et [docs/community/index.md](docs/community/index.md).

Tout le monde respecte le [Code de conduite](CODE_OF_CONDUCT.md) (en anglais, Contributor Covenant 2.1).

## Signaler un bug

Utilisez le formulaire **Bug report** en ouvrant une issue. Un bon rapport donne :

- la version de Lucium (celle qu'affiche Lucium › À propos de Lucium, ou le commit si vous l'avez compilée), la version de macOS et la puce ;
- les étapes les plus courtes qui reproduisent le problème, ce que vous attendiez, ce qui s'est passé ;
- la page ou l'extension en cause, de préférence une petite page de test ;
- la sortie du terminal si vous avez lancé l'application avec `pnpm start` ou `pnpm dev`.

**Retirez toute donnée personnelle** de ce que vous joignez : titres d'onglets, adresses, noms de comptes, chemins qui contiennent votre nom d'utilisateur. Regardez vos captures avant de les envoyer.

Une **faille de sécurité** ne se signale jamais dans une issue publique : suivez [SECURITY.md](SECURITY.md).

## Proposer une fonction

Ouvrez une issue **Feature request** (ou une discussion pour une idée encore floue). Décrivez d'abord le problème, puis votre proposition. Consultez la [feuille de route](docs/roadmap.md) : l'idée est peut-être faite, prévue ou exclue.

Le projet a deux priorités, dans cet ordre : être fidèle à la disposition et au comportement de Lucium, puis ajouter de nouvelles fonctions. Une fonction qui s'en écarte est bienvenue quand c'est un ajout (un nouveau réglage, une nouvelle entrée de menu), pas un changement silencieux d'un comportement existant.

## Exclu par décision

Ces décisions sont fermes (voir [GOVERNANCE.fr.md](GOVERNANCE.fr.md)). Une proposition ou une pull request sur l'un de ces points sera fermée :

- un **assistant IA** intégré au navigateur (discussion, barre « demander », agents qui agissent sur les pages), et tout appel à un fournisseur d'IA en ligne ; seul est permis le résumé de page par un modèle local (Ollama sur l'ordinateur de l'utilisateur), en option et éteint par défaut ;
- un **compte utilisateur**, ou tout ce qui oblige à se connecter pour utiliser le navigateur ;
- une **synchronisation ou un partage cloud** qui passe par un serveur ;
- la **télémétrie**, les statistiques d'usage, un rapport de plantage qui envoie des données ;
- tout ce qui enfreint [la règle de non-reprise](#la-règle-de-non-reprise) ;
- une offre payante, de la publicité ou un lien d'affiliation.

Installer l'extension de son choix n'est pas une exception à ces points : la prise en charge des extensions est générique.

## La règle de non-reprise

Lucium reproduit du **comportement et de la disposition observables** : l'aspect, l'emplacement, ce que font les choses.

Une contribution ne contient **aucun code, image, police, icône, son, table de chaînes ni fichier de données d'un autre navigateur ou d'un autre produit propriétaire**, en tout ou en partie, même modifié. Elle n'est pas écrite à partir de code décompilé ou désassemblé d'un tel produit. Les icônes et graphismes sont dessinés pour Lucium (voir `src/shared/icons.ts`). Des ressources libres sont acceptées si leur licence est compatible avec la GPL-3.0-or-later et consignée dans [docs/licences-tierces.md](docs/licences-tierces.md).

En cas de doute sur ce qui peut être utilisé, demandez dans la pull request avant d'envoyer davantage de travail. Un contenu copié est retiré dès qu'il est trouvé, ce qui peut obliger à réécrire l'historique.

## Mesurer un navigateur sans toucher à vos données

Une mesure, sur Lucium ou sur un autre navigateur que vous utilisez, suit ces règles :

- **Observer, ne jamais modifier.** Ne touchez pas aux fichiers du dossier de données d'un navigateur (sous `~/Library/Application Support`), et ne changez pas vos vrais espaces pour mesurer quelque chose. Créez un espace jetable avec des onglets neutres (par exemple `example.com`) et mesurez-y. Quittez un navigateur avant que Lucium importe ses données, et travaillez sur une copie de ses fichiers (`StorableSidebar.json` pour une barre latérale à espaces).
- **Mesurer ce qui s'observe** : l'Inspecteur d'accessibilité de macOS (position, taille, identifiants), des captures à l'échelle 1 (1 point = 1 pixel), l'échantillonnage de pixels pour les couleurs, des enregistrements d'écran à 60 images/s pour les durées d'animation. Ne décompilez ni ne désassemblez un autre navigateur, et ne copiez aucune ressource de son paquet.
- **Dire comment chaque valeur a été obtenue**, avec ces marques : `[A]` accessibilité, `[P]` pixels, `[I]` identifiant, `[V]` vu à l'écran, `[D]` déduit (à confirmer). Donnez les conditions : taille de la fenêtre, clair ou sombre, thème de l'espace, survol ou état actif, version du navigateur.
- **Dire ce qui n'a pas pu être mesuré**, et pourquoi. Une estimation marquée `[D]` est utile ; une estimation présentée comme une mesure est nuisible.
- **Aucune donnée personnelle** dans ce que vous écrivez ou joignez. Écrivez `<espace>` au lieu du nom d'un de vos espaces. Pas de titres d'onglets, d'adresses ni d'historique. Ne committez pas de captures brutes de votre navigateur : elles montrent vos données. Une image recadrée d'un contenu neutre est acceptable, une ressource extraite ne l'est pas.
- **Où l'écrire** : dans la description de la pull request qui met en œuvre la modification, avec chaque valeur et la façon dont elle a été obtenue.

Pour seulement signaler un manque, le formulaire **Missing from your previous browser** suffit : donnez des chiffres quand vous en avez.

## Préparer votre environnement

Prérequis : macOS (Apple Silicon est la plateforme testée), Node.js 26 (voir `.nvmrc` ; `nvm use` ou tout gestionnaire de versions qui le lit) et pnpm 12.16.1 (le champ `packageManager` de `package.json`).

```bash
git clone https://github.com/<votre-compte>/lucium.git     # votre fork
cd lucium
git remote add upstream https://github.com/pOwn3d/Lucium.git
pnpm install
pnpm dev                 # lancer l'application avec rechargement
```

Si Electron signale que son binaire manque, lancez une fois `node node_modules/electron/install.js`.

**`pnpm dev` et `pnpm start` ouvrent votre profil réel, volontairement.** Sans option, une session de développement lit et écrit le dossier de données de l'application installée, `~/Library/Application Support/Lucium` (espaces, onglets, réglages, historique, cookies, coffre de mots de passe), et chiffre les cookies comme les builds installées (fusible `EnableCookieEncryption` d'Electron, sans retour : [docs/drm.md](docs/drm.md)). Le code en cours d'écriture (un reducer, une migration, un nettoyage de fichiers) agit donc sur ce profil. Pour essayer quelque chose de risqué, passez à Electron un profil de test, après `--` :

```bash
pnpm dev -- --user-data-dir="$(mktemp -d)"                                       # un profil vierge, jeté ensuite
pnpm dev -- --user-data-dir="$HOME/Library/Application Support/lucium-dev"    # un profil de test gardé d'une session à l'autre
```

La même forme vaut pour `pnpm start`. Avant une session sur votre profil réel qui touche à l'état ou à ses migrations, copiez le dossier (`docs/drm.md` donne la commande `ditto`).

Avant chaque pull request :

```bash
pnpm typecheck && pnpm lint && pnpm test && pnpm test:engine
```

- `pnpm typecheck`, `pnpm lint` et `pnpm test` (Vitest, logique pure) sont rapides et n'ouvrent aucune fenêtre. Ce sont des contrôles requis de chaque pull request. Les tests unitaires tournent sous Linux et sous macOS : certains ne tournent que sous macOS et sont sautés sous Linux. `pnpm build` est aussi un contrôle requis, sous macOS : il attrape ce que l'empaqueteur ne sait pas résoudre (un import, une ressource, une page), que le typage et les tests unitaires ne voient pas.
- `pnpm test:coverage` lance les mêmes tests unitaires et mesure quelles lignes du produit ils exécutent (résumé dans le terminal, pages dans `coverage/index.html`). Ce n'est pas un contrôle requis et il n'a pas de seuil : il sert à trouver le code qu'aucun test n'exécute. Les suites moteur et les tests E2E ne sont pas dans le chiffre.
- `pnpm test:engine` lance un vrai Electron : il ouvre des fenêtres et **prend le focus**. Lancez-le quand vous n'utilisez pas la machine. En CI, il tourne chaque semaine, sur un tag de version et à la demande (workflow **Smoke (macOS)**, les minutes macOS coûtent cher), jamais sur une pull request : c'est à vous de le lancer quand votre modification touche aux fenêtres, aux vues, aux menus, aux extensions ou à `src/main/`. Si vous ne pouvez pas (pas de Mac), dites-le dans la pull request, et le mainteneur le lancera.
- `pnpm test:engine` ne lance pas tout, et `src/main/smoke-suites.ts` est la seule table qui dit quelle suite tourne où et pourquoi. Deux suites demandent une application à elles et ont leur commande : `pnpm test:engine:webstore` (dans la chaîne, la suite de la boutique est comptée comme sautée : les extensions de sonde que la chaîne charge enverraient ses pages à la vraie boutique) et `pnpm test:engine:extwindows` (les extensions dans trois profils et trois fenêtres, avec ses propres sondes). `pnpm test:engine:all` lance la chaîne, puis ces deux-là. Les autres se lancent à part, après `pnpm build`, avec `LUCIUM_SMOKE_ONLY=<nom> electron . --smoke --user-data-dir="$(mktemp -d)"` : `webstore-live` et `favicons-measure` utilisent le vrai Internet (en lecture seule, des décomptes seulement), `surface-real` demande une copie de la vraie extension dans `LUCIUM_EXTENSIONS`, et `perf` est la cible de `pnpm perf`, qui mesure pendant des minutes (la chaîne ne vérifie que sa préparation). Un nom qu'aucune suite ne porte est refusé (code de sortie 2), au lieu de lancer toute la chaîne.
- Ce qu'un passage de la chaîne vous dit. L'interface est fixée en français, quelle que soit la langue de votre Mac : les vérifications lisent des menus et des titres en français. Chaque vérification est écrite dans le journal au moment où elle est faite (`ok`, `FAIL`, ou `skip` avec la raison : une vérification sautée est comptée à part et n'est jamais une réussite). Chaque suite a un délai (10 minutes, davantage pour les deux longues ; `LUCIUM_SMOKE_SUITE_TIMEOUT_MS` le change) : une suite qui ne rend pas la main est comptée en échec et nommée, et la chaîne continue. Une suite qui se termine sans une seule vérification, ou dont l'extension de sonde n'est pas chargée, échoue. Le passage s'arrête, échoue et dit pourquoi quand les écrans du Mac se mettent en veille, que sa session est verrouillée, qu'il se met en veille, que le processus principal n'a pas tourné pendant une minute ou que l'application est priée de quitter : la suite en cours est coupée, aucune autre ne démarre et le rapport garde les suites faites (les vérifications pilotent de vraies fenêtres et lisent ce qui est dessiné : après un écran verrouillé, toutes échoueraient pour une raison étrangère à l'application). Gardez l'écran allumé et déverrouillé (`caffeinate -d` garde les écrans allumés, pas une session verrouillée à la main). Le passage se termine par une ligne par suite et le nom de celles qui ont échoué. Il remet votre presse-papiers après chaque suite et supprime son profil jetable ; un passage que vous interrompez ne fait ni l'un ni l'autre. `pnpm compat:compare` compare ensuite le rapport du passage (`out-engine/report.json`) à la référence du moteur (`compat/baseline-electron-<version>.json`) et liste ce que le passage a perdu.
- La chaîne construit avec `LUCIUM_KEEP_NAMES=1` (le processus principal garde les noms de ses fonctions et de ses classes) : les contrôles de coût nul des fonctions facultatives (`LUCIUM_SMOKE_ONLY=features`) reconnaissent à ces noms le code qui a posé une minuterie, construisez donc de la même façon avant de les lancer à part.
- `pnpm test:e2e` (Playwright, `tests/e2e/`) compile l'application et la pilote : environ 160 tests, une quinzaine de minutes. Il ouvre des fenêtres et **prend le focus**. Chaque test lance sa propre copie avec un dossier de données temporaire, jamais votre profil, et ses pages viennent d'un serveur local. L'application lancée par les tests ne joint rien hors de la machine : elle ne résout que les noms des tests, et le bloqueur ne télécharge aucune liste. En CI, il tourne chaque nuit sur `main` et à la main (workflow **E2E**, macOS), et n'est pas un contrôle requis d'une pull request. Le test visuel des Réglages (`tests/e2e/settings.spec.ts`) compare à des images faites sur la machine qui compare (l'écran, les polices et la version de macOS changent les pixels) : celles de la CI sont dans Git (`*-darwin-ci.png`), celles de votre machine n'y sont pas (`*-darwin-local.png`). Chaque image montre une catégorie entière, jusqu'à sa dernière ligne, et pas seulement ce que la fenêtre laisse voir. Une image de référence absente fait échouer le test : sur votre machine, le premier passage les dessine et échoue, le suivant compare ; `pnpm test:e2e tests/e2e/settings.spec.ts --update-snapshots` les redessine. Regardez les images avant de vous fier à la comparaison.

Lectures utiles : [docs/architecture.md](docs/architecture.md) (structure, port moteur) et [docs/fonctions.md](docs/fonctions.md) (chaque fonction, son interrupteur et son coût).

## Compiler l'application vous-même

Chacun peut compiler Lucium sur son Mac, **sans aucun compte** : ni compte castLabs, ni compte développeur Apple, ni clé. Ce que vous compilez est la **variante standard** : le même code que la version officielle, sur l'Electron officiel épinglé dans `package.json`. Les versions officielles ne sont pas la même chose, et seul le mainteneur les fabrique.

En plus des prérequis ci-dessus, il faut les outils en ligne de commande d'Xcode (`xcode-select --install`) : `pnpm package` compile trois petits auxiliaires natifs avec `clang` et `swiftc`.

```bash
pnpm install --frozen-lockfile
pnpm package             # dist/mac-arm64/Lucium.app, pour Apple Silicon
```

`pnpm package` lance `electron-vite build`, puis `pnpm build:native` (les auxiliaires), puis `electron-builder --mac --dir --arm64` : les étapes du contrôle requis `Build (macOS, unsigned)`. Rien n'est signé (`identity: null` dans `electron-builder.yml`) et rien n'est envoyé nulle part.

| | Variante standard (celle que vous compilez) | Version officielle (celle du mainteneur) |
|---|---|---|
| Electron | l'officiel, épinglé dans `package.json` | l'« Electron for Content Security » de castLabs, qui sait charger le module Widevine (la variante DRM, [docs/drm.md](docs/drm.md)) |
| Vidéos protégées (Netflix et consorts) | ne se lisent pas : la variante standard n'a pas le module Widevine | se lisent ; seul Netflix est vérifié, avant chaque version |
| Signature | aucune : ni signée avec un Developer ID, ni notarisée | signée par le service de castLabs (EVS), puis avec le Developer ID du mainteneur, et notarisée par Apple |
| Premier lancement | s'ouvre normalement sur le Mac qui l'a compilée ; sur un autre Mac, macOS la bloque jusqu'à *Ouvrir quand même* ([README](README.fr.md#compiler-depuis-les-sources)) | aucun avertissement |
| Mises à jour | aucune : elle ne porte aucune adresse de mise à jour, vous récupérez les sources et compilez de nouveau | depuis le flux de mise à jour signé de lucium.app |
| Touch ID pour le coffre de mots de passe | indisponible (l'auxiliaire du trousseau a besoin d'un profil d'approvisionnement de l'équipe de développement du mainteneur) : le coffre s'ouvre avec sa phrase secrète | disponible |

**Les versions officielles sont fabriquées par le mainteneur seul**, sur son propre Mac, avec `scripts/build-drm-release.sh`. Il y faut un compte EVS de castLabs, un Developer ID Apple et le trousseau du mainteneur. Aucune contribution n'en a besoin, aucun contrôle d'une pull request ne s'en sert, et une build faite avec d'autres clés n'est pas une version officielle. Vous n'avez jamais à lancer ce script pour contribuer. Si votre changement touche aux vidéos protégées, dites dans la pull request que vous n'avez pas pu l'essayer : le mainteneur vérifie que Netflix lit sur la version officielle avant chaque version ([processus de publication](docs/community/release-process.md), en anglais).

**Une build que vous compilez ouvre les données d'un Lucium installé.** Elle porte le nom et l'identifiant de Lucium : elle lit et écrit donc le même dossier de données, `~/Library/Application Support/Lucium`, comme `pnpm dev`. Pour l'essayer sur un profil vierge, donnez-lui un profil de test comme plus haut : `open -n dist/mac-arm64/Lucium.app --args --user-data-dir="$(mktemp -d)"`.

Si vous distribuez une build que vous avez compilée, changez le nom, le logo, l'identifiant, le flux de mise à jour et les adresses de contact : [TRADEMARKS.fr.md](TRADEMARKS.fr.md#si-vous-distribuez-une-version-modifiée) dit lesquels.

## Conventions du dépôt

- **La logique pure va dans `src/shared/`, testée.** Ces fichiers n'importent pas Electron. Chaque module a son test à côté (`nom.test.ts`, Vitest).
- **Ce que l'interface fait dans le temps se teste dans un document.** Un rendu statique montre ce qu'un composant dessine, pas ses effets, ses écouteurs, ses minuteries ni ce qu'un clic change. Pour cela, un fichier de test de `src/renderer/` commence par `// @vitest-environment happy-dom` et monte le composant avec `dom.test-support.ts` (voir `lock-settings.test.ts`, `hover-card-effects.test.ts`). Les autres tests continuent de tourner dans Node seul.
- **Un test qui a besoin d'un dossier le demande à `tempDir()`** (`src/main/temp-dir.ts`) : le dossier est supprimé après le test. Un `mkdtempSync` nu le laisse derrière lui, et une machine de développement s'en remplit.
- **Un seul reducer.** Tout changement de l'état persistant passe par `src/shared/sidebar.ts`. La forme de l'état est dans `src/shared/model.ts`, et ce qui est accepté au chargement d'un fichier d'état dans `src/shared/state-clean.ts` : un fichier modifié à la main ou corrompu ne doit jamais faire planter l'application.
- **Un seul port moteur.** Tout ce qui pilote le contenu web ou les extensions passe par `src/main/engine/types.ts` (`Engine`, `Page`). Son implémentation sur Electron est dans `src/main/engine/` (`electron-engine.ts`, `electron-page.ts` et les auxiliaires listés, chacun avec sa raison, dans `src/main/engine-port.test.ts`, qui en refuse tout nouveau) ; `src/shared/` n'importe jamais Electron. Le shell (`src/main/shell/`), les préchargements et la racine de `src/main/` importent encore Electron pour les fenêtres et les menus. C'est ce qui empêche une mise à jour de Chromium de casser le reste.
- **Le renderer n'est pas de confiance.** Le processus principal revalide chaque message IPC (`src/main/shell/ipc.ts`, `src/shared/ipc-policy.ts`). Un nouveau canal arrive avec sa validation et son test.
- **Règles de sécurité du code.** Elles valent pour chaque modification, pas seulement pour les signalements de sécurité :
  - un secret (clé d'API, jeton, mot de passe) n'est jamais écrit dans le fichier d'état, les journaux, une URL, un instantané de test ni à l'écran ; il est stocké chiffré par le trousseau du système (`safeStorage`), et seul le processus principal le relit ;
  - rien ne quitte la machine sans le choix explicite de l'utilisateur : un nouvel appel réseau est désactivé par défaut, figure dans la table des connexions du [README](README.fr.md) et est signalé dans la pull request ;
  - le texte d'une page web ou d'un modèle est affiché comme du texte : pas d'`innerHTML` avec un contenu qui n'est pas le nôtre, aucune interprétation du HTML d'un modèle, pas d'`eval`, de `new Function` ni de code chargé depuis une adresse distante ;
  - un fichier lu au démarrage ou importé (état, Retouche, thème, liste, signet) est validé et limité en taille, et un fichier corrompu ne fait jamais planter l'application ;
  - une dépendance avec un script d'installation, ou un avis de sécurité, est signalé dans la pull request avant l'intégration.
- **Tout garde-fou a son test, et le test est prouvé par mutation.** Un garde-fou est toute vérification qui refuse, limite ou valide : une limite de taille, un filtre d'URL, un contrôle de permission, une règle « ne jamais faire X ». Écrivez le test, puis **retirez ou inversez le garde-fou et vérifiez que le test échoue**, puis remettez le garde-fou. Dites-le dans la pull request. Un test qui passe avec et sans le garde-fou ne protège rien.
- **Le comportement du moteur a sa vérification en vrai Electron.** Ce que seul un vrai Electron peut montrer (fenêtres, vues, sessions, extensions) est vérifié dans `src/main/smoke-*.ts`, lancé par `pnpm test:engine`.
- **Des chiffres pour l'interface.** Une modification de l'interface dit ce qu'elle suit (tailles, couleurs, durées, et comment elles ont été observées), ou précise que c'est un ajout volontaire.
- **L'interface est en français et en anglais, et traduisible.** Chaque texte visible est dans les deux catalogues, `src/shared/i18n-fr.ts` et `src/shared/i18n-en.ts`, sous la même clé, et se lit avec `t('zone.cle')` : un nouveau texte arrive dans les deux langues, dans le même commit, et un test échoue quand une clé n'est que dans un catalogue ([docs/community/translations.md](docs/community/translations.md)). Écrivez chaque phrase en entier, sans la fabriquer à partir de morceaux dont l'ordre dépend de la grammaire, et ne mettez aucun texte dans une image.
- **Les couleurs passent par des jetons.** Une feuille de style n'écrit aucune couleur elle-même : elle prend un rôle de `src/renderer/tokens.css` (fond, texte, accent…), qui suit le thème clair et le thème sombre, ou, pour les quelques fenêtres qui ne sont pas sur les rôles, une couleur fixe de `src/renderer/palette.css`. `src/renderer/stylesheets.test.ts` refuse une couleur écrite dans une feuille migrée.
- **Langue des fichiers.** Les commentaires de code sont en **anglais**. Les documents de `docs/` sont en français, ceux de `docs/community/` en anglais ; les fichiers communautaires de la racine sont en anglais, et le README, ce guide, GOVERNANCE et TRADEMARKS ont aussi une version française.
- **Style.** TypeScript en mode strict. Le linter (`pnpm lint`, [oxlint](https://oxc.rs)) est un contrôle requis ; il n'y a pas de formateur : suivez le code autour du vôtre (2 espaces, pas de points-virgules, apostrophes simples). `.editorconfig` fixe la base.
- **Les règles du linter** sont la courte liste de `.oxlintrc.jsonc` : un hook appelé dans une branche, un effet qui lit une valeur absente de sa liste, une promesse que personne n'attend, un nom déclaré et jamais lu. Une exception tient sur une ligne, avec sa raison : `// oxlint-disable-next-line react-hooks/exhaustive-deps -- pourquoi`. Un commentaire qui n'excuse rien est une erreur. Chaque fichier TypeScript appartient à l'un des projets `tsconfig.*.json`, pour que le linter le lise avec ses types : un nouveau dossier s'ajoute à l'un d'eux.
- **Assistants de code.** Si vous travaillez avec l'un d'eux, [AGENTS.md](AGENTS.md) (en anglais) contient les règles qu'il doit suivre. Vous restez l'auteur de ce que vous soumettez, et celui qui le signe.
- **Les commentaires expliquent pourquoi**, pas quoi. Retirez le code commenté.
- **Dépendances.** En ajouter une demande une raison dans la pull request, une licence compatible avec la GPL-3.0-or-later consignée dans [docs/licences-tierces.md](docs/licences-tierces.md), et aucun script d'installation (`pnpm-workspace.yaml` liste les seuls paquets autorisés à lancer des scripts de compilation). `pnpm-lock.yaml` est commité, dans le même commit que `package.json`.
- **Versions.** Dans `package.json`, ce que l'application embarque (`dependencies`) et Electron sont épinglés à une version exacte, sans `^` ni `~` : ils tournent dans le navigateur, et `koffi` comme Electron sont du code natif. Les outils de développement (`devDependencies` autres qu'Electron) prennent une plage `^x.y.z` ; ce qui est installé reste fixé par `pnpm-lock.yaml` (`pnpm install --frozen-lockfile` en CI). Les mises à jour viennent de Dependabot (`.github/dependabot.yml`, une pull request par groupe), ou à la main avec `pnpm up <nom>@<version>`.
- **Documentation.** Mettez à jour la documentation quand le comportement change, et ajoutez une ligne dans la première section du [CHANGELOG](CHANGELOG.md) (la version en préparation, ou `## [Unreleased]` après une publication) pour tout ce qu'un utilisateur remarquerait, et la même ligne en français dans [CHANGELOG.fr.md](CHANGELOG.fr.md), que l'application affiche dans sa feuille « Nouveautés ». `README.md` et `README.fr.md` changent ensemble, dans le même commit ; de même `CONTRIBUTING.md` et `CONTRIBUTING.fr.md`, `GOVERNANCE.md` et `GOVERNANCE.fr.md`, `TRADEMARKS.md` et `TRADEMARKS.fr.md`. Une connexion que l'application fait d'elle-même figure dans la table du README, avec son interrupteur et sa valeur par défaut.
- **Ne corrigez pas ce qui n'a pas de rapport** dans la même pull request. Ouvrez une issue pour cela.

## Commits et pull requests

Les messages de commit et les titres de pull request suivent [Conventional Commits](https://www.conventionalcommits.org), **en anglais** :

```
<type>(<portée>): <ce qui change, à l'impératif, en minuscules, sans point final>

<corps facultatif : pourquoi, et ce qui a été envisagé>
```

- Types : `feat`, `fix`, `perf`, `refactor`, `docs`, `test`, `build`, `ci`, `chore`, `revert`.
- La portée est la zone, par exemple `sidebar`, `command-bar`, `engine`, `extensions`, `blocker`, `import`, `settings`, `docs`.
- Exemples : `fix(sidebar): keep the selection when a folder closes`, `feat(blocker): add a per-site exception`, `docs(community): describe the release process`.
- Un changement incompatible du fichier d'état ou d'un réglage est signalé par `!` (`feat(state)!: ...`) et expliqué dans le corps.

Le mainteneur intègre en squash : le titre de votre pull request est ce qui reste dans l'historique, et un contrôle requis en vérifie la forme. Plusieurs commits sur votre branche ne posent pas de problème, chacun avec sa signature (section suivante). Les changements du mainteneur passent par une pull request et suivent le même format.

## Licence de vos contributions

**Copyright © 2026 ConsilioWeb and contributors.** Lucium est publié sous **GPL-3.0-or-later** ([LICENSE](LICENSE)), avec deux permissions additionnelles : l'une autorise à le combiner et à le distribuer avec le module Widevine, dont la variante qui lit les vidéos protégées a besoin ([ADDITIONAL-PERMISSION.txt](ADDITIONAL-PERMISSION.txt), en anglais) ; l'autre permet au mainteneur de distribuer l'application iPhone et iPad par l'App Store d'Apple et TestFlight ([ADDITIONAL-PERMISSION-APP-STORE.txt](ADDITIONAL-PERMISSION-APP-STORE.txt), en anglais). En soumettant une contribution, vous acceptez qu'elle soit distribuée sous cette licence, avec ces permissions. **Vous gardez votre droit d'auteur** : rien n'est cédé au projet ni à ConsilioWeb, et il n'y a **pas d'accord de licence de contributeur** (CLA). [NOTICE](NOTICE) (en anglais) dit qui détient quoi ; le nom et le logo sont un sujet à part, dans [TRADEMARKS.fr.md](TRADEMARKS.fr.md) : les fichiers du logo ne sont pas sous GPL, et seul le mainteneur les modifie.

Ce qui vous est demandé, c'est le [Developer Certificate of Origin 1.1](https://developercertificate.org) : vous certifiez avoir écrit la contribution ou avoir le droit de la soumettre sous cette licence. Vous le faites par une ligne `Signed-off-by: Votre Nom <adresse>` à la fin de **chaque commit** de votre pull request (`git commit -s` l'ajoute ; `git rebase --signoff main` l'ajoute aux commits déjà faits). Un contrôle requis refuse une pull request dont un commit ne l'a pas. Cette ligne est du texte, pas une signature cryptographique : elle ne demande aucune clé. Vous pouvez y mettre votre adresse `noreply` de GitHub, puisque l'historique des commits est public.

Les fichiers source n'ont pas besoin d'en-tête de licence. Le code tiers que vous ajoutez garde sa propre licence et son en-tête.

---

Une question sur ce guide : ouvrez une [discussion](https://github.com/pOwn3d/Lucium/discussions).
