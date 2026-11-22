# Les Réglages de Lucium

⌘, ouvre la fenêtre des Réglages sur « Pour commencer ». À gauche, la barre latérale : la recherche, « Pour commencer », les huit catégories (Apparence, Onglets et fenêtres, Navigation, Vie privée et sécurité, Téléchargements et fichiers, Extensions et outils, Clavier et souris, Profils), puis « Fonctions en option » et « À propos et mises à jour ». À droite, la page choisie. Tout ce que vous changez s'applique tout de suite : il n'y a pas de bouton « Enregistrer ».

## Pour commencer

Les choix que presque tout le monde fait en arrivant, réunis sur une page : le navigateur par défaut, l'import depuis un autre navigateur, la langue, l'apparence et la taille de l'interface, le côté de la barre latérale, le niveau de protection, le gestionnaire de mots de passe, le moteur de recherche, les liens venus d'autres applications, ce qui se rouvre au lancement, la mise en veille et l'archivage des onglets, le dossier des téléchargements. Ce sont les mêmes réglages que dans leur catégorie, pas des copies : le lien « Ouvrir « … » » au pied d'un groupe mène à sa catégorie.

Au pied de la page, le bouton **« Découvrir ce que Lucium sait faire »** ouvre « Découvrir Lucium » (le panneau qui montre les fonctions par tâche, avec où les trouver, leur raccourci, « Essayer » et « Régler » vers le réglage), à côté de « Voir les fonctions » qui mène à « Fonctions en option ». Chaque « Régler » de ce panneau ouvre la page des Réglages qui tient la fonction ; le panneau ne change jamais un réglage lui-même.

La carte **« Régler en quelques questions »** pose les questions les plus courantes, une à la fois (34 au plus), puis montre ce qui va changer. Rien ne change avant « Appliquer », et « Annuler » remet tout comme avant.

## Chercher un réglage

Tapez dans le champ en haut de la barre latérale (⌘F, ou la touche /). La recherche lit les réglages tels qu'ils s'affichent, et comprend aussi les mots de tous les jours :

- « mode sombre » trouve « Apparence de Lucium » ;
- « ne pas me suivre » trouve le signal GPC ;
- « vpn » trouve le proxy, « sauvegarde » les copies automatiques, « mémoire » la mise en veille ;
- « taille du texte » trouve « Taille de l'interface ».

Le meilleur résultat est nommé en haut, et Entrée l'ouvre là où il vit. Quand vous cherchez quelque chose qui n'est pas un réglage, la recherche dit où le trouver : « importer » donne la commande du menu Lucium, « page d'accueil » explique qu'un nouvel onglet ouvre la barre de commandes. Échap vide la recherche.

## Les préréglages

Quatre réglages en regroupent plusieurs : **Niveau de protection** (Standard, Renforcée, Stricte), **Mettre en veille les onglets inactifs**, **Quand vous ouvrez Lucium** et **Liens venus d'autres applications**. Un choix règle d'un coup tous les réglages qu'il concerne ; une ligne sous le choix dit ce que fait l'option, et une notice dit combien de réglages ont changé, avec « Annuler » pendant quelques secondes. Quand vos réglages ne correspondent à aucune option, parce que vous les avez changés un par un, le préréglage affiche « Personnalisé » et les laisse tels quels.

Un nouveau profil commence en protection **Renforcée** : publicités, traqueurs et bannières de cookies bloqués, paramètres de suivi retirés des adresses ouvertes et copiées, signal « ne pas me suivre » envoyé. Un profil d'avant la 1.1.0 garde ses choix de protection : rien ne change pour lui, et son niveau reste celui qu'il avait (Standard, sauf choix de votre part).

## Plus de réglages

Chaque page montre en haut ce qu'on change le plus souvent. Le reste est dans **« Plus de réglages »**, au pied de la page : sa ligne dit quels groupes il contient et combien de réglages, avant même de l'ouvrir. Aucun autre réglage n'est replié. Un lien ou un résultat de recherche qui mène à un réglage rangé là ouvre « Plus de réglages » tout seul.

## Les sous-pages

Une liste ou un éditeur a sa propre sous-page : les listes de filtres, le DNS chiffré et le proxy, les exceptions par site, les raccourcis clavier, les sites gardés éveillés… La rangée qui l'ouvre dit déjà où vous en êtes (« 3 sites », « Coupé »). « Revenir à … », en haut de la sous-page, ou Échap, ramène à la page.

## Réglages modifiés et Rétablir

Un point après un réglage veut dire qu'il n'est plus à sa valeur par défaut ; un point dans la barre latérale signale une page qui en contient. **« Rétablir »**, sur la rangée, remet ce réglage (tous ceux d'un préréglage) ; « Rétablir les valeurs par défaut », au pied d'une page, remet ceux de la page. **« Réglages modifiés »**, au pied de la barre latérale, liste tout ce que vous avez changé, page par page, avec « Tout rétablir ». Chaque fois, une notice propose « Annuler ». Ce que vous avez saisi ou construit (listes de sites, règles, raccourcis, verrouillage) n'est jamais remis par ces boutons.

Pour la protection (le niveau et ses quatre réglages), la valeur par défaut est celle du profil à son départ : **Standard** pour un profil d'avant la 1.1.0, **Renforcée** pour un profil neuf. Un profil d'avant n'y est donc pas marqué « modifié » pour des réglages qu'il n'a jamais touchés, et « Rétablir » le ramène à Standard, non à Renforcée. Cette référence est posée une fois, à la lecture du fichier d'état, et ne change plus ensuite : ni un retour au défaut, ni un choix de niveau ne la modifient. Une exportation d'avant la 1.1.0 que l'on restaure a elle aussi Standard pour référence.

## Fonctions en option

Ce que Lucium sait faire en plus : arbre d'onglets, conteneurs, notes rapides, code QR, lecture à voix haute… Une ligne par fonction, rangée par thème, avec son interrupteur, ce qu'elle fait en une phrase et ce qu'elle coûte quand elle est allumée. **Coupée, une fonction ne coûte rien.** « En savoir plus » donne le détail. Le détail technique de chaque fonction est dans [fonctions.md](fonctions.md) ; le clavier dans la fenêtre, dans [accessibilite.md](accessibilite.md).
