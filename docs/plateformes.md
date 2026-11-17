# Plateformes : Windows, Linux, Mac Intel, Homebrew

La variante DRM a son propre document : `docs/drm.md`.

**Règle de lecture.** Lucium n'est écrit, mesuré et lancé à la main que sur macOS, Apple silicon. Tout ce qui suit pour Windows est **préparé sans avoir été exécuté**. Pour Linux, depuis le 17 novembre 2026, un jeu de test automatique (`linux.yml`, §8) construit les paquets et lance l'application sur un runner Ubuntu 24.04 de GitHub : ce qui y passe est dit « *vérifié en CI* ». Ce qui est *vérifié* l'est par des tests unitaires qui jouent un autre système sur un Mac, par la lecture du code d'`electron-builder` installé, par la validation de la configuration contre son schéma et, pour Linux, par ces exécutions en CI. Ce qui est *supposé* est dit comme tel. **Aucune machine Linux réelle (ni VM de bureau) n'a encore servi** : rien n'a été vu à l'écran par une personne. Rien n'a été signé ni publié pour Windows ou Linux.

## 1. En une page

| | macOS arm64 | macOS Intel | Windows | Linux |
|---|---|---|---|---|
| Code de l'application | testé (tests unitaires, suites moteur) | identique, jamais lancé | relu, couche écrite ; **tests unitaires et E2E (Playwright) joués en CI** sur `windows-latest` (§5.1), **jamais essayé à la main** | tests unitaires et 183 des 187 tests E2E passent en CI (Ubuntu 24.04, écran virtuel) ; **jamais vu sur un vrai bureau** |
| Empaquetage | `pnpm package` (dossier `.app`) | `dmg` + `zip` x64 préparés | NSIS x64 préparé | AppImage + deb x64 et arm64 **construits en CI** (non signés, 7 jours) ; le deb s'installe et démarre sur Ubuntu 24.04 |
| Signature | aucune (ad hoc) ; variante DRM : Developer ID, notarisée | aucune | aucune (SmartScreen avertira) | sans objet |
| Intégration continue | `ci.yml` (tests unitaires et build non signée, à chaque pull request), `smoke-macos.yml` (chaîne moteur : à la main, sur un tag et chaque semaine), `e2e.yml` (chaque nuit), `build.yml` (à la main et sur un tag) | `build.yml` (à la main et sur un tag, ne peut pas le lancer) | `windows.yml` : tests unitaires, installeur NSIS non signé en artefact (installé et désinstallé en silence, registre lu) et E2E, sur chaque pull request, à la main et chaque nuit (E2E) ; aucun n'est un contrôle requis ; `build.yml` (à la main et sur un tag) | `ci.yml` (typage, lint et tests, à chaque envoi et pull request) + **`linux.yml`** (paquets x64 et arm64, démarrage du deb et de l'AppImage, E2E sous Xvfb : sur une pull request qui touche le code, chaque nuit, à la main) + `build.yml` (expérimental) |
| Ce qui manque | signature + notarisation de la build standard | un Mac Intel (ou Rosetta) pour essayer | tout essai sur une vraie machine à la main (fenêtres, Explorateur, SmartScreen, « Applications par défaut ») ; signature (aucun certificat : carte à part) | un essai sur un vrai bureau (VM, carte 388) ; extensions à service worker (§8) ; Wayland ; AppImage sur Ubuntu 24.04 sans réglage (§8) |

Ce document couvre : ce qui est propre à macOS (§2), la couche de plateforme testée (§3), la configuration `electron-builder.yml` (§5), le brouillon `.github/workflows/build.yml` (§5), le cask Homebrew (§7), le jeu de test Linux en CI et la liste de contrôle d'un premier essai (§8). La couche n'a aucun réglage : elle remplace des appels directs par des appels qui, sur macOS, font la même chose.

## 2. Ce qui est propre à macOS

Méthode : recherche textuelle dans les fichiers de production (`src/` et `scripts/`, hors `*.test.ts` et `smoke-*.ts`). Une ligne comptée est une ligne de code, pas un fichier.

### 2.1 Appels et API

