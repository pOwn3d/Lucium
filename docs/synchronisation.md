# Synchronisation Mac ↔ iPhone (phase 2) : spécification

Spécification de la synchronisation directe entre le Mac et l'iPhone, sur le réseau local, sans serveur ni compte. Elle est écrite par la carte 443 et sert les cartes 444 (Mac), 445 (iPhone), 446 (fusion), 447 (reprise d'un onglet) et 448 (revue de sécurité). Ce document dit ce que le code doit faire, et les vecteurs de contrat (§19) tiennent d'accord le Mac et l'iPhone. **État de la carte 444 (Mac)** : sont écrits, testés et câblés l'écoute et le filtre d'adresses (§6), l'appairage et sa confirmation (§4), l'identité et le certificat (§3, §6.3), la fenêtre de synchronisation (§6.1), la page des Réglages et son canal IPC (§13.1), la ligne du README (§14) **et la séance d'échange (§8 : instantané, marques, filtre des entités reçues, action `sync/apply`)**, qui utilise la fusion à trois voies (§11) de la carte 446 : en TypeScript (`src/shared/sync-merge.ts`, `sync-canonical.ts`, `sync-snapshot.ts`) et en Swift (`ios/LuciumKit/Sources/LuciumKit/SyncMerge.swift`, `SyncCanonical.swift`, `SyncSnapshot.swift`), jouées contre les mêmes vecteurs. Le journal des conflits (§11.7.3), les phrases de « Conflit réglé » (§13.4) (`src/shared/sync-conflicts.ts`, `SyncConflicts.swift`), la feuille du Mac (`src/renderer/SyncConflictSheet.tsx`) et l'écran de l'iPhone (`ios/Lucium/SyncConflictScreen.swift`) sont de la carte 446 ; la séance rend les conflits réglés dans son résultat (`conflicts`), mais **ne les inscrit pas encore au journal et ne montre pas encore la feuille** : c'est ce qui reste à brancher. Ce que ces choix précisent est au §22. Rien de tout cela n'a été vu à l'œuvre avec un iPhone : la carte 445 (iPhone) n'est pas fusionnée et le contrôle du moteur (`src/main/smoke-sync.ts`) est écrit, pas lancé. La carte 452 (corps de séance de l'iPhone) est décrite au §23. La carte 447 (reprise d'un onglet du Mac, côté iPhone) est décrite au §24. La carte 448 reste à faire. **La carte 504 (§27) fait des onglets d'« Aujourd'hui » de vraies entités partagées** (décision du 19 novembre 2026) : conception seulement, aucun code ; elle remplace l'annonce en lecture seule du §10.4 d'origine. **La carte 505 (19 novembre 2026) remplace la fenêtre de synchronisation manuelle du Mac par une écoute permanente tant que la synchronisation est activée, Lucium déverrouillé et un iPhone appairé, et fait synchroniser l'iPhone seul à intervalle réglable (§28)** : les endroits de ce document qui parlent encore d'une fenêtre ouverte à la main sont des récits de l'état d'avant (§21 à §26), le texte de référence est celui du §6.1, du §8.1 et du §28.

Il complète [docs/ios.md](ios.md) §13, qui est l'étude. En cas d'écart, ce document prime ; les écarts voulus sont listés au §21.

**Comment lire les étiquettes.**

- **Décidé** : décision du chef de projet (`docs/ios.md` §15, ou la demande de lancer la phase 2 le 18 novembre 2026).
- **Vérifié** : lu dans un code installé (`@types/node` 26.6.6, SDK iPhoneOS 27.2) ou dans une page de manuel de ce Mac, ou essayé pour cette carte (essais du §17). Une phrase « essayé » dit sur quoi : Node 26.13 sur la boucle locale, ou Security.framework de ce Mac.
- **À vérifier** : non lu et non essayé ; la carte qui l'implémente le vérifie avant de s'y fier.
- **Choix [Qn]** : un des sept choix qui revenaient au chef de projet, posés en commentaire `[question]` sur la carte 443. **Réponse du chef de projet, le 18 novembre 2026 : « Le mieux le plus secure »**, lue ici comme : *pour chaque choix, l'option la plus sûre*. Cinq étaient déjà la recommandation (Q1, Q3, Q4, Q6, Q7) ; **deux changent** (Q2 : aucune catégorie cochée par défaut sauf la structure ; Q5 : le Mac n'écoute que pendant une fenêtre ouverte à la main, **choix remplacé le 19 novembre 2026** : voir §6.1, §18 et §28). Cette lecture est à confirmer par le chef de projet ; la liste est au §18.

## 1. En bref

