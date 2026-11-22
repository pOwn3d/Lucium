# Variante DRM (Widevine) : construire, signer et faire évoluer

La variante DRM est Lucium construit sur l'Electron de castLabs (« ECS », *Electron for Content Security*), le seul Electron qui sait charger le module Widevine qu'exigent les services de vidéo protégée. **Seul Netflix a été vérifié** ; Disney+ et Prime Video ne l'ont pas été. Elle se construit en local, sur un Mac Apple silicon, signée par EVS puis par un Developer ID Apple et notarisée (section 8) ; aucune version n'en est encore publiée. La build standard, sur l'Electron officiel épinglé dans `package.json`, reste la ligne principale.

## 1. Ce que fournit Electron officiel : rien

L'Electron officiel n'embarque ni le module de déchiffrement de contenu (CDM) Widevine, ni le mécanisme qui l'installe : aucun fichier « widevine » dans `Electron Framework.framework`, et le mot n'apparaît pas dans `electron.d.ts`. Le CDM est un composant propriétaire que les navigateurs basés sur Chromium téléchargent par leur *Component Updater*. Sans lui, `navigator.requestMediaKeySystemAccess('com.widevine.alpha')` échoue, et les services de vidéo protégée refusent de lire.

Le raccourci qui consiste à déclarer le module d'un autre navigateur installé (`--widevine-cdm-path`) ne marche pas sur l'Electron officiel : la page de support de Shaka répond `com.widevine.alpha: null`. Copier ce module ailleurs est en outre une zone grise de licence. Ce n'est pas une voie retenue.

## 2. L'Electron de castLabs (ECS)

Source : <https://github.com/castlabs/electron-releases> (README, wiki : `Home`, `CDM`, `EVS`, `FAQ`, `VMP`).

