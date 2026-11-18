# Synchronisation Mac ↔ iPhone (phase 2) : spécification

Spécification de la synchronisation directe entre le Mac et l'iPhone, sur le réseau local, sans serveur ni compte. Elle est écrite par la carte 443 et sert les cartes 444 (Mac), 445 (iPhone), 446 (fusion), 447 (reprise d'un onglet) et 448 (revue de sécurité). Ce document dit ce que le code doit faire, et les vecteurs de contrat (§19) tiennent d'accord le Mac et l'iPhone. **État de la carte 444 (Mac)** : sont écrits, testés et câblés l'écoute et le filtre d'adresses (§6), l'appairage et sa confirmation (§4), l'identité et le certificat (§3, §6.3), la fenêtre de synchronisation (§6.1), la page des Réglages et son canal IPC (§13.1), la ligne du README (§14) **et la séance d'échange (§8 : instantané, marques, filtre des entités reçues, action `sync/apply`)**, qui utilise la fusion à trois voies (§11) de la carte 446 : en TypeScript (`src/shared/sync-merge.ts`, `sync-canonical.ts`, `sync-snapshot.ts`) et en Swift (`ios/LuciumKit/Sources/LuciumKit/SyncMerge.swift`, `SyncCanonical.swift`, `SyncSnapshot.swift`), jouées contre les mêmes vecteurs. Le journal des conflits (§11.7.3), les phrases de « Conflit réglé » (§13.4) (`src/shared/sync-conflicts.ts`, `SyncConflicts.swift`), la feuille du Mac (`src/renderer/SyncConflictSheet.tsx`) et l'écran de l'iPhone (`ios/Lucium/SyncConflictScreen.swift`) sont de la carte 446 ; la séance rend les conflits réglés dans son résultat (`conflicts`), mais **ne les inscrit pas encore au journal et ne montre pas encore la feuille** : c'est ce qui reste à brancher. Ce que ces choix précisent est au §22. Rien de tout cela n'a été vu à l'œuvre avec un iPhone : la carte 445 (iPhone) n'est pas fusionnée et le contrôle du moteur (`src/main/smoke-sync.ts`) est écrit, pas lancé. Les cartes 445 à 448 restent à faire.

Il complète [docs/ios.md](ios.md) §13, qui est l'étude. En cas d'écart, ce document prime ; les écarts voulus sont listés au §21.

**Comment lire les étiquettes.**

- **Décidé** : décision du chef de projet (`docs/ios.md` §15, ou la demande de lancer la phase 2 le 18 novembre 2026).
- **Vérifié** : lu dans un code installé (`@types/node` 26.6.6, SDK iPhoneOS 27.2) ou dans une page de manuel de ce Mac, ou essayé pour cette carte (essais du §17). Une phrase « essayé » dit sur quoi : Node 26.13 sur la boucle locale, ou Security.framework de ce Mac.
- **À vérifier** : non lu et non essayé ; la carte qui l'implémente le vérifie avant de s'y fier.
- **Choix [Qn]** : un des sept choix qui revenaient au chef de projet, posés en commentaire `[question]` sur la carte 443. **Réponse du chef de projet, le 18 novembre 2026 : « Le mieux le plus secure »**, lue ici comme : *pour chaque choix, l'option la plus sûre*. Cinq étaient déjà la recommandation (Q1, Q3, Q4, Q6, Q7) ; **deux changent** (Q2 : aucune catégorie cochée par défaut sauf la structure ; Q5 : le Mac n'écoute que pendant une fenêtre ouverte à la main). Cette lecture est à confirmer par le chef de projet ; la liste est au §18.

## 1. En bref

