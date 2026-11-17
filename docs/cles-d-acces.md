# Clés d'accès (passkeys, WebAuthn)

État au 11 novembre 2026. Une clé d'accès remplace le mot de passe d'un compte par une clé gardée sur un appareil : ce Mac (Touch ID, trousseau iCloud), un téléphone (code QR) ou une clé de sécurité (USB, NFC). Les sites les créent et les utilisent par l'API WebAuthn (`navigator.credentials.create` et `get`).

**En bref.** Lucium prend en charge les clés d'accès de plateforme (celles du Mac, validées par Touch ID ou par son mot de passe) sur le Mac où elles ont été essayées. Le 11 novembre 2026, dans la 1.0.0 installée et signée Developer ID, une page de test a créé des clés sur ce Mac puis s'en est servie : macOS affiche sa propre fenêtre à chaque demande, et la demande réussit quand on la valide (Touch ID ou mot de passe, selon la fenêtre). Lucium n'a aucun code pour cela : le moteur (Electron, donc Chromium) et macOS font le travail, sans le droit de signature qu'Apple réserve aux navigateurs. Reste à mesurer : de vrais comptes sur de vrais sites, l'endroit où la clé est gardée (trousseau iCloud ou ce Mac seul), une clé de sécurité, un téléphone par code QR, et d'autres Mac. Ce document dit ce qui est établi, ce qui a été mesuré, ce qui ne l'est pas encore, et ce qui se décide ensuite.

## 1. Ce qui est établi

Relevé sans lancer l'application, dans les sources et dans les fichiers d'une build de la 1.0.0 en préparation (alors numérotée 0.3.0), construite le 10 novembre 2026 (moteur 45.2.1+wvcus). Les droits de la 1.0.0 installée, celle de la mesure, ont été relus le 11 novembre.

- **Aucun code de Lucium ne touche à WebAuthn.** Ni préchargement, ni réglage, ni notice. Le seul fichier qui cite le mot est `src/shared/debugger-policy.ts`, qui refuse aux extensions le domaine `WebAuthn` du protocole de débogage (les authentificateurs virtuels).
- **L'application n'a pas le droit de signature qu'Apple réserve aux navigateurs.** Les droits de l'application signée sont six, ceux de `build/entitlements.drm.mac.plist` : JIT, mémoire exécutable non signée, validation des bibliothèques désactivée, caméra, micro, position. Il n'y a ni `com.apple.developer.web-browser.public-key-credential`, qui ouvre aux navigateurs les clés du trousseau iCloud, ni `keychain-access-groups` pour l'application elle-même (l'auxiliaire du coffre de mots de passe a le sien, qui ne sert qu'à lui). La 1.0.0 installée a les mêmes six droits et aucun profil d'approvisionnement (pas de `Contents/embedded.provisionprofile`). Vérifier : `codesign -d --entitlements - --xml /Applications/Lucium.app`.
- **Le moteur contient le code de Chromium pour le trousseau iCloud, derrière ce droit.** Le nom du droit et la classe `ASAuthorizationPlatformPublicKeyCredentialProvider` figurent dans le binaire `Electron Framework`. Avant la mesure, ce document en déduisait qu'aucune clé de plateforme ne marcherait sans le droit. La mesure de la section 5 montre le contraire. Le chemin que prend la demande (le trousseau iCloud, ou une clé que le moteur garde sur ce Mac seul) n'est pas établi.
- **Ce droit ne s'ajoute pas seul.** Apple l'accorde sur demande, à un identifiant d'application, et il doit figurer dans un profil d'approvisionnement embarqué dans l'application. Un droit restreint écrit dans la signature sans profil qui l'autorise empêche l'application de se lancer : il ne faut pas l'essayer « pour voir » dans `build/entitlements*.plist`.

## 2. Ce qui n'est pas mesuré

Une seule mesure a été faite : la sonde de la section 3, sur un Mac (section 5). Ces points restent ouverts.

| Question | Ce que l'on sait | Pourquoi c'est important |
|---|---|---|
| Une clé d'accès sur un vrai compte d'un vrai site : la créer, se connecter avec, et le remplissage automatique (`mediation: 'conditional'`) | La sonde est une page locale : elle ne parle à aucun serveur et ne vérifie rien. Le moteur annonce le remplissage automatique (`isConditionalMediationAvailable()` à `true`), que la sonde n'essaie pas. | Un site vérifie la réponse sur son serveur et peut demander plus que la sonde. La connexion à un grand service de comptes est déjà fragile dans Lucium (`docs/architecture.md`, « Identité des pages »). Un compte qui n'a plus que sa clé d'accès dépend de ce point. |
| Où la clé est gardée : dans le trousseau iCloud, synchronisée avec les autres appareils du compte, ou sur ce Mac seul | `attachment` vaut `platform`, et la liste `transports` est vide : elle ne le dit pas. | Une clé gardée sur ce Mac seul disparaît avec lui et ne sert pas sur un iPhone. |
| Une clé de sécurité (USB, NFC) | Le bouton 2 a échoué en `UnknownError` après 17,7 s, sans clé de sécurité branchée à ce moment, à ce que l'on sait. Ce résultat ne dit rien d'une clé branchée. | Une clé qui demande son code PIN a besoin d'une fenêtre : on ne sait pas si celle d'Apple la propose ici. |
| Un téléphone par code QR (transport hybride) | Le moteur l'annonce (`hybridTransport` à `true`). Aucune demande ne l'a essayé. | C'est la voie de qui garde ses clés sur un téléphone. |
| D'autres Mac, d'autres versions de macOS, un Mac sans Touch ID | Un seul Mac mesuré : un MacBook Pro (Mac16,5, Apple M4 Max) sous macOS 27.2.1. | Lucium s'installe à partir de macOS 13. La fenêtre d'Apple et ce qu'elle permet peuvent changer d'une version et d'un Mac à l'autre. |

