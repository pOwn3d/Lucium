# Plateformes : Windows, Linux, Mac Intel, Homebrew

La variante DRM a son propre document : `docs/drm.md`.

**Règle de lecture.** Lucium n'est écrit, mesuré et lancé que sur macOS, Apple silicon. Tout ce qui suit pour Windows et Linux est **préparé sans avoir été exécuté**. Ce qui est *vérifié* l'est par des tests unitaires qui jouent un autre système sur un Mac, par la lecture du code d'`electron-builder` installé et par la validation de la configuration contre son schéma. Ce qui est *supposé* est dit comme tel. Rien n'a été empaqueté, signé ni publié pour Windows ou Linux.

## 1. En une page

| | macOS arm64 | macOS Intel | Windows | Linux |
|---|---|---|---|---|
| Code de l'application | testé (tests unitaires, suites moteur) | identique, jamais lancé | relu, couche écrite, **jamais lancé** | relu, couche écrite, **jamais lancé** |
| Empaquetage | `pnpm package` (dossier `.app`) | `dmg` + `zip` x64 préparés | NSIS x64 préparé | AppImage + deb x64 préparés |
| Signature | aucune (ad hoc) ; variante DRM : Developer ID, notarisée | aucune | aucune (SmartScreen avertira) | sans objet |
| Intégration continue | `ci.yml` (tests unitaires et build non signée, à chaque pull request), `smoke-macos.yml` (chaîne moteur : à la main, sur un tag et chaque semaine), `e2e.yml` (chaque nuit), `build.yml` (à la main et sur un tag) | `build.yml` (à la main et sur un tag, ne peut pas le lancer) | `build.yml` (à la main et sur un tag, expérimental) | `ci.yml` (typage, lint et tests, à chaque envoi et pull request) + `build.yml` (expérimental) |
| Ce qui manque | signature + notarisation de la build standard | un Mac Intel (ou Rosetta) pour essayer | tout essai ; icône `.ico` ; enregistrement « navigateur par défaut » | tout essai ; bac à sable sur Ubuntu 24.04 ; Wayland |

Ce document couvre : ce qui est propre à macOS (§2), la couche de plateforme testée (§3), la configuration `electron-builder.yml` (§5), le brouillon `.github/workflows/build.yml` (§5), le cask Homebrew (§7). La couche n'a aucun réglage : elle remplace des appels directs par des appels qui, sur macOS, font la même chose.

## 2. Ce qui est propre à macOS

Méthode : recherche textuelle dans les fichiers de production (`src/` et `scripts/`, hors `*.test.ts` et `smoke-*.ts`). Une ligne comptée est une ligne de code, pas un fichier.

### 2.1 Appels et API

