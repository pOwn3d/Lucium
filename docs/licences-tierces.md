# Licences des composants tiers

Lucium est publié sous **GPL-3.0-or-later** (texte dans `LICENSE`, avis dans `NOTICE` : « Copyright © 2026 ConsilioWeb and contributors »). Ce document recense ce qui n'est pas de nous et que l'application embarque, charge ou télécharge, avec la licence relevée **dans le paquet installé ou dans l'en-tête de la liste elle-même**, et ce que chaque licence nous oblige à faire. Il donne aussi l'origine des médias du dépôt (logo, icônes, animation, sons, vidéos de fond, polices).

Aucun code, image, police ni donnée propriétaire d'un autre navigateur n'est repris.

## Où sont les textes

| Fichier | Contenu | Dans l'application construite |
|---|---|---|
| `LICENSE` | Le texte de la GPL version 3 | `Contents/Resources/LICENSE` |
| `NOTICE` | Le titulaire du droit d'auteur, ce qui n'est pas sous GPL (composants tiers, médias générés, logo), les faits sur la variante DRM et le texte de la permission additionnelle | `Contents/Resources/NOTICE` |
| `ADDITIONAL-PERMISSION.txt` | La permission additionnelle (GPL version 3, article 7) pour le module Widevine et le moteur qui le charge | `Contents/Resources/ADDITIONAL-PERMISSION.txt` ; son texte est aussi repris en entier dans `NOTICE` |
| `ADDITIONAL-PERMISSION-APP-STORE.txt` | La permission additionnelle (GPL version 3, article 7) pour distribuer l'application iPhone et iPad par l'App Store d'Apple et TestFlight (17 novembre 2026) ; elle ne couvre que le code du projet, pas les listes de filtres ni les autres composants tiers | non livré dans l'application du Mac (elle ne contient pas de code d'`ios/`) ; son texte est repris en entier dans `NOTICE` ; l'application iOS la montrera dans son écran des licences (`docs/ios.md`, §6.5) |
| `NOTICE-MEDIA.md`, `NOTICE-MEDIA.fr.md` | Les médias générés par IA (vidéos de fond, musique du film) : origine, et absence de licence libre | non livré (dépôt) ; `NOTICE` en porte le résumé |
| `THIRD-PARTY-NOTICES.txt` | Les paquets npm livrés : version, licence déclarée, adresse des sources, texte de chaque licence. **Généré** depuis `pnpm-lock.yaml` (`pnpm notices`), jamais écrit à la main | `Contents/Resources/THIRD-PARTY-NOTICES.txt` |
| `LICENSE.electron.txt` | La licence d'Electron (MIT) | `Contents/Resources/`, copié depuis la distribution d'Electron sur laquelle la build est faite |
| `LICENSES.chromium.html` | Les avis de Chromium et de tout ce qu'il embarque (FFmpeg, etc.) | idem |
| `resources/fonts/LICENSES.md` | Les dix polices : droits d'auteur, version, empreinte, texte de l'OFL 1.1 | `Contents/Resources/fonts/LICENSES.md` |
| `TRADEMARKS.md` | Le nom et le logo de Lucium : ce qui est réservé, les fichiers du logo qui ne sont pas sous GPL, ce qu'un fork doit changer | non livré (dépôt) ; `NOTICE` en porte le résumé |
| ce document | Tout ce qui ne vient pas de npm, et l'origine des médias | `Contents/Resources/docs/licences-tierces.md` |

Sur les autres systèmes, les deux fichiers du moteur sont à côté de l'exécutable et les textes du projet dans son dossier `resources`. `scripts/after-pack.cjs` copie les deux fichiers du moteur et **arrête la build** si l'un des cinq premiers manque ou est vide (`scripts/notices/shipped-notices.cjs`) ; `scripts/package-drm.mjs` refait le contrôle sur le dossier qui sera signé, avant toute signature.

## Bloqueur de publicités et de traqueurs

### Moteur de filtres : `@ghostery/adblocker` 2.20.3

| Paquet | Licence | Rôle |
|---|---|---|
| `@ghostery/adblocker` | MPL-2.0 | Moteur : analyse des listes, correspondance des requêtes, règles cosmétiques, sérialisation |
| `@ghostery/adblocker-content`, `@ghostery/adblocker-extended-selectors`, `@ghostery/url-parser` | MPL-2.0 | Dépendances du moteur |
| `@remusao/guess-url-type`, `@remusao/small`, `@remusao/smaz`, `@remusao/smaz-compress`, `@remusao/smaz-decompress`, `@remusao/trie` | MPL-2.0 | Dépendances du moteur |
| `tldts-core`, `tldts-experimental` | MIT | Extraction du domaine d'une adresse, pour le moteur. Lucium ne se sert pas de `tldts-experimental` pour ses propres décisions : sa liste des suffixes publics est une structure probabiliste, qui prend de rares domaines ordinaires pour des suffixes (`q8x.io`, `5cl.app`, trouvés en la comparant à la liste exacte) |
| `tldts` | MIT | La liste exacte des suffixes publics, du même auteur que `tldts-experimental` mais plus récente (7.5.5, avec son propre `tldts-core` 7.5.5 : voir la remarque sur `tldts` plus bas), dépendance directe de Lucium : `src/shared/party.ts` s'en sert pour juger si une requête va au site du document qui l'émet (mode Standard du bloqueur), si une entrée du coffre est voisine, si un lien reste dans une fenêtre d'application, et `src/main/shell/boost-host.ts` pour refuser de partager une Retouche pour tout un suffixe ; suffixes privés compris (`github.io`). Aucun script d'installation. Coût mesuré hors d'Electron avec la 7.4.22, non refait depuis, ni pour la 7.5.4 ni pour la 7.5.5 : 2,5 ms au premier chargement (1,3 ms pour la variante probabiliste), 130 Kio de code minifié |

- **Compatibilité avec la GPL-3.0-or-later** : la MPL-2.0 (§1.12 et §3.3) autorise de distribuer le code couvert dans une « œuvre plus large » sous une licence secondaire (GPL 2+, LGPL 2.1+, AGPL 3+), sauf si l'auteur a apposé la mention « Incompatible With Secondary Licenses » (Exhibit B). Vérifié : le texte de la licence contient l'Exhibit B comme tout exemplaire de la MPL-2.0, mais **aucun fichier du paquet** (sources, en-têtes, `package.json`, README) n'appose cette mention ; les en-têtes ne portent que l'Exhibit A. Les fichiers du moteur restent sous MPL-2.0, le reste de Lucium sous GPL-3.0-or-later.
- **Obligations** : conserver les en-têtes de licence et le fichier `LICENSE` du paquet (le paquet est installé tel quel dans `node_modules`, puis dans `app.asar` : il n'est pas modifié) ; indiquer où trouver le code source des fichiers MPL : <https://github.com/ghostery/adblocker> et le registre npm (`@ghostery/adblocker@2.20.3`). Nous n'avons modifié aucun de ces fichiers.
- Le moteur est derrière l'interface `FilterEngine` (`src/main/blocking/filter-engine.ts`) ; `src/main/blocking/ghostery-engine.ts` est le seul fichier qui l'importe.

#### Moteur évalué et non retenu : `adblock-rs` 0.13.3

Licence **MPL-2.0** (lue dans le paquet), donc également compatible. Essayé avec une toolchain Rust installée à part : il compile en 25 s sur Apple silicon et se charge dans Electron 45.0.0 (arm64) ; EasyList + EasyPrivacy se compilent en 70 ms et une vérification de requête prend 1,8 µs (3,1 µs et 203 ms pour le moteur retenu : sans effet pour l'utilisateur). Mais le paquet npm **ne contient aucun binaire précompilé** : `postinstall` lance `cargo build --release` (toolchain Rust 1.97 imposée par `rust-toolchain.toml`) et pnpm 12 refuse de l'exécuter sans `allowBuilds`. Chaque contributeur et chaque CI devrait installer Rust, et la version `darwin-x64` demanderait une seconde compilation croisée. Rejeté pour cette raison, pas pour la vitesse ni la licence.

### Listes de filtres

**Aucune liste n'est livrée avec Lucium pour Mac ni stockée dans le dépôt** (l'application iOS fait autrement : voir plus bas). Elles sont téléchargées sur le Mac où Lucium tourne, depuis le site de leurs auteurs, uniquement lorsqu'une option de blocage est activée (par une requête GET, sans donnée envoyée), puis conservées telles quelles dans le dossier de données (`filters/lists/`). Chaque liste garde sa licence ; l'application ne les modifie pas.

| Liste | URL officielle | Licence déclarée | Attribution |
|---|---|---|---|
| EasyList | <https://easylist.to/easylist/easylist.txt> | GPL-3.0-or-later **ou** CC BY-SA 3.0 (au choix), selon <https://easylist.to/pages/licence.html> | « Les auteurs d'EasyList » (<https://easylist.to/>) si requis |
| EasyPrivacy | <https://easylist.to/easylist/easyprivacy.txt> | idem | idem |
| EasyList Cookie List | <https://ublockorigin.github.io/uAssets/thirdparties/easylist-cookies.txt> (copie de <https://secure.fanboy.co.nz/fanboy-cookiemonster.txt>, publiée par <https://easylist.to/>, dont la directive `!#include` est résolue) | **CC BY 3.0** d'après l'en-tête du fichier ; le dépôt `easylist/easylist` d'où elle est générée est en GPL-3.0-or-later / CC BY-SA 3.0 | « Les auteurs d'EasyList » |
| uBlock filters | <https://ublockorigin.github.io/uAssets/filters/filters.min.txt> (le fichier `filters.txt`, `!#include` résolus) | GPL-3.0 (<https://github.com/uBlockOrigin/uAssets/blob/master/LICENSE>) | Raymond Hill et les contributeurs d'uAssets |
| uBlock filters – Badware | <https://ublockorigin.github.io/uAssets/filters/badware.txt> | GPL-3.0 | idem |
| uBlock filters – Confidentialité | <https://ublockorigin.github.io/uAssets/filters/privacy.min.txt> (`privacy.txt`, `!#include` résolu) | GPL-3.0 | idem |
| uBlock filters – Dépannage (unbreak) | <https://ublockorigin.github.io/uAssets/filters/unbreak.txt> | GPL-3.0 | idem |
| uBlock filters – Correctifs rapides (quick fixes) | <https://ublockorigin.github.io/uAssets/filters/quick-fixes.txt> | GPL-3.0 | idem |
| AdGuard Français (inclut la Liste FR) | <https://filters.adtidy.org/extension/ublock/filters/16.txt> | **GPL-3.0** (dépôt `AdguardTeam/AdguardFilters`, <https://github.com/AdguardTeam/AdguardFilters/blob/master/LICENSE>) ; la Liste FR qu'elle reprend (`easylist/listefr`) est en **CC BY-SA 3.0** d'après son en-tête | AdGuard et « les auteurs de la Liste FR » (<https://forums.lanik.us/viewforum.php?f=91>) |
| uBlock filters – Avis de cookies | <https://ublockorigin.github.io/uAssets/filters/annoyances-cookies.txt> | GPL-3.0 | idem |

Points à connaître :

- Le texte `LICENSE` d'uAssets est la GPL version 3 sans mention « ou ultérieure » : nous le traitons comme **GPL-3.0 seule**. Sans conséquence pour le Mac, dont l'application ne redistribue pas ces listes. **L'application iOS en embarque une copie convertie** (section suivante) : l'ensemble qu'elle distribue est donc à traiter comme GPL-3.0 et non « 3 ou ultérieure ».
- L'en-tête de l'EasyList Cookie List annonce CC BY 3.0 alors que l'ensemble du dépôt EasyList est en double licence GPL-3.0-or-later / CC BY-SA 3.0, et la page de licence précise que les fichiers hébergés ailleurs peuvent suivre d'autres conditions. Dans les deux cas l'obligation est la même (créditer les auteurs) et nous ne redistribuons pas la liste.
- **Fichiers composés (`.min.txt`) et `!#include`.** Le moteur ne suit pas la directive `!#include autre-fichier.txt` : `filters.txt` d'uBlock n'a que 6 078 règles sur les 23 939 de la liste complète, `privacy.txt` et `fanboy-cookiemonster.txt` perdent aussi un fichier. Le catalogue pointe donc vers les versions où les inclusions sont résolues, et une liste qui contient encore un `!#include` est refusée au téléchargement plutôt que chargée incomplète (`validateFilterList`).
- Les listes d'uBlock contiennent des règles `##+js(...)` (scriptlets) et des redirections vers des ressources neutralisées. Lucium n'embarque **aucune** ressource d'uAssets : avec l'option « Scriptlets et règles étendues du bloqueur », une règle ne fait que **nommer** l'un des douze scriptlets de sa propre bibliothèque (`src/preload/guard-world.ts`) ou l'une de ses ressources de remplacement (`src/shared/redirect-resources.ts`), toutes écrites pour Lucium ; une règle qui nomme autre chose est ignorée (scriptlets) ou traitée comme un blocage simple (redirections). Sans l'option, ces règles sont ignorées.

### Listes de filtres embarquées dans l'application iOS

L'application iPhone et iPad **embarque** neuf des listes du tableau ci-dessus (`EMBEDDED_LIST_IDS` de `scripts/ios-filter-lists/embedded-lists.ts` : EasyList, EasyPrivacy, les six listes uBlock filters et l'EasyList Cookie List ; **AdGuard Français n'est pas embarquée** : la décision du 17 novembre 2026 ne la nomme pas, et sa licence est la moins claire du catalogue), pour que le bloqueur n'ait rien à télécharger (`docs/ios.md`, section 6.5).

- **Ce qui est livré** : le résultat de la conversion de chaque liste en règles de WebKit (`scripts/ios-filter-lists.mjs`), c'est-à-dire **une œuvre dérivée** de la liste, avec la liste d'origine nommée par son adresse. Les fichiers sont produits à la préparation de la build depuis les adresses du tableau ci-dessus, **jamais versionnés** dans le dépôt (`ios/Lucium/FilterLists/`, ignoré) ; le convertisseur, sous GPL-3.0-or-later avec le reste du projet, est dans le dépôt, de sorte que la copie livrée se refait à partir de sa source.
- **Attribution** : l'application montre, pour chaque liste, son titre, son auteur, sa licence, l'adresse de sa source, celle des conditions de sa licence et la date de la copie (écran « Licences et crédits », lu dans le registre que le script écrit avec les fichiers à partir des mêmes mentions que celles du tableau). **Le script refuse d'écrire** une liste dont la licence, l'auteur ou une adresse manque.
- **Mises à jour** : avec l'application seulement (une nouvelle version sur l'App Store ou TestFlight), jamais par un téléchargement de l'application. Le tableau des connexions de `docs/ios.md` (section 7) ne gagne donc aucune ligne.
- **Ce que la permission additionnelle ne couvre pas** : `ADDITIONAL-PERMISSION-APP-STORE.txt` ne vaut que pour le code dont les titulaires l'ont accordée ; **les auteurs de ces listes ne l'ont pas accordée**. Les conditions de l'App Store face à la GPL-3.0 d'uBlock filters et à la double licence d'EasyList (GPL-3.0-or-later ou CC BY-SA 3.0) **n'ont pas été analysées par un juriste** : le chef de projet a décidé le 17 novembre 2026 de faire sans, et le risque est assumé par le mainteneur. Aucune relecture n'est prévue avant l'envoi.

### Listes de l'utilisateur (fichier ou texte collé)

Aucune dépendance ni donnée ajoutée : ces listes sont celles que l'utilisateur apporte lui-même (un fichier de son disque, ou des règles qu'il colle), lues par le même moteur `@ghostery/adblocker` et conservées dans `filters/lists/custom-<id>.txt` du dossier de données. **Lucium n'en télécharge aucune depuis une adresse** (l'ajout par adresse n'existe pas). La licence d'une liste est celle de son auteur : l'application affiche la source (nom du fichier ou « Règles collées »), pas la licence, qu'elle ne peut pas connaître ; le texte conservé ne garde que les règles retenues (les commentaires, dont l'en-tête de licence d'une liste, sont écartés de la copie : l'utilisateur garde son fichier d'origine). Une liste d'un tiers qu'on redistribuerait avec l'application resterait soumise au paragraphe précédent.