| Catégorie | Lignes hors de la couche | Où | Sur Windows / Linux |
|---|---|---|---|
| `process.platform` lu directement | 7 | `index.ts`, `browser.ts`, `popup-windows.ts`, `electron-engine.ts` (3), `dev-electron.mjs` | les 7 restantes sont déjà des paramètres (`popupKey`, agent utilisateur, partage d'écran) ou le script de dev macOS |
| Options de fenêtre `titleBarStyle: 'hidden'` + `trafficLightPosition` | 0 (5 types de fenêtre : principale, Mini-fenêtre, supplémentaire/privée, Réglages, application web) | `index.ts` (×3), `settings-window.ts`, `shell/web-apps.ts` (`webAppWindowFrame`) | sans les feux tricolores, une fenêtre à barre de titre cachée n'a **aucun bouton** : la couche laisse la barre de titre du système |
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
| Navigateur par défaut (`setAsDefaultProtocolClient`) | 4 | `index.ts`, `ipc.ts` | non branché ; sous Windows 10+ l'API n'enregistre qu'une association, l'utilisateur choisit dans les Paramètres (§9) ; `build/installer.nsh` écrit les entrées « Programmes par défaut » qui font apparaître Lucium dans la liste (§5, non exécuté) |
| Panneau « À propos » du système | 3 | `about.ts`, `index.ts` | `role: 'about'` : boîte personnalisée sous Windows, panneau GTK sous Linux (à constater) |

### 2.2 Défauts réels trouvés (pas seulement des appels à garder)

| Défaut | Où | Effet hors macOS | État |
|---|---|---|---|
| `LUCIUM_EXTENSIONS` séparée par `:` | `index.ts` | un chemin `C:\…` est coupé en deux | **corrigé** (`splitPathList`, `;` sous Windows) |
| Chemin d'un hôte de messagerie native testé par `startsWith('/')` | `shared/native-messaging.ts` | tous les hôtes Windows refusés | **corrigé** (`isAbsolutePath`) |
| Dossier de téléchargement d'un profil testé par `startsWith('/')` | `shared/profiles.ts` | un dossier `C:\…` effacé au chargement | **corrigé** |
| Raccourcis par défaut qui se percutent quand ⌘ devient Ctrl | `shared/keybindings.ts` | 13 groupes (26 commandes) : `Ctrl+1…9` (espaces et éléments), `Ctrl+D`, `Ctrl+N`, `Ctrl+Maj+C`, `Ctrl+F` | **corrigé** pour les défauts (15 réécrits, 5 sans défaut : `blankWindow`, `copyUrlQuote`, `developerMode`, `addSplit`, `closeSplitPane` ; `F11` pour le plein écran) ; un test échoue si deux défauts se rejoignent |
| Raccourcis `Ctrl+Alt+lettre` sous Windows | `shared/keybindings.ts` | Ctrl+Alt est AltGr sur beaucoup de claviers (dont le français) : le raccourci part pendant qu'on tape un caractère | **15 défauts concernés, non changés** (§9) : `newLittleArc`, `captureVisible`, `captureFull`, `copyUrlMarkdown`, `findReplace`, `viewSource`, `devTools`, `inspectElement`, `jsConsole`, `nextSpace`, `previousSpace`, `nextTab`, `previousTab`, `archive`, `clearSiteDataNow` |
| Raccourcis `Ctrl+Alt+flèches` sous Linux (GNOME) | `shared/platform.ts` (`LINUX_DEFAULTS`) | GNOME lie `Ctrl+Alt+↑/↓/←/→` au changement d'espace de travail et `Ctrl+Alt+Maj+↑/↓/←/→` au déplacement de la fenêtre vers un autre espace : le gestionnaire de fenêtres les prend avant l'application, qui ne les reçoit pas (essai du 17 novembre 2026, carte 388, défaut 4 : `Ctrl+Alt+↑` ne change pas d'onglet, `Ctrl+Alt+A` et `Ctrl+Alt+N` marchent) | **corrigé pour Linux** (macOS et Windows inchangés) : onglet suivant / précédent `Ctrl+Page suiv.` / `Ctrl+Page préc.` (les touches de Chrome et de Firefox), déplacer l'onglet vers le bas / le haut `Ctrl+Maj+Page suiv.` / `Ctrl+Maj+Page préc.`, espace suivant / précédent `Alt+Page suiv.` / `Alt+Page préc.` (Alt est déjà la touche des espaces hors macOS, `Alt+1…9` ; pas `Alt+flèches`, qui sont Précédent et Suivant dans les navigateurs). **Vérifié dans la source de GNOME 46** : le schéma `org.gnome.desktop.wm.keybindings` de gsettings-desktop-schemas 46.0 (étiquette `46.0`, dépôt gitlab.gnome.org/GNOME/gsettings-desktop-schemas) et `org.gnome.mutter.wayland` de mutter 46.0 donnent les raccourcis réservés ; l'aide GNOME 46 « Useful keyboard shortcuts » et « Keyboard navigation » (help.gnome.org/users/gnome-help/46/) les confirme et dit que `Ctrl+Page préc.` / `Ctrl+Page suiv.` sont les touches d'une interface à onglets. GNOME réserve `Super+Page préc.` / `Super+Page suiv.` pour les espaces, rien avec `Ctrl` ou `Alt` et les touches Page. Un test (`platform.test.ts`) refuse tout défaut Linux qui tombe sur la liste réservée par GNOME 46 (espaces, `Alt+Tab`, `Alt+F4`, `Ctrl+Alt+F1…F12`…) et échoue si on retire la correction. **Non vérifié sur une vraie session** : GNOME (Ubuntu 24.04) et KDE n'ont pas été essayés avec ces touches ; les valeurs d'Ubuntu qui s'ajoutent à celles de GNOME (réglages `ubuntu-settings`) ne sont pas lues. Les autres défauts `Ctrl+Alt+…` ne sont pas sur la liste de GNOME 46 (le même test) ; Ctrl+Alt n'est pas AltGr sous Linux (fait `ctrlAltIsAltGr`, supposé) |
| Correcteur orthographique actif sans langue | `page-commands.ts` | sur Windows et Linux Chromium **télécharge** ses dictionnaires (`electron.d.ts`, `setSpellCheckerDictionaryDownloadURL` : « By default Electron will download hunspell dictionaries from the Chromium CDN ») ; macOS utilise celui du système | **traité** : hors macOS le correcteur est désactivé par défaut (fait `systemSpellChecker` de `shared/platform.ts`) ; l'activer dans Édition › Orthographe et grammaire déclenche le téléchargement, dit dans le README ; le choix n'est pas mémorisé d'un lancement à l'autre |
| Noms de fichiers téléchargés nettoyés pour macOS seulement | `shared/file-names.ts` | pas de caractères `<>:"\|?*`, de noms réservés (`CON`, `NUL`, `COM1`…), de point ou d'espace final, limite de 260 caractères | **traité, non vérifié sur Windows** : `suggestedFileName(nom, { platform, folder })` remplace `<>:"\|?*` par `_`, préfixe `_` aux noms réservés (`CON`, `PRN`, `AUX`, `NUL`, `COM0-9`, `LPT0-9`, exposants `¹²³` compris, avec ou sans extension), mesure en unités UTF-16 (240) et raccourcit pour que le chemin reste sous 259 caractères quand le dossier est connu. Sans plateforme, comportement de macOS inchangé. Branché sur le dossier temporaire, la question « où enregistrer ? », le contrôle de reprise et le nom du PDF. Règles relues dans la page de Microsoft « Naming Files, Paths, and Namespaces » (caractères, noms réservés dont `¹²³`, point ou espace final, 260 caractères) ; `COM0` et `LPT0` n'y figurent pas, ils sont gardés par prudence ; la limite de 260 est la plus stricte (Windows 10 1607 et plus peut la lever par un réglage, supposé désactivé). Testé par des tests qui jouent `win32`, jamais sur une vraie machine. Pas branché : le chemin sans question (`uniquePath`) garde le nom de Chromium, qui nettoie déjà pour Windows (supposé) |
| Clé de chemin insensible à la casse | `engine/download-paths.ts` | vrai sur macOS et Windows, **faux sous Linux** : deux fichiers de casse différente sont pris pour un | **non traité** (conséquence : un numéro ajouté sans besoin) |
| Hôtes de messagerie native des extensions | `shared/native-messaging.ts` | Windows les trouve par la **base de registre**, pas par un dossier | dossiers Linux ajoutés ; Windows : seul le dossier de Lucium compte (la lecture d'une clé de registre n'est pas écrite ; `installer.nsh` supprime à la désinstallation la clé `Software\Lucium\NativeMessagingHosts` que cette lecture utiliserait) |
| Raccourci système de la Mini-fenêtre (`globalShortcut`) | `index.ts` | ne fonctionne pas sous Wayland sans portail (supposé, à vérifier) ; sur le runner Windows `CmdOrCtrl+Alt+N` est refusé (« taken by another application », journal des E2E) et, avec AltGr, il volerait la frappe de `~` sur certains claviers (question 2 du §9) | **non traité** |
| Fenêtre d'application web (« Ouvrir un site comme application ») | `shell/web-apps-wiring.ts` | `titleBarStyle: 'hidden'` posé sur tous les systèmes : sans feux tricolores, une fenêtre sans aucun bouton pour la fermer | **corrigé** (`webAppWindowFrame` passe par la couche : barre du système hors macOS) ; test qui échoue si la barre est cachée partout |
| Chemin choisi par l'utilisateur | `engine/download-names.ts` (`chosenFilePath`) | ne testait que `/` (fin de chemin, `..`) : un chemin Windows en `\` passait | **corrigé** (règles de `path.win32` ou `path.posix` selon la plateforme ; test) |
| Reprise d'un téléchargement | `shared/download-resume.ts` (`isRecordablePath`) | exigeait un chemin qui commence par `/` : **aucun** chemin `C:\…` n'était enregistrable, donc aucune reprise sous Windows | **corrigé** (accepte `C:\…` ; un partage réseau sans lettre n'est pas repris) ; 2 tests qui échouent sans la correction |
| Coffre de mots de passe | `password-vault.ts` (`writePrivateFile`) | exigeait le mode 0600 après chaque écriture ; Windows annonce 0666 pour tout fichier : « the file is not private », **le coffre ne pouvait jamais être enregistré** | **corrigé** (`isOwnerOnlyMode` : fait de plateforme `posixFileModes`, la vérification n'a pas de sens sous Windows ; la protection y est la liste d'accès du profil de l'utilisateur, que Node ne lit pas) |
| Pages locales (`file://`) | `engine/local-file-guard.ts` | construisait des chemins `/C:/Users/…` : `realpath` échouait toujours, donc **toute page locale perdait ses images et ses feuilles de style** (la garde refuse par défaut : ni fuite, ni exécution, mais un affichage cassé) | **corrigé** (chemins `C:\…`, adresse sans lecteur refusée ; tests par plateforme) ; non examinés : comparaison sans casse du dossier personnel et de la lettre de lecteur, flux de données NTFS, noms courts 8.3 |
| Listes du bloqueur | `blocking/list-store.ts` | « could be read by other users » écrit trois fois à **chaque lancement** (mode 0666 lu comme ouvert) | **corrigé** (`isClosedToOthers`) |
| Clé de signature du flux de mise à jour | `update-feed-signature.ts` | refusait la clé privée (mode 0666) : une publication lancée depuis Windows n'aurait pas pu signer | **corrigé** (le module n'importe rien du projet : il lit `process.platform` lui-même ; seul endroit, à valider) |
| `O_NOFOLLOW` | `durable-write.ts`, `engine/download-resume.ts` | n'existe pas sous Windows : un lien laissé sous le nom temporaire est suivi | **non traité** (le dossier de données est dans le profil de l'utilisateur, seul son compte peut y poser un lien ; la reprise garde un contrôle `lstat` et la comparaison `dev`/`ino`, dont le numéro de fichier NTFS n'est pas exact comme nombre JS) |
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

**Ce que les tests ne prouvent pas.** Que les dossiers de données des autres navigateurs sous Windows (`%LOCALAPPDATA%\Google\Chrome\User Data`, `%APPDATA%\Mozilla\Firefox\Profiles`…) et Linux (`~/.config/google-chrome`, `~/.mozilla/firefox`…) sont les bons sur une vraie machine, ni que `/sys/class/power_supply` répond comme supposé. Les dossiers Snap et Flatpak des navigateurs (`~/snap/firefox/common/.mozilla/firefox`, `~/snap/chromium/common/chromium`, `~/.var/app/…`) sont cherchés après le dossier ordinaire, et le premier qui existe sert (`browserDataDirs`, `browserDataDir` dans `src/main/platform/paths.ts`) : couverts par des tests qui jouent un dossier de snap, **pas** sur une vraie machine. Les identifiants Flatpak viennent de Flathub, non vérifiés. La source d'import `arc` n'est pas proposée hors macOS : son dossier sous Windows n'est pas connu.

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
| Barre de titre dessinée par la page (Windows/Linux) | `index.ts`, `shared/frame-layout.ts`, CSS | décrite au §10, **pas écrite** : `windowFrame(lights, overlay)` accepte déjà un `titleBarOverlay` ; il reste la mise en page |
| Lecture d'une clé de registre pour les hôtes de messagerie native (Windows) | `shared/native-messaging.ts`, `main/` | à écrire (aucune fonction prête) ; l'installeur ne s'en occupe qu'au nettoyage |

## 5. Construction : `electron-builder.yml` et `build.yml`

Configuration ajoutée **sans toucher** à `identity: null`, `extendInfo`, `electronFuses`, `extraResources` ni `asarUnpack`. Elle est **valide contre le schéma** d'`electron-builder` (un témoin négatif, une clé mal écrite, est bien refusé). Elle n'a encore servi à construire pour Windows ; pour Linux, elle sert à chaque exécution du workflow `linux.yml` (§8).

- **Windows** : `nsis`, x64, assistant en plusieurs pages, installation par utilisateur (`perMachine: false`), dossier modifiable. **Non signé, et c'est acceptable pour un premier essai** : aucun certificat n'est configuré (le projet est open source, pas de budget) ; Windows SmartScreen avertira (« Windows a protégé votre ordinateur » : *Informations complémentaires* puis *Exécuter quand même*). La signature (Authenticode) est une carte à part (identité du titulaire et budget à décider) ; `AGENTS.md` §7 la réserve au mainteneur et interdit toute étape de signature dans un workflow. `win.icon` pointe sur `build/icon.ico`.
- **Registre (`build/installer.nsh`)**, écrit, **jamais exécuté** (le premier essai de compilation sera celui de la CI) : `electron-builder` l'inclut de lui-même et appelle ses macros `customInstall` et `customUnInstall` (lues dans `templates/nsis` d'`app-builder-lib` 26.18). Il écrit, sous la racine de l'installation (`SHELL_CONTEXT` : `HKCU` pour l'installation par utilisateur), l'entrée « Programmes par défaut » de Windows (`Software\Clients\StartMenuInternet\Lucium` avec `Capabilities\URLAssociations` `http` et `https`, `RegisteredApplications`, un ProgID `LuciumURL` dont la commande reçoit l'adresse après `--`) et le schéma `lucium://`, et supprime tout cela à la désinstallation et à la mise à jour. Effet attendu, **supposé** : Lucium apparaît dans *Paramètres › Applications › Applications par défaut* et l'utilisateur peut le choisir pour http et https (Windows 10 et 11 ne laissent aucun programme se mettre par défaut tout seul). Pas d'association de fichiers (`.html`, PDF, images) : l'application lit un lien sur sa ligne de commande, pas un chemin de fichier. Pas de description dans les « Capabilities » : ce serait un texte d'interface dans une seule langue.
- **Linux** : `AppImage` et `deb`, x64 (le workflow `linux.yml` construit aussi l'arm64 avec `--arm64`, sans changer ce fichier). Catégorie `Network;WebBrowser`, types MIME `x-scheme-handler/http`, `x-scheme-handler/https`, `text/html`, `application/xhtml+xml` (pour que l'environnement de bureau propose Lucium comme navigateur ; `%U` est ajouté par l'outil). Synopsis du `.deb` : `synopsis` (première ligne de la description Debian ; sans elle la ligne était vide). Le `.deb` x64 et le `.deb` arm64 portent le même nom `lucium` sans `Multi-Arch` : ils ne s'installent pas ensemble. L'AppImage arm64 a une dépendance `libz.so` (sans version, fournie par `zlib1g-dev` seul) : la CI la voit passer parce que son runner a ce paquet ; sur un Ubuntu ordinaire elle ne démarre pas. Lu dans l'ELF (`DT_NEEDED`), non lancé sans `zlib1g-dev` ; l'AppImage x64 n'a que `libz.so.1`.
- **Champs descriptifs** (`extraMetadata`) : `homepage`, `author` (nom et adresse `contact@lucium.app`, la même que celle des signalements de sécurité, `SECURITY.md`) et `desktopName`. Un `.deb` refuse de se construire sans adresse de mainteneur ni page d'accueil (code d'`electron-builder` lu). **Ces trois champs entrent dans le `package.json` de l'application empaquetée sur tous les systèmes, macOS compris** ; rien ne les lit à l'exécution. À défaire si on préfère les passer en ligne de commande (`-c.extraMetadata…`) pour le seul Linux.
- **macOS** : voir §6.