## 3. Mesurer

La sonde est une page servie sur ce Mac seulement. Elle ne parle à aucun serveur, ne vérifie rien, et les clés qu'elle crée n'ouvrent aucun compte.

1. Dans le dépôt : `pnpm probe:passkeys`. La commande écrit une adresse (`http://localhost:8765/`) et n'ouvre aucune fenêtre.
2. Ouvrir cette adresse dans la version de Lucium à mesurer : la build signée Developer ID installée dans `/Applications`.
3. Lire le haut du rapport : ce que le moteur annonce avant toute demande.
4. Cliquer les cinq boutons l'un après l'autre, en attendant la fin de chaque demande (60 secondes au plus). Valider chaque fenêtre d'Apple qui s'affiche : une fenêtre fermée ou annulée termine la demande par un refus. Noter à part ce qui s'affiche : une fenêtre de Touch ID, une demande de mot de passe, un code QR, une liste d'appareils, ou rien. Refaire les boutons 2 et 4 avec une clé de sécurité USB branchée, si vous en avez une.
5. « Copier le rapport », et le résumer dans la section 5 de ce document, avec la version de Lucium, celle de macOS, le modèle du Mac et ce qui s'est affiché.
6. Refaire les étapes 2 à 5 dans un autre navigateur basé sur Chromium, sur le même Mac : c'est la référence.
7. Supprimer les clés de la sonde : Réglages Système › Mots de passe (site `localhost`), ou l'outil de la clé de sécurité.

Les essais sur de vrais comptes complètent la sonde : section 4, point 2.

Ce que le rapport contient, et comment le lire :

- `capabilities` : les réponses du moteur avant toute demande. Une chaîne qui commence par un nom d'erreur est un appel qui a échoué ; `absent` est un appel que le moteur n'a pas.
- `attempts` : une ligne par bouton, avec `durationMs`. Un `NotAllowedError` en quelques millisecondes est un refus du moteur. Le 11 novembre, un `NotAllowedError` en 1,5 à 2,5 secondes était une fenêtre d'Apple fermée ou annulée. Le même après 60 000 ms est une demande à laquelle personne n'a répondu.
- `attachment` d'une demande réussie dit où vit la clé (`platform` ou `cross-platform`). `transports` dit par où elle passe (`internal`, `usb`, `hybrid`) ; la sonde ne le lit qu'à la création, et une liste vide ne dit rien.

Le code de la sonde est dans `src/main/passkey-probe.ts`, ses tests dans `src/main/passkey-probe.test.ts`, et le serveur dans `scripts/passkey-probe.mjs`.

## 4. Ce qui se décide ensuite

La mesure du 11 novembre montre que les clés de plateforme marchent sur le Mac essayé. Il n'y a rien à corriger dans Lucium aujourd'hui : ce qui reste, ce sont des mesures.

1. **Rien à corriger dans ce que le moteur annonce.** La version précédente de ce document prévoyait de faire répondre `false` à `isUserVerifyingPlatformAuthenticatorAvailable()` si le moteur annonçait un authentificateur qu'il n'a pas. Il l'a : le bouton 1 réussit. Cette correction n'est plus à faire.
2. **Essayer sur de vrais comptes**, dans la build installée : `webauthn.io` (inscription puis connexion), GitHub et Google (ajouter une clé d'accès au compte, se déconnecter, se reconnecter avec elle, y compris par la proposition qui s'affiche dans le champ de connexion), et un site bancaire de démonstration qui accepte les clés d'accès. Noter ce qui s'affiche et le résultat, et le consigner dans la section 5.
3. **Mesurer la clé de sécurité et le code QR.** Refaire les boutons 2 et 4 de la sonde avec une clé de sécurité USB branchée. Puis les boutons 2 et 5 avec un téléphone, en choisissant dans la fenêtre d'Apple un autre appareil, si elle le propose.
4. **Mesurer où vit la clé.** Après le bouton 1, chercher la clé du site `localhost` dans Réglages Système › Mots de passe sur ce Mac, puis sur un autre appareil du même compte iCloud. Le README le dira ensuite : une clé qui ne vit que sur ce Mac disparaît avec lui.
5. **La demande du droit à Apple est suspendue.** Demander `com.apple.developer.web-browser.public-key-credential`, puis l'embarquer avec un profil d'approvisionnement, n'est plus justifié : rien de ce qui a été mesuré n'en dépend. À reconsidérer si un essai sur de vrais comptes échoue. Ce droit change les droits de signature : Netflix serait à revérifier ensuite, comme après tout changement de `build/entitlements*.plist` (`docs/drm.md`, section 8).
6. **Pas de notice dans l'application pour l'instant.** Une notice après une demande refusée supposerait d'observer `navigator.credentials` dans chaque page web, ce qui est un risque sur les pages de connexion. Au premier passage du 11 novembre, les refus venaient de la personne qui fermait la fenêtre d'Apple. Un texte ne se décidera que sur un échec mesuré.
7. **Des clés d'accès dans le coffre de mots de passe de Lucium** : toujours « à l'étude » dans `docs/roadmap.md`. C'est un chantier à part (un authentificateur à écrire), sans date.