Listes examinées et non retenues : « I don't care about cookies » (<https://www.i-dont-care-about-cookies.eu/abp/>, GPL-3.0 d'après son en-tête, mais dernière modification le 30 novembre 2023 : périmée) ; les listes du dépôt `brave/adblock-lists` (Unbreak, Specific, Social, liste « première partie ») : licence **MPL-2.0** (API GitHub), compatible comme le moteur, mais non incluses : elles sont écrites pour un autre moteur de filtres (options `:5`, ressources propres à ce moteur), et une comparaison n'a montré aucune requête qu'elles bloquent et que nous laissons passer une fois les listes uBlock complètes ; « Fanboy's Mobile Notifications » (CC BY 3.0) : bannières « installez l'application », hors du périmètre des deux options du bloqueur.

## Navigation sûre : listes de sites dangereux (`resources/safe-browsing/`)

Deux listes publiques d'**hôtes** (noms de domaine et adresses IPv4), **embarquées** sous forme d'empreintes de 8 octets (64 bits, non cryptographiques) (`src/shared/safe-set.ts`) : on ne peut pas en relire les noms, seulement tester un nom connu. Elles sont préparées par `scripts/build-safe-browsing.mjs` sur la machine du mainteneur avant une version, et **ne changent qu'avec l'application** : l'application ne télécharge rien pour cette fonction, n'envoie aucune adresse visitée, et le tableau des connexions du README ne gagne aucune ligne. `resources/safe-browsing/SOURCES.json` dit pour chaque liste l'adresse, la licence, le nombre d'hôtes, la date de la copie, le nombre d'hôtes partagés retirés, l'empreinte sha-256 de la source téléchargée et celle du fichier emballé. Les hôtes qui servent des pages de tout le monde (raccourcisseurs, sites de collage, stockage, constructeurs de pages, passerelles IPFS : `SHARED_HOSTS` de `src/shared/safe-set.ts`) sont **retirés** avant l'emballage : le script refuse d'écrire un fichier qui en garde un, et `safe-set.test.ts` échoue si l'un d'eux figure dans l'instantané livré. Le script refuse aussi une source de plus de 40 Mo ou plus lente que 120 s, et une liste dont le nombre d'hôtes varie de plus de 20 % depuis l'instantané remplacé (sauf `--force`, après relecture).