Vérifié dans le code d'`electron-builder` : (0) un `build/installer.nsh` est inclus par défaut (`NsisTarget.js`, `getResource(options.include, "installer.nsh")`) ; (1) avec `--dir` sur la ligne de commande, les cibles du fichier sont ignorées, donc `pnpm package` et `release.yml` ne changent pas ; (2) la conversion d'icône essaie `build/icons/` *avant* `build/icon.icns` ; ce dossier ne contient aucun `16x16.png`…, donc sans `win.icon` explicite on aurait l'icône d'Electron avec un simple avertissement.

**Icônes** :

| Manquant | Pour | Aujourd'hui |
|---|---|---|
| `build/icon.ico` | exécutable et installeur Windows | **fait** : couches 16, 24, 32, 48, 64, 128, 256 (avec transparence) de la même icône que `build/icon.icns`. Faite avec les outils déjà installés sur le Mac : `iconutil -c iconset build/icon.icns`, puis ImageMagick (`magick icon_16x16.png 16.png`, `icon_16x16@2x.png` → 32, `icon_32x32@2x.png` → 64, `icon_128x128.png` → 128, `icon_256x256.png` → 256, 24 et 48 réduits depuis 32 et 128, puis `magick 16.png 24.png 32.png 48.png 64.png 128.png 256.png icon.ico`). Vue en planche contact : lisible dès 16 px ; l'aspect dans l'Explorateur n'est pas vérifié. À refaire si `pnpm icons:logo` change le dessin |
| `build/icons/16x16.png` … `512x512.png` | AppImage, deb, lanceur | conversion de `build/icon.icns` ; le dossier `build/icons/` est lu en premier |
| `build/installerHeaderIcon.ico`, `uninstallerIcon.ico`, bandeau NSIS | installeur | icônes par défaut de NSIS |
| `resources/app-icons/*.png` sert déjà d'icône de fenêtre possible (`icon` de `BrowserWindow`, Linux) | non branché | — |

