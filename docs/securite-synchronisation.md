# Revue de sécurité de la synchronisation Mac et iPhone

Rapport de la carte 448 (synchro 6/6), écrit le 18 novembre 2026. Il porte sur le code **déjà fusionné** dans `main` (jusqu'au commit `bb7e8067`) et sur les correctifs de cette carte (tous fusionnés). La spécification est `docs/synchronisation.md` ; ce rapport dit ce que l'attaque a trouvé, ce qui est corrigé, ce qui reste, et propose la réponse au questionnaire d'exportation du chiffrement.

**Résultat en une phrase.** Aucun défaut ne permet à quelqu'un qui n'est pas appairé de lire ou d'écrire des données, **sauf si la personne scanne un faux QR avec son iPhone** (n° 9) : l'appairage, l'épinglage et le filtre d'adresses tiennent. En revanche, **un appareil appairé hostile pouvait faire plus que ne le dit la spécification** (écrire dans le prototype du processus principal, empoisonner l'horloge, faire supprimer des données, bloquer le processus principal quelques secondes) ; **dix de ces défauts sont corrigés par huit PR** (§10) et **deux points de conception restent ouverts** (n° 9 et n° 10). Le rapport n'est donc **pas encore « sans point bloquant »** : voir la liste des points à décider au §8.

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
| 9 | moyenne | **L'iPhone ne demande jamais « s'appairer à quel Mac ? ».** Un faux QR (affiche, message) que la personne scanne dans « Ajouter un Mac » fait épingler le Mac de l'attaquant, puis lancer une séance : espaces, dossiers, favoris et onglets épinglés partent chez lui. La confirmation du §4.1 [Q7] protège le Mac, pas l'iPhone. | Lecture du code (`SyncPairingSheet`, `SyncController`) ; relevé par la relecture, non rejoué | **Non corrigé : décision d'interface** (§8) |
| 10 | moyenne | **Modèle de recherche reçu : `http` accepté, hôte libre.** Un appareil appairé peut, si la catégorie « réglages » est cochée des deux côtés (non cochée par défaut), rediriger toutes les recherches du Mac vers un serveur de son choix. | Lecture de `inbound-filter.ts` | **Corrigé côté Mac** (décision du chef du 18 nov. : « Moteurs connus seulement »), PR #107 (Mac et iPhone) |
| 11 | moyenne | **Application d'un patch en temps quadratique.** `applySyncPatch` cherchait dans la liste pour chaque entité : 40 000 créations bloquaient le processus principal 3,4 s (rejoué ici ; 3,9 s et 7 s pour 20 000 dossiers et 20 000 onglets selon la relecture). L'appareil hostile calcule la même fusion, donc les résumés concordent : il pouvait relancer le gel à chaque séance. | Rejoué : 3,4 s contre 91 ms après correctif | **Corrigé**, PR #99 (fusionnée) |
| 12 | moyenne | **Bornes en octets, pas en valeurs.** Une trame de 30 Mio de tableaux vides imbriqués coûte 8 à 12 s de gel et 1,76 Go de mémoire (la relecture). | Mesure de la relecture, non rejouée ; le calcul (350 000 valeurs au Mio) est de moi | **Corrigé**, PR #100 (fusionnée) : 150 000 valeurs par trame, 2 000 000 par connexion |
| 13 | moyenne | **Supprimer un espace sur l'iPhone supprime, sur le Mac, ses onglets ouverts** (ceux d'« Aujourd'hui », qui ne se synchronisent pas) sans archive, comme une suppression locale mais sans confirmation sur le Mac. Un appareil hostile peut le faire pour tout ce qu'il connaît. | Rejoué | **Non corrigé : décision** (§8) |
| 14 | moyenne | **Pierres tombales cumulées sans borne** (198 000 après deux séances) : la séance suivante échoue en `too many tombstones` des deux côtés ; les tombes de genres interdits (`password`…) sont acceptées puis renvoyées. | Relecture, non rejoué | **Non corrigé** |
| 15 | moyenne (latent) | **Texte avec un substitut isolé** (`\ud83d`) : le Mac en produit (coupe à 60 ou 1000 unités au milieu d'un émoji) et le Swift ne sait pas le lire (`bad-message`) : la séance échoue tant que la valeur est dans l'état. | Relecture, non rejoué | **Non corrigé** |
| 16 | moyenne (latent) | **Clé de liste `favorites:<profileId>` sans borne ni forme NFC** : le Mac et le Swift peuvent donner deux listes différentes (`divergence`) ; une clé de 510 caractères rend la base illisible. | Relecture, non rejoué | **Non corrigé** |
| 17 | moyenne | **`MarkBook.adopt` efface les marques et tombes des catégories non échangées** : après une séance sans « réglages », leurs marques repartent de l'heure du moment et leurs suppressions peuvent revenir. | Relecture, non rejoué | **Non corrigé** |
| 18 | basse | **Une erreur d'heure bloque l'horloge des marques dans le futur pour toujours** (pas d'auto-guérison) ; `Hlc.next` dépasse 13 chiffres à `9999999999999`. Le n° 2 corrige l'entrée par le réseau, pas ce cas. | Raisonnement | **Non corrigé** |
| 19 | basse | **iPhone : aucune durée maximale de séance** (le Mac applique 10 min ; `SyncLimits.sessionMaximum` n'est lu nulle part côté iPhone) : un pair qui envoie un octet par minute bloque « Synchroniser maintenant ». | Lecture, non rejoué | **Corrigé**, PR à venir (`SyncSessionClient.run` borne la séance à 10 minutes ; le corps de séance de la carte 452 n'a rien à faire, la coupure est autour de lui) |
| 20 | basse | **JSON : clés dupliquées** (`{"n":1,"n":2}`) : « première gagne » en Swift, « dernière gagne » en JavaScript. Le résumé `result` doit attraper l'écart. | Relevé, non rejoué | **Non corrigé** |
| 21 | basse | **Le Mac affiche seulement le nom choisi par l'iPhone** dans « Autoriser / Refuser », pas l'adresse source : quelqu'un qui a photographié le QR s'appelle « iPhone de … ». | Lecture | **Non corrigé** (une ligne de plus dans la feuille) |
| 22 | basse | **Identité remplacée si le trousseau refuse un instant** : `loadOrCreate` écrase l'identité et oublie les appareils appairés. Perte de confort, pas de fuite. | Lecture | **Corrigé côté Mac**, PR à venir (pas de remplacement au premier refus du trousseau) ; l'iPhone ne remplace rien sans « introuvable » : lu, inchangé |
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
- **Le modèle de recherche** (n° 10) : tant que la catégorie « réglages » reste non cochée par défaut, le risque ne touche que ceux qui la cochent.

## 6. Ce qui n'a pas été revu ni vérifié

- Le corps de séance de l'iPhone (carte 452) ; à relire à sa fusion.
- Rien sur un appareil réel : `Network.framework`, résolution d'un nom `.local`, invite du réseau local, caméra, `safeStorage` dans l'application, pare-feu de macOS. Le Node d'Electron 45.2.1 a été essayé par la carte 444, pas par moi.
- `smoke-sync.ts` n'a pas été lancé (`AGENTS.md` §1) ; les essais de bout en bout du Mac sont ceux des tests Vitest.
- La mesure du n° 12 (mémoire, gel) est celle de la relecture ; je ne l'ai pas rejouée. Celle du n° 11 l'a été.
- La page des Réglages et `sync-conflicts` (le journal n'est pas encore branché au Mac) ont été lus vite.
- Pas de revue de l'interface (textes, accessibilité) ni des captures.
- **Aucune nouvelle dépendance n'a été ajoutée.**

## 7. Pour les cartes voisines

- **Carte 452 (corps de séance iPhone)** : (a) écarter, comme le Mac, les pierres tombales et les marques d'ordre à plus de 7 jours dans le futur (§9.3, PR #94) ; (b) remplacer par la version de la base une entité refusée pour ses marques, son adresse ou sa valeur (§22, PR #97) ; (c) le Mac refuse un genre ou un identifiant qui porte un nom de `Object.prototype` (§7.1, PR #93) : le Swift n'en a pas besoin, mais ne doit pas en produire ; (d) lire `SyncLimits.sessionMaximum` (n° 19) ; (e) refuser les chaînes à substitut isolé (n° 15) ; (f) appliquer la borne de valeurs JSON (150 000 par trame, 2 000 000 par connexion, PR #100).
- **Carte 447 (reprise d'un onglet)** : la liste reçue est filtrée en `http(s)` (PR #96) ; ne rien ouvrir d'autre que par ce chemin.

## 8. Points à décider avant de dire « sans point bloquant »

1. **N° 9, l'iPhone confirme-t-il le Mac ?** Recommandation : après la preuve du Mac et avant d'enregistrer, afficher « Appairer avec « nom » ? » et quatre à six caractères de l'empreinte, **et** montrer les mêmes caractères sur le Mac dans la feuille « Autoriser / Refuser » (n° 21), pour que la personne compare. Texte FR et EN, test.
2. **N° 10, le modèle de recherche.** Recommandation : ne synchroniser que les moteurs connus (la liste de `settings-guide.ts`) et refuser `http`. Le Swift doit suivre (vecteur `inbound`).
3. **N° 13.** Recommandation : archiver, ou mettre dans une copie de session, les onglets ouverts d'un espace avant de le supprimer à la demande d'un autre appareil.

Les n° 14 à 22 sont des correctifs sans décision à prendre ; ils n'ont pas été faits faute de temps dans cette carte et peuvent suivre en PR séparées.

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

## 10. Liste des PR de cette carte

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

Chacune a un test qui échoue sans le correctif (mutation vue) et met à jour `docs/synchronisation.md`. Un seul écart de méthode : la branche de la PR #97 a été amendée et poussée de force (`--force-with-lease`) quelques minutes après son premier envoi, avant l'ouverture de la PR, ce que `AGENTS.md` §7 déconseille ; rien d'autre n'était sur cette branche.
