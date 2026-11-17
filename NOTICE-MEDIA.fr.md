# Médias générés par intelligence artificielle

[English version](NOTICE-MEDIA.md)

Certains médias distribués avec Lucium n'ont été ni dessinés, ni filmés, ni composés par une personne : ils ont été générés par intelligence artificielle. Cette page dit lesquels, d'où ils viennent, et quelle licence ils ont : aucune. C'est une déclaration du mainteneur, pas un avis juridique.

## Quels médias

| Média | Où | Distribué |
|---|---|---|
| Neuf vidéos de fond et leurs neuf vignettes | `resources/backgrounds/lucium-*.mp4` et `lucium-*.jpg` | Dans ce dépôt et dans l'application (les « Vidéos de Lucium » du fond d'un espace) |
| La musique du film de présentation | Ni dans ce dépôt, ni dans l'application | Avec le film, sur [lucium.app](https://lucium.app) |

## D'où ils viennent

- **Les vidéos** ont été générées le 6 novembre 2026 avec le service en ligne Higgsfield, par l'abonnement payant du mainteneur : une image fixe (modèle GPT Image 2.6), puis son animation (modèle MiniMax H3 ou Wan 3.0, selon la vidéo). Le projet a ensuite réduit trois d'entre elles, fondu la boucle sur une seconde, encodé les fichiers et pris les vignettes, avec ffmpeg. Le tableau des modèles et des réglages est dans [`resources/backgrounds/README.md`](resources/backgrounds/README.md).
- **La musique du film** a été générée avec Higgsfield elle aussi. C'est le mainteneur qui le dit ; le dépôt ne contient ni le fichier, ni la trace de la date et du modèle.
- Les textes donnés au service et les fichiers tels que le service les a rendus ne sont pas dans le dépôt.

## Leur licence : aucune

- Ces médias ne sont **pas sous la GPL-3.0-or-later** du code, **pas sous une licence Creative Commons**, ni sous aucune autre licence libre.
- Le mainteneur les distribue avec Lucium en s'appuyant sur les conditions du service, lues dans leur version du 23 octobre 2026. Les conditions de chaque modèle utilisé par le service n'ont pas été lues.
- **Ce projet ne donne aucune licence sur ces médias et ne promet aucun droit de les réutiliser.** Savoir si vous pouvez les copier, les modifier ou les distribuer, en dehors de la transmission de Lucium tel quel, dépend des conditions du service et de ses modèles, et de la loi de votre pays. Cette page ne le tranche pas.
- Deux choses que ces conditions interdisent, telles que le mainteneur les a lues : entraîner un modèle avec ces médias, et retirer les signaux de provenance d'un fichier généré.

Si vous distribuez une version modifiée de Lucium sans vouloir dépendre de cela, retirez les dix-huit fichiers de `resources/backgrounds/` et leurs entrées de `src/shared/builtin-backgrounds.ts`, la liste que lit l'application.

## Marques de provenance

Les fichiers de `resources/backgrounds/` sont gardés tels qu'ils sont entrés dans le dépôt le 6 novembre 2026. Ils ne sont pas réencodés, pour que toute marque de provenance qu'ils portent y reste. Ce qui y a été lu le 11 novembre 2026 : aucun relevé de provenance dans le conteneur (pas de manifeste C2PA), et l'étiquette de l'encodeur, ffmpeg. Une marque cachée dans l'image elle-même ne peut pas être lue d'ici. Ne nettoyez pas et ne réencodez pas ces fichiers pour retirer une telle marque.