## 5. Relevés

Chaque relevé est daté, avec la version de Lucium, celle de macOS, le modèle du Mac, et ce qui s'est affiché à chaque bouton. On résume le rapport de la sonde dans un tableau, sans coller tout le JSON.

### 11 novembre 2026 : Lucium 1.0.0, MacBook Pro, macOS 27.2.1

- **Lucium** : 1.0.0, build du commit `a098e2a84`, signée Developer ID, installée dans `/Applications`. Moteur : Electron de castLabs 45.2.1+wvcus.
- **Mac** : MacBook Pro (Mac16,5, Apple M4 Max), macOS 27.2.1.
- **Page** : `http://localhost:8765/`, servie par `scripts/passkey-probe.mjs`. Relevé par le mainteneur.
- **Ce que le moteur annonce avant toute demande** : `PublicKeyCredential` et `navigator.credentials` sont là. `isUserVerifyingPlatformAuthenticatorAvailable()` et `isConditionalMediationAvailable()` répondent `true`. `getClientCapabilities()` répond `true` à tout : `passkeyPlatformAuthenticator`, `userVerifyingPlatformAuthenticator`, `hybridTransport`, `conditionalCreate`, `conditionalGet`, `extension:prf`, `largeBlob`, les fonctions `signal…` et `relatedOrigins`.
- **Ce qui s'est affiché** : à chaque demande, une fenêtre de macOS pour créer ou utiliser la clé. Au premier passage, le mainteneur l'a fermée ou annulée chaque fois. Au second, il l'a validée chaque fois (Touch ID ou mot de passe, selon la fenêtre).

| Bouton | Premier passage : fenêtres d'Apple fermées | Second passage : fenêtres d'Apple validées |
|---|---|---|
| 1. `create-platform` : créer une clé sur ce Mac | `NotAllowedError` | Réussi en 1 778 ms : `attachment` `platform`, `transports` vide |
| 2. `create-roaming` : créer une clé sur une clé de sécurité ou un téléphone | `NotAllowedError` | Échoué : `UnknownError` après 17 696 ms (« The passkey request failed. ») |
| 3. `create-any` : créer une clé, au choix | `NotAllowedError` | Réussi en 1 638 ms : `platform` |
| 4. `get-created` : se connecter avec une clé créée ici | `NotAllowedError` | Réussi en 1 829 ms : `platform` |
| 5. `get-any` : se connecter avec une clé au choix | `NotAllowedError` | Réussi en 2 787 ms : `platform` |

Au premier passage, les cinq refus sont arrivés en 1,5 à 2,5 secondes.

Ce que le relevé établit, et ce qu'il n'établit pas :

- Sur ce Mac, une page crée une clé d'accès de plateforme et s'en sert, à condition que la personne valide la fenêtre d'Apple. Lucium prend donc en charge les clés de plateforme sur ce Mac.
- Une fenêtre d'Apple fermée donne à la page un `NotAllowedError`, comme dans tout navigateur où la personne annule.
- Le bouton 2 a échoué sans clé de sécurité branchée, à ce que l'on sait : ce n'est pas une mesure de la clé de sécurité.
- `transports` vide ne dit pas si la clé est dans le trousseau iCloud ou sur ce Mac seul.
- Aucun relevé de référence dans un autre navigateur (section 3, étape 6) n'est consigné.

## 6. Ce que le produit dit en attendant

- `README.fr.md` et `README.md`, « Limites connues » : les clés d'accès de plateforme marchent sur le Mac essayé, après validation de la fenêtre d'Apple ; de vrais comptes, une clé de sécurité, un téléphone par code QR et d'autres Mac n'ont pas été essayés ; garder une autre méthode de connexion tant que ce n'est pas mesuré.
- Le site, FAQ : la même chose, en quelques phrases ; feuille de route : les clés d'accès dans le gestionnaire de mots de passe de Lucium, « À l'étude ».
- `docs/roadmap.md` : les clés d'accès sont parmi ce qui est disponible (Touch ID, essayé sur un Mac), avec ce qui reste à mesurer.
- Les notes de la version 1.0.0 (`CHANGELOG.fr.md`, `CHANGELOG.md`) datent d'avant la mesure : elles disent que le README conseille de ne pas compter sur les clés d'accès. Cette section est figée avec la build ; le README, lui, dit ce qui est mesuré.
