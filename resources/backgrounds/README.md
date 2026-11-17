# Fonds vidéo de Lucium

Les vidéos proposées dans le panneau Fond d'un espace (« Vidéos de Lucium »). Elles sont livrées dans les ressources de l'application (`electron-builder.yml`, `extraResources`), lues comme un média de l'utilisateur et jamais écrites ni supprimées (`src/shared/builtin-backgrounds.ts`, `src/main/media-storage.ts`).

Générées pour Lucium le 6 novembre 2026 avec Higgsfield (abonnement payant du mainteneur) : une image fixe (GPT Image 2.6), animée en boucle avec la même image au début et à la fin, puis fondue sur une seconde au raccord (ffmpeg `xfade`), sans son.

| Fichier | Scène | Modèle vidéo |
| --- | --- | --- |
| `lucium-aurores-boreales.mp4` | Aurores boréales sur un lac gelé | MiniMax H3 (2K, réduite en 1080×1920) |
| `lucium-temple-brume.mp4` | Temple japonais dans la brume | MiniMax H3 (2K, réduite en 1080×1920) |
| `lucium-serre-lucioles.mp4` | Serre la nuit, pluie et lucioles | MiniMax H3 (2K, réduite en 1080×1920) |
| `lucium-village.mp4` | Village enneigé | Wan 3.0 (720×1280) |
| `lucium-foret.mp4` | Forêt au clair de lune | Wan 3.0 (720×1280) |
| `lucium-montagnes.mp4` | Montagnes dans la brume sous les aurores | Wan 3.0 (720×1280) |
| `lucium-ville-cyberpunk.mp4` | Ville néon sous la pluie | Wan 3.0 (720×1280) |
| `lucium-fonds-marins.mp4` | Méduses dans les fonds marins | Wan 3.0 (720×1280) |
| `lucium-hublot-spatial.mp4` | Planète vue d'un hublot | Wan 3.0 (720×1280) |

Encodage : H.264 `crf 26`, `+faststart`. Les vignettes `lucium-*.jpg` (180×320) sont prises à 2 s de chaque vidéo.

L'intensité du voile proposée avec chaque vidéo se déduit de sa vignette (luminosité moyenne des 60 % de gauche) : si une vidéo change, refaire la mesure décrite dans `src/shared/builtin-backgrounds.ts`.

Aucune vidéo de banque d'images (Mixkit) ici : leur licence permet de s'en servir dans un projet, pas de les redistribuer telles quelles.

## Origine

Ce que le dépôt établit :

- **Outil** : le service en ligne Higgsfield, avec l'abonnement payant du mainteneur. L'image fixe de départ vient du modèle GPT Image 2.6, l'animation du modèle indiqué dans le tableau (MiniMax H3 ou Wan 3.0).
- **Date** : le 6 novembre 2026 ; les fichiers sont entrés dans le dépôt le même jour.
- **Ce qui a été fait ensuite, dans ce projet** : la réduction en 1080×1920 pour trois d'entre elles, le fondu d'une seconde au raccord de la boucle, l'encodage et les vignettes, avec ffmpeg.
- **Ce que le dépôt ne contient pas** : les textes donnés au service pour générer les images et les animations, et les fichiers d'origine avant le montage.

## Licence : aucune

**Ces dix-huit fichiers n'ont aucune licence libre.** Ils ne sont ni sous la GPL-3.0-or-later du reste du dépôt, ni sous une licence Creative Commons. Le mainteneur les distribue avec Lucium en s'appuyant sur les conditions du service de génération, lues dans leur version du 23 octobre 2026 ; le projet ne promet à personne le droit de les réutiliser. La notice complète est à la racine : [`NOTICE-MEDIA.fr.md`](../../NOTICE-MEDIA.fr.md) (en anglais : [`NOTICE-MEDIA.md`](../../NOTICE-MEDIA.md)).

**Ne pas réencoder ces fichiers.** Ces conditions interdisent de retirer les signaux de provenance d'un fichier généré : les fichiers restent tels qu'ils sont entrés dans le dépôt. Si une vidéo doit changer, la refaire depuis le fichier rendu par le service, et l'écrire ici.
