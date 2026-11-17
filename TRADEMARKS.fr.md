# Nom et logo de Lucium

[English version](TRADEMARKS.md)

Le code de Lucium est un logiciel libre sous GPL-3.0-or-later : vous pouvez le copier, le modifier et distribuer votre propre version ([LICENSE](LICENSE)). La licence porte sur le code. Elle ne porte ni sur le nom ni sur le logo, et elle ne donne pas le droit de présenter une autre build comme étant Lucium. Cette page dit ce qui est réservé, quels fichiers sont hors de la GPL, ce qu'une version modifiée doit changer, et ce qui reste permis.

C'est une règle du projet, écrite par son mainteneur, pas un avis juridique. Elle ne retire rien de ce que la GPL accorde sur le code.

## Ce qui est réservé

- **Le nom « Lucium »**, seul ou dans un nom de produit (« Lucium DRM », « Lucium Browser »).
- **Le logo**, « les espaces en éventail » : cinq onglets arrondis qui s'ouvrent depuis un point de lumière, dans ses huit versions de couleur, ainsi que les icônes, favicons et images qui en sont tirés.

[ConsilioWeb](https://consilioweb.fr), qui maintient le projet, s'en sert pour dire une seule chose : *cette build a été faite et publiée par le mainteneur de Lucium.* Seules les builds officielles les portent : celles que le mainteneur construit et publie, sur [lucium.app](https://lucium.app).

Vous ne pouvez pas utiliser le nom ou le logo, ou quelque chose d'assez proche pour être confondu avec eux, comme nom ou comme icône d'une build qui n'est pas officielle.

Aucune marque n'est déposée aujourd'hui pour le nom ou pour le logo. Ils sont réservés par cette règle, par le droit d'auteur sur le dessin, et par le droit qui protège un signe sous lequel un produit est connu.

## Les fichiers du logo ne sont pas sous GPL

Le dessin du logo n'est pas un logiciel libre. **Copyright © 2026 ConsilioWeb, tous droits réservés**, pour ces fichiers du dépôt :

| Fichiers | Ce que c'est |
|---|---|
| `scripts/logo/fan-logo.ts` | Le dessin lui-même : les formes, leurs proportions et les huit jeux de couleurs |
| `build/icon.icns` | L'icône de l'application, rendue depuis le dessin |
| `resources/app-icons/*.png` | Les huit icônes proposées dans les Réglages, rendues depuis le dessin |

Il en va de même des favicons et des images du site tirés du dessin. Le reste de `scripts/logo/` (le script qui rend les icônes, le test qui les contrôle) est du code sous GPL, comme les icônes des menus et de l'interface.

Sans rien demander, vous pouvez :

- garder ces fichiers dans une copie du dépôt, un fork compris, et les transmettre tels quels avec le code source ;
- construire Lucium avec eux pour votre propre usage ;
- transmettre une build officielle telle quelle ;
- montrer le logo pour parler de Lucium (voir plus bas) ;
- modifier `scripts/logo/fan-logo.ts` pour mettre votre propre dessin à la place de celui-ci : c'est ce qu'une version modifiée doit faire.

Tout le reste demande l'accord du mainteneur : modifier le logo, distribuer une build à vous qui le porte, vous en servir pour un autre produit.

## Si vous distribuez une version modifiée

Une build que vous gardez pour vous n'a rien à changer. Dès que vous donnez votre build à quelqu'un d'autre, changez ces cinq choses, pour que personne ne la prenne pour une build officielle et pour qu'elle ne se serve pas des services du projet :

| Quoi | Pourquoi | Où c'est aujourd'hui |
|---|---|---|
| **Le nom** | On doit pouvoir distinguer votre build de Lucium. | `productName` dans `package.json` et `electron-builder.yml`, les textes de `src/shared/i18n-fr.ts` et `src/shared/i18n-en.ts` |
| **Le logo et les icônes** | Même raison, et ces fichiers ne sont pas sous GPL. | Votre propre dessin dans `scripts/logo/fan-logo.ts`, puis `pnpm icons:logo`, qui réécrit `build/icon.icns` et `resources/app-icons/` |
| **L'identifiant de l'application** | Avec l'identifiant de Lucium, votre build ouvrirait le profil, les entrées du trousseau et les autorisations système d'un Lucium installé. | `appId` dans `electron-builder.yml` (`app.lucium.browser`), les identifiants des auxiliaires dans `native/`, `src/main/vault-keychain.ts` et `src/main/translate/system.ts`, le schéma d'adresse `lucium` |
| **Le flux de mise à jour** | Le flux de `lucium.app` sert des builds officielles, signées par le mainteneur. Votre build ne doit pas lui demander de mises à jour. | L'adresse donnée à `scripts/build-drm-release.sh --update-feed` et `--test-feed`, et les canaux de `src/main/publish-update.ts`. Une build faite sans ces options ne suit aucun flux. |
| **Les adresses de contact** | Les signalements sur votre build doivent vous arriver, pas au mainteneur de Lucium. | Les pages de la communauté dans `src/shared/problem-report.ts`, le dépôt et la société dans `src/shared/about.ts`, `contact@lucium.app` dans les documents, les métadonnées du paquet dans `electron-builder.yml` |

Gardez tels quels les avis de droit d'auteur et les textes de licence ([LICENSE](LICENSE), [NOTICE](NOTICE), `THIRD-PARTY-NOTICES.txt`) : la GPL le demande, et ce n'est pas un usage du nom que cette page restreint.

## Ce qui reste permis

- **Dire d'où vient votre version** : « basé sur Lucium », « un fork de Lucium », « construit à partir du code source de Lucium ». Dites-le dans une phrase, pas dans le nom de votre produit.
- **L'usage descriptif** : écrire sur Lucium, le comparer, s'en servir pour enseigner, le tester, faire un lien vers lui, le nommer dans un rapport de bug.
- **Montrer le logo pour parler de Lucium** : un article, une présentation, un comparatif, une liste de navigateurs, sans le modifier et sans laisser entendre que le projet vous soutient.
- **Tout ce que la GPL accorde sur le code.** Les fichiers du logo n'en font pas partie.

## Ce qui n'est pas permis sans demander

- Appeler une build modifiée « Lucium », ou d'un nom qui le contient ou lui ressemble.
- Utiliser le logo, ou une variante, comme icône d'une autre application, d'un autre projet ou d'une société.
- Laisser entendre que le projet ou son mainteneur a fait, vérifié ou soutient votre build, votre produit ou votre service.
- Déposer le nom ou le logo, seuls ou combinés, comme marque, nom de domaine ou nom de compte destiné à passer pour le projet.

## Les noms des autres

macOS, Chromium, Electron, Widevine, Netflix et les autres noms qui apparaissent dans le code et les documents appartiennent à leurs titulaires. Lucium n'a pas de lien avec eux. Rien ici n'accorde de droit sur ces noms.

## Demander

Pour un usage que cette page ne prévoit pas, ou pour signaler une build qui se fait passer pour Lucium, écrivez au mainteneur, [ConsilioWeb](https://consilioweb.fr). Le projet a aujourd'hui un seul mainteneur, qui répond seul.
