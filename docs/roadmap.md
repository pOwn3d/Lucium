# Feuille de route

Ce que Lucium fait aujourd'hui, ce qui est prévu et ce qui est exclu. Le détail de chaque fonction, avec son réglage et sa valeur par défaut, est dans [`fonctions.md`](fonctions.md) et le [README](../README.fr.md). Ce qui reste à faire se suit dans les issues du dépôt.

## Disponible (1.0, macOS sur Apple silicon)

- **Barre latérale verticale** : espaces avec leur profil isolé et leur thème, favoris, onglets épinglés, dossiers imbriqués, onglets du jour, archivage automatique, glisser-déposer, sélection multiple.
- **Barre de commandes** (⌘T, ⌘L) : adresses, recherche, onglets ouverts et archivés, actions, recherche dans un site, complétion en ligne, suggestions, calculatrice.
- **Fonctions de navigation** : vue scindée (2 à 4 volets), Coup d'œil, Mini-fenêtre pour les liens d'autres applications, Retouches, image dans l'image automatique, contrôles média, captures, éditeur de thème d'espace, fenêtre Réglages, raccourcis modifiables, routage des liens, fenêtres multiples et fenêtre privée.
- **Ajouts de Lucium** : veille et gel des onglets, effacement des données d'un site, bloqueur de publicités et de traqueurs, mode lecture, visionneuse PDF, gestionnaire de mots de passe local, verrouillage, export chiffré, traduction de page sur ce Mac, résumé de page par un modèle local, en option (Ollama sur ce Mac ou sur un ordinateur du réseau local), et les autres options listées dans [`fonctions.md`](fonctions.md).
- **Extensions Manifest V3**, non empaquetées ou depuis le Chrome Web Store, avec le panneau latéral, `chrome.debugger`, `chrome.identity`, `chrome.downloads`, la messagerie native et les raccourcis d'extension. L'extension Claude est le cas vérifié du panneau latéral : voir [`compat-extension-claude.md`](compat-extension-claude.md).
- **Import** depuis votre navigateur actuel (signets et historique ; espaces, onglets, dossiers, thèmes, favoris, vues scindées et Retouches quand il les a) ou depuis un fichier de signets.
- **Variante DRM** pour les vidéos protégées : c'est elle que le mainteneur publie ; voir [`drm.md`](drm.md).
- **Téléchargement signé et notarisé** : une image disque `.dmg`, signée avec un Developer ID et notarisée par Apple, publiée sur lucium.app.
- **Mise à jour depuis l'application** : Lucium lit le flux de lucium.app, propose la nouvelle version et l'installe après votre clic ; un canal de test est en option (« Recevoir les versions de test »). Voir [`drm.md`](drm.md), section 12.
- **Clés d'accès (passkeys)** : disponibles (Touch ID, essayé sur un Mac). La fenêtre de macOS s'affiche, et la création puis la connexion réussissent après validation. Reste à mesurer : de vrais comptes sur de vrais sites, l'endroit où la clé est gardée (trousseau iCloud ou ce Mac seul), une clé de sécurité, un téléphone par code QR, d'autres Mac ([`cles-d-acces.md`](cles-d-acces.md)).

## Prévu

- **Autres plateformes** : les paquets Intel, Windows et Linux sont configurés mais n'ont jamais été construits ni essayés ([`plateformes.md`](plateformes.md)).
- **Finitions de l'interface** : quelques états restent à finir (dossier épinglé ouvert ou fermé, onglet épinglé actif ou survolé, menus de favori et de dossier, animations, lecteur multimédia, thème clair de la barre de commandes).
- **Extensions** : couverture plus large des API `chrome.*` ([`extensions-compatibilite.md`](extensions-compatibilite.md) dit ce qui marche aujourd'hui).
- **Clés d'accès dans le gestionnaire de mots de passe** : à l'étude ([`cles-d-acces.md`](cles-d-acces.md), section 4).
- **Synchronisation entre machines** : seulement si elle peut se faire sans service tiers (principe 5 de [`GOVERNANCE.fr.md`](../GOVERNANCE.fr.md)). En attendant, l'export chiffré et « Restaurer les données… » font passer un profil d'un Mac à l'autre.

## Exclu, par décision

- **Assistant IA** : ni discussion, ni agent qui agit sur les pages (principe 2 de [`GOVERNANCE.fr.md`](../GOVERNANCE.fr.md)). Seule exception : un résumé de page par un modèle local, en option.
- **Compte, synchronisation et partage cloud** : ils demandent un service.
- **Favoris « vivants »** (aperçus de messagerie ou d'agenda) : ils exigent des comptes et des API tierces.
- **Traduction de page par un service en ligne** : la traduction se fait sur ce Mac ([`traduction-locale.md`](traduction-locale.md)).
- **Easels et notes de la barre latérale** : exclus. Les « Notes rapides » de Lucium sont une fonction à part, gardée sur ce Mac.
- **Reprendre l'ordre des résultats de la barre de commandes d'un autre navigateur** : le code d'aucun autre navigateur n'est lu ; Lucium applique ses propres règles.

## Impossible dans Electron

Caster, un vrai flou d'arrière-plan derrière la barre de commandes, l'indicateur de caméra et de micro, le retour haptique, l'import des cookies et des mots de passe, et le choix « sur clic » ou « sur ces sites » de l'accès d'une extension aux sites.
