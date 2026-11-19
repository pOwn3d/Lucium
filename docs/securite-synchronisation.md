# Revue de sécurité de la synchronisation Mac et iPhone

Rapport de la carte 448 (synchro 6/6), écrit le 18 novembre 2026 (première passe) et complété le 19 novembre 2026 (**seconde passe : §11**). Il porte sur le code **déjà fusionné** dans `main` (jusqu'au commit `bb7e8067`) et sur les correctifs de cette carte, puis de la carte 471 (décisions du chef du 18 novembre et points n° 9 à 22 : §8 et §10). La spécification est `docs/synchronisation.md` ; ce rapport dit ce que l'attaque a trouvé, ce qui est corrigé, ce qui reste, et propose la réponse au questionnaire d'exportation du chiffrement.

**Résultat en une phrase.** Aucun défaut ne permet à quelqu'un qui n'est pas appairé de lire ou d'écrire des données : l'appairage, l'épinglage et le filtre d'adresses tiennent, et le faux QR scanné par la personne (n° 9) est fermé par le code à comparer. **Un appareil appairé hostile pouvait faire plus que ne le dit la spécification** (écrire dans le prototype du processus principal, empoisonner l'horloge, faire supprimer des données, bloquer le processus principal quelques secondes) : **les vingt-deux défauts n° 1 à 22 sont corrigés par quatorze PR** (§10 ; le n° 23 est une information acceptée), côté Mac et côté iPhone, chacun avec un test vu échouer sans lui. Les décisions du chef du 18 novembre 2026 (n° 9, 10 et 13) sont appliquées. **Ce qui reste n'est pas un défaut de code** : la relecture du corps de séance de l'iPhone (§6), la conformité du chiffrement (§9, décision du chef) et ce qui ne se vérifie que sur un appareil réel.

**Seconde passe (19 novembre 2026, §11).** Les 22 correctifs de la première passe ont été **rejoués** (chacun retiré du code : son test échoue) et tiennent. Le corps de séance de l'iPhone et les correctifs de la carte 471 ont été relus par trois lecteurs indépendants : **onze défauts de plus**, dont deux de perte de données sans appareil hostile (n° 25) ou par un Mac appairé hostile (n° 33), **sont corrigés par onze PR fusionnées** ; **huit points restent à décider** (§11.4). **Ce n'est donc toujours pas « sans point bloquant »** : voir la conclusion du §11.5.

## 1. Périmètre

Relu :

- **Mac**, `src/main/sync/` en entier : écoute et fenêtre (`listener.ts`, `sync-window.ts`), filtre d'adresses, limiteur, appairage (`pairing-server.ts`, `pairing-secret.ts`, `pairing-proof.ts`, `pairing-code.ts`), certificat, identité et coffre `safeStorage`, fichiers (`sync-store.ts`, `bases.ts`, `mark-store.ts`), trames et messages, séance (`session.ts`, `patch.ts`, `inbound-filter.ts`, `state-view.ts`, `marks.ts`), service (`sync-service.ts`).
- **Partagé** : `src/shared/sidebar-sync.ts` (l'action `sync/apply`), `sync-ipc.ts` et son canal (`src/main/shell/sync-ipc.ts`), `sync-merge.ts`, `sync-canonical.ts`, `sync-snapshot.ts`, `sync-conflicts.ts`, et la page des Réglages (`SyncSettings.tsx`, lue vite).
- **iPhone**, `LuciumKit/Sync/` (adresses, QR, preuves, trames, messages, certificat, canal, connexion, client d'appairage, réglages) et l'application (`SyncNetwork`, `SyncIdentity`, `SyncController`, `QRScanner`, `SyncPairingSheet`, `Info.plist`, `PrivacyInfo.xcprivacy`), plus les pendants Swift de la fusion.

**Pas relu :** le corps de séance de l'iPhone. Il est en cours sur la carte 452 (copie `.worktrees/C452`) et n'est pas fusionné : à `bb7e8067`, `SyncSessionClient` n'a que l'interface `SyncSessionBody` et un corps vide. **À relire quand la carte 452 sera fusionnée** ; en attendant, les défauts du §3 qui touchent « les deux côtés » sont signalés à cette carte.

## 2. Méthode

1. Lecture de la carte, des bilans 443 à 446, de `docs/synchronisation.md` en entier et de `AGENTS.md`.
2. Lecture du code du Mac par moi (travailleur) ; **deux relectures indépendantes** par des agents sans mon avis : une sur le Swift, une sur la fusion et les instantanés hostiles. Je ne leur ai pas donné ma conclusion.
3. **Chaque trouvaille a été vérifiée avant d'être corrigée** : un test qui échoue sur le vrai code (séance réelle sur de vrais sockets, ou test Swift), puis le correctif, puis la **mutation** (je retire le correctif : le test doit échouer). Les trouvailles que je n'ai pas rejouées moi-même sont marquées « relevé par la relecture, non rejoué ».
4. Rien n'a ouvert de fenêtre sur le Mac (`AGENTS.md` §1). Les essais sont des tests Vitest (TLS sur la boucle locale) et `swift test` du paquet ; **aucun simulateur** n'a été démarré.

## 3. Trouvailles

Gravité : **haute** = un appareil appairé hostile casse le processus ou fait perdre des données ; **moyenne** = déni de service, ou défaut de conception ; **basse** = robustesse, ou rien d'exploitable aujourd'hui.

| N° | Gravité | Trouvaille | Preuve | État |
|---|---|---|---|---|
| 1 | haute | **Pollution du prototype du processus principal.** `"kind": "__proto__"` (en *valeur*) dans un `snapshot.part` faisait écrire l'entité suivante dans `Object.prototype` ; `"constructor"` écrivait dans la fonction `Object`. Une propriété de nom libre apparaissait sur tous les objets. Pas de chaîne menant à l'exécution de code montrée. | Test sur la vraie séance : propriété lisible sur `{}` après la séance, avant correctif | **Corrigé**, PR #93 (fusionnée) |
| 2 | haute | **Horloge empoisonnée.** Une pierre tombale ou une marque d'ordre datée de l'an 2286 passait (le filtre des 7 jours ne visait que les entités) et tirait l'horloge des marques du Mac, conservée dans `sync-marks.json` : toutes ses marques suivantes étaient refusées par un iPhone honnête, et la pierre supprimait ce qu'elle nomme. | Test : séance `ok`, `refused: 0`, horloge à `9999999999999` | **Corrigé**, PR #94 (fusionnée) |
| 3 | moyenne | **Un voisin gardait l'unique place d'appairage.** Une connexion TLS avec n'importe quel certificat, puis le silence : la place était tenue 60 s, en boucle, sans connaître le secret. La spécification dit pourtant qu'un voisin ne doit pas pouvoir l'empêcher. | Tests sur du vrai TLS | **Corrigé**, PR #95 (fusionnée) |
| 4 | basse (aujourd'hui) | **Annonce d'onglets ouverts non filtrée.** Le Mac n'envoyait que du `http(s)` mais gardait tout ce qu'il recevait (script, fichier local) pour « Reprendre un onglet » (carte 447), qui ouvre par le chemin ordinaire, lequel accepte `file:`. Rien ne lit encore la liste. | Test de séance | **Corrigé**, PR #96 (fusionnée) |
| 5 | haute | **Une entité refusée était lue comme une suppression.** Un iPhone dont l'horloge avance de plus d'une semaine, après avoir renommé un espace : le Mac **supprimait l'espace et ses onglets épinglés**, les deux appareils annonçaient `ok`. Même chose pour une adresse qui cesse d'être une page web. | Rejoué : deux appareils honnêtes | **Corrigé côté Mac**, PR #97 (fusionnée) ; **le Swift doit faire de même** (carte 452) |
| 6 | basse à moyenne | **iPhone : `SyncEncoding.data(hex:)` arrête l'application** sur un caractère non ASCII (`é`) : un `sync.json` qui en contient un fait planter l'application à chaque lancement. Même fonction : `+f` et `-0` acceptés. | Rejoué : `Fatal error: String index is out of bounds` | **Corrigé**, PR #98 (fusionnée) |
| 7 | basse | **iPhone : `isLocal` lit une chaîne C.** `fd00::1` puis un octet nul puis `.evil.com` est lu comme `fd00::1`. Pas une sortie du réseau local (le système s'arrête au même octet), mais deux lecteurs liraient autre chose. | Test Swift | **Corrigé**, PR #98 |
| 8 | basse | **iPhone : l'appairage laisse la connexion ouverte** quand le Mac répond `bye` au lieu du défi, quand un envoi échoue, ou après un délai. | Test Swift | **Corrigé**, PR #98 |
| 9 | moyenne | **L'iPhone ne demande jamais « s'appairer à quel Mac ? ».** Un faux QR (affiche, message) que la personne scanne dans « Ajouter un Mac » fait épingler le Mac de l'attaquant, puis lancer une séance : espaces, dossiers, favoris et onglets épinglés partent chez lui. La confirmation du §4.1 [Q7] protège le Mac, pas l'iPhone. | Lecture du code (`SyncPairingSheet`, `SyncController`) ; relevé par la relecture, non rejoué | **Corrigé**, PR #111 (décision du chef du 18 nov. : « Code à comparer ») : après la preuve du Mac et avant d'enregistrer, l'iPhone affiche « Appairer avec « nom » ? Code : XXXXXX », la feuille du Mac affiche le même code, rien n'est gardé avant l'accord des deux côtés (spécification §4.6) |
| 10 | moyenne | **Modèle de recherche reçu : `http` accepté, hôte libre.** Un appareil appairé peut, si la catégorie « réglages » est cochée des deux côtés (non cochée par défaut), rediriger toutes les recherches du Mac vers un serveur de son choix. | Lecture de `inbound-filter.ts` | **Corrigé**, PR #107 (décision du chef du 18 nov. : « Moteurs connus seulement »), Mac et iPhone |
| 11 | moyenne | **Application d'un patch en temps quadratique.** `applySyncPatch` cherchait dans la liste pour chaque entité : 40 000 créations bloquaient le processus principal 3,4 s (rejoué ici ; 3,9 s et 7 s pour 20 000 dossiers et 20 000 onglets selon la relecture). L'appareil hostile calcule la même fusion, donc les résumés concordent : il pouvait relancer le gel à chaque séance. | Rejoué : 3,4 s contre 91 ms après correctif | **Corrigé**, PR #99 (fusionnée) |
| 12 | moyenne | **Bornes en octets, pas en valeurs.** Une trame de 30 Mio de tableaux vides imbriqués coûte 8 à 12 s de gel et 1,76 Go de mémoire (la relecture). | Mesure de la relecture, non rejouée ; le calcul (350 000 valeurs au Mio) est de moi | **Corrigé**, PR #100 (fusionnée) : 150 000 valeurs par trame, 2 000 000 par connexion |
| 13 | moyenne | **Supprimer un espace sur l'iPhone supprime, sur le Mac, ses onglets ouverts** (ceux d'« Aujourd'hui », qui ne se synchronisent pas) sans archive, comme une suppression locale mais sans confirmation sur le Mac. Un appareil hostile peut le faire pour tout ce qu'il connaît. | Rejoué | **Corrigé**, PR #109 (décision du chef du 18 nov. : « Archiver avant »), Mac et iPhone |
| 14 | moyenne | **Pierres tombales cumulées sans borne** (198 000 après deux séances) : la séance suivante échoue en `too many tombstones` des deux côtés ; les tombes de genres interdits (`password`…) sont acceptées puis renvoyées. | Relecture, non rejoué | **Corrigé**, PR #112 (genres interdits refusés, 50 000 pierres au plus par côté), Mac et iPhone |
| 15 | moyenne (latent) | **Texte avec un substitut isolé** (`\ud83d`) : le Mac en produit (coupe à 60 ou 1000 unités au milieu d'un émoji) et le Swift ne sait pas le lire (`bad-message`) : la séance échoue tant que la valeur est dans l'état. | Relecture, non rejoué | **Corrigé**, PR #112 (le Mac coupe sans séparer une paire, et en octets pour les onglets ouverts ; refus des textes à substitut isolé ou de plus de 64 Kio en octets) |
| 16 | moyenne (latent) | **Clé de liste `favorites:<profileId>` sans borne ni forme NFC** : le Mac et le Swift peuvent donner deux listes différentes (`divergence`) ; une clé de 510 caractères rend la base illisible. | Relecture, non rejoué | **Corrigé**, PR #112 (le profil doit être un identifiant du Mac), Mac et iPhone |
| 17 | moyenne | **`MarkBook.adopt` efface les marques et tombes des catégories non échangées** : après une séance sans « réglages », leurs marques repartent de l'heure du moment et leurs suppressions peuvent revenir. | Relecture, non rejoué | **Corrigé**, PR #113, Mac et iPhone |
| 18 | basse | **Une erreur d'heure bloque l'horloge des marques dans le futur pour toujours** (pas d'auto-guérison) ; `Hlc.next` dépasse 13 chiffres à `9999999999999`. Le n° 2 corrige l'entrée par le réseau, pas ce cas. | Raisonnement | **Corrigé**, PR #113 (l'horloge repart de l'heure du jour, les marques trop loin sont refaites), Mac et iPhone |
| 19 | basse | **iPhone : aucune durée maximale de séance** (le Mac applique 10 min ; `SyncLimits.sessionMaximum` n'est lu nulle part côté iPhone) : un pair qui envoie un octet par minute bloque « Synchroniser maintenant ». | Lecture, non rejoué | **Corrigé**, PR #114 (`SyncSessionClient.run` borne la séance à 10 minutes ; la coupure est autour du corps de séance) |
| 20 | basse | **JSON : clés dupliquées** (`{"n":1,"n":2}`) : « première gagne » en Swift, « dernière gagne » en JavaScript. Le résumé `result` doit attraper l'écart. | Relevé, non rejoué | **Corrigé**, PR #112 (`hasDuplicateKey` côté Mac, `SyncDuplicateKeys` appelé par `SyncMessageCodec.decode` côté iPhone) |
| 21 | basse | **Le Mac affiche seulement le nom choisi par l'iPhone** dans « Autoriser / Refuser », pas l'adresse source : quelqu'un qui a photographié le QR s'appelle « iPhone de … ». | Lecture | **Corrigé**, PR #111 (la feuille du Mac dit l'adresse d'où vient la demande, avec le code du n° 9) |
| 22 | basse | **Identité remplacée si le trousseau refuse un instant** : `loadOrCreate` écrase l'identité et oublie les appareils appairés. Perte de confort, pas de fuite. | Lecture | **Corrigé côté Mac**, PR #114 (pas de remplacement au premier refus du trousseau) ; l'iPhone ne remplace rien sans « introuvable » : lu, inchangé |
| 23 | information | **iPhone :** un nom `.local` n'est pas revérifié une fois résolu ; en saisie de code l'iPhone présente son certificat à n'importe qui à l'adresse tapée (le secret ne fuit pas : preuve HMAC). | Relevé | Accepté, §5 |

## 4. Ce que l'attaque n'a pas fait tomber

Lu en entier et jugé sain, avec la preuve quand elle existe :

- **Pas d'écoute hors fenêtre** : `listener.ts` n'existe que pendant la fenêtre ; elle se ferme par le délai (horloge sûre), la page, l'interrupteur, le verrou, la sortie ; chaque connexion est coupée avant toute poignée de main si l'adresse source n'est pas locale (BlockList de Node, `::ffff:` compris), avec 5 connexions, 10 s de poignée de main, 10 échecs par minute et par adresse.
- **Épinglage** : TLS 1.3 seul, certificat client obligatoire, comparaison de l'empreinte du certificat par le code (jamais `authorized`) ; un inconnu ne peut parler que d'appairage et seulement fenêtre d'appairage ouverte ; l'identifiant est lié à l'empreinte. Côté iPhone, le bloc de vérification répond « non » par défaut, ne délègue pas au système, et l'empreinte du QR est comparée avant d'envoyer le moindre octet.
- **Appairage** : secret de 128 bits à usage unique, brûlé à la première preuve juste, 120 s, 5 preuves fausses ; HMAC en temps constant sur une transcription qui couvre les deux empreintes et les deux nonces ; deux étiquettes différentes ; confirmation sur le Mac. Un intercepteur qui relaie ne peut pas produire la preuve. Vecteurs communs Swift et TypeScript.
- **Entrées** : longueur lue avant le contenu, 1 Mio par trame, 32 Mio par séance, profondeur 32, `__proto__` en clé (et, depuis la PR #93, en valeur), nombres et NFC, lecture itérative (un million de crochets ne vide pas la pile). Aucun plantage sur 280 000 messages tirés au hasard côté Swift.
- **Rien ne se synchronise de ce qui ne doit pas** : classement de chaque champ testé contre `model.ts`, liste fermée de huit réglages, genres interdits refusés, onglets privés et espaces verrouillés mis de côté (identifiants seulement), aucun cookie ni mot de passe ni verrou ni historique dans un instantané. Les Retouches, scripts et extensions ne partent pas.
- **Secrets** : clé privée scellée par `safeStorage` (jamais en clair sur le disque) ou dans le trousseau de l'iPhone (`AfterFirstUnlockThisDeviceOnly`, non extractible, non synchronisable) ; le secret d'appairage n'est ni écrit ni journalisé ; aucun `print`, `NSLog` ni `os_log` d'empreinte ou de preuve ; fichiers de synchronisation en 0600, écriture atomique, refus des liens symboliques.
- **IPC** : un seul canal, chaque requête relue par `parseSyncRequest` (champs exacts), refusé aux fenêtres privées et pendant le verrou ; `sync/apply` est réservée au processus principal ; la page est du texte React (pas de HTML injecté).
- **Verrouillage** : la séance refuse de démarrer verrouillée, revérifie avant d'écrire, la fenêtre et l'appairage se ferment au verrou, côté Mac et côté iPhone.
- **Info.plist de l'iPhone** : pas de `NSAllowsLocalNetworking`, pas de `NSBonjourServices`, descriptions de la caméra et du réseau local présentes.

## 5. Risques acceptés (à confirmer par le chef)

- **Un appareil appairé est de confiance pour ce qui se synchronise.** Il peut modifier ou supprimer les espaces, dossiers, favoris et onglets épinglés qu'il connaît. La revue a *borné* ce qu'il peut faire de plus (n° 1, 2, 4, 5) mais pas ce principe (§16 de la spécification : « non couvert »).
- **Le réseau local peut gêner** : quelqu'un sur le même Wi-Fi qui occupe les 5 connexions ou refuse les poignées de main gêne la synchronisation tant que la fenêtre est ouverte. Il ne lit rien.
- **Le « réseau local » contient** `10/8`, `172.16/12`, `192.168/16`, `169.254/16`, `fc00::/7`, `fe80::/10` **et `100.64/10`** (VPN maillés, mais aussi le réseau de certains opérateurs). Choix de la spécification.
- **Certificat valable de 1970 à 9999, jamais renouvelé** ; la clé de l'iPhone n'est pas dans la Secure Enclave. Choix de la spécification.
- **Un Mac volé** ne peut pas se connecter à l'iPhone (il n'ouvre jamais de connexion) ; un iPhone volé se coupe en l'oubliant sur le Mac.
- **Le modèle de recherche** (n° 10) : tant que la catégorie « réglages » reste non cochée par défaut, le risque ne touche que ceux qui la cochent. **Correction de la seconde passe** : cette phrase était fausse pour tout ce qui voyage : la séance appliquait ce qu'elle recevait **quelle que soit la catégorie** (n° 24, corrigé par la PR #129) ; elle est vraie depuis.

## 6. Ce qui n'a pas été revu ni vérifié

- ~~Le corps de séance de l'iPhone (carte 452) ; à relire à sa fusion.~~ **Relu à la seconde passe (§11)**, par un lecteur indépendant et par moi pour `SyncExchange.swift`, `SyncMarkKeeper`, `SyncBase`, `SyncJournalFile`, `SyncRestore`, `SyncApply`.
- Rien sur un appareil réel : `Network.framework`, résolution d'un nom `.local`, invite du réseau local, caméra, `safeStorage` dans l'application, pare-feu de macOS. Le Node d'Electron 45.2.1 a été essayé par la carte 444, pas par moi.
- `smoke-sync.ts` n'a pas été lancé (`AGENTS.md` §1) ; les essais de bout en bout du Mac sont ceux des tests Vitest.
- La mesure du n° 12 (mémoire, gel) est celle de la relecture ; je ne l'ai pas rejouée. Celle du n° 11 l'a été.
- La page des Réglages et `sync-conflicts` (le journal n'est pas encore branché au Mac) ont été lus vite.
- Pas de revue de l'interface (textes, accessibilité) ni des captures.
- **Aucune nouvelle dépendance n'a été ajoutée.**

## 7. Pour les cartes voisines

- **Carte 452 (corps de séance iPhone, fusionné après ce rapport)** : tout ce que ce paragraphe demandait au Swift est fait par les PR de la carte 471 (§10), avec les mêmes vecteurs que le Mac : marques du futur (PR #94 côté Mac, déjà dans le Swift de la carte 452), version de la base à la place d'une entité refusée (PR #97, idem), borne de valeurs JSON (PR #100, idem), clés écrites deux fois, profils, pierres tombales, marques des catégories non échangées, horloge qui se rétablit, onglets ouverts d'un espace supprimé, moteurs de recherche, durée de séance. **Le corps de séance de l'iPhone n'a pas été relu en entier** (§6).
- **Carte 447 (reprise d'un onglet)** : la liste reçue est filtrée en `http(s)` (PR #96) ; ne rien ouvrir d'autre que par ce chemin.

## 8. Décisions du chef, et ce qui en est fait

Décisions du 18 novembre 2026, toutes appliquées :

1. **N° 9, « Code à comparer »** : l'iPhone affiche « Appairer avec « nom » ? Code : XXXXXX » (six caractères tirés des deux empreintes, les mêmes sur la feuille « Autoriser / Refuser » du Mac) ; l'appairage ne s'enregistre qu'après l'accord des deux côtés (PR #111, spécification §4.6). Le n° 21 (adresse source sur la feuille) est dans la même PR.
2. **N° 10, « Moteurs connus seulement »** : seuls les moteurs que Lucium propose, en `https`, passent par la synchronisation ; un moteur personnalisé reste sur son appareil dans les deux sens (PR #107).
3. **N° 13, « Archiver avant »** : les onglets ouverts d'un espace supprimé à distance vont dans l'archive (source `sync`) avant la suppression (PR #109).

Les n° 11 et 12 avaient été corrigés par la première passe (PR #99 et #100) ; les n° 14 à 20 et 22 sont corrigés par les PR #112, #113 et #114.

**Écarts de méthode de la carte 471** : (1) les PR #111, #112 et #113 ont reçu, après leur ouverture, des fusions de `main` et des commits de correction de tests ou de types (pas de push forcé) ; (2) un problème hors périmètre mais bloquant a été corrigé à part, PR #121 : sous Windows, le service tirait parfois un port que le système réserve (`EACCES`) et l'ouverture de la porte échouait (les tests de CI échouaient au hasard) ; (3) ce document et `docs/synchronisation.md` sont mis à jour par cette seule PR, pour ne pas faire chevaucher les tableaux de six PR.

## 9. Conformité du chiffrement : réponse proposée au questionnaire d'App Store Connect

**Décision du chef de projet, 18 novembre 2026 : « Exemptée, chiffrement d'iOS ».** Les réponses 1 à 4 de §9.3 sont retenues (chiffrement utilisé : oui ; exemption du chiffrement du système : oui ; algorithmes propriétaires ou en plus du système : non) et `ITSAppUsesNonExemptEncryption = false` est dans `ios/Lucium/Info.plist` (carte 488 ; `docs/synchronisation.md` §15). **Rien n'a été répondu chez Apple** : la clé évite la question à l'envoi ; les points de §9.4 restent à vérifier. Le texte ci-dessous est la proposition d'origine de la revue.

### 9.1 Ce que le code fait (vérifié dans le dépôt)

| Brique | iPhone | Mac (hors App Store) |
|---|---|---|
| Transport de la synchronisation | TLS 1.3 de `Network.framework` (le système) | TLS 1.3 de Node d'Electron (BoringSSL, embarqué) |
| Authentification de l'appairage | HMAC-SHA-256 et SHA-256 de CryptoKit | HMAC-SHA-256 et SHA-256 de `node:crypto` |
| Clé et certificat | ECDSA P-256 : `SecKeyCreateRandomKey`, `SecKeyCreateSignature` ; DER écrit par le projet | ECDSA P-256 de `node:crypto` ; DER écrit par le projet |
| Navigation | HTTPS de `WKWebView` et `URLSession` (inchangé) | HTTPS de Chromium (inchangé) |
| **Ce que le projet écrit lui-même** | **aucun algorithme de chiffrement, aucun mode, aucune suite** : le code Swift n'appelle ni AES, ni ChaChaPoly, ni `SealedBox`, ni `CCCrypt` (cherché) ; `SymmetricKey` n'y sert que de clé de HMAC | idem |

Le projet a bien écrit **un protocole d'authentification** (la transcription du HMAC, `docs/synchronisation.md` §4.4) mais **pas une primitive** : tout ce qu'il appelle est normalisé (TLS 1.3 : RFC 8446 ; HMAC : FIPS 198-1 ; SHA-256 : FIPS 180-4 ; ECDSA P-256 : FIPS 186-4).

### 9.2 Ce que disent les sources lues

| Source | Ce qui a été lu | Fiabilité |
|---|---|---|
| Apple, aide d'App Store Connect, « Overview of export compliance » | Il faut répondre à des questions sur l'usage du chiffrement. Les apps qui n'utilisent que le chiffrement du système sont dans un cas « à déterminer ». Tableau : « Your app uses encryption limited to that within the Apple operating system » donne « No documentation required in App Store Connect ». La France est contrôlée à part : « French encryption declaration form is only required if you're distributing your app on the App Store in France ». | **Résumé de la page, pas le texte exact** : à vérifier dans App Store Connect |
| Apple, « Complying with Encryption Export Regulations » (documentation) | **Corps illisible** (titre seul) | **À vérifier** |
| Apple, forums de développeurs qui citent la documentation | Le chiffrement du système (HTTPS par `URLSession`) est en général exempté ; un algorithme standard utilisé *à la place de ou en plus de* celui du système, ou propriétaire, demande une documentation ; un exemptée peut encore demander un rapport annuel d'auto-classification aux États-Unis. | **Faible** (avis de développeurs) : à vérifier |
| BIS (États-Unis), pages « Mass market » et « Encryption items not subject to the EAR » | Un logiciel gratuit ou open source rendu public n'est pas soumis à l'EAR ; un logiciel grand public peut s'auto-classer 5D992.c, avec un rapport d'auto-classification. | Lu |
| 15 CFR 740.17 et 742.15 (texte, via Cornell LII) | Rapport d'auto-classification à recevoir **avant le 1er février** de l'année suivante (`crypt-supp8@bis.doc.gov`) pour le « mass market » exporté ; la notification du code source public (`crypt@bis.doc.gov` et `enc@nsa.gov`) n'est exigée que pour un code qui fournit de la **« non-standard cryptography »**. | Lu (texte en vigueur à vérifier sur eCFR, que le lecteur n'a pas pu ouvrir) |
| France, décret 2007-663 (Légifrance) | Les opérations de fourniture, d'importation, de transfert et d'exportation de moyens de cryptologie qui n'assurent pas *exclusivement* de l'authentification ou du contrôle d'intégrité sont soumises à déclaration préalable (art. 3) ; l'annexe 1 en dispense certaines catégories. | Articles lus ; **annexes non lues**, pages de l'ANSSI **vides** : à vérifier |

### 9.3 Réponse proposée

Dans l'ordre où App Store Connect pose les questions (ordre et formulation **à vérifier à l'écran**, je ne les ai pas lus) :

1. **« L'app utilise-t-elle le chiffrement ? »** Oui. Elle l'utilisait déjà (HTTPS) ; la synchronisation y ajoute une connexion chiffrée vers un autre appareil.
2. **« Exemption de la catégorie 5, partie 2 ? »** Oui, au titre du chiffrement limité à celui du système d'exploitation : tout passe par `Network.framework`, CryptoKit, Security et WebKit ; le projet n'implémente aucun algorithme. La page d'Apple ne limite pas ce cas aux serveurs : il est lu comme couvrant une connexion vers un autre appareil de la personne. **C'est le point que seul Apple, ou le mainteneur, peut confirmer.**
3. **« Algorithmes propriétaires ou non reconnus par un organisme de normalisation ? »** Non : toutes les primitives sont normalisées. *Réserve :* le protocole d'appairage (HMAC sur une transcription) est écrit par le projet ; c'est un protocole d'authentification fait de primitives normalisées, pas un algorithme.
4. **« Algorithmes standard *à la place de ou en plus de* ceux du système ? »** Non : aucun code de chiffrement n'est embarqué dans la build iOS.
5. **« Disponible en France ? »** À décider (choix de distribution, §10). Si l'app est dans l'exemption du système, Apple ne demande pas de déclaration française d'après la page lue (résumé).

**Clé `ITSAppUsesNonExemptEncryption`.** Elle était absente (retirée par la carte 445). **Elle est remise à `false` (carte 488, décision du chef du 18 novembre 2026)** ; la garde Vitest (`src/shared/ios-store-listing.test.ts`) exige désormais `false` et refuse une API de chiffrement ou une bibliothèque qui n'est pas celle du système. La preuve de la réponse d'Apple n'existe pas : la décision est celle du chef.

**Le Mac** n'est pas distribué par l'App Store : les questions d'Apple ne s'y appliquent pas. Il embarque déjà BoringSSL (Chromium) pour HTTPS ; la synchronisation n'ajoute **aucune primitive nouvelle**, seulement un usage de plus de TLS et de HMAC. Le code est public sous GPL-3.0-or-later : d'après la page de BIS lue, du code source public n'est pas soumis à l'EAR, et la notification de l'article 742.15(b)(2) ne vise que la « non-standard cryptography ». **À confirmer par le mainteneur** (pays d'établissement, éventuel rapport annuel pour le binaire de l'App Store).

### 9.4 Ce qui reste à vérifier avant d'envoyer une build

1. Les textes exacts et l'ordre des questions d'App Store Connect, et la réponse « exemption du système » (Apple n'a pas été interrogé).
2. Le corps de la page « Complying with Encryption Export Regulations » (illisible ici).
3. Si un **rapport annuel d'auto-classification** (BIS, 1er février) reste dû pour le binaire de l'App Store même exempté.
4. L'annexe 1 du décret 2007-663 et les pages de l'ANSSI : l'app est-elle dispensée de déclaration en France, et la distribution en France exige-t-elle quelque chose d'Apple.
5. Si le protocole d'appairage doit être déclaré comme « propriétaire » (§9.3, réserve de la question 3).

## 10. Liste des PR

**Carte 448 (première passe)**

| PR | Sujet | État |
|---|---|---|
| #93 | refuser un genre ou un identifiant qui nomme un membre de `Object.prototype` | fusionnée |
| #94 | refuser une pierre tombale ou une marque d'ordre à plus d'une semaine dans le futur | fusionnée |
| #95 | une connexion muette ne garde plus l'unique place d'appairage | fusionnée |
| #96 | ne garder que des pages web parmi les onglets ouverts annoncés | fusionnée |
| #97 | ne pas lire comme une suppression une entité qui ne peut pas être envoyée maintenant | fusionnée |
| #98 | iPhone : hexadécimal non ASCII, octet nul dans un hôte, connexion d'appairage non fermée | fusionnée |
| #99 | appliquer un patch en temps linéaire | fusionnée |
| #100 | borner les valeurs d'un message, pas seulement ses octets | fusionnée |

**Carte 471 (décisions du chef et correctifs sans décision), Mac et iPhone**

| PR | Sujet | État |
|---|---|---|
| #107 | n° 10 : ne synchroniser que les moteurs de recherche que Lucium propose | fusionnée |
| #109 | n° 13 : les onglets ouverts d'un espace supprimé à distance vont dans l'archive | fusionnée |
| #111 | n° 9 et 21 : code à comparer à l'appairage, adresse source sur la feuille, enregistrement après l'accord des deux côtés | fusionnée |
| #112 | n° 14, 15, 16 et 20 : pierres tombales, substituts isolés et octets, profil, clés écrites deux fois | fusionnée |
| #113 | n° 17 et 18 : marques des catégories non échangées, horloge qui se rétablit | fusionnée |
| #114 | n° 19 et 22 : durée de séance de l'iPhone, identité non remplacée au premier refus du trousseau | fusionnée |
| #121 | hors périmètre, bloquait la CI : un autre port quand le système refuse celui qui est tiré (Windows) | fusionnée |

Chacune a un test qui échoue sans le correctif (mutation vue) ; la méthode, les mutations et ce qui n'a pas été essayé sont dans le compte rendu de la carte. Un seul écart de méthode de la première passe : la branche de la PR #97 a été amendée et poussée de force (`--force-with-lease`) quelques minutes après son premier envoi, avant l'ouverture de la PR, ce que `AGENTS.md` §7 déconseille ; rien d'autre n'était sur cette branche.

## 11. Seconde passe (19 novembre 2026)

La carte 448 est restée ouverte après la première passe : le corps de séance de l'iPhone (carte 452), les correctifs de sécurité de la carte 471 (« code à comparer », moteurs connus, archive avant suppression, bornes, horloge) et la reprise d'un onglet des deux côtés (cartes 447 et 490, puis 491) ont été fusionnés depuis. Cette passe les attaque, et vérifie que chaque trouvaille de la première passe est **vraiment** fermée.

### 11.1 Méthode

1. Lecture de la carte, de ses commentaires, des bilans des cartes 452, 471, 447 et 490, de ce rapport et de `docs/synchronisation.md`.
2. **Trois relectures indépendantes**, en lecture seule, sans mon avis ni mes conclusions : (a) le corps de séance de l'iPhone et ses jumeaux du Mac, (b) les correctifs de la carte 471 (contournement, régression, divergence Mac/iPhone), (c) la reprise d'onglet des deux côtés (schémas, IPC, verrou, affichage). Elles pouvaient lancer des tests Vitest et `swift test` jetés (dans un dossier à part), ni fenêtre, ni simulateur, ni Electron.
3. **Rejouer les preuves de la première passe** : pour chaque PR de la première passe et de la carte 471, je retire le correctif du code (`git revert` du code seul, ou mutation ciblée d'une ligne) et je lance les tests de la synchronisation : ils doivent échouer.
4. **Chaque trouvaille d'une relecture a été rejouée par moi avant d'être corrigée** : un test qui échoue sur le vrai code, le correctif, puis la mutation (je retire le correctif, le test échoue). Ce qui n'a pas été rejoué est dit.
5. Une PR par défaut, squash, aucun push forcé sauf un (voir §11.6). Aucune fenêtre ouverte, aucun simulateur.

### 11.2 Les trouvailles de la première passe sont-elles fermées ? Oui

Rejoué sur `main` à `949a6f68` (puis `07d8e9e6`) : Vitest des dossiers de la synchronisation 1 521 tests verts, `swift test` 652 tests verts. Pour chaque correctif, retiré du code :

| Trouvailles | PR | Retiré, les tests échouent |
|---|---|---|
| 1 pollution de prototype | #93 | 3 tests (messages, séance, instantané) |
| 2 horloge empoisonnée | #94 | 3 tests (filtre, séance, vecteurs communs), pour les pierres et pour les listes |
| 3 place d'appairage | #95 | 1 test chacun pour la grâce et pour la demande envoyée |
| 4 onglets ouverts | #96 | 1 test pour le filtre, 1 pour la borne des identifiants |
| 5 refus lu comme suppression | #97 | 5 tests |
| 6, 7, 8 Swift | #98 | sans le correctif : `Fatal error: String index is out of bounds` et l'adresse `fd00::1\0…` repasse |
| 11 patch quadratique | #99 | équivalence au lent + **97 ms pour 40 000 créations et un ordre de 40 000, 17 ms pour 40 000 suppressions** (rejoué) |
| 12 valeurs par trame | #100 | 1 test pour la borne de trame, 1 pour celle de connexion |
| 10 moteurs connus | #107 | 14 tests (filtre) et 1 test (moteur personnalisé gardé) |
| 13 archive avant | #109 | 8 tests |
| 9 + 21 code à comparer | #111 | 2 tests de canal, 4 fichiers de test (dont le module du code) |
| 14, 15, 16, 20 | #112 | 23 tests |
| 17, 18 | #113 | 7 tests |
| 19, 22 | #114 | 3 tests |
| port de repli | #121 | 2 tests |

Aucune de ces trouvailles n'est rouverte. **Mais** trois d'entre elles avaient un trou voisin (§11.3 n° 25, 35, 37) et le n° 9 a une limite (n° 36).

### 11.3 Nouvelles trouvailles (n° 24 à 34), toutes corrigées

| N° | Gravité | Trouvaille | Preuve | État |
|---|---|---|---|---|
| 24 | **moyenne à haute** | **Une catégorie non cochée est appliquée quand même.** Rien ne filtrait par catégorie ce que la séance **recevait** : un appareil appairé qui envoie ses réglages, son archive ou ses espaces alors que la catégorie n'est pas commune les fait écrire. Rejoué sur le Mac (`httpsUpgrade`, `sendGpc` et une entrée d'archive changés) et sur l'iPhone (`httpsUpgrade`, `stripTrackingParams`, `protectionBaseline`, archive) : la phrase du §5, « le risque ne touche que ceux qui cochent « réglages » », était fausse. Trouvé par deux lecteurs (Mac et iPhone). | Test qui échoue sans le correctif, des deux côtés | **Corrigé**, PR #129 (le reçu est coupé aux genres des catégories communes avant la fusion ; un appareil qui en envoie plus finit en `divergence`, rien n'est écrit) |
| 25 | **moyenne** (perte de données sans appareil hostile) | **Les marques d'un espace mis de côté sont oubliées.** Un espace verrouillé n'est pas dans l'instantané fusionné ; `MarkBook.adopt` ne gardait que les marques de ce qui y était : au déverrouillage, ce que l'autre appareil avait changé entre-temps perdait contre l'ancienne valeur, sur les deux appareils, sans erreur (rejoué : un dossier renommé sur l'iPhone pendant que son espace était verrouillé sur le Mac revient à son ancien nom partout). Le n° 17 laissait ce trou. Trouvé par deux lecteurs. | Test qui échoue sans le correctif, des deux côtés | **Corrigé**, PR #130 |
| 26 | moyenne | **« Sur l'iPhone » : la ligne cliquée n'est pas toujours celle qui s'ouvre.** Une ligne était nommée `<iPhone>:<identifiant d'onglet>` et le clic cherchait l'adresse par ce nom : deux lignes de même identifiant (`good.example` et `evil.example`, même titre) → le clic sur celle qu'on lit ouvre l'autre ; et une séance qui met une autre adresse sous le même identifiant pendant que la barre est ouverte → le clic ouvre la nouvelle page. L'hôte lu n'est plus l'hôte ouvert. Rejoué sur le vrai service. | Deux tests de service | **Corrigé**, PR #126 (le nom porte une empreinte de l'adresse) |
| 27 | basse | Le Mac **coupait** à 4096 octets l'adresse d'un onglet ouvert annoncé (une autre page : jeton ou paramètre perdu) ; l'iPhone écarte et la spécification disait « laissée de côté ». | Test (adresse à la borne, +1 octet, caractères à 2 octets) | **Corrigé**, PR #125 (fusionnée) |
| 28 | basse à moyenne | **iPhone : l'hôte d'un nom international est écrit en Unicode** (`https://аррӏе.com/` lisible comme un site connu, alors que le système charge `xn--80ak6aa92e.com` ; le Mac écrit le nom ASCII). La fonction sert à toutes les lignes (onglets, barre, archive, téléchargements). Rejoué avec `URLComponents` contre `URL`. | Vecteurs communs (adresses et reprise) : le Mac passe, l'iPhone échoue sans le correctif | **Corrigé**, PR #127 |
| 29 | basse | Deux onglets annoncés de même identifiant donnent deux lignes de même nom (SwiftUI ne définit pas ce qu'il en fait ; non rejoué, pas de simulateur). | Vecteur commun | **Corrigé**, PR #128 (une ligne par identifiant) |
| 30 | moyenne | **Le titre d'un onglet ouvert pouvait porter un substitut isolé** (une page fixe son titre) : l'iPhone refuse le message entier, la séance échoue tant que l'onglet est ouvert et que « Onglets ouverts » est cochée. Que Chromium laisse passer un tel titre jusqu'à l'état n'a pas été essayé (pas d'Electron). | Test sur `openTabsOf` | **Corrigé**, PR #131 |
| 31 | basse | `holdsUnsendableText` empilait une liste avec `push(...liste)` : `RangeError` à partir d'environ 125 000 éléments (la trame en permet 150 000) ; la séance finit en `internal`, pas de plantage. | Test (149 000 valeurs) | **Corrigé**, PR #132 |
| 32 | **haute** (iPhone seulement) | **`SyncApply` est quadratique, voire cubique, sur le fil principal** (le Mac l'a corrigé en #99, pas le Swift) : build de test, 10 000 créations + un ordre : **13 s** ; une chaîne de 1 500 dossiers : **35 s** ; 12 000 listes à ordonner : **34 s**. Un Mac appairé hostile calcule la même fusion, donc les résumés concordent. | Équivalence à l'ancienne version (copiée comme oracle) sur 400 patchs au hasard, et trois cas de taille | **Corrigé**, PR #133 |
| 33 | **haute** (iPhone seulement) | **L'état peut dépasser ce que l'iPhone sait relire.** L'iPhone garde les champs qu'il ne connaît pas (§11.6) et n'a pas les plafonds du Mac : 28,8 Mio de champs inconnus à chaque séance (une séance en porte 32) donnent 28,8, 57,6 puis 86,5 Mio de `state.json`, au-delà des 64 Mio de relecture : au lancement suivant le fichier est mis de côté (`.corrupt-…`, trois copies) et l'application repart de zéro. Rejoué sur l'écriture et la relecture ; la mémoire du décodage n'a pas été mesurée. | Test de séance (la fusion n'est pas adoptée) | **Corrigé**, PR #135 (au-delà de 32 Mio, rien n'est écrit, la séance finit en `too-large`) |
| 34 | moyenne à basse | `SyncChannel` gardait le type de **chaque** message et les règles d'ordre le parcouraient : 30 000 petits `open-tabs` en 19,5 s (build de test), jusqu'à la coupure à dix minutes. | Test de durée | **Corrigé**, PR #134 |

### 11.4 Points laissés à décider (n° 35 à 42), et ce qu'en a fait la carte 517

| N° | Gravité | Point | Pourquoi je ne l'ai pas corrigé | Recommandation | État (carte 517, 19 novembre 2026) |
|---|---|---|---|---|---|
| 35 | moyenne | **Une horloge qui revient en arrière de plus de 7 jours fait reculer les marques** (`Hlc.next` repart de l'heure, `update` refait les marques « trop loin »). C'est la contrepartie du n° 18 : on ne sait pas dire si l'**ancienne** horloge ou la **nouvelle** est fausse. Rejoué : le dernier renommage du Mac, daté d'une horloge à −30 jours, perd contre un plus ancien de l'iPhone ; le Swift fait de même (lu). | Choix de conception, pas un oubli. | Garder : une horloge à −7 jours ou plus est rare et le n° 18 l'est davantage ; ou ne refaire les marques que si l'**heure du jour** est plus loin que la dernière marque de plus de 7 jours (et pas l'inverse) | **Corrigé selon la recommandation A de la question posée sur la carte (à confirmer par le chef de projet avant la fusion)**, PR #151 : la règle de la carte (« ne refaire les marques que si l'heure du jour est en avance de plus de 7 jours sur la dernière marque ») ne se lit pas à la lettre (elle referait toutes les marques après une semaine sans geste) ; l'horloge garde le plus grand instant d'une marque venue de l'autre appareil et mesure contre lui, §9.3 de la spécification. |
| 36 | moyenne | **Le code à comparer (30 bits) tient moins que dit.** La carte 471 écrivait « suffisant contre un faux Mac qui ne peut pas essayer plus de quelques certificats (raisonnement, non mesuré) ». Mesuré (simulation, Node) : un faux Mac et un faux iPhone qui choisissent chacun leur certificat trouvent une collision `code(A1, iPhone) = code(Mac, A2)` en 80 000 empreintes par côté (0,3 s) ; si l'empreinte de l'iPhone n'est connue qu'à la connexion, 2³⁰ essais, environ 7 min d'un cœur (une empreinte se fait varier sans refaire de clé). **Précondition** : l'attaquant a photographié le vrai QR (secret et empreinte du Mac), la personne scanne le sien **pendant** que le vrai Mac attend. Sans fenêtre d'appairage ouverte sur le vrai Mac, il n'y a rien à comparer et seule la lecture de la phrase protège. | Aucun code de six caractères ne résiste à cela sans engagement (commit-reveal) ; c'est un changement de protocole. | **Accepter et le dire** : le code protège du faux QR seul, pas d'un attaquant qui a vu le vrai QR et relaie. Pour aller plus loin : un engagement de l'empreinte de l'iPhone avant que le Mac ne montre la sienne | **Corrigé**, PR #147 : engagement de l'iPhone avant que le Mac montre sa moitié, code fait des deux empreintes et de deux nonces, un essai à 2⁻³⁰ (§4.7 de `docs/synchronisation.md`). |
| 37 | basse à moyenne | **Les onglets ouverts d'un espace supprimé repartent par l'archive** : les entrées d'archive de source `sync` (n° 13) portent adresse et titre et partent avec la catégorie « archive », sans le consentement « onglets ouverts ». Rejoué. Un appareil hostile récupère ainsi les onglets ouverts d'un espace qu'il choisit de supprimer — mais il reçoit déjà toute l'archive si la catégorie est cochée. | Question de ce que la personne attend de « archive ». | Ne pas envoyer les entrées `source: sync` (elles restent là où l'espace a été supprimé), des deux côtés, avec un vecteur | **Corrigé**, PR #148 : les entrées de source `sync` ne partent plus, des deux côtés, avec un vecteur. |
| 38 | basse à moyenne | **Le port de repli (#121) n'est jamais répercuté** aux iPhone déjà appairés : `hello` ne porte que `hosts`, l'iPhone garde le port du QR. Après un repli (`EADDRINUSE` ou `EACCES`), il faut ré-appairer. | Changement de protocole. | Mettre le port dans `pair.accept`/`hello` ou le choisir une fois pour toutes à l'appairage | **Corrigé**, PR #150 : le port d'écoute actuel dans `pair.accept` (obligatoire) et dans le `hello` du Mac ; limite dite au §29 de la spécification (un `hello` ne corrige pas un port qui ne répond plus). |
| 39 | basse | **Une entité que `SyncApply` refuse reste dans la base**, puis devient une suppression poussée au Mac à la séance suivante (rejoué : un dossier au nom blanc). Un Mac honnête ne l'envoie pas ; une version plus récente qui permettrait plus le pourrait. | Peu probable sans version qui diffère. | Ne pas adopter dans la base ce que `apply` rejette | **Corrigé autrement que dit**, PR #148 : l'iPhone mémorise ce qu'`apply` refuse à côté de sa base et le reprend de la base ; la base elle-même n'est pas modifiée (§11.6 de la spécification : deux bases différentes ne fusionnent plus depuis la base). |
| 40 | moyenne (écart à la spécification) | **Un genre inconnu traverse une fois puis est supprimé à la deuxième séance** (rejoué : `widget`) : le Swift ne l'envoie pas, la base le garde, la fusion le prend pour supprimé ; la spécification (§11.6) dit qu'on ne supprime jamais ce qu'on ne comprend pas. Même `snapshotOf` côté Mac. Seul un appareil plus récent en produit. | Il n'y en a pas encore. | À corriger avant la première version qui ajoute un genre | **Corrigé**, PR #148 : un genre ou une liste inconnus sont repris de la base, des deux côtés, avec un vecteur. |
| 41 | basse | L'identité est remplacée au **second** refus du trousseau, sans délai ; un certificat que `X509Certificate` ne lit plus (après une mise à jour d'Electron) est remplacé tout de suite. | Choix de la carte 471. | Ajouter un délai (une minute) ou demander à la personne | **Corrigé**, PR #148 : une minute après le premier refus avant de remplacer l'identité, y compris pour un fichier illisible. |
| 42 | basse | Le Mac enregistre l'iPhone au `bye` de celui-ci, **sans second accord de sa personne** : « Autoriser » est cliqué avant que le code de l'iPhone existe. La phrase « accord des deux côtés » (§4.6) est vraie de l'iPhone, pas du Mac. | Le Mac a déjà montré le code et l'adresse avant le clic. | Corriger la phrase | **Corrigé**, PR #150 : la phrase dit ce qui est vrai (deux accords donnés dans l'ordre, Mac puis iPhone, sans second accord du Mac), §4.1 et §4.6. |

Et ce qui est **noté, borné, non corrigé** : l'archive de la personne est évincée par les entrées `sync` d'un espace supprimé (500 au plus, bornées par les onglets du Mac) ; 50 000 pierres tombales à +6 jours se propagent (bruit, 30 jours) ; `hello.now` hostile empêche l'envoi de tout ce qui est local (rien d'écrit) ; un `state.json` corrompu à `lastActiveAt: 1e20` arrête l'application (`Int(…)`) ; deux clés JSON équivalentes en Unicode (NFC contre NFD) sont des doublons pour le Swift et pas pour le JavaScript (aucune clé de snapshot exploitable : NFC est imposée) ; le fichier de marques n'est pas validé à la lecture (un fichier corrompu à la main) ; une séance qui s'achève juste après le verrouillage ou l'oubli du Mac peut repeupler la liste « Sur le Mac » ; l'hôte d'« Sur l'iPhone » long est coupé par la fin dans la barre (le vrai domaine peut être caché), l'espace où s'ouvre la page est choisi par l'iPhone sans pastille sur le Mac, et l'adresse brute (retour à la ligne, tabulation, identifiants) est gardée telle quelle jusqu'à l'ouverture, où Chromium la normalise (le Swift la refuse : au pire une `divergence`).

### 11.5 Ce qui n'a pas été revu, et conclusion

**Pas revu ou pas prouvé** : tout ce qui demande un appareil, un simulateur ou Electron (invite du réseau local, caméra, Network.framework, `safeStorage`, le comportement de SwiftUI avec des identifiants en double, un titre de page à substitut isolé dans Chromium, la mémoire du décodage de dizaines de Mio, le watchdog d'iOS) ; `smoke-sync.ts` n'a pas été lancé ; la cible de l'application iOS n'a pas été compilée (les changements qui la touchent tiennent en une ligne dans `BrowserModel+Sync.swift`) ; la page des Réglages, `SyncConflictScreen` et les textes n'ont pas été relus ; la liste « Sur l'iPhone » a été relue **à la fusion de la carte 491** (PR #124) : elle garde la liste en mémoire après la fenêtre, l'oublie au verrou, à la décoche, à l'arrêt, avec l'appareil et à la sortie (testé) ; je n'y ai rien trouvé de plus (la ligne d'aide n'est qu'un texte, un clic dessus n'ouvre rien) ; le n° 26 compte davantage depuis qu'elle dure. La conformité du chiffrement (§9) n'a pas été rouverte.

**Conclusion : toujours pas « sans point bloquant »**, mais plus pour la même raison. Les onze défauts de ce paragraphe (n° 24 à 34), dont trois de gravité haute ou moyenne à haute, **sont corrigés et fusionnés** (§11.7) ; aucun ne donnait accès à quelqu'un qui n'est pas appairé. Il reste **à décider** les n° 35, 36, 37 et 38 (une horloge reculée, la force du code, l'archive, le port) et à **corriger avant le prochain genre** le n° 40 ; les autres sont de peu de gravité. Aucun point ne justifie, seul, de retenir la première version TestFlight, **mais le n° 24 et le n° 33 le justifiaient tant qu'ils étaient ouverts** : leurs PR (#129, #135) sont fusionnées. Et la synchronisation n'a toujours **jamais tourné sur un appareil réel** (premier paragraphe de ce §11.5) : un essai sur un iPhone et un Mac avant de l'inclure est la condition que cette revue ne peut pas lever.

### 11.6 Écarts de méthode de cette passe

- **Un premier push forcé** : la branche de la PR #131 a reçu un premier commit qui utilisait `String.prototype.toWellFormed` (absent de la bibliothèque TypeScript du projet : le contrôle de types échouait) ; je l'ai amendé et poussé de force quelques minutes après l'ouverture de la PR (`AGENTS.md` §7 le déconseille ; dit dans la PR). Rien d'autre n'était sur cette branche.
- **Un second push forcé**, sur la branche de ce rapport, une minute après son premier envoi et avant l'ouverture de la PR (j'ai amendé une phrase) : même règle enfreinte, par inattention ; plus de push forcé ensuite.
- Mes mutations ont d'abord été lancées dans la copie `.worktrees/C448b` que lisaient aussi les relecteurs, pendant quelques secondes ; je suis passé à une copie jetable (`C448b-mut`) dès que je l'ai vu. Je n'ai pas vu de trace dans leurs rapports.
- La PR #127 (fusionnée) change `AddressResolver.host(of:)`, qui sert partout sur l'iPhone ; la cible de l'application n'a pas été jouée sur simulateur.

### 11.7 Liste des PR de la seconde passe

| PR | Sujet | État |
|---|---|---|
| #125 | n° 27 : écarter l'onglet ouvert à l'adresse trop longue, au lieu de la couper | fusionnée |
| #126 | n° 26 : nommer une ligne de « Sur l'iPhone » par l'adresse annoncée | fusionnée |
| #127 | n° 28 : l'hôte ASCII d'une adresse sur l'iPhone | fusionnée |
| #128 | n° 29 : une ligne par identifiant | fusionnée |
| #129 | n° 24 : une catégorie non commune n'est pas appliquée | fusionnée |
| #130 | n° 25 : garder les marques des espaces mis de côté | fusionnée |
| #131 | n° 30 : le titre d'un onglet ouvert écrit comme un texte | fusionnée |
| #132 | n° 31 : ne pas empiler une liste sur la pile d'appel | fusionnée |
| #133 | n° 32 : appliquer un patch en temps linéaire sur l'iPhone | fusionnée |
| #134 | n° 34 : retenir les genres de messages, pas chaque message | fusionnée |
| #135 | n° 33 : ne pas écrire un état trop gros pour être relu | fusionnée |

Chacune a un test qui échoue sans le correctif (vu), et la mutation a été faite côté Mac comme côté Swift. Rebasées sur `main` après les fusions des cartes voisines (#137 à #143 : synchro automatique, onglets d'Aujourd'hui) : la règle des espaces mis de côté (n° 25) couvre aussi la liste `today:<espace>` côté Mac ; **côté iPhone le genre `todayTab` n'est pas encore connu de `SyncMarkBook.listKind`**, donc la liste d'Aujourd'hui d'un espace verrouillé n'y garde pas sa marque (à reprendre avec la carte qui ajoute ce genre à l'iPhone).
