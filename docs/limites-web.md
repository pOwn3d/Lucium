# Ce que le web peut faire ailleurs et pas, ou pas tout à fait, dans Lucium

Lucium affiche les pages avec le Chromium d'Electron. Presque tout le web s'y comporte comme dans un navigateur Chromium. Cette page liste les écarts connus, avec leur raison. Chaque ligne dit si l'écart est **voulu** (un choix de sécurité ou de vie privée), s'il vient **du moteur**, et s'il a été **mesuré** dans l'application ou seulement lu dans le code.

Les extensions ont leur propre page : [extensions-compatibilite.md](extensions-compatibilite.md). Les clés d'accès aussi : [cles-d-acces.md](cles-d-acces.md).

## Notifications

| Écart | Raison | État |
|---|---|---|
| Une page n'envoie une notification que si elle est ouverte et éveillée. Les notifications poussées par un serveur quand la page est fermée (Web Push, `PushManager.subscribe`) ne sont pas fournies. | Du moteur : Electron n'a pas de service de push pour les pages web. | Lu dans le code, pas mesuré : l'échec de `pushManager.subscribe` reste à constater sur un site d'essai. |
| Un onglet mis en veille ou gelé ne notifie plus. | Conséquence de la ligne précédente : c'est la page qui notifie. La liste « Sites gardés éveillés » (Réglages › Onglets et fenêtres › Sites gardés éveillés) sert à cela. | Voulu. |
| Un clic sur la notification d'une page ne montre pas forcément son onglet. | Du moteur : Electron ne transmet pas ce clic à l'application, et rien dans Lucium ne le remplace. | Lu dans le code, pas mesuré. |

## Appareils et matériel

| Écart | Raison | État |
|---|---|---|
| Web Bluetooth : toute demande est annulée, sans message dans la page. | Voulu : Lucium n'a pas de fenêtre pour choisir un appareil Bluetooth, et Electron annule la demande quand personne ne répond. | Lu dans le code. |
| WebHID, WebUSB et Web Serial sont désactivés par défaut. | Voulu : voir [api-materielles.md](api-materielles.md). Le réglage est dans Réglages › Vie privée et sécurité › Plus de réglages › API matérielles du web. | Mesuré (suite moteur). |
| Un serveur qui demande un certificat client (mTLS, carte à puce) n'en reçoit aucun. La page ne dit pas pourquoi la connexion échoue ; Lucium le dit par un avis dans la fenêtre de l'onglet, qui nomme le site, une fois par serveur et par lancement. L'avis est celui de la fenêtre (au pied de la barre latérale) et s'efface seul : rien ne reste dans le centre de notifications. | Voulu : un certificat révèle une identité, et Lucium n'a pas de fenêtre pour le choisir (`src/main/shell/certificates.ts`). | Lu dans le code. |

## Partage d'écran