| Sujet | Fait |
|---|---|
| Nature | « a fork of Electron », « a drop-in replacement for stock Electron », qui active le CDM Widevine. Le dépôt `castlabs/electron-releases` ne contient pas les sources : un `README`, `install.js`, `checksums.json`, `electron.d.ts`, `vmp-resign.py` et la documentation. Les binaires sont des pièces jointes des versions. |
| Licence | MIT, comme Electron. Le CDM Widevine est propriétaire et n'est pas dans le binaire : il est installé au premier lancement. |
| Distribution | Hors du registre npm. Versions de la forme `vX.Y.Z+wvcus`, avec `checksums.json` au même tag. |
| Rythme | Un build par mois et par série soutenue : « not every Electron release gets an ECS build ». Mises à jour « best-effort », sécurité comprise. Les trois dernières séries majeures sont soutenues. |
| Plateformes | macOS et Windows complets ; Linux partiel, sans VMP. |
| CDM | Installé au premier lancement par le Component Updater ; les lancements suivants vérifient les mises à jour en arrière-plan, module installé ou non, sauf `--disable-component-update`. `components.whenReady()` force l'installation. |
| Licences persistantes | Retirées par l'éditeur de Widevine : lecture en flux seulement, pas de téléchargement hors ligne. |
| VMP (*Verified Media Path*) | Les builds ECS sont signés pour le développement (serveurs de test Widevine). La production demande la signature du service **EVS**. |
| EVS | Service gratuit, avec compte. `evs-vmp sign-pkg` sur le dossier qui contient le `.app`, après l'empaquetage et avant de zipper ; jetons à renouveler. Sur macOS, la signature VMP passe **avant** celle d'Apple. Garantie « AS IS ». En 2022, le service a été suspendu quelques jours à la demande de Widevine. |
| Fusibles | EVS ne signe que deux ensembles de fusibles : celui de castLabs par défaut, et « one additional set » (ticket [castlabs/electron-releases#152](https://github.com/castlabs/electron-releases/issues/152)). Toute autre combinaison est refusée : « Binary signature denied ». Voir la section 5. |
| macOS | L'entitlement `com.apple.security.cs.disable-library-validation` est nécessaire pour que le CDM se charge sous le runtime durci (FAQ de castLabs). Lucium le donne au processus principal et aux auxiliaires simple et « Plugin » (`Lucium Helper.app`, `Lucium Helper (Plugin).app`), pas aux auxiliaires de rendu et GPU (section 8). |

## 3. Prérequis

- Un Mac Apple silicon, Node et pnpm comme pour la build standard (`CONTRIBUTING.md`).
- **Le moteur castLabs décompressé** (le dossier qui contient `Electron.app`), dans la version stable `+wvcus` de l'Electron épinglé dans `package.json` : aujourd'hui `electron-v45.2.1+wvcus-darwin-arm64.zip`, vérifié contre `SHASUMS256.txt`, `checksums.json` et la somme enregistrée dans `scripts/ecs-checksums.json` (`node scripts/electron-upgrade.mjs 45.2.1 --steps=ecs` le télécharge et le vérifie ; section 11). Chemin : `LUCIUM_ECS_DIST`, par défaut `~/Library/Application Support/lucium-drm-tools/ecs-<version épinglée>`, soit `ecs-45.2.1`. Le script contrôle ce moteur avant de construire (« Le garde-fou du moteur », plus bas).
- **L'outil EVS** (`castlabs-evs`, Apache-2.0) dans un environnement Python isolé. Dossier de `evs-vmp` : `LUCIUM_EVS_BIN`, par défaut `~/Library/Application Support/lucium-drm-tools/evs-venv/bin`.
- **Un compte EVS** : `evs-account signup`, puis `evs-account confirm-signup` avec le code reçu par courriel. Le mot de passe se tape dans le terminal ; il ne va jamais dans un fichier du dépôt. Quand la session a expiré : `evs-account refresh`.
- Facultatif : une identité **Developer ID Application** dans le trousseau (section 8), un profil d'approvisionnement pour Touch ID (`LUCIUM_KEYCHAIN_PROFILE`), un profil de notarisation (`LUCIUM_NOTARY_PROFILE`).

Sans signature EVS, la build démarre et Widevine s'installe, mais les licences sont refusées : `PLATFORM_TAMPERED` sur le serveur d'essai, `LICENSE_REQUEST_FAILED` en production. La signature VMP de castLabs ne vaut plus une fois l'application renommée et ses fusibles changés.

### Le garde-fou du moteur

La 0.2.15 a été distribuée sur une préversion, `45.0.0-alpha.14+wvcus` (Chromium 156.0.8077.0), alors que `package.json` épinglait Electron 45.2.1 : le script se contentait d'un avertissement. Depuis la 0.2.16, `scripts/package-drm.mjs` lit le fichier `version` du moteur et s'arrête avant de construire quoi que ce soit (règle dans `src/main/drm-engine-guard.ts`, testée dans `src/main/drm-engine-guard.test.ts`) :

| Moteur présenté | Réponse |
|---|---|
| Une préversion (`-alpha`, `-beta`, `-nightly`) | Refusé, toujours. Aucune option, aucune exception ne l'autorise. |
| Une version sans le marqueur `+wvcus` | Refusé, toujours : ce n'est pas l'Electron de castLabs avec Widevine. |
| Une version stable `+wvcus` autre que l'Electron épinglé | Refusé, sauf exception écrite (ci-dessous). |
| La version stable `+wvcus` de l'Electron épinglé | Accepté. |

`scripts/build-drm-release.sh` et `scripts/electron-upgrade.mjs` passent par ce script : ils héritent du contrôle et n'ont pas d'option pour le lever.

**L'exception** sert à un seul cas : `package.json` est monté à une version que castLabs n'a pas encore publiée, et la variante doit sortir quand même sur la stable précédente. Elle s'écrit dans un seul fichier, `build/drm-engine-exception.json`, absent en temps normal :

```json
{
  "engine": "45.2.1",
  "pinned": "45.2.3",
  "reason": "castLabs n'a pas encore publié 45.2.3+wvcus ; 45.2.1+wvcus est sa dernière stable de la ligne 45."
}
```

- `engine` : la version castLabs à utiliser, stable et écrite en entier, sans le marqueur. Seule cette version est alors acceptée.
- `pinned` : l'Electron épinglé au moment où l'exception est écrite. Dès que `package.json` change de version, l'exception ne vaut plus et la build s'arrête : on la récrit ou on supprime le fichier.
- `reason` : la raison, en 30 caractères au moins.

Un fichier présent mais faux (JSON illisible, champ manquant, préversion, raison vide) arrête la build : il n'est jamais lu comme « pas d'exception ». Quand une exception sert, le script l'écrit dans le journal de la build avec sa raison. Le fichier est suivi par Git : l'écart se voit dans l'historique et se relit avant une publication.

## 4. Construire et installer

La commande habituelle est `scripts/build-drm-release.sh` (ou `pnpm build:drm`). Elle construit, signe, vérifie, puis installe `/Applications/Lucium.app` à la place de l'application normale, seulement si Lucium ne tourne pas (jamais de force). L'application précédente est rangée dans `~/Library/Application Support/lucium-app-backups/<date>/`. Le script garde les 3 copies les plus récentes et supprime les plus anciennes (`scripts/prune-app-backups.sh`) ; `LUCIUM_APP_BACKUPS_KEEP=<nombre>` change ce nombre.

| Option | Effet |
|---|---|
| (aucune) | Fusibles de l'ensemble castLabs (`--castlabs-fuses`), signature EVS, signature Developer ID si le trousseau en a une, vérifications, installation. |
| `--no-install` | La même chose, mais s'arrête avant `/Applications` : la build reste dans `dist-drm/mac-arm64/Lucium.app`. |
| `--notarize` | Envoie aussi l'application signée au service de notarisation d'Apple, agrafe le ticket, vérifie, et écrit `dist-drm/Lucium-<version>-arm64.zip`, le fichier à distribuer. Demande une identité Developer ID et `LUCIUM_NOTARY_PROFILE`. |
| `--original-fuses` | Les fusibles de castLabs laissés ouverts (`package-drm.mjs --no-fuses`) : le retour arrière, avec la restauration du profil (section 6). **Signée ad hoc, pour ce Mac seulement** : refusée avec `LUCIUM_SIGN_IDENTITY` ou `--notarize`, et aucune identité Developer ID n'est cherchée dans le trousseau. Signée par l'équipe sous l'identifiant de production, une build aux fusibles `RunAsNode`, `NODE_OPTIONS` et inspecteur ouverts serait installée par Squirrel depuis tout flux qui la nomme. |
| `--update-feed <adresse https>` | Grave dans l'application l'adresse du fichier de versions (`MAIN_VITE_UPDATE_FEED`, écrite par electron-vite dans `app.asar`, contrôlée après la build) : la vérification automatique (20 s après le lancement, puis une fois par jour) et « Rechercher les mises à jour… » la lisent ; l'installation depuis elle ne part que du clic de l'utilisateur (section 12). Demande une identité Developer ID ; refusée avec `--original-fuses`. C'est le canal **stable**, celui qu'une build suit par défaut. |
| `--test-feed <adresse https>` | Grave une seconde adresse, celle du canal **de test** (`MAIN_VITE_UPDATE_FEED_TEST`, contrôlée dans `app.asar` comme la première). Mêmes règles que `--update-feed`, dont elle dépend : refusée sans `--update-feed`, avec `--original-fuses` ou sans identité Developer ID. Une build qui la porte affiche « Recevoir les versions de test » (Réglages › À propos et mises à jour, dans « Plus de réglages ») ; sans elle, ce réglage n'apparaît pas (section 12). |

Les options se combinent, sauf `--update-feed`, `--test-feed` et `--notarize` avec `--original-fuses`. Exemple complet, avec Touch ID et notarisation :

```sh
LUCIUM_KEYCHAIN_PROFILE=/chemin/vers/le-profil-du-trousseau.provisionprofile \
LUCIUM_NOTARY_PROFILE=<nom du profil notarytool> \
scripts/build-drm-release.sh --notarize
```

Le script appelle `scripts/package-drm.mjs`, qu'on peut aussi lancer seul :

| Option de `package-drm.mjs` | Effet |
|---|---|
| (aucune) | Construit l'application, sans signature : `dist-drm/mac-arm64/Lucium DRM.app`, identifiant `app.lucium.browser.drm`, à côté de l'application normale. |
| `--vmp` | Signe par EVS, puis `evs-vmp verify-pkg`. |
| `--apple` | Signe ensuite avec l'identité Developer ID de `LUCIUM_SIGN_IDENTITY` (section 8). |
| `--as-lucium` | Construit sous le nom et l'identifiant de l'application normale (`Lucium.app`, `app.lucium.browser`), pour l'installer à sa place. macOS accorde le réseau local par identifiant : une build sous un autre identifiant le perd. |
| `--castlabs-fuses` | Écrit l'ensemble de fusibles de castLabs (section 5) et le contrôle avant EVS. |
| `--no-fuses` | Garde les fusibles du binaire castLabs, ouverts. Jamais avec `--apple`. |
| `--timestamp-required` | Avec `--apple` : s'arrête à la première pièce que le serveur d'horodatage d'Apple ne date pas, au lieu de signer sans horodatage. `build-drm-release.sh --notarize` le passe : Apple ne notarise rien sans horodatage. |
| `--fuse-trial <fusible>` | Une copie d'essai (section 5). |

`--castlabs-fuses` est refusé avec `--no-fuses` ou `--fuse-trial`, et `--fuse-trial` avec `--as-lucium`. `--apple` est refusé avec `--no-fuses`, et avec `--as-lucium` sans `--castlabs-fuses` : l'identité Developer ID ne signe jamais les fusibles de castLabs laissés ouverts.

Les auxiliaires natifs sont construits au début de `package-drm.mjs` et copiés avant la signature EVS (qui ne lit que le framework Electron) : `LuciumKeychain.xpc` dans `Contents/XPCServices/` (`native/vault-keychain/`, le service XPC du Touch ID du coffre de mots de passe), son module `vault-xpc.node` dans `Contents/Resources/` (`native/vault-xpc/`, hors de `app.asar`), et l'auxiliaire de traduction du système dans `Contents/Helpers/` (`native/system-translate/`, macOS 26 et plus).

## 5. Fusibles : l'ensemble castLabs

EVS calcule son empreinte sur le code du framework : changer un seul fusible change un octet, et le service refuse le binaire, sauf pour l'ensemble que castLabs accepte. La variante DRM utilise cet ensemble (`CASTLABS_SIGNED_SET` de `src/main/drm-fuse-trial.ts`) :

| Fusible | Ensemble castLabs (variante DRM) | castLabs par défaut | Build standard (`electron-builder.yml`) |
|---|---|---|---|
| `RunAsNode` | off | on | off |
| `EnableCookieEncryption` | **on** | off | on |
| `EnableNodeOptionsEnvironmentVariable` | off | on | off |
| `EnableNodeCliInspectArguments` | off | on | off |
| `EnableEmbeddedAsarIntegrityValidation` | on | off | on |
| `OnlyLoadAppFromAsar` | on | off | on |
| `LoadBrowserProcessSpecificV8Snapshot` | off | off | défaut (off) |
| `GrantFileProtocolExtraPrivileges` | on | on | défaut (on) |

Les autres fusibles gardent la valeur de castLabs, y compris la neuvième position, que `@electron/fuses` 1.8.0 ne nomme pas. Les deux applications ont donc exactement le même ensemble (test `drm-fuse-trial.test.ts`) : elles ouvrent le même profil, et la build standard doit relire les cookies que la variante DRM a chiffrés.

**`GrantFileProtocolExtraPrivileges` reste ouvert** (5 novembre 2026), et ne peut pas être fermé :

- **EVS l'exige ouvert.** L'ensemble que castLabs signe porte `GrantFileProtocolExtraPrivileges=on` (ticket #152, message du 9 juillet 2025 ; FAQ du wiki relue le 5 novembre 2026 : « `[FuseV1Options.GrantFileProtocolExtraPrivileges]: true` », aucun autre ensemble). Le fermer, c'est « Binary signature denied », donc plus de Netflix.
- **L'interface en dépend.** Elle est chargée par `loadFile` depuis `app.asar` (`load` de `src/main/index.ts`). Dans le code d'Electron 45.2.1 (`shell/browser/protocol_registry.cc`), c'est ce fusible qui installe le lecteur d'archive pour les adresses `file://` (`AsarURLLoaderFactory`) : fermé, les pages de l'interface, rangées dans `app.asar`, ne se chargent plus. Il donne aussi à tout document `file://` l'accès aux autres fichiers et l'accès universel (`allow_file_access_from_file_urls`, `allow_universal_access_from_file_urls`, `shell/browser/electron_browser_client.cc`), et le `fetch` sur `file:` (`shell/renderer/renderer_client_base.cc`). Que les scripts module des pages construites en aient besoin est déduit, non essayé.

Ce que le fusible donne aux documents `file://`, Lucium le reprend aux onglets : le crochet `onBeforeRequest` de chaque session de pages refuse qu'une page locale lise un autre fichier, et les crochets d'en-têtes de la session lui refusent la réponse d'un site qui ne la partage pas (`src/main/engine/local-file-guard.ts`, règles dans `docs/architecture.md`, section « Sécurité »). Electron 45.2.1 fait passer les requêtes `file://` par ce crochet : c'est son propre test « webRequest.onBeforeRequest works with file:// protocol » (`spec/api-web-request.spec.ts`). La variante castLabs n'a pas été lue sur ce point ; le test moteur le vérifie dans l'application construite (ci-dessous).

**Fusibles, profil et cookies.** Rien ne change dans les fusibles : la build standard et la variante DRM gardent l'ensemble castLabs, et une mise à jour de l'une à l'autre version aussi. Le chiffrement des cookies est **un autre fusible** (`EnableCookieEncryption`, section 6), inchangé et toujours activé : ni les cookies ni le profil ne deviennent illisibles.

**À vérifier sur la prochaine build**, avant la publication, puis après la mise à jour par Squirrel :

1. Les fusibles : `pnpm fuses:read /Applications/Lucium.app` montre l'ensemble castLabs, `GrantFileProtocolExtraPrivileges` **Enabled** ; `evs-vmp verify-pkg` passe ; Netflix lit 30 s. `pnpm fuses:read` lit le binaire avec le code du dépôt et ne télécharge rien. Ne pas utiliser `npx @electron/fuses read` : `npx` télécharge et exécute la dernière version du paquet, hors de `pnpm-lock.yaml`, sur le Mac qui signe.
2. L'interface s'affiche : barre latérale, barre de commandes, Réglages, À propos, Extensions.
3. Le test moteur, avant la build : `LUCIUM_SMOKE_ONLY=runtime pnpm test:engine` (cas « local file » de `src/main/smoke-runtime.ts` : un `fetch` et un cadre vers un autre fichier sont refusés, l'image voisine s'affiche).
4. À la main, dans la build installée : un fichier HTML d'un dossier à lui (`~/Sites/essai/index.html` avec `style.css` et `img/logo.png`) s'affiche avec son style et son image ; dans sa console, `fetch('file:///etc/hosts')` échoue ; une page enregistrée « Page web, complète » dans Téléchargements s'affiche avec son dossier `_files` ; un PDF local s'ouvre, défile et zoome.
5. Après la mise à jour : les points 1, 2 et 4 de nouveau, et le profil (un site où l'on est connecté le reste, aucune demande d'accès au trousseau).

**Contrôles avant EVS** (`--castlabs-fuses` et `--fuse-trial`) : les fusibles sont relus avec le `@electron/fuses` d'electron-builder et comparés position par position à l'`Electron.app` de castLabs ; seules les positions écrites doivent avoir changé. Avec les deux fusibles de l'archive fermés, le script vérifie aussi que `Resources/app.asar` existe et que l'empreinte SHA-256 de son en-tête est celle d'`ElectronAsarIntegrity` dans l'`Info.plist` (electron-builder l'écrit quels que soient les fusibles). Sans identité Developer ID, la build est signée de nouveau ad hoc juste après le changement des fusibles, avant EVS ; sinon macOS la tuerait au lancement (sortie 137).

### Essais des fusibles (`--fuse-trial`)

`--fuse-trial <fusible>` fabrique une copie d'essai : les fusibles de castLabs, sauf celui essayé, fermé à la valeur d'`electron-builder.yml`. `<fusible>` vaut `runAsNode`, `enableNodeOptionsEnvironmentVariable`, `enableNodeCliInspectArguments`, `onlyLoadAppFromAsar`, `enableEmbeddedAsarIntegrityValidation`, ou `castlabs-set` (l'ensemble complet).

```sh
LUCIUM_SIGN_IDENTITY="Developer ID Application: …" node scripts/package-drm.mjs --fuse-trial <fusible> --vmp --apple
```

- Emplacement : `dist-drm-trial/<fusible>/mac-arm64/Lucium essai <fusible>.app`, ignoré par Git. Le script n'écrit jamais dans `/Applications`.
- Identité : identifiant `app.lucium.browser.drm.trial.<fusible en minuscules>` et nom interne `lucium-essai-<fusible en minuscules>`, donc un dossier de données à part (`~/Library/Application Support/lucium-essai-<fusible>`), un verrou d'instance à part et un élément Touch ID à part : une copie ne lit pas le profil réel et n'y écrit pas.
- Cache EVS à part (`dist-drm-trial/<fusible>/evs-cache.json`) : le cache de l'outil ne garde que 16 signatures, et un essai ne doit pas chasser celle de la build installée.

Résultat sur castLabs 45.0.0-alpha.14+wvcus avec castlabs-evs 1.3.2 : chacun des cinq fusibles fermé seul est refusé (`400 Bad Request`, puis `ValidityError: Binary signature denied`) ; l'ensemble `castlabs-set` est accepté, et Netflix y lit. **À refaire sur `45.2.1+wvcus`** avant la première build publiée sur ce moteur : rien ne garantit qu'EVS signe le même ensemble d'une version à l'autre (`node scripts/package-drm.mjs --vmp --fuse-trial castlabs-set`).

## 6. Chiffrement des cookies : un passage à sens unique

Avec `EnableCookieEncryption`, Chromium chiffre les cookies avec une clé rangée dans le trousseau (« Lucium Safe Storage » ; macOS peut demander l'accès au trousseau). D'après la documentation d'Electron (« Fuses »), c'est à sens unique : les cookies existants sont chiffrés quand ils sont réécrits, et une build sans le fusible trouve ensuite une base de cookies inutilisable. `build-drm-release.sh` le rappelle avant l'installation ; il ne fait pas de sauvegarde et ne lit pas le profil.

**Sauvegarde recommandée** avant le premier lancement d'une build qui change les fusibles, Lucium fermé :

```sh
ditto "$HOME/Library/Application Support/Lucium" "$HOME/Library/Application Support/lucium-profile-backups/$(date +%Y%m%d-%H%M%S)"
```

Le dossier de données s'écrit `Lucium` (Electron le nomme d'après le `productName` de `package.json`). macOS ne distingue pas la casse sur un volume APFS ordinaire : `~/Library/Application Support/lucium` désigne le même dossier.

**Retour arrière**, Lucium fermé, les deux étapes :

1. Mettre le profil chiffré de côté, sans l'effacer, puis recopier la sauvegarde à sa place :

   ```sh
   mv "$HOME/Library/Application Support/Lucium" "$HOME/Library/Application Support/lucium-cookies-chiffres-$(date +%Y%m%d-%H%M%S)"
   ditto "$HOME/Library/Application Support/lucium-profile-backups/<date de la sauvegarde>" "$HOME/Library/Application Support/Lucium"
   ```

2. Reconstruire et installer la build aux fusibles ouverts : `scripts/build-drm-release.sh --original-fuses`. Elle est signée ad hoc : macOS peut redemander les autorisations et l'accès au trousseau, et Touch ID n'est plus disponible (l'auxiliaire du trousseau refuse une application signée ad hoc).

L'une sans l'autre ne suffit pas : la sauvegarde seule serait chiffrée de nouveau au lancement suivant, et la build aux fusibles ouverts seule ne lirait plus les cookies chiffrés. Ce qui a changé dans le profil depuis la sauvegarde est perdu. Les fusibles `RunAsNode`, `NODE_OPTIONS` et l'inspecteur sont alors de nouveau ouverts dans la variante.

**Développement.** `pnpm dev` et `pnpm start` ouvrent le profil réel. La copie d'Electron que fait `scripts/dev-electron.mjs` (dossier `.dev-electron/`) active aussi `EnableCookieEncryption` avant sa signature ad hoc : elle relit et écrit les cookies chiffrés comme la build installée. Les autres fusibles de l'ensemble ne sont pas appliqués au développement (`onlyLoadAppFromAsar` empêcherait electron-vite de servir l'application). Au premier lancement, macOS peut demander l'accès au trousseau pour cette copie (signature différente) : répondez **« Autoriser »**, jamais **« Toujours autoriser »**. La copie est signée ad hoc et ses fusibles `RunAsNode`, `NODE_OPTIONS` et inspecteur sont ouverts : inscrite dans la liste d'accès de la clé des cookies (« Lucium Safe Storage »), elle donnerait cette clé sans question à tout programme local qui la lance comme un interpréteur Node. Pour essayer une modification risquée, donner un profil de test après `--` : `pnpm dev -- --user-data-dir="$(mktemp -d)"`.

## 7. Connexions réseau de la variante : module Widevine

- **Module Widevine et Component Updater** : la seule connexion de la variante que personne n'a demandée au moment où elle part. Elle n'existe pas sur la build standard, qui n'a ni module `components` ni Component Updater.
  - **Quand.** Au premier lancement d'un profil, la vérification part tout de suite : mesuré, la requête sort à 0,5 s, le module se télécharge à 0,9 s, le compte rendu part à 2,6 s, puis une vérification vers 60 s. Aux lancements suivants, module installé, rien au démarrage : une seule vérification, vers 60 s (mesuré). Le code : `src/main/index.ts` appelle `installWidevine` dès `app.whenReady()`, et `src/main/engine/widevine.ts` demande le module (`components.whenReady()`). Le journal écrit à chaque lancement `[widevine] asking Google’s component updater for the module (DRM build only)`. Ensuite, le Component Updater vérifie sur sa propre minuterie tant que l'application est ouverte, module installé ou non (documentation de castLabs, section 2) ; la période de cette minuterie n'est pas mesurée. Un test moteur (`--smoke`) ne l'appelle pas.
  - **Vers qui.** Le service de mise à jour des composants de Google, celui de tout navigateur basé sur Chromium : `update.googleapis.com` (mesuré : `POST https://update.googleapis.com/service/update2/json`). Aucune ligne de ce dépôt ne fixe cette adresse. Le module, lui, est téléchargé depuis `edgedl.me.gvt1.com` en **HTTP simple** (port 80, mesuré).
  - **Pourquoi.** Le module Widevine n'est ni dans ce dépôt, ni dans l'image disque, ni dans l'archive de mise à jour (section 11 bis) : le moteur le télécharge au premier lancement, puis à chaque nouvelle version du module. Sans lui, les services de vidéo protégée refusent de lire.
  - **Ce qui part.** La requête est écrite par le moteur, pas par Lucium, et aucune ligne de ce dépôt n'en choisit le contenu. Mesuré le 17 novembre 2026 (1.1.2, Electron 45.2.1, Chromium 156, profil vide, journal réseau en octets clairs ; `--disable-quic` au second lancement pour que les corps restent lisibles) :
    - **Premier lancement, 687 octets** : un `POST` en JSON (protocole Omaha 4.0), sans cookie, avec les paramètres de signature CUP (`cup2key`, `cup2hreq`). Il ne nomme qu'**un seul composant**, Widevine (identifiant `oimompecagnajdejgnnjijobebaeigek`, sans version installée). Il contient la langue (`fr`), le système (`Mac OS X` et sa version), le processeur (`arm64`), la version de Chromium, la mémoire en gigaoctets, des indicateurs du processeur (AVX, SSE) et deux identifiants aléatoires, `requestid` et `sessionid`.
    - **Compte rendu, 1 415 octets**, à 2,6 s : le téléchargement (durée, taille, adresse) et l'installation (version, cohorte, date d'installation).
    - **Vérification suivante, 878 octets**, vers 60 s : la version installée, la cohorte, la date d'installation, le jour de la vérification précédente (`rd`) et le nombre aléatoire gardé dans `Local State` (`ping_freshness`), remplacé après chaque vérification.
    - Aucun autre hôte Google ni autre composant n'apparaît dans ces lancements. Le serveur voit l'adresse IP.
  - **Ce qui reste sur le disque.** Le moteur garde l'état de ce protocole dans le fichier `Local State` du dossier de données, sous `updateclientdata`, pour le composant Widevine : relevé le 10 novembre 2026 dans un profil de la variante (noms des clés seulement, valeurs non lues), les clés `cohort`, `cohortname`, `dlrc` (jour de la dernière vérification), `installdate` et `pf` (le nombre aléatoire). Le module est dans `WidevineCdm/`, son paquet dans `component_crx_cache/`.
  - **À mesurer.** Ce qui n'a pas été mesuré : la période de la minuterie après la vérification vers 60 s (seules les 180 premières secondes de deux lancements ont été observées) ; le contrôle d'intégrité du paquet du module, téléchargé en HTTP simple ; ce que le premier film protégé ajoute ; ce que devient un module déjà installé quand `--disable-component-update` est posé. Ce qui est écrit sous « Ce qui part » est relevé, pas déduit du protocole.
  - **Aucun réglage ne la coupe aujourd'hui.** Demander le module au premier film ne supprimerait pas la connexion, puisque le Component Updater vérifie de lui-même ; cela ferait seulement échouer le premier film pendant le téléchargement. Seul `--disable-component-update`, posé avant `app.ready`, arrête ce service (documentation de castLabs), et rien dans Lucium ne le pose. Un interrupteur honnête serait un réglage « Contenus protégés » lu avant `app.ready`, pris en compte au lancement suivant, qui pose ce commutateur et n'appelle pas `components.whenReady()` ; éteint, les services de vidéo protégée ne liraient plus sur un profil sans module. Ce que deviendrait un module déjà installé est à mesurer.
- **IPv6 : aucun réglage propre à la variante.** Jusqu'à la 0.2.15, `src/main/index.ts` posait le commutateur `--disable-ipv6` dans la variante seulement, pour les hôtes `.local` d'un réseau domestique (par exemple Home Assistant, « Ce site ne répond pas », `ERR_ADDRESS_UNREACHABLE`), et cette page en déduisait qu'un site qui ne répond qu'en IPv6 ne s'y chargeait pas. Ce commutateur n'existe plus dans Chromium : relevé le 10 novembre 2026, son nom est absent du binaire `Electron Framework` 45.2.1 standard et de celui de la variante installée (45.2.1+wvcus), alors que `disable-quic` et `host-resolver-rules` y figurent. Il ne changeait donc rien, et il est retiré ; `src/main/chromium-switches.test.ts` refuse désormais un commutateur que le moteur ne lit pas. Le même changement avait ajouté la clé `NSLocalNetworkUsageDescription` (section 8), qui est l'explication la plus probable du retour des hôtes `.local`. **À mesurer** dans la variante installée : un hôte `.local` qui a une adresse IPv6, et un site qui ne répond qu'en IPv6.

## 8. Signature Developer ID de la variante DRM

**Ordre, toujours le même** : construction castLabs, contrôle des fusibles, signature EVS (`evs-vmp sign-pkg`, puis `verify-pkg`), signature Developer ID, vérifications, notarisation (avec `--notarize`), installation. La signature EVS vient toujours avant celle d'Apple : elle ajoute `Electron Framework.sig` dans le framework, ce qui casserait le sceau d'une signature Apple déjà posée.

**Identité** : la valeur de `LUCIUM_SIGN_IDENTITY` si la variable est définie ; elle doit figurer dans `security find-identity -v -p codesigning` par son nom entier (une partie de nom est refusée), sinon le script s'arrête avant la construction. Il s'arrête aussi quand `node_modules` porte la marque de npm (`node_modules/.package-lock.json`) : les outils de la build sont ceux de `pnpm-lock.yaml`, à réinstaller avec `rm -rf node_modules && pnpm install --frozen-lockfile`. Sans variable, le script prend la première « Developer ID Application » de cette liste. Seul le nom de l'identité passe par les scripts ; la clé reste dans le trousseau. Sans identité, la build garde une signature ad hoc et le script le dit : elle lit Netflix sur le Mac où elle est construite, mais ne peut pas être notarisée, et Gatekeeper la refuse sur un autre Mac.

**Signature pièce par pièce, sans `--deep`** : `codesign --force --options runtime --timestamp --entitlements <fichier de la pièce>` (le fichier dépend de la pièce, voir « Entitlements » ci-dessous), dans l'ordre de `src/main/mac-sign-order.ts` : chaque fichier Mach-O (y compris `koffi.node` dans `app.asar.unpacked`, hors des emplacements que `--deep` parcourt) et chaque `.app` ou `.framework` imbriqué, du plus profond au moins profond, puis l'application. Sans réponse du serveur d'horodatage d'Apple, les pièces restantes sont signées sans horodatage ; la notarisation demandera alors de relancer.

**Auxiliaire du trousseau (Touch ID)** : le service XPC `LuciumKeychain.xpc` est signé par `native/vault-keychain/build.sh` avec l'identité Developer ID, ses propres entitlements (groupe d'accès `<ÉQUIPE>.app.lucium.browser.vault`) et son profil d'approvisionnement : `LUCIUM_KEYCHAIN_PROFILE` (chemin du profil Developer ID fait pour l'App ID `<ÉQUIPE>.app.lucium.browser.keychain`) et `LUCIUM_TEAM_ID` (facultative, lue sinon dans l'identité). La signature de l'application le laisse de côté, d'où l'absence de `--deep`, qui l'aurait signé de nouveau avec les entitlements de l'application. Le profil est intégré au service (`Contents/XPCServices/LuciumKeychain.xpc/Contents/embedded.provisionprofile`) : un service XPC est un paquet de type application, où macOS cherche ce profil. Sans profil, l'auxiliaire est signé sans les entitlements du trousseau, et Lucium dit « Touch ID indisponible » ; `package-drm.mjs` s'arrête si le service a ces entitlements sans son profil. Sans `--apple`, il est signé ad hoc. Le module `vault-xpc.node` est l'une des pièces que signe le Developer ID de l'application : `package-drm.mjs` vérifie que le module et le service sont signés par la même équipe que l'application (sans quoi Touch ID serait refusé : le groupe d'accès du trousseau est celui de l'équipe). L'auxiliaire de traduction est signé avec le runtime durci et sans entitlement.

**Vérifications**, faites par `package-drm.mjs` sur le paquet final ; un échec arrête tout avant l'installation :

1. `codesign --verify --deep --strict --verbose=2` (`--deep` ne sert ici qu'à vérifier).
2. L'auxiliaire du trousseau a gardé sa signature (même `CDHash` avant et après la signature de l'application) ; le script dit s'il porte les entitlements du trousseau.
3. Les entitlements de chaque pièce signée, relus dans sa signature (`codesign -d --entitlements - --xml`) : exactement les clés du fichier que `entitlementsFor` lui donne (aucune pour une bibliothèque, un framework, le gestionnaire de plantages ou le programme de mise à jour), donc `disable-library-validation` dans le processus principal et les auxiliaires simple et « Plugin », jamais dans les auxiliaires de rendu et GPU, et un seul auxiliaire « Plugin » (reconnu à son nom). Une clé en plus ou en moins arrête le script.
4. `evs-vmp verify-pkg` relancé : la signature VMP a survécu à celle d'Apple.

Sans Developer ID, seuls `verify-pkg` et `codesign --verify --strict` sur l'auxiliaire du trousseau sont lancés : la signature ad hoc du binaire castLabs ne scelle pas les ressources, et `codesign --strict` échoue dessus (« code has no resources but signature indicates they must be present »).

**Entitlements, pièce par pièce** : un fichier par rôle, choisi par `entitlementsFor` (`src/main/mac-sign-order.ts`), le même principe que la signature de Chromium et que les réglages par défaut de `@electron/osx-sign` (qui citent les fichiers `helper-*-entitlements.plist` de Chromium) : les processus qui exécutent les pages ne reçoivent que le strict nécessaire. Avant ce découpage, un seul fichier allait à toutes les pièces, donc aussi aux moteurs de rendu et au GPU. Le premier découpage n'ouvrait les deux clés de Widevine que dans l'auxiliaire « Plugin » : sur la build notariée, Netflix a alors refusé de lire (erreur M7702-1003, le 8 novembre 2026), sans qu'aucun processus du CDM ne démarre. Le découpage actuel rend les deux clés au processus principal et à l'auxiliaire simple, et garde la restriction là où elle ne touche pas la lecture : les moteurs de rendu et le GPU.

| Pièce | Fichier | Entitlements |
|---|---|---|
| `Lucium.app` (processus principal), `Lucium Helper.app` (processus utilitaires : réseau, audio, Node) et `Lucium Helper (Plugin).app` (le module Widevine) | `build/entitlements.drm.mac.plist` | exactement six clés : `allow-jit`, `allow-unsigned-executable-memory`, `disable-library-validation`, `device.camera`, `device.audio-input`, `personal-information.location` |
| `Lucium Helper (Renderer).app`, `Lucium Helper (GPU).app` | `build/entitlements.drm.helper.mac.plist` | `allow-jit` seulement : la validation des bibliothèques reste active, sans mémoire exécutable non signée |
| Frameworks, bibliothèques, `koffi.node`, `vault-xpc.node`, `chrome_crashpad_handler`, `ShipIt` | aucun | aucun (un entitlement n'est pas lu dans une bibliothèque ; les exécutables n'en ont pas l'usage) |
| `LuciumKeychain.xpc` | ses propres entitlements (`native/vault-keychain/`), signé par son `build.sh` | groupe d'accès du trousseau, autorisé par son profil |
| `LuciumTranslate.app` | signé par son `build.sh` | aucun |

La build normale (`pnpm package:signed`, electron-builder) n'a pas le module Widevine : aucune pièce n'a besoin des deux clés de Widevine, et `build/entitlements.mac.plist` (sans elles : `allow-jit` et les trois accès aux appareils) va à toutes les pièces, electron-builder n'acceptant qu'un fichier pour toutes les pièces imbriquées. La variante DRM ne s'en sert plus : son fichier reprend ces quatre clés et y ajoute les deux de Widevine. Un auxiliaire de Electron dont le nom n'est pas connu de `entitlementsFor` arrête la signature : ses entitlements se décident exprès, ils ne sont pas ceux de l'application par défaut. `src/main/drm-packaging-files.test.ts` et `src/main/mac-sign-order.test.ts` échouent si un auxiliaire de rendu ou GPU reçoit l'une des deux clés, si le processus principal ou un auxiliaire simple ou « Plugin » n'a pas le fichier de la variante DRM (exactement ses six clés), si un autre fichier de `build/`, celui de la build normale compris, en gagne une, ou si `package-drm.mjs` ne compte plus exactement un auxiliaire « Plugin ».

| Entitlement | Pourquoi, et pour qui |
|---|---|
| `com.apple.security.cs.allow-jit` | V8 compile JavaScript et WebAssembly en mémoire exécutable : le processus principal (et `koffi.node`, qui y alloue des trampolines), les utilitaires, les moteurs de rendu et le GPU. Sans lui, le runtime durci bloque les pages. Dans tous les fichiers de la variante DRM. |
| `com.apple.security.cs.allow-unsigned-executable-memory` | Le processus principal et les auxiliaires simple et « Plugin » : ils manipulent du code natif tiers, le module Widevine, que Chromium ne marque pas pour le JIT. Pas les moteurs de rendu ni le GPU. |
| `com.apple.security.cs.disable-library-validation` | Le processus principal et les auxiliaires simple et « Plugin » : le module Widevine est signé par son éditeur, pas par l'équipe de Lucium, et sans cet entitlement il ne se charge pas (castLabs, FAQ : « Library validation must be disabled with an entitlement for the Widevine CDM to load »). Pas les moteurs de rendu ni le GPU. |
| `com.apple.security.device.camera` | Processus principal et auxiliaire simple (l'auxiliaire « Plugin » les reçoit avec le même fichier, sans en avoir l'usage) : avec le runtime durci, macOS ne pose la question de la caméra à une page que si l'application a cet entitlement. |
| `com.apple.security.device.audio-input` | Même chose pour le micro. |
| `com.apple.security.personal-information.location` | Même chose pour la position (`navigator.geolocation`). |

**Pourquoi la validation des bibliothèques est désactivée dans le processus principal, et pas seulement dans l'auxiliaire « Plugin »** : le 8 novembre 2026, la build notariée dont seul l'auxiliaire « Plugin » avait `disable-library-validation` (et `allow-unsigned-executable-memory`) n'a pas lu Netflix : erreur M7702-1003, sans qu'aucun processus du CDM ne soit lancé. L'explication retenue : le module Widevine est installé par le Component Updater et enregistré par le processus principal, qui doit donc pouvoir charger du code signé par un autre éditeur ; l'auxiliaire « Plugin » seul ne suffit pas. Ce n'est pas relu dans le code de Chromium : seule la lecture réelle de Netflix sur la build signée avec ce jeu de clés le confirme (section 9). L'auxiliaire simple (`Lucium Helper.app`, qui héberge les processus utilitaires) reçoit le même fichier que le processus principal, comme avant le découpage.

**Ce qui reste restreint** : les auxiliaires de rendu et GPU, qui exécutent les pages et le graphique, gardent la validation des bibliothèques et n'ont ni `disable-library-validation` ni `allow-unsigned-executable-memory` : c'est la part du découpage par rôle qui reste, et la plus exposée au contenu web. En contrepartie, le processus principal accepte maintenant toute bibliothèque signée par un autre éditeur ; `package-drm.mjs` continue de vérifier que `vault-xpc.node` et le service du trousseau sont signés par l'équipe de l'application (Touch ID l'exige), et relit les entitlements de chaque pièce après la signature. Ce jeu de six clés est celui d'avant le découpage par rôle : si Netflix ne lisait plus avec lui, la cause est à chercher hors des entitlements (fusibles, section 5 ; signature VMP, étape 4 ci-dessus).

**Ce qui ne passe pas par un entitlement** : le réseau local (clé `NSLocalNetworkUsageDescription` de l'`Info.plist`, dans `electron-builder.yml`, contrôlée par `package-drm.mjs`) ; le Bluetooth (clé `NSBluetoothAlwaysUsageDescription`, fournie par Electron ; `com.apple.security.device.bluetooth` est une clé du bac à sable, que Lucium n'utilise pas) ; l'enregistrement de l'écran, l'accessibilité et l'accès complet au disque, accordés par l'utilisateur. L'entitlement des passkeys de navigateur (`com.apple.developer.web-browser.public-key-credential`) n'est pas ajouté : Apple l'accorde sur demande, et un entitlement restreint qu'aucun profil n'autorise empêche l'application de se lancer. Les passkeys du Mac marchent sans lui dans la 1.0.0 essayée (mesure du 11 novembre 2026, [`cles-d-acces.md`](cles-d-acces.md)) : la demande est suspendue.

**macOS peut redemander les autorisations.** En passant d'une signature ad hoc à Developer ID, l'identité de l'application change pour macOS : son exigence de signature passe d'une empreinte du binaire à « `app.lucium.browser` signé par l'équipe ». Il peut redemander l'enregistrement de l'écran, l'accessibilité, la caméra, le micro, le réseau local, l'accès complet au disque, l'accès au trousseau et l'automatisation : les accorder de nouveau au premier lancement (Réglages Système › Confidentialité et sécurité). Les builds suivantes signées par la même identité devraient les garder. Le script affiche cet avertissement quand l'application installée et la nouvelle build n'ont pas le même type de signature.

### L'icône choisie, posée sur le paquet (décision du 12 novembre 2026)

Réglages › À propos et mises à jour › Icône de l’application propose huit versions du logo. Jusqu'à la 1.0.0, Lucium ne montrait l'icône choisie que dans le Dock, pendant qu'il tournait (`app.dock.setIcon`, en mémoire) : le paquet n'était jamais modifié, et le Dock d'un Lucium fermé, le Finder et le Launchpad montraient l'icône du paquet (`build/icon.icns`, la version Clair). Le mainteneur a tranché le 12 novembre 2026 : **toujours garder l'icône choisie**. Dès qu'une icône autre que Clair est choisie, Lucium la pose sur le paquet qui tourne, pour que le Dock, le Finder et le Launchpad la gardent une fois Lucium fermé ; il n'y a pas de réglage de plus.

**Comment** (`src/main/shell/bundle-icon.ts`, appelé par `app-icon.ts` au lancement et à chaque choix) : l'appel du système `NSWorkspace setIcon:forFile:options:`, par `/usr/bin/osascript -l JavaScript`, lancé sans shell (`execFile`), 5 s au plus, sans bloquer le processus principal, un appel à la fois. Le script est une constante ; le chemin du paquet et celui de l'image lui arrivent en arguments. Le paquet est le dossier `.app` qui contient l'exécutable qui tourne (`process.execPath`), jamais un chemin venu de l'interface ou de l'état. Rien n'est écrit en développement, dans les tests lancés depuis les sources (`isBuiltApp()`) ni hors macOS. Le système écrit deux choses : un fichier vide `Icon\r` à la racine du paquet (l'image est dans sa *resource fork*) et l'attribut étendu `com.apple.FinderInfo` sur le dossier du paquet. L'icône posée est notée dans `bundle-icon.json`, dans le dossier des données : au lancement suivant, rien n'est refait si le paquet la porte déjà.

**Mesure du 12 novembre 2026**, sur une copie jetable de la 1.0.0 signée et notarisée (`dist-drm/mac-arm64/Lucium.app` copiée par `ditto`), l'icône Sépia & Or posée puis retirée par le script de Lucium :

| État de la copie | `codesign --verify --deep --strict` | `codesign --verify --deep` | `spctl -a -vv` |
|---|---|---|---|
| neuve | valide | valide | accepted, source=Notarized Developer ID |
| icône posée (réponse `true`, `Icon\r` de 0 octet) | refusée : « resource fork, Finder information, or similar detritus not allowed » (« Disallowed xattr com.apple.FinderInfo found on Lucium.app ») | valide | accepted, source=Notarized Developer ID |
| icône retirée (le même appel, sans image) | valide | valide | accepted, source=Notarized Developer ID |

Après le retrait, `Icon\r` et l'attribut `com.apple.FinderInfo` ont disparu, et le paquet est identique à la copie neuve : mêmes fichiers, mêmes contenus (SHA-256), mêmes droits, mêmes attributs étendus (695 entrées comparées) ; seule la date de modification du dossier du paquet a changé. Sur un dossier en lecture seule, l'appel répond `false` et n'écrit rien.

**Le compromis** : une copie qui porte l'icône ne passe plus la vérification stricte de sa signature ; macOS l'ouvre toujours comme une application notarisée (`spctl` lit la notarisation). `pnpm verify:app` sur une telle copie échoue donc à la ligne `signature`, et la ligne le dit (« a custom icon is set on this copy… ») : ce n'est pas un défaut de la build.

**Les garde-fous** :

- l'icône par défaut n'est jamais posée : choisir Clair retire l'icône personnalisée (`Icon\r` et l'attribut), et la vérification stricte repasse. Le paquet est partagé par tous les profils, l'icône est le choix d'un seul : seul le profil qui l'a posée (son `bundle-icon.json` nomme ce paquet) la retire. Une seconde instance sur un profil vierge (test, capture, mesure), qui n'a rien posé, laisse celle qu'elle trouve ;
- **avant d'installer une mise à jour**, Lucium retire l'icône et attend la fin du retrait : avant « Installer et relancer » (`restart`, `app-update.ts`) et à la fermeture qui installe une mise à jour déjà téléchargée (`installPrepareBeforeQuit`, `update-quit-check.ts`). Un échec est écrit au journal et l'installation continue. La nouvelle version arrive sans icône posée, et son premier lancement la remet. Une fermeture demandée par le système (extinction, fermeture de session) n'attend personne : la mise à jour s'installe alors avec l'icône posée ;
- rien n'est retiré à une fermeture ordinaire : c'est le but de la décision ;
- un paquet que l'utilisateur ne peut pas modifier (installé par un administrateur, dossier ou volume en lecture seule, image disque, translocation de Gatekeeper) n'est pas touché : l'erreur est écrite au journal avec le chemin et la raison, et Réglages › À propos et mises à jour › Icône de l’application dit « L'icône ne peut pas être gardée à la fermeture : l'application n'est pas modifiable à cet endroit. Elle reste choisie tant que Lucium tourne. » Le Dock montre l'icône choisie tant que Lucium tourne, dans tous les cas ;
- **ce qui est publié n'en porte jamais** : `package-drm.mjs` vérifie l'application qu'il vient de construire (`codesign --strict`, plus haut) et `build-drm-release.sh` en fait l'archive avant que rien ne la lance ; `make-dmg.mjs` vérifie la copie qu'il met dans l'image disque (`codesign --strict` : une copie par `ditto` garde l'attribut, mesuré le 12 novembre) ; `publish-update.mjs` refuse une archive qui contient `Lucium.app/Icon\r`. Une archive faite à la main (`ditto -c -k --sequesterRsrc --keepParent`) d'une copie qui porte l'icône contient ce fichier, sans l'attribut de la racine : la copie qu'on en extrait passe la vérification stricte (mesuré le 12 novembre), mais elle donnerait l'icône de cette copie à chaque copie mise à jour.

**Ce que fait Squirrel.Mac d'un paquet qui porte l'icône**, lu dans ses sources (`github.com/Squirrel/Squirrel.Mac`, branche `master`, fichiers `SQRLCodeSignature.m`, `SQRLInstaller.m`, `SQRLUpdater.m` ; la version qu'embarque Electron 45 peut en différer) : il ne vérifie jamais la signature du paquet qui tourne, il en lit seulement l'exigence désignée (`SecCodeCopySelf`, `SecCodeCopyDesignatedRequirement`) ; il vérifie la mise à jour téléchargée, puis la copie que ShipIt en prépare, avec `kSecCSStrictValidate | kSecCSCheckNestedCode | kSecCSCheckAllArchitectures` contre cette exigence ; ShipIt met l'ancien paquet de côté en entier, installe le nouveau à sa place, puis supprime l'ancien. L'icône posée sur l'ancien paquet ne devrait donc pas faire échouer l'installation. Le retrait avant l'installation garantit que le paquet remplacé est de nouveau scellé et que rien ne reporte l'icône sur la nouvelle version (le mode `SquirrelMacEnableDirectContentsWrite` de Squirrel, que Lucium ne pose pas, garderait le dossier racine et donc l'icône). **Non vérifié** : une installation réelle par Squirrel depuis une copie qui porte l'icône ; et, dans l'application installée, l'accord de macOS (protection « Gestion des apps », macOS 13 et plus) quand `osascript`, lancé par Lucium, modifie le paquet de Lucium : un refus donne le motif « non modifiable » ci-dessus.

### Notarisation

`scripts/build-drm-release.sh --notarize` (et l'étape `notarize` de `scripts/electron-upgrade.mjs`, avec `--sign --notarize`) envoie l'application signée à Apple avec `xcrun notarytool submit --keychain-profile "$LUCIUM_NOTARY_PROFILE" --wait`, refuse tout statut autre que `Accepted`, agrafe le ticket (`stapler staple`), puis lance `stapler validate`, `spctl --assess` et de nouveau `evs-vmp verify-pkg`. La notarisation et l'agrafage ne cassent pas la signature EVS. Si Apple refuse, rien n'est installé, et le script donne la commande `notarytool log` qui explique le refus.

`LUCIUM_NOTARY_PROFILE` est le **nom** d'un profil du trousseau, jamais un secret. Il se crée une fois par Mac, avec une clé API d'App Store Connect (clé d'équipe : fichier `.p8`, identifiant de clé, identifiant d'émetteur), rangée hors du dépôt :

```sh
xcrun notarytool store-credentials <nom du profil> \
  --key /chemin/vers/AuthKey_XXXXXXXXXX.p8 \
  --key-id XXXXXXXXXX \
  --issuer <identifiant d'émetteur>
xcrun notarytool history --keychain-profile <nom du profil>   # vérifie le profil
```

Sans les options, `store-credentials` pose les questions une par une. Par défaut, il vérifie les identifiants auprès d'Apple avant d'enregistrer le profil.

## 9. Vérifier la lecture

Pas de build à distribuer sans lecture vérifiée. Après une construction :

1. La page de contrôle de castLabs, « Widevine VMP Lab » (<https://castlabs.github.io/wv-vmp-lab/>) : Widevine « Available » et un statut VMP valide.
2. Un service réel en lecture (Netflix, avec un abonnement). Le runtime durci touche le chargement du module Widevine : seule une lecture réelle prouve que les entitlements suffisent.

La définition reste limitée : le CDM de cette variante est de niveau logiciel, ce qui plafonne en général la qualité (SD ou HD limitée) selon les services.

## 10. Mettre à jour le moteur castLabs

Le suivi des versions castLabs et la procédure de mise à jour sont dans `docs/mise-a-jour-chromium.md`. `pnpm electron:watch` signale une nouvelle version `+wvcus` ; `node scripts/electron-upgrade.mjs <version>` (avec `--sign` pour signer, `--notarize` pour notariser) prépare la montée, télécharge le moteur castLabs de la version, construit la variante avec `--castlabs-fuses` et ne publie rien. Avec `--allow-prerelease`, il prépare la ligne principale sur une préversion, mais l'étape de build de la variante est refusée (« Le garde-fou du moteur », section 3). Après une montée de version de castLabs, refaire l'essai des fusibles (section 5) et l'essai de lecture (section 9) avant d'installer.

**Règle** : la variante suit l'Electron épinglé dans `package.json`, et celui-ci ne monte que vers une version que castLabs a publiée en stable `+wvcus`. État au 10 novembre 2026 : `package.json` épingle 45.2.1 et `v45.2.1+wvcus` (stable, publiée le 5 novembre 2026, Chromium 156.0.8078.75) est la dernière stable castLabs de la ligne 45. Electron 45.2.2 et 45.2.3 (Chromium 156.0.8078.80) existent, sans build castLabs : la ligne principale reste donc en 45.2.1, et elle montera avec la variante quand castLabs publiera la suite. `pnpm electron:watch` le signale.

## 11. Limites

- **Binaire non reconstructible** : le moteur castLabs est un binaire seul ; le CDM est propriétaire et téléchargé chez son éditeur. C'est pourquoi la variante reste séparée de la ligne principale.
- **Somme de l'archive castLabs, sans signature** : castLabs ne signe ni l'archive ni ses sommes. L'étape `ecs` de `scripts/electron-upgrade.mjs` exige que trois relevés s'accordent : `SHASUMS256.txt`, pièce jointe de la version ; `checksums.json`, fichier du dépôt `castlabs/electron-releases` au même tag (écrit par un commit, servi depuis l'arbre git et non depuis les pièces jointes) ; et, pour une version déjà téléchargée une fois, la somme enregistrée dans `scripts/ecs-checksums.json` (45.2.1 : relevé le 12 novembre 2026, les deux sources de castLabs donnaient la même somme). Ce que cela arrête : une pièce jointe remplacée seule, et une archive remplacée après son premier téléchargement. Ce que cela n'arrête pas : une prise du compte GitHub de castLabs avant le premier téléchargement d'une version, puisque les deux premiers relevés sont sous ce même compte. Il n'existe pas de source indépendante : le binaire diffère de l'Electron amont, dont les sommes ne servent donc pas de comparaison. Risque accepté.
- **Retard de sécurité** : un build par mois et par série, sans engagement ; la variante peut être en retard de plusieurs semaines sur les correctifs de Chromium. La 0.2.15 distribuée est sur une préversion (`45.0.0-alpha.14+wvcus`, Chromium 156.0.8077.0) ; à partir de la 0.2.16 la variante se construit sur `45.2.1+wvcus` (Chromium 156.0.8078.75), et le script refuse toute préversion (section 3). L'écart qui reste est celui de castLabs : au 10 novembre 2026, deux correctifs d'Electron (45.2.2 et 45.2.3, Chromium 156.0.8078.80) n'ont pas de build `+wvcus`.
- **Dépendance à EVS** : si le service change ses conditions ou s'arrête, plus de nouvelle signature, donc plus de lecture pour les builds suivantes.
- **Fusibles figés** : un futur fusible d'Electron hors de l'ensemble castLabs ne pourra pas être activé dans la variante.
- **Connexion au service de composants** à chaque lancement (section 7).
- **Qualité limitée** et pas de téléchargement hors ligne (section 9 et section 2).
- **Linux** : pas de VMP chez castLabs, donc sans doute pas de lecture chez les services qui l'exigent.

## 11 bis. Licences : ce que la variante contient, et ce qu'elle ne contient pas

Lucium est sous GPL-3.0-or-later ; le module Widevine est propriétaire. Ce qui suit décrit les faits ; ce n'est pas un avis juridique. **Une permission additionnelle (GPL version 3, article 7) accompagne la licence depuis le 11 novembre 2026** (`ADDITIONAL-PERMISSION.txt`, reprise dans `NOTICE` ; les deux fichiers sont livrés dans l'application) : elle autorise à combiner Lucium avec le module et avec le moteur qui le charge, et à distribuer le résultat. Son texte, rédigé par le mainteneur, attend la relecture d'un juriste.

- **Dans la variante distribuée** : le code de Lucium (GPL-3.0-or-later), l'Electron de castLabs (MIT, binaire non reconstruit ici) avec Chromium, et leurs textes de licence. Le module Widevine **n'y est pas**.
- **Le module** est téléchargé par le moteur lui-même (son *Component Updater*), sur la machine de la personne, depuis le service de son éditeur, au premier lancement puis à chaque mise à jour (section 7). Il n'est ni dans ce dépôt, ni dans l'image disque, ni dans l'archive de mise à jour.
- **Aucun code de Lucium n'est lié au module.** Lucium demande au moteur de l'installer (`src/main/engine/widevine.ts`) ; le moteur le charge à l'exécution, derrière l'interface *Encrypted Media Extensions* de Chromium.
- **La build standard** (Electron du projet Electron) ne contient pas le module et ne contacte pas ce service.

**Les textes de licence dans le paquet.** L'archive castLabs contient, à côté d'`Electron.app`, `LICENSE` (Electron) et `LICENSES.chromium.html` (Chromium et ce qu'il embarque). electron-builder ne copie qu'`Electron.app` depuis un moteur décompressé : la 0.2.15 a donc été distribuée sans ces deux fichiers. Depuis la 1.0 :

1. `scripts/package-drm.mjs` refuse, avant de construire, un dossier du moteur où l'un des deux manque. Il faut décompresser l'archive entière (`ditto -x -k`, ce que fait `scripts/electron-upgrade.mjs`), pas seulement `Electron.app` ;
2. `scripts/after-pack.cjs` les copie dans `Contents/Resources` (`LICENSE.electron.txt`, `LICENSES.chromium.html`), avant toute signature, depuis ce dossier et jamais depuis l'Electron standard ;
3. `scripts/package-drm.mjs` relit `Contents/Resources` sur le dossier qui sera signé : `LICENSE`, `NOTICE`, `ADDITIONAL-PERMISSION.txt`, `THIRD-PARTY-NOTICES.txt` et ces deux fichiers doivent y être, sinon il s'arrête.

Ces fichiers font partie du contenu signé : une build faite avant ce changement ne les aura jamais, il faut la reconstruire. Le contrôle est testé sans construire (`scripts/notices/shipped-notices.test.ts`) ; la preuve sur une vraie build est la ligne « licence texts in Contents/Resources » de la sortie du script.

Les licences du moteur castLabs et du module Widevine sont dans `docs/licences-tierces.md`.

## 12. Mise à jour par le flux

Une build construite avec `--update-feed <adresse>` sait se mettre à jour. Avec `--test-feed <adresse>` en plus, elle porte **deux canaux** (voir plus bas). Elle lit le fichier de versions à cette adresse 20 s après le lancement puis une fois par jour (réglage « Rechercher les mises à jour automatiquement », activé par défaut), et une notice au pied de la barre latérale propose « Installer » ; **Lucium › Rechercher les mises à jour…** (ou le bouton de la fenêtre À propos) le fait sur demande et propose « Télécharger et installer ». Puis « Installer et relancer ». Le moteur d'installation est celui que l'application embarque déjà : `Squirrel.framework` et son installateur `ShipIt`, pilotés par l'`autoUpdater` d'Electron en mode `serverType: 'json'` (`src/main/shell/app-update.ts`).

**Les règles, dans le code** (`src/main/shell/update-source.ts`) :

- l'application construite n'installe **que** depuis une des adresses gravées à la build. Ni `LUCIUM_UPDATE_FEED` (retirée de l'environnement au démarrage), ni le réglage `updateFeedUrl` : Squirrel installe toute build signée par la même équipe, une adresse que d'autres pourraient choisir pourrait donc ramener une ancienne build ;
- **deux canaux** (décision du 7 novembre 2026). `--update-feed` grave l'adresse du canal **stable** (celui que suit une build par défaut), `--test-feed` celle du canal **de test**, qui reçoit les versions avant le stable. Le réglage `updateChannel` (`stable` par défaut ; case « Recevoir les versions de test » de Réglages › À propos et mises à jour, rangée dans « Plus de réglages ») ne fait que **choisir entre les deux adresses gravées** : il ne peut en nommer aucune, et une valeur inconnue dans un fichier de profil donne le canal stable. Il vaut pour la vérification du menu, la vérification en arrière-plan et l'installation à la fois (`channelFeed`, `src/main/shell/update-source.ts`) ; l'installateur redonne l'adresse à Squirrel quand le canal a changé depuis le téléchargement précédent. Une build qui ne porte pas l'adresse de test ne montre pas la case et suit l'adresse stable quel que soit le réglage : elle se comporte exactement comme avant. Un fichier d'état importé ne change pas le canal de cette installation (pas plus que `updateFeedUrl`) ;
- **changer de canal ne ramène jamais en arrière** : si la dernière version du canal choisi est plus ancienne que celle qui tourne, la vérification dit « Lucium est à jour », la notice n'apparaît pas et rien n'est téléchargé ; `ElectronSquirrelPreventDowngrades` (ci-dessous) le refuserait de toute façon. Une mise à jour **déjà téléchargée** (notice « prêt à être installé ») reste installée à la fermeture même si l'on change de canal entre-temps : Squirrel ne sait pas annuler un téléchargement fini, et Lucium ne l'écarte que si le fichier de versions la retire (plus bas) ;
- le canal stable répond 404 tant que rien n'y est publié : la vérification en arrière-plan reste muette, et « Rechercher les mises à jour… » dit « La vérification des mises à jour a échoué » (« Réponse 404 »). Cocher « Recevoir les versions de test » suit le canal de test en attendant la première version stable ;
- la vérification en arrière-plan (« Rechercher les mises à jour automatiquement », activé par défaut) lit l'adresse gravée **dans l'application construite seulement**, 20 s après le lancement puis toutes les 24 h, sans cookie ni identifiant (décision du 5 novembre 2026). Décochée, elle n'envoie rien. Depuis les sources, elle ne lit jamais l'adresse gravée, seulement une adresse donnée à la main. Un échec de réseau ne montre rien : le tour suivant réessaie (`backgroundFeed`, `src/main/shell/auto-update.ts`) ;
- la notice (`src/shared/auto-update.ts`) : « Lucium X est disponible » avec « Installer » et « Plus tard », ou « Lucium X est prêt à être installé » avec « Installer et relancer » quand la mise à jour est déjà téléchargée. « Plus tard » ne la ramène pas avant 24 h ou le prochain lancement ; une version montrée trois fois sans « Installer » ne revient plus d'elle-même (le réglage-mémoire `updateNotices`), le menu la trouve toujours. Elle ne s'affiche que dans une fenêtre normale au premier plan : jamais dans une fenêtre privée, ni pendant un partage de fenêtre que Lucium connaît (la fenêtre annotée, ou une page de Lucium qui partage une de ses fenêtres), ni derrière le verrouillage ; elle attend alors la prochaine fenêtre qui prend le focus. Un partage d'écran entier par une page, ou par une autre application, n'est pas détecté ;
- sans adresse gravée (build de développement, build sans l'option), rien ne change : la vérification lit le réglage, ou la variable depuis les sources, et ouvre la page de téléchargement ;
- `ElectronSquirrelPreventDowngrades` (`electron-builder.yml`) fait refuser par Squirrel une version plus ancienne que celle qui tourne. Aucun flux ne ramène donc en arrière une copie installée : on publie une version plus haute, ou on réinstalle à la main (section 4, la sauvegarde de `lucium-app-backups`) ;
- **retirer une version défectueuse** : `node scripts/publish-update.mjs --withdraw <version> --channel <canal>` remet le fichier de versions de la version précédente (chaque publication garde celui qu'elle remplace, `feed-<version>.json`) et met de côté l'archive et l'image disque de la version retirée, sans rien supprimer. Le fichier de versions qui reste liste la version retirée (`withdrawn`) : une copie qui la fait tourner le lit dans ce fichier, sans autre requête, affiche « Cette version a été retirée » et indique la version à installer. Ce n'est pas une publication : elle ne demande ni attestation ni délai, et elle ajoute au journal des publications une ligne de type `withdrawal`. La procédure complète, avec les pages du site, la version plus haute à publier et ce que l'application fait des données quand on revient à une version plus ancienne, est dans [docs/community/release-process.md](community/release-process.md#withdrawing-a-version).
- **l'icône choisie** (Réglages › À propos et mises à jour › Icône de l’application), posée sur le paquet, en est retirée avant chaque installation par Squirrel, « Installer et relancer » comme fermeture qui installe ; le premier lancement de la nouvelle version la remet (section 8, « L'icône choisie, posée sur le paquet ») ;
- **un correctif urgent** (`security`, clé facultative du fichier de versions, lue par `securityFixVersion` dans `src/shared/update-check.ts`) : le mainteneur écrit `"security": "X.Y.Z"` (la première version qui porte le correctif d'une faille exploitée) dans le fichier de versions **avant de le signer** ; la signature couvre tout le fichier, la clé ne peut donc pas être ajoutée en route. La publication (`publish-update.mjs`) ne la pose pas encore : elle s'écrit à la main dans le fichier à signer, et un fichier sans clé ou avec une valeur qui n'est pas une version simple se lit comme avant. Une copie dont la version est **en dessous** de celle-là, et à qui le fichier offre une version qui la porte, dit dans la notice « Lucium X.Y.Z corrige une faille de sécurité » et **ignore le plafond de 3 affichages** (la notice est montrée à chaque lancement et chaque jour, jamais plus d'une fois par jour dans une même exécution, et ses affichages ne sont pas comptés). **La fréquence ne change pas** : 20 s après le lancement puis une fois par jour, sans requête de plus ; seul le plafond de la notice est levé. Rien d'autre n'est lu de cette clé (aucun texte du fichier n'est affiché). Tests : `update-check.test.ts`, `auto-update.test.ts` (partagé et main).
- **une version retirée après son téléchargement** (`src/main/shell/squirrel-staging.ts`, `update-quit-check.ts`) : une copie qui a déjà téléchargé la version retirée (notice « prêt à être installé ») relit le fichier à la recherche suivante, à « Rechercher les mises à jour… », et au moment de quitter (5 s au plus, seulement si « Rechercher les mises à jour automatiquement » est activé). Si la version téléchargée y est listée comme retirée, Lucium retire la tâche launchd `app.lucium.browser.ShipIt` que Squirrel avait posée pour l'installer à la fermeture, efface ce qu'il avait préparé (`~/Library/Caches/app.lucium.browser.ShipIt`, `ShipItState.plist` et `update.*`), dit « La version X a été retirée : elle n'est pas installée » et propose la version que le fichier offre. Retirée au moment de quitter, elle est dite au lancement suivant. Electron n'a aucun appel pour annuler un téléchargement fini : Lucium fait ce que Squirrel fait lui-même avant de poser une nouvelle mise à jour. Une tâche qui tourne en root (copie installée là où seul un administrateur écrit) n'est pas retirée, seuls les fichiers le sont. **À vérifier** sur une vraie mise à jour (build signée, deux versions, un retrait) : ce chemin n'est testé que sur des doublures ;

**Les variables, les mêmes pour toutes les builds que sert un flux** :

| Variable | Rôle pour la mise à jour |
|---|---|
| `LUCIUM_SIGN_IDENTITY` | L'identité Developer ID (un nom, jamais un secret ; section 8). Squirrel vérifie l'archive téléchargée contre l'exigence désignée de l'application qui tourne : même identifiant (`app.lucium.browser`, `--as-lucium`), **même équipe**. À fixer pour les deux builds : sans elle, le script prend la première identité du trousseau. |
| `LUCIUM_KEYCHAIN_PROFILE` | Le profil d'approvisionnement de l'auxiliaire du trousseau (section 8). ShipIt remplace tout le paquet, auxiliaires compris : une build faite sans ce profil installe un auxiliaire sans entitlements, et Touch ID devient « indisponible » après la mise à jour. |
| `LUCIUM_NOTARY_PROFILE` | Le nom du profil `notarytool` (section 8, Notarisation) : `--notarize` écrit l'archive `dist-drm/Lucium-<version>-arm64.zip`, celle que Squirrel installe. |

La version est celle de `package.json` (elle devient `CFBundleShortVersionString`, que Squirrel compare). Pour un essai, on la change localement, sans la committer.

**Publier une version** (exemple : de 0.2.0 à 0.2.1, sur le site d'essai) :

```sh
# A : la 0.2.0 qui sait se mettre à jour, installée par le script (une fois : une build sans adresse ne se met jamais à jour seule)
LUCIUM_SIGN_IDENTITY="Developer ID Application: …" LUCIUM_KEYCHAIN_PROFILE=/chemin/du/profil.provisionprofile LUCIUM_NOTARY_PROFILE=<nom> \
  scripts/build-drm-release.sh --notarize \
    --update-feed https://lucium.app/updates/darwin-arm64/feed.json \
    --test-feed https://test.lucium.app/updates/darwin-arm64/feed.json
# B : la 0.2.1, construite sans être installée (package.json en 0.2.1)
… même environnement … scripts/build-drm-release.sh --notarize --no-install --update-feed https://lucium.app/updates/darwin-arm64/feed.json --test-feed https://test.lucium.app/updates/darwin-arm64/feed.json
# Le fichier de versions du canal où la version est publiée (l'archive d'abord, dans le dossier de ce canal)
node scripts/make-update-feed.mjs dist-drm/Lucium-0.2.1-arm64.zip https://test.lucium.app/updates/darwin-arm64/ > dist-drm/feed.json
```

Les deux adresses sont gravées dans **chaque** build, quel que soit le canal où elle est publiée : une version d'abord publiée sur le canal de test, puis (même archive, même version) sur le stable, est lue par les deux. Le script affiche, après une notarisation, une commande `make-update-feed.mjs` par canal (`dist-drm/feed.json` pour le stable, `dist-drm/feed-test.json` pour le test).

`make-update-feed.mjs` lit la version dans l'`Info.plist` de l'archive (elle doit être celle de `package.json`), calcule la taille et le SHA-256 (Squirrel écarte un téléchargement qui ne correspond pas), date le fichier et reprend en notes le premier paragraphe de la section de la version dans `CHANGELOG.fr.md` (`--notes "…"` pour en donner d'autres) ou, sans paragraphe, les titres de ses lignes, coupés après un titre entier quand ils dépassent 300 caractères. Le fichier porte aussi une clé `en`, propre à Lucium : les notes tirées de `CHANGELOG.md` (`--notes-en`) et la page de téléchargement en anglais (`--page-en`), que montre une interface en anglais. Une version antérieure à la 1.0 ignore cette clé et garde le français. L'archive part **d'abord**, le fichier de versions **ensuite** : un fichier qui nomme une archive absente fait échouer toutes les installations. Le dépôt sur le site est décrit dans le README du dépôt du site (« Publier une mise à jour »).

**En une commande** : `node scripts/publish-update.mjs` fait la suite de la construction (`docs/community/release-process.md`, « Publishing the update »). Il vérifie la build (version, ticket de notarisation agrafé, fusibles Electron égaux à ceux de l'application installée), écrit `dist-drm/feed.json`, envoie l'archive et le fichier dans un dossier privé du serveur (créé au début de l'envoi par `mktemp -d` sous `/tmp`, droits `0700`, et supprimé à la fin, même quand la publication s'arrête en route), publie l'archive, la retélécharge et compare son SHA-256, puis seulement publie le fichier de versions et le relit en ligne. Avant d'envoyer quoi que ce soit, il lit les conditions d'une publication (`docs/community/release-process.md`, « The conditions of a publication ») : l'archive contient bien l'application contrôlée, la fiche de construction écrite à côté d'elle par `scripts/build-drm-release.sh --notarize` nomme le commit dont elle vient, les deux journaux des changements portent la date de la version, les suites moteur sont passées sur ce commit (`pnpm test:engine:release`), et, pour le canal stable, la version a passé une journée sur le canal de test et le mainteneur a rempli son attestation (Netflix lit, Touch ID ouvre le coffre, la mise à jour depuis la version précédente s'installe). Chaque publication ajoute une ligne à un journal gardé hors du dépôt. Il s'arrête à la première erreur et dit ce que le serveur contient alors. `--dry-run` affiche chaque commande sans lancer celles qui touchent au réseau ou au serveur. `--channel test|stable` choisit le canal (`test` par défaut) : le dépôt ne garde que le nom et l'adresse https de chaque canal, le serveur et le dossier viennent d'un fichier JSON hors du dépôt (`~/Library/Application Support/lucium-secrets/publish-channels.json`, ou `--config <fichier>`, ou la variable `LUCIUM_PUBLISH_CONFIG`), décrit dans `docs/community/release-process.md`, « The file of the servers ». Le dossier d'un canal neuf est créé par l'étape de l'archive. Quand `dist-drm/Lucium-<version>-arm64.dmg` et son `.sha256` existent (`node scripts/make-dmg.mjs`, qui fait l'image disque signée et notarisée à partir de l'application déjà notarisée ; `docs/community/release-process.md`, « The disk image »), la commande les publie aussi, dans le dossier de l'archive, après elle et avant le fichier de versions, et relit l'image en ligne ; `--no-dmg` les laisse de côté.

**Le fichier de versions est signé.** À partir de la 1.0, une copie ne croit un fichier de versions que si une clé gravée en elle l'a signé (Ed25519, `src/main/update-feed-signature.ts`) ; la signature est la dernière clé du fichier, `signatures`, et porte sur les octets exacts du fichier tel qu'il était avant d'être signé. Sans signature valide, sur le canal stable, sur le canal de test ou à une adresse donnée à la main, Lucium ne propose aucune mise à jour et ne dit d'aucune version qu'elle a été retirée : « Rechercher les mises à jour… » dit « Le flux de mises à jour n'a pas de signature valide : aucune mise à jour n'est proposée. », la recherche automatique n'affiche rien, et une ligne part au journal des erreurs (Réglages › À propos et mises à jour › Plus de réglages › État de Lucium). `scripts/publish-update.mjs` signe le fichier, avec la clé privée rangée hors du dépôt (`~/Library/Application Support/lucium-secrets/feed-key.pem`, créée par `node scripts/feed-key.mjs`) ; un fichier écrit à la main n'est pas signé. La ou les clés publiques sont dans `src/main/update-feed-keys.ts` : tant que ce fichier est vide, `scripts/build-drm-release.sh` s'arrête avant la construction dès qu'on lui donne `--update-feed` ou `--notarize`, et `pnpm verify:app` échoue. Limite : la seconde lecture du fichier, que Squirrel.Mac fait lui-même au moment d'« Installer », n'est pas couverte par cette signature ; elle reste protégée par la signature Developer ID de l'archive, sa taille, son SHA-256 et le refus d'une version plus ancienne. Création, sauvegarde, changement et fuite de la clé : `docs/community/release-process.md`, « The key of the update feed ».

**Ce que voit l'utilisateur** : sans rien demander, au plus une fois par jour, la notice « Lucium X est disponible (taille). » avec « Installer » et « Plus tard » ; « Installer » lance directement le téléchargement. Depuis le menu : « Recherche des mises à jour… », puis « Lucium est à jour » ou « La version X est disponible » avec « Télécharger et installer ». Electron ne donne pas l'avancement du téléchargement sous macOS : un message dit « Téléchargement de Lucium X (taille)… », puis une boîte « Lucium X est prêt » propose « Installer et relancer » ou « À la prochaine fermeture ». Les échecs sont dits en clair : serveur injoignable, signature refusée, flux invalide, archive refusée (taille, empreinte ou version), volume en lecture seule (Lucium lancé depuis une image disque ou depuis Téléchargements), avec « Télécharger manuellement ».

**La relance** : `quitAndInstall` émet `before-quit-for-update`, ferme toutes les fenêtres, puis quitte. Sur cet événement, Lucium enregistre l'état et lève ses questions : « Avertir avant de quitter », les téléchargements en cours, la question avant de fermer une fenêtre de plusieurs onglets (`prepareQuitForUpdate`, `src/main/shell/quit-flow.ts`). L'effacement des sites « à la fermeture de Lucium » garde la fermeture 8 s au plus. Une mise à jour téléchargée et non installée s'installe à la fermeture suivante.

**Changer d'adresse** : les adresses sont gravées dans chaque build installée. Pour en changer, on publie sur l'**ancienne** adresse une build qui porte la nouvelle. C'est ainsi que les installations qui ne portaient que l'adresse de `test.lucium.app` passent aux deux canaux : la première build à deux adresses se publie sur `test.lucium.app`. Ensuite, ces installations suivent le canal **stable** par défaut : tant que rien n'y est publié (404), elles ne reçoivent plus rien jusqu'à ce que « Recevoir les versions de test » soit coché.