| Liste | Source | Licence (relevée le 22 novembre 2026) | Usage |
|---|---|---|---|
| Hameçonnage | Phishing.Database, `phishing-domains-ACTIVE.txt` (<https://github.com/Phishing-Database/Phishing.Database>) | **MIT** (fichier `LICENSE` du dépôt : © 2018-2025 Mitchell Krog, Nissar Chababy et les contributeurs), compatible avec la GPL-3.0-or-later. Le texte de la licence MIT est livré avec l'application : `resources/safe-browsing/LICENSES.txt` | 392 051 hôtes retenus (100 lignes qui n'étaient pas un nom d'hôte simple ont été écartées) |
| Logiciels malveillants | `urlhaus-filter`, `urlhaus-filter-domains-online.txt` (<https://gitlab.com/malware-filter/urlhaus-filter>), fait des données de abuse.ch URLhaus | **CC0 1.0 et MIT** d'après le README du dépôt (fichiers `LICENSE-CC0.md` et `LICENSE` présents) ; les données d'URLhaus y sont déclarées CC0. **Non confirmé par cette vérification sur le site d'abuse.ch** (la page lue n'énonce pas la licence) : à relire sur <https://urlhaus.abuse.ch/> avant une version publique | 1 929 hôtes retenus |

Listes examinées et écartées : URLhaus en direct (une clé, donc un compte, est désormais exigée : réponse 410 sans clé) ; OpenPhish (conditions non commerciales, incompatibles avec la GPL) ; PhishTank (compte et clé ; CC-BY-SA) ; HaGeZi « Threat Intelligence Feeds » (GPL-3.0 seule, sans « ou ultérieure », et 4 à 34 Mo) ; `phishing-filter` de malware-filter (sources OpenPhish et PhishTank).

**Taille** : bornée à 4 000 000 d'octets pour les deux fichiers ensemble (`SNAPSHOT_MAX_BYTES` de `src/shared/safe-set.ts`) ; le script refuse d'écrire au-delà et `safe-set.test.ts` échoue si les fichiers livrés la dépassent. L'instantané du 22 novembre 2026 pèse 3 151 856 octets (3 136 416 + 15 440).

**Limite** : une liste livrée avec l'application a l'âge de sa dernière version. Elle protège de ce qui est listé à cette date, pas des sites apparus depuis ; l'application le dit dans le réglage et sur la page d'avertissement.

## Mode lecture : `@mozilla/readability` 0.6.0

| Paquet | Licence | Rôle |
|---|---|---|
| `@mozilla/readability` | Apache-2.0 (lue dans `package.json` et `LICENSE.md` du paquet installé) | Extrait l'article d'une page (titre, auteur, texte, images) pour le mode lecture (`src/main/engine/reader-mode.ts`) |

- **Compatibilité avec la GPL-3.0-or-later** : l'Apache-2.0 est compatible avec la GPL version 3 (la GPLv2 seule ne l'est pas, mais Lucium est en 3 ou ultérieure) : l'œuvre combinée reste distribuable sous GPL-3.0-or-later, le fichier de `@mozilla/readability` gardant sa licence Apache-2.0.
- **Comment il est livré** : le fichier `Readability.js` du paquet est inséré tel quel, comme texte, dans `out/main/index.js` (import `?raw`, `electron.vite.config.ts` l'exclut de l'externalisation) puis injecté dans un monde isolé de la page pour lire son DOM. Il n'est pas modifié ; son en-tête (« Copyright (c) 2010 Arc90 Inc », texte de la licence Apache-2.0) est conservé dans le fichier livré (vérifié dans `out/main/index.js`). Arc90 Inc. est l'auteur d'origine de readability.js.
- **Obligations** : conserver l'avis de copyright et le texte de la licence (fait : ils sont dans le fichier) ; indiquer les modifications s'il y en avait (aucune). Code source : <https://github.com/mozilla/readability> et le registre npm (`@mozilla/readability@0.6.0`).
- Le contenu qu'il renvoie vient de la page : il n'est jamais exécuté. Il s'affiche dans un document sans script (CSP `default-src 'none'`, voir `src/shared/reader.ts`).

## Thèmes prêts à l'emploi : palettes de couleurs (`src/shared/theme-presets.ts`)

Aucun code ni fichier de ces projets n'est repris : **seules les valeurs hexadécimales** de leurs palettes sont écrites dans `theme-presets.ts` (une couleur n'est pas une œuvre), avec la source en commentaire. Les fichiers cités dans la colonne « Source des valeurs » sont ceux **du dépôt amont nommé** (par exemple `src/nord.scss` dans `nordtheme/nord`), pas des fichiers de Lucium. Les licences ci-dessous ont été relevées dans le fichier `LICENSE` du dépôt cité ou, à défaut, dans son README ou l'API de GitHub ; toutes sont permissives et compatibles avec la GPL-3.0-or-later. Par courtoisie et pour respecter les licences qui demandent de conserver l'avis de copyright, les auteurs sont nommés ici.