**Workflow `.github/workflows/build.yml`** (brouillon) : à la main (`workflow_dispatch`) et sur un tag `v*` poussé, jamais sur une pull request (macOS coûte 10 fois le tarif Linux sur un dépôt privé, Windows 2 fois), matrice macOS / Windows / Linux, `pnpm typecheck`, `pnpm test`, `pnpm build`, puis, sur demande, l'empaquetage non signé et le dépôt des fichiers en artefact **3 jours**. Aucun secret, `permissions: contents: read`, `--publish never`, `CSC_IDENTITY_AUTO_DISCOVERY=false`. Windows et Linux sont `experimental` : une jambe qui échoue ne fait pas échouer l'exécution et les tests unitaires n'arrêtent pas la construction. Mêmes actions épinglées que `ci.yml`. Les tests Windows ont leur workflow propre (§5.1) ; `pnpm test:engine` n'est pas dans la matrice : il tourne dans `smoke-macos.yml`.

### 5.1 Windows en CI : `.github/workflows/windows.yml`

Fichier séparé de `build.yml` et de `ci.yml` (aucun des sept contrôles requis n'est renommé, aucun des trois jobs n'est requis). `windows-latest`, jeton en lecture seule, aucun secret, aucune signature, `--publish never`. Déclenché par chaque pull request qui ne touche pas que des documents, à la main, et chaque nuit (E2E seulement).