| Écart | Raison | État |
|---|---|---|
| On partage un écran ou une fenêtre, pas un onglet seul. | Du moteur : le sélecteur du système fait planter Electron 45, Lucium propose donc sa propre liste (`docs/architecture.md`). | Mesuré. |
| Pas de son partagé sur macOS. | Du moteur : Electron ne donne le son d'un écran que sur Windows. | Lu dans le code. |
| Pas d'envoi d'un onglet vers un téléviseur ou une enceinte (Cast). Aucune entrée de menu ne le propose. | Du moteur : le routeur Cast de Chromium n'est pas inclus dans Electron. Pour afficher une page sur un autre écran, utilisez la recopie d'écran de macOS (Centre de contrôle › Recopie de l'écran). | Lu dans le code. |

## Appels (WebRTC : Meet, Zoom…)

| Écart | Raison | État |
|---|---|---|
| Un appel vit dans l'onglet qui l'a ouvert : il ne passe pas d'un onglet, d'un profil ou d'une fenêtre à l'autre, et il prend fin avec cet onglet. | Du moteur : une connexion WebRTC (`RTCPeerConnection`) est liée au document qui l'a créée, et Chromium ne sait pas la migrer. Chaque profil de Lucium a sa propre session (cookies et données isolés) et chaque onglet son contenu : une connexion ne peut pas être partagée entre eux, et une couche commune à tous les profils ferait perdre cette isolation. | Du moteur (Chromium). Gardez l'onglet de l'appel ouvert, ou ouvrez l'appel dans une fenêtre à part si vous voulez changer librement d'onglet. Qu'un simple changement d'onglet coupe l'appel dans la 1.1.0 n'a pas été mesuré : on ne l'affirme pas. |

## Fenêtres ouvertes par une page (popups) et cadres

| Écart | Raison | État |
|---|---|---|
| Dans une popup : pas de fenêtre d'identification HTTP, `prompt()` répond `null`, `alert()` et `confirm()` montrent la feuille de macOS d'Electron (elle ne nomme pas le site, et ses boutons sont en anglais : « OK », « Cancel ») au lieu de la boîte de Lucium, pas de plein écran, et une autorisation (caméra, micro) est redemandée à chaque fois au lieu d'être mémorisée. Un Coup d'œil se comporte de même pour les trois boîtes. | Voulu : une popup est une fenêtre réduite, sans l'interface d'un onglet. | Lu dans le code ; la feuille d'une popup est dans le contrôle moteur écrit (`src/main/smoke-dialogs.ts`), pas encore lancé. L'effet exact sur le plein écran d'une vidéo n'est pas mesuré. |
| Dans un cadre (`iframe`) : `prompt()` répond `null`, et un formulaire de connexion n'est ni proposé à l'enregistrement ni rempli par le coffre. | Voulu : les scripts de Lucium ne sont chargés que dans le cadre principal. Un navigateur Chromium bloque lui aussi `prompt()` dans un cadre d'une autre origine. | Lu dans le code. |
| Dans un cadre (`iframe`), d'un autre site ou du même : `alert()` et `confirm()` montrent la feuille de macOS d'Electron, pas la boîte de Lucium. Cette feuille ne dit pas quel site la montre, a ses boutons en anglais (« OK », « Cancel ») et peut s'ouvrir alors que l'onglet du cadre est en arrière-plan. Une page peut donc encore l'obtenir en appelant la fonction d'un cadre qu'elle crée elle-même. | Voulu (décision du 12 novembre 2026) : seul le cadre principal reçoit la boîte de Lucium ; Electron ne laisse remplacer ces fonctions que là où Lucium charge ses scripts. | Lu dans le code ; un cadre d'un autre site est dans le contrôle moteur écrit (`src/main/smoke-dialogs.ts`), pas encore lancé. |

## Boîtes des pages (`alert()`, `confirm()`, `prompt()`)

Dans un onglet, les trois boîtes passent par la boîte de Lucium : elle nomme le site (« site.example indique : » ou « … demande : »), s'ouvre sur l'onglet qui l'a demandée et garde la page en attente de la réponse, comme ailleurs. Les écarts :

| Écart | Raison | État |
|---|---|---|
| La boîte d'un onglet en arrière-plan ne s'ouvre pas : elle attend que l'onglet soit affiché, et la page reste en attente jusque-là. Un avis dit quel site attend, avec « Afficher ». | Voulu : une boîte ne s'ouvre jamais par-dessus l'onglet que l'on regarde, et l'onglet qui demande n'est pas mis au premier plan par son propre appel. | Lu dans le code et testé (`off-screen-questions.test.ts`) ; contrôle moteur écrit (`src/main/smoke-dialogs.ts`), pas encore lancé pour `alert()` et `confirm()`. |
| Une page que son serveur place dans un bac à sable (`Content-Security-Policy: sandbox`) en gardant son origine (`allow-same-origin`) mais sans `allow-modals` ouvre la boîte de Lucium pour `alert()` et `confirm()`, là où Chromium n'affiche rien. Sans `allow-same-origin`, Chromium décide seul : rien sans `allow-modals`, sa feuille avec. | Du moteur : rien ne dit à Lucium qu'une page est dans un bac à sable, sauf son origine opaque. | Lu dans le code ; le cas sans `allow-same-origin` est dans le contrôle moteur écrit, pas encore lancé. |
| Pendant qu'on quitte une page, ses gestionnaires de `beforeunload`, `pagehide` et `unload` n'ouvrent aucune boîte : l'appel rend aussitôt (`confirm()` vaut `false`), comme dans Chromium. Un appel différé depuis ces gestionnaires (minuterie) peut encore en ouvrir une. | Voulu : une page ne retient pas l'utilisateur sur le départ. | Testé (`dialog-bridge.test.ts`) ; contrôle moteur écrit pour `beforeunload`, pas encore lancé. |

## Fenêtre flottante d'un appel (Document Picture-in-Picture)

| Écart | Raison | État |
|---|---|---|
| Le bouton qui ouvre la petite fenêtre d'appel d'un site de visioconférence (Google Meet : `documentPictureInPicture.requestWindow()`) ne fait rien tant que la fonction « Image dans l’image des appels vidéo » est coupée, ce qui est le réglage par défaut : la demande échoue, sans ouvrir d'onglet. | Du moteur : Electron 45 ne montre pas cette fenêtre (electron/electron#39633). La fonction, dans Réglages › Fonctions en option, la reprend par un événement interne d'Electron ([fonctions.md](fonctions.md), `document-pip`). | Lu dans le code. Le contrôle moteur `LUCIUM_SMOKE_ONLY=docpip` est écrit, pas encore lancé. |
| Fonction activée, la fenêtre est celle de Lucium, pas celle de Chrome : une barre de titre qui nomme le site, au-dessus des autres fenêtres, sans bouton « Revenir à l'onglet ». Elle n'ouvre aucune fenêtre ni aucun lien, ne navigue pas (elle se ferme si on l'envoie ailleurs) et ne se recharge pas. Une autorisation que la page n'a pas encore (caméra, micro) se demande depuis l'onglet. | Voulu : une fenêtre qui reste au-dessus des autres montre le seul document que sa page y écrit. | Lu dans le code ; le comportement avec un vrai appel n'est pas mesuré. |
| Fonction activée, une mise à jour d'Electron qui change son événement interne coupe la fenêtre sans bruit pour la page : la demande échoue comme avant, et le journal le dit (`[pip] Electron has no listener …`). | Du moteur : l'événement `-add-new-contents` n'est pas documenté. | Gardé par un test ; à relire à chaque montée d'Electron (`docs/mise-a-jour-chromium.md`). |

## Lecture automatique

Une vidéo avec le son démarre après un geste sur la page. Lucium ne tient pas le compte des sites que vous regardez souvent, que Chromium utilise pour laisser certains sites démarrer seuls : une vidéo ouverte depuis un autre site peut donc attendre un clic. Le réglage se change site par site (Réglages › Vie privée et sécurité › Autorisations mémorisées, ou le panneau du site). Voulu.

## Vidéos protégées

Le module Widevine est installé au lancement, dans la variante DRM seulement ([drm.md](drm.md)). Sur une connexion lente, Lucium annonce au bout de deux minutes que les contenus protégés sont indisponibles ; si le module arrive ensuite, une seconde notice dit que les vidéos se lisent. Seul Netflix a été vérifié.

## Fichiers téléchargés

« Ouvrir avec… » et « Ouvrir sans l'enregistrer » sont refusés pour ce qui peut s'exécuter. La liste comprend les scripts en texte (`.js`, `.py`, `.rb`, `.php`, `.lua`, `.swift`, `.sh`…) et les `.jar` : ouvert avec le Terminal, un tel fichier s'exécute. « Ouvrir » par le système reste possible depuis la fenêtre des téléchargements. Voulu (`src/shared/open-with.ts`).