| Thèmes (noms dans l'éditeur) | Source des valeurs | Licence | Auteurs |
|---|---|---|---|
| Dracula, Dracula Alucard | <https://github.com/dracula/dracula-theme> (README, « Color Palette ») | MIT | Dracula Theme |
| Nord | <https://github.com/nordtheme/nord> (`src/nord.scss` : nord0, nord8) | MIT | Sven Greb et les contributeurs |
| Solarized sombre, Solarized clair | <https://github.com/altercation/solarized> (README : base03, base3, blue) | MIT | Ethan Schoonover |
| Gruvbox sombre, Gruvbox clair | <https://github.com/morhetz/gruvbox> (`colors/gruvbox.vim`) | MIT/X11 (indiqué dans le README ; le dépôt n'a pas de fichier `LICENSE` reconnu par GitHub) | morhetz (Pavel Pertsev) |
| Tokyo Night, Tokyo Night Storm | <https://github.com/folke/tokyonight.nvim> (`lua/tokyonight/colors/night.lua`, `storm.lua`) ; le thème d'origine est celui d'enkia (<https://github.com/enkia/tokyo-night-vscode-theme>, dont les valeurs coïncident) | **Apache-2.0** pour tokyonight.nvim | Folke Lemaitre ; enkia |
| Catppuccin Mocha, Catppuccin Macchiato, Catppuccin Frappé, Catppuccin Latte | <https://github.com/catppuccin/palette> (`palette.json`, version 1.8.0) | MIT | Catppuccin |
| One Dark | <https://github.com/Binaryify/OneDark-Pro> (`themes/OneDark-Pro.json`) ; teinte d'accent de `one-dark-syntax` d'Atom | MIT (OneDark-Pro) ; MIT (Atom) | Binaryify ; GitHub Inc. |
| Monokai | <https://github.com/microsoft/vscode> (`extensions/theme-monokai`) | MIT | Microsoft Corporation ; palette de Wimer Hazenberg (Monokai) |
| Rosé Pine, Rosé Pine Moon, Rosé Pine Dawn | <https://github.com/rose-pine/rose-pine-palette> (`palette.json`) | MIT | Rosé Pine (mvllow et les contributeurs) |
| GitHub sombre, GitHub clair | `@primer/primitives` 11.10.0 (`dist/css/functional/themes/dark.css`, `light.css`) | MIT | GitHub Inc. |

- **Obligation** : la licence MIT demande de conserver l'avis de copyright et le texte de la licence **lorsqu'on distribue des copies ou des parties substantielles du logiciel**. Des valeurs hexadécimales isolées n'en sont pas ; la table ci-dessus tient lieu de mention. **Apache-2.0** (tokyonight.nvim) : même raisonnement ; aucun fichier n'est repris ni modifié, donc ni `NOTICE` ni texte de licence à joindre.
- Les noms (Dracula, Nord, Solarized, Gruvbox, Catppuccin, GitHub, etc.) désignent des palettes et appartiennent à leurs auteurs ; Lucium n'est ni affilié à eux ni approuvé par eux.
- La palette Monokai n'a pas de licence propre : la valeur retenue est celle du fichier de VS Code (MIT), dont l'en-tête dit reprendre les couleurs du Monokai d'origine (créé par Wimer Hazenberg).
- **Non vérifié** : la licence du thème Tokyo Night d'enkia (l'API de GitHub ne la signale pas ; le dépôt a été déplacé) : c'est pourquoi les valeurs ont été relevées dans tokyonight.nvim (Apache-2.0).