| Job | Ce qu'il fait | Constaté en CI |
|---|---|---|
| `Unit tests (Windows)` | `pnpm test` | premier passage : **641 échecs sur 19 416 tests, 90 fichiers** (chemins écrits avec `/`, modes POSIX, outils du mainteneur) ; corrigés ou sautés avec leur raison ; voir « Tests sautés sous Windows » |
| `Installer (Windows, unsigned)` | `pnpm build`, installeur NSIS x64 non signé, installation silencieuse pour l'utilisateur courant, lecture du registre, désinstallation silencieuse, relecture | **vert dès le premier passage** : `build/installer.nsh` compile ; les clés `http`/`https`, `LuciumURL`, `lucium://` et `RegisteredApplications` sont écrites puis retirées. Artefact `lucium-win-UNSIGNED-check-build` (7 jours : le plafond de `workflow-hygiene.test.ts`), à télécharger sur la page du passage (*Artifacts*) : c'est l'installeur à essayer, **non signé** (SmartScreen) |
| `E2E (Windows)` | la suite Playwright entière contre l'application construite depuis les sources, sur le bureau du runner | premier passage : **181 réussis, 6 échecs** (16 minutes) |

**Tests sautés sous Windows**, chacun avec sa raison dans le test et inscrit au registre de `src/main/conditional-skips.test.ts` : `chmod` qui ne refuse rien (il ne pose que l'attribut lecture seule), `mkfifo`, `O_NOFOLLOW`, les assistants et scripts macOS, les scripts de publication du mainteneur (bash, git, ssh : lancés sur son Mac), un nom de fichier `Icon` + retour chariot interdit sous Windows. Côté E2E : les images de référence des Réglages (dessinées sur macOS), le clic ⌥⌘ (disposition mesurée sur macOS seulement, `shared/little-modifier.ts`), et la moitié « rien ne défile » du test de défilement automatique (Chromium défile de lui-même au clic milieu sous Windows).

**E2E : échecs qui ne sont pas propres à Windows.** `site-panel.spec.ts:300` et `:329` échouent aussi sur macOS (même workflow lancé à la main, 5 échecs dont ces deux-là) : la rangée des extensions compte 9 tuiles (extensions, « + », dossier, page des extensions) là où le test en attend 8 ; hors périmètre, signalé. Le test de téléchargement lent laissait des processus d'aide de Chromium tenir le dossier de données (EPERM à la suppression) : la fermeture tue maintenant l'arbre (`taskkill /T`).

**Ce que la CI ne prouve pas** : l'aspect des fenêtres (barre de titre, polices, échelle de l'écran), l'Explorateur, SmartScreen, la page « Applications par défaut », un clavier AZERTY, une machine avec le mode développeur absent (liens symboliques), les chemins longs, un compte standard sans droits d'administrateur (le runner est administrateur).

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

## 8. Linux : le jeu de test en CI, puis la liste de contrôle d'un premier essai (Windows ou Linux)

### 8.1 Le jeu de test Linux (`.github/workflows/linux.yml`)

Workflow « Linux » : sur une pull request qui touche le code, le paquetage ou les tests (pas sur une pull request qui ne change que de la documentation), chaque nuit à 03 h 30 UTC et à la main. Rien ne s'ouvre sur un poste : un écran virtuel (Xvfb) sur un runner Ubuntu 24.04 de GitHub. Ni signature, ni publication, ni secret ; aucun de ses jobs n'est un contrôle requis de `main`.

