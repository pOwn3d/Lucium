# Gouvernance

Comment Lucium est conduit. Le texte est volontairement court ; il grandira avec le projet.

[English](GOVERNANCE.md) · Français. Les deux versions disent la même chose et changent dans le même commit.

## Rôles

- **Contributeurs** : toute personne qui ouvre une issue, une discussion ou une pull request. Aucune autorisation n'est nécessaire. Les contributeurs gardent le droit d'auteur de leur travail, distribué sous GPL-3.0-or-later (voir [CONTRIBUTING.fr.md](CONTRIBUTING.fr.md)).
- **Mainteneurs** : relisent et intègrent les pull requests, trient les issues, font respecter le [Code de conduite](CODE_OF_CONDUCT.md), traitent les signalements de sécurité. Ils sont listés dans [`.github/CODEOWNERS`](.github/CODEOWNERS). Être mainteneur ne permet pas d'envoyer directement sur `main` : voir [les règles de `main`](#les-règles-de-main).
- **Mainteneur principal** : tranche quand les mainteneurs ne sont pas d'accord et garde la direction du projet conforme aux principes ci-dessous.
- **Versions** : la build de production et la publication d'une mise à jour reviennent au seul mainteneur principal. Il relit et vérifie tout ce qui entre dans une version, puis la construit, la signe, la fait notariser et la publie depuis son Mac ; aucun workflow ne le fait et aucun n'en détient les secrets ([processus de publication](docs/community/release-process.md#signing-and-notarization)). Personne d'autre ne publie une version de Lucium.

**Il y a aujourd'hui un seul mainteneur**, qui est aussi le mainteneur principal : [@pOwn3d](https://github.com/pOwn3d). Un contributeur propose son changement par une issue ou une pull request ; le mainteneur le relit, le corrige au besoin, l'intègre dans `main`, puis construit et publie la version. Avec un seul mainteneur, personne dans le projet ne relit une seconde fois ses propres changements, et personne dans le projet ne reçoit une plainte qui le vise : ce document ne promet pas le contraire.

Lucium a été créé par [ConsilioWeb](https://consilioweb.fr). Ce n'est pas un produit commercial : il n'y a pas d'édition payante, et il n'y en aura pas.

## Les règles de `main`

Ce sont les règles du dépôt public.

- **Tout changement passe par une pull request**, pour tout le monde, mainteneur compris. Personne n'envoie directement sur `main`.
- **Une pull request n'est intégrée que si ses contrôles requis passent** : typage, lint, tests unitaires sous Linux et sous macOS, une build non signée de l'application sous macOS, la signature (`Signed-off-by`) de chaque commit (le [Developer Certificate of Origin](https://developercertificate.org)) et un titre au format [Conventional Commits](https://www.conventionalcommits.org).
- **L'historique est linéaire et ses commits sont signés.** Le forçage (`force push`) de `main` et sa suppression sont refusés pour tout le monde.
- **La chaîne moteur et les tests de bout en bout ne sont pas des contrôles requis.** Ils pilotent une vraie application, ouvrent ses fenêtres et durent longtemps. Les tests de bout en bout tournent chaque nuit sur `main` ; la chaîne moteur tourne chaque semaine, sur un tag de version et à la demande. Les deux sont lus avant une publication ([processus de publication](docs/community/release-process.md)).
- **Relecture.** Le mainteneur relit la pull request d'un contributeur avant de l'intégrer. Tant qu'il n'y a qu'un mainteneur, ses propres pull requests n'ont pas de second relecteur : elles doivent passer les contrôles requis. Dès qu'il y a deux mainteneurs, une pull request demande l'approbation d'un mainteneur autre que son auteur.

## Comment les décisions sont prises

- **Tout se passe dans le dépôt.** Un changement est une pull request ; les raisons d'une décision sont écrites dans l'issue, dans la pull request ou dans `docs/`.
- **Petites modifications** (une correction, une doc, un test) : une pull request, intégrée une fois relue et ses contrôles passés.
- **Modifications importantes** (architecture, nouvelle dépendance, changement d'un comportement visible, changement du format du fichier d'état) : proposées dans une issue ou une discussion, ouvertes aux commentaires au moins **7 jours** avant la décision, et consignées dans l'issue ou dans `docs/`. Un changement de principe suit la règle des principes, plus bas.
- On cherche le **consensus**. À défaut, les mainteneurs décident à la majorité ; le mainteneur principal départage, et décide seul tant qu'il est le seul mainteneur. Les raisons sont écrites.
- Toute décision peut être rouverte avec des faits nouveaux.

## Devenir mainteneur

Il n'y a ni quota ni examen. Un contributeur est invité par les mainteneurs en place après :

- plusieurs contributions intégrées sur quelques mois, de bonne qualité et conformes aux conventions ;
- des relectures et un tri des issues utiles et constructifs ;
- une bonne compréhension des principes et de la structure du projet ;
- le respect du Code de conduite.

Un mainteneur active l'authentification à deux facteurs sur son compte GitHub et s'engage à suivre ce document. Les droits sont donnés par GitHub (et `CODEOWNERS`). Ils couvrent la relecture et l'intégration ; construire et publier une version reste au mainteneur principal.

Un mainteneur inactif longtemps (environ un an) qui ne répond pas passe au statut d'émérite et perd ses droits, avec nos remerciements. Il peut revenir sur demande.

## Droit d'auteur, licence et nom

**Copyright © 2026 ConsilioWeb and contributors.** Lucium est distribué sous **GPL-3.0-or-later** ([LICENSE](LICENSE)). ConsilioWeb détient le droit d'auteur du code qu'il a écrit ; chaque contributeur garde le droit d'auteur de ce qu'il apporte. Les contributions entrent sous la même licence et avec sa permission additionnelle pour le module Widevine ([ADDITIONAL-PERMISSION.txt](ADDITIONAL-PERMISSION.txt), en anglais), avec la signature du Developer Certificate of Origin et **sans cession** : il n'y a pas d'accord de licence de contributeur. [NOTICE](NOTICE) (en anglais) dit qui détient quoi et quels composants sont sous une autre licence.

La licence couvre le code. Elle ne donne aucun droit sur le nom « Lucium » ni sur le logo comme signes de ce projet : [TRADEMARKS.fr.md](TRADEMARKS.fr.md) dit ce qu'une version modifiée doit changer.

## Principes non négociables

Ils définissent ce qu'est Lucium. Ils ne se décident ni par un vote ni par une pull request.

1. **Logiciel libre, pour toujours.** GPL-3.0-or-later. Pas d'édition payante, pas de fonction derrière un paiement, pas de changement vers une licence propriétaire, pas de publicité.
2. **Pas d'assistant IA intégré.** Pas de discussion, aucun agent qui agit sur les pages. Seule exception : un résumé de page par un modèle local, en option. Ce modèle tourne sur l'ordinateur de l'utilisateur (Ollama), reste éteint tant que l'utilisateur ne l'active pas, et n'est interrogé qu'à une adresse de cet ordinateur. Aucun fournisseur d'IA en ligne n'est appelé, et le projet ne fait tourner et ne paie aucun service d'IA.
3. **Pas de compte** pour utiliser le navigateur.
4. **Pas de télémétrie**, aucune donnée d'usage envoyée à qui que ce soit.
5. **Pas de synchronisation cloud** passant par un service exploité par le projet ou par une entreprise.
6. **Aucune reprise de code ni d'asset propriétaire**, ceux des autres navigateurs compris : seuls le comportement et la disposition observables sont reproduits.

Changer l'un d'eux changerait la nature du projet : cela demande un amendement explicite de ce fichier, une discussion publique d'au moins 30 jours et l'accord de tous les mainteneurs.

Qui n'est pas d'accord reste libre de dupliquer le projet (fork) : la licence est faite pour cela.

## Modifier ce document

Par pull request, avec les règles d'une modification importante ; un changement de principe suit la section précédente. [GOVERNANCE.md](GOVERNANCE.md) change dans le même commit.