## Polices des Retouches (`resources/fonts/`)

Dix polices variables, **SIL Open Font License 1.1**, embarquées pour que les Retouches puissent les appliquer aux pages sans rien télécharger : Inter, Hanken Grotesk, Manrope, Figtree, Space Grotesk, Fraunces, Literata, Bodoni Moda, JetBrains Mono, Atkinson Hyperlegible Next.

- **Origine** : sous-ensembles « latin » (axe de graisse) distribués par Fontsource (`cdn.jsdelivr.net/fontsource/fonts/<police>:vf@latest/latin-wght-normal.woff2`), entrés dans le dépôt le 1er novembre 2026. Les contours des glyphes ne sont pas modifiés ; les métadonnées de Fontsource indiquent OFL-1.1 pour les dix.
- **Version et empreinte de chaque fichier** : l'adresse d'origine disait `@latest`, donc la version du paquet Fontsource n'est écrite nulle part et **n'est pas reconstituée ici**. Ce qui est épinglé est ce que le dépôt contient : la version que chaque police déclare dans son fichier (table `name`, identifiant 5), sa taille et son SHA-256, dans le tableau de `resources/fonts/LICENSES.md`. Le test `src/main/font-files.test.ts` refuse un fichier dont l'empreinte n'est pas celle du tableau : une police remplacée ou mise à jour ne passe pas sans que sa ligne soit refaite.
- **Droits d'auteur et texte de la licence** : `resources/fonts/LICENSES.md` (le tableau, puis le texte intégral de l'OFL 1.1), copié dans l'application empaquetée (`fonts/LICENSES.md` des ressources). La mention de copyright de chaque ligne est celle que porte le fichier (table `name`, identifiant 0).
- **Noms réservés** : une police qui déclare un « Reserved Font Name » ne peut pas être redistribuée modifiée (un sous-ensemble en est une) sous ce nom. **Playfair Display** et **Lora** en déclarent un : elles ont été écartées. Les dix retenues n'en déclarent aucun. Relu le 10 novembre 2026 dans le fichier de licence de la branche par défaut de chaque dépôt amont (`OFL.txt` ; `LICENSE.txt` pour Inter ; pour Manrope, dont le dépôt n'a pas ce fichier à sa racine, la copie `ofl/manrope/OFL.txt` du dépôt `google/fonts`) : OFL 1.1, aucune ligne « Reserved Font Name ». Limites : c'est l'état de la branche à cette date, pas celui du tag de la version embarquée ; et pour Fraunces et Manrope l'année de la mention amont (2018) n'est pas celle que porte le fichier embarqué (2020, 2019). Les pages reçoivent chaque police sous le nom `Lucium <police>`.
- **Choix des dix** : éditorial, recoupé entre plusieurs guides de typographie : sans-serif d'interface la plus installée (Inter), trois sans-serif de texte et géométriques (Hanken Grotesk, Manrope, Figtree), une grotesque technique (Space Grotesk), une sérif douce (Fraunces), une sérif de lecture (Literata), une sérif de titrage à fort contraste (Bodoni Moda), la police de code de référence (JetBrains Mono) et la plus lisible en basse vision (Atkinson Hyperlegible Next).
- **Limites** : sous-ensemble latin seulement (le français est couvert ; les caractères hors latin, par exemple cyrillique, grec, vietnamien ou latin étendu, retombent sur la police suivante de la pile) ; pas de variante italique (le navigateur synthétise l'oblique).

## Paquets npm livrés : `THIRD-PARTY-NOTICES.txt`

La liste n'est plus tenue à la main. `node scripts/make-third-party-notices.mjs` (`pnpm notices`) lit `pnpm-lock.yaml`, suit les `dependencies` de `package.json` et tout ce qu'elles demandent (les dépendances de développement, Vite, Vitest, TypeScript, electron-builder, ne sont pas livrées et n'y sont pas), puis écrit pour chaque paquet sa version, la licence que déclare son `package.json`, l'adresse de ses sources et le texte de licence qu'il contient. Le fichier est dans le dépôt et dans l'application.

- **Tenu à jour par un test** : `scripts/notices/third-party-notices.test.ts` refait le fichier et refuse une copie différente. Après un `pnpm add`, un `pnpm update` ou un nouvel `override`, relancer `pnpm notices` et enregistrer le fichier avec le lockfile.
- **Ce que le générateur refuse** (il s'arrête, avec la raison) : un paquet du lockfile qui n'est pas installé, une version installée qui n'est pas celle du lockfile, un paquet sans licence déclarée, un paquet sans fichier de licence qui ne déclare pas MIT. Ces cas demandent une décision, pas une ligne automatique.
- **Binaires par système** : `koffi` (appels natifs de l'annotation d'une fenêtre partagée) livre son binaire dans un paquet par système et par processeur (`@koromix/koffi-<système>`). Une build n'embarque que celui de sa cible ; le fichier les nomme tous sous `koffi`, sans texte propre, et le générateur vérifie sur celui qui est installé qu'il déclare la même licence.

Ce que le fichier généré ne peut pas dire, et qui reste écrit ici :

| Paquet | Remarque |
|---|---|
| `electron-chrome-extensions` 4.10.0 | **Modifié** par un correctif appliqué à l'installation (`patches/electron-chrome-extensions@4.10.0.patch`, `pnpm-workspace.yaml`). Le correctif est dans le dépôt ; le paquet garde son `LICENSE.md` dans `app.asar`. Le fichier généré signale le correctif sur la ligne du paquet. |
| `electron-chrome-web-store` 0.13.0 | Le paquet npm **ne contient ni fichier `LICENSE` ni ligne de copyright** : son `package.json` dit `"license": "MIT"` et nomme son auteur, Samuel Maddock ; le dépôt amont (`samuelmaddock/electron-browser-shell`) n'a pas non plus de `LICENSE` pour ce paquet. Le générateur écrit donc le texte MIT standard avec ce titulaire, **sans année** (le paquet n'en donne pas : elle n'est pas inventée), et le dit dans le fichier. |
| `adm-zip` 0.6.1 | Version imposée par `overrides` de `pnpm-workspace.yaml` (la 0.5.18 a une faille connue). |
| `@mozilla/readability` 0.6.0 | Voir « Mode lecture » ci-dessus. Son `LICENSE.md` ne contient que l'avis court de l'Apache-2.0, pas le texte entier : le texte entier est à <https://www.apache.org/licenses/LICENSE-2.0>. |
| `@types/chrome`, `@types/filesystem`, `@types/filewriter`, `@types/har-format` | Des déclarations de types sans code exécuté, apportées par `electron-chrome-web-store`. Elles sont dans `app.asar`, donc dans la liste. |
| `tldts` 7.5.5, `tldts-experimental` 7.4.22, `tldts-core` 7.5.5 et 7.4.22 | `tldts` est une dépendance directe de Lucium ; `tldts-experimental` est une dépendance du moteur de filtres, apportée par `@ghostery/adblocker` (qui accepte toute version 7.x depuis la 7.4.10), et reste en 7.4.22. `tldts-core`, dont les deux dépendent, existe donc en deux versions : la 7.5.5 pour `tldts`, la 7.4.22 pour `tldts-experimental` (même licence MIT, aucun script d'installation dans les deux). On a monté `tldts` seul, le 16 novembre 2026, parce que sa liste exacte des suffixes décide du partage d'une Retouche et du mode Standard du bloqueur, et que Lucium y compte les suffixes privés : la 7.4.24 corrige l'avis GHSA-mf82-cgp5-3vmq (une règle joker mal appliquée avec les suffixes privés) et la 7.4.26 fait du parent d'une règle joker un suffixe public (`kawasaki.jp`, `compute.amazonaws.com`), ce que `boost-host.test.ts` vérifie. La liste probabiliste du moteur de filtres ne sert pas à ces décisions, donc elle n'a pas été montée avec. Premier passage, le 12 novembre 2026, de la 7.4.19 à la 7.4.22 pour les deux paquets : `tldts-core` 7.4.20, que le verrou tenait, est dite dépréciée par le registre npm (publication interrompue à mi-chemin chez l'auteur) ; la 7.4.22 n'ajoutait que la liste des suffixes à jour et la reconnaissance de l'adresse IPv6 non spécifiée. |

**Electron et Chromium** ne sont pas des paquets livrés (le paquet npm `electron` est une dépendance de développement, qui télécharge le binaire) : leurs textes sont `LICENSE.electron.txt` (MIT) et `LICENSES.chromium.html`, pris dans la distribution d'Electron utilisée pour la build. La 0.2.15 distribuée ne les contenait pas : electron-builder ne copie que `Electron.app` quand on lui donne un moteur déjà décompressé, ce qui est le cas de la variante DRM. À partir de la 1.0, `scripts/after-pack.cjs` les copie, et la build s'arrête s'ils manquent.

**Code QR** : aucune bibliothèque. L'encodeur (`src/shared/qr.ts`) est écrit pour Lucium à partir de la norme ISO/IEC 18004 (octets, niveau M, versions 1 à 10) ; aucune dépendance n'est utilisée. Il a été relu par le lecteur de codes de macOS (CoreImage) sur toutes les versions 1 à 10 aux limites de capacité et sur les 8 masques ; les empreintes de ces codes sont dans `qr.test.ts`.

## Outils de développement non livrés : le linter

Le linter (`pnpm lint`) est **oxlint** 1.91.0, avec **oxlint-tsgolint** 7.0.2005 qui lit les types pour la règle des promesses. Ce sont des dépendances de développement : aucun des deux n'est dans l'application ni dans `THIRD-PARTY-NOTICES.txt`.

- Licence **MIT** pour les deux (lue dans le `LICENSE` et le `package.json` des paquets installés ; titulaires : VoidZero Inc. et contributeurs, et les contributeurs de typescript-eslint pour oxlint-tsgolint), compatible avec la GPL-3.0-or-later.
- **Aucun script d'installation** : ni `oxlint`, ni `oxlint-tsgolint`, ni leurs paquets par plateforme (`@oxlint/binding-*`, `@oxlint-tsgolint/*`) ne déclarent de `scripts` dans leur `package.json`. Rien n'est ajouté à `allowBuilds`.
- Ce sont des **binaires précompilés** (un par système et par processeur, dépendances optionnelles), téléchargés depuis le registre npm et vérifiés par les sommes de `pnpm-lock.yaml`. oxlint-tsgolint est construit sur le compilateur TypeScript natif (typescript-go, d'après son `README`) ; le paquet ne reprend pas le texte de licence de ce compilateur, que nous n'avons pas vérifié. Non reconstruits ici.

## Lucium DRM : Electron de castLabs et module Widevine (variante, `docs/drm.md`)

Uniquement dans la variante « Lucium DRM » (`scripts/package-drm.mjs`), jamais dans la build standard. **Les builds que le mainteneur publie sont de cette variante.**

- **Electron « for Content Security » de castLabs** (`castlabs/electron-releases`, dépôt sous licence MIT) : binaire d'Electron modifié pour charger Widevine, **non reconstruit ici** (les sources du fork ne sont pas dans ce dépôt) ; somme de contrôle comparée à `SHASUMS256.txt` de la version, à `checksums.json` du même dépôt au même tag et à la somme enregistrée dans `scripts/ecs-checksums.json` (`docs/drm.md`, section 11). Version utilisée : la stable `+wvcus` de l'Electron épinglé dans `package.json`, soit 45.2.1+wvcus à partir de la 0.2.16 (la 0.2.15 était sur la préversion 45.0.0-alpha.14+wvcus) ; `scripts/package-drm.mjs` refuse une préversion. Son archive contient `LICENSE` (Electron, MIT) et `LICENSES.chromium.html` à côté d'`Electron.app` : ce sont ces deux fichiers, et non ceux de l'Electron standard, qui vont dans la variante.
- **Module Widevine (CDM)** : propriétaire (titulaire : Google), **non distribué avec Lucium** ; installé au démarrage depuis le service de composants de son éditeur. Ses conditions sont celles de son éditeur, hors de ce dépôt.
- **Service de signature EVS de castLabs** et l'outil `castlabs-evs` 1.3.2 (Apache-2.0) : gratuit, avec un compte ; garanties « as is ». L'outil n'est ni dans le dépôt ni dans l'application. Conditions susceptibles de changer (le service a déjà été suspendu quelques jours en 2022 à la demande de Widevine).

### Un module propriétaire à côté d'un code sous GPL : les faits

Ce paragraphe décrit ce que fait le logiciel ; ce n'est pas une analyse juridique. Depuis le 11 novembre 2026, **une permission additionnelle (GPL version 3, article 7) accompagne la licence** : son texte est dans `ADDITIONAL-PERMISSION.txt` et repris dans `NOTICE`. Elle autorise à combiner Lucium avec le module Widevine et avec une build d'Electron ou de Chromium faite pour le charger, à distribuer le résultat, et à ne pas fournir les sources du module, des parties non libres de ce moteur, ni les clés et le service de signature.

1. Le module n'est **ni dans le dépôt, ni dans l'application distribuée** (ni dans l'image disque, ni dans l'archive de mise à jour).
2. Il est **téléchargé par le moteur** (le *Component Updater* de la build castLabs), sur la machine de la personne qui lance la variante, depuis le service de son éditeur. Lucium ne fait que le demander au moteur (`components.whenReady()`, `src/main/engine/widevine.ts`).
3. **Aucun code de Lucium n'est lié au module** à la construction. Le moteur le charge à l'exécution, derrière l'interface *Encrypted Media Extensions* de Chromium, celle qu'une page web utilise.
4. La build standard ne contient pas le module et ne le télécharge pas.
5. Pour que le module se charge sous le runtime durci de macOS, la variante est signée avec `disable-library-validation` sur le processus principal et deux auxiliaires (`docs/drm.md`, section 8).

**Ce qui attend une relecture** : le texte de la permission a été rédigé par le mainteneur, sur le modèle des permissions additionnelles connues ; un juriste ne l'a pas encore relu. Elle est écrite **avant la première contribution extérieure** : les contributions entrent sous GPL-3.0-or-later avec cette permission (`CONTRIBUTING.fr.md`), ce qui évite d'avoir à demander plus tard l'accord de chaque contributeur. L'identifiant SPDX reste `GPL-3.0-or-later` dans `package.json` et dans `NOTICE` : une permission propre à un projet n'a pas d'identifiant dans la liste SPDX.

## Ce qui n'a pas été vérifié

- La ligne de copyright exacte d'`electron-chrome-web-store` (année, titulaires) : le paquet npm n'en porte pas.
- **Dans une build réelle** : la présence des six textes dans `Contents/Resources` (la permission additionnelle en est un depuis le 11 novembre 2026). Le script qui les copie et les contrôle est testé sur des dossiers de test (`scripts/notices/shipped-notices.test.ts`), sans construire. Les archives castLabs 44.9.3 et 45.0.0-alpha.14 contiennent bien `LICENSE` et `LICENSES.chromium.html` ; celle de la 45.2.1+wvcus n'a pas été ouverte. La preuve se fera à la prochaine build : `package-drm.mjs` écrit la ligne « licence texts in Contents/Resources » ou s'arrête.
- Dans un `.app` empaqueté : le chargement du script de page d'`electron-chrome-web-store` depuis `app.asar.unpacked`, et la présence des fichiers de licence des paquets dans `app.asar` (par exemple `node_modules/@ghostery/adblocker/LICENSE`). Leur texte est de toute façon dans `THIRD-PARTY-NOTICES.txt`.
- Les conditions de chaque modèle utilisé par le service de génération des vidéos (MiniMax H3, Wan 3.0, GPT Image 2.6) : non lues. Celles du service l'ont été (version du 23 octobre 2026), hors de ce dépôt.
- Un avis juridique : ce document est un relevé technique des textes de licence, pas une consultation. Trois points l'attendent en particulier : le texte de la permission additionnelle (ci-dessus), le nom et le logo (`TRADEMARKS.md`, dont la sortie d'un fichier de code hors de la GPL), et les médias générés (`NOTICE-MEDIA.fr.md`).

## Traduction de page locale : Bergamot et ses modèles

Le détail (sources, tailles, intégrité) est dans `docs/traduction-locale.md`. La traduction de macOS (framework Translation d'Apple, auxiliaire `native/system-translate/`) n'apporte aucun code tiers : c'est un service du système.

| Composant | Licence relevée | Statut |
|---|---|---|
| Colle JavaScript de `bergamot-translator` (`src/main/translate/vendor/bergamot-translator.js`) | MPL-2.0 (en-tête du fichier) | **embarquée**, copiée sans modification (provenance : `docs/traduction-locale.md`, § 2.2), en-tête MPL-2.0 conservé ; insérée comme texte dans le processus principal. Code source : <https://github.com/mozilla/translations> et <https://github.com/browsermt/bergamot-translator>. Même compatibilité que pour `@ghostery/adblocker` (MPL-2.0 §3.3, aucune mention « Incompatible With Secondary Licenses ») |
| Binaire WebAssembly de `bergamot-translator` (et Marian, MIT) | MPL-2.0 (enregistrement Remote Settings du binaire) | **téléchargé sur le clic de l'utilisateur**, avec ses empreintes SHA-256, jamais embarqué ni redistribué par Lucium |
| Modèles de traduction (`firefox-translations-models`) | MPL-2.0 (fichier `LICENSE` du dépôt) | **téléchargés sur le clic de l'utilisateur**, jamais embarqués ni redistribués par Lucium ; la licence des données d'entraînement n'est pas établie |
| Code d'exécution d'Emscripten contenu dans la colle JavaScript | MIT ou University of Illinois/NCSA, au choix (licence du projet Emscripten ; non relue dans le fichier, qui ne la cite pas) | **embarqué** avec la colle, dont il fait partie (fichier généré par `build-wasm.py` du dépôt `mozilla/translations`). Le fichier ne porte que l'en-tête MPL-2.0 : aucun avis propre à Emscripten n'y figurait, donc aucun n'a été retiré |

## Médias de Lucium : origine et licence

Ce que le dépôt permet d'établir, média par média. Ce qui ne l'est pas est dit tel quel.

| Média | Fichiers | Origine | Licence |
|---|---|---|---|
| Logo « les espaces en éventail » | `scripts/logo/fan-logo.ts` (le dessin, un SVG écrit dans le code) | Dessiné pour Lucium dans ce dépôt (9 novembre 2026). Aucune image incrustée, aucun fichier d'un tiers | **Hors GPL** : Copyright © 2026 ConsilioWeb, tous droits réservés. Le logo est réservé aux builds officielles ; ce qui reste permis est dans `TRADEMARKS.md` |
| Icône de l'application et ses huit versions | `build/icon.icns`, `resources/app-icons/*.png` | Rendues depuis le dessin ci-dessus par `scripts/logo/make-icons.mjs` (`pnpm icons:logo`). Jamais retouchées à la main ; `scripts/logo/fan-logo.test.ts` compare les images au dessin | Comme le logo |
| Icônes des menus et de l'interface | `scripts/make-menu-icons.mjs` (écrit `src/main/shell/menu-icons-data.ts`), tracés SVG de `src/renderer/` | Tracés écrits dans le code ; le dépôt ne cite aucune banque d'icônes. Un commentaire de `src/renderer/Toolbar.tsx` dit que ces icônes ont la graisse et la taille des SF Symbols d'Apple, et que celle de la barre latérale en reprend la forme (`sidebar.left`) | GPL-3.0-or-later pour le code. **À faire relire** : la ressemblance voulue avec une icône d'Apple |
| Icône de l'extension de sonde | `compat/surface-probe/icon.png` (128 px) | Dessinée point par point par `scripts/probe-icon/probe-icon.ts` (`pnpm icons:probe`) : une tuile grise, un anneau et un point. Aucune image d'un tiers ; `scripts/probe-icon/probe-icon.test.ts` compare le fichier au dessin | GPL-3.0-or-later, comme le code |
| Polices | `resources/fonts/*.woff2` | Voir « Polices des Retouches » | SIL Open Font License 1.1 |
| Vidéos de fond et leurs vignettes | `resources/backgrounds/lucium-*.mp4`, `lucium-*.jpg` (9 + 9) | Générées le 6 novembre 2026 avec le service Higgsfield (abonnement payant du mainteneur) ; modèles et réglages dans `resources/backgrounds/README.md` | **Aucune licence libre** (ni GPL, ni Creative Commons). Voir ci-dessous |
| Film de présentation du site | hors dépôt (`out-film/`, non suivi ; publié sur le site) | Fabriqué par `scripts/site-film/` à partir de captures de l'application | Le film n'est pas dans le dépôt. Sa musique : voir « Musique du film » ci-dessous |

### Vidéos de fond : générées par IA, sans licence libre

Les neuf vidéos et leurs vignettes sont des sorties d'un service de génération par IA (Higgsfield, abonnement payant du mainteneur). Décision du mainteneur, le 11 novembre 2026 :

- elles restent dans le dépôt et dans l'application ;
- elles ne sont **ni sous GPL-3.0-or-later, ni sous une licence Creative Commons**, ni sous aucune autre licence libre, et le projet ne promet à personne le droit de les réutiliser ;
- la notice est à part, dans les deux langues : `NOTICE-MEDIA.fr.md` et `NOTICE-MEDIA.md` ; `NOTICE`, livré avec l'application, en porte le résumé ;
- les fichiers ne sont pas réencodés : les conditions du service interdisent de retirer les signaux de provenance d'un fichier généré.

Le mainteneur s'appuie sur les conditions du service dans leur version du 23 octobre 2026 ; leur copie est à garder par lui, hors du dépôt. Ce qui n'est pas établi : les conditions de chaque modèle (MiniMax H3, Wan 3.0, GPT Image 2.6) n'ont pas été lues. Ce qui a été lu dans les fichiers le 11 novembre 2026 : aucun relevé de provenance dans le conteneur (pas de manifeste C2PA), seulement l'étiquette de l'encodeur ffmpeg, puisque le montage du 6 novembre les a encodés ; les fichiers rendus par le service ne sont pas dans le dépôt.

### Musique du film : générée par IA

`scripts/site-film/film.mjs` accepte `--music <fichier>` et mixe ce fichier sous le film ; sans l'option, le film est muet. **Aucun fichier de musique n'est dans le dépôt.** Le mainteneur indique que la musique du film publié a été générée avec Higgsfield, comme les vidéos : elle a la même notice (`NOTICE-MEDIA.fr.md`), sans licence libre. La date de la génération, le modèle et la commande du rendu ne sont pas écrits dans le dépôt : le journal du rendu (`out-film/`, ligne « musique : … ») n'est pas suivi. Les deux sons synthétisés de l'animation viennent du code du dépôt.

## Autres textes repris

- **Code de conduite** (`CODE_OF_CONDUCT.md`) : adapté du *Contributor Covenant* 2.1, sous **CC BY 4.0** ; l'attribution et la nature de l'adaptation sont écrites à la fin du fichier.
- **Feuille et animation « Effacer les données du site »** (`src/shared/site-data-overlay.ts`, `src/renderer/SiteData.tsx`) : portées de l'extension « Clear Domain Data », **du mainteneur lui-même** (`docs/fonctions.md`). Ce n'est pas le code d'un tiers ; la licence sous laquelle l'extension est publiée de son côté n'est pas écrite dans ce dépôt.