| Catégorie | Lignes hors de la couche | Où | Sur Windows / Linux |
|---|---|---|---|
| `process.platform` lu directement | 7 | `index.ts`, `browser.ts`, `popup-windows.ts`, `electron-engine.ts` (3), `dev-electron.mjs` | les 7 restantes sont déjà des paramètres (`popupKey`, agent utilisateur, partage d'écran) ou le script de dev macOS |
| Options de fenêtre `titleBarStyle: 'hidden'` + `trafficLightPosition` | 0 (4 types de fenêtre : principale, Mini-fenêtre, supplémentaire/privée, Réglages) | `index.ts` (×3), `settings-window.ts` | sans les feux tricolores, une fenêtre à barre de titre cachée n'a **aucun bouton** : la couche laisse la barre de titre du système |
| `setWindowButtonVisibility` / `Position` | 0 appel direct (2 passent par la couche) | `browser.ts`, `little.ts` | documentés « macOS » dans `electron.d.ts` ; l'existence de la méthode ailleurs n'a pas été vérifiée : jamais appelée hors macOS maintenant |
| `setVibrancy` (matière de la fenêtre) | 0 | `browser.ts` | déjà gardé ; Windows 11 a `setBackgroundMaterial` (non utilisé) |
| Touch ID (`canPromptTouchID`, `promptTouchID`) | 0 | `index.ts` | jamais proposé ; Windows Hello n'a pas d'API Electron : phrase seule |
| `app.dock` (icône du Dock) | 3 | `app-icon.ts`, `index.ts` (mode silencieux des mesures) | `app.dock` est `undefined` hors macOS, le code le teste déjà ; l'icône de fenêtre (`icon`) n'est pas posée sous Linux |
| Rôles de menu propres à macOS (`services`, `hide`, `hideOthers`, `unhide`, `front`, `zoom`, `showSubstitutions`, `startSpeaking`, `stopSpeaking`, `shareMenu`) | 11 lignes (12 rôles) | `menu.ts` (9), `lock-menu.ts` (1 ligne, 2 rôles), `context-menus.ts` (1) | retirés **à l'exécution** par `adaptMenuTemplate` (le menu de macOS n'est pas touché), avec les séparateurs et les sous-menus vides qu'ils laissent |
| `systemPreferences` | 6 | `index.ts`, `motion.ts`, `electron-engine.ts` | `getAnimationSettings` : attrapé et journalisé hors macOS ; `getMediaAccessStatus('screen')` : déjà gardé |
| `open -a` (« Ouvrir avec… ») | 1 | `open-with.ts` | à masquer hors macOS (§4) ; le repli (application du système) existe |
| `pmset` (charge de la batterie) | 0 | `battery-saver.ts` | Linux : `/sys/class/power_supply/BAT*/capacity` ; Windows : inconnue (le mode économie ne s'enclenche alors que sur demande) |
| `plutil` (liste de propriétés `Bookmarks.plist`) | 1 | `importers/service.ts` | la source `safari` n'est pas proposée hors macOS |
| Chemins `~/Library/…` | 5 | `importers/service.ts` (sources `arc` et `safari`), `menu-actions.ts`, `import-sources.ts`, `native-messaging.ts` | dossiers des navigateurs basés sur Chromium et sur Gecko par système dans `platform/paths.ts` (supposés, §3) |
| Liens `x-apple.systempreferences:` | 1 | `translate-ipc.ts`, `import-sources.ts` | `null` hors macOS : le bouton n'est pas proposé |
| Événement `open-url` | 1 | `index.ts` | hors macOS les liens sont dans la ligne de commande : le premier lancement les lit |
| Navigateur par défaut (`setAsDefaultProtocolClient`) | 4 | `index.ts`, `ipc.ts` | non branché ; sous Windows 10+ l'API n'enregistre qu'une association, l'utilisateur choisit dans les Paramètres (§9) |
| Panneau « À propos » du système | 3 | `about.ts`, `index.ts` | `role: 'about'` : boîte personnalisée sous Windows, panneau GTK sous Linux (à constater) |

### 2.2 Défauts réels trouvés (pas seulement des appels à garder)

| Défaut | Où | Effet hors macOS | État |
|---|---|---|---|
| `LUCIUM_EXTENSIONS` séparée par `:` | `index.ts` | un chemin `C:\…` est coupé en deux | **corrigé** (`splitPathList`, `;` sous Windows) |
| Chemin d'un hôte de messagerie native testé par `startsWith('/')` | `shared/native-messaging.ts` | tous les hôtes Windows refusés | **corrigé** (`isAbsolutePath`) |
| Dossier de téléchargement d'un profil testé par `startsWith('/')` | `shared/profiles.ts` | un dossier `C:\…` effacé au chargement | **corrigé** |
| Raccourcis par défaut qui se percutent quand ⌘ devient Ctrl | `shared/keybindings.ts` | 13 groupes (26 commandes) : `Ctrl+1…9` (espaces et éléments), `Ctrl+D`, `Ctrl+N`, `Ctrl+Maj+C`, `Ctrl+F` | **corrigé** pour les défauts (15 réécrits, 5 sans défaut : `blankWindow`, `copyUrlQuote`, `developerMode`, `addSplit`, `closeSplitPane` ; `F11` pour le plein écran) ; un test échoue si deux défauts se rejoignent |
| Raccourcis `Ctrl+Alt+lettre` sous Windows | `shared/keybindings.ts` | Ctrl+Alt est AltGr sur beaucoup de claviers (dont le français) : le raccourci part pendant qu'on tape un caractère | **15 défauts concernés, non changés** (§9) : `newLittleArc`, `captureVisible`, `captureFull`, `copyUrlMarkdown`, `findReplace`, `viewSource`, `devTools`, `inspectElement`, `jsConsole`, `nextSpace`, `previousSpace`, `nextTab`, `previousTab`, `archive`, `clearSiteDataNow` |
| Correcteur orthographique actif sans langue | `page-commands.ts` | sur Windows et Linux Chromium **télécharge** ses dictionnaires (`electron.d.ts`, `setSpellCheckerDictionaryDownloadURL` : « By default Electron will download hunspell dictionaries from the Chromium CDN ») ; macOS utilise celui du système | **traité** : hors macOS le correcteur est désactivé par défaut (fait `systemSpellChecker` de `shared/platform.ts`) ; l'activer dans Édition › Orthographe et grammaire déclenche le téléchargement, dit dans le README ; le choix n'est pas mémorisé d'un lancement à l'autre |
| Noms de fichiers téléchargés nettoyés pour macOS seulement | `shared/file-names.ts` | pas de caractères `<>:"\|?*`, de noms réservés (`CON`, `NUL`, `COM1`…), de point ou d'espace final, limite de 260 caractères | **non traité** |
| Clé de chemin insensible à la casse | `engine/download-paths.ts` | vrai sur macOS et Windows, **faux sous Linux** : deux fichiers de casse différente sont pris pour un | **non traité** (conséquence : un numéro ajouté sans besoin) |
| Hôtes de messagerie native des extensions | `shared/native-messaging.ts` | Windows les trouve par la **base de registre**, pas par un dossier | dossiers Linux ajoutés ; Windows : seul le dossier de Lucium compte |
| Raccourci système de la Mini-fenêtre (`globalShortcut`) | `index.ts` | ne fonctionne pas sous Wayland sans portail (supposé, à vérifier) | **non traité** |
| Titre des boîtes de dialogue | `app.name` | sous Windows, une boîte sans titre prend `app.name` comme titre ; `app.name` est `Lucium` (le `productName` de `package.json`) : la boîte dit « Lucium » | **rien à faire** ; à revoir sur une vraie fenêtre le jour où Windows est essayé |

### 2.3 Texte et mise en page

| Catégorie | Chiffre | Détail |
|---|---|---|
| Lignes de production avec les symboles ⌘ ⌥ ⌃ ⇧ | 153 lignes, 45 fichiers | surtout `Toolbar.tsx` (infobulles), `command-bar.ts`, `littlearc.tsx`, `shortcut-view.ts`, `tab-cycle.ts`, `SettingsWindow.tsx`, `SettingsShortcuts.tsx` ; les raccourcis affichés par `formatAccelerator` sont déjà par système (§3), pas les infobulles écrites en dur |
| « Afficher dans le Finder » | 3 libellés (menu des téléchargements, deux boutons) | le menu suit la couche ; les deux boutons de `Panels.tsx` et `littlearc.tsx` restent à brancher |
| Réserve des feux tricolores | `LIGHTS_CLEARANCE = 76` px, `padding-left: 83px` de `.la-header` | blanc inutile hors macOS tant que la barre de titre est celle du système |
| `-webkit-app-region` (zones de déplacement) | 20 lignes, 9 fichiers CSS | sans effet utile dans une fenêtre à barre de titre du système ; à revoir si la barre est dessinée par la page |
| Polices | `-apple-system, BlinkMacSystemFont, 'SF Pro Text'` en tête de pile ; vingt polices « système macOS » dans les Retouches | retombée sur `system-ui` ; l'aspect change |
| Détection de la plateforme dans l'interface | 1 (`Sidebar.tsx : isMac`) | l'instantané porte déjà `platform` ; la sélection multiple par Ctrl-clic en dépend |

### 2.4 Outils de développement et d'empaquetage

| Fichier | Dépend de | Hors macOS |
|---|---|---|
| `scripts/dev-electron.mjs` | `PlistBuddy`, `cp -cR`, `codesign` | déjà gardé (`process.platform === 'darwin'`) : lance `electron-vite` tel quel |
| `scripts/logo/make-icons.mjs` (`pnpm icons:logo`) | `iconutil`, Google Chrome sans fenêtre (Playwright) | fabrique `build/icon.icns` et `resources/app-icons/` depuis le dessin `scripts/logo/fan-logo.ts` : à lancer sur un Mac |
| `package.json` `package` | `--mac --dir` | inchangé ; pas de script Windows/Linux (la CI appelle `electron-builder` directement) |
| `package.json` `test:engine` | variable d'environnement et `mktemp` à la syntaxe bash | à lancer depuis un shell bash (Git Bash sous Windows) |
| `electron-builder.yml` `electronFuses.resetAdHocDarwinSignature` | macOS | ignoré ailleurs |

## 3. La couche de plateforme

`src/shared/platform.ts` (pur, partagé avec l'interface) et `src/main/platform/` (appels Electron derrière une interface). **Rien ne lit `process.platform` en dehors de `currentPlatform()`** pour ce qui a été déplacé.

```
shared/platform.ts      PlatformId, PLATFORM_FACTS (ce que chaque système offre), splitPathList, isAbsolutePath, linksFromArgv,
                        revealLabel, settingsLink, NON_MAC_DEFAULTS, defaultAcceleratorFor, canonicalAccelerator,
                        formatAcceleratorFor, usesCtrlAlt
main/platform/index.ts  createPlatform(id, seams) → Platform ; currentPlatform() ; windowFrame, applyVibrancy, syncTrafficLights,
                        setWindowButtonVisibility, removeWindowMenu, touchId, batteryPercent, adaptMenu, accelerator, importAvailable,
                        browserDataDir, commandLineLinks
main/platform/menu.ts   adaptMenuTemplate : le menu de macOS rendu tel quel (même objet) ; ailleurs, rôles propres à macOS retirés
main/platform/paths.ts  dossiers des autres navigateurs par système, avec LOCALAPPDATA, APPDATA, XDG_CONFIG_HOME
```

**Garantie macOS.** Chaque méthode fait, sur `darwin`, exactement l'appel qu'elle remplace (mêmes arguments, même ordre : visibilité puis position des feux ; `null` pour la matière « aucune »). Les valeurs par défaut des paramètres de plateforme sont celles de macOS, donc un appelant qui n'en passe pas (tous les tests existants) ne voit aucune différence. `adaptMenuTemplate('darwin', t)` renvoie `t` lui-même. Les tests écrits avant la couche passent sans modification.

**Branché dans l'application (côté processus principal).** `index.ts` (3 fenêtres, Touch ID, liste d'extensions, liens de la ligne de commande, service d'import), `settings-window.ts`, `browser.ts` (matière, feux), `little.ts` (feux), `battery-saver.ts`, `popup-windows.ts` (barre de menus), `context-menus.ts` (libellé), `menu.ts` (raccourcis et adaptation), `importers/service.ts` et `menu-actions.ts` (dossiers), `extension-shims.ts` et `native-messaging.ts` (hôtes).

**Tests.** `src/shared/platform.test.ts` (25), `src/main/platform/platform.test.ts` (24), `menu.test.ts` (12), `src/main/importers/service-platform.test.ts` (6) : 67 tests qui jouent `darwin`, `win32` et `linux` sur n'importe quelle machine, plus `src/main/platform/build-files.test.ts` (15) qui garde, comme texte, ce que les fichiers de construction ne doivent jamais faire (aucun secret, aucune publication, jeton en lecture seule, déclenchement manuel, aucune signature, cible `dir` et fuses de macOS intacts, pas de binaire universel). Vérifications moteur : `src/main/smoke-platforms.ts` (15 contrôles, `LUCIUM_SMOKE_ONLY=platforms`), branché dans la chaîne du contrat moteur.

**Ce que les tests ne prouvent pas.** Que les dossiers de données des autres navigateurs sous Windows (`%LOCALAPPDATA%\Google\Chrome\User Data`, `%APPDATA%\Mozilla\Firefox\Profiles`…) et Linux (`~/.config/google-chrome`, `~/.mozilla/firefox`…) sont les bons sur une vraie machine, ni que `/sys/class/power_supply` répond comme supposé. Les variantes Snap et Flatpak des navigateurs ne sont pas couvertes. La source d'import `arc` n'est pas proposée hors macOS : son dossier sous Windows n'est pas connu.

## 4. Ce qui reste à brancher

Côté interface surtout ; les fonctions pures existent et sont testées.

| À faire | Fichiers | Fonction prête |
|---|---|---|
| Passer la plateforme à `formatAccelerator` et `acceleratorFromKeyEvent` (affichage et saisie des raccourcis) | `SettingsShortcuts.tsx` (l. 83, 89), `Panels.tsx` (l. 815, 821), `SettingsWindow.tsx` (l. 361), `shared/plus-menu.ts` (l. 61) | `formatAccelerator(acc, platform)`, `acceleratorFromKeyEvent(e, platform)` ; l'instantané a déjà `platform` |
| Comparer des raccourcis avec `canonicalAccelerator` (Ctrl saisi = `CmdOrCtrl` par défaut) | `shared/keybindings.ts` : `sameAccelerator`, `findConflicts` | `canonicalAccelerator(acc, platform)` |
| Infobulles écrites en dur (`['⌘', 'S']`…) | `Toolbar.tsx` (12), `littlearc.tsx` (8), `App.tsx`, textes d'aide des Réglages | `formatAcceleratorFor` + la commande correspondante |
| Libellé « Afficher dans le Finder » des deux boutons | `Panels.tsx:212`, `littlearc.tsx:257` | `revealLabel(platform)` |
| Masquer « Ouvrir avec… » hors macOS | `context-menus.ts` | `platform.facts.openWithBundle` |
| Lecture des raccourcis de `browser.ts` (⌃Tab) et de `index.ts` (Mini-fenêtre) avec la plateforme | `browser.ts`, `index.ts` | `platform.accelerator(id, bindings)` |
| Texte « macOS peut demander une confirmation » du navigateur par défaut | `index.ts` | — |
| Dictionnaires du correcteur (réseau) | `page-commands.ts` | désactivé par défaut hors macOS |
| Noms de fichiers Windows | `shared/file-names.ts` | à écrire |
| Barre de titre dessinée par la page (Windows/Linux) | `index.ts`, `frame-layout.ts`, CSS | `windowFrame(lights, overlay)` accepte déjà un `titleBarOverlay` ; il reste la mise en page (zone droite réservée aux boutons, retrait de la réserve de 76 px) |
| Registre Windows pour « navigateur par défaut » et messagerie native | `build/installer.nsh` | à écrire |

## 5. Construction : `electron-builder.yml` et `build.yml`

Configuration ajoutée **sans toucher** à `identity: null`, `extendInfo`, `electronFuses`, `extraResources` ni `asarUnpack`. Elle est **valide contre le schéma** d'`electron-builder` (un témoin négatif, une clé mal écrite, est bien refusé). Elle n'a encore servi à construire ni pour Windows ni pour Linux.

- **Windows** : `nsis`, x64, assistant en plusieurs pages, installation par utilisateur, dossier modifiable. Non signé. `win.icon` pointe sur `build/icon.icns` (convertie en `.ico` par `electron-builder`).
- **Linux** : `AppImage` et `deb`, x64. Catégorie `Network;WebBrowser`, types MIME `x-scheme-handler/http`, `x-scheme-handler/https`, `text/html`, `application/xhtml+xml` (pour que l'environnement de bureau propose Lucium comme navigateur ; `%U` est ajouté par l'outil).
- **Champs descriptifs** (`extraMetadata`) : `homepage`, `author` (nom et adresse `contact@lucium.app`, la même que celle des signalements de sécurité, `SECURITY.md`) et `desktopName`. Un `.deb` refuse de se construire sans adresse de mainteneur ni page d'accueil (code d'`electron-builder` lu). **Ces trois champs entrent dans le `package.json` de l'application empaquetée sur tous les systèmes, macOS compris** ; rien ne les lit à l'exécution. À défaire si on préfère les passer en ligne de commande (`-c.extraMetadata…`) pour le seul Linux.
- **macOS** : voir §6.

Vérifié dans le code d'`electron-builder` : (1) avec `--dir` sur la ligne de commande, les cibles du fichier sont ignorées, donc `pnpm package` et `release.yml` ne changent pas ; (2) la conversion d'icône essaie `build/icons/` *avant* `build/icon.icns` ; ce dossier ne contient aucun `16x16.png`…, donc sans `win.icon` explicite on aurait l'icône d'Electron avec un simple avertissement.

**Icônes** :

| Manquant | Pour | Aujourd'hui |
|---|---|---|
| `build/icon.ico` (≥ 256 px, couches 16, 24, 32, 48, 64, 128, 256) | exécutable et installeur Windows | conversion de `build/icon.icns` ; qualité des petites tailles à juger |
| `build/icons/16x16.png` … `512x512.png` | AppImage, deb, lanceur | conversion de `build/icon.icns` ; le dossier `build/icons/` est lu en premier |
| `build/installerHeaderIcon.ico`, `uninstallerIcon.ico`, bandeau NSIS | installeur | icônes par défaut de NSIS |
| `resources/app-icons/*.png` sert déjà d'icône de fenêtre possible (`icon` de `BrowserWindow`, Linux) | non branché | — |

**Workflow `.github/workflows/build.yml`** (brouillon) : à la main (`workflow_dispatch`) et sur un tag `v*` poussé, jamais sur une pull request (macOS coûte 10 fois le tarif Linux sur un dépôt privé, Windows 2 fois), matrice macOS / Windows / Linux, `pnpm typecheck`, `pnpm test`, `pnpm build`, puis, sur demande, l'empaquetage non signé et le dépôt des fichiers en artefact **3 jours**. Aucun secret, `permissions: contents: read`, `--publish never`, `CSC_IDENTITY_AUTO_DISCOVERY=false`. Windows et Linux sont `experimental` : une jambe qui échoue ne fait pas échouer l'exécution et les tests unitaires n'arrêtent pas la construction. Mêmes actions épinglées que `ci.yml`. Attendu au premier essai : des échecs de tests Windows (chemins Unix en dur dans les tests) ; `pnpm test:engine` n'est pas dans la matrice : il tourne dans `smoke-macos.yml`.

## 6. Mac Intel : x64 et arm64

`mac.target` devient : `dir` (inchangé), `zip` et `dmg` pour `arch: [x64, arm64]`, nommés `Lucium-<version>-mac-<arch>.<ext>` (`arch` = `x64` ou `arm64` ; c'est `artifactName` d'`electron-builder.yml`). La variante DRM que le mainteneur publie garde un autre nom, `Lucium-<version>-arm64.zip` et `.dmg` (`scripts/build-drm-release.sh`), celui que `release.yml` attend dans l'annotation du tag. **Deux archives séparées, pas un binaire universel.**

| | Deux archives (retenu) | Universel (`arch: universal`) |
|---|---|---|
| Taille du téléchargement | celle d'aujourd'hui pour chacun | sensiblement plus grosse : les deux exécutables dans un seul `.app` (`Electron.app` mesure 252 Mo en arm64 seul ; l'universel n'a pas été construit, estimation : un peu moins du double) |
| Temps de construction | deux constructions (non mesuré) | deux constructions + fusion `@electron/universal` + comparaison des archives asar (non mesuré) |
| Fuses | basculés dans chaque architecture comme aujourd'hui | `electron-builder` ne les bascule **qu'après la fusion** (`doUniversalPack` : `disableFuses` pour chaque moitié, puis `doAddElectronFuses`) ; l'effet sur un exécutable fat avec `resetAdHocDarwinSignature` n'est pas vérifié |
| Homebrew | `arch arm: "arm64", intel: "x64"` : un `url` par processeur | une seule `url` |
| Risque | aucun nouveau | fusion de fichiers natifs différents (`singleArchFiles`, `x64ArchFiles` à renseigner s'il en apparaît) |

Ce qui change vraiment : (1) `electron-builder --mac` sans `--dir` produit maintenant quatre fichiers (un `dmg` et un `zip` par processeur) en plus du dossier ; (2) `release.yml` ne construit rien, et la seule archive publiée est celle, arm64, de la variante DRM : une archive x64 demande une construction de plus, non écrite ici ; (3) rien n'a pu être lancé sur Intel. **Piste d'essai** : un Mac Apple silicon peut exécuter une application x86_64 avec Rosetta 2 ; si Rosetta est installé, la version x64 peut y être essayée (non vérifié ; une signature ad hoc invalidée par les fuses peut aussi compter sous Rosetta, à constater). Un `dmg` non signé est arrêté par Gatekeeper comme le `.app` non signé d'aujourd'hui.

## 7. Homebrew : cask

Le cask décrit l'image disque que publie le mainteneur (variante DRM, puce Apple, signée Developer ID et notarisée), pas les archives non signées de la build standard. Il est produit par `scripts/make-cask.mjs` à partir de l'image publiée sur le canal stable, de sa somme et des fiches de la publication, et vivra dans un tap du projet, `pOwn3d/homebrew-lucium`, à créer après la publication stable de la 1.0.0 : [homebrew.md](homebrew.md). Rien n'est publié.

Le dépôt officiel `homebrew/cask` attendra : seuils de notoriété (90 forks, 90 observateurs ou 225 étoiles quand l'auteur propose son propre projet) et ancienneté du dépôt (30 jours) ; détail dans [homebrew.md](homebrew.md#un-tap-à-nous-pas-homebrewcask-pour-linstant). Le cask ne retire jamais la marque de quarantaine : l'image est notarisée, Gatekeeper l'accepte telle quelle. Une archive x64 (§6) demanderait une `url` par processeur.

## 8. Premier essai sur Windows ou Linux : liste de contrôle

À faire dans l'ordre, une machine à la fois (ne pas lancer `pnpm test:engine` sur une machine qu'on utilise : de vraies fenêtres s'ouvrent).

1. `pnpm install`, `pnpm typecheck`, `pnpm test` : noter les tests qui échouent (chemins `/tmp`, séparateurs, `isAbsolute`) ; ce sont les premières choses à rendre indépendantes du système.
2. `pnpm build` puis `electron .` : la fenêtre s'ouvre-t-elle, avec une barre de titre système ? Le bandeau de la barre latérale est-il décalé (réserve de 76 px) ? Les vues superposées transparentes (barre flottante, panneaux) restent-elles transparentes ?
3. `LUCIUM_SMOKE_ONLY=platforms electron . --smoke --user-data-dir=<dossier jetable>` : le fichier `smoke-platforms.ts` est écrit pour les trois systèmes.
4. Menu : « Lucium » (À propos, Réglages, Quitter) ; raccourcis (Ctrl) ; les 15 raccourcis `Ctrl+Alt+…` avec un clavier AZERTY.
5. Liens ouverts depuis une autre application (première instance et seconde), navigateur par défaut.
6. Import depuis les autres navigateurs : les dossiers supposés existent-ils ?
7. Téléchargement d'un fichier au nom exotique ; « Afficher dans le dossier » ; corbeille.
8. Correcteur orthographique : quel trafic réseau au premier champ de texte ?
9. Empaquetage (`build.yml` avec `package`) puis installation propre ; SmartScreen ; bac à sable de Chromium sous Ubuntu 24.04 (`kernel.apparmor_restrict_unprivileged_userns` : un AppImage ne peut pas porter de profil AppArmor ; ne pas contourner par `--no-sandbox`, à trancher) ; `libfuse2` pour lancer un AppImage.

## 9. Questions ouvertes

1. **Windows et Linux** : sans testeur régulier de chaque système, la préparation ci-dessus ne devient pas une version.
2. **Les 15 raccourcis `Ctrl+Alt+…` sous Windows** : les supprimer, les passer à `Ctrl+Maj+Alt`, ou les garder (risque AltGr).
3. **Barre de titre** : celle du système (retenue pour un premier essai) ou dessinée par la page avec les boutons du système en surimpression (mise en page à refaire).
4. **Dictionnaires du correcteur** hors macOS : désactivés par défaut ; faut-il mémoriser le choix de les activer dans un réglage ?
5. **`extraMetadata`** dans `electron-builder.yml` : acceptable sur tous les systèmes ? (§5)
6. **Mac Intel** : essai sous Rosetta ; une archive x64 dans `release.yml`.
7. **Homebrew** : un tap du projet (`pOwn3d/homebrew-lucium`) plutôt que `homebrew/cask`, choix à confirmer par le mainteneur ([homebrew.md](homebrew.md)).