| Job | Ce qu'il fait |
|---|---|
| `Linux packages (x64)` et `(arm64)` | `electron-builder --linux AppImage deb`, non signé ; contrôle du contenu du deb ; **installe le deb avec `apt` et le lance** (Ubuntu 24.04 : le profil AppArmor est chargé par le script d'installation) ; lance l'AppImage telle que la machine la reçoit, puis une fois les espaces de noms d'utilisateur autorisés. Les paquets sont gardés 7 jours, sous le nom `lucium-linux-<arch>-UNSIGNED-check-build` |
| `E2E (Linux, xvfb)` | la suite Playwright de `tests/e2e` (187 tests, environ 13 minutes) contre le binaire Linux d'Electron et l'interface construite. Elle ne peut pas viser le paquet : ses fusibles sont fermés (`enableNodeCliInspectArguments: false`) et il refuse `--remote-debugging-port`, par lequel Playwright pilote Electron. Résultats (traces des échecs, `junit.xml`) gardés 14 jours : `e2e-linux-results` |

**Télécharger les paquets** : onglet *Actions* du dépôt › workflow *Linux* › une exécution › *Artifacts* (`lucium-linux-x64-UNSIGNED-check-build`, `lucium-linux-arm64-UNSIGNED-check-build`). Ce sont des paquets de contrôle (non signés, sans la variante DRM) : le nom de chaque fichier le dit, personne ne doit les prendre pour un téléchargement de Lucium. L'arm64 est celui d'une machine virtuelle Linux sur un Mac Apple silicon.

**Le bac à sable de Chromium n'est jamais coupé.** Ubuntu 24.04 restreint les espaces de noms d'utilisateur (`kernel.apparmor_restrict_unprivileged_userns=1`, constaté sur le runner, x64 et arm64), dont le bac à sable est fait. Ce que la CI a constaté :

| Cas | Résultat (vérifié en CI, x64 et arm64) |
|---|---|
| Le **deb** installé par `apt` | le script d'installation d'`electron-builder` charge `/etc/apparmor.d/lucium` (profil qui autorise `userns` pour `/opt/Lucium/lucium`) : l'application démarre, une fenêtre s'ouvre, chaque processus de rendu a son filtre seccomp (`Seccomp: 2`), aucun processus n'a `--no-sandbox` |
| Le binaire d'Electron des tests E2E | aucun profil ne le nomme : `scripts/linux-ci.sh sandbox-profile` charge le même profil pour lui, sans rien relâcher d'autre |
| L'**AppImage telle quelle** sur Ubuntu 24.04 | **refusée, à dessein.** Le script de lancement de l'AppImage (`AppRun`, d'`electron-builder`) ajoute `--no-sandbox` quand `unshare -Ur true` échoue, et Lucium refuse ce commutateur (`REFUSED_SWITCHES`) : code de sortie 1 et une ligne qui dit pourquoi et quoi faire. Un AppImage ne peut pas porter de profil AppArmor |
| L'AppImage une fois les espaces de noms autorisés (`sudo sysctl -w kernel.apparmor_restrict_unprivileged_userns=0`) | elle démarre, bac à sable actif, avec `libfuse2t64` installé (Ubuntu 24.04 ne l'a pas par défaut) |

Conséquence à retenir : **sur Ubuntu 24.04 et plus, le deb est la forme qui marche sans réglage ; l'AppImage demande que l'administrateur autorise les espaces de noms d'utilisateur.** Rien n'a été décidé au-delà (pas de `--no-sandbox` par défaut, pas de profil par utilisateur) : choix à confirmer avec la carte 388.

**Défauts trouvés par cette CI et corrigés** (chacun avec son test, vu échouer sans le correctif) :

- **Le deb contenait 68 fichiers inscriptibles par tout le monde** (modes 0666 et 0777), dont l'exécutable `/opt/Lucium/lucium` : l'archive d'Electron les porte et `electron-builder` les copie. `scripts/after-pack.cjs` remet 0755 (dossiers, exécutables) et 0644 (`scripts/linux-modes.cjs`), et le workflow échoue si un fichier du deb est inscriptible par le groupe ou les autres.
- **La ligne de refus de `--no-sandbox`** disait « commutateurs de développement et de test » à une personne qui n'avait rien tapé (c'est l'`AppRun` qui l'ajoute). Sous Linux elle dit maintenant pourquoi et quoi faire (`refusalMessage`, `src/main/runtime.ts`).

**E2E sous Linux : 183 passent, 1 est sauté, 3 échouent** (dernière exécution mesurée).

| Test | État | Raison |
|---|---|---|
| `settings.spec.ts` (comparaison visuelle des Réglages) | sauté hors macOS, la raison est dans le rapport | les images de référence sont celles du runner macOS (`-darwin-ci.png`) ; aucune n'est gardée pour Linux. Elles seraient dessinées et comparées par le workflow Linux comme celles de macOS : non fait |
| `command-bar.spec.ts` « omnibox-keywords » et `extensions.spec.ts` « extension-data-apis » | **échouent sous Linux seulement** (passent sur le runner macOS) | le service worker d'une extension démarre **sans `chrome.omnibox` ni les autres API que les scripts de `extension-shims.js` définissent** (`Cannot read properties of undefined (reading 'onInputStarted')`, puis « Service worker registration failed. Status code: 15 »), alors que les scripts sont bien enregistrés dans la session (`lucium-shims-sw`, `crx-mv3-preload`, `lucium-patches-sw`). **Cause non trouvée** : à chercher dans la VM avec les outils de développement du worker. Ce sont les deux seuls tests qui s'appuient sur un service worker d'extension : **on ne sait pas encore si les extensions à service worker marchent sous Linux** |
| `site-panel.spec.ts` « the row of the extensions goes to the line with six of them » | échoue **aussi sur macOS** (non lié à Linux) | le test attend 8 tuiles (6 extensions, « + » et le dossier) ; la rangée en porte 9 depuis que le bouton « Ouvrir la page Extensions » existe. Attente périmée, non corrigée ici (hors du périmètre) |