| Question | Réponse |
|---|---|
| Quoi | Une synchronisation **dans les deux sens** des espaces, dossiers, favoris et onglets épinglés (et, si la personne les coche, de l'archive et de quelques réglages) entre **son** Mac et **son** iPhone |
| Par où | **Le réseau local seulement**, d'appareil à appareil. Aucun serveur, aucun compte, aucun service d'une entreprise (iCloud compris) : `GOVERNANCE.md` principe 5 et `AGENTS.md` §5 |
| Qui parle à qui | **Le Mac écoute, l'iPhone se connecte.** Le Mac n'ouvre jamais de connexion vers l'iPhone |
| Quand | **Désactivée par défaut**, des deux côtés. **Le Mac n'écoute que pendant une fenêtre de synchronisation que la personne ouvre elle-même** (10 minutes au plus, §6.1) ; pendant ce temps l'iPhone se synchronise à l'ouverture de l'application, au retour au premier plan et sur demande ; les deux sont sur le même réseau |
| Appairage | Un **code QR** affiché par le Mac (adresse, port, empreinte, secret de 128 bits à usage unique valable 2 minutes), lu par l'iPhone ; à défaut de caméra, un code à saisir |
| Transport | **TLS 1.3 mutuel**, certificats auto-signés, **empreinte de l'autre épinglée** des deux côtés ; pendant l'appairage seulement, un **HMAC-SHA-256** prouve que les deux côtés connaissent le secret |
| Messages | Des trames de JSON précédées de leur longueur (1 Mio au plus), numérotées, sans accusé par message ; une version de protocole négociée par ALPN |
| Fusion | **À trois voies**, entité par entité et champ par champ, avec une base par appareil appairé ; le plus récent gagne, **une suppression perd face à une modification** ; les champs inconnus traversent |
| Jamais | Mots de passe, verrous, cookies, historique, onglets privés, Retouches, scripts, extensions, réglages de réseau et de mise à jour |
| Choix du chef | **sept** ([Q1] à [Q7], §18) : réponse « le mieux le plus secure », l'option la plus sûre de chacun |
| Dépendance nouvelle | **Aucune** (certificats écrits à la main : [Q6], §6.3) |

## 2. Règles du projet qui s'appliquent

| Règle | Conséquence ici |
|---|---|
| `GOVERNANCE.md` principe 5 : pas de synchronisation par un service du projet ou d'une entreprise | Le seul chemin est appareil à appareil. Un VPN que la personne gère (par exemple une adresse en 100.64.0.0/10) est un réseau local de plus ; Lucium n'en fournit aucun |
| `GOVERNANCE.md` principes 3 et 4 : pas de compte, pas de télémétrie | Aucun identifiant de compte. Les identifiants d'appareil sont aléatoires, créés sur l'appareil, et ne quittent jamais le réseau local |
| `AGENTS.md` §5 : rien ne quitte la machine sans le choix explicite de la personne ; un nouvel appel réseau est désactivé par défaut, a son interrupteur, est dans le tableau des connexions du README et nommé dans la pull request | §14 : la ligne du tableau, l'interrupteur **des deux côtés**, désactivé par défaut |
| `AGENTS.md` §6 : le processus principal revalide chaque message IPC ; pas de dépendance sans raison | La page Réglages passe par un canal IPC validé (carte 444). Aucune dépendance : §6.3 |
| `AGENTS.md` §6 : jamais de secret dans l'état, un journal, une URL ou un test | Le secret d'appairage n'est que dans le QR et en mémoire ; jamais écrit sur disque, jamais journalisé. Les clés privées sont dans le trousseau (§3.3) |
| `docs/ios.md` §5 : un état de version supérieure n'est jamais réécrit | Une séance avec un appareil dont l'état est d'une version plus récente est refusée (`state-too-new`) |
| `docs/ios.md` §4.5 : le verrou est un verrou de l'interface | Un verrou ne se synchronise jamais ; le contenu d'un espace verrouillé reste de côté [Q4] |

## 3. Les deux appareils

### 3.1 Rôles

- **Le Mac est le serveur TLS** : il écoute (§6.1) et n'ouvre aucune connexion sortante pour la synchronisation.
- **L'iPhone est le client** : il se connecte, ouvre la séance et la ferme. Conséquence : les changements faits sur le Mac arrivent sur l'iPhone **à la prochaine séance** (ouverture de l'application, retour au premier plan, bouton « Synchroniser maintenant »), **à condition que la fenêtre de synchronisation du Mac soit ouverte** (§6.1), pas au moment où ils sont faits. C'est l'écart assumé de `docs/ios.md` §13.1.
- Les deux appareils font **la même fusion** (§11) sur les mêmes entrées et comparent le résultat ; ce n'est pas le Mac qui tranche pour l'iPhone. Cette symétrie est voulue par la carte 446 (mêmes vecteurs des deux côtés) et laisse la porte ouverte à deux appareils de même rôle plus tard. Écarté : une fusion faite par le Mac seul, plus simple, mais qui ne détecte pas un écart entre les deux implémentations (le résumé `result` du §8 le détecte).

### 3.2 Identité d'un appareil

À la première activation, chaque appareil crée :

| Élément | Valeur |
|---|---|
| **Clé** | une paire ECDSA **P-256** (`prime256v1`), créée sur l'appareil, jamais exportée |
| **Certificat** | auto-signé, écrit selon le profil du §6.3 ; **valable de 1970 à 9999** (la date ne sert à rien : la confiance vient de l'empreinte) |
| **Empreinte** (`fp`) | le **SHA-256 du certificat en DER**, 32 octets, écrit en hexadécimal minuscule (64 caractères) ou en base64url sans remplissage (43 caractères) |
| **Identifiant d'appareil** (`id`) | 16 octets aléatoires, en base64url sans remplissage (22 caractères). Charset `[A-Za-z0-9_-]`, 1 à 64 caractères à la lecture. **Lié à l'empreinte à l'appairage** : une séance dont le `hello.device.id` n'est pas celui enregistré pour l'empreinte présentée est refusée (`fingerprint-mismatch`) |
| **Nom** | le nom que la personne voit (« MacBook Pro de … », « iPhone de … »), 1 à 80 caractères ; envoyé à l'appairage et à chaque `hello` ; **jamais utilisé pour reconnaître** un appareil |

**Précision sur `docs/ios.md` §13.2** : l'étude dit « l'empreinte de sa clé publique ». La spécification retient l'empreinte **du certificat** : même hachage des deux côtés sans fabriquer l'en-tête ASN.1 d'une clé (essayé : `X509Certificate.fingerprint256` de Node donne ce même SHA-256 ; `SecCertificateCopyData` de Security.framework donne les mêmes octets). Un certificat n'est jamais renouvelé : le remplacer, c'est se réapparier.

### 3.3 Où c'est gardé

| | Mac | iPhone |
|---|---|---|
| **Clé privée** | chiffrée par `safeStorage` d'Electron, dans un fichier de la zone de données de l'application (**à vérifier** : documentation d'Electron 45.2.1 non lue ici ; ne jamais l'écrire en clair) | trousseau : élément de clé, `kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly` (la constante existe dans `SecItem.h` ; l'en-tête dit que les valeurs « ThisDeviceOnly » ne se synchronisent pas vers un autre appareil : **vérifié**) ; **pas** `kSecAttrSynchronizable` : la clé ne passe pas par le trousseau iCloud |
| **Certificat** | un fichier à côté | le trousseau (certificat + clé forment une identité, `kSecClassIdentity` : l'API `SecIdentityCreateWithCertificate` n'existe **que sur macOS** (`SEC_OS_OSX` dans `SecIdentity.h`, **vérifié**) ; l'identité de l'iPhone se forme donc par `SecItemAdd` du certificat et de la clé puis une requête `kSecClassIdentity` : **à vérifier** par la carte 445) |
| **Appareils appairés** (`peers`) | `sync.json` : `id`, nom, plateforme, empreinte, date d'appairage, dernière séance, catégories | un fichier équivalent |
| **Base de fusion** de chaque appareil appairé, **marques** (§9.2), **pierres tombales** (§11.5), journal des conflits (§11.7) | fichiers à côté de `state.json` (jamais dedans : `docs/ios.md` §13.6) | dossier de l'application |
| **Port d'écoute** | choisi **une fois** au hasard entre 49152 et 65535 à la première activation, gardé dans `sync.json` ; s'il est pris au lancement, un autre est tiré, et l'iPhone se reconnecte par les moyens du §5 | — |

**Une clé que le trousseau n'ouvre pas** (revue de sécurité, n° 22) : sur le Mac, l'identité n'est **pas remplacée au premier refus** — un trousseau qui refuse un instant (une invite refusée, un trousseau verrouillé) emportait sinon tous les appareils appairés, puisqu'une nouvelle identité a une autre empreinte. La page dit « Le trousseau de macOS n'a pas ouvert la clé… Vos iPhone restent appairés : réessayez » ; si la clé ne s'ouvre toujours pas au deuxième essai (un profil restauré sur une autre machine), une nouvelle identité est faite et la page dit qu'il faut appairer de nouveau. Un fichier qui n'est pas une identité du tout (pas de JSON, un certificat illisible, une clé qui n'est pas celle du certificat) est remplacé tout de suite : rien ne pourrait l'ouvrir plus tard. Le trousseau de l'iPhone ne remplace rien sans que la recherche de l'identité dise « introuvable » (`KeychainSyncIdentityStore`, lu et laissé tel quel).

Tout fichier lu est **borné** à la lecture (comme `DATA_FILE_MAX_BYTES` du Mac, `persist.ts`) et traité comme hostile. **Une restauration sur un autre appareil** (sauvegarde de l'iPhone, copie d'un profil du Mac) ne ramène pas la clé : si `sync.json` liste des appareils mais que la clé est absente, l'application oublie la liste et dit qu'il faut se réapparier (§12).

## 4. Appairage

### 4.1 Déroulé avec le QR

1. Sur le Mac, la personne ouvre la page « Synchronisation » des Réglages (à créer), active l'interrupteur (l'écoute démarre, §6.1) et touche **« Ajouter un iPhone »**.
2. Le Mac tire un **secret** de 16 octets (`crypto.randomBytes`) et ouvre une **fenêtre d'appairage de 120 secondes**, mesurée par une horloge monotone (un changement d'heure du Mac ne la prolonge pas). Il affiche le **QR**, un compte à rebours, et en dessous l'adresse et le code à saisir (§4.3).
3. Sur l'iPhone, la page « Synchronisation » des réglages de l'application, bouton **« Ajouter un Mac »**, ouvre la caméra. L'iPhone lit le QR, vérifie sa forme (§4.2) et que **chaque adresse est locale** (§6.2), puis ouvre une connexion TLS vers la première adresse qui répond (§5). **Avant d'envoyer le moindre octet**, il compare l'empreinte du certificat que le Mac présente à celle du QR : si elles diffèrent, il ferme (`fingerprint-mismatch`) et ne dit pas « Mac non joignable » mais « ce n'est pas le Mac du code ».
4. Le Mac accepte, **pendant la fenêtre seulement**, une connexion dont l'empreinte est inconnue ; elle n'a le droit de parler que d'appairage (§7.4). Il envoie `pair.challenge` (un nonce de 16 octets).
5. L'iPhone répond `pair.request` : son identité, son nom, son nonce, et une **preuve** = HMAC-SHA-256 du secret sur la transcription (§4.4).
6. Le Mac vérifie la preuve **en temps constant** (`crypto.timingSafeEqual`, **vérifié** dans `@types/node`). Preuve fausse : `bad-proof`, la tentative est comptée, la fenêtre reste ouverte. Preuve juste : **le secret est brûlé** (à partir de là, `pairing-used` pour qui le rejoue).
7. **[Q7, recommandé]** Le Mac affiche « Un iPhone nommé « … » demande à s'appairer » avec **Autoriser** et **Refuser** (60 secondes ; sans réponse, c'est un refus). Refus : `pairing-refused` ; le secret reste brûlé.
8. Autorisé, le Mac envoie `pair.accept` : son identité, son nom, ses adresses (§5) et **sa preuve** (§4.4). L'iPhone la vérifie ; fausse, il n'enregistre rien.
9. Chacun **enregistre l'autre** : id, nom, plateforme, empreinte, date. La connexion se ferme (`bye`). L'iPhone ouvre ensuite une **séance normale** (§8) : un seul chemin de code pour la première synchronisation et les suivantes.

### 4.2 Forme du QR

Le QR contient **une ligne de texte** (pas d'URL : un analyseur d'URL ne lit pas la même chose en Swift et en JavaScript, `docs/ios.md` §5) :

```
lucium-sync:1/<fp>/<secret>/<port>/<hôtes>
```

| Champ | Forme |
|---|---|
| `lucium-sync:1` | le préfixe et la **version du code** (1) |
| `<fp>` | l'empreinte du certificat du Mac, base64url sans remplissage, **43 caractères** |
| `<secret>` | le secret, base64url sans remplissage, **22 caractères** |
| `<port>` | entier décimal de 1 à 65535, **sans zéro en tête** |
| `<hôtes>` | **1 à 4** hôtes séparés par des virgules : adresse IPv4 en décimal pointé, adresse IPv6 en minuscules **sans crochets ni zone** (`fe80::…%en0` n'est donc jamais écrit), ou nom `….local` ; **tous locaux** (§6.2). L'ordre est l'ordre d'essai |

Longueur totale : **300 caractères au plus**. La lecture est **stricte** : un espace, un segment de plus ou de moins, un caractère hors du jeu, une longueur fausse, un port nul ou trop grand, un hôte non local, **refusent le code** (`invalid-code`) ; un autre numéro de version dit `unsupported-version` (« mettez Lucium à jour des deux côtés »). Les vecteurs : `ios/Contracts/sync-pairing-vectors.json`, tableau `qr`.

### 4.3 Repli sans caméra : le code à saisir

Sous le QR, le Mac écrit **l'adresse** (`Mac-de-….local:49213`) et le **code** : le secret en base32 (alphabet de la RFC 4648, `A–Z` et `2–7`), **26 caractères** par groupes de cinq (`ABCDE-FGHIJ-KLMNO-PQRST-UVWXY-Z`). L'iPhone, « Saisir un code », demande ces deux champs. La lecture **ignore la casse, les espaces et les tirets** ; tout autre caractère refuse le code. Vecteurs : tableau `manualCode`.

Ici l'iPhone **ne connaît pas l'empreinte du Mac** avant la connexion : il enregistre celle que le Mac présente, puis vérifie la preuve du Mac (`pair.accept`). **C'est suffisant** parce que la preuve couvre les deux empreintes (§4.4) : un intercepteur qui présente son propre certificat à l'iPhone ne peut pas produire une preuve juste, faute du secret. Le QR ajoute seulement un refus **plus tôt** (avant tout envoi).

### 4.4 La preuve : le HMAC de la transcription

Tout est en octets. Un champ est écrit **précédé de sa longueur sur 2 octets, grand-boutiste** (`lp(x)`) ; une chaîne est de l'UTF-8. La clé du HMAC est le **secret brut de 16 octets**.

```
transcription(étiquette, champs…) = lp(utf8(étiquette)) ‖ lp(champ₁) ‖ lp(champ₂) ‖ …

preuveDemande = HMAC-SHA-256(secret, transcription("lucium-sync/1 pair-request",
                   empreinteMac, empreinteIphone, nonceMac, nonceIphone, utf8(idIphone)))

preuveAccord  = HMAC-SHA-256(secret, transcription("lucium-sync/1 pair-accept",
                   empreinteMac, empreinteIphone, nonceMac, nonceIphone, utf8(idMac), utf8(idIphone)))
```

Les empreintes sont les 32 octets, les nonces les 16 octets. Les preuves s'écrivent en base64url sans remplissage (43 caractères). Elles couvrent **les deux empreintes** : c'est ce qui lie la preuve à *cette* connexion TLS. Deux étiquettes **différentes** empêchent qu'une preuve de demande serve de preuve d'accord. Les vecteurs recalculent ces valeurs à la main de chaque côté (`proof`, avec `mutations` : changer un seul champ change la preuve).

**Renfort envisagé, non retenu en v1** : lier aussi la preuve au canal TLS par l'exportateur de clés (`exportKeyingMaterial` côté Node, `sec_protocol_metadata_create_secret_with_context` côté Apple). Les deux existent (**vérifié** dans `tls.d.ts` et `SecProtocolMetadata.h`) et **le même exportateur donne les mêmes 32 octets des deux côtés** (essayé : Node client et serveur sur la boucle locale ; **Node ↔ Apple non essayé**). Les empreintes déjà dans la preuve suffisent contre un intercepteur ; le renfort ne s'ajoute que si l'essai Node ↔ Apple réussit, par une version 2 du protocole.

### 4.5 Vie du secret

| État | Quand | Une demande reçue répond |
|---|---|---|
| **ouvert** | de la création du QR à l'un des cas suivants | (la preuve est vérifiée) |
| **brûlé** | la première preuve **juste**, quel que soit le sort de la demande ensuite | `pairing-used` |
| **expiré** | 120 000 ms écoulés (« moins de 120 000 » est ouvert) | `pairing-expired` |
| **verrouillé** | **5 preuves fausses** | `pairing-locked` |
| **fermé** | la personne ferme la feuille, coupe l'interrupteur, ou le Mac se verrouille | `pairing-closed` |

L'ordre de contrôle d'une demande est : fermé, verrouillé, expiré, brûlé, **puis** la preuve. Une preuve fausse **ne brûle pas** le secret (un voisin ne doit pas pouvoir empêcher l'appairage en frappant à la porte), mais **cinq** le verrouillent ; la personne affiche un nouveau QR. Un secret n'est **jamais réutilisé** : chaque « Ajouter un iPhone » en tire un nouveau. Vecteurs : tableau `secretLifecycle`.

## 5. Retrouver l'autre appareil

Les adresses d'un Mac changent (DHCP, autre Wi-Fi). L'iPhone garde **une liste de candidats** pour chaque Mac appairé et les essaie **dans l'ordre, l'un après l'autre** (3 s au plus chacun) :

1. **le nom `.local`** du Mac, que le système résout par mDNS ;
2. les **dernières adresses connues** (jusqu'à 4) ;
3. **[Q1] aucun Bonjour en v1.** Si le chef retient un annonceur Bonjour (option B de [Q1]), il vient ici, sans changer le reste.

À chaque `hello` (§8), **le Mac renvoie ses adresses et son nom `.local` actuels** (`hosts`, au plus 4, chacun passé par le filtre du §6.2) : l'iPhone remplace sa liste. Si tout échoue, l'iPhone dit « Mac introuvable » et propose de **rescanner le QR** (nouvel appairage seulement si l'empreinte a changé).

**Ce qui est vérifié** : rien sur le réseau (aucun appareil, aucun Wi-Fi ici). **À vérifier sur appareil** : (1) que `NWConnection` vers un nom `.local` le résout bien par mDNS sur un iPhone ; (2) que `os.hostname()` d'Electron rend bien un nom en `.local` sur un Mac réel (sinon le Mac n'écrit que ses adresses) ; (3) que **Bonjour n'est pas nécessaire** pour (1) : la documentation lue (`NSLocalNetworkUsageDescription`, `NSBonjourServices`, `docs/ios.md` §13.2) parle de Bonjour pour **découvrir**, pas pour résoudre un nom `.local`.

**Autorisation du réseau local (iPhone).** `NSLocalNetworkUsageDescription` est obligatoire pour toute application qui se connecte au réseau local (documentation d'Apple lue, `docs/ios.md` §13.2). Texte en français et en anglais dans `InfoPlist.xcstrings`. Si la personne **refuse**, la séance échoue sans pouvoir le dire par un code précis : l'application affiche « Lucium n'a pas le droit d'utiliser le réseau local : Réglages d'iOS › Lucium » (le code d'erreur exact de `Network.framework` : **à vérifier**). `NSCameraUsageDescription` est requise pour le QR ; **sans** clé `NSBonjourServices` en v1 (inutile sans annonceur).

**Scanner un QR sur iPhone** : `AVMetadataObject.ObjectType.qr` existe (`AVMetadataObjectTypeQRCode` dans `AVMetadataObject.h`, **vérifié**) ; `VisionKit` (`DataScannerViewController`) est l'autre voie, **non lue** : à choisir par la carte 445.

## 6. Transport

### 6.1 Côté Mac : l'écoute

| Réglage | Valeur |
|---|---|
| Quand | **[Q5]** **seulement pendant une fenêtre de synchronisation**, que la personne ouvre sur le Mac par le bouton « Ouvrir la synchronisation » de la page Réglages (ou en ouvrant une fenêtre d'appairage, §4.1) et qui **se ferme** : au bout de **10 minutes**, à la fermeture de la page Réglages, par « Fermer », quand l'interrupteur est coupé, ou quand l'application se verrouille (`lock.ts`). **Hors de toute fenêtre, aucun port n'est ouvert.** La page dit « Ouverte : il reste 8:40 » ; un appui sur « Prolonger » repart pour 10 minutes. C'est la lecture littérale de `docs/ios.md` §13.2 point 6 |
| Où | l'adresse non spécifiée (toutes les interfaces), **mais** chaque connexion dont l'adresse source n'est pas locale (§6.2) est **fermée avant toute poignée de main** |
| TLS | `minVersion: 'TLSv1.3'` (une version 1.2 n'est jamais proposée), `requestCert: true`, `rejectUnauthorized: false` (le certificat est auto-signé : la vérification de l'empreinte est faite par le code du projet), ALPN `lucium-sync/1` |
| Limites | **4 connexions** de synchronisation à la fois, plus **1** d'appairage ; poignée de main en **10 s** ; **60 s** sans trame = fermeture ; séance de **10 min** au plus ; **10 connexions refusées en 60 s** depuis la même adresse = cette adresse est refusée pendant 60 s (table de 256 adresses au plus) ; **la place d'appairage n'est pas gardée par une connexion muette** : tant qu'une connexion n'a pas envoyé son `pair.request` elle est à l'abri 3 s, puis le prochain inconnu la prend, et la muette est coupée et comptée contre son adresse (une qui a envoyé sa demande n'est jamais déplacée) |
| Premier octet | **rien n'est lu** d'une connexion tant que l'empreinte du certificat du client n'est pas dans `peers` (ou qu'une fenêtre d'appairage est ouverte, auquel cas seuls les messages d'appairage sont admis) |

**Vérifié** (essayé : Node 26.13 sur la boucle locale, `127.0.0.1`, avec deux certificats écrits à la main) : un serveur `tls.createServer({ requestCert: true, rejectUnauthorized: false, minVersion: 'TLSv1.3', ALPNProtocols })` reçoit le certificat du client ; `socket.authorized` vaut **`false`** avec l'erreur `DEPTH_ZERO_SELF_SIGNED_CERT` (le code du projet doit donc **toujours** comparer l'empreinte lui-même) ; `socket.getProtocol()` rend `TLSv1.3` ; `getPeerX509Certificate().raw` donne les octets dont le SHA-256 est l'empreinte (et `getPeerCertificate().fingerprint256` donne la même valeur une fois les deux-points retirés et les lettres mises en minuscules) ; un client **inconnu** va au bout de la poignée de main avant que le serveur ne le ferme ; un client qui n'offre que `lucium-sync/2` échoue avec `ERR_SSL_TLSV1_ALERT_NO_APPLICATION_PROTOCOL`. **À vérifier dans Electron 45.2.1** : tout cela est mesuré avec Node 26.13, pas avec le Node d'Electron (version non lue). **À vérifier** aussi : filtrer par adresse **avant** la poignée de main, avec un écouteur `connection` sur `tls.Server` ou, sinon, `net.createServer` suivi de `new tls.TLSSocket(socket, { isServer: true, … })`.

`docs/ios.md` §13.2 cite `checkServerIdentity` : il compare un **nom d'hôte** et n'est pas l'outil pour une empreinte ; avec un certificat auto-signé et `rejectUnauthorized: false`, la vérification se fait à l'événement `secureConnection` (serveur) ou `secureConnect` (client), avant d'écrire ou de lire un octet.

### 6.2 Filtre d'adresses : un réseau, pas Internet

Une adresse est **locale** si elle est dans :

| Famille | Plages |
|---|---|
| IPv4 | `10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`, `169.254.0.0/16` (lien local), `100.64.0.0/10` (partagée : les VPN de type maillage s'y trouvent) |
| IPv6 | `fc00::/7` (locale unique), `fe80::/10` (lien local) ; une adresse IPv4 écrite en IPv6 (`::ffff:a.b.c.d`) suit la règle de l'IPv4 |
| Nom | un nom qui **finit par `.local`** (au moins une étiquette devant) |

**Tout le reste est refusé** : adresse publique, `127.0.0.0/8` et `::1` (la boucle locale n'est ouverte que par un réglage d'essai, jamais en production), `0.0.0.0`, la diffusion, un nom autre que `.local` (un nom DNS peut désigner n'importe quelle machine). Les plages privées sont celles que le README donne déjà pour Ollama. Le filtre s'applique : à l'**adresse source** d'une connexion entrante (Mac), à **chaque hôte** d'un QR, d'une saisie et d'un `hosts` reçu (iPhone). Vecteurs : tableau `addressPolicy`.

### 6.3 Les certificats : écrits à la main [Q6]

Ni Node ni les API d'Apple ne fabriquent un certificat : **vérifié** (aucune fonction de création dans `crypto.d.ts` et `tls.d.ts` ; `SecIdentityCreateWithCertificate` ne signe pas, il associe). Le projet écrit donc le **DER** lui-même, des deux côtés, selon **un seul profil** :

| Élément | Valeur |
|---|---|
| Version | v3 (`A0 03 02 01 02`) |
| Numéro de série | 16 octets aléatoires, premier octet entre `0x01` et `0x7F` (entier positif, DER minimal) |
| Signature | `ecdsa-with-SHA256` (1.2.840.10045.4.3.2), **sans paramètres** |
| Émetteur et sujet | identiques : un seul nom `CN=lucium-sync` (UTF8String). **Aucun nom de personne ou d'appareil** : TLS 1.3 chiffre le certificat dans la poignée de main, mais il ne doit rien dire de toute façon |
| Validité | `700101000000Z` (UTCTime) à `99991231235959Z` (GeneralizedTime) |
| Clé | `SubjectPublicKeyInfo` P-256, point non compressé |
| Extensions | **aucune** |

**Essayé** : un certificat construit sur ce profil (211 octets à signer pour la clé P-256 d'essai ; 302 octets au total) est lu par `crypto.X509Certificate` de Node (sujet, validité, clé ; `verify` de sa propre signature : vrai) et par `SecCertificateCreateWithData` de Security.framework de ce Mac (clé P-256 de 256 bits lue, mêmes octets, même SHA-256) ; une séance TLS 1.3 mutuelle entre deux de ces certificats s'établit. **Non essayé** : le chargement de l'identité par `Network.framework` sur un appareil, et la lecture par Electron 45.2.1.

Les octets à signer d'un exemple sont figés dans `sync-pairing-vectors.json` (`certificate`) : **un changement de profil d'un côté fait échouer le test de l'autre**. La signature ECDSA n'est pas déterministe : le vecteur fige donc les octets **à signer** et un certificat complet d'exemple, pas une signature attendue. Risque assumé : du code DER à nous. Il est borné : un certificat mal formé fait échouer l'appairage, il ne l'affaiblit pas.

### 6.4 Côté iPhone

`NWConnection(host:port:using:)` avec `NWParameters(tls:tcp:)` (les deux initialiseurs sont dans l'interface Swift du SDK, **vérifié**). Les options TLS passent par `NWProtocolTLS.Options.securityProtocolOptions`, **vérifié** (`Network.swiftinterface`) ; les fonctions utilisées existent dans `SecProtocolOptions.h` (iOS 13 ou avant) :

| Besoin | Fonction |
|---|---|
| TLS 1.3 au moins | `sec_protocol_options_set_min_tls_protocol_version(options, .TLSv13)` |
| Présenter son identité | `sec_protocol_options_set_local_identity` |
| ALPN | `sec_protocol_options_add_tls_application_protocol(options, "lucium-sync/1")` |
| Vérifier l'empreinte du Mac | `sec_protocol_options_set_verify_block` : le bloc lit la chaîne du pair (`sec_protocol_metadata_access_peer_certificate_chain`), calcule le SHA-256 du premier certificat et **répond oui seulement s'il est épinglé** (ou, en saisie de code, le garde pour la vérification de la preuve) ; il **ne délègue pas** à l'évaluation du système |
| Un serveur exige un client | `sec_protocol_options_set_peer_authentication_required` : par défaut vrai pour un client, faux pour un serveur (l'en-tête le dit) ; côté Mac, c'est `requestCert` |

Le **comportement exact** du bloc de vérification face à un certificat auto-signé sur un appareil (code d'erreur, moment) : **à vérifier** par la carte 445.

## 7. Messages

### 7.1 Trame et enveloppe

Une **trame** = **4 octets** (longueur du contenu, entier non signé, grand-boutiste) puis le contenu : **un objet JSON** en UTF-8.

- La longueur est lue **avant** le contenu : `0` ou plus de **1 048 576 octets (1 Mio)** ferme la connexion (`bad-frame`, `too-large`) **sans lire** le contenu.
- Le contenu est du JSON **hostile** : un objet (pas un tableau, pas un nombre), profondeur **32 au plus**, **aucune clé `__proto__`** à aucune profondeur (une copie `obj[clé] = valeur` la prendrait pour le prototype), **aucun genre, identifiant, nom de liste ou identifiant de liste qui porte le nom d'un membre de `Object.prototype`** (`__proto__`, `constructor`, `toString`, `hasOwnProperty`…) **ou `prototype`** : écrit comme *valeur* (`"kind": "__proto__"`), un tel nom fait lire `record[kind] ??= {}` sur le prototype lui-même, et l'entité suivante s'écrit alors dans le prototype de tous les objets du processus (essayé par la carte 448 ; refusé en `bad-message` à la lecture du message, et par `parseSnapshot` pour un fichier ; la lecture Swift n'en a pas besoin, un dictionnaire n'a pas de prototype : un Mac refuse donc un nom qu'un iPhone accepterait, ce qui ne joue que contre un appareil hostile), **toute clé en forme de normalisation Unicode C (NFC)** (un dictionnaire Swift prend pour **une seule** clé « é » écrit avec un ou avec deux caractères, JavaScript en garde deux : avec des clés toutes en NFC, deux clés distinctes d'un côté le sont de l'autre ; vaut aussi pour les noms de genre, d'identifiant, de champ et de liste d'un instantané, §8.3), nombres **finis** ; ceux de 1e21 et plus, de moins de 1e-6 (hors zéro), sont refusés, et `-0` se lit `0` (pour que Swift et JavaScript écrivent les mêmes chiffres, §8.4).
- Toute chaîne : **64 Kio** au plus ; les champs connus ont les bornes de leur type (§7.3).

L'**enveloppe** est plate :

```json
{ "v": 1, "t": "hello", "n": 1, … les champs du type … }
```

| Champ | Règle |
|---|---|
| `v` | entier ; **doit valoir la version négociée** par ALPN (§7.2) |
| `t` | le type, parmi ceux du §7.3 ; un **autre type** à la version négociée : `unknown-type` |
| `n` | **numéro de message** de l'expéditeur, **par sens**, à partir de **1**, **+1 à chaque message** (l'`error` compte) ; autre valeur : `bad-sequence`, fatal |
| autres champs | ceux du type ; un **champ inconnu** d'un type connu est **ignoré** (et ne traverse pas : seules les *entités* gardent leurs champs inconnus, §11.6) ; un champ **manquant** ou **de mauvais type** : `bad-message` |

### 7.2 Versions

La version du protocole est **négociée par ALPN** : le Mac offre `lucium-sync/1` ; l'iPhone propose la liste de ce qu'il parle. Pas de protocole commun : la poignée de main échoue (essayé côté Node : `ERR_SSL_TLSV1_ALERT_NO_APPLICATION_PROTOCOL`) et l'iPhone dit « Les deux Lucium ne parlent pas la même version : mettez-les à jour ». `v` dans l'enveloppe est un garde : une valeur autre que la version négociée donne `unsupported-version` (avec `supported: [1]` dans l'`error`). Une version **majeure** change quand un message cesse d'être compris par l'ancienne ; ajouter un champ ou une catégorie **ne change pas** la version (§7.1 : les champs inconnus sont ignorés).

### 7.3 Types

| `t` | Sens | Champs (tous requis sauf mention) |
|---|---|---|
| `hello` | les deux, **première** trame d'une séance | `device` `{id, name, platform}` (`platform` : `"mac"` ou `"ios"`) ; `nonce` (16 octets, base64url) ; `categories` (liste d'identifiants du §10.1, 0 à 8) ; `baseHash` (64 hex, ou `null` : pas de base) ; `stateVersion` (entier) ; `appVersion` (chaîne ≤ 32) ; `now` (ms depuis 1970, pour la dérive de l'horloge, §9.3) ; `hosts` (Mac seulement, 0 à 4 hôtes locaux) |
| `pair.challenge` | Mac → iPhone, **première** trame d'un appairage | `nonce` |
| `pair.request` | iPhone → Mac | `device` ; `nonce` ; `proof` (§4.4) |
| `pair.accept` | Mac → iPhone | `device` ; `proof` ; `hosts` |
| `snapshot.part` | les deux | `part` (entier, de 0), `parts` (total, 1 à 4096), `entities` (0 à 500 objets du §8.3), `tombstones` (liste, facultative), `order` et `orderStamps` (objets, facultatifs), `withheld` (liste d'identifiants d'espaces mis de côté, facultatif : [Q4], §18) |
| `snapshot.end` | les deux, après la dernière partie | `entityCount` (entier) ; `digest` (64 hex, §8.4) |
| `open-tabs` | les deux, **si** la catégorie `openTabs` est commune | `items` : 0 à 200 `{id, spaceId, url, title, lastActiveAt}` (adresse ≤ 4096 octets, titre ≤ 300) |
| `result` | les deux, après les deux `snapshot.end` | `digest` du résultat de la fusion |
| `commit` | les deux, après l'application locale | `digest` (le même) |
| `unpair` | l'un des deux | — : « je t'oublie » (§12) |
| `error` | l'un des deux | `code` (§7.6) ; `fatal` (booléen) ; `supported` (liste d'entiers, facultatif) ; `detail` (chaîne ≤ 200, **anglais, pour les journaux, jamais montrée**) |
| `bye` | l'un des deux, dernière trame | — |

### 7.4 Ordre

Une connexion est dans **une phase** à la fois, et un message hors phase est un `bad-message` fatal :

- **Appairage** : `pair.challenge` (Mac) → `pair.request` (iPhone) → `pair.accept` (Mac) **ou** `error` → `bye`. Rien d'autre.
- **Séance** : `hello` des deux côtés ; puis, dans chaque sens, une ou plusieurs `snapshot.part`, éventuellement un `open-tabs`, puis `snapshot.end` ; quand **les deux** `snapshot.end` sont reçus, `result` des deux côtés ; si les `digest` sont égaux, chacun applique, puis `commit` ; `bye`. `unpair` et `error` sont permis après `hello`.

Il n'y a **pas d'accusé par message** : TCP et TLS livrent dans l'ordre et sans perte ou la connexion tombe ; l'**exhaustivité** est contrôlée par `parts`, `entityCount` et `digest`. L'accusé de la **séance** est `commit` : l'état « À jour » ne s'affiche que quand le `commit` de l'autre est reçu.

### 7.5 Bornes en un tableau

| Borne | Valeur |
|---|---|
| Trame | 1 048 576 octets |
| Instantané reçu (somme des contenus d'une séance) | 33 554 432 octets (**32 Mio**) |
| Entités d'un instantané | 100 000 |
| Entités par partie | 500 |
| Parties | 4096 |
| Profondeur JSON | 32 |
| **Valeurs JSON** (chaque objet, liste, texte, nombre, booléen et `null` compte pour un) | **150 000 par trame, 2 000 000 par connexion** : `too-large` au-delà. Les bornes en octets ne bornent pas le travail : 32 Mio de `[[],[],…]` font plus de 10 millions de valeurs, plus d'un gigaoctet et dix secondes de processus principal arrêté (essayé par la carte 448). Un état réel fait une vingtaine de valeurs par kilo-octet de trame ; 100 000 entités de quinze valeurs en font un million et demi. **Le Swift doit appliquer la même borne** (carte 452) |
| Chaîne | 65 536 octets |
| Nom d'appareil | 80 caractères ; identifiant 1 à 64 |
| Onglets annoncés | 200 |
| Connexions | 4 + 1 d'appairage |
| Poignée de main / silence / séance | 10 s / 60 s / 10 min (**des deux côtés** : `SyncSessionClient.run` coupe la séance de l'iPhone à 10 minutes, `SyncLimits.sessionMaximum`) |
| Séances automatiques | une toutes les 15 s au plus |
| Appairage | 120 s ; 5 preuves fausses ; 60 s pour confirmer |

Une borne dépassée **ferme la connexion** avec le code qui convient (`too-large`, `rate-limited`, `timeout`…) ; ce que l'autre côté a déjà envoyé n'est **jamais appliqué à moitié** : l'application (§8.5) n'a lieu qu'après la vérification des résumés.

### 7.6 Codes d'erreur

Le même catalogue des deux côtés. Chaque code a un texte d'interface (§13) et dit s'il est **fatal** (la connexion se ferme).

| Code | Fatal | Sens |
|---|---|---|
| `bad-frame`, `too-large` | oui | longueur nulle ou trop grande |
| `bad-message`, `unknown-type`, `bad-sequence` | oui | message mal formé, d'un type inconnu, ou hors numéro / hors phase |
| `unsupported-version` | oui | version de protocole incompatible |
| `invalid-code` | oui | QR ou code à saisir illisible (côté iPhone, avant toute connexion) |
| `not-paired` | oui | l'empreinte n'est pas dans la liste, hors fenêtre d'appairage |
| `fingerprint-mismatch` | oui | l'empreinte ne correspond pas à celle attendue, ou l'identifiant ne correspond pas à l'empreinte |
| `bad-proof` | oui | preuve d'appairage fausse |
| `pairing-expired`, `pairing-used`, `pairing-locked`, `pairing-closed`, `pairing-refused` | oui | états du secret (§4.5) ; refus de la personne |
| `rate-limited`, `timeout`, `busy` | oui | trop de connexions ou d'essais ; silence ; une autre séance est en cours avec cet appareil |
| `locked` | oui | le Mac est verrouillé |
| `state-too-new` | oui | l'état de l'autre est d'un format plus récent que celui que cet appareil sait écrire |
| `truncated` | oui | `parts`, `entityCount` ou `digest` d'un instantané ne correspondent pas |
| `divergence` | oui | les deux `result` diffèrent : **rien n'est écrit** |
| `clock-skew` | **non** | avertissement : les horloges diffèrent de plus de 5 minutes (§9.3) |
| `internal` | oui | échec local (disque plein, fichier illisible) |

Vecteurs : tableaux `frames`, `messages`, `sequences` de `sync-message-vectors.json`.

## 8. Une séance de synchronisation

### 8.1 Quand

L'iPhone ouvre une séance : au **lancement**, au **retour au premier plan** (5 s de délai pour regrouper), après un changement local (30 s de délai), et sur **« Synchroniser maintenant »**. Jamais plus d'une séance toutes les 15 s. L'application **suspendue** ne synchronise pas (`docs/ios.md` §13.1). Pas de séance si la synchronisation est coupée, si aucun appareil n'est appairé, ou si l'application est **verrouillée** (`locked`). **Le Mac n'écoute que pendant sa fenêtre (§6.1)** : une connexion refusée n'est **pas** une erreur, c'est l'état « En attente » (§13.3), avec la phrase « Ouvrez la synchronisation sur le Mac » ; l'iPhone n'insiste pas avant son prochain déclencheur.

### 8.2 Les entrées

1. **Figer** : chaque appareil prend un **instantané** de sa vue synchronisable (§10), restreinte aux **catégories communes**, et le garde en mémoire. Les modifications que la personne fait pendant la séance **ne changent pas** cet instantané.
2. **`hello`** : chacun envoie le sien. Les catégories sont l'**intersection** (une catégorie ne passe que si les deux l'ont cochée). Si `baseHash` diffère, ou est `null` d'un côté : **pas de base commune**, la fusion se fait à base vide (§11.8). Si l'`stateVersion` de l'autre est **supérieure** à celle que l'appareil sait écrire : `state-too-new`.
3. **`snapshot.part`** : chacun envoie son instantané complet (§8.3), puis **`snapshot.end`**.
4. **`open-tabs`**, entre `hello` et `snapshot.end`, si la catégorie `openTabs` est commune (§10.4).

L'envoi de l'instantané **complet** à chaque séance est un choix de simplicité (quelques milliers d'entités tiennent en quelques centaines de Kio). Un envoi par différences, par résumé de chaque entité, pourra s'ajouter plus tard par une capacité de plus dans `hello` ; il n'est pas dans la v1.

### 8.3 L'instantané

L'instantané est :

```json
{
  "entities": { "<genre>": { "<id>": { "fields": { … }, "stamps": { "<champ>": "<marque>" } } } },
  "tombstones": { "<genre>": { "<id>": "<marque>" } },
  "order": { "<liste>": ["<id>", …] },
  "orderStamps": { "<liste>": "<marque>" }
}
```

Genres : `space`, `folder`, `tab` (épinglés seulement), `favorite`, `archived`, `setting`. Sur le fil, les entités voyagent en **éléments** `{ "kind", "id", "fields", "stamps" }` répartis dans les `snapshot.part`. Un même `(kind, id)` **deux fois** dans un instantané est un `bad-message`. `fields` contient **les champs synchronisés et tous les champs inconnus** de l'entité (§10.2, §11.6) ; `stamps` a une marque par champ, **y compris** pour un champ qui a été retiré (absent de `fields`) ; **un champ absent dont la marque serait « zéro » n'a pas d'entrée** (elle ne dirait rien, et deux appareils ne l'écriraient pas pareil). **Sur le fil**, chaque `snapshot.part` porte ses entités, une liste de pierres tombales `{ "kind", "id", "stamp" }` et, comme objets, les morceaux de `order` et d'`orderStamps` qu'elle apporte ; l'instantané assemblé est celui de la forme ci-dessus.

### 8.4 Forme canonique et résumé

Le `digest` d'un instantané est le **SHA-256, en hexadécimal minuscule, de sa forme canonique**. La forme canonique est celle de la **RFC 8785** (JCS) : UTF-8, aucune espace, clés des objets triées par **unités de code UTF-16**, chaînes et nombres écrits comme `JSON.stringify` de JavaScript. Elle est choisie parce qu'elle est une norme et que le TypeScript n'a rien à écrire de plus. Le Swift devra imiter les chiffres de JavaScript ; **c'est pourquoi les nombres du §7.1 sont bornés** (aucun exposant, aucun `-0`). Les vecteurs `canonical` contiennent les cas difficiles (accents, clé hors du plan multilingue de base, nombres, échappements).

### 8.5 Fusion, comparaison, application

1. Chacun fusionne **localement** : `fusion(base, local, distant)` (§11), même fonction, mêmes entrées ; résultat = **l'instantané fusionné**, ses conflits, ses suppressions.
2. Chacun envoie **`result`** avec le `digest` de l'instantané fusionné. **Différents** : `divergence`, **rien n'est écrit** de part et d'autre ; la personne voit « Les deux appareils ne s'accordent pas » ; c'est un bogue à signaler, jamais un état normal.
3. **Égaux** : chacun **applique** le résultat à son état :
   - il calcule le **patch** entre son instantané figé et le fusionné ;
   - il l'applique à l'état **courant** par le réducteur (`src/shared/sidebar.ts` côté Mac : une action `sync/apply`, **une seule**, qui ne touche que ce que le patch nomme) ; une entité que la personne a changée **depuis** l'instantané garde son changement local : la séance suivante le propagera ;
   - il **nettoie** ce qui entre comme à la lecture d'un fichier (`parseStateText`, `state-clean.ts` : chaque champ reçu est reborné ; une entité invalide est **écartée**, comptée et journalisée, jamais fatale) ; une adresse reçue n'est acceptée que si les règles de lecture de l'état l'acceptent (la carte 444 nomme les fonctions de `state-clean.ts` qui s'en chargent) ;
   - il met à jour la **base** de cet appareil appairé (= l'instantané fusionné), **dans la même écriture** que l'état ;
   - il envoie **`commit`**.
4. La séance est **terminée** quand le `commit` de l'autre est reçu. Si la connexion tombe avant : « Échange interrompu » ; la base et l'état sont **déjà cohérents** localement ; à la séance suivante, `baseHash` peut différer, et le repli du §11.8 s'applique sans perdre de suppression (les pierres tombales servent à ça).

### 8.6 Ce qui n'est jamais exécuté

Un message ne contient ni code, ni script, ni commande. Une adresse reçue **n'est ouverte** que si la personne la touche. Une entité reçue ne change jamais un champ que la liste du §10.2 ne nomme pas comme synchronisé. **Les Retouches ne voyagent pas du tout** (§10.5).

## 9. Rejeu et horloges

### 9.1 Rejeu

| Menace | Réponse |
|---|---|
| Rejouer un message d'une séance dans une autre | Impossible sans les clés de la séance : TLS 1.3 chiffre et authentifie chaque enregistrement, les clés sont propres à la connexion |
| Rejouer **un QR** | le secret est **brûlé** à la première preuve juste ; expiré à 120 s ; verrouillé à 5 preuves fausses (§4.5) |
| Rejouer **une preuve** d'appairage | La preuve contient le **nonce du Mac**, tiré à chaque connexion (`pair.challenge`) : une preuve ne vaut que pour la connexion qui l'a vue |
| Un doublon, un message perdu ou réordonné par un bogue | le **numéro `n`** (§7.1) : écart = `bad-sequence`, fatal. Défense en profondeur : TLS fournit déjà l'ordre |
| Rejouer **une ancienne séance entière** | Même chose : impossible sans clé ; et une fusion **idempotente** (§11.9) rendrait un rejeu inoffensif |

### 9.2 Horloge hybride et marques

Chaque changement d'un champ porte une **marque** : une chaîne de forme

```
<ms sur 13 chiffres>-<compteur sur 4 hexadécimaux minuscules>-<id de l'appareil>
```

(par exemple `1790000000123-0003-AbCd…`), **comparée comme un texte, octet par octet**. La marque « zéro », celle d'un champ sans marque connue, est la chaîne `"0"`, plus petite que toute autre. Les **marques** sont fabriquées par une **horloge logique hybride** (HLC) : `ms` = le plus grand de l'heure du jour, de la dernière marque émise et de la dernière marque reçue ; le compteur compte les marques d'une même milliseconde. Une marque trouve son champ **à l'écriture de l'état** : l'appareil compare l'état avant et après (par entité d'abord, par champ ensuite) et marque ce qui a changé, **au moment où il le voit** (au plus 300 ms après le geste : le délai de l'écriture de `StateStore`). Ce n'est donc pas l'heure d'une synchronisation, mais celle du geste, à une fraction de seconde près.

L'égalité de deux marques est impossible entre deux appareils (l'identifiant d'appareil y figure) ; **à égalité de `ms` et de compteur, l'identifiant le plus grand (ordre des octets) gagne**. C'est le « départage par l'identifiant d'appareil » de `docs/ios.md` §13.4. **Deux marques identiques** (le cas de deux champs jamais marqués, tous deux « zéro ») : la valeur dont la **forme canonique** (§8.4) est la plus grande gagne, les deux textes étant comparés **par unité de code UTF-16**, comme les clés de la forme canonique (et non par octet UTF-8 : un caractère hors du plan multilingue de base, « 😀 », est alors **plus petit** que « ～ » U+FF5E) ; c'est arbitraire, mais pareil des deux côtés. Un vecteur de fusion le tient. Les vecteurs `stamps` fixent l'ordre, `-` et `_` compris.

### 9.3 Dérive

- Les deux `now` d'un `hello` s'écartent de plus de **5 minutes** : `clock-skew`, avertissement **non fatal**, affiché une fois (« L'horloge de … diffère de plus de 5 minutes de la vôtre : en cas de conflit, le choix du plus récent peut se tromper »).
- Une marque reçue **plus de 7 jours dans le futur** (par rapport à l'heure locale) fait **écarter l'entité** (comptée et journalisée, jamais fatale) : un appareil à l'heure fausse ne gagne pas tous les conflits pour toujours. **Il en va de même pour une pierre tombale et pour une liste avec sa marque d'ordre** : elles sont écartées de la même façon, **de ce qui vient de l'autre appareil comme de ce que cet appareil lui envoie** (avec l'heure de l'autre pour ses marques, §22). Sans cela, une seule pierre tombale datée de l'an 2286 passait, supprimait tout ce qu'elle nomme, et tirait l'horloge des marques de l'appareil au-delà de ce que tout autre accepte : ses marques suivantes étaient alors refusées par l'autre appareil, pour toujours (essayé par la carte 448). **Le Swift n'applique pas encore cette règle** : le corps de séance de l'iPhone (carte 452) doit l'écrire, sinon un iPhone qui garderait une marque du futur ferait diverger les deux résumés (`divergence`, rien n'est écrit). **La fusion elle-même ne lit jamais l'heure du jour** : c'est une fonction pure de ses entrées (§11.1), ce qui la rend identique des deux côtés.
- La fenêtre d'appairage utilise une horloge **monotone** (§4.1) ; aucun contrôle de sécurité ne repose sur l'heure du jour.

## 10. Ce qui est synchronisé, et ce qui ne l'est jamais

### 10.1 Les catégories

La personne coche ce qui voyage ; **une catégorie ne passe que si les deux appareils l'ont cochée**. Valeurs par défaut **[Q2]** : **seule `structure` est cochée**, les trois autres sont au choix de la personne, chacune avec sa phrase.

| Identifiant | Contenu | Fusionné ? | Défaut |
|---|---|---|---|
| `structure` | espaces, dossiers, favoris, onglets **épinglés** | oui | **coché** |
| `settings` | les huit réglages de §10.3 | oui | **non coché** |
| `archive` | onglets archivés (au plus **500 par espace**, les plus récents) | oui | **non coché** |
| `openTabs` | annonce des onglets ouverts (« Reprise », §10.4) | **non** (jamais écrits dans l'état de l'autre) | **non coché** |

Réservées, **pas dans la v1** : `library` (signets, « À lire plus tard » ; l'iPhone ne les a pas encore, `docs/ios.md` §4.1), `sessions`. Un genre ou un champ **inconnu** d'une version plus récente traverse sans être lu (§11.6).

### 10.2 Classement des champs

Chaque champ d'un genre est **une et une seule** de ces trois classes :

| Classe | Sens |
|---|---|
| **synchronisé** | fusionné champ par champ (§11) |
| **graine** | copié **à la création** de l'entité sur l'autre appareil, puis **local** : l'autre appareil le change sans qu'il revienne |
| **local** | jamais envoyé |

| Genre | Synchronisé | Graine | Local |
|---|---|---|---|
| `space` | `id`, `name`, `emoji`, `theme`, `profileId`, `hideHeader`, `iconKind`, `iconLetter`, `iconColor`, `iconRound` | — | `image`, `background` (des fichiers qui n'existent que sur l'appareil), `webPanels` |
| `folder` | `id`, `spaceId`, `name`, `parentId`, `atBottom`, `atTodayStart`, `noWake`, `icon` | `collapsed` | `live` (le flux d'un dossier vivant se télécharge sur l'appareil) |
| `tab` (épinglé) | `id`, `spaceId`, `pinned`, `anchorUrl`, `customTitle`, `icon`, `folderId`, `keepAwake` | `url`, `title` (la page où l'on est et son titre changent à chaque navigation : bruit) | `image`, `faviconUrl`, `deadKept`, `autoReload`, `container`, `windowKey`, `openerId`, `parentId`, `treeCollapsed`, `favoriteId`, `createdAt`, `lastActiveAt`, `private` |
| `favorite` | `id`, `url`, `title`, `profileId` | — | `faviconUrl` (un cache) |
| `archived` | `id`, `spaceId`, `url`, `title`, `archivedAt`, `source`, `pinned`, `anchorUrl`, `folderId` | — | `history`, `container` |
| `setting` | `value` | — | — |

Un **test de classement** de la carte 444 énumère **tous les champs** de `Space`, `Folder`, `TabItem`, `Favorite` et `ArchivedTab` de `model.ts` et **échoue** si l'un n'est dans aucune classe : un champ ajouté au Mac sans décision de synchronisation ne part pas par défaut. Les vecteurs (`fieldClasses`) donnent la table ci-dessus sous une forme lisible par un test, et le test de contrat **vérifie que chaque champ nommé existe** dans `model.ts`. Ce que la table ne classe pas (un champ **inconnu** d'une version plus récente) est **synchronisé comme opaque**, parce qu'un appareil qui le connaît l'a écrit pour être partagé ; ce choix est valable seulement pour les **entités**, jamais pour les réglages (liste fermée, ci-dessous).

### 10.3 Les réglages : une liste fermée

Un réglage ne se synchronise **que s'il est dans cette liste** (rien n'est « tous sauf ») :

| Clé | Pourquoi |
|---|---|
| `httpsUpgrade`, `sendGpc`, `stripTrackingParams`, `stripCopiedLinks`, `protectionBaseline` | les cinq règles de vie privée que **l'iPhone lit déjà** avec les noms du Mac (`docs/ios.md` §7.1) |
| `autoArchiveHours` | l'iPhone applique la même règle (12 h par défaut) |
| `searchUrlTemplate` | le moteur de recherche (l'iPhone le lit) ; reçu seulement s'il contient `%s` et s'ouvre en `http(s)` |
| `profileNames` | les noms que la personne a donnés à ses profils |

Une valeur reçue est **rebornée comme à la lecture d'un fichier** (`cleanPrivacySettings`, `mergeSettings`) : un booléen qui n'en est pas un, un nombre hors bornes, une chaîne trop longue sont écartés. Une valeur est **un seul registre** : `profileNames` (un dictionnaire) est tranché **en entier**, pas clé par clé. **`profiles`** (les réglages propres à un profil) n'est **pas** synchronisé en v1. La liste **ne grandit que par une pull request qui change ce document et ses vecteurs** (`settingsAllowed`, `settingsNever`).

### 10.4 Les onglets ouverts : une annonce, pas une fusion

Les onglets d'« Aujourd'hui » **ne sont pas des entités** : ouvrir 80 onglets sur un appareil ne doit pas en ouvrir 80 sur l'autre. La catégorie `openTabs` envoie seulement une **liste en lecture seule** (`open-tabs`, §7.3) : adresse, titre, espace, dernière activité, **200 au plus**, `http` et `https` seulement **à l'envoi et à la réception** (l'appareil qui reçoit écarte, compte et journalise tout autre onglet annoncé : un script, un fichier local, une adresse de données ; essayé par la carte 448), **jamais** un onglet privé, jamais un onglet d'un espace verrouillé [Q4]. L'autre appareil la garde **en mémoire seulement** (jamais écrite) et la montre dans « Reprendre un onglet du Mac » (carte 447). Toucher une ligne **ouvre un onglet local** avec cette adresse, par le chemin ordinaire d'ouverture d'adresse ; rien d'autre n'est copié. La liste est **vidée** à la fin de la séance et quand l'appareil est oublié. Les titres et adresses des onglets ouverts sont ce qui ressemble le plus à un historique : d'où le défaut **non coché** [Q2].

### 10.5 Ce qui n'est **jamais** synchronisé

| Quoi | Pourquoi |
|---|---|
| **Mots de passe** (le coffre, `passwordManager`, les fichiers et le trousseau) | le coffre du Mac est chiffré par le trousseau du Mac ; en copier le contenu vers un autre appareil est un autre projet de sécurité (`docs/ios.md` §13.3). La ligne « Mots de passe » de la maquette n'est pas reprise (décision du 17 novembre 2026) |
| **Verrous** : `lockEnabled`, `lockApp`, `lockedSpaces`, `lockTouchId`, `lock.json`, la phrase | ce qui est verrouillé n'a de sens que sur l'appareil ; un fichier ne doit **jamais** activer ni couper un verrou (même règle que `exportableState`, `lock.ts`) |
| **Cookies, stockage des sites, permissions des sites** (`sitePermissions`, `siteZoom`, `siteData*`…) | l'identité d'une personne sur un site ne se copie pas |
| **Historique de navigation** | l'iPhone n'en garde aucun (`docs/ios.md` §4.1) : rien à fusionner. S'il en gagne un un jour, ce sera une carte à part, une décision à part, et la catégorie sera **non cochée** |
| **Onglets privés**, fenêtres privées | jamais écrits nulle part (`persistableState`) |
| **Retouches** (`boosts`), **scripts utilisateur**, **extensions** et leurs réglages | du **code** : un appareil compromis ne doit pas pouvoir exécuter du code sur l'autre. `docs/ios.md` §13.3 les prévoyait « désactivées » (étape 2c) ; **cette spécification ne les envoie pas du tout** en v1 ; une étape 2c exigerait une revue de sécurité à part |
| **Réglages de réseau et de mise à jour** : `proxy*`, `doh*`, `updateFeedUrl`, `updateChannel`, `autoUpdate`, `customFilterLists`, `ollamaConfig`, `extensionPaths`, `translateModelsDir`, `webStore*`… | un réglage de réseau ou d'origine du code détourne le trafic ou les mises à jour de l'autre appareil |
| Fichiers : images d'espace et d'onglet, fonds, notes (`notes.json`), téléchargements, vignettes | ils ne sont que sur l'appareil |
| État d'interface : `activeSpaceId`, `activeTabBySpace`, largeurs, fenêtres, panneaux, `splits`, `workViews`, `sessions`, `commandBarUsage`, `liveFolders` | propre à l'appareil ; `commandBarUsage` est un **compteur d'usage** : il ne sort pas de l'appareil |
| Les clés de synchronisation elles-mêmes, la liste des appareils | jamais |

## 11. Fusion à trois voies

### 11.1 Les entrées

`fusion(base, local, distant, withheld)` est une **fonction pure** : elle ne lit ni l'heure, ni le disque, ni le hasard. Chaque entrée est un instantané (§8.3) ; `base` peut être **vide** (§11.8). Elle rend l'instantané fusionné et, à part, la liste des **conflits** et des **suppressions**. Elle **ne change pas ce qu'on lui donne** : ce qu'elle garde est une copie. Une quatrième entrée, `withheld` (l'**union** des listes d'identifiants d'espaces mis de côté que les deux appareils ont annoncées, §18), retire **avant tout** des trois instantanés ces espaces et ce qui en dépend (dossiers, onglets, archive : `spaceId`) : ni ajout, ni modification, ni suppression pour eux, et le résultat n'en contient rien. Comme les deux appareils l'appellent avec les mêmes quatre entrées, ils obtiennent le même résultat.

### 11.2 Une entité

Pour chaque `(genre, id)` présent dans l'une des trois entrées, avec `B`, `L`, `D` la version de la base, locale, distante (ou « absente »).

| Cas | Résultat |
|---|---|
| absente partout | absente |
| présente **d'un seul côté** et **pas dans la base** | **ajout** : gardée |
| **dans les deux** et pas dans la base (même identifiant ajouté des deux côtés) | fusion **champ par champ** avec une base vide |
| dans la base, **absente d'un côté**, **intacte** de l'autre (ses champs égaux à ceux de la base) | **supprimée** |
| dans la base, **absente d'un côté**, **modifiée** de l'autre | **gardée, telle que l'autre côté l'a** : *la suppression perd* |
| dans la base, absente des deux | absente (les pierres tombales sont réunies) |
| présente dans les trois ou dans les deux | fusion **champ par champ** |

« **Modifiée** » comprend aussi : **une entité y a été ajoutée ou y est entrée** de l'autre côté depuis la base, par `spaceId`, `folderId` ou `parentId`. C'est le cas de la maquette « Conflit » (« Gardé dans « Réunions », sur les deux appareils ») : un dossier supprimé d'un côté, un onglet **déplacé dedans** de l'autre, le dossier est gardé. **Sans base** (base vide), il n'y a pas de « depuis la base » : seules les marques de l'entité elle-même comptent (§11.5).

### 11.3 Un champ

Pour chaque champ `f` de l'union des champs de `B`, `L` et `D` (un champ **absent** est une valeur : « retiré »). On compare les **valeurs JSON profondément** (clés d'objet sans ordre, tableaux dans l'ordre).

| `L` change ? | `D` change ? | Résultat |
|---|---|---|
| non | non | la valeur de la base |
| oui | non | `L` |
| non | oui | `D` |
| oui | oui, **même valeur** | cette valeur |
| oui | oui, **valeurs différentes** | **conflit** : la **marque la plus grande** gagne (§9.2) ; l'identifiant d'appareil de la marque départage |

La marque du champ fusionné est celle de la valeur retenue (ou la plus grande des deux, si les valeurs sont égales). **Les champs dont la classe est « graine » ne sont fusionnés que dans l'entité nouvellement créée** ; **les champs « locaux »** ne sont ni dans l'instantané ni dans la fusion.

### 11.4 L'ordre

L'ordre d'affichage est un **registre par liste**, pas un champ par entité. Une liste est une suite d'identifiants dont la clé est composée du genre et de son conteneur : `spaces` ; `folders:<espace>:<parent ou ->` ; `tabs:<espace>:<dossier ou ->` (épinglés) ; `favorites:<profil>`. (`archived` n'a pas d'ordre : la liste suit `archivedAt`.) Pour une liste `k`, avec `membres` = les entités fusionnées qui en font partie :

1. `restreindre(liste)` = la liste sans ce qui n'est pas dans `membres` et sans doublon.
2. Un côté a **réordonné** si, parmi les identifiants communs à sa liste et à celle de la base, leur **ordre relatif** diffère de celui de la base.
3. Les deux ont réordonné **de la même façon** : cette liste, sans conflit. Les deux ont réordonné **différemment** : la liste dont la marque d'ordre (`orderStamps[k]`) est la plus grande l'emporte (à marques égales, la plus grande forme canonique). Un seul : sa liste. Aucun : la liste de la base. La marque d'ordre du résultat est la plus grande des deux.
4. On **ajoute à la fin** les membres qui ne sont pas dans la liste retenue (ajoutés ou arrivés de l'autre côté), triés par **marque de naissance** (la plus petite marque des champs de l'entité ; « zéro » sans marque), puis par identifiant.

Une liste qui n'a **aucun membre** n'est pas écrite dans le résultat, **ni sa marque d'ordre** : une marque sans liste serait perdue à la fusion suivante (qui lit les clés des listes), et un résultat qui change quand on le fusionne encore n'est pas idempotent (§11.9). L'issue est symétrique : échanger `local` et `distant` donne la même suite. **Deux réorganisations différentes ne sont pas fusionnées : la plus récente gagne, et ce que l'autre côté avait ajouté va à la fin.** C'est une perte acceptée et dite dans le résumé du conflit.

### 11.5 Suppressions et pierres tombales

Une suppression est gardée **30 jours** sous forme de **pierre tombale** `(genre, id, marque)` puis purgée (`docs/ios.md` §13.4). Avec une base valide, l'absence dans l'instantané suffit à voir une suppression ; **à base vide**, c'est la pierre tombale qui la dit : une entité **présente d'un côté** et **à pierre tombale de l'autre** est **supprimée si la plus grande marque de ses champs est plus petite que celle de la pierre**, **gardée sinon** (une modification postérieure à la suppression gagne). Si la dernière séance avec un appareil date de **plus de 30 jours**, ses suppressions ont pu être purgées : **la fusion se fait à base vide et ce qui avait été supprimé peut revenir** ; l'écran d'état le dit.

### 11.6 Champs inconnus

Un champ qu'une version plus récente a ajouté, un genre que cette version ne connaît pas, **traversent** : ils sont gardés dans `fields`, fusionnés comme les autres champs (§11.3) et rendus. Un appareil **ne supprime jamais** ce qu'il ne comprend pas. C'est la règle des « champs étrangers » du Mac (`store.ts`) et de `rest` côté Swift (`docs/ios.md` §5). **Réserve** : un champ inconnu n'est fusionné que s'il est dans une entité **du genre connu** et si sa valeur passe les bornes générales du §7.1.

### 11.7 Après la fusion

1. **Références pendantes** : un `tab`, un `folder` ou un `archived` dont l'`spaceId` n'existe pas dans le résultat est **retiré** et **laisse une pierre tombale** marquée de son propre dernier changement (un changement postérieur, ailleurs, le ramène ; il est alors retiré de nouveau : c'est ce qui rend la fusion idempotente) ; un `folderId` ou un `parentId` qui ne désigne rien est **effacé** (l'entité retourne à la racine), sa marque est gardée (sauf si elle est « zéro », §8.3). Cette étape est **dans la fusion** (et pas dans la normalisation de l'appareil) pour que les deux appareils la fassent pareil.
2. **Cycles** : si des `parentId` de dossiers forment un cycle, le `parentId` du dossier dont l'**identifiant est le plus petit** est effacé (sa marque est gardée, sauf « zéro »), et on recommence jusqu'à ce qu'il n'y ait plus de cycle.
3. **Résumé des conflits** : chaque champ tranché par marque, chaque suppression perdue (« gardé »), chaque réorganisation perdue donne une ligne `{kind, id, field, winner, reason}` (`reason` : `newer` (le temps ou le compteur des marques diffère), `device-id` (même temps et même compteur : l'identifiant d'appareil départage), `value` (la **même** marque des deux côtés, un champ jamais marqué : la forme canonique départage, §9.2), `modification-over-deletion`, `order` ; `winner` est `local` ou `remote` **du point de vue de l'appareil qui fusionne** : l'autre appareil voit les mêmes lignes avec les deux côtés échangés). Les lignes sont **triées par `kind`, puis `id`, puis `field`** (une ligne sans champ avant celles qui en ont), chaque texte comparé par unité de code UTF-16 et **sans règle de langue** : le même ordre en TypeScript et en Swift. Les deux appareils calculent la **même** liste ; la valeur perdue est gardée **30 jours, au plus 200 lignes**, dans un journal **local** (`sync-conflicts`) pour le bouton **« Comparer »** ; ce journal contient des adresses et des titres : il suit les règles de confidentialité des autres fichiers de l'appareil, et il disparaît avec l'appareil oublié. **Forme** : un fichier `{ "v": 1, "entries": [...] }` à côté de `state.json` ; **une ligne par chose réglée** (`[kind, id, field]` écrit en JSON), qui garde le moment de la séance, l'autre appareil, la raison, le gagnant, le nom de la chose **tel que la personne l'a écrit** (nom d'un espace ou d'un dossier, titre d'un onglet, adresse à défaut : 120 caractères au plus), les deux valeurs **telles qu'on les lit** (texte coupé à 80 caractères, oui ou non, « aucune valeur », « une autre valeur » ; un dossier ou un espace par son nom, jamais par son identifiant ; un identifiant de profil n'est pas montré), le moment de chaque changement (lu dans les marques) et **ce qui remet la version perdue** (un champ remis à sa valeur ou retiré, l'entité supprimée, la liste remise dans son ordre ; rien si la valeur dépasse 4096 caractères). Une ligne qui règle de nouveau la même chose **remplace** l'ancienne ; une ligne de plus de 30 jours, ou au-delà de 200, s'en va. **Un fichier est hostile avant d'être lu** : il est borné à 4 Mio, chaque ligne est vérifiée (formes, bornes, noms en NFC, aucune clé `__proto__`) et copiée, une ligne mal formée est écartée et comptée, un fichier illisible donne un journal vide (et le dit), un fichier d'une version plus récente **n'est jamais réécrit**. Les phrases sont des **clés de catalogue** (`sync-conflict.*`) et les mots qu'on y met (§13.4) ; les deux langages écrivent les mêmes lignes et les mêmes phrases (`sync-conflict-vectors.json`).

### 11.8 Première synchronisation et base perdue [Q3]

La **base** d'un appareil appairé est l'instantané fusionné de la dernière séance **réussie** (§8.5). Elle est **vide** quand c'est la première séance, quand `baseHash` diffère ou est `null` (l'autre côté n'a pas la même), ou quand la dernière séance date de plus de 30 jours. **Base vide** = chaque entité présente d'un côté est un ajout : c'est **l'union** des deux états, un conflit de champ est tranché par la marque, et les pierres tombales tranchent les suppressions (§11.5). **Exception retenue [Q3]** : un iPhone **jamais modifié depuis son premier lancement** (aucun espace, onglet ou dossier créé par la personne ; un drapeau que la carte 445 passe à faux à la première action de la personne) **adopte l'état du Mac** au lieu de s'y ajouter, pour que le Mac ne reçoive pas un espace vide en plus des siens. **Comment** : cet iPhone envoie un **instantané vide** (`emptySnapshot()`) et fusionne avec un instantané **local** vide ; le Mac reçoit donc l'état d'un appareil qui n'a rien, et les deux appareils fusionnent les mêmes entrées (`mergeSnapshots(null, mac, vide)` et `mergeSnapshots(null, vide, mac)` donnent le même instantané, **sans conflit** : testé). L'application du patch (§8.5) retire alors de l'iPhone ce qu'il avait (son espace du premier lancement) et y met l'état du Mac.

### 11.9 Les propriétés

Les tests de la carte 446 (Swift **et** TypeScript, sur les vecteurs de `sync-merge-vectors.json`, puis sur des états tirés au hasard) tiennent :

1. **Convergence** : `fusion(b, l, d)` = `fusion(b, d, l)` (même instantané ; les conflits ont leur `winner` échangé).
2. **Idempotence** : fusionner un résultat avec lui-même, ou avec l'un de ses deux parents sur la même base, ne change rien.
3. **Conservation des champs inconnus**.
4. **Aucune entité n'apparaît** si elle n'est dans aucune des entrées ; **aucune entité modifiée ne disparaît** parce que l'autre côté l'a supprimée (hors références pendantes, §11.7) ; la fusion **ne change pas ses entrées** ; elle ne laisse **aucune référence pendante ni aucun cycle** de dossiers.

## 12. Oublier un appareil, perdre un appareil

| Situation | Ce qui se passe |
|---|---|
| **« Oublier » un appareil connecté** (page « Synchronisation » des Réglages, liste des appareils) | l'appareil envoie `unpair`, **puis** efface l'empreinte, la base, les marques propres à cet appareil, le journal des conflits et l'annonce d'onglets ; l'autre fait pareil à la réception |
| **« Oublier » un appareil absent** | effacé **localement** tout de suite ; l'autre ne le sait pas avant sa prochaine connexion, où il reçoit `not-paired` et efface de son côté |
| **iPhone perdu ou volé** | sur le Mac, **« Oublier cet iPhone »** : le Mac **refuse aussitôt** toute connexion de cette empreinte (le Mac est le serveur : c'est lui qui contrôle l'entrée). Le téléphone garde ce qu'il avait déjà reçu (c'est une copie locale, que le verrou de l'iPhone protège) |
| **Mac perdu ou volé** | sur l'iPhone, « Oublier ce Mac » : l'iPhone **ne se connecte plus** ; le Mac volé **ne peut pas** se connecter à l'iPhone (il n'ouvre jamais de connexion). L'iPhone ne peut pas empêcher un Mac volé d'**accepter** son empreinte : sans l'iPhone, elle ne sert plus à rien |
| **Réinstallation, restauration** | pas de clé, pas de liste (§3.3) : tout est à refaire |
| **Clé soupçonnée compromise** | oublier l'appareil des deux côtés, puis réappairer : l'empreinte change |

Il n'y a **pas de révocation à distance** : un appareil oublié d'un côté seulement est refusé par celui-là, et reste connu de l'autre jusqu'à ce que la personne l'y oublie aussi.

## 13. Ce que voit l'utilisateur

Les textes sont des **clés des deux catalogues** (`src/shared/i18n-fr.ts` et `i18n-en.ts`, `AGENTS.md` §3) et des phrases entières. Cette spécification donne les clés et le sens ; les cartes 444 et 445 écrivent les textes.

### 13.1 Mac : la page « Synchronisation » des Réglages

- Un **interrupteur** « Synchroniser avec mes appareils » (**désactivé**), sous-texte : « Entre votre Mac et votre iPhone, sur votre réseau local. Rien ne passe par un serveur. » ; un bouton **« Ouvrir la synchronisation »** (la fenêtre de 10 minutes du §6.1, avec son compte à rebours, « Prolonger » et « Fermer »).
- Les **catégories** (§10.1), chacune avec une phrase qui dit ce qu'elle envoie ; « Onglets ouverts » dit : « Ce que vous lisez est envoyé, titres et adresses compris. »
- La **liste des appareils** : nom, plateforme, **dernière synchronisation** (« il y a 2 min »), **« Oublier »** ; **« Ajouter un iPhone »** (feuille : QR, compte à rebours, adresse, code, bouton « Fermer »).
- Une **ligne d'état** (§13.3) et, s'il y en a un, **« Dernier conflit réglé »** (§13.4).
- Un lien vers ce qui est dit des **connexions** (§14).

### 13.2 iPhone : la page « Synchronisation » des réglages

Un interrupteur, **« Ajouter un Mac »** (caméra, puis « Saisir un code »), la liste (un Mac), **« Synchroniser maintenant »**, « Oublier ce Mac », la ligne d'état. Le sous-titre « Synchronisé avec le Mac » des espaces (`docs/ios.md` §3) **apparaît** quand la synchronisation est active. Aucune option « Passer par iCloud » (décision du 17 novembre 2026).

### 13.3 États

| État | Condition | Message (clé) |
|---|---|---|
| Désactivée | interrupteur coupé | `sync.state.off` |
| Aucun appareil | activée, aucun appairage | `sync.state.noDevice` |
| En attente | l'iPhone n'a pas encore de séance, ou **la fenêtre de synchronisation du Mac est fermée** (ou le Mac verrouillé) : « Ouvrez la synchronisation sur le Mac » | `sync.state.waiting` |
| Appareil absent | aucun candidat n'a répondu | `sync.state.unreachable` |
| En cours | séance ouverte | `sync.state.running` |
| **À jour** | `commit` de l'autre reçu : « il y a n min » | `sync.state.upToDate` |
| Espaces de côté | n espaces verrouillés [Q4] | `sync.state.lockedSpaces` (pluriel : `.one` / `.other`) |
| Horloge | `clock-skew` | `sync.state.clockSkew` |
| Erreur | un code fatal du §7.6 | `sync.error.<code>` |

Chaque code du §7.6 a **un texte et une action** (par exemple `pairing-expired` : « Ce code a expiré. Affichez-en un nouveau sur le Mac. » ; `fingerprint-mismatch` : « Ce n'est pas le Mac du code. » ; `state-too-new` : « L'autre Lucium est plus récent : mettez celui-ci à jour. » ; `divergence` : « Les deux appareils ne s'accordent pas : rien n'a été changé. » ). Un texte **ne montre jamais** un secret, un nom d'hôte brut ni une empreinte entière.

### 13.4 « Conflit réglé »

Le résumé de la maquette : « Deux changements se croisaient. » puis la liste (« Le Mac, le plus récent, est appliqué », « Gardé dans « Réunions », sur les deux appareils »), **jamais une question qui bloque**, avec **« Comparer »** (les deux valeurs, depuis le journal du §11.7, avec la possibilité de **rétablir** celle qui a perdu : c'est un changement ordinaire, qui repart à la séance suivante). Les mots viennent de la maquette ; la carte 446 écrit l'écran.

**Ce que l'écran dit** (feuille sur le Mac, `SyncConflictSheet` ; écran de l'iPhone, `SyncConflictScreen`, qui dit les mêmes choses avec les mêmes clés, ses textes étant ceux du Mac à la lettre, `src/shared/ios-sync-conflict-contract.test.ts` ; d'après la maquette « Conflit ») : le titre « Deux changements se croisaient » et « Faits sur les deux appareils depuis leur dernière synchronisation. » ; pour chaque conflit, une carte : ce que c'est (« Espace », « Dossier », « Onglet épinglé »… et le nom que la personne lui a donné), **une rangée par appareil** (le Mac, l'iPhone : ce qu'il a fait, « Nom changé en « Boulot » », « Rangé dans « Réunions » », « Supprimé », et à quelle heure, du plus ancien au plus récent), puis **ce qui est en vigueur** (« La version de l'iPhone, la plus récente, est appliquée. », « Changements simultanés : la version du Mac est appliquée. », « Gardé sur les deux appareils. », « L'ordre du Mac, le plus récent, est gardé. ») ; **« Comparer »** montre les deux versions (« Version gardée », « Version écartée ») avec **« Rétablir cette version »**, un changement ordinaire qui repart à la séance suivante (l'écran le dit) ; une suppression qui a perdu n'a pas deux versions à montrer : elle propose **« Le supprimer partout »** (la maquette dit « Le fermer partout » pour un onglet). **« D'accord »** ferme l'écran (un seul bouton pour tout l'écran, là où la maquette en dessine un par carte) : jamais une question qui bloque, jamais un choix à faire pour que la séance se termine. **Qui nomme quel appareil** : le gagnant est lu du point de vue de l'appareil qui montre l'écran (§11.7.3), le Mac y dit « Mac » et l'iPhone « iPhone », jamais « cet appareil ». L'écran ne change rien lui-même : il prend les lignes du journal et rend « Rétablir » à la page qui le monte (un changement d'état ordinaire, puis la ligne s'efface du journal).

### 13.5 Accessibilité

Les écrans suivent ce que dit `docs/ios.md` pour le reste de l'application : Dynamic Type, 44 pt, étiquettes lues, et **le QR a un équivalent texte** (§4.3) : il ne faut pas une caméra ni une vue pour s'appairer.

## 14. Connexions : la ligne du README

Ce qui suit est à ajouter par les cartes 444 et 445, avec la fonction (`docs/ios.md` §13.5, `AGENTS.md` §5). **La ligne du Mac est dans les deux README** (carte 444, page « Synchronisation » de Réglages › Téléchargements et fichiers) ; celle de l'iPhone reste à ajouter par la carte 445. Les deux README (anglais et français) changent ensemble.

**Tableau du Mac** (anglais) :

> | **Synchronization with your own iPhone**, once you have paired it: your spaces, folders, favorites and pinned tabs (and, only if you tick them, a short list of settings, archived tabs and a list of your open tabs), in an encrypted exchange (TLS 1.3, each device holds the other's key) **with your iPhone only, on the local network, in both directions**. Nothing goes through a server, an account or the internet; the Mac refuses any connection from an address that is not private, and passwords, locks, cookies and history are never sent | only while the switch is on and you have opened the synchronization window on the Mac (10 minutes at most, closed when you quit the page or lock Lucium) and your paired iPhone asks; a pairing opens for 2 minutes at your click | the “Synchronization” page of the Settings (**off**; the path is written by the card that creates the page) |

(français) :

> | **Synchronisation avec votre iPhone**, une fois appairé : vos espaces, dossiers, favoris et onglets épinglés (et, seulement si vous les cochez, une courte liste de réglages, les onglets archivés et la liste de vos onglets ouverts), dans un échange chiffré (TLS 1.3, chaque appareil garde la clé de l'autre) **avec votre iPhone seulement, sur le réseau local, dans les deux sens**. Rien ne passe par un serveur, un compte ou Internet ; le Mac refuse toute connexion venue d'une adresse qui n'est pas privée, et les mots de passe, les verrous, les cookies et l'historique ne sont jamais envoyés | seulement quand l'interrupteur est activé, que vous avez ouvert la fenêtre de synchronisation sur le Mac (10 minutes au plus, fermée quand vous quittez la page ou verrouillez Lucium) et que votre iPhone appairé le demande ; un appairage s'ouvre 2 minutes à votre clic | la page « Synchronisation » des Réglages (**désactivée** ; le chemin est écrit par la carte qui crée la page) |

**Tableau de la version iOS** : la ligne « Search suggestions, site icons, synchronization: not in the iOS code yet » perd le mot « synchronization » et gagne la sienne, symétrique : l'échange **avec votre Mac** sur le réseau local, **seulement** quand la synchronisation est activée et l'application ouverte, **désactivée** par défaut, avec son interrupteur dans la page « Synchronisation » des réglages de l'application. Chaque ligne dit ce qui est échangé et avec qui, et que rien n'est envoyé à un tiers.

## 15. Conformité du chiffrement

`docs/ios.md` §13.5 (renvoyé comme « §13.4 » par la carte 448) pose la question ; voici ce que cette spécification en change et ce qu'elle ne tranche pas.

**Ce que fait le code (fait de conception).**

| Brique | Mac | iPhone |
|---|---|---|
| Chiffrement du transport | TLS 1.3 de la bibliothèque de chiffrement embarquée dans Electron (laquelle : à vérifier) | TLS 1.3 de `Network.framework` (le système) |
| Authentification d'un appairage | HMAC-SHA-256, SHA-256 (`node:crypto`) | HMAC-SHA-256, SHA-256 (CryptoKit) |
| Clés et certificat | ECDSA P-256 (`node:crypto`) ; DER écrit par le projet | ECDSA P-256 (Security / CryptoKit) ; DER écrit par le projet |
| Ce que le projet **n'écrit pas** | **aucun** algorithme de chiffrement, aucun mode, aucun protocole de sa main : seulement des appels au système ou à la bibliothèque de l'environnement | idem |

**Ce que cela change pour la v1 d'iOS.** `ios/Lucium/Info.plist` porte `ITSAppUsesNonExemptEncryption = false` (décision du 18 novembre 2026), parce que l'application n'utilisait que le chiffrement d'iOS pour HTTPS (`docs/ios.md` §9.5). **Avec la synchronisation, l'application ne fait plus que cela** : elle établit aussi une connexion chiffrée à un autre appareil et authentifie ses messages. La documentation d'Apple lue pour l'étude **ne dit pas** qu'une telle application reste exemptée (`docs/ios.md` §13.5) ; elle cite le chiffrement du système, le chiffrement standard et le chiffrement « propriétaire » parmi les cas à déterminer, et dit que la diffusion en France est aussi contrôlée par l'ANSSI. **Cette spécification ne tranche pas la valeur de la clé.** Elle dit :

1. **la clé `false` ne doit pas partir dans une build qui contient la synchronisation** tant que le questionnaire d'App Store Connect n'a pas été rempli pour cette build et que la carte 448 n'a pas rendu sa conclusion ; le code de la synchronisation est dans la build **même si l'interrupteur est coupé** : la question porte sur la build, pas sur l'usage ;
2. la conception n'utilise que les primitives du système, ce qui est ce que Apple demande de distinguer d'un chiffrement que l'application implémente elle-même ; si, malgré cela, Apple juge l'usage **non exempté**, le mainteneur prépare la documentation demandée (au cas par cas, délai indicatif de deux jours ouvrés, `docs/ios.md` §13.5) ;
3. **le Mac** n'est pas distribué par l'App Store : les règles d'Apple ne s'y appliquent pas. Les règles d'exportation du pays du mainteneur et celles des États-Unis pour un logiciel libre qui contient du chiffrement **n'ont pas été lues** : **à confirmer par le mainteneur** (carte 448).

## 16. Menaces et limites

| Menace | Réponse | Où |
|---|---|---|
| Un tiers sur le même Wi-Fi **écoute** | TLS 1.3 (TLS 1.2 jamais proposé) | §6 |
| Il **s'insère à l'appairage** | secret de 128 bits dans le QR, **1 usage, 2 minutes**, preuve qui couvre les deux empreintes, confirmation sur le Mac [Q7] | §4 |
| Il **voit le QR** (une épaule, une photo) | usage unique et 2 minutes ; **confirmation sur le Mac** [Q7] ; l'iPhone légitime reçoit « code déjà utilisé » | §4.5 |
| Il **rejoue** un message ou un QR | TLS, secret brûlé, nonce de connexion, numéros | §9.1 |
| Il **se fait passer** pour un appareil appairé | l'empreinte est épinglée ; l'identifiant est lié à l'empreinte | §3.2 |
| Il envoie un **message énorme ou piégé** | longueur lue avant le contenu, bornes, profondeur, `__proto__` refusé, **rien n'est exécuté** | §7 |
| Un **port ouvert en permanence** | **aucun port n'est ouvert hors d'une fenêtre de synchronisation** que la personne ouvre (10 minutes au plus) [Q5] | §6.1 |
| Il **inonde** l'écoute | filtre d'adresses avant la poignée de main, 4 connexions, limites de débit, 10 échecs par minute et par adresse | §6.1 |
| Il atteint le Mac **depuis Internet** | adresse source publique refusée avant TLS ; le Mac n'est pas annoncé ; **le routeur** ne doit pas rediriger le port (rien ici ne le fait) | §6.2 |
| Un **appareil appairé est compromis** | **non couvert** (il envoie ce que l'appareil sait envoyer) ; ses effets sont bornés : pas de code, pas de réglage de réseau, entités rebornées | §8.6, §10 |
| Un appareil **perdu** | oubli depuis l'autre (§12) | §12 |
| Un **tiers déjà sur l'appareil** | **non couvert** : le trousseau et l'état sont à lui | — |
| **Divergence** entre le Swift et le TypeScript | résumé `result`, rien n'est écrit en cas d'écart | §8.5 |

**Limites assumées.** Les deux appareils doivent se voir et être ouverts, **et la personne doit ouvrir la fenêtre de synchronisation sur le Mac** (§3.1, §6.1) ; **pas de synchronisation hors du réseau local** ; un réseau qui isole les clients (Wi-Fi d'invités, d'entreprise) l'empêche ; l'ordre est **un registre par liste** (§11.4) ; un appareil hors ligne plus de 30 jours peut faire revenir ce qui a été supprimé (§11.5).

## 17. Vérifié et à vérifier

**Vérifié** (lu dans un code installé ou essayé, ce 18 novembre 2026) :

| Quoi | Source |
|---|---|
| `tls.createServer` : `requestCert`, `rejectUnauthorized`, `minVersion` (`'TLSv1.3'`), `ALPNProtocols` ; `TLSSocket.getPeerX509Certificate`, `exportKeyingMaterial(length, label, context)` ; `crypto.timingSafeEqual`, `createHmac`, `generateKeyPairSync`, classe `X509Certificate` | `@types/node` 26.6.6 (`tls.d.ts`, `crypto.d.ts`) |
| **Aucune** fonction de création de certificat dans Node | lecture de `crypto.d.ts` et `tls.d.ts` |
| Un serveur TLS 1.3 de Node avec client authentifié par un certificat auto-signé **écrit à la main** : `authorized` = `false`, empreinte = SHA-256 du DER, ALPN négocié, version `TLSv1.3`, **même exportateur de clés** des deux côtés, client inconnu détecté après la poignée de main, ALPN sans recouvrement = `ERR_SSL_TLSV1_ALERT_NO_APPLICATION_PROTOCOL` | essai sur la boucle locale, Node 26.13 |
| Le certificat écrit à la main est lu par `X509Certificate` (signature vérifiée) et par `SecCertificateCreateWithData` (clé P-256 de 256 bits, mêmes octets) | essai, Node 26.13 et Security.framework de ce Mac |
| `sec_protocol_options_set_verify_block`, `set_local_identity`, `set_min_tls_protocol_version` (iOS 13), `add_tls_application_protocol`, `set_peer_authentication_required` (client : vrai par défaut ; serveur : faux), `sec_protocol_metadata_create_secret` et `_with_context` (iOS 12), `sec_identity_create` | SDK iPhoneOS 27.2 (`SecProtocolOptions.h`, `SecProtocolMetadata.h`, `SecProtocolTypes.h`) |
| `NWConnection(host:port:using:)`, `NWParameters(tls:tcp:)`, `NWProtocolTLS.Options.securityProtocolOptions`, `NWBrowser.Descriptor.bonjour(type:domain:)` | `Network.swiftinterface` du SDK 27.2 |
| `SecIdentityCreateWithCertificate` n'existe que sur macOS ; `kSecClassIdentity` existe ; les valeurs `…ThisDeviceOnly` de `kSecAttrAccessible` ne se synchronisent pas | `SecIdentity.h`, `SecItem.h` |
| `AVMetadataObjectTypeQRCode` | `AVMetadataObject.h` |
| `/usr/bin/dns-sd -R` existe ; sa page de manuel dit que ses arguments et sa sortie peuvent changer et déconseille de l'appeler d'un script | `man dns-sd` |

**Vérifié le 18 novembre 2026 (carte 444)** : le Node **d'Electron 45.2.1** (Node 24.22.1, TLS de BoringSSL ; Electron lancé avec `ELECTRON_RUN_AS_NODE=1` depuis l'archive officielle, sans fenêtre ni application) fait passer, avec le vrai code de `src/main/sync/` : le certificat du §6.3 (octets à signer du vecteur, lecture par `X509Certificate`, signature, empreinte), les 44 vecteurs du filtre d'adresses (IPv4 écrite en IPv6 comprise), les 29 vecteurs du QR et les 12 du code à saisir, les preuves, une séance **TLS 1.3 mutuelle avec ALPN `lucium-sync/1` entre deux certificats écrits à la main**, l'empreinte du certificat du Mac vue par le client, un appairage de bout en bout, le refus d'un client sans protocole commun et d'un inconnu (`not-paired`). **Ce que cet essai ne prouve pas** : `safeStorage` (il demande le trousseau : essai du smoke `sync`, non lancé), `os.hostname()` dans l'application, le pare-feu et l'autorisation du réseau local de macOS, un vrai appareil.

**À vérifier** (non lu, non essayé) :

1. ~~Le Node d'Electron 45.2.1~~ (fait, ci-dessus) ; reste **l'essai sur un appareil** et dans l'application elle-même (le smoke `sync` de `src/main/smoke-sync.ts` est écrit, pas lancé).
2. `NWConnection` vers un nom `.local`, et ce que rend `os.hostname()` d'Electron (§5).
3. Le code d'erreur de `Network.framework` quand le réseau local est refusé (§5) et le moment où le bloc de vérification est appelé face à un certificat auto-signé (§6.4).
4. L'**identité** de l'iPhone : `SecItemAdd` d'un certificat et d'une clé, puis `kSecClassIdentity` (§3.3).
5. L'**exportateur** de clés entre Node et Apple (renfort du §4.4) ; `safeStorage` d'Electron 45 (§3.3).
6. Filtrer par adresse avant la poignée de main avec `tls.Server` (§6.1).
7. Le comportement de l'iPhone quand l'application passe en arrière-plan au milieu d'une séance (la connexion est coupée : la séance échoue proprement, et rien n'est écrit tant que `result` n'est pas égal).
8. Le pare-feu de macOS à la première écoute, pour une build non signée (`docs/ios.md` §13.2), et l'**autorisation du réseau local** de macOS pour une application qui écoute : non lue.
9. La **conformité du chiffrement** (§15).
10. ~~Le **délai de commentaire**~~ (**fait**, décidé par le chef de projet le 18 novembre 2026 : une *issue* à part, et non l'*issue* [#42](https://github.com/pOwn3d/Lucium/issues/42), qui porte sur l'étude iOS). `GOVERNANCE.md` demande au moins **7 jours** de commentaire pour un changement important de comportement visible ou d'architecture. L'*issue* [#90](https://github.com/pOwn3d/Lucium/issues/90), ouverte le 18 novembre 2026, décrit la synchronisation Mac ↔ iPhone, dit que le code est déjà fusionné (désactivé par défaut) avant ce délai, et laisse les commentaires ouverts **jusqu'au 25 novembre 2026**. **Aucune version ne porte la synchronisation avant cette date.** Ce qui reste : lire les commentaires reçus et écrire la décision, avec ses raisons, dans l'*issue*.

## 18. Choix qui reviennent au chef de projet

Chacun a été posé en commentaire `[question]` de la carte 443, avec sa recommandation. **Réponse du chef de projet (18 novembre 2026) : « Le mieux le plus secure »**, lue comme l'option **la plus sûre** de chacun ; le texte ci-dessus la suit. À confirmer : si la lecture est fausse pour l'un d'eux, il suffit de changer la ligne du tableau et le paragraphe qu'elle désigne.

| | Choix | Retenu (l'option la plus sûre) | Où |
|---|---|---|---|
| **Q1** | Découverte : Bonjour ou non | **Pas de Bonjour en v1** ; nom `.local` + dernières adresses | §5 |
| **Q2** | Ce qui est synchronisé par défaut | **`structure` seule** cochée ; `settings`, `archive` et `openTabs` **non** (**changé** : la recommandation cochait aussi `settings`) | §10.1 |
| **Q3** | Premier échange sans base | **Union**, avec adoption de l'état du Mac par un iPhone jamais modifié | §11.8 |
| **Q4** | Espaces verrouillés | **Mis de côté** pendant le verrou, leurs identifiants seuls voyagent | §10.4, §13.3 |
| **Q5** | Quand le Mac écoute | **Seulement pendant une fenêtre de synchronisation ouverte à la main** (10 minutes au plus) : lecture littérale de `docs/ios.md` §13.2 (**changé** : la recommandation écoutait tant que Lucium tourne ; **coût** : la synchronisation demande un geste sur le Mac à chaque fois) | §6.1 |
| **Q6** | Certificats | **DER écrit à la main**, des deux côtés | §6.3 |
| **Q7** | Confirmation sur le Mac à l'appairage | **Oui** : Autoriser / Refuser | §4.1 |

**Espaces mis de côté [Q4]** (précision de la recommandation) : un espace verrouillé **sur un appareil** est **retiré de l'instantané qu'il envoie** et ses changements reçus **ne sont pas appliqués** tant qu'il l'est. Pour que l'autre appareil ne le prenne pas pour supprimé, le `hello` ne porte pas la liste, mais **chaque partie d'instantané** porte `withheld` : les **identifiants** des espaces mis de côté (champ facultatif de `snapshot.part`, ignoré d'un appareil qui ne le connaît pas), et la fusion **retire des trois entrées** (base, local, distant) un espace nommé là et ce qui en dépend (§11.1) : ni ajout, ni modification, ni suppression, et le résultat, donc le résumé comparé, n'en contient rien. Ce que la personne change dans un espace de côté ne repart qu'à une séance où il ne l'est plus : sans base pour cet espace, ses entités sont alors des ajouts des deux côtés (§11.8), et les pierres tombales tranchent les suppressions. Si la recommandation n'est pas suivie, ce paragraphe disparaît et rien d'autre ne change.

## 19. Vecteurs de contrat

Trois fichiers dans `ios/Contracts/`, **au format des vecteurs existants** (JSON, un `comment` en tête qui dit qui les lit) :

| Fichier | Contient |
|---|---|
| `sync-pairing-vectors.json` | `proof` (les preuves d'appairage recalculables, avec `mutations`), `qr` (valides et refusés), `manualCode`, `secretLifecycle` (valide, expiré, rejoué, preuve fausse, verrouillé, refusé), `clientChecks` (empreinte fausse), `addressPolicy`, `certificate` (octets à signer et certificat d'exemple) |
| `sync-message-vectors.json` | `limits`, `frames` (longueurs), `messages` (valide, trop gros, version inconnue, champ inconnu, `__proto__`, hors phase), `sequences` (numéros), `stamps`, `canonical` (formes canoniques et SHA-256), `fieldClasses`, `settingsAllowed`, `settingsNever`, `inbound` (entités écartées) |
| `sync-merge-vectors.json` | des **cas de fusion** : base, local, distant, résultat attendu, conflits attendus, `swap` (le résultat doit être le même en échangeant local et distant) |
| `sync-merge-draws.json`, `sync-snapshot-vectors.json`, `sync-conflict-vectors.json` | (carte 446) le **corpus de tirages** et son résultat, ce qu'un instantané reçu doit être, les **lignes du journal et les phrases** de « Conflit réglé » pour chaque conflit des deux fichiers précédents, la conservation du journal (30 jours, 200 lignes) et la lecture d'un fichier hostile |

**Qui les lit.**

- **La fusion** (`sync-merge-vectors.json`) : Vitest la joue contre le **vrai code** (`src/shared/sync-merge.ts`, carte 446 : le lecteur de référence écrit dans le test est retiré) ; `sync-merge-draws.json`, un **corpus de 60 tirages** (deux appareils qui modifient un ancêtre commun, `src/shared/sync-merge-draws.test-support.ts`) avec le résultat de la fusion du Mac, est un fichier de référence de Vitest (réécrit par `-u`, refusé s'il diffère) que LuciumKit jouera contre le Swift.
- **Vitest** : `src/shared/ios-sync-contract.test.ts` (appairage, messages) et `src/shared/ios-sync-merge-contract.test.ts` (fusion) valident la **forme** de chaque vecteur (champs, types, longueurs, marques bien formées) et les **jouent contre un lecteur de référence écrit dans le test** : le QR, le code à saisir, le filtre d'adresses, la vie du secret, les trames, les messages et leur ordre, le filtre des entités reçues (la fusion n'en fait plus partie : elle est jouée contre le vrai code, ci-dessus). Ils **recalculent** les preuves (HMAC), les SHA-256 canoniques et l'ordre des marques, **construisent** un certificat sur le profil du §6.3 (octets à signer, puis lecture par `X509Certificate` : signature, noms, dates, empreinte), vérifient que **tous les champs de `Space`, `Folder`, `TabItem`, `Favorite` et `ArchivedTab` de `model.ts` ont une classe** et une seule, que la **liste des réglages** est dans `defaultSettings()` et **ne contient aucune** clé de `settingsNever` ni de verrou, et (`src/shared/sync-merge.test.ts`) essaient la fusion sur **600 tirages** (même résultat en échangeant local et distant, fusion répétée sans effet, champs inconnus conservés, aucune référence pendante ni cycle, entrées inchangées, espace mis de côté, premier échange). **Les cartes 444 et 445 remplacent le lecteur de référence** de leurs parties (appairage, messages, filtre des entités) par le vrai code : le test joue alors les mêmes vecteurs contre lui. Les tirages au hasard ont déjà fait corriger cinq règles de ce document (§8.3, §9.2, §11.1, §11.4, §11.7) ; les tirages de la carte 446, qui modifient un ancêtre commun comme le font deux appareils, ont fait préciser la liste vide (§11.4), l'ordre des conflits et l'ordre des textes à égalité (§9.2, §11.7).
- **LuciumKit, la fusion** (`SyncMergeTests.swift`, `swift test`) : `SyncMerge` joue les 37 cas de `sync-merge-vectors.json` et les **60 tirages** de `sync-merge-draws.json` (le résultat entier, les conflits et l'**empreinte SHA-256** de la forme canonique du résultat, donc l'accord octet pour octet avec le TypeScript), `SyncSnapshot.read` joue `sync-snapshot-vectors.json` (ce qu'un instantané reçu doit être : accepté ou refusé, et son texte canonique), `SyncCanonical` joue les vecteurs `canonical` et `stamps` ; puis les propriétés du §11.9 sur ces mêmes états (convergence, idempotence, champs inconnus conservés, aucune référence pendante ni cycle, listes cohérentes, espace mis de côté, premier échange). Le dictionnaire de Swift est tiré au hasard à chaque processus : une règle qui dépendrait de l'ordre de parcours échouerait ici une fois sur deux.
- **LuciumKit, le reste** (`SyncVectorTests.swift`, `swift test`) : lit les **mêmes fichiers**, vérifie leur forme, recalcule les preuves par **CryptoKit** (donc l'accord Swift/TypeScript sur le HMAC), les SHA-256 des chaînes canoniques, et fait lire par **Security.framework** le certificat d'exemple (`SecCertificateCreateWithData`, empreinte). L'implémentation de la fusion et celle de la forme canonique en Swift sont dans les fichiers ci-dessus : ce test ne les écrit pas.

**Ce que les vecteurs ne prouvent pas.** Ni un échange réseau réel, ni la poignée de main sur appareil, ni l'interopérabilité de l'exportateur de clés Node ↔ Apple, ni la fusion en Swift (carte 446).

## 20. Ce que chaque carte fait de cette spécification

| Carte | À faire |
|---|---|
| **444 : Mac** | `src/main/sync/` : identité (§3), écoute et filtre (§6.1–6.2), certificat (§6.3), appairage (§4), séance (§8), `sync/apply` dans le réducteur, page Réglages et **canal IPC validé** (une validation et un test par message), textes des deux langues, **ligne du README** (§14), test de classement des champs (§10.2), **mutations** des gardes (taille, adresse, preuve, épinglage) ; la **fenêtre de synchronisation** du §6.1 (ouverture, compte à rebours, fermeture, aucun port ouvert hors fenêtre) et son test [Q5] |
| **445 : iPhone** | `NWConnection` épinglé (§6.4), identité par `SecItemAdd`, QR (`AVFoundation` ou `VisionKit`) et saisie du code (§4.3), `Info.plist` (`NSLocalNetworkUsageDescription`, `NSCameraUsageDescription`), Réglages, textes, ligne du README iOS ; **pas de `NWBrowser`** si [Q1] = A |
| **446 : fusion** | `fusion` (§11) en TypeScript (`src/shared/`) **et** en Swift (`LuciumKit`), la forme canonique du §8.4 en Swift, **les mêmes vecteurs des deux côtés**, les propriétés du §11.9 sur des états tirés au hasard, l'écran « Conflit réglé » et le journal du §11.7 : **fait** : le journal, les phrases, la feuille du Mac et l'écran de l'iPhone ; **monter** la feuille et l'écran dans les pages « Synchronisation » et brancher « Rétablir » sur l'état reste à 444 et 445 |
| **447 : reprise** | l'écran « Reprise » et la source « Sur le Mac » de la barre de commandes, sur l'annonce du §10.4 |
| **448 : revue** | relire ce document **et** le code contre §16 ; refaire les essais du §17 dans Electron 45.2.1 et sur appareil ; la **conformité du chiffrement** (§15) ; rapport **sans point bloquant** |

## 21. Écarts avec `docs/ios.md` §13

| `docs/ios.md` | Ici | Pourquoi |
|---|---|---|
| §13.2 : « l'empreinte de sa clé publique » | l'empreinte **du certificat** (SHA-256 du DER) | même hachage des deux côtés, aucun en-tête ASN.1 à fabriquer (§3.2) |
| §13.2 point 2 : Bonjour, `NWBrowser`, `NSBonjourServices` | **aucun en v1** [Q1] | §5 |
| §13.2 point 3 : `checkServerIdentity` | vérification de l'empreinte à `secureConnection` / `secureConnect` | `checkServerIdentity` compare un nom d'hôte ; `rejectUnauthorized: false` avec un certificat auto-signé (§6.1) |
| §13.2 point 6 : « fenêtre de synchronisation ouverte » | **repris à la lettre** : une fenêtre que la personne ouvre, 10 minutes au plus [Q5] | l'option la plus sûre (aucun port ouvert hors fenêtre) ; elle coûte un geste sur le Mac |
| §13.3 étape 2c : Retouches reçues désactivées | **pas envoyées du tout** en v1 | du code : une revue à part (§10.5) |
| §13.3 étape 2b : onglets d'« Aujourd'hui » | une **annonce** en lecture seule, pas une fusion | ouvrir 80 onglets ici ne doit pas en ouvrir 80 là (§10.4) |
| §13.3 étape 2d : historique | **jamais** tant que l'iPhone n'en a pas | rien à fusionner (§10.5) |
| §13.4 : « le plus récent gagne (horodatage relevé par l'appareil qui l'a vu) » | **marques hybrides** par champ, produites à l'écriture de l'état (§9.2) | l'heure d'une synchronisation n'est pas celle du geste |
| §13.4 : « une suppression face à une modification : la modification gagne » | repris, et **étendu** : entrer dans un conteneur supprimé compte comme une modification | le cas « Réunions » de la maquette (§11.2) |
| §13.5 : TLS 1.3, HMAC de la transcription | repris ; la transcription est **fixée octet par octet** (§4.4) | pour qu'un vecteur la tienne |

## 22. Ce que la carte 444 a précisé en l'écrivant

Les points où le code a dû choisir, sans changer ce qui est décidé plus haut :

| Sujet | Ce que fait le Mac | Pourquoi |
|---|---|---|
| **Qui filtre quoi** (§8.5) | chaque appareil applique la porte des entités reçues **aussi à son propre instantané avant de l'envoyer** (avec l'horloge de l'autre appareil pour les marques du futur) | les deux fusions doivent partir des mêmes entrées : sans cela, une entité que l'un envoie et que l'autre refuse donne deux résultats, donc `divergence` (rien n'est écrit) à chaque séance. Une entité refusée reste où elle est, intacte, n'est pas envoyée, est comptée et journalisée |
| **Graines** (§10.2) | envoyées **seulement avec une entité que la base de cet appareil avec l'autre ne contient pas** ; la base gardée n'en contient pas | un champ « graine » (la page où un onglet épinglé se trouve) qui changerait à chaque navigation serait sinon un changement à fusionner. Un onglet épinglé que la fusion rend à un appareil qui l'avait supprimé arrive sans graine : il s'ouvre à son `anchorUrl` |
| **Marques** (§9.2) | un livre de marques (`sync-marks.json`) : le hachage de chaque champ et la marque donnée au moment où l'appareil le voit changer (300 ms après le geste), une marque aussi pour un champ retiré et pour l'ordre de chaque liste, des pierres tombales de 30 jours. **Il suit l'état seulement tant que l'interrupteur est activé** ; au lancement l'identifiant est lu dans le fichier sans ouvrir la clé (pas de demande au trousseau) | ni adresse ni titre dans ce fichier ; rien n'est abonné, rien ne tourne interrupteur coupé |
| **Écriture** (§8.5) | l'action `sync/apply` : un champ n'est écrit que si l'état tient encore ce qu'il tenait au gel (`expect`), une entité n'est supprimée que si elle est encore telle qu'au gel ; le tout passe par `normalize`, comme un fichier lu au démarrage | ce que la personne a changé pendant la séance est gardé et repart à la séance suivante ; un champ reçu est reborné comme tout autre |
| **Place d'appairage** (§6.1) | une seule ; une connexion qui n'a pas envoyé `pair.request` dans les 3 s qui suivent sa prise de la place la perd au profit du prochain inconnu (coupée, comptée) | un voisin qui ouvre une connexion TLS et se tait gardait la place 60 s (le silence permis), en boucle, tout le temps de la fenêtre : il empêchait l'appairage sans connaître le secret (essayé par la carte 448) |
| **Application d'un patch** (§8.5) | `sync/apply` travaille sur une copie de chaque liste touchée, avec un index des identifiants, et ne parcourt chaque liste qu'une fois pour les suppressions et une fois pour les ordres | la version qui cherchait dans la liste pour chaque entité tenait le processus principal 3,4 s pour 40 000 créations ; un appareil hostile calcule la même fusion et le résumé concorde : il pouvait relancer ce gel à chaque séance (carte 448). Un test joue 400 patchs tirés au hasard contre l'ancienne version, gardée comme référence |
| **Une séance à la fois** | une deuxième connexion d'un appareil appairé reçoit `busy` | les marques et la base sont écrites par une seule séance |
| **Durée de séance de l'iPhone** (§7.5) | `SyncSessionClient.run` borne toute la séance à `sessionMaximum` (10 minutes ; `within` ferme la connexion, ce qui termine la lecture en cours) et échoue en `timeout` | revue de la carte 448, n° 19 : un Mac qui envoie un octet par minute gardait chaque silence court, la séance ne finissait jamais et « Synchroniser maintenant » restait « en cours » |
| **Clé que le trousseau n'ouvre pas** (§3.3) | `IdentityStore.loadOrCreate` ne remplace une clé qui ne s'ouvre pas que si on le lui dit (`replaceUnopenable`) ; il lève `IdentityNotOpenableError` sinon, et le service ne le dit qu'au deuxième essai (`identityRefusals`) ; une identité qui n'en est pas une est remplacée tout de suite ; problème `identity-unopenable` (texte des deux langues) | revue de la carte 448, n° 22 : un trousseau qui refuse un instant faisait écraser l'identité et oublier tous les appareils appairés |
| **Entité refusée qui est dans la base** (§8.5) | `cleanSnapshot` reçoit la base de la séance : une entité refusée pour ses marques (`future-mark`), son adresse (`invalid-url`) ou sa valeur (`invalid-value`) est **remplacée par sa version de la base** (inchangée), de ce qui vient de l'autre appareil comme de ce que cet appareil envoie ; une refusée pour ce qu'elle est (`not-pinned`, `private`, genre interdit) est écartée, et l'autre appareil la supprime (elle est sortie de ce qui se synchronise). Sans base, elle est écartée | la fusion lit « dans la base, absente d'un côté, intacte de l'autre » comme une suppression : un iPhone dont l'horloge avance de plus d'une semaine, qui renomme un espace, faisait **supprimer cet espace et ses onglets épinglés du Mac** (essayé par la carte 448) ; **le Swift doit faire de même** (carte 452), sinon les deux résumés peuvent différer |
| **Marques du futur** (§9.3) | `cleanSnapshot` écarte, en plus des entités, les pierres tombales et les listes (avec leur marque d'ordre) dont la marque dépasse l'heure locale de plus de 7 jours ; la porte s'applique aussi à l'instantané que cet appareil envoie, avec l'heure de l'autre (`hello.now`) | les deux fusions doivent partir des mêmes entrées ; une marque de l'an 2286 tirait l'horloge des marques du Mac (`MarkBook.adopt` la retient) |
| **Avertissement d'horloge** (§9.3) | un `error` non fatal (`clock-skew`) est noté et la séance continue ; un `error` fatal l'arrête avec son code | |
| **Fichiers** (§3.3) | `sync.json`, `sync-identity.json`, `sync-marks.json`, `sync-base-<id>.json` (un par appareil, 30 jours), à côté de `state.json` | aucun export, aucune sauvegarde ni copie de session ne les emporte |
| **Onglets ouverts** (§10.4) | annoncés (au plus 200, adresses web, jamais privés ni d'un espace verrouillé) seulement si la catégorie est commune ; gardés **en mémoire** par le service (`openTabsFrom`), oubliés avec la fenêtre et avec l'appareil | la carte 447 les montre |

**Ce que les tests ne montrent pas** : un échange avec le vrai code de l'iPhone (carte 445), un réseau réel, un grand état de plusieurs milliers d'entités sur un appareil, le comportement de `safeStorage` au premier usage.