| Question | Réponse |
|---|---|
| Quoi | Une synchronisation **dans les deux sens** des espaces, dossiers, favoris et onglets épinglés (et, si la personne les coche, des onglets d'« Aujourd'hui », de l'archive et de quelques réglages) entre **son** Mac et **son** iPhone |
| Par où | **Le réseau local seulement**, d'appareil à appareil. Aucun serveur, aucun compte, aucun service d'une entreprise (iCloud compris) : `GOVERNANCE.md` principe 5 et `AGENTS.md` §5 |
| Qui parle à qui | **Le Mac écoute, l'iPhone se connecte.** Le Mac n'ouvre jamais de connexion vers l'iPhone |
| Quand | **Désactivée par défaut**, des deux côtés. **Synchronisation automatique** (décidé par le chef de projet le 19 novembre 2026) : **le Mac écoute tant que la synchronisation est activée, que Lucium est déverrouillé et qu'au moins un iPhone est appairé** (§6.1) ; **l'iPhone synchronise seul**, à un intervalle réglable (30 s, **1 min par défaut**, 5 min, 15 min) tant que l'application est ouverte à l'écran, et aussi au lancement, au retour au premier plan, après un changement local et sur demande (§8.1). **Les deux applications doivent être ouvertes, sur le même réseau local** ; rien ne tourne en arrière-plan |
| Appairage | Un **code QR** affiché par le Mac (adresse, port, empreinte, secret de 128 bits à usage unique valable 2 minutes), lu par l'iPhone ; à défaut de caméra, un code à saisir |
| Transport | **TLS 1.3 mutuel**, certificats auto-signés, **empreinte de l'autre épinglée** des deux côtés ; pendant l'appairage seulement, un **HMAC-SHA-256** prouve que les deux côtés connaissent le secret |
| Messages | Des trames de JSON précédées de leur longueur (1 Mio au plus), numérotées, sans accusé par message ; une version de protocole négociée par ALPN |
| Fusion | **À trois voies**, entité par entité et champ par champ, avec une base par appareil appairé ; le plus récent gagne, **une suppression perd face à une modification** ; les champs inconnus traversent |
| Jamais | Mots de passe, **cookies, sessions et connexions automatiques aux sites**, verrous, historique, onglets privés, Retouches, scripts, extensions, réglages de réseau et de mise à jour (aucune catégorie, y compris l'automatique de la carte 505, n'en transporte : §10.5) |
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
- **L'iPhone est le client** : il se connecte, ouvre la séance et la ferme. Conséquence : les changements faits sur le Mac arrivent sur l'iPhone **à la prochaine séance** (au plus tard l'intervalle choisi sur l'iPhone, 1 minute par défaut, tant que l'application est ouverte à l'écran ; ou au lancement, au retour au premier plan, bouton « Synchroniser maintenant »), **à condition que le Mac écoute** (§6.1), pas au moment où ils sont faits. C'est l'écart assumé de `docs/ios.md` §13.1.
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

Tout fichier lu est **borné** à la lecture (comme `DATA_FILE_MAX_BYTES` du Mac, `persist.ts`) et traité comme hostile. **Une restauration sur un autre appareil** (sauvegarde de l'iPhone, copie d'un profil du Mac) ne ramène pas la clé : si `sync.json` liste des appareils mais que la clé est absente, l'application oublie la liste et dit qu'il faut se réapparier (§12).

## 4. Appairage

### 4.1 Déroulé avec le QR

1. Sur le Mac, la personne ouvre la page « Synchronisation » des Réglages (à créer), active l'interrupteur (l'écoute démarre, §6.1) et touche **« Ajouter un iPhone »**.
2. Le Mac tire un **secret** de 16 octets (`crypto.randomBytes`) et ouvre une **fenêtre d'appairage de 120 secondes**, mesurée par une horloge monotone (un changement d'heure du Mac ne la prolonge pas). Il affiche le **QR**, un compte à rebours, et en dessous l'adresse et le code à saisir (§4.3).
3. Sur l'iPhone, la page « Synchronisation » des réglages de l'application, bouton **« Ajouter un Mac »**, ouvre la caméra. L'iPhone lit le QR, vérifie sa forme (§4.2) et que **chaque adresse est locale** (§6.2), puis ouvre une connexion TLS vers la première adresse qui répond (§5). **Avant d'envoyer le moindre octet**, il compare l'empreinte du certificat que le Mac présente à celle du QR : si elles diffèrent, il ferme (`fingerprint-mismatch`) et ne dit pas « Mac non joignable » mais « ce n'est pas le Mac du code ».
4. Le Mac accepte, **pendant un appairage ouvert seulement** (la feuille « Ajouter un iPhone » : le secret vit 2 minutes), une connexion dont l'empreinte est inconnue ; elle n'a le droit de parler que d'appairage (§7.4). Il envoie `pair.challenge` (un nonce de 16 octets).
5. L'iPhone répond `pair.request` : son identité, son nom, son nonce, une **preuve** = HMAC-SHA-256 du secret sur la transcription (§4.4), **et un engagement** (`commit`, §4.7) : le haché de son empreinte et d'un second nonce, le *nonce de code*, qu'il garde pour lui.
6. Le Mac vérifie la preuve **en temps constant** (`crypto.timingSafeEqual`, **vérifié** dans `@types/node`). Preuve fausse : `bad-proof`, la tentative est comptée, l'appairage reste ouvert. Preuve juste : **le secret est brûlé** (à partir de là, `pairing-used` pour qui le rejoue). **Alors seulement** (§4.7) le Mac tire son propre nonce de code et l'envoie dans `pair.nonce` ; l'iPhone répond `pair.reveal` avec le sien ; le Mac vérifie qu'il ouvre l'engagement du pas 5 (sinon `bad-proof`, rien n'est enregistré).
7. **[Q7, recommandé]** Le Mac affiche « Un iPhone nommé « … » demande à s'appairer » avec **Autoriser** et **Refuser** (60 secondes ; sans réponse, c'est un refus), **le code à comparer** (§4.6, calculé une fois les deux nonces de code connus : la feuille n'apparaît donc qu'après `pair.reveal`) et **l'adresse d'où vient la demande** (revue de sécurité, n° 21 : quelqu'un qui a photographié le QR s'appelle « iPhone de … » aussi, et n'est pas à l'adresse de l'iPhone). Refus : `pairing-refused` ; le secret reste brûlé.
8. Autorisé, le Mac envoie `pair.accept` : son identité, son nom, ses adresses (§5), **le port sur lequel il écoute maintenant** (celui du QR a pu être remplacé depuis : un port pris ou refusé en fait tirer un autre, §6.1 ; l'iPhone garde celui-ci, pas celui du QR) et **sa preuve** (§4.4), **sans avoir enregistré l'iPhone**. L'iPhone vérifie la preuve ; fausse, il n'enregistre rien. La feuille du Mac reste affichée, avec le code et « Annuler », en attendant l'iPhone.
9. **Code à comparer** (décision du chef de projet du 18 novembre 2026, « Code à comparer », n° 9 de la revue) : la preuve du Mac juste et **avant d'enregistrer quoi que ce soit**, l'iPhone affiche « Appairer avec « <nom du Mac> » ? Code : XXXXXX » et **Appairer** / **Annuler** (60 secondes ; sans réponse, c'est un refus). **Annuler** : l'iPhone envoie une `error` `pairing-refused` ; le Mac n'enregistre rien ; l'iPhone non plus. **Appairer** : l'iPhone envoie `bye`.
10. Au `bye` de l'iPhone, le Mac **enregistre l'iPhone** (id, nom, plateforme, empreinte, date) et répond `bye` ; si la liste est pleine, il répond `error` `internal` à la place et l'iPhone n'enregistre rien. Au `bye` du Mac, l'iPhone **enregistre le Mac**. **L'appairage ne s'enregistre donc qu'après les deux accords, donnés dans cet ordre et pas l'un après l'autre sur le même écran** (carte 517, revue de sécurité n° 42) : celui de la personne du Mac (« Autoriser », avec le code et l'adresse sous les yeux), puis celui de la personne de l'iPhone (« Appairer », qui compare le code). **Le Mac ne redemande rien à sa personne quand l'iPhone dit oui** : « Autoriser » est cliqué avant que l'iPhone ne montre son code, et la feuille qui attend ne garde qu'« Annuler ». Le Mac écrit au `bye` de l'iPhone, avant que l'iPhone ne revienne. L'iPhone ouvre ensuite une **séance normale** (§8) : un seul chemin de code pour la première synchronisation et les suivantes.

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

**Une clé que le trousseau n'ouvre pas** (revue de sécurité, n° 22) : sur le Mac, l'identité n'est **pas remplacée au premier refus** — un trousseau qui refuse un instant (une invite refusée, un trousseau verrouillé) emportait sinon tous les appareils appairés, puisqu'une nouvelle identité a une autre empreinte. La page dit « La clé de synchronisation de cet ordinateur n'a pas pu être ouverte… Vos iPhone restent appairés : réessayez dans une minute » ; si l'identité ne peut toujours pas être utilisée à l'essai qui vient **une minute ou plus après le premier refus** (un profil restauré sur une autre machine), une nouvelle identité est faite et la page dit qu'il faut appairer de nouveau (carte 517, revue de sécurité n° 41 : le deuxième essai ne suffit plus, il faut le délai, mesuré sur l'horloge des fenêtres, `IDENTITY_REPLACE_DELAY_MS`). **Un fichier qui n'est pas une identité** (pas de JSON, un certificat que Node ne lit plus après une mise à jour d'Electron, une clé qui n'est pas celle du certificat) **suit la même règle** : il n'est plus remplacé tout de suite, parce qu'on ne sait pas le distinguer d'une lecture qui échoue un instant, et qu'une minute ne coûte rien ; l'erreur est la même (`identity-unopenable`, dont le texte dit « le trousseau a refusé la clé, ou le fichier est illisible »). Un refus qui se répète ne repart pas du début : la minute court depuis le **premier**. Le trousseau de l'iPhone ne remplace rien sans que la recherche de l'identité dise « introuvable » (`KeychainSyncIdentityStore`, lu et laissé tel quel).

### 4.6 Le code à comparer

Sans lui, une personne qui scanne l'affiche ou le message d'un faux QR (« Ajouter un Mac ») fait épingler à son iPhone le Mac de quelqu'un d'autre, et lui envoie ses espaces, ses dossiers, ses favoris et ses onglets épinglés à la première séance : la confirmation du Mac (étape 7) protège le Mac, pas l'iPhone (revue de sécurité, n° 9). Avec lui, l'iPhone dit **qui** il va épingler avant de le faire, et la personne le compare à ce que **son** Mac affiche.

- **Calcul** (carte 517, revue de sécurité n° 36) : `SHA-256(transcription("lucium-sync/1 pair-code", empreinteMac, empreinteIphone, nonceCodeMac, nonceCodeIphone))` (la transcription du §4.4 : l'étiquette, puis chaque champ précédé de sa longueur sur deux octets : deux empreintes de 32 octets, deux nonces de code de 16 octets), les **30 premiers bits**, écrits en **six caractères** de l'alphabet du code à saisir (RFC 4648 : `A–Z`, `2–7` : ni `0`, ni `1`, ni `8`, ni `9` à prendre pour une lettre). Les empreintes sont celles que **chaque appareil a vues dans la poignée de main TLS** (pas celles que l'autre dit avoir) : le Mac en première position, l'iPhone en seconde. Les nonces de code sont ceux de l'échange d'engagement du §4.7, **pas** ceux de la preuve du §4.4.
- **Pourquoi il tient** : un intercepteur tient un certificat à lui vers chaque appareil, donc chaque côté part d'un couple d'empreintes différent et les deux codes diffèrent ; un faux Mac n'a pas de feuille de son côté pour montrer le même code que l'iPhone attend. Le code n'est pas un secret et ne prouve rien tout seul : ce sont les preuves du §4.4 qui prouvent ; le code fait voir à la personne que les deux bouts s'accordent sur **qui parle à qui**. **Ce que 30 bits ne tenaient pas seuls** (n° 36, mesuré par la seconde passe) : tant que le code ne dépendait que des deux empreintes, un attaquant qui a photographié le vrai QR et qui relaie fait varier *son* certificat jusqu'à trouver deux empreintes qui donnent le même code des deux côtés : environ 80 000 certificats par côté s'il choisit les deux, 2³⁰ essais (quelques minutes d'un cœur) si l'empreinte de l'iPhone n'est connue qu'à la connexion. L'engagement du §4.7 supprime cette recherche : le code dépend de deux nonces tirés **après** que l'autre côté s'est engagé, et l'attaquant n'a plus **qu'un essai** par appairage, de probabilité 2⁻³⁰.
- **Montré** : sur le Mac dans la feuille « Autoriser / Refuser », puis pendant l'attente de l'iPhone ; sur l'iPhone après la preuve du Mac, avec le nom que le Mac s'est donné (lu comme du texte, jamais reconnu par lui) et deux boutons, **Appairer** et **Annuler**. Les vecteurs `comparisonCode` et `commitments` de `sync-pairing-vectors.json` fixent le calcul, joués par le code du Mac et par LuciumKit.
- **Rien n'est écrit avant les deux accords** (étapes 7, 9 et 10 du §4.1 ; « les deux accords » sont ceux des deux personnes, donnés l'un après l'autre : celui du Mac, puis celui de l'iPhone, sans second accord du Mac, n° 42) : l'iPhone qui annule, ou se tait, ne laisse rien au Mac ; la personne du Mac qui annule pendant l'attente non plus (`pairing-refused`).

### 4.7 L'engagement : ce que l'attaquant ne peut plus chercher (carte 517, revue de sécurité n° 36)

**Décision du chef de projet, 19 novembre 2026** : l'iPhone s'engage sur son empreinte avant que le Mac montre ce qui fait son code, puis la révèle. C'est la comparaison numérique des appairages Bluetooth (*Numeric Comparison*) : celui qui s'engage ne peut plus changer sa valeur après avoir vu celle de l'autre, et le nombre comparé dépend des deux. Il n'y a pas de choix ouvert : l'état de l'art tranche l'ordre (engagement, valeur de l'autre, révélation) et la longueur (le Bluetooth compare 6 chiffres, soit 20 bits ; ici 30 bits sont gardés).

**Messages** (trois changements, dans cet ordre) :

| Ordre | Message | De → à | Champs |
|---|---|---|---|
| 1 | `pair.challenge` | Mac → iPhone | `nonce` (inchangé) |
| 2 | `pair.request` | iPhone → Mac | `device`, `nonce`, `proof` (inchangés) **et `commit`** : 32 octets en base64url sans remplissage (43 caractères) |
| 3 | `pair.nonce` (**nouveau**) | Mac → iPhone | `nonce` : le nonce de code du Mac, 16 octets (22 caractères) |
| 4 | `pair.reveal` (**nouveau**) | iPhone → Mac | `nonce` : le nonce de code de l'iPhone, 16 octets |
| 5 | `pair.accept` | Mac → iPhone | inchangé (§4.1 pas 8), après la réponse de la personne du Mac |

```
nonceCodeIphone = 16 octets tirés par l'iPhone à chaque appairage, gardés secrets jusqu'au pas 4
nonceCodeMac    = 16 octets tirés par le Mac au pas 3, après avoir reçu l'engagement
commit          = SHA-256(transcription("lucium-sync/1 pair-commit", empreinteIphone, nonceCodeIphone))
code            = les 30 premiers bits de SHA-256(transcription("lucium-sync/1 pair-code",
                      empreinteMac, empreinteIphone, nonceCodeMac, nonceCodeIphone))   (§4.6)
```

**Ce que chaque côté fait, et refuse.**

- **Mac** : au pas 2, il lit `commit` ; un `pair.request` **sans** `commit` ou de la mauvaise forme est un `bad-message` fatal. Il vérifie la preuve comme avant (§4.5 : l'ordre de contrôle du secret ne change pas). **Seulement si le secret répond « accepté »**, il tire `nonceCodeMac` et l'envoie (`pair.nonce`) : un secret fermé, expiré, brûlé ou verrouillé n'obtient aucun nonce. Il attend `pair.reveal` (silence permis : celui de la poignée de main, 10 s). Il recalcule `SHA-256(transcription("lucium-sync/1 pair-commit", empreinteIphoneVueEnTLS, nonceRévélé))` : **l'empreinte est celle de la poignée de main TLS, pas celle que l'iPhone annoncerait**, donc un engagement relayé d'un autre iPhone ne s'ouvre pas. Un engagement qui ne s'ouvre pas : `bad-proof`, fatal, rien n'est enregistré, la tentative est comptée contre l'adresse. Il calcule le code **seulement alors** et montre la feuille « Autoriser / Refuser » (§4.1 pas 7).
- **iPhone** : il tire `nonceCodeIphone` **avant** `pair.request` et ne le met dans aucun message avant `pair.reveal`. Il n'envoie `pair.reveal` **qu'après** avoir lu `pair.nonce` ; un `pair.accept` qui arrive sans `pair.nonce` est un `bad-message` (un Mac qui saute l'étape montre un code que rien n'engage). Il calcule son code avec les deux nonces quand la preuve du Mac est vérifiée (§4.1 pas 9), jamais avant.
- **L'ordre des phases** (§7.4) : côté Mac, `pair.request` puis `pair.reveal` ; côté iPhone, `pair.challenge`, `pair.nonce`, `pair.accept`. Un message hors de cet ordre, ou un second du même type, est un `bad-message` fatal.
- **Un nonce de code n'est jamais celui de la preuve** : celui de la preuve (`nonce` de `pair.challenge` et de `pair.request`) est dit avant l'engagement ; un nonce de code dit trop tôt rouvrirait la recherche.

**Pourquoi l'attaquant n'a plus qu'un essai.** Il tient deux connexions : un faux Mac vers le vrai iPhone (certificat `A1`, celui de son QR) et un faux iPhone vers le vrai Mac (certificat `A2`, secret photographié). Les codes à égaler sont `g(A1, P, nm1, np1)` côté iPhone et `g(M, A2, nm2, np2)` côté Mac. Le vrai iPhone ne révèle `np1` qu'après avoir reçu `nm1` : l'attaquant fixe `nm1` sans connaître `np1`. Le vrai Mac ne donne `nm2` qu'après l'engagement de l'attaquant : celui-ci fixe `A2` et `np2` sans connaître `nm2`. Chaque côté a donc une valeur que l'attaquant ne connaît pas quand il fixe la sienne, et les deux codes sont égaux avec la probabilité 2⁻³⁰, **une seule fois** : le secret est brûlé par la première preuve juste (`pairing-used` ensuite) et un code qui diffère fait annuler la personne. Un attaquant qui n'a pas le secret n'obtient même pas de nonce.

**Ce que cela ne protège toujours pas** : une personne qui ne compare pas les deux codes ; un attaquant qui a le secret et recommence avec un autre QR (la personne du Mac doit alors rouvrir « Ajouter un iPhone » et voit chaque fois la feuille) ; la lecture de la phrase par la personne reste le seul juge. Les 30 bits suffisent donc : un essai à 2⁻³⁰ par QR photographié.

**Version du protocole : aucune compatibilité à garder.** Rien de tout cela n'est publié (aucune version distribuée ne parle l'appairage sans engagement ; seuls tournent des builds d'essai) : le protocole reste `lucium-sync/1` (ALPN, `v` des enveloppes, `lucium-sync:1` du QR) et la forme de l'appairage est **remplacée**, pas étendue. Un Mac et un iPhone d'essai de l'ancienne forme ne s'appairent plus avec ceux-ci (le Mac refuse un `pair.request` sans `commit` ; l'ancien iPhone ne sait pas répondre à `pair.nonce`) : il faut mettre à jour les deux. **Les appareils déjà appairés le restent** (l'empreinte épinglée et la séance du §8 ne changent pas). Une fois une version distribuée, toute modification de cette forme est un changement de version majeure (§7.2).

**Vecteurs** (`ios/Contracts/sync-pairing-vectors.json`) : `commitments` (l'engagement pour des entrées fixes, avec des mutations : changer l'empreinte ou le nonce change l'engagement) ; `comparisonCode` avec les quatre entrées (changer une seule des quatre change le code) ; `transitions` de `sync-message-vectors.json` (les suites de messages qu'une phase d'appairage accepte ou refuse) et les messages `pair.request` (avec `commit`), `pair.nonce` et `pair.reveal` du même fichier. Le Mac et LuciumKit les jouent.

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
| Quand | **Écoute permanente** (décidé par le chef de projet le 19 novembre 2026 : « synchronisation automatique », carte 505). Le Mac écoute **si et seulement si** : (1) l'interrupteur est activé, (2) Lucium n'est **pas verrouillé** (`lock.ts` : un verrou ferme la porte, un déverrouillage la rouvre), (3) **au moins un iPhone est appairé**, ou **un appairage est ouvert** (la feuille « Ajouter un iPhone » : le secret à usage unique vit **2 minutes**, puis la porte se referme s'il n'y a toujours aucun appareil). **Aucun port n'est ouvert** quand l'interrupteur est coupé, quand Lucium est verrouillé, quand Lucium est fermé, ni quand aucun iPhone n'est appairé (hors des 2 minutes d'un appairage). L'écoute n'a **pas d'échéance** ; elle ne dépend pas de la page Réglages (la quitter ne la ferme pas, elle ne ferme que la feuille d'un appairage). La porte se ferme aussi quand le **dernier** iPhone est oublié, avec un court délai (2 s) quand un iPhone dit lui-même qu'il oublie le Mac ou qu'un appairage vient d'être refusé : la réponse due à l'iPhone part avant que la connexion tombe. Une seule fonction décide (`SyncService.reconcileListening`, appelée au lancement, par l'interrupteur, par le verrou, par chaque appairage, oubli ou expiration), jamais deux endroits. **Historique** : [Q5] (18 novembre 2026, « le mieux le plus secure ») avait retenu une fenêtre de 10 minutes ouverte à la main (« Ouvrir la synchronisation », « Prolonger », « Fermer »), qui forçait à ouvrir le Mac puis l'iPhone à chaque fois ; **remplacée le 19 novembre 2026** après le deuxième essai réel. Le coût en sécurité est un **port ouvert en permanence sur le réseau local** tant que la synchronisation est activée : §16 dit ce qui le borne |
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
- Le contenu est du JSON **hostile** : un objet (pas un tableau, pas un nombre), profondeur **32 au plus**, **aucune clé `__proto__`** à aucune profondeur (une copie `obj[clé] = valeur` la prendrait pour le prototype), **aucun genre, identifiant, nom de liste ou identifiant de liste qui porte le nom d'un membre de `Object.prototype`** (`__proto__`, `constructor`, `toString`, `hasOwnProperty`…) **ou `prototype`** : écrit comme *valeur* (`"kind": "__proto__"`), un tel nom fait lire `record[kind] ??= {}` sur le prototype lui-même, et l'entité suivante s'écrit alors dans le prototype de tous les objets du processus (essayé par la carte 448 ; refusé en `bad-message` à la lecture du message, et par `parseSnapshot` pour un fichier ; la lecture Swift n'en a pas besoin, un dictionnaire n'a pas de prototype : un Mac refuse donc un nom qu'un iPhone accepterait, ce qui ne joue que contre un appareil hostile), **toute clé en forme de normalisation Unicode C (NFC)** (un dictionnaire Swift prend pour **une seule** clé « é » écrit avec un ou avec deux caractères, JavaScript en garde deux : avec des clés toutes en NFC, deux clés distinctes d'un côté le sont de l'autre ; vaut aussi pour les noms de genre, d'identifiant, de champ et de liste d'un instantané, §8.3), nombres **finis** ; ceux de 1e21 et plus, de moins de 1e-6 (hors zéro), sont refusés, et `-0` se lit `0` (pour que Swift et JavaScript écrivent les mêmes chiffres, §8.4). **Aucune clé écrite deux fois dans un même objet**, quelle que soit l'écriture (`"n"` et `"\u006e"` sont la même clé) : le Swift garde la première, `JSON.parse` la dernière, et le même message se lirait de deux façons sans que les résumés l'attrapent, puisque chaque appareil hache ce qu'il a lu (revue de sécurité, n° 20 ; vecteurs `duplicateKeys`). **Aucun texte, aucune clé avec un substitut isolé** (`\ud83d` sans sa moitié) : le Swift ne sait pas le lire, et le Mac en produisait en coupant un texte au milieu d'un émoji (n° 15).
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
| `hello` | les deux, **première** trame d'une séance | `device` `{id, name, platform}` (`platform` : `"mac"` ou `"ios"`) ; `nonce` (16 octets, base64url) ; `categories` (liste d'identifiants du §10.1, 0 à 8) ; `baseHash` (64 hex, ou `null` : pas de base) ; `stateVersion` (entier) ; `appVersion` (chaîne ≤ 32) ; `now` (ms depuis 1970, pour la dérive de l'horloge, §9.3) ; `hosts` (Mac seulement, 0 à 4 hôtes locaux) ; `port` (Mac seulement, facultatif : le port d'écoute **actuel**, entier de 1 à 65535, carte 517, n° 38) |
| `pair.challenge` | Mac → iPhone, **première** trame d'un appairage | `nonce` |
| `pair.request` | iPhone → Mac | `device` ; `nonce` ; `proof` (§4.4) ; `commit` (43 caractères, l'engagement du §4.7) |
| `pair.nonce` | Mac → iPhone, après une preuve juste | `nonce` (le nonce de code du Mac, §4.7) |
| `pair.reveal` | iPhone → Mac | `nonce` (le nonce de code de l'iPhone, qui doit ouvrir `commit`, §4.7) |
| `pair.accept` | Mac → iPhone | `device` ; `proof` ; `hosts` ; `port` (le port d'écoute **actuel** du Mac, entier de 1 à 65535, obligatoire : une valeur absente, nulle, trop grande ou qui n'est pas un entier est un `bad-message`, n° 38) |
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

- **Appairage** : `pair.challenge` (Mac) → `pair.request` avec son engagement (iPhone) → `pair.nonce` (Mac, après une preuve juste) → `pair.reveal` (iPhone) → `pair.accept` (Mac) **ou** `error` → puis le mot de la personne de l'iPhone, qui compare le code (§4.6) : `bye` (oui) **ou** `error` `pairing-refused` (non) → le Mac répond `bye` (il a enregistré l'iPhone) **ou** `error` `internal` (il n'a pas pu). Rien d'autre (`bye` et `error` sont admis partout). Un message hors de cet ordre est un `bad-message` (§4.7).
- **Séance** : `hello` des deux côtés ; puis, dans chaque sens, une ou plusieurs `snapshot.part`, éventuellement un `open-tabs`, puis `snapshot.end` ; quand **les deux** `snapshot.end` sont reçus, `result` des deux côtés ; si les `digest` sont égaux, chacun applique, puis `commit` ; `bye`. `unpair` et `error` sont permis après `hello`.

Il n'y a **pas d'accusé par message** : TCP et TLS livrent dans l'ordre et sans perte ou la connexion tombe ; l'**exhaustivité** est contrôlée par `parts`, `entityCount` et `digest`. L'accusé de la **séance** est `commit` : l'état « À jour » ne s'affiche que quand le `commit` de l'autre est reçu.

### 7.5 Bornes en un tableau

| Borne | Valeur |
|---|---|
| Trame | 1 048 576 octets |
| Instantané reçu (somme des contenus d'une séance) | 33 554 432 octets (**32 Mio**) |
| Entités d'un instantané | 100 000 |
| Pierres tombales d'un instantané **envoyées ou reçues** (les plus récentes) | 50 000 (`maxTombstonesPerSnapshot`) : la fusion garde celles des deux côtés, donc au plus 100 000 |
| Entités par partie | 500 |
| Parties | 4096 |
| Profondeur JSON | 32 |
| **Valeurs JSON** (chaque objet, liste, texte, nombre, booléen et `null` compte pour un) | **150 000 par trame, 2 000 000 par connexion** : `too-large` au-delà. Les bornes en octets ne bornent pas le travail : 32 Mio de `[[],[],…]` font plus de 10 millions de valeurs, plus d'un gigaoctet et dix secondes de processus principal arrêté (essayé par la carte 448). Un état réel fait une vingtaine de valeurs par kilo-octet de trame ; 100 000 entités de quinze valeurs en font un million et demi. **Le Swift applique la même borne** (`SyncMessageCodec.valueCount`, carte 452) |
| Chaîne | 65 536 octets |
| Nom d'appareil | 80 caractères ; identifiant 1 à 64 |
| Onglets annoncés | 200 |
| Connexions | 4 + 1 d'appairage |
| Poignée de main / silence / séance | 10 s / 60 s / 10 min (**des deux côtés** : `SyncSessionClient.run` coupe la séance de l'iPhone à 10 minutes, `SyncLimits.sessionMaximum`) |
| Séances automatiques | une toutes les 15 s au plus |
| Appairage | 120 s ; 5 preuves fausses ; 60 s pour confirmer sur le Mac, puis 60 s pour comparer le code sur l'iPhone |

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

L'iPhone ouvre une séance : au **lancement**, au **retour au premier plan** (5 s de délai pour regrouper), **à intervalle réglable tant que l'application est au premier plan** (carte 505, ci-dessous), après un changement local (30 s de délai) et sur **« Synchroniser maintenant »**. Jamais plus d'une séance toutes les **15 s**, même sur demande de l'intervalle. L'application **suspendue** ne synchronise pas (`docs/ios.md` §13.1). Pas de séance si la synchronisation est coupée, si aucun appareil n'est appairé, ou si l'application est **verrouillée** (`locked`). **Le Mac n'écoute que sous les conditions du §6.1** : une connexion refusée ou sans réponse n'est **pas** une erreur grave, c'est l'état « En attente » (§13.3), avec la phrase « Lucium doit être ouvert et déverrouillé sur le Mac » ; l'iPhone n'insiste pas avant la prochaine échéance, qui **s'espace** après des échecs répétés.

**L'intervalle (carte 505).** La page de l'iPhone propose **30 secondes, 1 minute (par défaut), 5 minutes, 15 minutes**, gardés dans `sync.json` (jamais dans `state.json`). Une valeur inconnue dans le fichier redevient 1 minute. Tant que l'application est au premier plan et déverrouillée, une échéance lance une séance ; passer en arrière-plan, verrouiller, couper la synchronisation ou oublier le Mac arrête l'échéance, et le retour au premier plan la relance. **Recul** : après **3 échecs de suite** (Mac absent, qui ne répond pas, ou séance interrompue), l'intervalle est **doublé à chaque échec de plus**, jusqu'à **15 minutes** au plus (30 s : 1, 2, 4, 8, puis 15 minutes) ; un succès, un retour au premier plan ou un « Synchroniser maintenant » remet le compte à zéro. Cela évite de vider la batterie quand le Mac est éteint ou sur un autre réseau.

**Arrière-plan : rien n'est promis.** iOS suspend l'application peu après son départ de l'écran et ne la réveille que quand il le décide. Une tâche d'actualisation d'arrière-plan (`BGAppRefreshTask`) **n'est pas utilisée** : le système choisit quand elle tourne (parfois quelques fois par jour, parfois jamais), Lucium se verrouille en quittant l'écran (`lockAll`, et une séance ne tourne pas verrouillée), et ni ce réveil ni l'accès au réseau local depuis l'arrière-plan ne peuvent être essayés sans appareil. La page le dit : la synchronisation se fait **tant que Lucium est ouvert à l'écran**.

### 8.2 Les entrées

1. **Figer** : chaque appareil prend un **instantané** de sa vue synchronisable (§10), restreinte aux **catégories communes**, et le garde en mémoire. Les modifications que la personne fait pendant la séance **ne changent pas** cet instantané.
2. **`hello`** : chacun envoie le sien. Les catégories sont l'**intersection** (une catégorie ne passe que si les deux l'ont cochée). Si `baseHash` diffère, ou est `null` d'un côté : **pas de base commune**, la fusion se fait à base vide (§11.8). Si l'`stateVersion` de l'autre est **supérieure** à celle que l'appareil sait écrire : `state-too-new`.
3. **`snapshot.part`** : chacun envoie son instantané complet (§8.3), puis **`snapshot.end`**.
4. **`open-tabs`**, entre `hello` et `snapshot.end`, si la catégorie `openTabs` est commune (§10.4 d'origine). **Remplacé** : les onglets d'« Aujourd'hui » sont des entités du genre `todayTab` dans l'instantané (§27.2), et le message `open-tabs` est retiré si [Q8] = A (§27.11).

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

Genres : `space`, `folder`, `tab` (épinglés seulement), `todayTab` (les onglets d'« Aujourd'hui », catégorie `todayTabs`, §27), `favorite`, `archived`, `setting`. Sur le fil, les entités voyagent en **éléments** `{ "kind", "id", "fields", "stamps" }` répartis dans les `snapshot.part`. Un même `(kind, id)` **deux fois** dans un instantané est un `bad-message`. `fields` contient **les champs synchronisés et tous les champs inconnus** de l'entité (§10.2, §11.6) ; `stamps` a une marque par champ, **y compris** pour un champ qui a été retiré (absent de `fields`) ; **un champ absent dont la marque serait « zéro » n'a pas d'entrée** (elle ne dirait rien, et deux appareils ne l'écriraient pas pareil). **Sur le fil**, chaque `snapshot.part` porte ses entités, une liste de pierres tombales `{ "kind", "id", "stamp" }` et, comme objets, les morceaux de `order` et d'`orderStamps` qu'elle apporte ; l'instantané assemblé est celui de la forme ci-dessus.

### 8.4 Forme canonique et résumé

Le `digest` d'un instantané est le **SHA-256, en hexadécimal minuscule, de sa forme canonique**. La forme canonique est celle de la **RFC 8785** (JCS) : UTF-8, aucune espace, clés des objets triées par **unités de code UTF-16**, chaînes et nombres écrits comme `JSON.stringify` de JavaScript. Elle est choisie parce qu'elle est une norme et que le TypeScript n'a rien à écrire de plus. Le Swift devra imiter les chiffres de JavaScript ; **c'est pourquoi les nombres du §7.1 sont bornés** (aucun exposant, aucun `-0`). Les vecteurs `canonical` contiennent les cas difficiles (accents, clé hors du plan multilingue de base, nombres, échappements).

### 8.5 Fusion, comparaison, application

1. Chacun fusionne **localement** : `fusion(base, local, distant)` (§11), même fonction, mêmes entrées ; résultat = **l'instantané fusionné**, ses conflits, ses suppressions.
2. Chacun envoie **`result`** avec le `digest` de l'instantané fusionné. **Différents** : `divergence`, **rien n'est écrit** de part et d'autre ; la personne voit « Les deux appareils ne s'accordent pas » ; c'est un bogue à signaler, jamais un état normal.
3. **Égaux** : chacun **applique** le résultat à son état :
   - il calcule le **patch** entre son instantané figé et le fusionné ;
   - il l'applique à l'état **courant** par le réducteur (`src/shared/sidebar.ts` côté Mac : une action `sync/apply`, **une seule**, qui ne touche que ce que le patch nomme) ; une entité que la personne a changée **depuis** l'instantané garde son changement local : la séance suivante le propagera ;
   - il **nettoie** ce qui entre comme à la lecture d'un fichier (`parseStateText`, `state-clean.ts` : chaque champ reçu est reborné ; une entité invalide est **écartée**, comptée et journalisée, jamais fatale) ; une adresse reçue n'est acceptée que si les règles de lecture de l'état l'acceptent (la carte 444 nomme les fonctions de `state-clean.ts` qui s'en chargent) ;
   - **une suppression d'espace venue de l'autre appareil n'emporte pas sans trace les onglets ouverts de celui-ci** : ceux d'« Aujourd'hui » de l'espace supprimé (ni épinglés, ni privés, ni une page interne), **qu'ils soient partagés (§27) ou non** (la fusion retire ceux qui pendent, §11.7), vont d'abord dans **l'archive** (source `sync`), dans l'espace où la personne se trouve, à défaut le premier qui reste ; une suppression faite sur place demande, elle, la confirmation de la personne (revue de sécurité, n° 13) ; **ces entrées ne repartent pas** (revue de sécurité, n° 37) : l'autre appareil n'est pas censé recevoir, sous « archive », des adresses et des titres que la case « Onglets ouverts » n'a jamais autorisés ; elles ne comptent pas non plus parmi les 500 les plus récentes d'un espace ;
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

(par exemple `1790000000123-0003-AbCd…`), **comparée comme un texte, octet par octet**. La marque « zéro », celle d'un champ sans marque connue, est la chaîne `"0"`, plus petite que toute autre. Les **marques** sont fabriquées par une **horloge logique hybride** (HLC) : `ms` = le plus grand de l'heure du jour, de la dernière marque émise et de la dernière marque reçue ; le compteur compte les marques d'une même milliseconde. Une marque trouve son champ **à l'écriture de l'état** : l'appareil compare l'état avant et après (par entité d'abord, par champ ensuite) et marque ce qui a changé, **au moment où il le voit** (au plus 300 ms après le geste : le délai de l'écriture de `StateStore` ; sur l'iPhone l'écriture de l'état attend 500 ms, c'est donc à cette écriture que les marques sont relevées). Ce n'est donc pas l'heure d'une synchronisation, mais celle du geste, à une fraction de seconde près.

L'égalité de deux marques est impossible entre deux appareils (l'identifiant d'appareil y figure) ; **à égalité de `ms` et de compteur, l'identifiant le plus grand (ordre des octets) gagne**. C'est le « départage par l'identifiant d'appareil » de `docs/ios.md` §13.4. **Deux marques identiques** (le cas de deux champs jamais marqués, tous deux « zéro ») : la valeur dont la **forme canonique** (§8.4) est la plus grande gagne, les deux textes étant comparés **par unité de code UTF-16**, comme les clés de la forme canonique (et non par octet UTF-8 : un caractère hors du plan multilingue de base, « 😀 », est alors **plus petit** que « ～ » U+FF5E) ; c'est arbitraire, mais pareil des deux côtés. Un vecteur de fusion le tient. Les vecteurs `stamps` fixent l'ordre, `-` et `_` compris.

### 9.3 Dérive

- Les deux `now` d'un `hello` s'écartent de plus de **5 minutes** : `clock-skew`, avertissement **non fatal**, affiché une fois (« L'horloge de … diffère de plus de 5 minutes de la vôtre : en cas de conflit, le choix du plus récent peut se tromper »).
- Une marque reçue **plus de 7 jours dans le futur** (par rapport à l'heure locale) fait **écarter l'entité** (comptée et journalisée, jamais fatale) : un appareil à l'heure fausse ne gagne pas tous les conflits pour toujours. **Il en va de même pour une pierre tombale et pour une liste avec sa marque d'ordre** : elles sont écartées de la même façon, **de ce qui vient de l'autre appareil comme de ce que cet appareil lui envoie** (avec l'heure de l'autre pour ses marques, §22). Sans cela, une seule pierre tombale datée de l'an 2286 passait, supprimait tout ce qu'elle nomme, et tirait l'horloge des marques de l'appareil au-delà de ce que tout autre accepte : ses marques suivantes étaient alors refusées par l'autre appareil, pour toujours (essayé par la carte 448). **Le Swift applique la même règle** (`SyncInbound.clean`, carte 452, jouée contre les vecteurs `clean` de `sync-state-vectors.json` que produit `cleanSnapshot` du Mac) : sans elle, un iPhone qui garderait une marque du futur ferait diverger les deux résumés (`divergence`, rien n'est écrit). **La fusion elle-même ne lit jamais l'heure du jour** : c'est une fonction pure de ses entrées (§11.1), ce qui la rend identique des deux côtés.
- **Une horloge qui s'est trompée se rétablit** (revue de sécurité, n° 18) : l'horloge des marques ne reste pas pour toujours en avance. Si la dernière marque est à **plus de 7 jours devant l'heure du jour**, ou au bout de ce que treize chiffres tiennent (`9999999999999`), la marque suivante part de l'heure du jour ; et chaque marque d'un champ, d'une pierre tombale ou d'une liste qui est à plus de 7 jours devant l'heure du jour est **refaite** (comme un changement de maintenant) à la prochaine lecture de l'état : sans cela, tout ce que l'appareil avait changé pendant que son horloge était fausse restait refusé par l'autre pour toujours (§9.3). Une avance de quelques minutes (la dérive habituelle) n'y change rien. Le Swift fait de même (`SyncMarkBook.next` et `update`, testés dans `SyncMarksReviewTests`). **Mais une horloge qui recule n'est pas une horloge qui s'était trompée** (carte 517, revue de sécurité n° 35) : localement, une horloge fausse en avance puis remise à l'heure (n° 18) et une horloge juste qu'on recule de plus de 7 jours (marques bonnes, heure du jour en retard) sont indiscernables, et refaire les marques dans le second cas les fait perdre contre tout ce que l'autre appareil a changé entre-temps. Seul l'autre appareil les départage : ses marques sont faites à **son** heure. L'horloge garde donc, avec elle (clé `peer` de l'objet `clock` du fichier de marques, facultative), **le plus grand instant d'une marque venue d'un autre appareil** (`Hlc.peer`, `SyncMarkBook.peer` : une marque reçue est écartée si elle est à plus de 7 jours devant l'heure d'alors, §9.3 : l'autre appareil ne peut pas pousser cette valeur plus loin) et mesure tout ce qui précède (« à plus de 7 jours devant », départ de l'horloge, marques refaites) **contre le plus grand de l'heure du jour et de cette valeur**. Une horloge reculée de plus de 7 jours **après** que l'autre appareil a montré son heure ne fait donc plus reculer les marques (elles continuent, compteur après compteur, après celles déjà faites) ; des marques devant l'heure du jour **et** devant l'autre appareil sont encore celles d'une horloge qui s'était trompée, et sont refaites comme avant. Sans mot de l'autre appareil (aucune séance encore), rien ne change. Une marque de cet appareil n'est jamais prise pour celle de l'autre (l'identifiant d'appareil de la marque départage).
- La fenêtre d'appairage utilise une horloge **monotone** (§4.1) ; aucun contrôle de sécurité ne repose sur l'heure du jour.

## 10. Ce qui est synchronisé, et ce qui ne l'est jamais

### 10.1 Les catégories

La personne coche ce qui voyage ; **une catégorie ne passe que si les deux appareils l'ont cochée**, **en réception aussi** : ce qu'un appareil envoie d'une catégorie qui n'est pas commune (réglages, archive, structure) est écarté avant la fusion, des deux côtés (`onlyExchanged`), et compté comme « non synchronisé » ; un appareil honnête n'en envoie jamais (revue de sécurité, seconde passe : sans cela un appareil appairé pouvait baisser les réglages de vie privée sans que « réglages » soit coché). Valeurs par défaut **[Q2]** : **seule `structure` est cochée**, les trois autres sont au choix de la personne, chacune avec sa phrase.

| Identifiant | Contenu | Fusionné ? | Défaut |
|---|---|---|---|
| `structure` | espaces, dossiers, favoris, onglets **épinglés** | oui | **coché** |
| `settings` | les huit réglages de §10.3 | oui | **non coché** |
| `archive` | onglets archivés (au plus **500 par espace**, les plus récents ; **sans** les entrées de source `sync`, qui restent où l'espace a été supprimé : carte 517, revue de sécurité n° 37) | oui | **non coché** |
| `todayTabs` | les **onglets d'« Aujourd'hui »** : ouverture, fermeture, espace, ordre, nom et icône (§27) ; **remplace** `openTabs` [Q8] | oui (genre `todayTab`) | **non coché** [Q9] |
| ~~`openTabs`~~ | ~~annonce des onglets ouverts (« Reprise »)~~ : **retirée** si [Q8] = A ; historique au §10.4 | — | — |

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
| `todayTab` (§27.2) | `id`, `spaceId`, `customTitle`, `icon`, `activeAt` (projection de `lastActiveAt`, arrondie à 10 minutes) | `url`, `title` (copiés à l'entrée dans l'ensemble partagé) | tous les autres champs de `TabItem` (dont `container`, `windowKey`, `parentId`, `lastActiveAt`) |
| `favorite` | `id`, `url`, `title`, `profileId` | — | `faviconUrl` (un cache) |
| `archived` | `id`, `spaceId`, `url`, `title`, `archivedAt`, `source`, `pinned`, `anchorUrl`, `folderId` | — | `history`, `container` |
| `setting` | `value` | — | — |

**Deux règles de valeur** s'ajoutent à la classe (revue de sécurité, n° 15 et 16) : le `profileId` d'un espace ou d'un favori est **un identifiant de profil du Mac** (1 à 32 caractères de `A–Z`, `a–z`, `0–9`, `_` et `-`), puisque la clé de la liste des favoris en est faite (`favorites:<profil>`) : un profil de 500 caractères rendait la base illisible, et un profil écrit en deux formes Unicode donnait deux listes ; et **aucun texte d'une entité ne porte de substitut isolé**. Une entité qui ne les tient pas est refusée comme pour une adresse qui n'est pas une page (`invalid-value`, la version de la base prend sa place). Un **test de classement** de la carte 444 énumère **tous les champs** de `Space`, `Folder`, `TabItem`, `Favorite` et `ArchivedTab` de `model.ts` et **échoue** si l'un n'est dans aucune classe : un champ ajouté au Mac sans décision de synchronisation ne part pas par défaut. Les vecteurs (`fieldClasses`) donnent la table ci-dessus sous une forme lisible par un test, et le test de contrat **vérifie que chaque champ nommé existe** dans `model.ts`. Ce que la table ne classe pas (un champ **inconnu** d'une version plus récente) est **synchronisé comme opaque**, parce qu'un appareil qui le connaît l'a écrit pour être partagé ; ce choix est valable seulement pour les **entités**, jamais pour les réglages (liste fermée, ci-dessous).

### 10.3 Les réglages : une liste fermée

Un réglage ne se synchronise **que s'il est dans cette liste** (rien n'est « tous sauf ») :

| Clé | Pourquoi |
|---|---|
| `httpsUpgrade`, `sendGpc`, `stripTrackingParams`, `stripCopiedLinks`, `protectionBaseline` | les cinq règles de vie privée que **l'iPhone lit déjà** avec les noms du Mac (`docs/ios.md` §7.1) |
| `autoArchiveHours` | l'iPhone applique la même règle (12 h par défaut) |
| `searchUrlTemplate` | le moteur de recherche (l'iPhone le lit) ; **seulement un des moteurs que Lucium propose** (la liste des Réglages, `SEARCH_ENGINES`, tous en `https`) : un modèle reçu qui n'est pas dans cette liste (un autre hôte, `http`, un modèle de plus après le bon) est refusé (`invalid-value`). **Un moteur personnalisé reste sur l'appareil qui l'a, dans les deux sens** : il n'est pas envoyé, et le moteur que l'autre appareil a ne le remplace pas. Sans cela, un appareil appairé aurait pu envoyer toutes les recherches de l'autre vers un serveur de son choix (revue de sécurité, n° 10). Les vecteurs portent la liste (`searchEngines`) |
| `profileNames` | les noms que la personne a donnés à ses profils |

Une valeur reçue est **rebornée comme à la lecture d'un fichier** (`cleanPrivacySettings`, `mergeSettings`) : un booléen qui n'en est pas un, un nombre hors bornes, une chaîne trop longue sont écartés. Une valeur est **un seul registre** : `profileNames` (un dictionnaire) est tranché **en entier**, pas clé par clé. **`profiles`** (les réglages propres à un profil) n'est **pas** synchronisé en v1. La liste **ne grandit que par une pull request qui change ce document et ses vecteurs** (`settingsAllowed`, `settingsNever`).

### 10.4 Les onglets ouverts : une annonce, pas une fusion (décision du 18 novembre 2026, **remplacée le 19 novembre 2026**)

> **Remplacé par le §27.** Le 19 novembre 2026, après le deuxième essai réel (« j'ai pas les onglets du jour qui se synchronisent » → « Vrais onglets partagés »), le chef de projet a décidé que les onglets d'« Aujourd'hui » **sont** des entités partagées : ouvrir ou fermer un onglet sur un appareil le fait sur l'autre à la séance suivante. La catégorie `todayTabs` et le genre `todayTab` (§27) prennent la place de ce qui suit, que [Q8] retire si le chef suit la recommandation. Le texte d'origine est gardé **pour l'historique de la décision** ; il n'est plus la règle.

*Texte d'origine (18 novembre 2026).* Les onglets d'« Aujourd'hui » **ne sont pas des entités** : ouvrir 80 onglets sur un appareil ne doit pas en ouvrir 80 sur l'autre. La catégorie `openTabs` envoie seulement une **liste en lecture seule** (`open-tabs`, §7.3) : adresse, titre, espace, dernière activité, **200 au plus**, `http` et `https` seulement **à l'envoi et à la réception** (l'appareil qui reçoit écarte, compte et journalise tout autre onglet annoncé : un script, un fichier local, une adresse de données ; essayé par la carte 448), **jamais** un onglet privé, jamais un onglet d'un espace verrouillé [Q4]. L'autre appareil la garde **en mémoire seulement** (jamais écrite) et la montre dans « Reprendre un onglet du Mac » (carte 447). Toucher une ligne **ouvre un onglet local** avec cette adresse, par le chemin ordinaire d'ouverture d'adresse ; rien d'autre n'est copié. La liste est **vidée** à la fin de la séance et quand l'appareil est oublié. Les titres et adresses des onglets ouverts sont ce qui ressemble le plus à un historique : d'où le défaut **non coché** [Q2].

**Ce qui est resté vrai** : la limite de 200, `http` et `https` seulement à l'envoi **et** à la réception, jamais un onglet privé, jamais un onglet d'un espace verrouillé [Q4], le défaut **non coché**, et la raison de la prudence (titres et adresses = ce qui ressemble le plus à un historique) : le §27 les reprend, avec ce qu'il ajoute (§27.8).

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

L'ordre d'affichage est un **registre par liste**, pas un champ par entité. Une liste est une suite d'identifiants dont la clé est composée du genre et de son conteneur : `spaces` ; `folders:<espace>:<parent ou ->` ; `tabs:<espace>:<dossier ou ->` (épinglés) ; `today:<espace>` (les onglets d'« Aujourd'hui », §27.2) ; `favorites:<profil>`. (`archived` n'a pas d'ordre : la liste suit `archivedAt`.) Pour une liste `k`, avec `membres` = les entités fusionnées qui en font partie :

1. `restreindre(liste)` = la liste sans ce qui n'est pas dans `membres` et sans doublon.
2. Un côté a **réordonné** si, parmi les identifiants communs à sa liste et à celle de la base, leur **ordre relatif** diffère de celui de la base.
3. Les deux ont réordonné **de la même façon** : cette liste, sans conflit. Les deux ont réordonné **différemment** : la liste dont la marque d'ordre (`orderStamps[k]`) est la plus grande l'emporte (à marques égales, la plus grande forme canonique). Un seul : sa liste. Aucun : la liste de la base. La marque d'ordre du résultat est la plus grande des deux.
4. On **ajoute à la fin** les membres qui ne sont pas dans la liste retenue (ajoutés ou arrivés de l'autre côté), triés par **marque de naissance** (la plus petite marque des champs de l'entité ; « zéro » sans marque), puis par identifiant.

Une liste qui n'a **aucun membre** n'est pas écrite dans le résultat, **ni sa marque d'ordre** : une marque sans liste serait perdue à la fusion suivante (qui lit les clés des listes), et un résultat qui change quand on le fusionne encore n'est pas idempotent (§11.9). L'issue est symétrique : échanger `local` et `distant` donne la même suite. **Deux réorganisations différentes ne sont pas fusionnées : la plus récente gagne, et ce que l'autre côté avait ajouté va à la fin.** C'est une perte acceptée et dite dans le résumé du conflit.

### 11.5 Suppressions et pierres tombales

Une suppression est gardée **30 jours** sous forme de **pierre tombale** `(genre, id, marque)` puis purgée (`docs/ios.md` §13.4). Avec une base valide, l'absence dans l'instantané suffit à voir une suppression ; **à base vide**, c'est la pierre tombale qui la dit : une entité **présente d'un côté** et **à pierre tombale de l'autre** est **supprimée si la plus grande marque de ses champs est plus petite que celle de la pierre**, **gardée sinon** (une modification postérieure à la suppression gagne). **Les pierres tombales sont bornées** (revue de sécurité, n° 14) : un appareil n'en envoie que **50 000 au plus, les plus récentes** (à marque égale, le genre puis l'identifiant les plus petits : les deux appareils gardent les mêmes), la moitié de ce qu'un instantané peut porter, parce que la fusion garde celles des deux côtés et qu'une base de plus de 100 000 pierres ne se relisait plus (« too many tombstones » sur les deux appareils à la séance suivante, avec 198 000 après deux séances) ; **celles d'un genre de code ou de secret** (`password`, `vault`, `boost`… `neverKinds`) **sont refusées**, comme les entités du même genre (elles étaient acceptées puis renvoyées). Le plus ancien qui ne passe pas est compté et journalisé (`too-many-tombstones`), jamais fatal. Si la dernière séance avec un appareil date de **plus de 30 jours**, ses suppressions ont pu être purgées : **la fusion se fait à base vide et ce qui avait été supprimé peut revenir** ; l'écran d'état le dit.

### 11.6 Champs inconnus

Un champ qu'une version plus récente a ajouté, un genre que cette version ne connaît pas, **traversent** : ils sont gardés dans `fields`, fusionnés comme les autres champs (§11.3) et rendus. Un appareil **ne supprime jamais** ce qu'il ne comprend pas. C'est la règle des « champs étrangers » du Mac (`store.ts`) et de `rest` côté Swift (`docs/ios.md` §5). **Réserve** : un champ inconnu n'est fusionné que s'il est dans une entité **du genre connu** et si sa valeur passe les bornes générales du §7.1.

**Ce qu'un appareil ne comprend pas ne devient jamais une suppression** (carte 517, revue de sécurité n° 39 et 40) :

- **Un genre ou une liste inconnus** passent la première fois dans la fusion et dans la base ; l'état n'en tient rien. Un instantané fait de l'état seul dirait donc « supprimé ici » à la séance suivante, et la fusion enverrait à l'autre appareil la suppression de ses propres données. L'instantané **reprend de la base**, tels quels, les entités des genres inconnus et les listes inconnues (`snapshotOf` côté Mac, `SyncStateView.snapshot` côté iPhone) : aucun changement local, rien à trancher. Le vecteur `view` « what the base holds of a kind or a list this version does not know… » le fixe pour les deux langages. Un genre connu que l'état ne tient plus reste une suppression.
- **Une entité qu'`apply` refuse d'écrire** (un dossier au nom blanc, un onglet sans adresse : iPhone seulement, le Mac écrit ce que la fusion lui donne) est dans le résultat et dans la base, mais pas dans l'état : même risque, même remède, par une **mémoire locale**. L'iPhone note à côté de sa base (`sync-base-<id>.json`, clé `refused`) les entités qu'`apply` n'a pas faites (`SyncApply.Outcome.rejections`) et les reprend de la base à la séance suivante, tant que la fusion les garde (`SyncApplyRefused.swift`). **La base elle-même n'est pas modifiée** : la décision de la carte disait « ne pas adopter dans la base ce que `apply` rejette », mais une base qui diffère d'un appareil à l'autre change le `baseHash` de `hello` pour toujours, donc plus aucune séance ne fusionne depuis la base (§8.2) : les suppressions seraient perdues à chaque séance. Le but (aucune suppression poussée) est atteint sans cela. Seules les entités refusées en entier sont retenues ; une **valeur** refusée d'une entité qui existe n'est pas traitée (non rejoué, hors de ce que la revue disait).

### 11.7 Après la fusion

1. **Références pendantes** : un `tab`, un `folder` ou un `archived` dont l'`spaceId` n'existe pas dans le résultat est **retiré** et **laisse une pierre tombale** marquée de son propre dernier changement (un changement postérieur, ailleurs, le ramène ; il est alors retiré de nouveau : c'est ce qui rend la fusion idempotente) ; un `folderId` ou un `parentId` qui ne désigne rien est **effacé** (l'entité retourne à la racine), sa marque est gardée (sauf si elle est « zéro », §8.3). Cette étape est **dans la fusion** (et pas dans la normalisation de l'appareil) pour que les deux appareils la fassent pareil.
2. **Cycles** : si des `parentId` de dossiers forment un cycle, le `parentId` du dossier dont l'**identifiant est le plus petit** est effacé (sa marque est gardée, sauf « zéro »), et on recommence jusqu'à ce qu'il n'y ait plus de cycle.
3. **Résumé des conflits** : chaque champ tranché par marque, chaque suppression perdue (« gardé »), chaque réorganisation perdue donne une ligne `{kind, id, field, winner, reason}` (`reason` : `newer` (le temps ou le compteur des marques diffère), `device-id` (même temps et même compteur : l'identifiant d'appareil départage), `value` (la **même** marque des deux côtés, un champ jamais marqué : la forme canonique départage, §9.2), `modification-over-deletion`, `order` ; `winner` est `local` ou `remote` **du point de vue de l'appareil qui fusionne** : l'autre appareil voit les mêmes lignes avec les deux côtés échangés). Les lignes sont **triées par `kind`, puis `id`, puis `field`** (une ligne sans champ avant celles qui en ont), chaque texte comparé par unité de code UTF-16 et **sans règle de langue** : le même ordre en TypeScript et en Swift. Les deux appareils calculent la **même** liste ; la valeur perdue est gardée **30 jours, au plus 200 lignes**, dans un journal **local** (`sync-conflicts`) pour le bouton **« Comparer »** ; ce journal contient des adresses et des titres : il suit les règles de confidentialité des autres fichiers de l'appareil, et il disparaît avec l'appareil oublié. **Forme** : un fichier `{ "v": 1, "entries": [...] }` à côté de `state.json` ; **une ligne par chose réglée** (`[kind, id, field]` écrit en JSON), qui garde le moment de la séance, l'autre appareil, la raison, le gagnant, le nom de la chose **tel que la personne l'a écrit** (nom d'un espace ou d'un dossier, titre d'un onglet, adresse à défaut : 120 caractères au plus), les deux valeurs **telles qu'on les lit** (texte coupé à 80 caractères, oui ou non, « aucune valeur », « une autre valeur » ; un dossier ou un espace par son nom, jamais par son identifiant ; un identifiant de profil n'est pas montré), le moment de chaque changement (lu dans les marques) et **ce qui remet la version perdue** (un champ remis à sa valeur ou retiré, l'entité supprimée, la liste remise dans son ordre ; rien si la valeur dépasse 4096 caractères). Une ligne qui règle de nouveau la même chose **remplace** l'ancienne ; une ligne de plus de 30 jours, ou au-delà de 200, s'en va. **Un fichier est hostile avant d'être lu** : il est borné à 4 Mio, chaque ligne est vérifiée (formes, bornes, noms en NFC, aucune clé `__proto__`) et copiée, une ligne mal formée est écartée et comptée, un fichier illisible donne un journal vide (et le dit), un fichier d'une version plus récente **n'est jamais réécrit**. Les phrases sont des **clés de catalogue** (`sync-conflict.*`) et les mots qu'on y met (§13.4) ; les deux langages écrivent les mêmes lignes et les mêmes phrases (`sync-conflict-vectors.json`).

### 11.8 Première synchronisation et base perdue [Q3]

La **base** d'un appareil appairé est l'instantané fusionné de la dernière séance **réussie** (§8.5). Elle est **vide** quand c'est la première séance, quand `baseHash` diffère ou est `null` (l'autre côté n'a pas la même), ou quand la dernière séance date de plus de 30 jours. **Base vide** = chaque entité présente d'un côté est un ajout : c'est **l'union** des deux états, un conflit de champ est tranché par la marque, et les pierres tombales tranchent les suppressions (§11.5). **Exception retenue [Q3]** : un iPhone **jamais modifié depuis son premier lancement** (aucun espace, onglet ou dossier créé par la personne ; un drapeau que la carte 445 passe à faux à la première action de la personne) **adopte l'état du Mac** au lieu de s'y ajouter, pour que le Mac ne reçoive pas un espace vide en plus des siens. **Comment** : cet iPhone envoie un **instantané vide de sa structure** (`emptySnapshot()` pour les espaces, dossiers, onglets épinglés et favoris, leurs listes et leurs pierres tombales) et fusionne avec un instantané **local** de même forme ; il dit `baseHash: null` dans son `hello` pour que le Mac fusionne lui aussi à base vide ; le Mac reçoit donc l'état d'un appareil qui n'a rien, et les deux appareils fusionnent les mêmes entrées (`mergeSnapshots(null, mac, vide)` et `mergeSnapshots(null, vide, mac)` donnent le même instantané, **sans conflit** : testé). L'application du patch (§8.5) retire alors de l'iPhone ce qu'il avait (son espace du premier lancement) et y met l'état du Mac. **Précision (carte 452, réponse du chef de projet le 18 novembre 2026)** : le drapeau ne dit que « rien n'a été arrangé » : il ne regarde ni les réglages ni l'archive. **Seule la structure est donc vidée**, et seulement quand la catégorie `structure` est commune ; les réglages communs et l'archive partent et se fusionnent normalement (sinon un iPhone dont seuls les réglages ont changé reprendrait à chaque séance les valeurs du Mac). Le patch se calcule, lui, depuis l'instantané **réel** de l'iPhone : c'est lui qui retire ses espaces, et un espace verrouillé reste de côté comme toujours (§18).

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

- Un **interrupteur** « Synchroniser avec mes appareils » (**désactivé**), sous-texte : « Entre votre Mac et votre iPhone, sur votre réseau local. Rien ne passe par un serveur. » ; **plus de bouton « Ouvrir la synchronisation »** (carte 505) : une ligne dit **« Cet ordinateur attend votre iPhone sur le réseau local »** quand il écoute (ou « aucun iPhone n'est appairé : aucun port n'est ouvert », ou « devrait attendre votre iPhone mais n'écoute pas » avec la raison du message au-dessus), et que l'iPhone choisit son rythme ; la ligne de la page des fichiers dit « à l'écoute ». « Ouvrir / Prolonger / Fermer » et leurs demandes IPC sont **retirés** et refusés par le contrôle de la demande.
- Une phrase, sous les catégories : **« Jamais synchronisés : les mots de passe, les cookies, les sessions et les connexions automatiques aux sites, … »** (la même sur la page de l'iPhone).
- Les **catégories** (§10.1), chacune avec une phrase qui dit ce qu'elle envoie ; « Onglets d'Aujourd'hui » dit : « Les titres et les adresses de vos onglets d'Aujourd'hui sont envoyés à l'autre appareil. » (§27.8) ; **[Q9]** : la feuille « Autoriser » porte en plus une case décochée « Partager aussi les onglets d'Aujourd'hui »
- La **liste des appareils** : nom, plateforme, **dernière synchronisation** (« il y a 2 min »), **« Oublier »** ; **« Ajouter un iPhone »** (feuille : QR, compte à rebours, adresse, code, bouton « Fermer »). Quand un iPhone a prouvé qu'il connaît le secret, la feuille « Autoriser / Refuser » dit son nom, **l'adresse d'où vient la demande** et **le code à comparer** (§4.6) ; une fois « Autoriser » touché elle reste, avec le code et « Annuler », jusqu'à ce que la personne de l'iPhone ait confirmé.
- Une **ligne d'état** (§13.3) et, s'il y en a un, **« Dernier conflit réglé »** (§13.4).
- Un lien vers ce qui est dit des **connexions** (§14).

### 13.2 iPhone : la page « Synchronisation » des réglages

Un interrupteur, **« Ajouter un Mac »** (caméra, puis « Saisir un code » ; une fois la preuve du Mac vérifiée, **« Appairer avec « <nom du Mac> » ? Code : XXXXXX »** avec **Appairer** et **Annuler**, §4.6), la liste (un Mac), **« Synchroniser maintenant »**, **le réglage « Synchroniser tout seul » (30 secondes, 1 minute, 5 minutes, 15 minutes ; 1 minute par défaut, carte 505)**, « Oublier ce Mac », la ligne d'état, et la phrase « Jamais synchronisés : les mots de passe, les cookies, les sessions et les connexions automatiques aux sites. ». Le sous-titre « Synchronisé avec le Mac » des espaces (`docs/ios.md` §3) **apparaît** quand la synchronisation est active. Aucune option « Passer par iCloud » (décision du 17 novembre 2026).

### 13.3 États

| État | Condition | Message (clé) |
|---|---|---|
| Désactivée | interrupteur coupé | `sync.state.off` |
| Aucun appareil | activée, aucun appairage | `sync.state.noDevice` |
| En attente | l'iPhone n'a pas encore de séance, ou **le Mac n'écoute pas** (Lucium fermé ou verrouillé sur le Mac, synchronisation coupée là-bas, ou aucun iPhone appairé de son côté) : « Lucium doit être ouvert et déverrouillé sur le Mac » | `sync.state.waiting` |
| Appareil absent | aucun candidat n'a répondu | `sync.state.unreachable` |
| En cours | séance ouverte | `sync.state.running` |
| **À jour** | `commit` de l'autre reçu : « il y a n min » | `sync.state.upToDate` |
| Espaces de côté | n espaces verrouillés [Q4] | `sync.state.lockedSpaces` (pluriel : `.one` / `.other`) |
| Horloge | `clock-skew` | `sync.state.clockSkew` |
| Erreur | un code fatal du §7.6 | `sync.error.<code>` |

**« Dernier échange » (iPhone).** « À jour » seul ne dit pas ce qui a traversé : une catégorie cochée sur l'iPhone et pas sur le Mac ne passe pas, et les onglets d'« Aujourd'hui » ne passent que si « Onglets d'Aujourd'hui » est cochée **des deux côtés** (§27 ; au premier essai réel, 19 novembre 2026, ils ne passaient pas du tout : seuls les onglets épinglés, avec « Espaces et dossiers », et la liste de « Reprendre un onglet du Mac », avec « Onglets ouverts »). Le premier essai réel (19 novembre 2026, carte 494) a montré un iPhone qui avait bien reçu l'espace « Perso » du Mac, sans que la page le dise. Une section **« Dernier échange »**, tant que l'application n'a pas été relancée (le résumé est gardé en mémoire avec la séance), dit : les catégories **échangées** (celles que les deux appareils ont cochées), celles **pas échangées parce que non cochées sur le Mac**, le nombre d'éléments **reçus du Mac** (entités faites ou changées, supprimées, réglages écrits) ou « rien de nouveau », et le nombre d'éléments du Mac **non pris** (refusés à l'entrée ou par l'écriture de l'état). Les lignes sont calculées dans LuciumKit (`SyncLastExchange`), les phrases sont les clés `sync.last.*`.

Chaque code du §7.6 a **un texte et une action** (par exemple `pairing-expired` : « Ce code a expiré. Affichez-en un nouveau sur le Mac. » ; `fingerprint-mismatch` : « Ce n'est pas le Mac du code. » ; `state-too-new` : « L'autre Lucium est plus récent : mettez celui-ci à jour. » ; `divergence` : « Les deux appareils ne s'accordent pas : rien n'a été changé. » ). Un texte **ne montre jamais** un secret, un nom d'hôte brut ni une empreinte entière.

### 13.4 « Conflit réglé »

Le résumé de la maquette : « Deux changements se croisaient. » puis la liste (« Le Mac, le plus récent, est appliqué », « Gardé dans « Réunions », sur les deux appareils »), **jamais une question qui bloque**, avec **« Comparer »** (les deux valeurs, depuis le journal du §11.7, avec la possibilité de **rétablir** celle qui a perdu : c'est un changement ordinaire, qui repart à la séance suivante). Les mots viennent de la maquette ; la carte 446 écrit l'écran.

**Ce que l'écran dit** (feuille sur le Mac, `SyncConflictSheet` ; écran de l'iPhone, `SyncConflictScreen`, qui dit les mêmes choses avec les mêmes clés, ses textes étant ceux du Mac à la lettre, `src/shared/ios-sync-conflict-contract.test.ts` ; d'après la maquette « Conflit ») : le titre « Deux changements se croisaient » et « Faits sur les deux appareils depuis leur dernière synchronisation. » ; pour chaque conflit, une carte : ce que c'est (« Espace », « Dossier », « Onglet épinglé »… et le nom que la personne lui a donné), **une rangée par appareil** (le Mac, l'iPhone : ce qu'il a fait, « Nom changé en « Boulot » », « Rangé dans « Réunions » », « Supprimé », et à quelle heure, du plus ancien au plus récent), puis **ce qui est en vigueur** (« La version de l'iPhone, la plus récente, est appliquée. », « Changements simultanés : la version du Mac est appliquée. », « Gardé sur les deux appareils. », « L'ordre du Mac, le plus récent, est gardé. ») ; **« Comparer »** montre les deux versions (« Version gardée », « Version écartée ») avec **« Rétablir cette version »**, un changement ordinaire qui repart à la séance suivante (l'écran le dit) ; une suppression qui a perdu n'a pas deux versions à montrer : elle propose **« Le supprimer partout »** (la maquette dit « Le fermer partout » pour un onglet). **« D'accord »** ferme l'écran (un seul bouton pour tout l'écran, là où la maquette en dessine un par carte) : jamais une question qui bloque, jamais un choix à faire pour que la séance se termine. **Qui nomme quel appareil** : le gagnant est lu du point de vue de l'appareil qui montre l'écran (§11.7.3), le Mac y dit « Mac » et l'iPhone « iPhone », jamais « cet appareil ». L'écran ne change rien lui-même : il prend les lignes du journal et rend « Rétablir » à la page qui le monte (un changement d'état ordinaire, puis la ligne s'efface du journal).

### 13.5 Accessibilité

Les écrans suivent ce que dit `docs/ios.md` pour le reste de l'application : Dynamic Type, 44 pt, étiquettes lues, et **le QR a un équivalent texte** (§4.3) : il ne faut pas une caméra ni une vue pour s'appairer.

## 14. Connexions : la ligne du README

Ce qui suit est à ajouter par les cartes 444 et 445, avec la fonction (`docs/ios.md` §13.5, `AGENTS.md` §5). **La ligne du Mac est dans les deux README** (carte 444, page « Synchronisation » de Réglages › Téléchargements et fichiers) ; celle de l'iPhone reste à ajouter par la carte 445. Les deux README (anglais et français) changent ensemble. **Carte 505 (19 novembre 2026)** : les deux lignes ci-dessous et celles des README sont réécrites pour l'écoute permanente ; la ligne de l'iPhone dit qu'il se connecte seul à l'intervalle réglé tant que l'application est ouverte à l'écran.

**Tableau du Mac** (anglais) :

> | **Synchronization with your own iPhone**, once you have paired it: your spaces, folders, favorites and pinned tabs (and, only if you tick them, a short list of settings, archived tabs and your Today tabs), in an encrypted exchange (TLS 1.3, each device holds the other's key) **with your iPhone only, on the local network, in both directions**. Nothing goes through a server, an account or the internet; the Mac refuses any connection from an address that is not private, and passwords, cookies, sessions, automatic sign-ins to websites, locks and history are never sent | **as long as** the switch is on, Lucium is unlocked and an iPhone is paired, the Mac waits for your paired iPhone on the local network (a port is open for that, and none otherwise) and the iPhone connects by itself at the pace you chose; a pairing opens for 2 minutes at your click | the “Synchronization” page of the Settings (**off**; the path is written by the card that creates the page) |

(français) :

> | **Synchronisation avec votre iPhone**, une fois appairé : vos espaces, dossiers, favoris et onglets épinglés (et, seulement si vous les cochez, une courte liste de réglages, les onglets archivés et vos onglets d'Aujourd'hui), dans un échange chiffré (TLS 1.3, chaque appareil garde la clé de l'autre) **avec votre iPhone seulement, sur le réseau local, dans les deux sens**. Rien ne passe par un serveur, un compte ou Internet ; le Mac refuse toute connexion venue d'une adresse qui n'est pas privée, et les mots de passe, les cookies, les sessions, les connexions automatiques aux sites, les verrous et l'historique ne sont jamais envoyés | **tant que** l'interrupteur est activé, que Lucium est déverrouillé et qu'un iPhone est appairé, le Mac attend votre iPhone appairé sur le réseau local (un port est ouvert pour cela, et aucun sinon) et l'iPhone se connecte seul au rythme que vous avez choisi ; un appairage s'ouvre 2 minutes à votre clic | la page « Synchronisation » des Réglages (**désactivée** ; le chemin est écrit par la carte qui crée la page) |

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

**Décision du chef de projet (18 novembre 2026).** Réponse à la question posée par la revue de la carte 448 (`docs/securite-synchronisation.md` §9) : **« Exemptée, chiffrement d'iOS »**. `ios/Lucium/Info.plist` porte `ITSAppUsesNonExemptEncryption = false`, parce que l'application n'utilise que le chiffrement du système : HTTPS de WebKit, TLS 1.3 de `Network.framework`, HMAC-SHA-256 et SHA-256 de CryptoKit, ECDSA P-256 de Security. Le projet n'écrit aucun algorithme (tableau ci-dessus). C'est la lecture du chef de la documentation d'Apple, qui ne dit pas en toutes lettres qu'une connexion chiffrée vers un autre appareil reste exemptée (`docs/ios.md` §13.5) : **Apple n'a pas été interrogé** ; si une build était jugée non exemptée, le mainteneur prépare la documentation demandée (au cas par cas, délai indicatif de deux jours ouvrés). La clé vaut pour la build, pas pour l'interrupteur : le code de la synchronisation est dans toute build.

**Ce que la garde impose.** `src/shared/ios-store-listing.test.ts` (1) **exige la clé à `false`** ; (2) **refuse dans les sources Swift** toute API de chiffrement (`AES`, `ChaChaPoly`, `SealedBox`, `CCCrypt`, chiffrement de `SecKey`) ou bibliothèque de chiffrement qui n'est pas celle du système (CryptoSwift, OpenSSL, libsodium…) et une clé symétrique hors du HMAC de la preuve d'appairage. Ajouter un chiffrement de sa main rend la déclaration fausse : la garde échoue, et la décision est à reprendre avec le chef.

**Restent hors de cette décision :**

1. **le Mac** n'est pas distribué par l'App Store : les règles d'Apple ne s'y appliquent pas. Les règles d'exportation du pays du mainteneur et celles des États-Unis pour un logiciel libre qui contient du chiffrement **n'ont pas été lues en entier** : **à confirmer par le mainteneur** (`docs/securite-synchronisation.md` §9.4) ;
2. **la France** : la diffusion y est aussi contrôlée par l'ANSSI ; le choix de distribution reste au chef (`docs/securite-synchronisation.md` §10).

## 16. Menaces et limites

| Menace | Réponse | Où |
|---|---|---|
| Un tiers sur le même Wi-Fi **écoute** | TLS 1.3 (TLS 1.2 jamais proposé) | §6 |
| Il **s'insère à l'appairage** | secret de 128 bits dans le QR, **1 usage, 2 minutes**, preuve qui couvre les deux empreintes, confirmation sur le Mac [Q7] | §4 |
| Il **voit le QR** (une épaule, une photo) | usage unique et 2 minutes ; **confirmation sur le Mac** [Q7] ; l'iPhone légitime reçoit « code déjà utilisé » | §4.5 |
| Il fait **scanner un faux QR** (affiche, message) à la personne | **l'iPhone demande « Appairer avec « … » ? Code : XXXXXX »** après la preuve du Mac et avant d'enregistrer ; le code est celui que le vrai Mac affiche, sinon la personne annule ; rien n'est gardé avant les deux accords (celui de la personne du Mac, puis celui de la personne de l'iPhone) | §4.6 |
| Il **rejoue** un message ou un QR | TLS, secret brûlé, nonce de connexion, numéros | §9.1 |
| Il **se fait passer** pour un appareil appairé | l'empreinte est épinglée ; l'identifiant est lié à l'empreinte | §3.2 |
| Il envoie un **message énorme ou piégé** | longueur lue avant le contenu, bornes, profondeur, `__proto__` refusé, **rien n'est exécuté** | §7 |
| Un **port ouvert en permanence** (carte 505, décidé le 19 novembre 2026, à la place de [Q5]) | **accepté**, borné : il n'existe que si la synchronisation est activée, Lucium déverrouillé et un iPhone appairé (2 minutes pour un appairage) ; filtre d'adresses locales **avant** la poignée de main, TLS 1.3 mutuel épinglé (une empreinte inconnue ou oubliée n'a le droit de rien dire), 4 connexions et 1 d'appairage, 10 échecs par minute et par adresse, séance de 10 minutes ; **ce que voit un voisin du réseau** : un port TLS qui répond à la poignée de main puis dit `not-paired` à qui n'est pas appairé, et rien d'autre ; **limite connue** : un appareil du même réseau peut occuper les 5 places de connexion pendant la poignée de main (10 s) et gêner la synchronisation, de façon répétée tant que son adresse n'est pas refusée (10 échecs par minute) ; c'est une gêne de disponibilité, sans lecture ni écriture de rien, et elle existait déjà pendant la fenêtre de 10 minutes | §6.1, §28 |
| Il **inonde** l'écoute | filtre d'adresses avant la poignée de main, 4 connexions, limites de débit, 10 échecs par minute et par adresse | §6.1 |
| Il atteint le Mac **depuis Internet** | adresse source publique refusée avant TLS ; le Mac n'est pas annoncé ; **le routeur** ne doit pas rediriger le port (rien ici ne le fait) | §6.2 |
| Un **appareil appairé est compromis** | **non couvert** (il envoie ce que l'appareil sait envoyer) ; ses effets sont bornés : pas de code, pas de réglage de réseau, entités rebornées | §8.6, §10 |
| Un appareil **perdu** | oubli depuis l'autre (§12) | §12 |
| Un **tiers déjà sur l'appareil** | **non couvert** : le trousseau et l'état sont à lui | — |
| **Divergence** entre le Swift et le TypeScript | résumé `result`, rien n'est écrit en cas d'écart | §8.5 |

**Limites assumées.** Les deux appareils doivent se voir et être ouverts, **et Lucium doit être déverrouillé sur le Mac** (§3.1, §6.1) ; **rien n'est échangé quand l'une des deux applications est fermée ou suspendue** (voulu : décision du 19 novembre 2026) ; **pas de synchronisation hors du réseau local** ; un réseau qui isole les clients (Wi-Fi d'invités, d'entreprise) l'empêche ; l'ordre est **un registre par liste** (§11.4) ; un appareil hors ligne plus de 30 jours peut faire revenir ce qui a été supprimé (§11.5).

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
| **Q5** | Quand le Mac écoute | **Remplacé : décidé par le chef de projet le 19 novembre 2026 : synchronisation automatique** : le Mac écoute tant que la synchronisation est activée, Lucium déverrouillé et un iPhone appairé (2 minutes pour un appairage). *Historique : le 18 novembre, « le mieux le plus secure » avait retenu une fenêtre de 10 minutes ouverte à la main (lecture littérale de `docs/ios.md` §13.2 ; coût : un geste sur le Mac à chaque fois), ce qui a obligé le chef à ouvrir la fenêtre sur le Mac puis à toucher « Synchroniser maintenant » sur l'iPhone lors du deuxième essai réel.* | §6.1, §28 |
| **Q6** | Certificats | **DER écrit à la main**, des deux côtés | §6.3 |
| **Q7** | Confirmation sur le Mac à l'appairage | **Oui** : Autoriser / Refuser | §4.1 |

**Espaces mis de côté [Q4]** (précision de la recommandation) : un espace verrouillé **sur un appareil** est **retiré de l'instantané qu'il envoie** et ses changements reçus **ne sont pas appliqués** tant qu'il l'est. Pour que l'autre appareil ne le prenne pas pour supprimé, le `hello` ne porte pas la liste, mais **chaque partie d'instantané** porte `withheld` : les **identifiants** des espaces mis de côté (champ facultatif de `snapshot.part`, ignoré d'un appareil qui ne le connaît pas), et la fusion **retire des trois entrées** (base, local, distant) un espace nommé là et ce qui en dépend (§11.1) : ni ajout, ni modification, ni suppression, et le résultat, donc le résumé comparé, n'en contient rien. Ce que la personne change dans un espace de côté ne repart qu'à une séance où il ne l'est plus : sans base pour cet espace, ses entités sont alors des ajouts des deux côtés (§11.8), et les pierres tombales tranchent les suppressions. Si la recommandation n'est pas suivie, ce paragraphe disparaît et rien d'autre ne change.

## 19. Vecteurs de contrat

Trois fichiers dans `ios/Contracts/`, **au format des vecteurs existants** (JSON, un `comment` en tête qui dit qui les lit) :

| Fichier | Contient |
|---|---|
| `sync-pairing-vectors.json` | `proof` (les preuves d'appairage recalculables, avec `mutations`), `qr` (valides et refusés), `manualCode`, `comparisonCode` (le code à comparer, §4.6), `secretLifecycle` (valide, expiré, rejoué, preuve fausse, verrouillé, refusé), `clientChecks` (empreinte fausse), `addressPolicy`, `certificate` (octets à signer et certificat d'exemple) |
| `sync-message-vectors.json` | `limits`, `frames` (longueurs), `messages` (valide, trop gros, version inconnue, champ inconnu, `__proto__`, hors phase), `sequences` (numéros), `stamps`, `canonical` (formes canoniques et SHA-256), `fieldClasses`, `settingsAllowed`, `settingsNever`, `duplicateKeys` (une clé écrite deux fois), `searchEngines` (les moteurs de recherche que le Mac propose, seuls modèles qui traversent), `inboundTombstones` (les pierres tombales écartées), `inbound` (entités écartées ; `entityRaw` écrit l'entité en texte quand un fichier JSON ne peut pas porter la valeur : un substitut isolé) |
| `sync-merge-vectors.json` | des **cas de fusion** : base, local, distant, résultat attendu, conflits attendus, `swap` (le résultat doit être le même en échangeant local et distant) |
| `sync-today-vectors.json` | (carte 507, §27.16) les **onglets d'« Aujourd'hui » partagés** : les limites, les classes de champs de `todayTab`, l'adresse partageable, `activeAt`, l'**admission** (conditions, collante, plafond), la **porte d'entrée** (`invalid-url`, `invalid-value`, `too-many-today-tabs`), les **déplacements** épinglé ↔ Aujourd'hui et des **cas de fusion** (§27.9, §27.10, espace verrouillé). Joués par `src/shared/ios-sync-today-contract.test.ts` (contre `src/shared/sync-today.ts` et `sync-merge.ts`) et par LuciumKit (`SyncTodayVectorTests.swift`, contre `SyncToday.swift` et `SyncMerge.swift`) |
| `sync-state-vectors.json` | (carte 452) l'**état d'un appareil tel que la synchronisation le lit** : pour un état au format du Mac, les catégories communes, les espaces mis de côté et la base, les entités et les listes de l'instantané qu'une séance gèle (produits par `trackedViewOf` et `snapshotOf` du Mac) ; et le **patch** que donnent deux instantanés (produit par `buildPatch`). Joués par `src/main/sync/state-view-vectors.test.ts` et par LuciumKit (`SyncStateTests.swift`) |
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
| **447 : reprise** | **(remplacée par le §27 si [Q8] = A)** l'écran « Reprise » et la source « Sur le Mac » de la barre de commandes, sur l'annonce du §10.4 : **fait côté iPhone** (§24) ; le sens inverse, « Sur l'iPhone » dans la barre de commandes du Mac : carte 490 (§25) |
| **448 : revue** | relire ce document **et** le code contre §16 ; refaire les essais du §17 dans Electron 45.2.1 et sur appareil ; la **conformité du chiffrement** (§15) ; rapport **sans point bloquant** |

## 21. Écarts avec `docs/ios.md` §13

| `docs/ios.md` | Ici | Pourquoi |
|---|---|---|
| §13.2 : « l'empreinte de sa clé publique » | l'empreinte **du certificat** (SHA-256 du DER) | même hachage des deux côtés, aucun en-tête ASN.1 à fabriquer (§3.2) |
| §13.2 point 2 : Bonjour, `NWBrowser`, `NSBonjourServices` | **aucun en v1** [Q1] | §5 |
| §13.2 point 3 : `checkServerIdentity` | vérification de l'empreinte à `secureConnection` / `secureConnect` | `checkServerIdentity` compare un nom d'hôte ; `rejectUnauthorized: false` avec un certificat auto-signé (§6.1) |
| §13.2 point 6 : « fenêtre de synchronisation ouverte » | ~~repris à la lettre : une fenêtre que la personne ouvre, 10 minutes au plus [Q5]~~ **remplacé le 19 novembre 2026** : écoute permanente sous conditions (§6.1, §28) | la fenêtre coûtait un geste sur le Mac à chaque fois ; le port ouvert en permanence est borné au §16 |
| §13.3 étape 2c : Retouches reçues désactivées | **pas envoyées du tout** en v1 | du code : une revue à part (§10.5) |
| §13.3 étape 2b : onglets d'« Aujourd'hui » | d'abord (18 nov.) une **annonce** en lecture seule, pas une fusion ; **depuis le 19 novembre 2026 : des entités partagées** (genre `todayTab`, catégorie `todayTabs`), l'adresse copiée une seule fois et une page jamais rechargée | décision du chef (« Vrais onglets partagés ») ; l'ouverture de 80 onglets reste bornée par le plafond de 200 et la copie unique (§27) |
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
| **Code à comparer, adresse source** (§4.1, §4.6) | `runPairing` calcule `comparisonCode` des deux empreintes vues dans la poignée de main (`pairing-compare.ts`) et le donne, avec l'adresse source, à la feuille ; après « Autoriser » il envoie `pair.accept` **sans** enregistrer l'iPhone, attend le mot de la personne de l'iPhone (`bye` ou `error`, 60 s : `Channel.allowSilence` allonge le silence toléré pour cette attente) et n'enregistre qu'au `bye`, puis répond `bye` (ou `error` `internal` si la liste est pleine). Le service garde la feuille pendant l'attente (`confirm.waiting`) et la personne peut y renoncer (« Annuler », fermer la feuille ou la fenêtre : `pairing-refused`) | un faux QR scanné faisait épingler le Mac d'un autre par l'iPhone sans qu'il le demande ; le Mac n'écrivait plus l'iPhone **avant** son `pair.accept` pour qu'il ne revienne pas à un Mac qui l'a oublié : il l'écrit maintenant avant son dernier `bye`, que l'iPhone lit avant de revenir (revue de la carte 448, n° 9 et 21 ; décision du chef du 18 nov. : « Code à comparer ») |
| **Place d'appairage** (§6.1) | une seule ; une connexion qui n'a pas envoyé `pair.request` dans les 3 s qui suivent sa prise de la place la perd au profit du prochain inconnu (coupée, comptée) | un voisin qui ouvre une connexion TLS et se tait gardait la place 60 s (le silence permis), en boucle, tout le temps de la fenêtre : il empêchait l'appairage sans connaître le secret (essayé par la carte 448) |
| **Application d'un patch** (§8.5) | `sync/apply` travaille sur une copie de chaque liste touchée, avec un index des identifiants, et ne parcourt chaque liste qu'une fois pour les suppressions et une fois pour les ordres | la version qui cherchait dans la liste pour chaque entité tenait le processus principal 3,4 s pour 40 000 créations ; un appareil hostile calcule la même fusion et le résumé concorde : il pouvait relancer ce gel à chaque séance (carte 448). Un test joue 400 patchs tirés au hasard contre l'ancienne version, gardée comme référence |
| **Une séance à la fois** | une deuxième connexion d'un appareil appairé reçoit `busy` | les marques et la base sont écrites par une seule séance |
| **Durée de séance de l'iPhone** (§7.5) | `SyncSessionClient.run` borne toute la séance à `sessionMaximum` (10 minutes ; `within` ferme la connexion, ce qui termine la lecture en cours) et échoue en `timeout` | revue de la carte 448, n° 19 : un Mac qui envoie un octet par minute gardait chaque silence court, la séance ne finissait jamais et « Synchroniser maintenant » restait « en cours » |
| **Clé que le trousseau n'ouvre pas** (§3.3) | `IdentityStore.loadOrCreate` ne remplace une clé qui ne s'ouvre pas que si on le lui dit (`replaceUnopenable`) ; il lève `IdentityNotOpenableError` sinon, et le service ne le dit qu'au deuxième essai (`identityRefusals`) ; une identité qui n'en est pas une est remplacée tout de suite ; problème `identity-unopenable` (texte des deux langues) | revue de la carte 448, n° 22 : un trousseau qui refuse un instant faisait écraser l'identité et oublier tous les appareils appairés |
| **Marques des catégories non échangées** (§9.2) | `MarkBook.adopt` reçoit les genres que la séance a échangés (`kindIsExchanged` : ceux des catégories communes, plus les genres inconnus) et ne remplace que leurs marques, pierres tombales et ordres ; le reste du livre est gardé | revue de la carte 448, n° 17 : après une séance sans « réglages » ni « archive », les marques de ces catégories repartaient de l'heure du moment et leurs suppressions pouvaient revenir. **Le Swift fait de même** (`SyncMarkBook.adopt(_:exchanged:)`, `SyncStateView.isExchanged`). **Les espaces mis de côté** (verrouillés ici ou chez l'autre) gardent aussi leurs marques : ils ne sont pas dans l'instantané fusionné, et sans cela leurs marques repartaient de l'heure du moment, si bien qu'au déverrouillage ce que l'autre appareil avait changé entre-temps était écrasé (`Aside` / `SyncAside`, seconde passe de la revue) |
| **Application d'un patch en temps linéaire, côté iPhone** (§8.5) | `SyncApply.apply` cherche une entité par un index (les octets de son identifiant), retire en une fois, groupe les listes à ordonner en un seul parcours et retient les chaînes de dossiers qui finissent (comme `applySyncPatch` du Mac, #99) | revue de la carte 448, seconde passe : 10 000 créations en 13 s, une chaîne de 1 500 dossiers en 35 s, 12 000 listes en 34 s dans un build de test, sur le fil principal, par un Mac appairé hostile qui calcule la même fusion. `SyncApplyLinearTests` compare l'état à celui de l'ancienne version (copiée, `SyncApplyReference`) sur 400 patchs tirés au hasard |
| **Taille de l'état écrit par une séance, côté iPhone** (§8.5) | `SyncApply.apply(…, maxStateBytes:)` mesure l'état qu'un patch donnerait tel que le fichier d'état l'écrit ; au-delà de 32 Mio (la moitié de ce que `StateFile` relit, 64 Mio), **rien n'est écrit**, la fusion n'est **pas adoptée** (la base et les marques restent) et la séance finit en `too-large` | revue de la carte 448, seconde passe : l'iPhone garde les champs qu'il ne connaît pas (§11.6) et n'a pas les plafonds du Mac ; un Mac appairé hostile qui envoie 28 Mio de champs inconnus à chaque séance (la borne d'une séance est de 32 Mio) faisait dépasser la borne de relecture au bout de trois : l'état était alors mis de côté (`.corrupt-…`, trois copies) et l'application repartait de zéro |
| **Horloge des marques** (§9.3) | `Hlc.next` repart de l'heure du jour quand la dernière marque est à plus de 7 jours devant elle (ou à la fin de treize chiffres) ; `MarkBook.update` refait les marques de champs, de pierres tombales et de listes qui sont à plus de 7 jours devant | revue de la carte 448, n° 18. **Le Swift fait de même** (`SyncMarkBook.next` et `update`) |
| **Pierres tombales** (§11.5) | `cleanSnapshot` refuse celles d'un genre de code ou de secret et ne garde que les 50 000 plus récentes, de ce qui vient de l'autre appareil comme de ce que cet appareil lui envoie | revue de la carte 448, n° 14 : 198 000 pierres cumulées après deux séances, puis `too many tombstones` des deux côtés ; les tombes de genres interdits étaient acceptées puis renvoyées |
| **Texte coupé, clés, substituts** (§7.1, §10.2) | `printable` et `openTabsOf` coupent un texte sans séparer une paire de substituts (`cutText`) ; `parseMessage` refuse une clé écrite deux fois (`hasDuplicateKey`) et un texte ou une clé à substitut isolé ; `filterEntity` refuse un profil qui n'est pas un identifiant du Mac et un texte à substitut isolé | revue de la carte 448, n° 15, 16 et 20. **Le Swift fait de même** : `SyncMessageCodec.decode` appelle `SyncDuplicateKeys.has` (vecteurs `duplicateKeys`), `SyncInbound` refuse les profils qui ne sont pas des identifiants du Mac, filtre les pierres tombales de genres interdits et n'en garde que 50 000 (`inboundTombstones`) ; un texte à substitut isolé est refusé à la lecture du message (`bad-message`), le Mac le refuse au même endroit, et le Mac coupe en octets le titre des onglets ouverts (`cutBytes`) et laisse de côté une adresse de plus de 4096 octets au lieu de la couper (seconde passe de la revue : une adresse coupée est une autre page) et refuse un texte de plus de 64 Kio en octets dans une entité |
| **Onglets ouverts d'un espace supprimé à distance** (§8.5) | `sync/apply` met les onglets d'« Aujourd'hui » (ni épinglés, ni privés, ni une page interne) de chaque espace qu'il retire dans l'archive, source `sync`, avant le nettoyage de l'état ; ils vont dans l'espace actif, à défaut le premier qui reste (ou l'espace que `normalize` crée quand il n'en reste aucun) ; la page « Archive » a une pastille « Synchronisation » pour eux | un espace supprimé sur l'iPhone supprimait sur le Mac ses onglets ouverts, sans archive et sans confirmation, comme une suppression locale mais sans que la personne l'ait demandée ; un appareil hostile pouvait le faire pour tout ce qu'il connaît (revue de la carte 448, n° 13 ; décision du chef du 18 nov. : « Archiver avant »). **Le Swift fait de même** (`SyncApply.keepOpenTabsOfRemovedSpaces`, mêmes règles ; `ArchivedTab.Source.sync`) |
| **Moteur de recherche** (§10.3) | `filterEntity` n'accepte `searchUrlTemplate` que s'il est **l'un des modèles de `SEARCH_ENGINES`** ; la séance n'écrit pas le moteur reçu quand celui que l'état tient **maintenant** n'est pas l'un d'eux (un moteur personnalisé reste, et rien ne le remplace) ; son propre moteur personnalisé est refusé à l'envoi comme à la réception (la version de la base tient sa place, sinon il n'est pas envoyé) | un moteur personnalisé qui traversait, ou un modèle en `http` à l'hôte libre, envoyait les recherches de l'autre appareil chez un tiers (revue de la carte 448, n° 10). **Le Swift fait de même** : `SyncInbound` n'accepte que les modèles de `SearchEngine.presets` (la liste des vecteurs `searchEngines`, comparée par test), et `SyncApply` n'écrit pas le moteur reçu par-dessus un moteur qui n'en est pas |
| **Entité refusée qui est dans la base** (§8.5) | `cleanSnapshot` reçoit la base de la séance : une entité refusée pour ses marques (`future-mark`), son adresse (`invalid-url`) ou sa valeur (`invalid-value`) est **remplacée par sa version de la base** (inchangée), de ce qui vient de l'autre appareil comme de ce que cet appareil envoie ; une refusée pour ce qu'elle est (`not-pinned`, `private`, genre interdit) est écartée, et l'autre appareil la supprime (elle est sortie de ce qui se synchronise). Sans base, elle est écartée | la fusion lit « dans la base, absente d'un côté, intacte de l'autre » comme une suppression : un iPhone dont l'horloge avance de plus d'une semaine, qui renomme un espace, faisait **supprimer cet espace et ses onglets épinglés du Mac** (essayé par la carte 448) ; **le Swift fait de même** (`SyncInbound.clean` avec la base, carte 452 ; vecteurs `clean` de `sync-state-vectors.json`), sans quoi les deux résumés pourraient différer |
| **Marques du futur** (§9.3) | `cleanSnapshot` écarte, en plus des entités, les pierres tombales et les listes (avec leur marque d'ordre) dont la marque dépasse l'heure locale de plus de 7 jours ; la porte s'applique aussi à l'instantané que cet appareil envoie, avec l'heure de l'autre (`hello.now`) | les deux fusions doivent partir des mêmes entrées ; une marque de l'an 2286 tirait l'horloge des marques du Mac (`MarkBook.adopt` la retient) |
| **Avertissement d'horloge** (§9.3) | un `error` non fatal (`clock-skew`) est noté et la séance continue ; un `error` fatal l'arrête avec son code | |
| **Fichiers** (§3.3) | `sync.json`, `sync-identity.json`, `sync-marks.json`, `sync-base-<id>.json` (un par appareil, 30 jours), à côté de `state.json` | aucun export, aucune sauvegarde ni copie de session ne les emporte |
| **Onglets ouverts** (§10.4 **d'origine, remplacé par le §27** si [Q8] = A) | annoncés (au plus 200, adresses web, jamais privés ni d'un espace verrouillé) seulement si la catégorie est commune ; gardés **en mémoire** par le service (`openTabsFrom`, `resumeSource`), oubliés au verrouillage, à la fermeture de Lucium, à la décoche de la catégorie, à l'arrêt de la synchronisation et avec l'appareil (pas avec la fenêtre : §26) | la carte 447 les montre sur l'iPhone, la carte 490 dans la barre de commandes du Mac (§25) |

**Ce que les tests ne montrent pas** : un échange avec le vrai code de l'iPhone (carte 445), un réseau réel, un grand état de plusieurs milliers d'entités sur un appareil, le comportement de `safeStorage` au premier usage.

## 23. Ce que la carte 452 a précisé en l'écrivant (corps de séance de l'iPhone)

Le corps de séance de l'iPhone (§8.2 à §8.5) est `SyncExchangeBody` (LuciumKit, `Sync/SyncExchange.swift`), derrière l'interface `SyncSessionBody` de la carte 445. Il suit pas à pas `session.ts` du Mac : mêmes étapes, même fusion (`SyncMerge`), mêmes empreintes. Ce qui est écrit et prouvé dans LuciumKit : la vue de l'état (`SyncStateView`, jouée contre `ios/Contracts/sync-state-vectors.json`, dont le Mac produit les valeurs attendues par son propre `trackedViewOf` et `snapshotOf`), le livre des marques (`SyncMarkBook`, `SyncMarkKeeper`), le filtre des entités reçues (`SyncInbound`, enfin joué en Swift contre les vecteurs `inbound`, `fieldClasses`, `settingsAllowed`, `neverKinds`), les parties de l'instantané (`SyncSnapshotParts`), le patch (`SyncPatch`, joué contre `buildPatch` du Mac) et son écriture dans l'état (`SyncApply`, jumeau de `sync/apply`), la base du Mac (`SyncBaseStore`). Les points où le code a dû choisir (et ce que la revue de sécurité de la carte 448, `docs/securite-synchronisation.md` §7, demande au corps de séance de l'iPhone : marques du futur, base à la place d'une entité refusée, bornes de valeurs, durée de séance, substitut isolé : tout est ci-dessous) :

| Sujet | Ce que fait l'iPhone | Pourquoi |
|---|---|---|
| **Qui filtre quoi** (§8.5) | comme le Mac : la porte des entités reçues s'applique **aussi à son propre instantané avant l'envoi**, avec l'horloge du Mac pour les marques du futur ; une entité que le Mac ne lirait pas (nom de champ hors forme NFC, borne dépassée) est écartée, comptée, journalisée, jamais fatale | les deux fusions partent des mêmes entrées ; sans cela une seule valeur étrange de l'état ferait finir chaque séance par `bad-message` |
| **iPhone jamais modifié** (§11.8) | seule la **structure** est vidée (réponse du chef de projet) ; `baseHash: null` dans le `hello` | voir §11.8 |
| **Marques du futur** (§9.3) | `SyncInbound.clean` écarte, comme `cleanSnapshot` du Mac, les entités, **les pierres tombales et les listes avec leur marque d'ordre** dont une marque dépasse de plus de 7 jours l'heure de l'appareil qui juge, à ce qui vient comme à ce qui part (avec l'heure du Mac pour ce que l'iPhone envoie) | les deux fusions partent des mêmes entrées |
| **Noms d'un objet JavaScript** (§7.1) | le Mac refuse un genre, un identifiant, un nom de liste ou un identifiant de liste qui est un membre de `Object.prototype` (`constructor`, `toString`, `__proto__`, `prototype`…) ; Swift n'en a pas besoin à la lecture (un dictionnaire n'a pas de prototype), mais l'iPhone **n'envoie pas** une entité, une pierre tombale, une liste ou un espace mis de côté qui porte un tel nom (elle reste chez lui, comptée) | sinon une seule entité de ce genre ferait finir chaque séance par `bad-message` |
| **Entité qui ne peut pas voyager** (§8.5) | comme la porte du Mac (`cleanSnapshot` avec la base, PR #97 du Mac) : une entité refusée pour ses marques, son adresse ou sa valeur et qui est dans la **base** est remplacée par sa version de la base (inchangée), à ce qui vient comme à ce qui part ; une refusée pour ce qu'elle est (`not-pinned`, `private`, genre interdit) est écartée, l'autre appareil la supprime ; sans base, elle est écartée | sinon la fusion lit « dans la base, absente d'un côté » comme une suppression : une horloge d'une semaine d'avance faisait supprimer un espace et ses onglets épinglés de l'autre appareil |
| **Durée d'une séance** (§7.5) | dix minutes au plus (`SyncLimits.sessionMaximum`, que l'iPhone ne lisait nulle part) : au-delà, le canal est fermé et la séance finit par `timeout` | un pair qui envoie un octet par minute gardait « Synchroniser maintenant » occupé pour toujours |
| **Valeurs JSON** (§7.5) | 150 000 par trame et 2 000 000 par connexion (`SyncLimits.maxFrameValues`, `maxSessionValues`), chaque objet, liste, texte, nombre, booléen et `null` comptant pour un (les clés non) : `too-large` au-delà | les bornes en octets ne bornent pas le travail ; mêmes chiffres que le Mac (PR #100) |
| **Texte à substitut isolé** (§7.1) | un texte qui porte un `\uD800` à `\uDFFF` dont l'autre moitié manque est **refusé** (`bad-message`), explicitement (`SyncMessageCodec.hasLoneSurrogate`) : une chaîne Swift n'en contient pas, et un décodeur qui mettrait le caractère de remplacement à sa place ferait différer l'empreinte de l'iPhone de celle du Mac, qui écrit le substitut tel quel (revue de sécurité, n° 15 : le Mac en produit en coupant un titre au milieu d'un émoji ; **à corriger côté Mac**, tant qu'il en produit la séance échoue) | une séance qui diverge sans le dire est pire qu'une séance refusée |
| **Favori sans profil** | l'instantané le donne au profil `default`, comme la réparation de l'état du Mac | les deux appareils disent la même chose, et la liste `favorites:default` est celle que la fusion lit |
| **Graines** (§10.2) | comme le Mac (§22) : envoyées seulement avec une entité que la base ne contient pas ; la base gardée n'en contient pas | un onglet épinglé change de page à chaque navigation |
| **Écriture** (§8.5) | `SyncApply` : un champ n'est écrit que si l'état tient encore ce qu'il tenait au gel ; une entité n'est retirée que si elle est encore telle qu'au gel ; chaque valeur reçue est rebornée comme à la lecture d'un fichier (nom, émoji, adresse web, profil, type) et ce que l'état ne type pas (`rest`) est gardé tel quel ; une entité sans nom ou sans adresse n'est pas créée ; ce qui pointe vers un espace ou un dossier disparu est coupé ; **un état n'est jamais laissé sans espace** | ce que la personne change pendant la séance est gardé et repart à la séance suivante |
| **Réglages** | une clé hors de la liste fermée (§10.3) ou une valeur que cette version n'écrirait pas n'est pas écrite ; un état **sans** réglages reçoit d'abord les cinq d'un nouveau profil | sans eux, des réglages partiels se liraient comme ceux d'un ancien profil (HTTPS d'abord, rien d'autre) et la protection baisserait sans un mot |
| **Onglets ouverts** (§10.4 **d'origine, remplacé par le §27** si [Q8] = A) | reçus et gardés en mémoire (`SyncExchangeSummary.openTabs`), jamais écrits ; envoyés quand la catégorie est commune : pages web ouvertes (épinglées ou non), jamais un onglet privé ni d'un espace verrouillé, 200 au plus, une adresse de plus de 4096 octets laissée de côté (coupée, ce serait une autre page), un titre coupé à 300 octets ; à la réception, seules les pages web sont gardées, avec un identifiant et un identifiant d'espace de 128 caractères au plus, comme le Mac (#96) | la page « Synchronisation » promet que « ce que vous lisez est envoyé » |
| **Marques** (§9.2) | relevées à l'écriture de l'état (`SyncMarkKeeper.observe`) tant que la synchronisation est activée, et au gel de chaque séance ; adoptées à la fin d'une séance réussie (ce que la fusion a écrit n'est pas renvoyé comme un changement de l'iPhone) | sur l'iPhone l'écriture de l'état attend 500 ms (§9.2) |
| **Adresses** (§8.5) | « adresse web » = `http(s)://` suivi d'un hôte que `URL(string:)` lit ; le Mac demande `URL.canParse`. Les deux lisent pareil toute adresse qu'une personne ouvre ; une adresse exotique que l'un seul lit est refusée de ce côté seul, ce que les empreintes de la séance transforment en `divergence` (rien n'est écrit), jamais en état faux | deux analyseurs d'adresse ne sont pas le même code |

**Ce que les tests ne montrent pas** : l'échange avec le vrai code du Mac (l'essai d'interopérabilité de la carte 452 le fait, hors dépôt), un grand état de plusieurs milliers d'entités sur un appareil, le comportement en arrière-plan au milieu d'une séance. **Branché dans l'application** (deuxième PR de la carte 452) : le modèle écrit le patch (`BrowserModel+Sync.swift` : web views, images et états de page de ce qui part, verrou, onglet affiché, écriture du fichier tout de suite) et prend les marques à chaque écriture de l'état tant que la synchronisation est activée ; `SyncController` choisit le corps (`SyncExchangeBody` quand le modèle donne son hôte `SyncModelHost`), dit le hash de la base dans le `hello`, tient le journal des conflits (`sync-conflicts.json`) et les onglets ouverts du Mac en mémoire, et oublie la base, les marques et le journal avec le Mac (§12) ; la page dit « À jour » après un échange et propose « Dernier conflit réglé » (`SyncConflictScreen`, « Rétablir » est un changement ordinaire de l'état) ; la phrase de la page de démarrage dit « Rien ne quitte cet appareil, sauf vers votre Mac, sur votre réseau. » quand la synchronisation est activée **et** qu'un Mac est appairé (activée sans Mac, rien ne peut partir : la phrase simple reste) ; les lignes du tableau des connexions des README disent ce qui est échangé.

**Essai d'interopérabilité** (carte 452, hors dépôt, rien de committé, aucune fenêtre ouverte sur le Mac) : le vrai `SyncService`, `SyncListener` et la séance du Mac sous Node (Node 26) sur l'interface réseau réelle, et le vrai code Swift de l'iPhone (`SyncController`, `NetworkSyncConnector`, `SyncExchangeBody`, le modèle) sur un simulateur ; appairage par QR avec « Autoriser » sur le Mac, puis quatre séances (union de deux états ; changements dans les deux sens ; le même champ changé des deux côtés ; une suppression de chaque côté) et le premier échange d'un iPhone jamais modifié. Après chaque séance les deux bases (SHA-256 de l'instantané fusionné) et les deux structures sont identiques. **Ce que l'essai ne prouve pas** : un vrai iPhone, un vrai réseau, le nom `.local`, la caméra, l'autorisation du réseau local, `safeStorage`, le Node d'Electron.

## 24. Ce que la carte 447 a précisé en l'écrivant (reprendre un onglet du Mac, côté iPhone)

Écrit pour la carte 447. La logique est dans `LuciumKit` (`Sync/SyncResume.swift`, `swift test`) ; l'application ajoute `BrowserModel+Resume.swift`, `ResumeScreen.swift`, la source de `CommandBar.swift` et les lignes de `SyncController`. **Rien n'est écrit** : la liste est celle de §10.4, en mémoire. **Remplacé par le §27 si [Q8] = A** (ce que cette carte a fait est retiré ; le texte est gardé comme historique).

| Sujet | Ce qui est fait | Pourquoi |
|---|---|---|
| **Les lignes** (`SyncResume.rows`) | `http` et `https` seulement, **revérifiés à l'affichage** (une adresse sans hôte, ou de plus de 4096 octets, n'est pas une ligne), la plus récemment lue d'abord, **une ligne par adresse**, 200 au plus ; un titre vide devient l'hôte | l'annonce est une entrée hostile : la barrière de réception ne doit pas être la seule |
| **Où s'ouvre un toucher** (`SyncResume.targetSpace`) | un **nouvel onglet** (jamais le remplacement d'un onglet), dans l'espace que le Mac avait, **s'il existe sur l'iPhone et n'est pas verrouillé** ; sinon dans l'espace à l'écran ; si celui-ci est verrouillé aussi, **nulle part** | rien n'entre dans un espace verrouillé ; le chemin est celui d'un onglet ordinaire (`state.openTab`), qui repart à la séance suivante comme tout changement |
| **Ce que la liste nomme** | l'espace d'une ligne n'est nommé que s'il existe ici et n'est pas verrouillé | un espace verrouillé ne dit rien de lui |
| **Pourquoi il n'y a rien** (`SyncResume.availability`) | six cas, chacun avec sa phrase : pas de Mac appairé ; **catégorie non cochée sur l'iPhone** (la phrase dit où la cocher, et de la cocher aussi sur le Mac) ; cochée mais aucune séance depuis (la liste arrive à la prochaine) ; **séance faite et le Mac n'a rien envoyé** (il n'a pas coché la catégorie : la phrase le dit) ; liste vide ; liste | le défaut est « non coché » [Q2] : l'écran doit dire comment l'activer, pas rester muet |
| **Quand elle date** | « Liste annoncée par le Mac il y a 5 minutes », de l'heure de fin de la séance qui l'a apportée (`SyncController.macOpenTabsAt`) | une liste de ce que le Mac lisait ne doit pas passer pour son état présent |
| **Oubli** | la liste est **oubliée** au verrouillage de l'application, quand la catégorie est décochée, quand la synchronisation est coupée, et avec le Mac ; le résumé de séance gardé pour la page ne la contient pas (`lastExchange.openTabs` est vidé : une seule copie) | §10.4, §12 |
| **Barre de commandes** | la source « Sur le Mac » (`CommandBarSection.mac`, sous les onglets) : une puce, dessinée quand un Mac est appairé, qui montre toute la liste ; sans filtre, au plus **cinq** lignes quand ce qui est tapé nomme le titre ou l'hôte (rien quand rien n'est tapé) | les onglets du Mac ne doivent pas noyer ceux de l'iPhone |
| **L'écran** | la ligne « Reprendre un onglet du Mac » de la page « Synchronisation » (dès qu'un Mac est appairé) ouvre `ResumeScreen` | l'écran « Reprise » de la maquette ; pas de nouvelle feuille sur `BrowserScreen` (celles-ci se ferment au verrou, `ios-contract.test.ts`) |

**Le sens inverse** (le Mac qui reprend un onglet de l'iPhone) est fait par la carte 490 : voir §25. **Ce que les tests ne montrent pas** : un vrai iPhone, une vraie séance avec un Mac qui annonce ses onglets (l'essai d'interopérabilité de la carte 452 n'avait pas coché la catégorie).

## 25. Ce que la carte 490 a précisé en l'écrivant (« Sur l'iPhone », barre de commandes du Mac)

Décision du chef de projet du 18 novembre 2026. La logique pure est `src/shared/sync-resume.ts`, **jumelle de `SyncResume.swift`** : les deux jouent les mêmes vecteurs (`ios/Contracts/sync-resume-vectors.json` : lignes, raison, espace cible, âge ; `sync-resume.test.ts` et `SyncResumeVectorTests.swift`). Le service garde la liste (`SyncService.resumeSource`), la barre la demande par un canal à elle (`lucium:sync-resume`, `src/main/shell/sync-ipc.ts`). **Rien n'est écrit dans l'état** et aucune connexion nouvelle n'existe : la liste est celle que l'iPhone a déjà annoncée. **Remplacé par le §27 si [Q8] = A** (historique).

| Sujet | Ce qui est fait | Pourquoi |
|---|---|---|
| **Quand la section existe** | seulement si un iPhone est appairé, la synchronisation est allumée, la catégorie « Onglets ouverts » est cochée **sur le Mac** et l'iPhone a annoncé une liste non vide (donc l'a cochée aussi) ; sinon aucune ligne d'onglet n'est dessinée ; **une phrase** dit alors comment l'obtenir (§26) | la raison (`resumeAvailability`) est calculée et testée, comme sur l'iPhone |
| **Les lignes** | titre, hôte, âge de la liste (« annoncé il y a 5 minutes ») ; sous le titre « Sur l'iPhone », **seulement quand un texte est tapé** (titre ou hôte), cinq au plus, après les signets | comme « Sur le Mac » côté iPhone |
| **Ce que reçoit la page** | **ni adresse ni espace** : seulement l'identifiant, le titre, l'hôte et l'heure de la ligne ; un clic envoie l'identifiant, et le processus principal relit l'adresse et l'espace dans ce qu'il garde (`handleSyncResume`) | la page ne peut pas faire ouvrir une autre adresse ; chaque message est validé (`parseSyncResumeRequest`) |
| **Où s'ouvre un clic** | un **nouvel onglet** (`tab/open`), dans l'espace de même identifiant s'il existe ici et n'est pas verrouillé, sinon dans l'espace à l'écran ; si celui-ci est verrouillé aussi, **nulle part**. `http` et `https` seulement, **revérifiés à l'ouverture** | §10.4 ; un verrou ne se contourne pas |
| **Oubli** | au verrouillage de l'application, à la décoche de la catégorie, à l'arrêt de la synchronisation et avec l'iPhone ; **pas** à la fermeture de la fenêtre (§26) | §10.4, §12 |
| **Plusieurs iPhone** | les listes sont réunies, la plus récente d'abord ; l'identifiant d'une ligne porte celui de l'appareil, celui de l'onglet **et une empreinte de l'adresse annoncée** | deux appareils peuvent annoncer le même identifiant d'onglet ; un appareil qui donne le même identifiant à deux lignes, ou qui met une autre adresse sous l'onglet d'une ligne montrée, ne fait pas ouvrir une autre page que celle qui est lue : le clic sur l'ancienne ligne n'ouvre rien (revue de sécurité, seconde passe) |
| **Fenêtre privée** | aucune demande, aucune ligne | la synchronisation n'est pas pour elle |

**Ce que les tests ne montrent pas** : une vraie barre de commandes ouverte (aucune fenêtre n'a été ouverte pour cette carte), un vrai iPhone.

## 26. Ce que la carte 491 a changé (liste gardée après la fenêtre, phrase « comment l'activer »)

Décision du chef de projet du 18 novembre 2026 (« La garder en mémoire »), suite du §25. **Remplacé par le §27 si [Q8] = A** (historique).

| Sujet | Ce qui est fait | Pourquoi |
|---|---|---|
| **Durée de la liste** | la dernière liste des onglets ouverts de l'iPhone reste **en mémoire du processus principal** après la fermeture de la fenêtre de synchronisation, avec son **âge** (« annoncé il y a 3 heures »), jusqu'au **verrouillage**, à la **fermeture de Lucium**, à la **décoche** de « Onglets ouverts », à l'arrêt de la synchronisation ou à l'**oubli de l'iPhone** ; une séance suivante la remplace | la fenêtre dure 10 minutes au plus : la liste n'aurait servi que pendant ce temps |
| **Ce qui ne change pas** | rien sur disque, **aucun port ouvert hors fenêtre**, aucune connexion nouvelle : la liste est celle de la dernière séance | §3.1, §6.1 |
| **La phrase** | quand la liste est absente et que le texte tapé nomme la section (« iphone »), une ligne **sans action** sous « Sur l'iPhone » dit **comment l'activer**, une phrase par raison (`resumeAvailability` : `not-paired`, `disabled-here`, `waiting`, `disabled-on-iphone`, `empty` ; clés `cmd.iphone-hint-*`, FR et EN) | rien n'est dit à qui tape autre chose, ni à qui n'a pas d'iPhone ; la raison était déjà calculée |

**Ce que les tests ne montrent pas** : une vraie barre de commandes ouverte et un vrai iPhone (aucune fenêtre ouverte).

## 27. Onglets d'« Aujourd'hui » partagés (carte 504)

**Décision du chef de projet, le 19 novembre 2026**, après le deuxième essai réel (« j'ai pas les onglets du jour qui se synchronisent » → « Vrais onglets partagés ») : les onglets d'« Aujourd'hui » deviennent de vrais onglets partagés. **Ouvrir ou fermer un onglet sur un appareil le fait sur l'autre, à la séance suivante.** Cette section **remplace** le §10.4 d'origine (une annonce en lecture seule, décidée le 18 novembre : l'historique est gardé au §10.4). Elle est écrite pour le fonctionnement **automatique** décidé le même jour (carte 505 : le Mac écoute tant que la synchronisation est activée, l'iPhone synchronise à un intervalle réglable de 30 s, 1 min, 5 min ou 15 min ; §6.1 et [Q5] sont réécrits par cette carte, pas ici) : un onglet arrive donc **au plus un intervalle après**, tant que l'application de l'iPhone est ouverte. **Les rôles ne changent pas** : l'iPhone est le client, le Mac le serveur (§3.1). **Rien de ce qui suit n'est écrit en code** : c'est la conception ; les cartes d'implémentation viennent après les réponses du chef.

**Étiquettes.** Les choix qui reviennent au chef sont **[Q8] à [Q14]** (tableau du §27.14, posés en commentaires `[question]` sur la carte 504 ; [Q14] est le choix de la navigation, voir §27.10). Chaque paragraphe qui en dépend porte son étiquette, avec **la recommandation** ; une réponse différente ne change que ce paragraphe. **Vérifié** et **à vérifier** gardent le sens de l'en-tête : ce qui est dit du code a été lu dans le dépôt le 19 novembre 2026 ; ce qui n'a pas été lu est marqué « à vérifier ».

### 27.1 En bref

| Question | Réponse |
|---|---|
| Quoi | L'**ouverture** et la **fermeture** d'un onglet d'« Aujourd'hui », son **espace**, son **ordre**, le **nom** et l'**icône** que la personne lui a donnés. **Pas la page où l'on est** : l'adresse et le titre sont copiés une fois, à l'arrivée de l'onglet [Q14] |
| Catégorie | **Une nouvelle**, `todayTabs`, « Onglets d'Aujourd'hui », **non cochée par défaut** [Q9] ; elle remplace « Onglets ouverts » [Q8] |
| Entité | un nouveau genre, **`todayTab`**, une liste d'ordre par espace, `today:<espace>`, des pierres tombales à la fermeture |
| Une fermeture reçue | **range l'onglet dans l'archive** de l'autre appareil (source `sync`) : rien n'est supprimé sans trace [Q11] |
| Jamais | un onglet **privé**, d'une **fenêtre privée**, d'un **espace verrouillé** [Q4], d'un **conteneur**, la page d'un **favori**, une page qui n'est pas en `http` ou `https`, un onglet **au-delà du plafond de 200** [Q12] |
| Chargement | **aucune page n'est rechargée** : un onglet reçu arrive **endormi**, sans connexion réseau, et ne charge qu'à son ouverture |
| Protocole | **version 1 inchangée** ; un appareil qui ne connaît pas la catégorie ne la reçoit pas (§27.13) |

### 27.2 Le modèle : l'entité « onglet d'Aujourd'hui »

Un onglet d'« Aujourd'hui » est un onglet **ni épinglé, ni privé, ni la page d'un favori** (`isListedTab`, `model.ts`). Il devient une entité du genre **`todayTab`**, de la forme du §8.3 (`fields` et une marque par champ, §9.2). Le genre est **distinct** de `tab` (les onglets épinglés, catégorie `structure`) : les deux catégories se cochent séparément et un genre ne passe que si sa catégorie est commune (§10.1).

| Champ | Classe (§10.2) | Pourquoi |
|---|---|---|
| `id` | synchronisé (clé) | **stable** : l'identifiant que chaque appareil donne déjà à l'onglet (aléatoire ; l'iPhone écrit `UUID().uuidString.lowercased()`). **Vérifié le 19 novembre 2026 (carte 507)** : l'identifiant d'onglet du Mac est aussi aléatoire. Un onglet naît par `tab/open` ou `tab/duplicate` (`sidebar-tabs.ts`, `id: ctx.newId()`), ou par la copie d'un dossier (`sidebar-spaces.ts`) ; `ctx.newId()` est `randomUUID()` (UUID v4, minuscules) dans `liveCtx` (`store.ts`), que les fenêtres privées et invitées utilisent aussi. Seuls les tests et les essais donnent des identifiants fixes. Deux appareils ne donnent donc pas le même identifiant à deux onglets (à une collision d'UUID près). Il reste le même sur les deux appareils tant que l'onglet existe, et c'est aussi l'identifiant de son entrée d'archive (§27.5) |
| `spaceId` | synchronisé | un onglet déplacé dans un autre espace suit |
| `customTitle` | synchronisé | le nom que la personne a donné à l'onglet |
| `icon` | synchronisé | l'émoji choisi |
| `activeAt` | synchronisé, **projection** | le moment de la dernière utilisation, **arrondi à 10 minutes** (§27.5) ; ce n'est pas un champ du modèle d'onglet : c'est `lastActiveAt` arrondi, et recevoir un `activeAt` plus grand que le sien fait écrire `lastActiveAt = max(local, reçu)` |
| `url`, `title` | **graine** | l'adresse et le titre **au moment où l'onglet entre dans l'ensemble partagé** (§27.3), **copiés une fois** puis locaux : la page change à chaque navigation, c'est du bruit [Q14]. Comme pour les onglets épinglés (§22), **la base n'en garde pas** : une adresse ou un titre n'est pas écrit dans les fichiers de la synchronisation |
| tous les autres champs de `TabItem` | **local** | `image`, `faviconUrl`, `deadKept`, `autoReload`, `container`, `windowKey`, `openerId`, `parentId`, `treeCollapsed` (l'arbre des onglets n'est pas partagé), `favoriteId`, `createdAt`, `lastActiveAt`, `private`, `keepAwake` |

- **Marques** : par champ, comme tout le reste (§9.2) ; relevées à l'écriture de l'état, **au moment où l'appareil voit le changement**. **Pierre tombale** : l'onglet qui **quitte** « Aujourd'hui » (fermé, archivé à la main ou automatiquement, épinglé, espace supprimé) donne `(todayTab, id, marque)` gardée **30 jours** (§11.5) : l'identifiant seul, jamais une adresse.
- **Ordre** : un registre par liste, clé `today:<espace>` (§11.4) ; les onglets arrivés de l'autre côté vont à la fin, triés par marque de naissance. **Avec l'arbre des onglets activé** (`tabTree`), l'ordre reçu n'est qu'un point de départ : l'arbre remet ses branches en place (`settleTree`).
- **À l'arrivée**, l'onglet est créé **endormi** (§27.12), avec `createdAt` et `lastActiveAt` égaux à l'`activeAt` reçu (un onglet vieux de onze heures arrive vieux de onze heures : l'archivage automatique le traite alors pareil des deux côtés, §27.5), dans l'espace nommé, **sans jamais changer l'onglet ni l'espace affichés** (§27.6).
- **Épingler, détacher** : épingler un onglet d'« Aujourd'hui » fait **disparaître** `todayTab/<id>` et **apparaître** `tab/<id>` (même identifiant). L'application du patch lit « une suppression de `todayTab` et une création de `tab` du même identifiant, dans le même patch » comme **un déplacement** : l'onglet reste, change de liste, garde sa page. Le détacher est le même cas en sens inverse. Sans cette règle, une suppression et une création se croiseraient sur un seul onglet. **Si `structure` n'est pas commune**, épingler fait quitter l'ensemble partagé : l'autre appareil le **ferme** (il va à son archive) ; le §27.9 en tient un vecteur.

### 27.3 Qui est partagé : l'admission

Un onglet **entre** dans l'ensemble partagé quand, **à la fin du gel d'une séance dont la catégorie `todayTabs` est commune**, il tient **toutes** ces conditions :

1. un onglet d'« Aujourd'hui » d'une **fenêtre normale** (§27.7) ; ni privé, ni la page d'un favori, ni d'un **conteneur** (un conteneur est un isolement voulu : son adresse ne quitte pas l'appareil ; choix de conception, jamais vu par le chef) ;
2. son espace n'est **pas verrouillé** [Q4] ;
3. son adresse est en `http` ou `https`, avec un hôte, de **4096 octets au plus** (une adresse plus longue est laissée de côté, jamais coupée : une adresse coupée est une autre page) ;
4. il est ouvert **depuis 20 secondes au moins** : un onglet de passage (une fenêtre d'authentification, une redirection) ne part pas, et le titre n'est plus celui d'une page en cours de chargement ;
5. il y a de la **place** (§27.4).

**L'admission est collante.** Les conditions 3 et 4 ne sont regardées **qu'à l'entrée** : une fois admis, l'onglet reste dans l'instantané **tant qu'il existe dans « Aujourd'hui »**, quelle que soit la page où il va (une page interne, une page trop longue). Sinon sa navigation le ferait **disparaître de l'instantané**, et la fusion lit « absent d'un côté, dans la base » comme une **fermeture** (§11.2) : l'autre appareil le fermerait. **Pour la même raison**, ni le plafond, ni un verrou posé plus tard, ne retirent un onglet de l'instantané : le verrou le met de côté (`withheld`, §18), il ne le supprime pas.

**Où est tenue l'admission** : dans le livre des marques de l'appareil (§22, `sync-marks.json`), **par appareil et non par appairé** ; un onglet admis suit l'état tant que l'interrupteur est activé, comme les autres entités. Un onglet admis puis fermé **pendant qu'aucune séance n'a lieu** donne sa pierre tombale à la lecture suivante de l'état (§9.2), comme n'importe quelle suppression.

### 27.4 Plafond [Q12]

**Recommandation (A) : 200 onglets partagés au plus, par appareil ; un onglet de plus reste local.** Le chiffre est celui de l'annonce du §7.5 (200). L'appareil garde **au plus 200** onglets admis à la fois ; un onglet qui n'entre pas est **« non partagé »** : il reste où il est, **sans jamais disparaître de nulle part**, et il est admis dès qu'une place se libère (celui qui a servi le plus récemment d'abord, puis l'identifiant). La page dit « 37 onglets d'Aujourd'hui ne sont pas partagés (limite : 200) ».

- Deux appareils qui admettent chacun 200 donnent **jusqu'à 400** onglets dans l'ensemble fusionné : c'est voulu (un plafond sur le résultat obligerait la fusion, fonction pure des mêmes entrées des deux côtés, à choisir quel onglet retirer, c'est-à-dire à le **supprimer** : voir §27.3).
- **La porte d'entrée** (`cleanSnapshot` côté Mac, `SyncInbound.clean` côté iPhone) refuse en plus **plus de 500 entités `todayTab` dans un instantané** : les mieux classées (par `activeAt` décroissant, puis identifiant) sont gardées, les autres écartées, comptées, journalisées (`too-many-today-tabs`), jamais fatales ; une entité écartée qui est dans la base est **remplacée par sa version de la base** (la règle du §22, « Entité refusée qui est dans la base »), pour que l'écart ne soit pas lu comme une suppression. Un appareil honnête n'y arrive jamais.
- **Options.** (A) ce qui précède. (B) le même mécanisme à **500** : plus de confort pour qui garde beaucoup d'onglets, un instantané plus gros (environ 150 Kio, bien sous la trame de 1 Mio ; **à mesurer**). (C) **aucun plafond propre** : au-delà de 200 la catégorie s'arrête avec une erreur (`too-many-tabs`) jusqu'à ce que la personne ferme des onglets : plus simple, plus brutal.

### 27.5 Archivage automatique et fermeture [Q10] [Q11]

Un onglet **quitte** « Aujourd'hui » par la croix, ⌘W, « Archiver tout » (`today/clear`), l'**archivage automatique** (`archive/sweep` sur le Mac, `sweepIdleTabs` sur l'iPhone : un onglet resté inactif plus longtemps que le délai de son profil, 12 h par défaut ; le balayage tourne toutes les 10 minutes sur le Mac), la suppression de son espace. **Tous ces cas sont la même chose pour la synchronisation** : l'onglet n'est plus dans l'instantané, donc la fusion rend une **fermeture** à l'autre appareil. Dans tous les cas, côté appareil, l'onglet est déjà **archivé** (le Mac comme l'iPhone mettent l'onglet fermé dans l'archive, avec l'identifiant de l'onglet).

| Question | Réponse |
|---|---|
| Un onglet **archivé** sur l'un : **fermé** ou **archivé** sur l'autre ? | **Archivé** [Q11]. Une fermeture reçue appelle **le même chemin que l'archivage local** (`archiveTabs`, `archive(tabIds:)`), source **`sync`** (celle que le §8.5 utilise déjà pour un espace supprimé), avec **l'adresse que l'onglet a alors sur cet appareil** : si la personne a navigué ici, la page où elle est va à l'archive, **rien n'est perdu**. « Rouvrir le dernier onglet fermé » la rend. Une page interne ou privée, que l'archive n'accepte pas, est seulement retirée |
| Doublons dans l'archive quand `archive` est aussi commune | **Aucun** : l'identifiant d'une entrée d'archive est celui de l'onglet **des deux côtés** (`archiveTabs` : `id: t.id` ; `archive(tabIds:)` : `id: tab.id`). L'entrée écrite par l'appareil qui ferme et celle de l'appareil qui reçoit sont **la même entité `archived`** ; seuls `source` et `archivedAt` diffèrent, tranchés par marque, sans conséquence |
| Restaurer depuis l'archive | crée un **nouvel onglet, d'un nouvel identifiant** : c'est une ouverture, il est partagé comme un autre |
| Qui balaie, et sur quelle activité ? | **Chaque appareil balaie de son côté**, avec son délai (le réglage `autoArchiveHours` voyage si « Réglages » est coché, §10.3). **Le défaut recommandé [Q10 : A]** : l'activité est **partagée en gros** par `activeAt` (arrondi à 10 minutes) et le balayage lit `max(lastActiveAt, activeAt reçu)`. Ainsi un onglet lu sur l'iPhone n'est pas balayé par le Mac qui ne l'a pas vu : sans cela, **un onglet que l'on lit sur l'iPhone se ferait fermer** par le Mac à la séance suivante, ce qui est le défaut du cas d'usage |
| Fermé ici **pendant qu'il est lu** là | `activeAt` plus récent que la base est **une modification** : la fusion garde l'onglet (la suppression perd face à une modification, §11.2). L'appareil qui avait fermé le **retrouve**. **`activeAt` ne bouge que lorsque la personne choisit l'onglet ou y navigue**, pas quand l'application revient au premier plan sur l'onglet déjà affiché, ni pendant qu'elle le lit : sinon une fermeture ne tiendrait jamais sur un iPhone qui montre l'onglet |
| Séance déclenchée par un `activeAt` seul | **non** : le changement d'activité attend la séance suivante, de la même façon qu'une navigation |

**[Q10] — Options.** (A) l'activité est **partagée en gros** (recommandé). (B) chaque appareil balaie **sur sa seule activité** : rien de plus n'est partagé, mais un onglet lu sur un appareil est fermé par l'autre. (C) les onglets **partagés ne sont plus balayés** : la personne les ferme elle-même, et le plafond (§27.4) se remplit d'onglets oubliés.

**[Q11] — L'onglet affiché au moment de la fermeture.** (A) il est **fermé comme les autres** et l'appareil montre le voisin, avec une ligne « Fermé sur le Mac » (recommandé : le même résultat sur les deux appareils, la page est dans l'archive). (B) il est **gardé**, et revient donc sur l'autre appareil à la séance suivante (le tableau du §27.9, « ouvert ici, fermé là », devient un va-et-vient). (C) il est gardé **jusqu'à ce que la personne le quitte**, puis fermé : plus doux, un état de plus à garder en mémoire de la séance.

### 27.6 L'onglet actif : pas synchronisé

L'onglet affiché et l'espace affiché (`activeTabBySpace`, `activeSpaceId`) **restent propres à l'appareil** (§10.5, inchangé). Ouvrir un onglet sur le Mac **ne le montre pas** sur l'iPhone : il s'ajoute à la liste ; une séance **ne change jamais** l'onglet ni l'espace que la personne regarde. **Seule exception**, [Q11] : l'onglet affiché est lui-même fermé à distance.

### 27.7 Fenêtres privées, espaces verrouillés, adresses

| Cas | Règle |
|---|---|
| **Fenêtre privée** (Mac), onglet privé | **jamais** : aucune ligne dans l'instantané, aucune demande de la fenêtre (`isSyncedTab` exclut déjà `private`) ; la synchronisation n'est pas pour elle |
| **Espaces verrouillés** [Q4] | la règle de [Q4] **ne change pas** : les onglets de l'espace sont **mis de côté** (`withheld` retire de la fusion l'espace et tout ce qui en dépend par `spaceId`) ; rien n'en est envoyé, rien n'en est appliqué tant qu'il est verrouillé. Une fermeture reçue pour un onglet d'un espace verrouillé **attend** le déverrouillage. Au déverrouillage, l'espace n'a pas de base : ses onglets sont des **ajouts des deux côtés** (§18, §11.8) |
| **`http` et `https` seulement**, **à l'envoi et à la réception** | à l'envoi (admission, §27.3) ; à la réception, une entité `todayTab` dont l'adresse n'est pas une page web avec un hôte, ou dépasse 4096 octets, est refusée (`invalid-url`) comme l'adresse d'un onglet épinglé (§22) : remplacée par sa version de la base si elle y est, sinon écartée. Un titre dépasse 300 octets : coupé **sans séparer une paire de substituts** (`cutBytes`) |
| **Mini-fenêtre** (le Mac) | ses onglets ne sont pas des onglets de fenêtre normale : **non partagés**. **À vérifier** par la carte Mac : où vit l'état d'une mini-fenêtre |
| **Fenêtres indépendantes** (`independentWindows`) | un onglet est partagé quelle que soit sa fenêtre ; `windowKey` reste local. Un onglet reçu arrive dans **la première fenêtre** (celle sans `windowKey`) |

### 27.8 Vie privée : ce que cela ajoute

Titres et adresses des onglets ouverts sont **ce qui ressemble le plus à un historique** (§10.4). Ils partaient déjà dans l'annonce `open-tabs`, mais **en lecture seule et en mémoire**. Ce que cette section ajoute, et ce qu'elle n'ajoute pas :

- **Ce qui part** : pour chaque onglet partagé, **l'adresse et le titre à l'entrée** (graines), l'espace, le nom et l'icône que la personne a donnés, l'**ordre**, et `activeAt` (le moment de la dernière utilisation, à 10 minutes près : [Q10]). **Vers l'appareil appairé seulement**, par le même canal chiffré (§6).
- **Ce qui n'est pas écrit sur disque par la synchronisation** : **aucune adresse, aucun titre** (la base n'en garde pas, §27.2 ; le livre des marques garde des empreintes, §22 ; une pierre tombale est un identifiant et une marque). **Le journal des conflits** (§11.7.3) ne garde **jamais l'adresse ni le titre** d'un onglet d'« Aujourd'hui » : la ligne dit « Onglet », ou le nom que la personne lui a donné. L'adresse d'un onglet fermé n'est gardée que par **l'archive de l'appareil**, qui existe déjà et que la personne peut vider (le « Rien n'est gardé » de la maquette n'est pas modifié).
- **Ce que l'on peut déduire des pierres tombales** (30 jours) : combien d'onglets ont été fermés et quand, pas leur contenu.
- **Le défaut reste non coché** [Q9] ; la page dit **en une phrase** ce qui part : « Les titres et les adresses de vos onglets d'Aujourd'hui sont envoyés à l'autre appareil. »
- **Rien de nouveau n'est envoyé hors de l'appareil appairé** : pas d'appel réseau, pas de ligne de plus dans le tableau des connexions de ce point de vue, mais **la ligne du README change de mot** (§27.15).

**[Q9] — Valeur par défaut de la catégorie.** (A) **non cochée**, une phrase sur la page (la réponse du chef à [Q2] reste telle quelle : « le mieux le plus secure »). (B) **non cochée, mais proposée une fois** : la feuille « Autoriser » du Mac et la feuille « Appairer » de l'iPhone portent une case « Partager aussi les onglets d'Aujourd'hui », **décochée** : la personne dit oui ou non au moment où elle s'appaire, au lieu de découvrir la catégorie après coup (le deuxième essai a montré qu'elle ne la cherche pas). Chaque appareil garde **sa** case (les deux doivent être cochées, §10.1) : c'est deux gestes, mais faits à l'appairage, sous les yeux de la même personne. (C) **cochée par défaut** : rompt [Q2]. **Recommandation : B.**

### 27.9 Conflits

La fusion du §11 s'applique **sans règle propre** : les cas ci-dessous sont des cas de ses règles, que les vecteurs du §27.13 tiennent.

| Situation | Résultat |
|---|---|
| **Fermé ici, navigué là** | **La fermeture gagne.** Une navigation n'est **pas un changement d'un champ suivi** (`url` est une graine) : l'onglet est « intact » de l'autre côté, il est supprimé (§11.2). La page où il était va à l'**archive** de l'appareil où l'on a navigué (§27.5) : rien n'est perdu |
| **Fermé ici, lu là** (`activeAt` plus récent que la base) | **L'onglet est gardé** : une modification gagne une suppression (§11.2). Résumé de conflit : « Gardé sur les deux appareils » (§13.4) |
| **Fermé ici, déplacé, renommé ou changé d'icône là** | **L'onglet est gardé**, tel que l'autre côté l'a (même règle) |
| **Fermé des deux côtés** | absent ; les pierres tombales se réunissent |
| **Ouvert sur les deux, même adresse** | **deux onglets** : deux identifiants, deux entités, aucune fusion par adresse [Q13] |
| **Renommé des deux côtés** | la **marque la plus grande** gagne, comme pour un espace (§11.3) |
| **Épinglé ici, fermé là** | l'épinglage (`tab/<id>`) est une **création** : l'onglet revient **épinglé** sur les deux appareils (si `structure` est commune) ; c'est un geste de la personne, plus récent que la fermeture |
| **Réordonné des deux côtés** | la liste dont la marque d'ordre est la plus grande (§11.4) |

### 27.10 Premier échange [Q13] [Q14]

La **base est vide** (première séance, base perdue, plus de 30 jours, ou **première fois que la catégorie est commune**) : **l'union** des deux listes (§11.8), chaque onglet est un ajout, aucun conflit. Le plafond (§27.4) s'applique à ce que **chaque appareil** envoie : un Mac qui a 300 onglets en partage les **200** dont il s'est servi le plus récemment, les autres restent locaux.

- **Un iPhone jamais modifié** (§11.8) **adopte aussi les onglets du Mac** : son instantané de `todayTab` est vide comme celui de la structure, quand `todayTabs` est commune. Le drapeau « jamais modifié » passe à faux dès que la personne ouvre un onglet : **l'adoption ne retire jamais un onglet qu'elle a ouvert**. Une page vide (page de démarrage) n'est pas partageable de toute façon (§27.3).
- **Doublons d'adresse** : une même page ouverte sur les deux appareils donne **deux onglets**. **Options.** (A) **aucun dédoublonnage** (recommandé) : l'union ne perd rien, les deux copies sont à fermer, et une fusion « par adresse » obligerait le premier échange à **fermer** un onglet de la personne sans qu'elle l'ait demandé. (B) **dédoublonner au premier échange seulement** : même espace et même adresse exacte : un seul est gardé (le plus récemment utilisé), l'autre est archivé ; plus propre, mais la fermeture n'est plus un geste de la personne.
- **Si la base est perdue plus tard** (§11.5), ce qui avait été fermé sur un appareil et qui est resté ouvert sur l'autre **revient** : l'écran d'état le dit déjà.
- **Navigation reprise ou non [Q14].** (A) **non** : l'adresse est copiée à l'ouverture seulement (recommandé : pas de rechargement, pas de flux d'adresses de plus, aucun conflit sur l'adresse). Conséquence **assumée** : deux copies d'un même onglet peuvent montrer deux pages, celle de l'appareil où l'on a navigué en dernier n'étant pas reprise par l'autre. (B) **oui, sur un onglet endormi seulement** : l'adresse devient un champ synchronisé (dernière navigation gagnante) ; un onglet éveillé n'est jamais navigué par la synchronisation. Plus fidèle à « mêmes onglets », mais chaque navigation devient un changement à échanger, à départager et à journaliser, et le flux des pages vues devient un historique d'adresses de plus. Passer de A à B plus tard ne change que la classe d'un champ (§10.2).

### 27.11 « Reprendre un onglet du Mac » [Q8]

**Recommandation (A) : supprimé.** Avec des onglets partagés, la liste en lecture seule ne sert plus : ce qu'elle montrait est déjà dans « Aujourd'hui ». **Aucune version publiée ne porte la synchronisation** (§17, point 10) : retirer maintenant coûte peu, retirer plus tard coûterait une migration.

- **Ce qui disparaît** : la catégorie `openTabs` (§10.1), le message `open-tabs` (§7.3, §7.4, §7.5, §8.2 point 4), l'écran « Reprise » et la source « Sur le Mac » (cartes 447 et 452, §24), la source « Sur l'iPhone » de la barre de commandes du Mac et son canal `lucium:sync-resume` (carte 490, §25), la mémoire de la liste après la fenêtre et sa phrase (carte 491, §26), les vecteurs `sync-resume-vectors.json`, `openTabsOf`, `SyncResume`, `sync-resume.ts`. Les §24, §25 et §26 restent **comme l'historique de ce qui a été fait** ; chacun porte une ligne qui dit qu'il est remplacé.
- **Ce qui est lu avec tolérance** : une valeur `openTabs` dans un fichier `sync.json` d'une version de développement est **ignorée** (jamais une erreur). **Un appareil de développement qui l'annoncerait encore** ne la partage avec personne : la nouvelle version ne la connaît pas, l'intersection du §8.2 l'exclut, `open-tabs` n'est donc jamais envoyé.
- **Options.** (A) ce qui précède. (B) **garder les deux** : « Onglets ouverts » reste un mode léger (voir sans importer), la ligne de catégorie devient à **trois états** (rien / voir les onglets de l'autre appareil / les partager) ; quand `todayTabs` et `openTabs` sont communes, `open-tabs` n'est **pas** envoyé. Plus de code à tenir et à tester (les trois écrans existants), pour qui veut voir sans que rien ne s'ouvre ni ne se ferme.

### 27.12 Performances

- **Pas de rechargement.** Un onglet reçu est créé **endormi** : sans vue web ni connexion, avec son titre et son adresse ; il ne charge qu'à son ouverture. **À vérifier** : le Mac sait créer un onglet d'« Aujourd'hui » endormi avec une adresse (il le fait pour les onglets épinglés, `awake: false`, et pour ses endormis) ; l'iPhone sait garder un onglet sans vue web (`TabSleep`, `WebViewHost`) et n'en crée qu'à l'ouverture. Aucune icône n'est chargée pour un onglet endormi. Un onglet **navigué** n'est jamais rechargé par la synchronisation (l'adresse est une graine, [Q14]). Fermer un onglet éveillé est la fermeture ordinaire.
- **Taille.** Un instantané de 200 onglets : environ 200 entités de quelques champs, de l'ordre de 60 Kio, quinze valeurs JSON par entité, soit trois mille valeurs sur les 150 000 permises par trame (§7.5). **À mesurer** avec 200 onglets réels.
- **Fréquence.** Avec des séances toutes les 30 secondes (carte 505), un instantané complet par séance (§8.2) coûte une poignée de main TLS et deux fois cette taille, **même quand rien n'a changé**. L'**envoi par différences** que le §8.2 prévoit « plus tard » devient alors le premier chantier de performance ; il n'est **pas** dans cette carte, et la mesure ci-dessus dit s'il est nécessaire.
- **Déclencheurs.** Une séance « après un changement local » (§8.1) ne se déclenche que sur un changement **d'un champ suivi** : l'ouverture, la fermeture, le déplacement, un nom, une icône ; **ni une navigation, ni `activeAt` seul** (§27.5), sinon chaque page lue ferait une séance.
- **Application.** Les créations d'un échange (200 à la première séance) passent par **un seul** `sync/apply`, **une seule** écriture de l'état et un seul affichage, avec l'application en temps linéaire du §22 ; **à mesurer** avec 200 créations. Les onglets créés ne chargent rien : le coût est celui de l'état, pas celui des pages.
- **Livre des marques et pierres tombales.** Quatre marques par onglet, environ 200 onglets admis ; une centaine de fermetures par jour donne quelque trois mille pierres tombales sur 30 jours, très sous la borne de 50 000 (§7.5).

### 27.13 Compatibilité : une catégorie que l'autre appareil ne connaît pas

- **La version du protocole reste 1** : « ajouter un champ ou une catégorie ne change pas la version » (§7.2). `hello.categories` est une liste de textes de 32 caractères au plus, **quel que soit leur contenu** (`messages.ts`) : un appareil qui ne connaît pas `todayTabs` **ne l'annonce pas** et **ignore** celle de l'autre. L'intersection du §8.2 l'exclut : **ni `todayTab`, ni `today:<espace>` n'est envoyé**, l'échange continue comme avant pour le reste.
- **Ce que dit la page** : une catégorie cochée ici et absente de l'intersection dit « Pas cochée sur l'autre appareil, ou son Lucium est plus ancien » (le `hello` ne dit pas laquelle des deux : il donne la liste des catégories **cochées**, et `appVersion`). Le « Dernier échange » de l'iPhone (§13.3) dit déjà « pas échangées parce que non cochées sur le Mac » ; la phrase gagne ce second cas.
- **Un genre inconnu** (`todayTab` chez un appareil plus ancien) traverse sans être lu (§11.6) : cela ne peut arriver que si l'autre en a envoyé sans que la catégorie soit commune, ce qu'un appareil honnête ne fait pas.
- **Aucun changement du format d'état** (`stateVersion` inchangée) : `todayTab` n'est jamais dans `state.json`, c'est une projection des onglets. **Seul le livre des marques** gagne les onglets admis : son numéro de format augmente ; ce qu'une version plus ancienne fait d'un livre d'un format plus récent (le garder tel quel, comme le journal du §11.7.3, ou en refaire un à partir de l'état, ce qui revient à une base perdue, §11.8) est **à décider par la carte d'implémentation**.
- **Les vecteurs** (§19) gagnent `sync-today-vectors.json` (**écrit par la carte 507**, voir §27.16) : admission (conditions, collante, plafond, délai de 20 s), classement `fieldClasses` du genre `todayTab` (**et** la projection `activeAt`), cas de fusion du §27.9 (y compris le déplacement épinglé ↔ Aujourd'hui et la suppression face à `activeAt`), cas de la porte d'entrée (`invalid-url`, `too-many-today-tabs`) ; **l'archivage à la réception et l'identifiant d'entrée d'archive n'y sont pas encore** : ils dépendent de l'écriture dans l'état, c'est le travail des cartes Mac et iPhone. Joués par Vitest contre le vrai code du Mac et par LuciumKit contre le Swift ; **sans ces vecteurs, une seule règle différente d'un côté donne `divergence`** (§8.5).

### 27.14 Choix qui reviennent au chef de projet (carte 504)

Posés en commentaires `[question]` de la carte 504. **Les réponses ne sont pas encore données** : le texte ci-dessus suit la recommandation.

| | Choix | Recommandé | Où |
|---|---|---|---|
| **Q8** | Que devient « Reprendre un onglet du Mac » | **Supprimé** (la liste en lecture seule n'a plus d'objet) | §27.11 |
| **Q9** | Valeur par défaut de la catégorie | **Non cochée, proposée une fois à l'appairage** (case décochée sur chaque appareil) | §27.8 |
| **Q10** | Archivage automatique des onglets partagés | **Activité partagée en gros** (`activeAt`, 10 minutes) ; un balayage ferme chez l'autre | §27.5 |
| **Q11** | Une fermeture reçue, et l'onglet qui est affiché | **Archivé même s'il est affiché**, avec une ligne qui le dit | §27.5 |
| **Q12** | Plafond | **200 par appareil**, au-delà **local** (jamais supprimé) | §27.4 |
| **Q13** | Premier échange : doublons d'adresse | **Union sans dédoublonnage** | §27.10 |
| **Q14** | La navigation d'un onglet partagé est-elle reprise sur l'autre appareil | **Non** : adresse copiée à l'ouverture seulement | §27.10 |

### 27.15 Ce qui change ailleurs dans ce document

| Passage | Changement |
|---|---|
| §10.1, tableau | la ligne `openTabs` devient `todayTabs` [Q8] |
| §10.2, tableau | le genre `todayTab` |
| §10.4 | réécrit : la décision du 18 novembre y est gardée comme historique, remplacée le 19 novembre |
| §8.2 point 4, §8.3, §7.3 à §7.5 | le message `open-tabs` est retiré si [Q8] = A ; le genre `todayTab` s'ajoute aux genres |
| §8.5 (espace supprimé à distance) | les onglets d'« Aujourd'hui » de l'espace supprimé sont **déjà** archivés par la règle : elle vaut pour les onglets partagés comme pour les autres |
| §11.4 | les listes `today:<espace>` |
| §13.1, §13.3 | la phrase de la catégorie ; le « Dernier échange » ne dit plus que les onglets d'« Aujourd'hui » ne passent jamais |
| §14 | la ligne du README : « et vos onglets d'Aujourd'hui », au lieu de « la liste de vos onglets ouverts » ; **le README lui-même est changé par la carte d'implémentation, dans le même commit que la fonction** (`AGENTS.md` §5) |
| §21 | la ligne « étape 2b » |
| §22 à §26 | des lignes qui disent « remplacé par §27 » (si [Q8] = A) |
| `docs/ios.md` §13.3 | la ligne 2b |

**Ce qui ne change pas** : [Q4] (espaces mis de côté), [Q2] pour les autres catégories, [Q3] (union), la fusion et ses propriétés (§11.9), les bornes des messages (§7), le chiffrement, l'appairage, les rôles du Mac et de l'iPhone, l'onglet affiché. **Ce que cette section ne dit pas** : le fonctionnement automatique (écoute du Mac, intervalle de l'iPhone), qui est de la carte 505.

**Ce que les tests ne montrent pas** : seul le contrat partagé est écrit en code (§27.16) ; ni le Mac ni l'iPhone ne s'en servent encore, et rien n'a été essayé avec un iPhone.

### 27.16 Ce que la carte 507 a précisé en l'écrivant (le contrat partagé)

La carte 507 écrit **le contrat seulement** : des fonctions pures et les vecteurs `ios/Contracts/sync-today-vectors.json`, joués des deux côtés. **Rien n'est encore branché** : ni la vue de l'état, ni `cleanSnapshot`, ni `SyncInbound.clean`, ni le patch n'appellent ces fonctions ; c'est le travail des cartes Mac et iPhone. Les points où il a fallu choisir, sans changer ce qui est décidé plus haut :

| Sujet | Ce que fait le contrat | Pourquoi |
|---|---|---|
| **Où est le code** | `src/shared/sync-today.ts` (TypeScript, sans Electron) et `LuciumKit/Sources/LuciumKit/SyncToday.swift` : les limites (200, 500, 4096 octets, 300 octets, 20 s, 10 min), les classes de champs, `admitTabs`/`admit`, `gateTodayTabs`/`gate`, `todayMoves`/`moves`, `roundActiveAt`, `lastActiveFrom` | des fonctions pures des mêmes entrées des deux côtés ; les cartes Mac et iPhone les appellent. Les classes de `todayTab` ne sont **pas** dans `FIELD_CLASSES` (`field-classes.ts`) : ce tableau type les cinq genres de l'état que `sync/apply` sait écrire ; `todayTab` est une projection des onglets, la carte Mac l'y ajoutera avec son écriture |
| **Classes des champs** | `synced` : `id`, `spaceId`, `customTitle`, `icon`, `activeAt` ; `seed` : `url`, `title` ; `local` : tout le reste de `TabItem`, **`keepAwake` compris** (§27.2) ; `notApplicable` : `pinned`, `anchorUrl`, `folderId` (propres à un onglet épinglé) | un test lit `model.ts` et échoue si un champ de `TabItem` n'est dans aucune classe de `todayTab`, ou dans deux |
| **Arrondi de `activeAt`** | vers le **bas**, au multiple de 10 minutes ; une valeur qui n'est pas un nombre fini et positif donne 0 | « arrondi à 10 minutes » ne disait pas dans quel sens : vers le bas ne dépasse jamais la dernière utilisation réelle. Hypothèse du travailleur, jamais vue par le chef |
| **Admission** | un onglet **déjà admis** saute les conditions 2 à 5 (espace, adresse, 20 s, place) mais **la condition 1 est regardée à chaque fois** (privé, fenêtre privée, page d'un favori, conteneur : un onglet admis qui devient privé sort) ; les nouveaux se partagent `plafond − déjà admis` places, **le plus récemment utilisé d'abord (`lastActiveAt` brut), puis l'identifiant** ; un onglet déjà admis ne sort **jamais** pour le plafond, même s'il y en a plus de 200 | le plafond est « à l'entrée, jamais un retrait » (§27.3, §27.4). Un onglet refusé pour ce qu'il est (conditions 1 à 4) ne prend pas de place |
| **Porte d'entrée** | `gateTodayTabs` ne fait que ce qui est propre au genre : adresse partageable (`invalid-url`), titre qui n'est pas un texte ou `activeAt` qui n'est pas un nombre positif (`invalid-value`), **titre coupé à 300 octets** sans séparer un caractère, champs et marques **locaux** retirés, plus de 500 entités (`too-many-today-tabs`, les mieux classées par `activeAt` décroissant puis identifiant sont gardées). Les contrôles généraux (marque du futur, texte avec un substitut isolé, genre interdit) restent ceux de `cleanSnapshot` et `SyncInbound.clean`, qui l'appellent pour ce genre | pas de seconde copie des contrôles généraux. Une entité écartée qui est dans la base est remplacée par sa version de la base (§22) : **ces versions de la base s'ajoutent après le plafond de 500**, elles viennent d'une séance où elles avaient passé la porte |
| **Déplacement** | `todayMoves(retirées, créées)` : la suppression de `todayTab/<id>` avec la création de `tab/<id>` (ou l'inverse) **dans le même patch** est un déplacement. Une suppression seule est une fermeture : c'est aussi ce que voit l'autre appareil quand `structure` n'est pas commune | la règle de §27.2, à appeler depuis l'application du patch (Mac : `sync/apply` ; iPhone : `SyncApply`) |
| **La fusion** | aucune règle nouvelle : `sync-merge.ts` et `SyncMerge.swift` apprennent seulement que `todayTab` **dépend de son espace** (`spaceId`) : un espace mis de côté l'emporte avec ses onglets d'Aujourd'hui, un onglet d'un espace qui n'existe plus est retiré avec sa pierre tombale (§11.7.1), un onglet déplacé dans un espace le garde face à la suppression de l'espace (§11.2), et la liste `today:<espace>` est celle de l'onglet (§11.4) | sans cela, la fusion aurait traité `todayTab` comme un genre inconnu (§11.6) : pas d'ordre, pas de verrou |
| **Ce que les vecteurs ne tiennent pas** | l'archivage à la réception (source `sync`, identifiant d'entrée = identifiant de l'onglet) et la liste `today:<espace>` d'un espace mis de côté dans `buildPatch` (`listOfSpaceAside` ne connaît que `folders` et `tabs`) | ce sont l'écriture dans l'état et le patch : cartes Mac et iPhone |

**Vérifié** : l'identifiant d'onglet du Mac est aléatoire (§27.2). **Preuve** : chaque garde de `sync-today.ts` et de `SyncToday.swift` (le plafond, la condition de chaque refus, l'admission collante, l'arrondi, le plafond de la porte, la coupure du titre, le classement, la version de la base, les deux sens du déplacement) et les quatre lignes de la fusion ont été **retirées ou inversées une à une** : au moins un vecteur échoue chaque fois (Vitest et `swift test`) ; une seule inversion ne change rien (`>=` à la place de `>` sur le plafond de la porte : `slice` rend le même résultat, c'est une mutation équivalente).

### 27.17 Ce que la carte 508 a précisé en l'écrivant (le Mac)

La carte 508 branche le contrat sur le Mac (PR #143). Les points qui touchent **les deux appareils** :

| Sujet | Règle | Pourquoi |
|---|---|---|
| **`todayTabs` sans `structure`** | un appareil **n'annonce `todayTabs` que si `structure` est aussi cochée**, et la catégorie n'est **commune que si `structure` l'est** (le Mac applique les deux règles) | un onglet dépend de son espace (§27.2) et les espaces voyagent avec la structure : sans elle la fusion ne trouve aucun espace et **retire tous les onglets** (§11.7.1), ceux de l'appareil d'abord. L'iPhone doit annoncer de la même façon, et l'interface (carte d'interface) ne doit pas laisser cocher l'une sans l'autre. Le même trou existe pour `archive` seule : hors périmètre, non corrigé |
| **Un onglet revient sans sa page** | l'application du patch reprend l'adresse et le titre de **l'entrée d'archive de même identifiant** (§27.5), et la consomme ; sans entrée, l'onglet n'est pas créé (un onglet sans adresse n'en est pas un) | « fermé ici, lu là » (§27.9) : les graines ne partent qu'avec une entité **nouvelle pour l'autre appareil**, donc l'appareil qui a fermé reçoit l'onglet sans adresse |
| **Fermeture reçue d'un onglet affiché** [Q11] | l'onglet va à l'archive (source `sync`), le voisin est affiché ; la session prévient l'interface par `onShownTabsClosed` (identifiant, espace, « à l'écran ») : la ligne « Fermé sur l'iPhone » est celle de la carte d'interface | l'événement existe côté Mac, rien ne le dessine encore |
| **Déplacement** | l'onglet est converti **en place** (il garde sa page et son historique, les graines de la création ne sont pas écrites) ; seulement tant qu'il est tel que la séance l'a gelé | §27.2 |
| **Liste `today:<espace>`** | ne range que les onglets **nommés** : ceux d'« Aujourd'hui » qui ne sont pas partagés gardent leur place | §27.3 |
| **Livre des marques** | **format 2** (il porte les onglets admis, genre `todayTab`) ; un livre de format 1 est lu ; un format plus récent est mis de côté (le cas de la base perdue, §11.8) | §27.13 laissait la décision à la carte d'implémentation |
| **Mini-fenêtre** | ses pages ne sont pas dans l'état de la barre latérale (pages de `LittleWindow`) : **jamais partagées** | à vérifier en §27.7 : vérifié |

### 27.18 Ce que la carte 509 a précisé en l'écrivant (le genre `todayTab` sur l'iPhone)

La carte 509 branche le contrat du §27.16 dans LuciumKit et dans l'application de l'iPhone (**sans interface**, sans texte, sans la case d'appairage : les cartes d'interface qui suivent). Les points ci-dessous sont des choix de l'iPhone ; **ceux que le Mac doit faire à l'identique pour que les deux fusions partent des mêmes entrées** sont marqués « Mac pareil » et ont été comparés au code du Mac fusionné (§27.17) : l'entité envoyée, l'ordre `today:<espace>`, l'ensemble admis qui entre à l'adoption et la règle des catégories sont les mêmes ; l'admission est tenue autrement (le Mac la lit dans les entités du livre, l'iPhone en garde la liste) sans autre effet. Une séance contre le vrai Mac reste à jouer (carte d'interopérabilité).

| Sujet | Ce que fait l'iPhone | Pourquoi |
|---|---|---|
| **Entité envoyée** (Mac pareil) | `spaceId`, `customTitle`, `icon`, `activeAt` (arrondi vers le bas à 10 minutes), plus `url` et `title` en graines **seulement pour un onglet que la base ne connaît pas**. **Rien d'autre** : un champ inconnu du modèle d'onglet ne part pas. Liste d'ordre `today:<espace>`, dans l'ordre de l'état, **onglets admis seulement** | le genre est une projection, pas un reflet de `TabItem` : l'entité est la même quelle que soit la version de l'application qui l'écrit |
| **Admission** (Mac pareil) | décidée **au gel d'une séance dont `todayTabs` est commune**, jamais avant ; l'ensemble admis est gardé **dans le livre des marques** (`sync-marks.json`, format **2** : liste `admitted` ; un livre de format 1 se lit comme « aucun admis », un format 2 sans la liste est refusé). La condition 1 (privé, favori, conteneur) est relue **à chaque lecture de l'état**, pas seulement au gel : un onglet devenu privé sort tout de suite de la vue suivie | l'admission est collante (§27.3) ; sans le livre, un redémarrage la perdrait |
| **Un onglet reçu est admis** (Mac pareil) | à l'adoption de la fusion (`adopt`), les identifiants des `todayTab` du snapshot fusionné **entrent dans l'ensemble admis** | sinon la lecture suivante de l'état verrait l'onglet reçu « absent de la vue suivie » et le marquerait **fermé** : l'autre appareil le fermerait |
| **Espace verrouillé** | un onglet déjà admis dont l'espace se verrouille **reste admis** et est mis de côté (`withheld`) : il ne part pas, il n'est pas oublié ; un nouvel onglet d'un espace verrouillé n'entre pas (condition 2) | §27.3 |
| **Déclencheur** | avec `todayTabs` cochée ici, un onglet qui **pourrait** être partagé (page web, ni privé, ni favori, ni conteneur) et qui n'a pas encore été vu demande une séance « après un changement local » (30 s plus tard : il a alors plus de 20 s) ; une navigation ou un onglet vierge n'en demande pas | §27.12 : ouvrir un onglet est un changement ; l'admission, elle, attend le gel |
| **Création à l'arrivée** | un `todayTab` créé devient un onglet de l'état, **non épinglé**, **sans vue web** (la vue naît au réveil : rien n'est chargé), à la fin de la liste, avec `createdAt = lastActiveAt = activeAt` reçu (ou maintenant si `activeAt` manque) ; l'espace et l'onglet affichés ne changent jamais. Sans adresse web ou sans espace connu : pas fait, compté dans `rejected` | §27.2, §27.6 |
| **`activeAt` reçu** | `lastActiveAt = max(local, reçu)`, **sans garde `expect`** (le plus grand gagne de toute façon) ; le balayage (`sweepIdleTabs`) lit `lastActiveAt` et n'a donc rien de plus à savoir | §27.5 [Q10] |
| **Fermeture reçue** | le `todayTab` retiré est **archivé par `archive(tabIds:)`**, source `sync`, identifiant d'entrée = identifiant d'onglet, **avec la page où l'onglet est ici** ; seulement s'il est encore tel que la séance l'a gelé (`expect`) et pas épinglé entre-temps. Un onglet vierge ou privé est seulement retiré. L'espace qui l'affichait montre l'onglet le plus récemment utilisé | §27.5 [Q11] |
| **Événement « fermé sur le Mac »** | `SyncApply.Outcome.closedTabIDs` (les fermés) ; le modèle garde `syncClosedShownTab` (identifiant, titre, moment) **quand l'onglet affiché est l'un d'eux**. La ligne « Fermé sur le Mac » est d'une carte d'interface qui suit : elle lit cette valeur et l'efface | §27.5 [Q11] |
| **Épingler, détacher** | `todayMoves` est appelé à l'application du patch : un onglet que l'autre appareil épingle (retrait de `todayTab/<id>` + création de `tab/<id>`) **reste**, devient épinglé, **garde sa page** (les graines `url`/`title` du `tab` ne la remplacent pas) ; détaché : il reste, n'est plus épinglé, sans ancre ni dossier. Le retrait d'un `todayTab` ne ferme **jamais** un onglet épinglé ici | §27.2 |
| **Ordre `today:<espace>`** | seuls les onglets que la liste nomme se remettent dans l'ordre, **à la place qu'ils occupaient** ; les onglets locaux non partagés (au-delà du plafond, trop jeunes) ne bougent pas | l'autre appareil ne les connaît pas |
| **Premier échange, iPhone « jamais modifié »** | **aucun code** : l'adoption du §27.10 est l'**union** avec un instantané `todayTab` vide, ce que fait déjà la fusion. Le drapeau « jamais modifié » (`SyncOrigin`) ne regarde que la structure : il **ne passe pas à faux** quand la personne ouvre un onglet d'« Aujourd'hui », contrairement à ce que dit le §27.10. Retirer les `todayTab` de l'instantané d'un tel iPhone (comme on retire la structure) fermerait des onglets que la personne a ouverts : **non fait** | §27.10 : « l'adoption ne retire jamais un onglet qu'elle a ouvert » |
| **Journal des conflits** | le genre se dit « Onglet » ; l'étiquette de la ligne est le **nom que la personne a donné** (`customTitle`), **jamais** le titre ni l'adresse | §27.8 |
| **Catégorie** | `SyncCategory.todayTabs` (nom du protocole : `todayTabs`), **non cochée par défaut** [Q9] ; **annoncée dans le `hello` et prise comme commune seulement avec `structure`**, comme le Mac (`announcedCategories`, `commonCategories`) : sans les espaces, la fusion ne trouverait aucun espace et retirerait tous les onglets, ceux de l'autre appareil compris (`SyncCategory.announced`, `SyncCategory.common`) ; une catégorie inconnue d'un fichier `sync.json` est ignorée. La ligne de réglages n'est **pas** montrée (carte d'interface qui suit) | §27.1 |

**Vérifié** (tests LuciumKit, `SyncTodayTabsTests`, et tests de l'application sur simulateur, `SyncTodayTabsAppTests`, sans fenêtre) : tout ce qui précède, y compris des séances entières contre le Mac écrit pour les tests (`SyncTestMac`, même fusion Swift). **Pas vu** : un vrai iPhone sur un vrai réseau, et une séance contre le **vrai** Mac (carte d'interopérabilité).

### 27.19 Ce que la carte 510 a précisé en l'écrivant (l'interface et les textes, Mac et iPhone)

La carte 510 dessine ce que les cartes 508 et 509 avaient laissé côté données. Les choix, tous pris sans changer ce qui est décidé plus haut :

| Sujet | Ce que font le Mac et l'iPhone | Pourquoi |
|---|---|---|
| **Ligne de catégorie** | « Onglets d'Aujourd'hui », **non cochée par défaut** [Q9], avec une phrase entière : les adresses et les titres, à peu près quand vous les avez utilisés, partent vers l'autre appareil ; jamais les cookies ni les connexions | §27.8 : dire en une phrase ce qui part |
| **Pas sans « Espaces et dossiers »** | **Décocher la structure décoche aussi « Onglets d'Aujourd'hui »** (le service du Mac, `SyncCategory.ticked` sur l'iPhone) et, tant que la structure est décochée, **la ligne est grisée et dit pourquoi** (« Il faut d'abord cocher… »). Le service **refuse** de la cocher sans la structure (le Mac répond une erreur interne, l'iPhone ne change rien) | l'écran montre ce qui part : une ligne cochée mais inactive aurait promis des onglets qui ne partent pas (§27.16, règle de `announced`/`common`). Une seule table, `NEEDS_STRUCTURE` (Mac) et `SyncCategory.needsStructure` (iPhone), dit quelles catégories en dépendent : `archive` s'y ajoute avec la carte 516 si elle pose la même règle |
| **Case d'appairage** [Q9] | « Partager aussi les onglets d'Aujourd'hui », **décochée à chaque ouverture** : dans la question « Autoriser / Refuser » du Mac (`answer` porte `shareToday`), dans la feuille « Appairer » de l'iPhone (`pair(with:shareToday:)`). **Elle n'est appliquée qu'une fois l'appairage terminé** (un refus, un code non confirmé ou un échec ne coche rien), et **seulement si la structure est cochée** : sinon la case est grisée avec la même phrase | la personne dit oui ou non au moment où elle s'appaire ; chaque appareil garde sa case (§10.1) |
| **« non partagés : n »** | le nombre d'onglets que le gel a laissés sur l'appareil faute de place (refus `full` de l'admission, §27.4), dans « Dernier échange » : « Onglets d'Aujourd'hui non partagés : 37 (limite : 200). » Calculé **à chaque séance** ; 0 quand la catégorie n'est pas commune (seuls les onglets déjà admis sont alors candidats, tous passent) | §27.4 |
| **« Fermé sur le Mac » / « Fermé sur l'iPhone »** | une ligne quand un onglet **affiché** est fermé par l'autre appareil (§27.5 [Q11]). **Mac** : dans le groupe « Dernier échange » de la page, jusqu'à ce que la page soit quittée ou l'appareil oublié (`SyncStatus.closedShown`, alimenté par `onShownTabsClosed` de la séance). **iPhone** : un bandeau au-dessus de la page, avec le titre, « Sa page est dans l'archive. » et « Rouvrir » (`reopenSyncClosedShownTab` : l'entrée d'archive de même identifiant revient en **nouvel onglet**) ; il s'efface seul au bout de 12 secondes ou à la croix | le Mac a « Rouvrir le dernier onglet fermé » (le texte le dit) ; l'iPhone n'a pas cette commande, le bandeau en tient lieu pour cet onglet |
| **« Dernier échange »** | l'iPhone avait déjà la section ; elle gagne deux lignes (`todayTabsReceived`, `todayTabsUnshared`), **seulement si la catégorie a traversé**. **Le Mac n'avait pas de section « Dernier échange »** : elle est créée, et ne montre que ces deux lignes et « Fermé sur l'iPhone » (rien quand il n'y a rien à dire, rien sur les onglets d'Aujourd'hui tant que la catégorie est décochée) | le §13.3 ne décrivait la section que pour l'iPhone ; une phrase de plus pour le Mac que de laisser le Mac muet |
| **« Reçus »** | on compte les onglets d'Aujourd'hui **nouveaux ici** (créations du patch), pas les mises à jour : un renommage n'est pas un onglet reçu | « n onglets reçus » doit être le nombre d'onglets arrivés |
| **« Reprendre un onglet du Mac »** | **inchangé** : sa ligne « Onglets ouverts » reste (carte 511) | périmètre |
| **README** | les deux lignes du tableau des connexions, en français et en anglais : « et vos onglets d'Aujourd'hui, avec leurs adresses et leurs titres et à peu près quand vous les avez utilisés ; fermer un onglet d'Aujourd'hui sur un appareil l'archive sur l'autre » | `AGENTS.md` §5 : un nouvel échange est dans le tableau, dans le même commit que la fonction |

**Ce que les tests ne montrent pas** : le dessin réel des pages (aucune fenêtre ouverte, AGENTS §1) ; le Mac n'a pas de test de rendu d'image, l'iPhone dessine les écrans dans un test qui ne juge pas l'image.

## 28. Ce que la carte 505 a changé (synchronisation automatique, 19 novembre 2026)

**La demande du chef de projet, mot pour mot** : « je suis obligé d'aller sur mon téléphone, d'aller dans les réglages, de faire synchronisation, synchroniser maintenant, ensuite d'aller dans Lucium, d'aller dans synchroniser et de faire fenêtre de synchronisation. Moi je veux que ça soit automatique, que par exemple toutes les 30 secondes, 1 minute, peu importe, il faudrait qu'on puisse définir d'ailleurs le temps, que ça synchronise et que ça soit bidirectionnel, ce qui veut dire que si je supprime quelque chose sur mon Mac, cela supprime sur l'iPhone, et si je la supprime de l'iPhone, cela le supprime sur du Mac. » **Précisions du même jour** : la synchronisation ne tourne que quand Lucium est ouvert **des deux côtés** (voulu) ; sur le même réseau local ; en connexion sécurisée (le TLS mutuel épinglé est gardé en entier) ; **jamais** de cookies, de sessions, de mots de passe ni de connexion automatique aux sites ; intervalle de **1 minute par défaut** (30 s, 1 min, 5 min, 15 min).

| Sujet | Ce que fait la carte | Pourquoi |
|---|---|---|
| **[Q5] remplacé** | décidé par le chef de projet le 19 novembre 2026 : synchronisation automatique. L'historique du choix est gardé au §6.1 et au §18 | la fenêtre manuelle de 10 minutes demandait deux manipulations (Mac puis iPhone) à chaque synchronisation |
| **Quand le Mac écoute** (§6.1) | si et seulement si : interrupteur activé, Lucium déverrouillé, au moins un iPhone appairé (ou un appairage ouvert, 2 minutes) ; une seule fonction décide (`reconcileListening`) | la sécurité reste bornée par des conditions, plus par une échéance : ni verrouillé, ni coupé, ni sans appareil appairé, aucun port |
| **Ce qui est retiré** | `SyncWindow` (devenue `SyncListening`, sans échéance), les demandes IPC `open-window`, `prolong`, `close-window` (refusées par `parseSyncRequest`), `WINDOW_MAX_MS`, le bouton « Ouvrir la synchronisation », « Prolonger », « Fermer », leurs textes ; `status.window` devient `status.listening` | plus rien ne s'ouvre à la main : garder ces boutons aurait laissé croire qu'il faut encore le faire |
| **Ce qui reste, à l'identique** | TLS 1.3 mutuel avec empreinte épinglée, adresses locales seulement avant la poignée de main, refus des empreintes inconnues ou oubliées (`not-paired`), 4 connexions + 1 d'appairage, 10 échecs par minute et par adresse, séance de 10 minutes, appairage : QR à usage unique de 2 minutes avec confirmation sur le Mac et code à comparer sur l'iPhone | la demande ne touche pas à la sécurité du transport |
| **Après la fermeture d'une feuille d'appairage** | sans iPhone appairé la porte se ferme (à l'expiration du secret comme à la fermeture de la feuille, y compris sans que la page demande son état : une minuterie) ; avec un iPhone elle reste ; un appairage refusé ou un « oublier » venu de l'iPhone attend 2 s avant de fermer, pour que la réponse due parte | fermer la porte tout de suite coupait la connexion avant le dernier message |
| **L'iPhone** (§8.1) | séance à intervalle réglable (30 s, 1 min par défaut, 5 min, 15 min) tant que l'application est au premier plan ; recul après 3 échecs de suite (doublé à chaque échec, 15 minutes au plus) ; plancher de 15 s entre deux séances ; **pas d'arrière-plan** (rien promis : §8.1) ; le déclencheur « après un changement local », décrit mais jamais câblé, l'est (30 s de délai) | le chef veut que ça se fasse seul ; la batterie ne doit pas payer un Mac éteint |
| **Les suppressions** (§11.5) | **prouvées dans les deux sens, par des séances réelles** : espace, dossier, favori, onglet épinglé (retiré des épinglés) supprimés sur le Mac sont supprimés sur l'iPhone, et l'inverse, sans revenir aux séances suivantes, avec des suppressions simultanées des deux côtés (`src/main/sync/session-deletions.test.ts`, 14 cas ; en Swift `SyncDeletionTests`). Les 14 cas du Mac échouent tous quand on force la règle « une suppression perd face à une modification » à toujours garder l'entité (mutation vue). **Aucun correctif n'était nécessaire** : la fusion à trois voies et les pierres tombales le faisaient déjà. **Fermer un onglet épinglé n'est pas le supprimer** : il se rendort sur son ancre (c'est la règle du réducteur) ; sa suppression est de le **désépingler** | la demande dit « supprime » : ce qui disparaît des éléments synchronisés doit disparaître de l'autre côté |
| **Cookies, sessions, mots de passe, connexions automatiques** | **aucune catégorie n'en transporte** (vérifié : §10.5 ; les quatre catégories sont des entités classées champ par champ, une liste fermée de réglages, une liste d'onglets annoncés ; un test de classement échoue si un champ n'a pas de classe) ; la nouvelle écoute automatique n'ajoute **aucune** catégorie. Une phrase le dit sur la page des deux appareils (`sync.categories-never`, `sync.limits`) | demande du chef de projet |
| **Vie privée** | tant que la synchronisation est activée et qu'un iPhone est appairé, **un port est ouvert en permanence sur le réseau local** de ce Mac. Un autre appareil du même réseau peut s'y connecter, mais ne peut rien lire ni rien envoyer sans présenter une empreinte appairée ; il reçoit `not-paired` et est compté (§16). Le README le dit (tableau des connexions) | c'est le prix de l'automatisme ; dit en toutes lettres, pas caché |

**Les endroits des §21 à §26 qui parlent de « la fenêtre »** décrivent l'état de ces cartes à leur date : lisez « la porte » (l'écoute), qui, elle, ne ferme plus au bout d'un délai. La liste des onglets ouverts de l'iPhone gardée en mémoire (§26) l'est donc jusqu'au verrouillage, à la fermeture de Lucium, à la décoche de la catégorie, à l'arrêt de la synchronisation ou à l'oubli de l'iPhone ; **fermer la porte ne l'oublie plus rien d'autre que ces cas**.

**Ce que je n'ai pas vu à l'œuvre** : un vrai iPhone sur un vrai réseau (aucune fenêtre ouverte, aucun Lucium lancé pendant cette carte). Les séances sont jouées sous Node entre deux appareils TypeScript, et le client de l'iPhone par les tests de LuciumKit et de l'application sur simulateur ; le contrôle d'engine `smoke-sync.ts` est adapté mais **pas lancé** (`AGENTS.md` §1).

## 29. Ce que la carte 517 a changé (revue de sécurité, points 35 à 42, 19 novembre 2026)

Décisions du chef de projet du 19 novembre 2026, une PR par groupe cohérent (#147, #148 et #150). Le détail du protocole est au §4.7 ; l'état de chaque point, au §11.4 du rapport (`docs/securite-synchronisation.md`).

| N° | Ce qui change | Où |
|---|---|---|
| **36** | l'engagement à l'appairage : l'iPhone s'engage sur son empreinte et un nonce avant que le Mac donne le sien, le code est fait des deux empreintes et des deux nonces, l'attaquant n'a plus qu'un essai à 2⁻³⁰ ; la forme de l'appairage est **remplacée** (rien n'est publié : pas de compatibilité avec les builds d'essai) | §4.1, §4.6, §4.7, §7.3, §7.4 (#147) |
| **37** | les entrées d'archive de source `sync` ne partent pas, des deux côtés | §8.5, §10.1 (#148) |
| **38** | le port d'écoute actuel dans `pair.accept` (obligatoire) et dans le `hello` du Mac (facultatif) ; l'iPhone garde celui-là | §4.1, §7.3 |
| **39** | ce qu'`apply` refuse n'est pas lu comme une suppression : mémoire des refus à côté de la base, la base elle-même ne change pas (deux bases différentes ne fusionnent plus depuis la base) | §11.6 (#148) |
| **40** | un genre ou une liste inconnus sont repris de la base, jamais supprimés (valable pour `todayTab` tant qu'une version ne le connaît pas) | §11.6 (#148) |
| **41** | une minute après le premier refus avant de remplacer l'identité du Mac, y compris pour un fichier illisible | §4.5 (#148) |
| **42** | la phrase « accord des deux côtés » dit ce qui est vrai : deux accords donnés dans l'ordre (Mac, puis iPhone), pas de second accord du Mac | §4.1 pas 10, §4.6 |
| **35** | l'horloge des marques garde le plus grand instant d'une marque venue de l'autre appareil et mesure contre le plus grand de l'heure du jour et de cette valeur : une horloge qui recule ne fait plus reculer les marques, une horloge qui s'était trompée en avance est encore rattrapée (n° 18). **PR #151** : option A de la question posée sur la carte, confirmée le 19 novembre 2026 (la règle écrite sur la carte ne se lisait pas à la lettre) | §9.3 (#151) |

**Ce que le n° 38 ne corrige pas**. Le `hello` ne peut corriger qu'un port qui répond encore : un iPhone dont le port enregistré ne répond plus (le Mac a changé de port après un redémarrage, parce que le sien était pris) n'atteint jamais le `hello`. Le port de `pair.accept` règle le cas où le QR était déjà périmé à l'appairage ; pour l'autre cas, il faut appairer de nouveau, ou que le Mac garde son port (c'est ce qu'il fait : le port tiré est gardé et réutilisé, §6.1). Le choix de la carte (« le port dans `pair.accept`/`hello` ») est appliqué tel quel ; l'autre option du rapport (« le choisir une fois pour toutes à l'appairage ») n'est pas prise.

**Ce que la carte n'a pas pu faire sans appareil** : rien de tout cela n'a tourné sur un iPhone réel ni avec un Electron lancé (`smoke-sync.ts` est mis à jour, pas lancé).