Ce que la CI a aussi rendu juste : « ⌥⌘-clic » ouvre bien une mini-fenêtre sous Linux avec **Ctrl+Alt**-clic (la touche « nouvel onglet » de Chromium est Ctrl hors macOS ; le test visait `Meta`, la touche Windows). Le test passe avec `ControlOrMeta`. Deux tests de `site-panel.spec.ts` comptaient les pages que Playwright liste (course avec l'apparition de l'onglet, rouges aussi sur macOS) : ils comptent maintenant les fenêtres de l'application.

**Ce que ce jeu de test ne prouve pas (supposé)** : l'aspect (aucune capture regardée par une personne), un vrai bureau (GNOME, KDE, Wayland : Xvfb est X11 sans gestionnaire de fenêtres), la barre de titre du système, le menu et les raccourcis d'un clavier réel (AZERTY), les liens ouverts depuis une autre application et le navigateur par défaut, l'import depuis les autres navigateurs, les téléchargements et « Afficher dans le dossier », le correcteur orthographique, l'accélération graphique (le runner n'a pas de GPU : rendu logiciel), le trousseau (pas de service Secret Service sur le runner : le coffre de mots de passe n'y est pas exercé), l'installation depuis un centre de logiciels, la mise à jour.

### 8.2 Liste de contrôle d'un premier essai (à la main, sur une machine réelle)

À faire dans l'ordre, une machine à la fois (ne pas lancer `pnpm test:engine` sur une machine qu'on utilise : de vraies fenêtres s'ouvrent). Ce qui est déjà couvert par la CI (§8.1) est dit ; le reste attend la machine (carte 388).

