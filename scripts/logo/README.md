# Logo de Lucium : « les espaces en éventail »

Cinq onglets arrondis s'ouvrent depuis un point de lumière : chaque onglet est un espace, le centre est la page qui s'allume. **Un seul dessin** pour toutes les versions ; seules les couleurs changent.

| Fichier | Rôle |
|---|---|
| `fan-logo.ts` | La source unique : `fanLogo(thème, taille, uid, options)` rend le dessin en SVG (canevas de 1024, tuile de 824 aux coins de 185, ombre portée dans la marge), et `FAN_THEMES` donne les huit versions. |
| `make-icons.mjs` | Rend les images avec Google Chrome sans fenêtre (Playwright du dépôt), chaque taille depuis le SVG, fond transparent hors de la tuile ; construit le `.icns` avec `iconutil`. |
| `fan-logo.test.ts` | Garde le dessin, l'accord des thèmes avec le registre de Réglages › Icône (`src/shared/icons.ts`), et lit les images produites (couleurs, transparence, taille). |

## Licence : hors GPL

Le dessin (`fan-logo.ts`) et les icônes rendues (`build/icon.icns`, `resources/app-icons/*.png`, l'icône d'iOS) ne sont pas sous la GPL du reste du dépôt : Copyright © 2026 ConsilioWeb, tous droits réservés. Le logo est réservé aux builds officielles ; `TRADEMARKS.fr.md` dit ce qui reste permis et ce qu'une version modifiée doit remplacer. `make-icons.mjs` et `fan-logo.test.ts` sont du code sous GPL.

## Refaire les icônes

```sh
pnpm icons:logo                      # écrit le dépôt et out-icons/
pnpm icons:logo --site /chemin/dossier   # envoie les fichiers du site ailleurs
```

Il faut un Mac (`iconutil`) et Google Chrome. Aucune fenêtre ne s'ouvre. Ne pas retoucher les images à la main : modifier `fan-logo.ts`, relancer, puis `npx vitest run scripts/logo`.

Écrit dans le dépôt :

- `build/icon.icns` : l'icône de l'application, la version par défaut (Clair), de 16 à 1024 px en 1x et 2x ;
- `resources/app-icons/<id>.png` : l'icône de chaque choix de Réglages › Icône, en 512 px.
- `ios/Lucium/Assets.xcassets/AppIcon.appiconset/AppIcon-1024.png` : l'icône de l'application iPhone et iPad, la version par défaut en carré plein de 1024 px, **sans transparence** (App Store Connect la refuse) ni coins arrondis (le système les arrondit lui-même) ; `Contents.json` du même dossier la nomme.

Écrit dans `out-icons/` (ignoré par Git) :

- `lucium-<id>.png` : les huit versions en 1024 px ;
- `planche.png` : chaque version à 256, 64, 32 et 16 px sur fond clair et sur fond sombre, pour juger les petites tailles ;
- `site/` : ce que prend le site (`assets/icons/` à 256 px sous les noms du site, et les favicons).

## Les huit versions

| Version | Identifiant (`resources/app-icons/<id>.png`) | Fichier du site |
|---|---|---|
| Clair (par défaut) | `clair` | `clair.png` |
| Boréal | `boreal` | `boreal.png` |
| Crépuscule | `crepuscule` | `crepuscule.png` |
| Nébula | `nebula` | `nebula.png` |
| Cyber | `cyber` | `cyber.png` |
| Solaire | `solaire` | `solaire.png` |
| Abysse | `abysse` | `abysse.png` |
| Sépia & Or | `sepia-or` | `sepia-or.png` |

## Origine et licence

Le logo a été dessiné pour Lucium, dans ce dépôt (9 novembre 2026). Le dessin est un SVG écrit dans `fan-logo.ts` : aucune image incrustée, aucun fichier ni tracé repris d'un tiers. Toutes les images (`build/icon.icns`, `resources/app-icons/`, les icônes et favicons du site) sont rendues depuis ce fichier, jamais retouchées à la main.

- **Le dessin** (`fan-logo.ts`) et les images qu'il produit sont hors de la GPL (voir « Licence : hors GPL », plus haut) ; **les outils** (`make-icons.mjs`, `fan-logo.test.ts`) sont sous la licence du dépôt, GPL-3.0-or-later, « Copyright © 2026 ConsilioWeb and contributors ».
- **Le logo comme signe du projet** est réservé aux builds officielles : la GPL ne donne aucun droit sur lui à ce titre. Une version modifiée de Lucium que l'on distribue doit changer de nom et de logo. Voir [`TRADEMARKS.md`](../../TRADEMARKS.md).

Ajouter une version : un thème dans `FAN_THEMES`, une entrée dans `APP_ICONS` (`src/shared/icons.ts`) avec ses textes `icons.<id>` (français et anglais), puis `pnpm icons:logo`. Le test refuse un thème sans choix, un choix sans thème et une image qui n'est pas celle de son thème.
