# Documentation

Les documents de ce dossier sont en français. Pour installer, construire et utiliser Lucium, commencer par le [README](../README.fr.md) ; pour contribuer, par [CONTRIBUTING.fr.md](../CONTRIBUTING.fr.md).

## Fonctionner et utiliser

- [reglages.md](reglages.md) : la fenêtre des Réglages en une page (« Pour commencer », la recherche, les préréglages, « Plus de réglages », « Réglages modifiés », les sous-pages, « Fonctions en option »).
- [fonctions.md](fonctions.md) : chaque fonction optionnelle, son réglage, sa valeur par défaut, ce qu'elle coûte et ce que libère sa désactivation.
- [recherche.md](recherche.md) : la barre de commandes (sources des propositions, mots-clés « ! », calculatrice) et la recherche dans la page.
- [gestionnaire-mots-de-passe.md](gestionnaire-mots-de-passe.md) : le coffre de mots de passe local, son modèle de menace et ses choix.
- [traduction-locale.md](traduction-locale.md) : la traduction des pages sur la machine et l'interface traduite.
- [telechargements-reprise.md](telechargements-reprise.md) : la reprise d'un téléchargement après un redémarrage.
- [api-materielles.md](api-materielles.md) : WebHID, WebUSB et Web Serial.
- [limites-web.md](limites-web.md) : ce que le web fait ailleurs et pas, ou pas tout à fait, dans Lucium (notifications push, Bluetooth, certificats client, partage d'un onglet, popups et cadres).
- [cles-d-acces.md](cles-d-acces.md) : les clés d'accès (passkeys, WebAuthn) : ce qui est établi, ce qui a été mesuré, ce qui reste à mesurer, et la sonde pour le mesurer.
- [accessibilite.md](accessibilite.md) : l'accessibilité de l'interface (lecteur d'écran, clavier).
- [design/annotation-partage-fenetre.md](design/annotation-partage-fenetre.md) : l'annotation de ce que l'on montre pendant le partage d'une fenêtre.
- [design/capture-du-son-d-un-onglet.md](design/capture-du-son-d-un-onglet.md) : le son d'un onglet remis à une extension par une page d'aide et un lien local, et pourquoi pas par une demande de média de la page.
- [roadmap.md](roadmap.md) : ce qui est disponible, prévu ou exclu.

## Extensions

- [extensions-compatibilite.md](extensions-compatibilite.md) : la compatibilité des extensions les plus répandues.
- [compat-extension-claude.md](compat-extension-claude.md) : l'extension Claude dans Lucium, un cas réel d'extension à panneau latéral.

## Construire, mesurer et publier

- [architecture.md](architecture.md) : la structure du code, le port moteur et la mise à jour de Chromium sans casse.
- [mise-a-jour-chromium.md](mise-a-jour-chromium.md) : la procédure de mise à jour d'Electron et de Chromium.
- [drm.md](drm.md) : construire et signer la variante DRM (Widevine).
- [plateformes.md](plateformes.md) : Windows, Linux, Mac Intel et Homebrew.
- [homebrew.md](homebrew.md) : le cask Homebrew, son générateur (`scripts/make-cask.mjs`) et le tap du projet, à créer à la 1.0.
- [performance.md](performance.md) : la mesure de la mémoire et du processeur (`pnpm perf`).
- [comparatif-navigateurs.md](comparatif-navigateurs.md) : le banc de comparaison avec d'autres navigateurs (`pnpm bench:browsers`).
- [licences-tierces.md](licences-tierces.md) : les licences des composants tiers.
- [images/](images/README.md) : les règles des captures d'écran de la documentation.
- [captures-du-site.md](captures-du-site.md) : les captures et le film du site public (`pnpm captures:site`, `pnpm film:site`).

## Communauté (en anglais)

- [community/index.md](community/index.md) : les façons de contribuer et où en parler.
- [community/maintainers.md](community/maintainers.md) : la relecture, l'intégration, les réglages du dépôt et son adresse.
- [community/public-repository.md](community/public-repository.md) : comment le dépôt public a été créé, par un seul commit, et ce qui a été contrôlé avant.
- [community/release-process.md](community/release-process.md) : la publication d'une version, la signature et la notarisation.
- [community/translations.md](community/translations.md) : les traductions de l'interface et de la documentation.