0. Avant tout (Windows) : installer l'installeur NSIS non signé (artefact de la CI, ou `electron-builder --win nsis --x64` sur la machine) ; SmartScreen avertit, passer par *Informations complémentaires*.
1. `pnpm install`, `pnpm typecheck`, `pnpm test` : **vérifié en CI** (`Unit tests (Linux)`, contrôle requis). Les chemins `/tmp`, séparateurs et `isAbsolute` passent.
2. `pnpm build` puis `electron .` : **partiellement vérifié en CI** (l'application démarre sous Xvfb, 183 tests E2E passent). Reste à regarder : la fenêtre a-t-elle une barre de titre système ? Le bandeau de la barre latérale est-il décalé (réserve de 76 px) ? Les vues superposées transparentes (barre flottante, panneaux) restent-elles transparentes ?
3. `LUCIUM_SMOKE_ONLY=platforms electron . --smoke --user-data-dir=<dossier jetable>` : **non fait** (la chaîne moteur ne tourne que sur macOS, `smoke-macos.yml`). Le fichier `smoke-platforms.ts` est écrit pour les trois systèmes.
4. Menu : « Lucium » (À propos, Réglages, Quitter) ; raccourcis (Ctrl) ; les 15 raccourcis `Ctrl+Alt+…` avec un clavier AZERTY. **Supposé** (la CI n'a pas de clavier réel ; `Ctrl+Alt`-clic sur un lien est vérifié). Sous Linux, ni `Ctrl+Alt+flèches` ni `Ctrl+Alt+Maj+flèches` (GNOME les garde) : onglet suivant / précédent `Ctrl+Page suiv.` / `Ctrl+Page préc.`, déplacer l'onglet `Ctrl+Maj+Page suiv.` / `Ctrl+Maj+Page préc.`, espace suivant / précédent `Alt+Page suiv.` / `Alt+Page préc.` : à essayer dans une vraie session GNOME.
5. Liens ouverts depuis une autre application (première instance et seconde), navigateur par défaut. **Non fait** sous Linux. Windows : *Paramètres › Applications › Applications par défaut* liste-t-il Lucium (entrées de `build/installer.nsh`) ? Après désinstallation, les clés `Software\Clients\StartMenuInternet\Lucium`, `Software\Classes\LuciumURL` et `Software\Classes\lucium` ont-elles disparu (`regedit`, lecture seule) ?
6. Import depuis les autres navigateurs : les dossiers supposés existent-ils ? **Non fait.** Sous Linux, les dossiers Snap et Flatpak (Firefox, Chromium) sont cherchés après le dossier ordinaire : couverts par des tests qui jouent un dossier de snap, **non vérifié sur une machine**.
7. Téléchargement d'un fichier au nom exotique (`CON.txt`, `a:b?.pdf`, un nom de 300 caractères dans un dossier profond : les règles de `file-names.ts`) ; « Afficher dans le dossier » ; corbeille. **Non fait** (les tests de téléchargement passent en CI, pas ces trois points).
8. Correcteur orthographique : quel trafic réseau au premier champ de texte ? **Non fait.**
9. Empaquetage puis installation propre (Windows : SmartScreen) : **vérifié en CI** pour le deb (installation par `apt`, profil AppArmor, démarrage) et pour l'AppImage (démarrage, `libfuse2t64`), en x64 et en arm64 ; le comportement du bac à sable sous Ubuntu 24.04 est dans le tableau du §8.1 (pas de `--no-sandbox`). Reste : l'installation à la main sur un bureau, l'intégration au menu des applications, l'association « navigateur par défaut ».

## 9. Questions ouvertes

1. **Windows et Linux** : sans testeur régulier de chaque système, la préparation ci-dessus ne devient pas une version.
2. **Les 15 raccourcis `Ctrl+Alt+…` sous Windows** : les supprimer, les passer à `Ctrl+Maj+Alt`, ou les garder (risque AltGr).
3. **Barre de titre** : celle du système (retenue pour un premier essai) ou dessinée par la page avec les boutons du système en surimpression (mise en page à refaire).
4. **Dictionnaires du correcteur** hors macOS : désactivés par défaut ; faut-il mémoriser le choix de les activer dans un réglage ?
5. **`extraMetadata`** dans `electron-builder.yml` : acceptable sur tous les systèmes ? (§5)
6. **Mac Intel** : essai sous Rosetta ; une archive x64 dans `release.yml`.
7. **Homebrew** : un tap du projet (`pOwn3d/homebrew-lucium`) plutôt que `homebrew/cask`, choix à confirmer par le mainteneur ([homebrew.md](homebrew.md)).
8. **Signature Windows** : aucun certificat, pas de budget (décision du 17 novembre 2026, projet open source) ; carte à part, à ouvrir quand le titulaire (une société ou une personne) et la voie sont choisis (certificat acheté, Azure Trusted Signing, SignPath pour l'open source : non comparés ici). Sans elle, SmartScreen avertit à chaque installation.
9. **Messagerie native sous Windows** : lire une clé de registre (`Software\Lucium\NativeMessagingHosts\<hôte>`) en plus du dossier de données ? Rien n'est écrit : la fonction n'existe pas, l'installeur ne fait que nettoyer.

## 10. Barre de titre Windows : description, pas d'implémentation

**Aujourd'hui** (premier essai) : sous Windows, la couche (`windowFrame`) ne pose ni `titleBarStyle` ni `trafficLightPosition` : chaque fenêtre garde la **barre de titre du système** (titre, réduire, agrandir, fermer). Rien n'est dessiné par la page à cet endroit. Les fenêtres concernées : principale, supplémentaire et privée, Mini-fenêtre, Réglages et application web (cinq façons de les ouvrir, toutes par la couche depuis la correction du §2.2).

**Ce que la barre dessinée par la page demanderait** (décrit d'après les types d'Electron 45 installés, `electron.d.ts`, et le code ; rien de cela n'est essayé) :

| Sujet | Description |
|---|---|
| Options de fenêtre | `titleBarStyle: 'hidden'` + `titleBarOverlay: { color, symbolColor, height }` : Electron laisse les trois boutons du système (réduire, agrandir, fermer) **en haut à droite, par-dessus la page**, et active les API et variables CSS « Window Controls Overlay » (`env(titlebar-area-x)`, `env(titlebar-area-width)`, `navigator.windowControlsOverlay`). `windowFrame(lights, overlay)` accepte déjà cet argument (`src/main/platform/index.ts`), aucun appelant ne le passe. Sans `titleBarOverlay`, `titleBarStyle: 'hidden'` laisse une fenêtre **sans aucun bouton** (c'est le défaut corrigé pour l'application web) |
| Zone des boutons | Un rectangle à droite de la fenêtre, `height` de haut (la hauteur de la rangée de la barre d'outils, `TOOLBAR_BAR_HEIGHT`, serait un bon candidat) et large de trois boutons (de l'ordre de 138 px à l'échelle 100 % sur Windows 11, **supposé** : à lire dans `env(titlebar-area-width)` plutôt qu'à écrire en dur). Cette zone ne reçoit ni clic de la page ni glissement : aucun contrôle de Lucium ne doit s'y trouver |
| Mise en page, barre latérale à gauche (défaut) | Les boutons tombent au-dessus de la rangée de la barre d'outils, à son extrémité droite : réserver à droite de la barre d'outils (et de l'en-tête de la Mini-fenêtre et de l'application web) la largeur `100vw - env(titlebar-area-width) - env(titlebar-area-x)`. Le calcul de position des vues natives (`shared/frame-layout.ts`) ne bouge pas : la zone est dans la page, pas dans le cadre |
| Mise en page, barre latérale à droite (miroir) | Les boutons tombent au-dessus de la barre latérale, qui doit laisser sa rangée du haut libre à droite. À l'inverse de macOS, où les feux restent à gauche |
| Réserve des feux tricolores | `LIGHTS_CLEARANCE = 76` (`frame-layout.ts`, `lightsRoom`, `cardLeftUnderLights`), `padding-left` de l'en-tête de la Mini-fenêtre (80 px, `little.css`) et de l'application web : à ramener à **0** quand `facts.trafficLights` est faux ; aujourd'hui, sur la barre du système, ce blanc est inutile mais sans gravité |
| Zones de déplacement | `-webkit-app-region: drag` (20 lignes, 9 feuilles) reste sur les rangées du haut, `no-drag` sur leurs boutons ; la zone des boutons du système n'est pas déplaçable. Le double-clic agrandit ; les dispositions d'accrochage de Windows 11 apparaissent au survol du bouton d'agrandissement, fournies par le système (supposé) |
| Couleurs | `color` et `symbolColor` doivent suivre le thème (clair/sombre, couleurs d'espace) : `BrowserWindow.setTitleBarOverlay` (Windows et Linux) les met à jour à chaud ; à lire depuis les mêmes jetons que la feuille de style (`tokens.css`), jamais en dur. Les valeurs `#17171c` et `#fff` de `platform.test.ts` ne sont que des exemples de test |
| Menu | Sous Windows chaque fenêtre porte son menu (`removeWindowMenu` le retire des fenêtres qui n'en veulent pas) : avec la barre dessinée par la page, le menu n'a plus de place visible ; à décider (raccourcis seuls, ou un bouton de menu dans la barre d'outils) |
| Fenêtres | Les cinq reçoivent l'option ; la Mini-fenêtre (toujours au premier plan, petite) pourrait garder la barre du système ; Réglages aussi |
| Vérification | Impossible ici : seule une vraie fenêtre Windows montre les boutons, leur largeur à 125 %, 150 % de mise à l'échelle, et le comportement du double-clic. `smoke-platforms.ts` vérifie déjà les options posées par la couche |

**Décision attendue** (question 3 du §9) : la phase 1 garde la barre du système ; la barre dessinée par la page est une autre carte, à ouvrir si le chef de projet la veut.
