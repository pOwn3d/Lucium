# Journal des changements

Les changements visibles de Lucium, en français. C'est ce texte que la feuille « Nouveautés » de l'application montre quand l'interface est en français ; la référence est [CHANGELOG.md](CHANGELOG.md), en anglais, publié avec chaque version. Chaque ligne ajoutée là-bas est ajoutée ici, avec le même titre en gras suivi de deux-points.

## [Unreleased]

### Ajouts

- **Licence, App Store** : une seconde permission additionnelle (GPL version 3, article 7) permet au mainteneur de distribuer l’application iPhone et iPad par l’App Store d’Apple et TestFlight, ses sources restant complètes sous GPL. Texte : `ADDITIONAL-PERMISSION-APP-STORE.txt` et `NOTICE`. L’application n’est pas encore publiée.

### Changements

- **Windows, une seule barre** : la fenêtre principale, les autres fenêtres et les fenêtres privées, et celles d’un site ouvert comme application dessinent leur propre barre de titre, comme sur le Mac. Les trois boutons de Windows sont posés sur la barre d’outils, aux couleurs du thème (ils le suivent, ainsi que la couleur qu’une page demande pour sa barre), et la barre de menus est remplacée par un bouton ☰ au début de la barre d’outils, qui ouvre le même menu, avec les mêmes raccourcis. La mini-fenêtre et les Réglages gardent la barre de titre de Windows. Vu dans une machine virtuelle Windows 11, à l’échelle de 100 % ; les autres échelles et un vrai PC ne sont pas encore essayés.

### Corrections

- **Onglets en veille, Précédent et Suivant** : un onglet mis en veille pour libérer sa mémoire ne gardait que son adresse et se réveillait sans la liste des pages parcourues. La liste était lue une fois la page déjà fermée. Elle est maintenant lue juste avant la fermeture, et l’onglet se réveille avec ses pages Précédent et Suivant.
- **Windows, liens sous un nom de fichier** : les fichiers que Lucium écrit (état, historique, coffre, téléchargements) et un téléchargement qui reprend ne sont plus ouverts à travers un lien laissé sous leur nom. Windows ne peut pas faire refuser un lien à `open` : le nom est maintenant regardé d’abord.
- **Navigateur par défaut, Windows** : les Réglages ne disent plus que Lucium est le navigateur par défaut quand Windows ouvre les liens dans un autre. L’état est celui que Windows garde pour http et https, relu à votre retour, et « Définir comme navigateur par défaut » ouvre les Paramètres de Windows sur Lucium, où le choix vous revient.
- **Dictionnaires du correcteur, Windows et Linux** : Chromium ne télécharge plus, au premier lancement et correcteur éteint, le dictionnaire de la langue du système depuis son CDN. Une session démarre sans langue : rien n’est téléchargé avant que vous activiez l’orthographe dans le menu Édition.
- **Extensions sans service worker** : un clic sur l’icône d’une extension faite de pages seules (une fenêtre contextuelle, pas de worker en arrière-plan) ouvre sa fenêtre tout de suite et non après 10 secondes, et Lucium n’écrit plus d’échec de démarrage pour elle. Il lit le manifeste, qui dit qu’il n’y a aucun worker à attendre.

## [1.1.3] - 2026-11-17

Un lien glissé d’une autre application s’ouvre dans un nouvel onglet, « Ouvrir avec » propose Lucium pour les PDF et les images, un dossier peut porter un emoji, et la mini-fenêtre s’ouvre au centre et au premier plan. Une icône de site piégée ne peut plus figer Lucium, et la boîte de mise à jour nomme la version réellement téléchargée.

### Ajouts

- **Liens déposés sur une fenêtre** : un lien glissé d’une autre application (un message, un document, un terminal) sur une fenêtre de Lucium s’ouvre dans un nouvel onglet, dans l’espace affiché. Seules les adresses http et https sans nom ni mot de passe s’ouvrent, dix au plus ; une notification dit combien ont été laissées de côté.
- **Ouvrir avec** : « Ouvrir avec » du Finder propose Lucium pour les documents PDF et les images (PNG, JPEG, GIF, WebP, SVG), jamais comme application par défaut.
- **Icônes de dossier** : « Changer l’icône… » dans le menu d’un dossier lui met un emoji à la place du dessin, avec le sélecteur des espaces, pour un dossier créé à la main comme pour un dossier en direct. « Retirer l’icône » rend le dessin ; sans emoji, rien ne change.

### Changements

- **Mini-fenêtre centrée et au premier plan** : une mini-fenêtre s’ouvre au milieu de l’écran d’où vient le lien (celui du pointeur pour un lien d’une autre application) et reste au-dessus des autres fenêtres. « Nouvelle mini-fenêtre » s’ouvre là aussi. Elle ne passe pas encore au-dessus d’une application en plein écran.

### Corrections

- **Icônes de site** : un fichier d’icône piégé, un kilooctet de commentaires à la suite, pouvait figer Lucium : la vérification qui distingue une icône vectorielle d’une page d’erreur prenait un temps exponentiel. Elle lit maintenant le début du fichier en temps linéaire.
- **Fenêtre invité, langue** : une fenêtre invité utilise désormais la langue d’interface choisie dans la fenêtre principale, et non celle du système. Sur un Mac en anglais dont l’interface est réglée en français, elle passait la barre des menus et ses propres messages en anglais dès qu’elle prenait le focus.
- **Icône de l’application, autres profils** : un second Lucium lancé sur un autre profil (test, capture, mesure) ne retire plus l’icône choisie dans votre profil de l’application. Seul le profil qui l’a posée la retire, quand il revient à l’icône par défaut.
- **Mise à jour, version annoncée et retrait** : après « Installer », la boîte et le retrait d’une version suivent la version que Squirrel a réellement téléchargée, et non celle de l’offre lue plus tôt. Une version publiée entre l’offre et le clic était annoncée comme l’ancienne.

## [1.1.2] - 2026-11-17

La connexion sur accounts.google.com et accounts.youtube.com ne reste plus sur une page blanche après une redirection, comme elle le pouvait dans la 1.1.1.

### Corrections

- **Connexion aux comptes, page blanche** : sur accounts.google.com et accounts.youtube.com, une connexion qui passait par une redirection pouvait rester sur une page blanche. L’identité du moteur ne change plus qu’au départ d’une navigation ; une redirection vers ces hôtes, ou depuis eux, est annulée et relancée comme une navigation à part.

## [1.1.1] - 2026-11-16

Un bouton ouvre la page Extensions depuis le panneau du site, un cadre choisit la zone visible d’une vidéo de fond, et un script qu’une extension injecte après un clic sur son icône retrouve chrome.runtime, chrome.storage et les messages. Des comptes refusés sur accounts.google.com s’y connectent.

### Ajouts

- **Page Extensions, en un clic depuis le panneau du site** : la rangée des extensions du panneau du site se termine par un bouton en pièce de puzzle qui ouvre la page Extensions dans un onglet (celle que désigne chrome://extensions), à côté de « + » et du dossier, que le Web Store soit activé ou non.
- **Fond vidéo, choisir la zone visible** : une vidéo plus large ou plus haute que la barre latérale s’affiche entière, dans « Personnaliser l’espace » et l’éditeur de thème, avec un cadre de la forme de la barre. On le fait glisser, ou on le déplace avec les flèches, pour choisir la zone visible ; « Recentrer la vidéo » revient au milieu. Gardé par espace.

### Changements

- **Liste des suffixes publics** : mise à jour. Une Retouche partagée (lien ou fichier) visant `kawasaki.jp` ou `compute.amazonaws.com`, qui désignent chacun une famille entière de sites, est maintenant refusée, comme l’était déjà celle qui vise `co.uk` ou `github.io`.

### Corrections

- **Extensions, script injecté après un clic** : un script qu’une extension injecte dans un onglet remis d’un clic sur son icône (`activeTab`) a maintenant `chrome.runtime`, `chrome.storage` et les messages avec son worker, comme le dit l’API des extensions. Avant, il n’en avait aucun : le script devait être déclaré au manifeste.
- **Journal des extensions** : une page d’extension sans isolation de contexte (document hors écran, page d’arrière-plan d’un Manifest V2) ne remplit plus « Erreurs et journal » de chrome://extensions de cinq avertissements qui ne sont pas les siens : quatre sur contextBridge, un de la bibliothèque d’extensions.
- **Connexion aux comptes** : sur accounts.google.com et accounts.youtube.com, Lucium montre l’identité propre du moteur (son user agent, pas de `window.chrome.app`, aucun indice client ajouté), non celle d’un navigateur ordinaire. Des comptes refusés là (« Ce navigateur ou cette application ne sont peut-être pas sécurisés ») s’y connectent.

## [1.1.0] - 2026-11-13

### Ajouts

- **Vues de travail** : une tuile après les favoris ouvre en un clic, en vue scindée, 2 à 4 sites choisis à l’avance, à leur place et dans leurs proportions ; un second clic la ramène telle qu’on l’a laissée. On l’enregistre par le clic droit d’un onglet de la vue scindée ou le menu « + » ; la barre de commandes et le Dock la proposent aussi.
- **Proxy d’un profil, onglets qui n’en profitent pas** : un onglet en conteneur ou un onglet privé sort par le proxy général, jamais par celui de son profil. Quand son profil a un proxy qui envoie le trafic autrement, l’onglet porte une petite marque, avec une infobulle qui dit pourquoi.
- **Annotation de la page, touches d’une seule lettre** : un interrupteur « Touches d’une seule lettre pour annoter », allumé par défaut, dans Réglages › Fonctions en option. Coupé, les lettres des outils, E et X (qui efface toutes les pages de la session) ne font rien et la page les garde ; les boutons de la barre, ⌘Z, ⌥⌘⌫, ⇧⌥⌘⌫ et Échap restent.
- **Réglages plus simples** : une recherche qui comprend vos mots, des préréglages, rien de caché. La fenêtre a une barre latérale ; chaque page montre en haut ce qui compte et range le reste dans « Plus de réglages », qui dit ce qu’il contient.
- **Réglages, Pour commencer** : la première page réunit les choix des premières minutes (thème, taille, moteur, protection, mots de passe, lancement, veille, archivage, téléchargements, langue, navigateur par défaut, import), ceux de leur catégorie, pas des copies. Le guide « Régler en quelques questions » n’a plus que cette entrée.
- **Réglages, préréglages** : « Niveau de protection » (Standard, Renforcée, Stricte), la mise en veille, le lancement et les liens venus d’autres applications se règlent d’un choix qui écrit plusieurs valeurs, en tête de leur page. Une notice dit combien ont changé, avec « Annuler » ; « Personnalisé » quand rien ne correspond.
- **Réglages modifiés** : une rangée qui n’est plus à sa valeur par défaut porte un point et « Rétablir », qui remet aussi tous les réglages d’un préréglage, et sa page un point. « Réglages modifiés », au pied de la barre latérale, les montre tous avec leur contrôle et « Tout rétablir » ; chaque retour au défaut s’annule pendant 8 s.
- **Réglages, Fonctions en option** : les 29 fonctions à ajouter (arbre d’onglets, conteneurs, volets web, notes, code QR…) quittent leur catégorie pour cette page : une ligne chacune, avec la première phrase de ce qu’elle fait, son coût dit en une phrase et « En savoir plus ». Les autres rangées ne portent plus de repère de coût.
- **Réglages, sous-pages** : les listes et les éditeurs (sites gardés éveillés, exceptions par site, listes de filtres, DNS chiffré et proxy, autorisations mémorisées, raccourcis clavier…) s’ouvrent sur une page à part, depuis une rangée qui dit leur état (« 3 sites »). Le retour ou Échap ramène à cette rangée ; la recherche les trouve toujours.
- **Fonctions en option, filtre** : « Toutes / Allumées / Coupées », au-dessus du catalogue, ne garde que les fonctions dans un état, dans l’ordre des thèmes, et dit combien de lignes il montre ; les flèches le règlent. Un résultat de recherche vers une fonction cachée repasse sur « Toutes ».
- **Fond d’un espace, voile automatique** : une image ou une vidéo que vous ajoutez reçoit un voile réglé d’après sa clarté, sombre avec un texte clair ou clair avec un texte sombre, pour que le titre des onglets, même en veille, reste lisible (4,5:1). Un réglage à la main est gardé ; « Revenir au réglage automatique » mesure de nouveau.
- **Image dans l’image des appels vidéo** : le bouton d’un site de visioconférence qui ouvre une petite fenêtre au-dessus des autres, avec ses boutons (micro, caméra, raccrocher), l’ouvre. Elle garde la session du site et se ferme avec sa page. À l’essai et coupée par défaut (Fonctions en option) : coupée, la demande échoue comme avant, sans onglet.
- **Extensions, écouteurs bloquants** : les écouteurs bloquants `chrome.webRequest` d’une extension Manifest V2 chargée depuis un dossier agissent : annulation, redirection (vers le web ou ses fichiers), en-têtes ajoutés ou retirés, identifiants d’une connexion. Une requête les attend une seconde au plus ; en Manifest V3, ils restent informés seulement.
- **Notes, toutes les notes** : sous l’en-tête du panneau, « Cette page », « Cet espace » et « Toutes » choisissent ce que montre la liste, avec son compte et sa recherche. Le panneau s’ouvre sur la page quand elle a des notes, sinon sur toutes ; chaque note dit à quoi elle est liée et s’ouvre sans changer d’onglet.
- **Notes, un seul bouton dans la barre** : le bouton « Nouvelle note » disparaît ; « Toutes les notes » reste et ouvre le panneau sur « Toutes », où l’on crée aussi une note (Fichier › Nouvelle note et ⌥⌘E marchent toujours). Un interrupteur dans Réglages › Fonctions en option, sous Notes ; jamais en fenêtre privée.
- **Fichiers du disque** : une page, un PDF, une image, un texte ou une vidéo s’ouvre dans un onglet par un double-clic dans le Finder, « Ouvrir avec Lucium » ou l’icône du Dock, et quand on la dépose sur une fenêtre (dix au plus à la fois). Un type qu’un onglet téléchargerait est refusé, avec un message.
- **Extensions, son d’un onglet** : une extension peut capter le son d’un onglet (`chrome.tabCapture`), jamais son image : sous-titres d’une visio, enregistreur. Éteint pour chaque extension tant que vous ne l’avez pas autorisée dans ses détails ; l’onglet devient muet pour vous, porte un repère et s’arrête depuis là. Un réglage coupe tout.

### Changements

- **Contraste avec la fenêtre translucide ou un voile très léger** : l’aide de « Effet de verre de la fenêtre », de « Opacité de la barre latérale » et d’un voile réglé à la main dit que le contraste minimal du texte n’y est plus garanti. Le voile automatique d’un fond ajouté le garde.
- **Barres de défilement, comme le dit le Mac** : quand « Toujours afficher les barres de défilement » est réglé (Réglages Système › Apparence), les listes qui cachent leur barre (onglets de la barre latérale, espaces, sélecteur d’onglets, résultats de la mini-fenêtre…) la montrent. Lucium suit le réglage quand il change.
- **Notices avec une action, une durée et une pause** : « Annuler », « Rouvrir » et les autres restent 8 secondes partout (barre latérale, Réglages, suppressions des listes, recherche d’onglets, gestionnaire de tâches, barre de commandes après ⇧⌫ ; c’était 5, 6 ou 8) et attendent tant que le pointeur ou le focus est dessus, puis reprennent avec le temps restant.
- **Nouveaux profils, protection Renforcée par défaut** : un profil neuf bloque aussi les bannières de cookies, retire les paramètres de suivi des adresses ouvertes et copiées, et envoie le signal Global Privacy Control. Un profil d’avant garde ses choix et a Standard pour référence : rien n’y est marqué « modifié », et « Rétablir » ramène à Standard.
- **Réglages, barre latérale** : les tuiles deviennent une barre latérale : « Pour commencer », huit catégories (Apparence, Onglets et fenêtres, Navigation, Vie privée et sécurité, Téléchargements et fichiers, Extensions et outils, Clavier et souris, Profils), « Fonctions en option » et « À propos et mises à jour ». Les anciennes adresses suivent.
- **Réglages, Plus de réglages** : le choix « Essentiel / Tous les réglages » disparaît. Chaque page range ce qui n’est pas en haut dans un seul repli à son pied, « Plus de réglages », dont la ligne nomme les groupes qu’il contient : plus aucun réglage n’est caché sans que la page le dise.
- **Recherche des Réglages** : elle ignore les mots courants (« taille du texte », « ne pas me suivre »), cherche au début des mots, lit les choix des menus (« mode sombre »), comprend les tournures usuelles en français et en anglais, met le meilleur résultat en tête (Entrée l’ouvre) et dit où trouver ce qui n’est pas un réglage.
- **Réglages, textes** : chaque réglage dit son aide en une ligne ; le détail (mécanisme, limites, cas à part) passe derrière « En savoir plus », qui garde le texte d’avant en entier. Les notes des groupes suivent la même règle, et un message qui renvoie aux Réglages écrit le chemin d’après les noms des pages.
- **Réglages, noms** : « Garder l’historique des pages visitées » remplace « Ne jamais enregistrer l’historique » et s’allume quand l’historique est gardé, dans Profils aussi. Le verrouillage, le signal GPC et les pop-up sont nommés par ce qu’ils font ; deux groupes deviennent « Pistage et HTTPS » et « Empreinte et règles étendues ».
- **Lecture automatique, un réglage par site** : l’interrupteur « Un réglage pour chaque site », un réglage d’un réglage, disparaît. Le choix d’un site s’applique toujours et « Infos et réglages du site » le propose toujours ; un profil qui l’avait coupé retrouve les choix déjà faits, listés dans Autorisations mémorisées.
- **chrome://flags** : l’adresse ouvre « Fonctions en option », où sont les fonctions à ajouter, au lieu de « Pour commencer ».
- **Régler en quelques questions, un seul nom** : « Configuration rapide » disparaît. Le menu Aide, la barre de commandes, la feuille d’import et le premier lancement nomment le guide comme sa carte, « Régler en quelques questions » ; la recherche le trouve toujours sous « configuration rapide ».
- **Réglages, la dernière page** : Réglages… (⌘,) rouvre la fenêtre sur la page et la sous-page qu’elle montrait à sa fermeture, tant que Lucium reste ouvert, et la laisse où elle est quand elle est déjà ouverte ; « Pour commencer » la première fois. Un menu, un lien ou une adresse ouvrent toujours leur place. Rien n’est écrit sur le disque.
- **Réglages, côté de la barre latérale** : un menu « À gauche / À droite », nommé « Côté de la barre latérale », remplace l’interrupteur « Placer la barre latérale à droite de la fenêtre », dans Apparence et sur « Pour commencer ». Le réglage enregistré ne change pas.
- **Raccourcis clavier, « Réinitialiser » sur une ligne** : « Annuler la réinitialisation » reste proposé 8 secondes au lieu de 6, comme « Annuler » après « Rétablir » dans les Réglages.
- **Lecture et pause, un seul dessin** : la vidéo flottante, la vidéo de fond d’un espace, la pause et la reprise d’un téléchargement et la carte animée d’un réglage montrent les icônes Lecture et Pause du lecteur multimédia, au lieu d’en dessiner chacune une à sa façon.
- **Des milliers d’onglets** : la barre de commandes s’ouvre et répond à chaque touche sans attendre, même avec des milliers d’onglets dans un espace (jusqu’à un dixième de seconde par touche). Chaque changement d’un onglet et le lancement coûtent aussi moins quand il y a beaucoup d’onglets, d’espaces et de favoris.

- **Page Extensions, dossier Manifest V2** : la page Extensions charge, recharge et empaquette un dossier en Manifest V2, comme le faisait déjà Réglages › Extensions, et avertit sur la carte, sous « Détails » et au chargement que le format est ancien et que certaines fonctions peuvent manquer. Le Chrome Web Store n’installe toujours que du Manifest V3.
- **Application plus légère** : React n’est plus dans `app.asar`, où l’interface l’a déjà dans ses paquets et que le processus principal ne charge jamais (8 Mo de moins).
- **Image dans l’image automatique, plus tôt** : une vidéo que l’on regarde flotte quand on quitte son onglet après 2 secondes de lecture au lieu de 3, pour qu’un direct qu’on vient d’ouvrir (sur Twitch, par exemple) flotte tout de suite.
- **Page Extensions, dans un onglet** : `chrome://extensions` (et `/?id=<id>`, `/shortcuts`) s’ouvre dans un onglet de la fenêtre, avec la même page, et non plus dans une fenêtre à part ; un onglet qui la montre déjà est sélectionné. Pas en fenêtre privée ou invitée. Aucune page web ne peut l’ouvrir ni la lire, et les extensions ne l’atteignent pas.

### Suppressions

- **Import depuis un navigateur à barre latérale, Retouches** : la catégorie « Retouches » disparaît de cet import et du premier lancement. Ce navigateur ne garde pas ses retouches de sites sur le Mac : elle n’importait jamais rien. « Importer une Retouche… » reste pour les fichiers de Lucium.

### Corrections

- **Aide › État de Lucium** : le menu ouvre « À propos et mises à jour » sur le groupe « État de Lucium », déplie « Plus de réglages » et y pose le focus, au lieu du groupe « À propos ». Le bouton « Voir le journal » d’une erreur interne y mène aussi, et un lien vers un groupe des Réglages met le focus sur son titre.
- **Sites et suffixes publics** : Lucium lit maintenant la liste exacte des suffixes publics pour ses propres décisions (tiers du bloqueur en mode Standard, entrées voisines du coffre, liens d’une fenêtre d’application). La liste compacte qu’il lisait prenait quelques domaines ordinaires pour des suffixes (`q8x.io`) et coupait un tel site en deux.
- **Fenêtres aux onglets indépendants** : supprimer un conteneur ferme aussi ses onglets dans les autres fenêtres ; « Exporter les données » écrit les onglets de toutes les fenêtres ; un site à effacer à la fermeture ne l’est qu’à la fermeture de son dernier onglet, toutes fenêtres comprises ; un import ne remplace plus un onglet d’une autre fenêtre.
- **Effacer à la fermeture** : quand une seule action vide plus de vingt sites de la liste (un espace supprimé, « Vider les onglets du jour »), tous sont effacés, et non les vingt premiers.
- **Coup d’œil pour les liens vers d’autres sites** : « Ouvrir le lien dans un nouvel onglet », dans le menu d’un lien, ouvre un onglet, comme il le dit, au lieu d’un Coup d’œil quand l’option est allumée.
- **Enregistrer en PDF avec l’adresse** : le nom proposé garde tout le titre de la page ; une « / » ou un « : » y devient un tiret (« AC/DC » donne « AC-DC.pdf »), au lieu de ne garder que ce qui suit la dernière « / ».
- **Fenêtres aux onglets indépendants, signets** : « Exporter les signets (HTML) », avec les onglets du jour, écrit ceux de toutes les fenêtres, comme « Exporter les données », et non plus ceux de la seule fenêtre qui exporte.
- **Fenêtres aux onglets indépendants, « Gérer les espaces »** : le nombre d’onglets de chaque espace, celui du titre et celui de la notice de suppression comptent les onglets de toutes les fenêtres, que la suppression ou la mise de côté de l’espace ferment aussi.
- **Fenêtres aux onglets indépendants, vues scindées** : une vue scindée dont un volet passe dans une autre fenêtre (glissé, ou épinglé puis désépinglé ailleurs) reste à la fenêtre qui en garde le plus de volets, ou se défait, au lieu de disparaître des deux fenêtres en gardant ses onglets liés.
- **Extensions, `chrome.downloads`** : la fin d’un téléchargement (`endTime`) est le moment où il s’est terminé, et non plus celui où l’extension pose la question.
- **Capture de la page entière** : une page très large est coupée à 16 000 pixels de large, comme elle l’était déjà en hauteur, au lieu d’une image qui pouvait épuiser la mémoire.
- **Traduction, langue de la page** : la langue d’une page quittée avant d’avoir été lue n’est plus prise pour celle de la page suivante, qui proposait alors de traduire depuis une autre langue que la sienne.
- **Clavier, onglets et barres d’outils** : dans l’éditeur de Retouches, les flèches vont d’onglet en onglet (Style, Code, puis CSS, JS, Gomme) ; dans la barre d’annotation, de bouton en bouton. Tab ne s’arrête que sur l’onglet affiché. Les commandes de la vidéo flottante ne sont plus annoncées comme barre d’outils : les flèches y déplacent la lecture.
- **Éditeur de Retouches, le champ du code** : une ligne sous le CSS et le JavaScript dit que Tab y ajoute deux espaces, et comment quitter le champ (⇧Tab, ou Échap pour revenir à Style). Un lecteur d’écran la lit avec le champ.
- **Éditeur de Retouches, les Retouches du site** : la croix qui supprime une Retouche est une cible de 24 pixels à côté de son nom, et non plus de 22 pixels posée sur le bord du nom, où un clic pouvait ouvrir la Retouche à la place.
- **Lecteur multimédia et vidéo flottante, contraste** : le bouton pause d’un onglet coupé, qui met toujours en pause, est dessiné à 3:1 et n’est plus annoncé comme indisponible. « EN DIRECT » est écrit sur un rouge plus sombre (5,2:1), et la bande derrière le nom du site reste sombre jusqu’au pied du nom, qui garde 4,5:1 sur une image blanche.
- **Capture d’une zone, au clavier** : une flèche montre une zone au milieu de la fenêtre, les flèches la déplacent, ⇧ et les flèches la redimensionnent, Entrée la capture. La barre le dit, et les boutons Page entière et Fenêtre visible nomment leur touche, 2 et 3.
- **Annoter une capture, au clavier** : l’image est un arrêt de Tab. Les flèches y déplacent un point (⇧ pour aller plus vite), Entrée y commence puis termine une forme, ou ouvre le champ du texte, et Échap annule la forme en cours. Une ligne sous l’image le dit.
- **Réglages, icônes colorées avec « Augmenter le contraste »** : les pastilles bleue, verte, rouge et violette des rangées prennent les variantes accessibles de ces couleurs, comme macOS les dessine alors ; le pictogramme blanc se lit à 4,4:1 ou plus, au lieu de 2:1 à 3,6:1.
- **Réglages, « Rétablir » au clavier** : après « Rétablir » sur une rangée, une page ou « Tout rétablir », le focus va à « Annuler » de la notice, qui reste au-delà de ses 8 secondes tant qu’il y est ; le focus restait sur rien, hors d’atteinte d’« Annuler ». « Annuler » ramène le focus à la rangée.
- **Fonctions en option, le filtre** : sous « Allumées » ou « Coupées », une fonction basculée garde sa ligne, et le focus du clavier sur son interrupteur, jusqu’au changement de filtre. La ligne partait aussitôt, et le focus avec elle.
- **« Quitter ce site ? », une page qui se recharge elle-même** : une page qui navigue d’elle-même juste après avoir été ouverte depuis la barre d’adresse est demandée avec la boîte du système, comme toute page qui part d’elle-même ; « Quitter » ne recharge plus l’adresse tapée à la place de la navigation de la page.

- **Dossiers, début d’Aujourd’hui** : un dossier se glisse en haut d’Aujourd’hui, sous la ligne « Nouvel onglet » et au-dessus des onglets du jour, ou s’y place depuis son menu (« Mettre au début d’Aujourd’hui ») ; il y reste après un redémarrage. Un dossier sous les onglets du jour ne pouvait que remonter au-dessus de l’en-tête d’Aujourd’hui.

- **Extensions, document hors écran** : une demande de micro ou de caméra, faite depuis un document hors écran d’une extension, est refusée avec un message au lieu de faire quitter Lucium.

### Sécurité

- **Une page en plein écran** : quand une page prend toute la fenêtre (une vidéo, un jeu, un diaporama), un avis posé dessus dit quelques secondes de quel site il s’agit et qu’Échap quitte le plein écran. Une page pouvait sinon dessiner sa propre barre latérale et sa propre barre d’adresse, et se faire passer pour un autre site.
- **Scripts utilisateur, lecture du code** : les lignes longues d’un script reviennent à la ligne dans la boîte qui le montre avant l’ajout et dans sa liste ; du code placé après une longue suite d’espaces ne reste plus caché au-delà du bord droit.
- **« Quitter ce site ? »** : après « Rester », une page qui veut repartir d’elle-même, sans clic ni touche de votre part depuis, reste où elle est, sans boîte. Un site qui se recharge depuis son propre gestionnaire ne peut plus garder l’application figée derrière cette boîte.
- **Extensions, `chrome.debugger`** : la session d’une extension sur une page est coupée avant qu’une redirection n’emmène la page à une adresse que l’extension ne peut pas déboguer (le Chrome Web Store), et non plus seulement à son arrivée.
- **Liens vers une autre application dans un cadre** : un lien `mailto:`, `tel:` ou vers une autre application demandé par un cadre d’un autre site que l’onglet (une publicité, un widget) reçoit la question simple, qui nomme le site de ce cadre : sans case « Toujours ouvrir… », et le oui gardé pour la page ne vaut pas pour lui.
- **Boîtes `alert()` et `confirm()` des pages** : elles passent par la boîte de Lucium, comme `prompt()` : elle nomme le site, et celle d’un onglet en arrière-plan attend que vous l’affichiez au lieu de s’ouvrir par-dessus l’onglet affiché. Les cadres d’une page et les fenêtres qui ne sont pas des onglets gardent la feuille de macOS.
- **Indices du client sur la page elle-même** : la requête d’une page et celle de ses cadres portent désormais `Sec-CH-UA`, `Sec-CH-UA-Mobile` et `Sec-CH-UA-Platform`, avec les valeurs que Chromium met déjà sur leurs images et leurs scripts. En les comparant, un site ne voit plus un navigateur qu’aucun Chromium n’est ; rien de plus n’est envoyé.
- **Extensions, `activeTab`** : une extension à qui un clic prêtait une page pouvait lire celle où elle envoyait ensuite l’onglet (script demandé juste après `chrome.tabs.update`), sans permission d’hôte. Chaque script vérifie l’origine prêtée dans la page qui l’exécute ; une feuille de style, à son insertion. Le défaut était déjà dans la 1.0.1, la version stable jusqu’ici : passez à la 1.1.0.

## [1.0.1] - 2026-11-12

### Ajouts

- **Infos et réglages du site, extensions** : à côté de « + », qui ouvre le Chrome Web Store, une tuile en forme de dossier charge une extension non empaquetée (un dossier avec un `manifest.json`). Avec beaucoup d'extensions, la rangée passe à la ligne au lieu de couper des tuiles.
- **Infos et réglages du site, menu d'une extension** : un clic droit sur sa tuile, son bouton ⋯, la touche Menu ou Maj+F10 ouvrent un menu pour la désactiver ou l'activer, recharger un dossier, la gérer, ou la retirer après une question. Une extension désactivée reste dans la rangée, atténuée et barrée ; un clic ouvre son menu.

### Changements

- **Icône de l'application** : l'icône choisie dans Réglages › Général › Icône reste celle du Dock, du Finder et du Launchpad quand Lucium est fermé ; pour cela, Lucium la pose sur le fichier de l'application. Il la retire avant d'installer une mise à jour et la remet au lancement suivant.

### Corrections

- **Infos et réglages du site, extensions** : 12 px d’air sous la rangée des tuiles d’extensions, pour que la ligne au-dessus du pied du panneau ne les touche plus.
- **Infos et réglages du site, pied du panneau** : une longue ligne de sécurité (« Non sécurisé : certificat non valide accepté ») et « Réglages du site… » ne se coupent plus en débordant de leur pastille de 32 px ; la ligne grandit avec son texte et les éléments passent sur une seconde rangée quand ils ne tiennent pas.
- **Extension chargée depuis un dossier** : « Retirer » sur son dossier, dans Réglages › Outils et extensions › Extensions, la décharge tout de suite de tous les profils : elle quitte la barre d'outils, le menu Extensions et le panneau du site. Elle y restait jusqu'au lancement suivant. Le dossier et les données de l'extension ne sont pas touchés.
- **Infobulles** : un en-tête, une ligne ou un bouton dont le nom est déjà écrit n'a plus d'infobulle qui le répète et cache le haut de la ligne du dessous (« Replier la section Blocage » sur « Blocage », dans Infos et réglages du site). Un peu d'air sépare aussi l'en-tête d'une section repliable de son contenu.
- **Extensions retirées** : une extension tout juste retirée d’un profil dont une page ou un service worker envoie encore un écouteur ne provoque plus d’erreur dans le processus principal ; le message tardif est ignoré et noté dans le journal.

## [1.0.0] - 2026-11-11

### Changements

- **Nouveau départ sous le nom Lucium** : cette version ne lit pas les données d'une 0.2.x. Elle ouvre un nouveau dossier de données, vide, vous êtes déconnecté de tous les sites, macOS redemande ses autorisations (caméra, micro, écran, navigateur par défaut…), et les mots de passe se réimportent depuis un export CSV fait avant la mise à jour.
- **Liens de partage** : le lien d'une Retouche commence par `lucboost1_` et le code d'un thème par `luc1_`. Les liens et les codes faits avec une version 0.2.x ne sont plus lus : copiez-les de nouveau depuis cette version.
- **Extensions** : les règles réseau des extensions (`declarativeNetRequest` : un bloqueur de contenu, un éditeur d'en-têtes) et leurs écouteurs `chrome.webRequest` s'appliquent, après les protections de Lucium. La page des extensions ne prévient plus que sous une extension qui bloque depuis son code (`webRequestBlocking`).
- **Extensions avec activeTab** : une extension qui a `activeTab` et `scripting` sans permission d'hôte peut exécuter son script dans l'onglet après un clic sur son icône, jusqu'à ce que l'onglet change de site. Ce script a la page, pas les API `chrome.*`.
- **Autorisations facultatives des extensions** : quand une extension demande une autorisation que son manifeste donne comme facultative, juste après un clic ou une touche, Lucium vous pose la question avec la fiche de l'installation. Votre accord vaut pour le profil, et se retire dans la page Extensions (Détails). Sans clic, la demande est refusée.
- **Extension chargée depuis un dossier** : un dossier dont le manifeste liste plus de 512 autorisations, sites ou pages de scripts est refusé, comme un paquet du Chrome Web Store. Il était chargé, et le moteur appliquait la liste entière sans qu'elle soit montrée.
- **Raccourcis des extensions** : un raccourci proposé par une extension et déjà pris par un raccourci de Lucium ou d'une autre extension n'est plus affiché comme actif dans le menu Extensions, et la page des extensions dit qu'il ne répond pas.
- **Page des extensions** : « Effacer », sous la liste, n'oublie plus que les lignes affichées à cet endroit. Il vidait le journal de toutes les extensions, dans tous les profils.
- **Tableau des connexions** : le README dit ce que la variante DRM envoie à chaque lancement au service de mise à jour des composants de son moteur pour le module Widevine (données de comptage du protocole de Chromium ; aucun réglage ne l'arrête), et que la recherche de mises à jour du Chrome Web Store porte un identifiant de session.
- **Résumé de page** : il ne passe plus que par un modèle local, Ollama (toujours en option, éteint par défaut). Les fournisseurs en ligne (OpenAI, Mistral, OpenRouter, Anthropic) et leurs clés sont retirés ; un réglage qui en désignait un retombe sur « éteint ».
- **Résumé de page, Ollama sur le réseau local** : l'adresse d'Ollama peut être celle d'un autre ordinateur de votre réseau local, par son adresse IP privée (jamais un hôte public). Les Réglages disent alors que le texte de la page quitte ce Mac, en clair sur le réseau local ; une page privée n'y est jamais envoyée.
- **Résumé de page, nom en `.local` et Tailscale** : l'adresse d'Ollama accepte aussi un nom en `.local` (`mon-mac.local`) et la plage `100.64` à `100.127`. Un nom est vérifié à chaque envoi : la requête part vers l'adresse privée trouvée, et rien ne part s'il mène ailleurs. Un hôte public reste refusé.
- **Menu Fichier, « Résumer la page »** : avec Ollama sur un autre ordinateur, les trois entrées du résumé sont grisées quand l'onglet affiché est privé, au lieu d'ouvrir un onglet qui répondait par un refus.
- **Certificat client** : quand un site demande un certificat pour vous identifier, Lucium le dit par un avis dans sa fenêtre, qui nomme le site, à la place de la notification du système. Lucium n'en présente toujours aucun.
- **Retour à une version précédente** : au premier lancement d'une autre version que celle qui a enregistré vos espaces, onglets et réglages, Lucium en garde une copie avant d'y toucher. Une version plus ancienne vous dit où est cette copie ; de retour sur la version récente, Aide › Restaurer les données… la reprend.
- **Proxy d'un profil** : les Réglages disent que le proxy propre à un profil ne vaut pas pour ses onglets privés ni pour ses conteneurs, qui sortent par le proxy général (ou sans proxy s'il n'y en a pas).
- **Typographie française** : une ligne ne commence plus par « ? », « : », « ; », « ! », un guillemet fermant, un « % » ou une unité. Les textes français prennent leurs espaces insécables à l'affichage, et les recherches trouvent toujours un libellé tapé avec des espaces ordinaires.
- **Un nom par chose** : le panneau du site s'appelle partout « Infos et réglages du site » ; un espace est « mis de côté » puis « rouvert » dans tous les panneaux, comme dans le menu ; « Replier la barre » remplace « Coller la barre », et « Nouvelle capture » remplace « Refaire » à côté d'Annuler et Rétablir.
- **Réglages › Général** : l'interrupteur « Guide du premier lancement » est retiré. Il ne décidait rien : le guide s'ouvre seul sur un profil neuf, qui n'a que les réglages par défaut. Le guide et Aide › Premier lancement… restent.
- **Fond d'un espace** : le bouton dit « Ajouter un média… » et les messages parlent d'import, plus de « chargement » : le fichier ne quitte pas le Mac.
- **Clés d'accès (passkeys)** : le README dit de ne pas compter dessus dans Lucium et de garder une autre méthode de connexion. `docs/cles-d-acces.md` dit ce qui est établi (pas d'autorisation d'Apple pour le trousseau iCloud, pas de fenêtre de choix), ce qui reste à mesurer, et fournit une page de mesure (`pnpm probe:passkeys`).
- **Contenu du paquet** : l'application de démonstration d'Electron (`default_app.asar`), copiée avec le moteur de la variante DRM et jamais chargée, n'est plus livrée.
- **Installation d'une build** : le script de build garde les 3 copies les plus récentes de l'application précédente (`lucium-app-backups`) et supprime les plus anciennes ; `LUCIUM_APP_BACKUPS_KEEP` change ce nombre. Elles s'accumulaient sans limite, environ 300 Mo chacune.
- **Protection contre l'empreinte numérique** : elle s'applique aussi aux cadres d'une page (d'un autre site, `about:blank` et `srcdoc` compris), à ses workers et à ses service workers. Les workers partagés ne sont pas couverts ; seul le mode strict les retire. Tant qu'une extension débogue une page, ses cadres et ses workers ne sont pas protégés.
- **Publication** : une version retirée du canal de test (`--withdraw`) ne passe plus sur le canal stable tant que la même archive n'a pas été republiée sur le canal de test ; l'attente repart de cette republication, et `--security-fix` ne lève pas ce refus.
- **Vérification de l'application** : `pnpm verify:app` compare la signature à l'équipe des builds officielles, `9A9AUX9UHT`, que le README publie avec la commande pour la lire ; `--team` ou `LUCIUM_TEAM_ID` en nomme une autre. L'équipe n'est plus lue dans la signature vérifiée ; `--any-team` garde cette lecture pour examiner une copie.
- **Licence, vidéos protégées** : une permission additionnelle (GPL version 3, article 7) autorise à combiner et à distribuer Lucium avec le module Widevine et le moteur qui le charge. Son texte est dans `ADDITIONAL-PERMISSION.txt` et dans `NOTICE` ; il attend la relecture d'un juriste.
- **Nom et logo** : le logo est réservé aux builds officielles. Le dessin (`scripts/logo/fan-logo.ts`) et les icônes de l'application ne sont plus sous GPL ; `TRADEMARKS.fr.md` dit ce qui reste permis et ce qu'une version modifiée doit remplacer.
- **Vidéos de fond et musique du film** : elles ont été générées par IA avec Higgsfield. `NOTICE-MEDIA.fr.md` le dit : elles ne sont ni sous GPL ni sous Creative Commons, et le projet ne promet aucun droit de les réutiliser.
- **Export du dépôt public, fichiers hors GPL** : l'export est refusé si le logo, ses icônes ou les médias générés partent sans le document qui dit leur licence, ou si `NOTICE` ne nomme pas ce document ; la liste des fichiers non lus marque chacun d'eux.
- **Export du dépôt public** : le contrôle des textes reconnaît les renvois aux rapports internes des relectures suivantes et aux hypothèses, et le compte rendu liste les fichiers binaires exportés (images, vidéos, polices, PDF, archives), qu'aucune règle ne lit, pour qu'ils soient regardés avant l'envoi.
- **Publication, version déjà offerte** : avant tout envoi, le flux en place est lu. Une version que le canal offre déjà avec une autre archive est refusée (son fichier serait remplacé sous le flux, et toute installation échouerait), comme une version inférieure à celle qui est offerte.
- **Publication, image disque** : l'image doit contenir l'application de l'archive. `make-dmg.mjs` écrit avec elle un relevé (la somme de l'image et celle de l'exécutable qu'elle contient), et la publication refuse une image restée d'une construction précédente du même numéro, ou sans son relevé.
- **Relevé de construction** : un fichier que Git ne suit pas, dans un dossier que la construction lit (`src`, `resources`, `native`, `build`), compte maintenant comme un arbre modifié. Il peut être dans l'archive sans être dans le commit : le relevé le dit, et la publication refuse l'archive.
- **`verify-app`, helper de traduction** : le contrôle lit maintenant l'identifiant sous lequel le helper est signé et le protocole que son bundle annonce, ce que Lucium exige avant de le lancer. Signé autrement, la traduction par macOS était indisponible chez tous, sans message.
- **Export du dépôt public, premières lectures** : le contrôle des textes reconnaît aussi un renvoi à un rapport interne dont il ne connaît pas l'axe et qui ne porte pas de numéro de relecture ; les noms de sommes, d'encodages et de normes de cette forme ne sont pas touchés.
- **Effacer les données du site, vidéo protégée** : les licences de vidéo protégée (DRM) du site sont effacées aussi quand les cookies et les quatre types de stockage sont cochés, ce qui est le choix par défaut. La feuille dit si elles partent ou si elles restent, et la réponse a sa ligne « Licences de vidéo protégée ».
- **Effacer les données du site, sous-domaines** : avec « Sous-domaines », le stockage de tous les sous-domaines qui ont des données dans le profil part, même ceux qu'aucun onglet n'a montrés. La réponse a une ligne « Sous-domaines » : le nombre trouvé, ou un échec si la liste n'a pas pu être lue.
- **Conteneurs supprimés** : le dossier d'un conteneur supprimé, que Lucium gardait tant qu'une copie de l'état faite avant une restauration le nommait, est supprimé au lancement quand rien n'y a été écrit depuis 30 jours. Le journal le note.
- **Barre d'annotation** : elle suit l'apparence claire ou sombre, comme le reste de l'interface, au lieu de rester un panneau blanc.
- **Second raccourci** : cinq commandes dont le raccourci ne se tape pas tel quel sur un clavier français, ou que macOS et des sites utilisent aussi, gardent ce raccourci et en ont un second : ⌃⌘← et ⌃⌘→ (page précédente, suivante), ⌥⌘K (aide des raccourcis), ⌃⌘X (effacer les données du site), ⌃⌘1 à ⌃⌘9 (espaces).
- **Menu Extensions** : « Effacer les données du domaine » est retiré. L'entrée faisait la même chose que « Effacer les données du site maintenant » du menu Archive (⌥⇧⌘X), qui reste.
- **Version retirée : l’application le dit.** Quand la version installée a été retirée, Lucium affiche « Cette version a été retirée » et indique la version à installer, dans l’avis de mise à jour et dans « Rechercher les mises à jour… ». La liste des versions retirées est lue dans le flux de mise à jour déjà consulté : aucune requête de plus.
- **« Mode lisible » devient « Contraste de la page »** : le bouton à trois modes qui assombrit ou éclaircit une page entière change de nom, dans les menus, les Réglages et la barre de commandes, où « mode lisible » le trouve encore. Le mode lecture, qui montre l'article seul, garde le sien. Aucun réglage n'est perdu.
- **Sessions et Signets, comme les autres listes** : une session ou un signet supprimé quitte la liste aussitôt et se reprend avec « Annuler » ou ⌘Z (huit secondes pour une session, six pour un signet), au lieu d'un second clic de confirmation. ↑ et ↓ passent d'une ligne à l'autre, et un clic sur une ligne restaure la session ou ouvre le signet.
- **Barre d'annotation, couleur de l'espace** : les boutons enfoncés de la barre et l'aperçu des zones où la déposer prennent la couleur d'accent de l'espace affiché dans la fenêtre annotée, en clair comme en sombre, au lieu d'un bleu fixe.
- **Effacement automatique des annotations** : les traits d'une page annotée peuvent s'effacer seuls, en fondu, après 3, 5, 10, 20 ou 30 secondes sans nouveau trait ni clic ; ⌘Z les rétablit. Le bouton minuterie de la barre, avant Annuler, choisit la durée ; le réglage est aussi dans Réglages › Outils et extensions. Désactivé par défaut.
- **Permission additionnelle dans l'application** : le fichier `ADDITIONAL-PERMISSION.txt` (la permission de l'article 7 de la GPL pour le module Widevine) est livré dans l'application, à côté de `LICENSE` et de `NOTICE`, qui en reprenait déjà le texte.

### Corrections

- **Infos et réglages du site, Retouches** : la ligne d'une Retouche a trois boutons distincts, toujours visibles : Modifier (un crayon, ouvre l'éditeur), Exporter (si le partage des Retouches est activé) et Supprimer (une corbeille, rouge au survol). Ils se dessinaient les uns sur les autres. Pour renommer, double-cliquez sur le nom ou appuyez sur F2.
- **Menus des Réglages** : un menu prend la largeur de la valeur qu'il affiche ; une valeur longue n'est plus coupée sous les flèches (« Automatique (langue du système) », « Téléchargements », « Après 12 heures »…). Dans Profils, le texte d'introduction ne colle plus au cadre « Régler en quelques questions ».
- **Effacer l'historique, espace mis de côté** : effacer l'historique d'un profil efface aussi les pages précédentes gardées avec les onglets archivés d'un espace mis de côté. Elles restaient dans le fichier d'état.
- **Fenêtre privée** : la demande d'autorisation d'un site (position, partage d'écran…) s'ouvre de nouveau dans le panneau de la fenêtre, et la réponse reste en mémoire pour cette fenêtre, au lieu d'une boîte du système qui ne retenait rien.
- **Champ des panneaux** : un panneau avec un champ (Modifier l'onglet…) ouvert au lancement de la fenêtre y place de nouveau le curseur ; ce qui est tapé aussitôt n'est plus perdu.
- **Recherche dans un site** : une recherche qu'un site de votre machine déclare en http (`localhost`, `127.0.0.1`) est de nouveau gardée après « Ajouter » ; la notice disait « Recherche ajoutée » sans rien ajouter.
- **Barre de commandes** : avec « Mots-clés avec « ! » » désactivé, « !mot-clé » ne lance plus de recherche dans un site, même pour un de vos mots-clés ; le mot-clé sans « ! » marche toujours.
- **Textes de licence** : l'application contient maintenant la licence d'Electron, les avis de Chromium, l'avis de droit d'auteur de Lucium et la liste des composants npm avec leurs licences, à côté du texte de la GPL. La version précédente était distribuée sans les deux premiers.
- **Boîtes de confirmation en anglais** : le bouton qui renonce (fermer une fenêtre de plusieurs onglets, effacer l'historique, vider l'archive, retirer une extension, choisir un appareil) s'appelle « Cancel » ; il disait « Undo », comme si l'action était déjà faite.
- **Raccourcis clavier** : l'enregistrement d'un raccourci retient la lettre tapée, quelle que soit la disposition du clavier. Sur un clavier AZERTY, ⌘A s'enregistrait « ⌘Q », la lettre qu'un clavier américain a à cet endroit. Une touche qu'un raccourci ne sait pas nommer (« ù », « $ ») n'en fait plus un autre.
- **Sélecteur d'onglets** : un raccourci ⌥ + lettre donné au sélecteur d'onglets (⌃Tab par défaut) répond sur un clavier AZERTY. ⌥A y donne « æ » : Lucium lisait la lettre qu'un clavier américain a à cet endroit, et le raccourci restait muet.
- **Sélecteur d'onglets, touche tapée tôt** : Échap, ou ⌃ relâché, à l'instant où le panneau de ⌃Tab apparaît n'est plus perdu. Le panneau restait affiché : Échap n'annulait rien, et relâcher ⌃ ouvrait ensuite l'onglet sélectionné.
- **Raccourcis réservés** : donner à une commande ⌘Q, ⌘C, ⌥⌘M ou le raccourci d'une extension est refusé, avec le nom de ce qui le tient. Avant, rien n'était dit et l'une des deux cessait de répondre. ⌘⌫ et ⌘⌦ peuvent maintenant être enregistrés comme raccourcis.
- **Raccourci en double** : quand deux commandes gardent le même raccourci, le menu le donne à celle que vous avez réglée en dernier. Avant, les deux le portaient, et celle qui répondait n'était pas toujours celle que vous veniez de régler.
- **Notes sous les raccourcis** : Réglages › Raccourcis dit sous un raccourci quand des sites l'utilisent aussi (⇧⌘X, ⌘/, ⌘]…), quand macOS le garde (⌃1 à ⌃9 avec Mission Control) et quand votre clavier ne donne pas sa touche seule (⌘[ et ⌘/ sur un clavier AZERTY).
- **Raccourcis dans les bulles** : les bulles de la barre d'outils, de la barre latérale et de la mini-fenêtre, et les lignes de la barre de commandes, affichent le raccourci tel que vous l'avez réglé. « Capturer une zone » affichait ⌥⌘Z, qui n'a jamais été son raccourci (c'est ⇧⌘2).
- **Annotation** : quand ⌥⌘P est déjà tenu par l'autre fonction d'annotation de Lucium (une page, ou une fenêtre partagée), la note le dit, au lieu de « déjà pris par une autre application ».
- **Lancement** : fermer la fenêtre dans la seconde qui suit le lancement n'écrit plus d'« erreur interne » dans le journal ; la feuille du premier lancement n'est plus ouverte sur une fenêtre déjà fermée.
- **Contrastes** : sur un site qui colore la barre d'outils (bleu, rouge ou vert de marque), les boutons et l'adresse prennent une encre foncée, lisible ; le panneau « Infos et réglages du site » et la fenêtre des téléchargements ont un fond plus sombre ; le bouton principal du guide de premier lancement se lit en apparence sombre.
- **Onglets ouverts par une extension** : un onglet qu'une extension ouvre en arrière-plan reste en arrière-plan. Il prenait la place de l'onglet affiché, et sa fermeture montrait l'onglet voisin au lieu de celui que vous regardiez (un volet d'extension pouvait aussi se fermer).
- **Volet latéral d'une extension** : il ne se ferme plus quand une autre extension règle son propre volet (ce qu'une extension fait à chaque redémarrage), ni quand sa propre extension le règle pour un onglet que vous ne regardez pas.
- **Extension qui envoie un onglet ailleurs** : `chrome.tabs.update` avec une adresse répond dès que la page commence à charger, comme le prévoit l'API des extensions. Il attendait la page et, si l'onglet chargeait encore la précédente, l'extension ne recevait rien et voyait une erreur dans sa console.
- **Icônes d'extensions** : quand la fenêtre est étroite, le menu du bouton » (les icônes en trop) compte l'écart entre deux icônes ; l'adresse garde ses 180 px au lieu d'être réduite par des icônes qui ne tenaient pas.
- **Onglet privé** : l'adresse ou la recherche tapée dans la barre de commandes au-dessus d'un onglet privé n'est plus comptée dans le classement de la barre, qui est enregistré avec vos onglets. Rien de ce qui y est tapé ou choisi n'est gardé.
- **Classement de la barre de commandes par profil** : les pages que vous choisissez souvent dans la barre remontent dans le profil où vous les avez choisies, et dans aucun autre. Effacer l'historique d'un profil ne vide que son classement. L'ancien classement, commun à tous les profils, repart de zéro.
- **Page oubliée, classement de la barre de commandes** : une page oubliée dans l'historique (⇧⌫ dans la barre, le panneau Historique, « Oublier ce jour ») quitte aussi le classement de la barre, où son adresse restait enregistrée. « Annuler » après ⇧⌫ la remet dans le classement, avec son rang.
- **Profil nommé « Private »** : il ne prend plus l'identifiant réservé à la fenêtre privée. Et si un tel profil existe déjà, une fenêtre privée n'utilise plus son moteur de recherche, son dossier de téléchargement ni son nom : elle suit le profil par défaut.
- **Suggestions de recherche** : ce que vous tapez dans la barre de commandes au-dessus d'un onglet privé, ou dans une fenêtre privée, ne part plus vers le moteur de recherche pour obtenir des suggestions. Les propositions de votre Mac restent : onglets ouverts, commandes, calculatrice.
- **Notifications des sites** : un site jamais autorisé ni refusé lit de nouveau « pas encore demandé » au lieu de « refusé », et peut proposer ses notifications. Après « Autoriser » sans « Se souvenir pour ce site », il lit « autorisé » jusqu'à la fermeture de l'onglet. Rien n'est gardé dans une fenêtre ou un onglet privé.
- **Bouton de paiement ou de connexion dans un cadre** : un clic sur un bouton placé dans un cadre d'un autre site (paiement, « Se connecter avec… ») ouvre de nouveau sa fenêtre. Elle était bloquée avec la notice « sans clic de votre part ». Un cadre qui n'a pas été cliqué n'ouvre toujours rien, et un clic ouvre une seule fenêtre.
- **Protection contre l'empreinte** : la fenêtre vide qu'une page ouvre pour y écrire (`window.open('')`) reçoit la même protection et les mêmes scriptlets que la page qui l'a ouverte. Elle n'en recevait aucune. Les cadres d'une page ne sont toujours pas couverts.
- **Traduction locale** : la mémoire de la session garde les traductions site par site. Un site ne peut plus savoir, par la vitesse d'une traduction, si une phrase a déjà été traduite ailleurs. Elle se vide aussi quand vous effacez les données d'un profil ou d'un site, ou l'historique.
- **Phrase secrète demandée pendant une autre question** : la demande de phrase secrète (restauration d'une exportation chiffrée) n'est plus perdue quand une boîte de page ou la relecture d'une extension passe avant elle ; elle s'ouvre ensuite.
- **Résumé d'un onglet privé** : le résumé s'ouvre dans un onglet privé lui aussi. Il s'ouvrait dans un onglet ordinaire, et le titre de la page privée était enregistré avec vos onglets.
- **Onglet privé et réglages par site** : le site d'un onglet privé n'est plus écrit dans les réglages enregistrés par « Désactiver les gestes de souris sur ce site », « Toujours autoriser sur ce site » (fenêtres bloquées) et « Désactiver le bloqueur pour ce site ». Ces choix n'y sont plus offerts.
- **Onglets privés, conteneurs et plusieurs fenêtres** : le Coup d'œil d'un lien s'ouvre dans le contexte de l'onglet où est le lien (vue scindée comprise), « Effacer le cache et actualiser » vide le cache de l'onglet affiché, et effacer les données d'un profil recharge ses onglets dans toutes les fenêtres.
- **Boîtes de confirmation** : Tab reste sur les boutons de la boîte au lieu d'atteindre les réglages placés derrière elle ; la boîte grandit avec son message, qui ne passe plus sous les boutons quand il fait quatre lignes.
- **Lecteur d'écran** : le bouton qui ferme le panneau latéral et, quand la barre d'outils est masquée, Précédent, Suivant, Recharger, les infos du site et l'étoile des favoris sont lus par leur nom et non par un caractère. Dans les Réglages, l'aide et le « i » d'une ligne sont lus avec son contrôle.
- **Clavier** : la largeur du panneau latéral se règle aux flèches ; le menu « + » et le menu du titre d'une Retouche se parcourent aux flèches et l'entrée choisie est lue ; le « i » des Réglages s'atteint avec Tab et affiche sa phrase ; le champ de recherche des raccourcis montre le focus.
- **Panneaux** : après la suppression d'un signet ou des cookies d'un site, le focus revient au panneau et Échap le ferme de nouveau.
- **Lecteur multimédia** : au clavier, la rangée du titre (« Image dans l'image », « Fermer ») s'ouvre quand le focus entre dans la barre ; Tab ne s'arrête plus sur des boutons invisibles.
- **Contrastes de la barre latérale** : le texte secondaire (onglets en veille, « Nouvel onglet », « Aujourd'hui », noms des favoris) est mesuré sur la couleur réelle de l'espace et se lit sur toutes, dont « Sable » et « Jaune » en apparence sombre. De même pour la page vide, la barre d'une vue scindée et l'en-tête de la Mini-fenêtre.
- **Fenêtre privée** : l'adresse de la barre d'outils se lit mieux sur son fond bleu.
- **« Toujours augmenter le contraste »** : le réglage renforce aussi les gris de la barre latérale et les contours des panneaux et des Réglages, comme le fait le réglage de macOS. Il n'agissait que sur une partie des couleurs.
- **Petits textes** : l'emplacement d'un résultat choisi dans la barre de commandes, l'aide d'un encadré des Réglages, les marques de coût, un raccourci désactivé et les lettres des raccourcis de la barre d'annotation sont plus lisibles.
- **Interface en anglais** : la feuille « Créer un raccourci pour ce site » disait ses erreurs en français, le bouton de taille de l'éditeur de Retouches affichait « Taille », et une fenêtre surgissante sans adresse s'intitulait « adresse inconnue ». Les trois suivent la langue de l'interface.
- **Anglais** : le verrou et Touch ID disent « passphrase » partout, la page des extensions dit « Allow in Private Windows », et l'aide de création d'espace ne conseille plus un mot français ; les icônes proposées d'après le nom connaissent les mots anglais (« vacation », « work », « school »).
- **Aide › Premiers pas** : ouvre le README en français quand l'interface est en français (il s'ouvrait en anglais). La documentation technique d'Aide › Documentation reste en français, et le réglage de la langue le dit.
- **Cookies par site** : « 1 n'a pas pu l'être », « sauf 1 site gardé » : les phrases s'accordent avec leur nombre ; la question avant de tout retirer est claire quand la liste « Garder toujours » est vide, et un profil sans cookie n'affiche plus « aucun cookie sur 0 site. ».
- **Réglages › Listes de filtres** : la note sur la syntaxe des filtres tient en une phrase ; elle était coupée en trois colonnes autour de `##+js(…)`.
- **Créer un raccourci pour ce site** : la feuille ne s'affiche qu'une fois les raccourcis existants connus ; un enregistrement trop tôt aurait remplacé toute la liste.
- **Veille** : un onglet réveillé retrouve ses pages précédentes et suivantes. Avant, la mise en veille qui libère la mémoire (le mode par défaut) et la fenêtre principale refermée vidaient les boutons Précédent et Suivant. La liste reste en mémoire : après une relance de Lucium, un onglet repart de sa seule adresse.
- **Conteneurs d'onglets** : après Aide › Restaurer les données…, un conteneur créé depuis l'export garde ses cookies et son stockage tant que la copie faite avant la restauration existe. Avant, le lancement suivant les effaçait, et remettre cette copie rendait un conteneur vide.
- **Historique et cookies par site** : changer d'espace pendant que le panneau est ouvert ne fait plus agir « Oublier », « Oublier ce jour » ou « Nettoyer » sur un autre profil que celui de la liste affichée. Le panneau relit la liste du nouveau profil, et la confirmation « Effacer les données de navigation » se referme.
- **Notes** : une note qui contient un lien `mailto:` avec un `%` mal formé (une adresse collée depuis une page en Latin-1, un `.md` importé) s'ouvre de nouveau. Avant, elle ne pouvait plus être lue, modifiée ni exportée, seulement supprimée.
- **Effacer les données d'un profil** : ses onglets se rechargent dans toutes les fenêtres, pas seulement dans celle d'où part l'effacement. Avant, une autre fenêtre continuait d'afficher une page encore connectée.
- **Fond d'un espace** : « Supprimer » laisse sur le disque l'image ou la vidéo qu'une copie de session, une copie faite avant une restauration ou un autre espace nomme encore, pour que la restauration de cette copie retrouve son fond. Le fichier part à un lancement suivant, quand plus rien ne le nomme.
- **Extensions, performance** : avec une extension installée, chaque page web ne lit plus deux fois le script qui donne leurs API aux extensions (il ne tourne plus que dans leurs pages), et ce script pèse 18 Ko au lieu de 952 Ko : les workers et les pages d'extension démarrent sans lire les textes de l'interface.
- **Contraste de la page, images de fond** : en Sombre ou en Clair, une image de fond déclarée par une feuille de style rangée dans un autre dossier que la page (`url(../img/x.png)`) est cherchée à partir de l'adresse de cette feuille, et plus de celle de la page : l'image manquait, et le site recevait une demande pour un fichier inexistant.
- **IPv6 dans la version officielle** : le README ne dit plus que la version officielle désactive l'IPv6 et qu'un site qui ne répond qu'en IPv6 ne s'y charge pas. Le commutateur posé pour cela (`--disable-ipv6`) n'est plus lu par Chromium : il ne changeait rien, et il est retiré.
- **Questions des sites** : garder l'écran allumé pendant un appel ou une vidéo, conserver ses données hors ligne et les envoyer au retour du réseau ne font plus l'objet d'une question. Les autres demandes sont posées en clair (cookies dans une page intégrée, réseau local, polices, sortie audio…), et plus par leur nom technique.
- **Liens vers une autre application** : un lien « Ouvrir dans l'application » (Zoom, Teams, Slack, VS Code, Spotify…) ne reste plus sans effet. Lucium demande si le site peut ouvrir l'application, en nommant le type de lien (`zoommtg:`), à chaque fois ; si aucune application ne répond, une notice le dit.
- **Liens vers une autre application, « Toujours ouvrir »** : après un clic sur un tel lien, la question propose la case « Toujours ouvrir les liens de ce type depuis ce site ». Le oui vaut pour ce site et ce type de lien seulement, jamais pour un onglet privé, et se retire dans Réglages › Vie privée et sécurité, avec les autorisations des sites.
- **Signaler un problème** : le rapport tient dans le formulaire de la page Communauté du site (16 000 caractères au plus ; le formulaire en accepte 20 000 et aucun fichier). Quand le journal est plein, les lignes les plus récentes sont gardées et le rapport dit combien de plus anciennes sont laissées de côté.
- **Installer une extension** : dans la feuille qui liste ce que l'extension demande, Tab reste entre « Annuler » et le bouton d'ajout. Il atteignait les commandes de la fenêtre restées sous le voile, où Espace agissait sur ce qu'on ne voit pas.
- **Question laissée sans réponse** : ouvrir un panneau (la barre de commandes, les téléchargements…) par-dessus une demande de permission, une connexion demandée par un serveur, la relecture d'une extension ou une phrase secrète ne la fait plus disparaître. Elle revient à la fermeture du panneau ; avant, la page attendait sans fin.
- **Onglet déplacé ou parti sur un autre site** : « Créer un raccourci pour ce site » propose le site que l'onglet affiche, plus celui de son ouverture. Un lien qui ouvre un onglet et « Rechercher la sélection » l'ouvrent dans l'espace où se trouve l'onglet, plus dans celui où il avait été créé.
- **Téléchargements d'un onglet privé ou d'un conteneur** : « Ouvrir sans l'enregistrer » n'y garde plus le fichier pour de bon, « Demander où enregistrer chaque fichier » y pose sa question, et le fichier va dans le dossier de téléchargement du profil de l'espace. Ces trois réglages n'y étaient pas appliqués.
- **Onglet privé dans la barre de commandes** : ⌘↩ sur la ligne d'un onglet privé ouvre sa page dans un nouvel onglet privé. Elle s'ouvrait dans un onglet ordinaire, et son adresse entrait dans l'état enregistré et dans l'historique.
- **Annuler un oubli dans la barre de commandes** : après ⇧⌫ sur une page de l'historique, la barre propose « Annuler » pendant cinq secondes (le bouton, ou ⌘Z). La page revient dans l'historique telle qu'elle était, avec son titre, ses visites et sa date.
- **Coup d'œil** : « Copier l'adresse » retire les paramètres de suivi quand le réglage « Retirer les paramètres de suivi des liens copiés » est actif, comme les autres copies d'adresse. Si la copie échoue, une notice le dit.
- **Personnaliser l'espace** : « Rétablir » remet aussi le fond de l'espace (l'image ou la vidéo, son voile, la couleur du texte) tel qu'il était à l'ouverture du panneau, et retire un fond ajouté à un espace qui n'en avait pas. Le bouton s'active quand seul le fond a changé.
- **Recherche dans un site** : dans la barre de commandes, ce que vous tapez après la pastille d'un site (« YouTube », un mot-clé à vous) n'est plus envoyé lettre après lettre au moteur de recherche par défaut pour ses suggestions. Seul le site choisi reçoit la recherche, à l'envoi.
- **Signets** : modifier un signet avec une adresse refusée (pas une page web, ou déjà celle d'un autre signet) laisse le formulaire ouvert et dit pourquoi sous le champ de l'adresse, que les lecteurs d'écran lisent avec lui. Avant, le formulaire se fermait et la modification était perdue sans message.
- **Éditeur de thème** : Échap et « Réinitialiser » retirent le fond ajouté à un espace qui n'en avait pas à l'ouverture du panneau. Le fond restait.
- **Panneau des ressources** : tant que le pointeur est sur la liste, les lignes gardent leur place et seuls les chiffres changent. Elles se reclassaient toutes les 2 s, et ☾ ou ✕ pouvait agir sur un autre onglet que celui visé.
- **Import depuis un autre navigateur** : pendant la lecture, le navigateur, le profil et les cases à cocher ne se changent plus. L'aperçu qui arrivait pouvait ne plus correspondre à ce qui était coché, et « Confirmer l'import » importait autre chose que ce que la feuille montrait.
- **Global Privacy Control** : l'en-tête `Sec-GPC: 1` part aussi avec l'ouverture d'une connexion WebSocket. Il n'accompagnait que les requêtes http et https d'une page.
- **Global Privacy Control, requêtes de Lucium** : quand le réglage est activé, `Sec-GPC: 1` part aussi avec ce que Lucium demande lui-même : les versions, les listes de filtres, les icônes des sites, le catalogue de traduction et le Chrome Web Store. Seules les pages le portaient.
- **Copies automatiques** : la copie « À la fermeture » est faite aussi quand le Mac s'éteint et que Lucium doit s'arrêter sans attendre. Elle manquait dans ce cas ; vos onglets, eux, étaient bien enregistrés.
- **Interface qui ne répond plus** : quand l'interface s'arrête plusieurs fois de suite et n'est plus rechargée, une notification du Mac le dit et rappelle que vos onglets sont enregistrés. La fenêtre restait vide, sans un mot.
- **Traduction locale** : un modèle posé à la main puis remplacé retraduit les textes déjà vus, au lieu de resservir ceux de l'ancien modèle jusqu'à la fermeture. Dans un dossier des modèles choisi par vous, un sous-dossier nommé comme une paire de langues qui n'est pas un modèle n'est plus supprimé : il est mis de côté.
- **Exporter les données** : le panneau dit aussi ce que l'export ne contient pas (scripts utilisateur, listes de filtres, images et fonds des espaces), que les notes n'y vont que si leur fonction est activée, et que les réglages nomment des sites. Le README dit ce que l'effacement d'un site laisse (vidéos protégées).
- **Textes de l'interface** : une centaine de phrases relues, en français et en anglais : accords et pluriels (« 12 messages non lus »), phrases obscures réécrites, vocabulaire du code retiré, noms des volets de macOS tels que le système les écrit, adresses d'exemple en example.org.
- **Menus** : « Imprimer… », « Enregistrer la page sous… », « Nouveau profil… » et « Renommer l'espace… » ont leurs points de suspension ; « Replier les dossiers épinglés » et « Vider les onglets du jour » disent ce qu'ils font.
- **Menu Affichage** : « Caster », qui ne pouvait qu'annoncer que la fonction n'existe pas, est retiré avec sa boîte. Pour afficher une page sur un autre écran, utilisez la recopie d'écran de macOS ; l'aide le dit. « Notifications récentes » n'est plus au milieu des commandes d'actualisation.
- **Lecteur d'écran, langue** : la mini-fenêtre, les barres de l'annotation et du partage de fenêtre et la vue partagée annoncent leur langue. En interface anglaise, elles étaient lues avec la voix française.
- **Lecteur d'écran, noms et états** : l'icône de globe d'une page sans icône n'est plus lue avant le titre ; le chargement et la pastille de messages non lus d'un onglet sont annoncés ; deux lignes du panneau du site sont des interrupteurs ; la feuille « Raccourci pour ce site » est une boîte de dialogue nommée.
- **Clavier** : dans la feuille des raccourcis, Tab ne s'arrête plus sur chacune des trente lignes ; dans la vidéo flottante, Espace sur un bouton atteint au clavier active ce bouton (« Fermer » ferme) au lieu de mettre en pause.
- **Contrastes** : la lettre qui remplace une icône absente, les textes d'une extension désactivée, le détail de la ligne choisie dans la mini-fenêtre et la recherche d'onglets, et les touches des infobulles atteignent 4,5:1.
- **Lecteur d'écran, boutons répétés** : dans les Réglages et l'historique, « Retirer », « Modifier », « Oublier » ou « Désinstaller » disent sur quoi ils agissent (« Retirer exemple.fr »). Dans la liste des boutons, ils portaient tous le même nom.
- **Lecteur d'écran, noms** : le filtre de « Lire plus tard » a un nom, les pastilles du voile et du texte d'un fond d'espace se nomment par leur couleur et non par un code, le journal de l'onglet Moteur est annoncé. « Afficher », « Lire » et « Pause » ne sont plus lus « enfoncé ».
- **Écran de verrouillage** : pendant un délai d'attente, le message est lu une fois. Il était relu à chaque seconde du compte à rebours.
- **Champs refusés** : dans cinq formulaires (sites jamais bloqués, sites gardés au nettoyage des cookies, adresse d'un moteur de recherche…), le champ en erreur est relié à son message, qui est relu quand on revient sur le champ.
- **Barre de commandes** : le nombre de résultats est annoncé au lecteur d'écran, et ⇧Tab quitte le champ même quand une recherche de site est proposée.
- **Clavier, suite** : ⇧F10 sur « Précédent » ou « Suivant » ouvre la liste des pages de l'onglet ; les flèches parcourent les groupes de choix (icône de l'application, voile, harmonie du thème, icône d'un onglet) ; Échap referme une infobulle ; au premier lancement, le titre de l'étape affichée prend le focus.
- **Lancement** : les restes d'un import interrompu sont nettoyés trente secondes après le lancement, et non plus avant l'affichage de la première fenêtre.
- **Vidéos protégées** : quand le module Widevine arrive après les deux minutes d'attente (connexion lente), une seconde notice dit que les vidéos se lisent, au lieu de laisser la première annoncer une panne qui n'en est plus une.
- **Traces dans les pages** : les repères de liens des touches Vim, la Gomme, la vidéo flottante, un script utilisateur en échec et l'erreur qui arrête un script bloqué ne laissent plus dans la page ni balise, ni variable, ni attribut, ni message au nom du navigateur. Un site pouvait s'en servir pour reconnaître Lucium.
- **Tracé des gestes de souris** : une règle de style de la page ne peut plus le masquer ni le déplacer.
- **Effacer les données d'un profil** : les cookies de la session de l'interface partent aussi, avec les icônes. Rien dans les Réglages ne les effaçait.
- **Certificat client** : quand un serveur en demande un (mTLS, carte à puce), une notification dit que Lucium n'en présente aucun et que la connexion peut échouer, une fois par serveur. Seul le journal le notait.
- **Extensions** : `Object.defineProperty`, retenu pendant le chargement d'une extension sans certaines permissions, lui est toujours rendu intact, même quand la bibliothèque d'extensions s'arrête en route.
- **Interface en anglais** : les textes anglais sont relus. Les tournures calquées du français sont réécrites, une chose garde un seul mot (« log », « backup », « turned off », « Picture in Picture »), les menus et les commandes sont en casse de titre, les infobulles et les boutons des pages d'erreur en casse de phrase.
- **Un nom par chose, suite** : « Copier l'adresse » remplace « Copier l'URL », « Rechercher les mises à jour » est le seul verbe, « export » remplace « exportation », les menus disent « Fermer le volet web » et « Retirer un volet web », et la barre de la vue scindée dit « Défilement synchronisé » comme le menu.
- **Touches et gestes dans les textes** : « ⇧-clic », « ⌥⌘-clic », « ⌘Z » et « ⇧F10 » s'écrivent avec les signes du clavier du Mac, dans l'ordre des menus (« ⌃⇧Tab »), au lieu de « Maj + clic », « Cmd/Ctrl+Z » ou « touche Menu », qu'un Mac n'a pas.
- **Phrases accordées avec leur nombre** : les boîtes « Vider l'archive » et « Supprimer l'espace », la question de la restauration des données et trois notices accordent la phrase avec le nombre. Elles disaient « 1 onglet(s) seront fermés ».
- **Gestionnaire de tâches** : la part de processeur s'écrit dans la langue de l'interface, « 6,4 % » en français et « 6.4% » en anglais. Elle s'écrivait « 6.4 % » dans les deux.
- **Tailles, pourcentages et dates en anglais** : avec l'interface en anglais, un téléchargement s'écrit « 3.4 MB » et « 12 KB/s » (et non « 3,4 Mo »), le zoom d'un site, la taille d'une Retouche et la taille de l'interface « 110% », la date d'un élément de dossier vivant et celle du pied d'un PDF enregistré sont en anglais.
- **Nom automatique d'une session, en anglais** : il écrit le mois en lettres, « Session from 10 Nov 2026 at 14:32 ». « 10/11/2026 » se lisait 10 novembre ou 11 octobre selon le lecteur. Le nom français ne change pas.
- **Un nom par chose, suite** : en anglais, les onglets du jour sont partout « Today tabs » (plus « tabs of the day »), l'infobulle des flèches dit « Back » et « Forward » comme le menu, et une phrase française reprise ailleurs a la même traduction. En français, les notes de mise à jour disent « cette version » et non « cette build ».
- **Raccourci pour un site** : la feuille « Créer un raccourci pour ce site… » énonce la règle du mot-clé et celle de l'adresse avec les phrases des Réglages. Les deux formulaires refusaient la même saisie avec deux règles dites autrement.
- **Autorisations d'une extension** : la feuille d'installation dit « Lire vos favoris et vos onglets épinglés » pour l'API des signets, qui ne modifie rien dans Lucium. Elle disait « Lire et modifier vos favoris ».
- **Proposition de mise à jour** : les notes ne sont plus coupées au milieu d'un mot, mais après un titre entier. Avec l'interface en anglais, elles sont en anglais et « Télécharger manuellement » ouvre la page de téléchargement en anglais. Elles étaient en français pour tout le monde.
- **Copies de session** : une copie faite avec « Faire une copie maintenant » et celle d'avant une restauration ne sont plus supprimées par les copies automatiques suivantes. Elles sont comptées à part : les dix plus récentes restent. Le nombre des Réglages ne vaut que pour les copies automatiques.
- **Fichier d'état mis de côté** : les copies automatiques de la session perdue ne sont plus chassées par celles de l'état neuf. L'avis de lancement vous envoie les chercher : elles restent dans Fichier › Sessions… tant que le fichier mis de côté existe.
- **Image d'un espace ou d'un onglet** : elle n'est plus supprimée du disque tant qu'une copie de session ou la copie faite avant une restauration la nomme. Remettre cette copie ramène l'image ; avant, l'espace revenait avec son emoji.
- **Profil manquant** : avant de remettre les espaces sur le profil par défaut, Lucium copie le fichier d'état, et la boîte nomme cette copie. Si le dossier du profil revient, Aide › Restaurer les données… remet chaque espace sur son profil.
- **Restaurer les données** : la question dit ce qu'un export ne contient pas (historique, cookies, mots de passe, scripts utilisateur, règles de vos listes de filtres, images et fonds des espaces).
- **Emoji d'un espace** : un fichier d'état modifié à la main ou un import ne peut plus mettre un mot à la place de l'emoji d'un espace. Un seul emoji, une seule lettre ou un seul chiffre sont gardés ; le reste devient ✨.
- **Sites en IPv6** : un site ouvert par son adresse IPv6 (`http://[::1]:3000`) peut être ajouté aux sites gardés éveillés et aux sites sans blocage. L'adresse était refusée comme invalide.
- **Extensions du magasin** : leur dossier, dans les données de Lucium, n'est plus lisible par les autres comptes de ce Mac, comme le reste du dossier.
- **Apparence automatique** : le Coup d'œil, l'éditeur de thème, la mini-fenêtre et la feuille « Nouvel espace » suivent le passage de macOS du clair au sombre pendant qu'ils sont ouverts. Ils gardaient l'apparence qu'ils avaient à l'ouverture jusqu'à ce qu'autre chose les redessine.
- **Fond d'un espace** : l'aperçu montre le fichier que l'espace a maintenant. Après deux changements de fond rapprochés, la lecture du premier fichier, arrivée en retard, pouvait remplacer l'aperçu du second.
- **Extensions, écouteur bloquant** : une extension qui pose un écouteur `webRequest` « blocking » en est avertie dans sa console, et le journal de Lucium le note : l'écouteur est informé des requêtes, mais sa réponse n'est pas appliquée. Rien ne le disait.
- **Mise à jour d'une extension acceptée** : si la nouvelle version ne peut pas être mise en place (disque plein, dossier protégé), la version installée est rechargée aussitôt et un message le dit. L'extension restait arrêtée jusqu'au lancement suivant, sans explication.
- **Contraste de la page** : sur une page qui change une couleur sans fin par script, le moteur n'écrit plus une règle de plus à chaque valeur. À 5 000 règles il cesse de lire les éléments (les feuilles recolorées restent), et ses mémoires de couleurs et d'images sont bornées.
- **Reprise des téléchargements, fichier terminé** : un téléchargement qui se termine pendant la fermeture de la fenêtre ne laisse plus son enregistrement, et un fichier aussi long que le téléchargement entier n'est jamais tronqué ni supprimé (reprise, ligne retirée, 72 heures, réglage désactivé). Il pouvait passer pour un fichier partiel et être supprimé.
- **Reprise des téléchargements, fichier des enregistrements** : une écriture qui échoue ne laisse plus de `download-resume.json.tmp` à côté du fichier, et désactiver le réglage retire celui qui restait. Cette copie gardait les adresses des téléchargements, jetons compris.
- **Icône d'un onglet privé** : une icône de plus de 256 Ko est refusée avant d'être lue en entier, et une icône lente ne se pose plus sur la page où l'onglet est allé entre-temps.
- **Fenêtre de connexion d'une extension** : ses boîtes de dialogue répétées peuvent être coupées, et elle ne joue aucun son sans geste, même cachée. ⌘W ferme cette fenêtre et ⌘R la recharge, au lieu d'agir sur l'onglet derrière.
- **Export Markdown, notice** : la ligne qui dit qu'un contenu n'a pas été converti suit la langue de l'interface. Elle était toujours en français.
- **Pages surveillées** : le texte est lu hors de portée de la page et coupé à 200 000 caractères par Lucium lui-même. Une page pouvait en remettre des dizaines de mégaoctets à chaque passage.
- **Extensions du Web Store, manifeste** : quand Lucium ajoute son script aux scripts de contenu d'une extension, le manifeste est remplacé d'un seul geste, et un manifeste tronqué est refait depuis la copie gardée à côté. Un arrêt au milieu laissait une extension qui ne se chargeait plus avant d'être réinstallée.
- **Recherche par expression régulière** : une page qui remet plus de texte qu'une recherche n'en lit (4 millions de caractères) est refusée avant que l'expression tourne.
- **Traduction locale, page quittée** : une traduction qui attendait son tour, ou qui interrogeait macOS sur les langues, ne se lance plus si l'onglet est passé à une autre page ou si l'original a été demandé. L'autre page était traduite avec les mauvaises langues, et ses phrases rangées sous le premier site.
- **Traduction locale, « Arrêter »** : « Arrêter » pendant le chargement d'un modèle arrête ce chargement aussitôt. Le panneau répondait « occupé » et les autres traductions attendaient la fin du chargement, jusqu'à deux minutes.
- **Raccourcis des extensions, noms de touches** : une touche suggérée nommée comme un membre que tout objet possède (`constructor`, `toString`) n'est plus prise pour une touche. Le menu Extensions et les Réglages recevaient un raccourci qui ne voulait rien dire ; le menu n'accepte plus que des modificateurs et une touche.
- **Textes en anglais** : avec l'interface en anglais, quatre textes restaient en français : le dossier des favoris donné aux extensions, le nom d'un groupe d'onglets sans titre, le nom par défaut d'un dossier en direct, et le détail « Action » du rechargement automatique dans la barre de commandes.
- **Identification HTTP sans chiffrement** : avec le schéma Digest sur une connexion en clair, le panneau prévient maintenant que la connexion n'est pas chiffrée, avec un texte à lui : le mot de passe n'est pas envoyé tel quel, mais ce qui est envoyé peut suffire à le retrouver.
- **Coller dans une note** : coller un bloc de code fait de dizaines de milliers de lignes vides suivies d'un caractère ne fige plus la fenêtre. Le bloc est d'abord coupé à la taille d'un collage, et ses fins de ligne en trop sont retirées sans expression régulière.
- **Copie de session illisible** : quand la réparation d'une copie de session ou d'un fichier à restaurer échoue, la raison est écrite dans le journal, et la copie est écartée pour ce motif. Avant, l'erreur disparaissait et la copie était dite « sans espace ni onglet utilisable ».
- **Dossiers imbriqués par milliers** : un fichier d'état, un export ou une copie de session où des milliers de dossiers sont chacun dans le précédent se lit sans erreur de pile ; les dossiers sont ramenés à quatre niveaux. Lucium lit au plus 5 000 dossiers d'un fichier, les premiers.
- **Retouches avec un script** : le script que vous tapez est gardé au fil de la frappe comme un brouillon à part : rien n'est perdu si Lucium se ferme, et aucune page n'exécute un script à moitié tapé. Les pages exécutent le dernier script enregistré (« Enregistrer le script ») ; « Lancer l'aperçu » essaie le brouillon une fois dans la page affichée.
- **Gomme** : une modification faite dans le panneau de la Retouche pendant que la Gomme est active n'efface plus les éléments que vous venez de masquer.
- **Précédent et Suivant** : un clic droit ou un ⌃-clic sur ces boutons n'arme plus l'appui long. Le menu des pages ne peut plus s'ouvrir une seconde fois après avoir été refermé.
- **Réglages, cartes animées** : le dessin d'une carte est caché aux lecteurs d'écran, qui en lisaient les mots à la suite (fausse adresse, touches, états « avant » et « après »). Le nom de la carte et sa légende disent l'effet.
- **Son d'un onglet** : pour un lecteur d'écran, le bouton s'appelle « Couper le son de l'onglet » et dit s'il est enfoncé. Il portait le nom de l'état (« Son coupé »), sans dire qu'un appui rétablit le son.
- **Réglages › Outils web** : le titre « Résumé de page par un modèle local » n'est plus écrit deux fois de suite.
- **Test de connexion à Ollama** : si la demande n'aboutit pas, le bouton revient et la ligne dit l'échec. Il restait grisé sur « Test de la connexion… » jusqu'à la réouverture du volet.
- **Mini-fenêtre et application web, en anglais** : avec l'interface en anglais, l'en-tête d'un site ouvert comme application, le sélecteur d'espaces et le plateau de téléchargements de la mini-fenêtre ne restent plus en français, et un lecteur d'écran ne les lit plus avec la voix française.
- **Lire plus tard, suppressions annulables** : une page supprimée, ou la liste vidée, se reprend pendant six secondes avec « Annuler », comme dans les notes. À la confirmation de « Tout effacer », « Annuler » prend la place du premier bouton : un double-clic ne vide plus rien.
- **Lire plus tard, dossiers au clavier** : deux boutons montent et descendent une page dans son dossier (seul le glisser-déposer le permettait), et le champ « Nouveau dossier » a un nom pour les lecteurs d'écran.
- **Notes, texte abandonné** : une note quittée avec un texte non enregistré (Échap, « Annuler », « Terminé ») se reprend pendant six secondes. « Terminé » abandonne d'abord la note et laisse le panneau ouvert ; un second clic le ferme.
- **Cookies d'un site, modèle de traduction** : « Supprimer » demande un second clic avant de retirer les cookies d'un site ou un modèle de traduction, comme « Nettoyer » le fait déjà.
- **DNS chiffré, « Autre adresse »** : l'adresse est enregistrée quand vous quittez le champ ou appuyez sur Entrée, et plus à chaque frappe : les adresses de passage (`https://d/`, un autre domaine) ne sont plus mises en service. Une adresse refusée dit pourquoi, et que la précédente reste utilisée.
- **Demandes qui échouent** : le gestionnaire de tâches dit pourquoi sa liste est vide ou pourquoi un processus n'a pas pu être arrêté ; la feuille « Nouvel espace » ne reste plus sur « Création… » ; « Définir comme navigateur par défaut » de l'accueil ne reste plus grisé ; « Trouver et remplacer » dit qu'un remplacement a échoué.
- **Textes et tris** : en anglais, le panneau de traduction écrit « Models folder: » sans espace avant les deux-points ; les extensions des Réglages et les espaces du gestionnaire de tâches sont triés selon la langue de l'interface.
- **Barre de commandes, ⇧⌫** : la touche n'oublie une page de l'historique que si sa ligne a été choisie aux flèches ; pendant la frappe, elle efface une lettre. La barre dit que la page est oubliée, et le dit aussi quand l'oubli ou la lecture de l'historique échoue.
- **Mots de passe, générateur** : la longueur se tape au clavier. Elle était ramenée entre 8 et 128 à chaque frappe (« 3 » donnait 8, puis « 2 » donnait 82) ; elle l'est maintenant en quittant le champ ou sur « Générer ».
- **Mots de passe, trop d'essais** : le délai d'attente se décompte à l'écran et « Déverrouiller » reste éteint jusqu'à son terme. Le nombre restait figé, et un essai fait trop tôt partait pour être refusé.
- **Mots de passe, verrouillage** : ce qui a été tapé pendant que le coffre était ouvert (phrase actuelle, nouvelle, d'export ou de suppression, mot de passe généré) est effacé de la page dès que le coffre est verrouillé.
- **Messages d'erreur** : « Effacer les données du site », Réglages › Verrouillage et la page des extensions montrent la phrase de l'erreur, sans le préfixe technique « Error invoking remote method… » ni le nom du canal.
- **Premier lancement** : pendant l'import, « Plus tard », Échap et un clic hors de la feuille ne la ferment plus : le compte rendu et « Annuler l'import » ne sont plus perdus. Deux clics rapprochés ne lancent qu'un import, et des choix qui n'ont pas pu être enregistrés sont dits.
- **Panneau des ressources** : « Onglet mis en veille » et « Onglet fermé » ne sont dits qu'une fois la chose faite. Pour un onglet refusé ou une demande perdue, le panneau dit que l'onglet n'a pas pu être mis en veille ou fermé.
- **Partage de fenêtre annoté** : quand une demande de la fenêtre de commande échoue (liste des fenêtres, démarrage, arrêt, mode passage, outil), elle le dit au lieu de garder « Partage en cours », et l'erreur arrive dans État de Lucium.
- **Réglages, Contrôle du trafic aérien** : à l'ouverture, le curseur est dans le champ du site. Il était sur « Retirer » de la première règle, qu'Entrée supprimait.
- **Effacer les données du site, limite** : au-delà de 20 sites, ceux qui sont collés ou tapés en trop sont refusés tout de suite, avec la phrase qui le dit. Une longue liste devenait autant d'étiquettes et de demandes de comptage des cookies.
- **Personnaliser l'espace, profil** : choisir un autre profil pour un espace qui a des onglets demande une confirmation, puisque tous ses onglets sont rechargés et déconnectés de leurs sites. Le choix dans le menu s'appliquait aussitôt.
- **Accessibilité** : la liste des profils est un groupe de boutons qui disent lequel est affiché ; la confirmation d'effacement garde le focus ; les aides des cases d'« Effacer les données du site », la raison d'un bouton éteint et le nom de l'espace d'un onglet dans la barre de commandes sont lus.
- **Échecs dits** : un profil qui n'a pas pu être créé et un dossier de téléchargement qui n'a pas pu être choisi le disent à l'écran, au lieu d'un bouton qui ne fait rien.
- **Page des extensions, journal** : un journal ouvert qui reçoit des lignes ne fait défiler que sa propre liste, et seulement si vous étiez à la fin. La page ne bouge plus, et la lecture de lignes plus anciennes n'est plus interrompue.
- **Panneaux fermés** : un panneau fermé est retiré aussitôt de la mémoire de l'interface. Le mot de passe tapé, la capture ou la liste qu'il montrait ne restent plus jusqu'à l'ouverture du panneau suivant, et une suppression qui attendait « Annuler » (page de l'historique, espace) est faite dès la fermeture.
- **Panneau qui ne se dessine pas** : un panneau qui échoue à se dessiner ferme son calque, et la question qu'il portait (autorisation, identification) reçoit un refus. Il laissait un calque vide par-dessus la fenêtre et une question sans réponse.
- **Infos et réglages du site, fermeture** : un panneau ouvert juste après Échap sur ce panneau (barre de commandes, recherche dans la page) ne se referme plus tout seul.
- **Réglages › Raccourcis** : « Tout réinitialiser » peut être annulé, ce qui rend les raccourcis que vous aviez choisis. Chaque touche est annoncée avec le nom de sa commande, et le menu « Plus d'actions » se pilote au clavier (flèches, Échap).
- **Listes de filtres personnalisées** : « Retirer » demande confirmation avant de supprimer la liste et ses règles. Un échec du retrait ou de la mise à jour des listes est dit dans les Réglages.
- **Annotation de capture** : « Nouvelle capture » demande confirmation quand la capture porte des annotations, comme « Abandonner ». Un clic à côté de « Rétablir » ne perd plus le dessin.
- **Historique, « Oublier ce jour »** : toutes les pages du jour sont oubliées, et plus seulement celles que le panneau avait chargées. Le panneau dit quand il n'affiche que les 500 pages les plus récentes.
- **Modifier l'onglet** : ouvrir « Code QR », « Traduire », « Nommer la fenêtre » ou « Dossier en direct » n'envoie plus l'onglet vers l'adresse tapée dans le champ ; seul « Enregistrer » le fait. Une adresse qui ne peut pas être chargée, l'onglet étant en veille, est signalée.
- **Import** : la feuille ne se ferme plus pendant que l'import s'écrit, ni par son bouton, ni par Échap, ni par un clic au-dehors. La fermer n'arrêtait rien et faisait perdre le bouton « Annuler l'import ».
- **Infos et réglages du site, clavier** : le bouton qui efface les données du site porte ce nom pour un lecteur d'écran (il s'appelait « Plus »), la confirmation prend le focus, et « Annuler » sur la suppression d'une Retouche le rend à sa corbeille. « Image dans l'image automatique » dit qu'elle vaut pour tous les sites.
- **Échecs signalés** : quand le processus principal échoue, l'éditeur de thème (copier, coller, appliquer à tous les espaces, couleur du site), le panneau des espaces (mise de côté) et l'ajout d'une extension depuis le panneau du site le disent, au lieu d'un bouton sans effet.
- **Lecteur d'écran** : « Cette page ne déclare pas de couleur », dans l'éditeur de thème, est annoncée, et le temps de la vidéo flottante porte son nom.
- **Scripts utilisateur** : « Retirer » demande un second clic et dit que le code ne pourra pas être récupéré. Avant, un seul clic, juste à côté de « Voir le code », effaçait le script pour de bon, même un script collé à la main qui n'existait nulle part ailleurs.
- **Fond d'un espace, « Supprimer »** : le fichier n'est plus effacé tout de suite. Dans l'éditeur de thème, Échap ou « Réinitialiser » remettait l'espace sur un fichier disparu : fond vide et lecture impossible. Le fichier est supprimé à un lancement suivant, quand plus rien ne le nomme.
- **Dossier en direct** : « Source du dossier en direct » s'ouvre avec la source, ce qui est suivi et le nom du dossier. La feuille s'ouvrait vide et il fallait tout retaper pour changer un seul champ.
- **Proxy manuel** : l'adresse est enregistrée quand vous quittez le champ ou appuyez sur Entrée, plus à chaque frappe (le trafic partait un instant vers `hôte:8`, `hôte:80`, `hôte:808`). Tant que le proxy affiché n'est pas enregistré, les Réglages le disent. Un test de connexion qui n'a pas pu être lancé le dit aussi.
- **Demandes sans réponse** : le panneau Sessions dit quand la liste des copies automatiques n'a pas pu être lue, quand une restauration confirmée a échoué et quand une copie n'a pas pu être faite ; Réglages › Général dit quand Lucium n'a pas pu être défini comme navigateur par défaut. Avant, rien ne se passait et rien n'était dit.
- **Sessions, espace mis de côté** : pendant la confirmation de la suppression, le panneau écrit que l'espace, son thème et ses onglets partent avec la session. Ce n'était dit que dans une info-bulle, que ni le clavier ni un lecteur d'écran ne reçoivent.
- **Signets, grande bibliothèque** : la liste affiche les 200 premiers signets, puis les suivants à la demande ; la recherche porte toujours sur toute la bibliothèque. Après un gros import (jusqu'à 5 000 signets), le panneau tardait à s'ouvrir et la recherche saccadait.
- **Largeur de la barre latérale au clavier** : le bord de la barre latérale reçoit le focus et se règle avec ← et → (Maj pour un pas plus grand), Début et Fin ; un lecteur d'écran lit la largeur. Elle ne se réglait qu'à la souris.
- **Partage de fenêtre annoté, saisie en japonais, chinois ou coréen** : Entrée pendant la composition d'un texte choisit le caractère proposé au lieu de poser le texte à moitié saisi ; Échap abandonne la composition sans jeter le texte.
- **Annotation de la page, saisie en japonais, chinois ou coréen** : dans la zone de texte, Entrée pendant la composition choisit le caractère proposé et Échap abandonne la composition. La zone se fermait et posait le texte à moitié saisi.
- **En-tête de la mini-fenêtre** : le titre et l'adresse de la page s'affichent même quand la fenêtre s'ouvre sur un Mac très occupé. L'en-tête pouvait rester vide jusqu'au changement de page suivant. De même pour l'en-tête d'un site ouvert comme application et pour le plateau de téléchargements.
- **État de Lucium, erreurs de l'interface** : une erreur que le moteur ne détaille pas (boucle d'un `ResizeObserver`, script d'une autre origine) est écrite avec son message et sa place. Le journal n'écrivait que « null ».
- **Bord tiré puis changement d'application** : tirer le bord de la barre latérale, d'un panneau ou d'une vue scindée s'arrête quand la fenêtre n'est plus au premier plan ou que le système annule le pointeur.
- **Bulle d'aide orpheline** : la bulle d'un bouton disparaît quand le bouton disparaît sous le pointeur (un bouton du lecteur quand le son s'arrête, la tuile d'un onglet qui se ferme). Un tel bouton ne reçoit aucun signal de sortie du pointeur.
- **Fermer l'onglet** : « Fermer l'onglet » du menu d'un onglet, d'une sélection ou de la carte de survol archive maintenant l'onglet du jour, comme ⌘W. « Rouvrir le dernier onglet fermé » le retrouve.
- **Fermer les autres onglets du jour** : la page ouverte d'un favori et les autres volets de la vue scindée de l'onglet gardé restent ouverts, comme avec « Vider les onglets du jour ».
- **Fenêtres aux onglets indépendants** : mettre un espace de côté garde aussi les onglets que les autres fenêtres ont dans cet espace, et les rouvre avec lui. La question compte tous les onglets fermés, pour la mise de côté comme pour la suppression depuis le menu de l'espace.
- **Dossiers en direct** : la copie d'un dossier en direct faite au-delà de la limite de 20 est un dossier ordinaire, au lieu d'un dossier qui paraît en direct et n'est jamais relu.
- **Rétablir les réglages** : « Rétablir les valeurs par défaut » de la catégorie Outils garde l'adresse et le modèle Ollama que vous avez saisis. Il remet l'interrupteur et les curseurs à leur valeur d'origine.
- **Arbre d'onglets** : une très longue chaîne d'onglets ouverts l'un depuis l'autre, lue dans un fichier restauré, n'empêche plus la barre latérale de s'afficher.
- **Onglet en veille sous le pointeur** : son titre garde un contraste de 4,5:1 sur toutes les couleurs d'espace quand le pointeur passe sur sa ligne. Sur plusieurs couleurs sombres il descendait à 3,4:1 environ.
- **Restaurer les données, ce qui reste d'ici** : la question dit aussi que « Surveiller des pages », les commandes par adresse `lucium://` et la recherche automatique des mises à jour restent allumées ou éteintes comme sur cette installation.
- **Annotation de la page, gomme** : passée vite sur un trait, elle l'efface. Elle ne regardait que les points où le pointeur était signalé, et le moteur regroupe un mouvement rapide en un seul : la gomme sautait par-dessus le trait. Elle efface maintenant tout le long de son chemin.
- **Panneaux, premier affichage** : un panneau s'affiche dès sa première image avec l'état de sa fenêtre. Avec la barre latérale à droite, la fenêtre des téléchargements apparaissait un instant à gauche, sur la page, avant de rejoindre la barre latérale ; un Mac chargé faisait durer ce décalage.
- **Espace verrouillé, « Nouveau dossier »** : dans le menu Onglets, dans le menu de l'espace (clic droit ou en-tête) et dans le menu « + », l'entrée est grisée tant que l'espace est verrouillé, et son infobulle dit pourquoi. Elle restait active, et le clic était refusé par un avis.
- **Raccourcis clavier, « Réinitialiser » sur une ligne** : le raccourci par défaut revient, et un avis propose « Annuler la réinitialisation » pendant quelques secondes pour retrouver celui que vous aviez choisi, qui était perdu. ⌘Z fait de même, et reprend aussi « Tout réinitialiser » et le retrait des conflits tant que leur avis est affiché.
- **Onglet éveillé sous le pointeur** : son titre garde un contraste de 4,5:1 sur toutes les couleurs d'espace quand le pointeur passe sur sa ligne. « Sable » en sombre descendait à 4,46:1, et des couleurs claires choisies en sombre à 4,2:1. Le fond ne change pas : seul le texte devient un peu plus franc, là où il le faut.
- **Mise à jour retirée après son téléchargement** : quand le fichier de versions liste comme retirée la version déjà téléchargée (relu à la recherche suivante, par « Rechercher les mises à jour… » ou en quittant), elle n'est pas installée : Lucium efface ce qu'il avait préparé, le dit par un avis et propose la version à installer. Elle s'installait à la fermeture.

### Sécurité

- **Flux de mises à jour signé** : Lucium ne croit le fichier qui annonce une nouvelle version que s'il porte une signature faite avec une clé gravée dans l'application. Sans signature valide, sur le canal stable comme sur le canal de test, aucune mise à jour n'est proposée, aucune version n'est dite retirée, et « Rechercher les mises à jour… » le dit.
- **`chrome.debugger`** : une extension ne peut plus simuler le dépôt de fichiers sur une page (la page lisait alors n'importe quel fichier de votre disque), ni une touche qui colle votre presse-papiers dans la page.
- **Page locale** : une page ouverte depuis un fichier ne peut plus lire la réponse d'un site web en la demandant autrement (`fetch` en mode `same-origin` ou `no-cors`). Un worker partagé d'une page locale ne peut plus rien demander au web.
- **Certificat non valide** : un site qui a exigé une connexion sécurisée (HSTS) reste connu après un redémarrage de Lucium, pour la durée qu'il a demandée : « Continuer quand même » ne revient plus pour lui. Une fenêtre privée ne garde rien, et « Effacer les données » oublie ces sites.
- **Certificat non valide, à la fermeture** : la liste des sites qui exigent une connexion sécurisée (HSTS) est aussi écrite quand Lucium se ferme. Un site visité pour la première fois dans la dernière seconde n'est plus oublié au lancement suivant.

- **Moteur de Lucium** : la version distribuée quitte la préversion du moteur (45.0.0-alpha.14) pour sa version stable 45.2.1 (Chromium 156.0.8078.75), celle sur laquelle Lucium est testé, avec les correctifs de Chromium parus entre les deux. La construction refuse désormais un moteur de préversion.
- **Commutateurs de lancement** : l'application construite ne démarre plus avec le commutateur de test `--smoke`, ni avec ceux du débogage distant (`--remote-debugging-port`, `--remote-debugging-pipe`), ni avec ceux qui affaiblissent TLS, la résolution des noms, le trousseau ou le bac à sable ; elle ignore les variables de test.
- **Adresse affichée** : quand une page part vers une adresse de plus de 65 536 caractères (une redirection suffit), l'onglet affiche bien le nouveau site, avec l'adresse coupée. Il gardait le nom et la mention « Sécurisé » du site quitté au-dessus de la page d'un autre.
- **Onglets des extensions** : une extension qui demande un onglet à une adresse qui ne s'ouvre pas dans un onglet (`data:`, `blob:`) reçoit une erreur. Elle recevait à la place un onglet déjà ouvert, parfois celui d'un autre profil, qu'elle pouvait ensuite naviguer ou fermer.
- **Fichier local ouvert dans un onglet** : une page ouverte depuis un fichier (`file://`) ne lit plus, par `fetch` ou `XMLHttpRequest`, la réponse d'un site, d'un service de votre machine ou de votre réseau local, sauf si le serveur la partage avec tous. Elle affiche toujours ses images, styles et scripts, y compris ceux d'un site, comme une page enregistrée.
- **Mode développeur** : il n'accepte plus sans question un certificat non valide que pour un site de ce Mac ou du réseau local (`localhost`, `.local`, adresse privée). Un site d'internet mis en mode développeur garde sa page « Votre connexion n'est pas privée » et son « Continuer quand même ».
- **Certificat non valide** : un site qui exige une connexion sécurisée (HSTS) n'offre plus « Continuer quand même ». Lucium le sait pour les domaines entièrement préchargés (`.app`, `.dev`, `.page`, `.bank`…) et pour un site qui l'a demandé par son en-tête pendant la session.
- **Accès d'un site à vos fichiers** : la question nomme le fichier ou le dossier, et dit s'il sera lu ou modifié, au lieu de « utiliser « fileSystem » ». La case « Se souvenir » n'est plus offerte : un site redemande pour chaque fichier ou dossier.
- **Fichiers de l'application** : au lancement, Lucium compare les scripts qu'il charge dans les pages (lecture des formulaires de connexion, garde des pages, extensions) avec les empreintes scellées dans son archive. Si l'un d'eux a été modifié ou supprimé, il ne démarre pas et le dit.
- **Icône d'un onglet** : l'icône qu'une page déclare passe par le bloqueur avant d'être chargée par la barre latérale. Une page ne peut plus faire contacter un traqueur que le bloqueur refuse en le déclarant comme son icône ; l'onglet montre alors sa lettre.
- **Icônes des sites** : Lucium télécharge chaque icône une fois, dans le profil de l'onglet (ses cookies, son bloqueur), 256 Ko au plus et seulement une image. La barre latérale affiche cette copie et ne contacte plus aucun site ; elle chargeait chaque icône elle-même, hors du profil.
- **Verrouillage d'un espace** : quand l'espace affiché se verrouille seul (son verrou, ou la mise en veille du Mac), le Coup d'œil, le panneau latéral d'une extension, la recherche dans la page et le panneau ouvert se ferment. Ils restaient utilisables par-dessus l'écran de verrou.
- **Questions d'un onglet en arrière-plan** : une demande de permission, une connexion demandée par un serveur ou une boîte `prompt()` n'apparaît plus par-dessus un autre onglet, et l'onglet ne passe plus devant de lui-même. Une notice dit quel site attend ; la question s'ouvre quand vous y allez.
- **Coffre de mots de passe** : rien n'est rempli, ni proposé à l'enregistrement, sur une page dont le certificat non valide a été accepté (« Continuer quand même » ou mode développeur). Sur un réseau hostile, le mot de passe partait à celui qui interceptait la connexion.
- **Téléchargement en cours** : le fichier porte la marque « téléchargé depuis Internet » de macOS dès ses premiers octets, plus seulement une fois terminé. Un serveur qui laissait un téléchargement « en cours » sans fin livrait un fichier entier que Gatekeeper ne contrôlait pas.
- **Règles réseau des extensions** : une règle dont l'expression régulière peut prendre un temps sans fin sur une adresse choisie par une page (répétition dans une répétition, assertion avant ou arrière, référence arrière) est écartée à la lecture, avec une ligne dans le journal. Elle pouvait figer Lucium.
- **Panneau latéral d'une extension** : il ne s'ouvre plus à côté d'un onglet privé, ni dans une fenêtre privée, que la demande vienne de l'extension ou d'un clic sur son icône. L'extension recevait le numéro de l'onglet privé.
- **Scripts utilisateur et Retouches** : un code dont une ligne change le sens de lecture, ou qui contient une fin de ligne invisible (U+2028, U+2029), est refusé avec le numéro de la ligne : le code lu ne serait pas le code exécuté. Un autre caractère invisible (espace sans chasse, liaison d'un emoji composé) est accepté, avec un avertissement qui dit la ligne à relire.
- **Ouvrir sans l'enregistrer** : d'autres types de fichiers de macOS ne s'ouvrent plus depuis le dossier temporaire ni avec une application mémorisée : raccourcis vers un serveur (`.afploc`, `.smbloc`, `.vncloc`), panneaux de préférences, économiseurs d'écran, modules, pages enregistrées `.webarchive`, archives `.xip`.
- **Demande de permission** : un clic sur « Autoriser » qui arrive moins d'une demi-seconde après l'apparition de la bulle n'est pas pris pour une réponse ; la bulle reste. Une page ne peut plus vous faire cliquer vite à cet endroit, puis demander la caméra ou le micro juste avant le clic.
- **Enregistrement d'un mot de passe** : « Enregistrer » et « Ignorer » ne valent que pour l'identifiant affiché au moment du clic. Si un formulaire envoyé dans un autre onglet l'a remplacé entre-temps, rien n'est enregistré et le panneau montre le nouvel identifiant proposé.
- **Volet web** : le volet se ferme quand son espace change de profil, au lieu de rester ouvert avec les comptes de l'ancien profil. Et quand la page du volet quitte le site pour lequel il a été ouvert (un lien, une redirection), son nom est suivi du site affiché.
- **Identifiant supprimé du coffre** : la copie du coffre d'avant la suppression (`passwords.vault.bak`) est retirée aussitôt. Elle gardait l'identifiant supprimé, chiffré, jusqu'à la modification suivante du coffre.
- **Plein écran d'une page** : une page ne peut plus garder la touche Échap pour elle (`navigator.keyboard.lock()` est refusé). Une page en plein écran couvre toute la fenêtre, adresse comprise : Échap reste toujours la sortie.
- **Adresse affichée** : un nom de site trop long pour la barre d'outils, la pastille de la barre latérale ou l'en-tête de la mini-fenêtre est raccourci par ses sous-domaines ; le domaine lui-même reste entier. La mini-fenêtre affiche le site à toutes les largeurs.
- **Page sans nom de site** : pour une page vide (`about:blank`), un fichier local ou une adresse `data:`, l'emplacement de l'adresse affiche ce que dit l'adresse, plus le titre. Une page choisit son titre et pouvait y écrire le nom d'un autre site.
- **Page en http** : la barre d'outils dit « Non sécurisé » pour une page arrivée sans chiffrement, comme la barre latérale le signalait déjà. Une page servie par ce Mac lui-même (`localhost`) ne traverse aucun réseau : elle n'a pas cette mention.
- **Débogueur des extensions** : une extension ne peut plus choisir à la place de l'utilisateur un compte (connexion fédérée) ou un appareil, ni remplir un formulaire avec une carte enregistrée. Les domaines `FedCm`, `DeviceAccess`, `DigitalCredentials`, `Autofill` et trois autres sont refusés.
- **Débogueur des extensions, clés d'accès** : `chrome.debugger` refuse aussi le domaine `WebAuthn`. Une extension ne peut plus brancher un authentificateur virtuel, qui répondait à la place de votre clé à une demande de clé d'accès de la page et rendait les clés privées qu'il avait créées.
- **Verrou** : une mini-fenêtre, une fenêtre d'application, la vidéo flottante, la barre d'annotation ou une fenêtre de partage restée ouverte pendant que Lucium est verrouillé n'est plus écoutée. Ces fenêtres se ferment au verrouillage ; le refus tient maintenant même si l'une d'elles restait.
- **Annotation de la page** : le calque qui porte vos traits et vos textes vit désormais à part des scripts du site. La page ne peut plus lire ni modifier ce que vous y dessinez ou écrivez. Une page qui écoutait déjà toute sa fenêtre avant l'annotation reçoit encore le pointeur et les touches, comme pour tout ce qui se passe sur elle.
- **Annotation de la page, touche qui pose un texte** : Entrée ou Échap, qui ferme la zone de texte, n'arrive plus du tout à la page. Son relâchement venait après la fermeture et la page le recevait : un site qui réagit à Entrée pouvait agir quand vous posiez votre texte.
- **Règles réseau des extensions** : une règle à plusieurs `*`, ou une expression régulière à répétitions successives, ne peut plus figer Lucium sur une adresse longue choisie par une page. Un filtre est comparé en un nombre d'étapes borné ; une expression n'est essayée que sur une adresse assez courte pour elle, ou la règle est écartée.
- **Règles réseau des extensions, journal** : quand une règle n'est pas appliquée à une requête parce que l'adresse est trop longue pour elle, ou que la comparer demandait trop d'étapes, le journal de l'extension le dit, une fois par règle. La règle cessait de s'appliquer sans un mot.
- **Requêtes de Lucium et extensions** : les requêtes que Lucium fait lui-même (relecture d'une page, images d'une page enregistrée, reprise d'un téléchargement) ne passent plus par les règles ni par les écouteurs des extensions, qui pouvaient les bloquer, les détourner ou les lire.
- **Onglet prêté à une extension (activeTab)** : le prêt qu'un clic sur l'icône d'une extension lui fait de l'onglet s'arrête pour de bon quand l'onglet change de site. Il reprenait sans nouveau clic dès que l'onglet revenait sur le site, par un lien, une redirection ou le bouton Précédent.
- **Extension présente dans deux profils** : ce qu'une extension peut faire dans un profil se lit dans la version que ce profil a chargée. Quand deux profils en avaient deux versions, les permissions de celle chargée en dernier valaient pour les deux.
- **Script d'une extension dans un onglet prêté** : l'adresse de l'onglet est relue juste avant chaque script et chaque feuille de style, et plus seulement à la réception de la demande. Un onglet parti ailleurs pendant la lecture des fichiers de l'extension ne reçoit plus rien.
- **Monde des scripts d'une extension** : dans un onglet prêté, chaque extension a son propre monde isolé, attribué une fois pour toutes. Il était calculé à partir de son identifiant, et deux extensions pouvaient tomber sur le même et lire les variables l'une de l'autre.
- **Événements d'une extension** : le worker d'une extension ne peut plus s'abonner aux événements d'une autre extension du profil, ni lui retirer les siens. Seules les pages d'extension étaient vérifiées.
- **Bloqueur, listes de filtres** : une règle d'une liste publique à plusieurs `*`, ou une expression régulière coûteuse, ne peut plus figer Lucium sur une adresse longue choisie par une page. Ces règles (moins de 200 sur 130 000) sont écartées à la compilation, et le moteur ne lit que les 2 048 premiers caractères d'une adresse.
- **Listes de filtres personnelles** : une expression régulière suivie d'options (`/…/$3p`, `/…/$1p`) est refusée comme les autres ; elle passait le tri. Une règle que le moteur écarte pour son coût (deux `*` sans nom d'hôte) est comptée parmi les règles non reconnues au lieu d'être gardée sans effet.
- **Scriptlets du bloqueur** : une expression régulière à deux répétitions successives (`a*a*b`, `a{0,99}a{0,99}b`) est refusée ; elle pouvait figer une page plusieurs secondes. `remove-attr` ne retire plus `sandbox`, `integrity`, `nonce`, `csp` ni `referrerpolicy`.
- **Scripts utilisateur** : `/payment`, `/pay`, `/billing`, `/signup`, `/password`, `/login;…`, `/%6cogin` et `www.login.…` sont reconnus comme pages de connexion ou de paiement. Le texte dit que ces pages sont reconnues à leur adresse, et non plus qu'elles ne sont « jamais touchées ».
- **Import de Retouches** : la lecture du CSS d'un fichier de Retouches ne ralentit plus sur des parenthèses imbriquées ; un fichier forgé pouvait occuper Lucium près d'une minute.
- **Fiche d'une extension** : la fiche d'installation et les droits accordés lisent les mêmes entrées du manifeste, 512 au plus par liste. Au-delà, l'extension est refusée, et une mise à jour n'est pas appliquée. Une autorisation ou un site écrit après des centaines d'entrées de remplissage n'était pas montré, mais accordé.
- **Mise à jour d'une extension** : passer d'un site précis à tous ses sous-domaines (`https://exemple.com/*` vers `https://*.exemple.com/*`), de `https` à tous les schémas, d'un chemin à tout le site ou d'un port à tous demande de nouveau votre accord. Ces élargissements s'appliquaient sans fiche.
- **Fiche d'une extension, tous les sites** : un motif qui couvre tout un suffixe public (`*://*.com/*`, `*://*.co.uk/*`) ou les WebSockets de tous les sites (`wss://*/*`) est annoncé comme un accès à tous les sites, avec l'avertissement. Il était montré comme le domaine « com » ou comme « certaines adresses ».
- **Export des signets** : avec « Inclure aussi les onglets du jour », les onglets privés d'une fenêtre normale ne sont plus écrits dans le fichier. Depuis le menu, l'export est refusé tant qu'un espace est verrouillé, comme depuis les Réglages.
- **Journal des erreurs, blocage** : une page ne peut plus figer les fenêtres avec un message d'erreur très long. Seuls les 4 000 premiers caractères d'une erreur sont lus, et la réduction des chemins prend un temps proportionnel à la longueur du texte.
- **Journal des erreurs, vie privée** : une adresse dont le chemin contient une apostrophe ou une parenthèse perd tout son chemin et ses paramètres ; un chemin sur un disque externe (`/Volumes/…`) est réduit au nom du fichier, une adresse `mailto:` à son domaine. Ces lignes vont dans « Signaler un problème ».
- **Restaurer les données** : un fichier restauré ne choisit plus le dossier de téléchargement, le dossier des modèles de traduction, le proxy ni le DNS, qui restent ceux de cette installation. Il n'accorde plus d'autorisation à un site (caméra, micro, position) : seuls ses refus sont repris. Ses onglets `devtools:` ne reviennent pas.
- **Effacer l'historique** : la liste des sites auxquels Lucium a déjà proposé d'ajouter leur recherche (jusqu'à 200 noms de sites visités) est vidée avec l'historique. Rien ne permettait de la vider.
- **Dossier vivant GitHub** : une adresse reçue de GitHub est comparée au dépôt une fois normalisée. `https://github.com/a/b/../../autre/page` commençait comme le dépôt et menait ailleurs.
- **Test de proxy** : un nom d'hôte est résolu avant le test, et l'adresse obtenue passe le même filtre qu'une adresse écrite en chiffres. Un nom qui pointait vers `169.254.169.254` passait.
- **Import de mots de passe** : dans un export Bitwarden, plusieurs adresses séparées par des virgules sont lues une à une. Elles étaient lues comme un seul site, qui n'existe pas, et l'identifiant n'était jamais proposé.
- **Mode lecture** : le lecteur se ferme quand une autre page arrive dans l'onglet. Ouvert pendant une navigation lente, il gardait l'article de la page précédente à l'écran sous l'adresse de la nouvelle.
- **Proxy refusé** : quand le moteur refuse un proxy, la session n'a plus de réseau jusqu'au prochain changement du réglage, et un message le dit. Elle continuait de sortir par sa route précédente.
- **Export Markdown, images** : une réponse n'est gardée que si son type est l'un des types d'image prévus (`constructor` passait pour l'un d'eux), et la requête ne nomme que l'origine de la page à un autre site, et rien de https vers http. L'adresse entière de la page partait.
- **Lecteur multimédia** : les marques que le lecteur laisse sur les médias d'une page (pause, volume) ne portent plus le nom de Lucium. Leurs noms sont tirés à chaque lancement.
- **Extension désactivée ou retirée** : Lucium oublie son manifeste quand elle quitte un profil. Une page de l'extension restée ouverte recevait encore les réponses des API que Lucium fournit lui-même ; ses appels sont maintenant refusés, comme pour une extension qui n'a jamais eu la permission.
- **Espace verrouillé, actions des menus** : « Vider Aujourd'hui », la remise à zéro des onglets épinglés, le rangement et le changement de profil d'un espace verrouillé sont refusés, avec un message. « Vider l'archive » ne vide plus que l'archive visible : les onglets archivés d'un espace verrouillé restent.
- **Espace verrouillé, restauration** : tant qu'un espace est verrouillé, « Restaurer les données… », la remise en place d'une copie de session et l'annulation d'un import sont refusées, avec la raison, comme l'export. Elles remplaçaient ou retiraient ses onglets sans la phrase.
- **Espace verrouillé, nom et apparence** : le nom, l'icône, le thème, le fond, l'image et l'en-tête d'un espace verrouillé ne changent plus sans la phrase. Leurs entrées de menu sont grisées, et « Appliquer ce thème à tous les espaces » le laisse tel quel. Le déplacer dans la liste reste permis.
- **Espace verrouillé, nouveau dossier** : « Nouveau dossier » et « Nouveau dossier en direct » sont refusés dans un espace verrouillé, avec un message, comme les autres changements de cet espace. Les autres espaces en créent toujours.
- **Espace verrouillé et `chrome.bookmarks`** : une extension ne lit plus les onglets épinglés ni les dossiers d'un espace verrouillé, et plus rien (ni favoris, ni noms d'espaces) tant que l'application est verrouillée. Elle recevait jusque-là tout l'arbre.
- **Export Markdown** : une page faite d'une très longue suite d'espaces ou de retours à la ligne (dans un bloc de code, un texte en gras, un lien ou une cellule de tableau) ne fige plus Lucium pendant des minutes à l'export. Les blancs des extrémités sont retirés par un parcours, plus par une expression régulière.
- **Espace verrouillé et gestionnaire de tâches** : le gestionnaire de tâches ne liste plus les onglets d'un espace verrouillé. Il donnait leur titre, rangé par espace, à qui l'ouvrait sans la phrase. Un onglet privé y est nommé « Onglet privé », sans son titre.
- **Classement de la barre de commandes** : les adresses choisies dans la barre ne sont plus comptées quand l'historique n'est pas enregistré. « Effacer l'historique de navigation » vide ce classement, et effacer l'historique d'un site en retire les adresses de ce site.
- **Conteneurs** : « Séparer de l'onglet épinglé » garde la page dans le conteneur de l'onglet épinglé. Elle se rechargeait hors conteneur, avec les cookies du profil.
- **Onglets privés** : la page d'un onglet privé ne peut plus devenir un volet web, qui est enregistré avec l'espace. Le titre d'un onglet privé n'est plus donné au système comme titre de la fenêtre (Mission Control, menu du Dock).
- **Coup d'œil** : l'en-tête de l'aperçu affiche le site réel de la page, sans la partie « nom@ » d'une adresse, garde toujours visible le nom de domaine principal et indique « Non sécurisé » pour une page en http.
- **Restaurer les données** : un fichier restauré ne décide plus si Lucium surveille des pages, accepte les adresses `lucium://` d'autres applications ou cherche les mises à jour. Ces trois réglages restent ceux de cette installation.

## [0.2.15] - 2026-11-10

### Ajouts

- **Barre latérale fenêtre par fenêtre** : chaque fenêtre met sa barre à gauche ou à droite pour elle seule, ou la colle en une colonne d'icônes (onglets épinglés, non-lus) avec « Plier la barre », ⌃⌘S, le clic droit ou le menu Affichage. Le réglage reste le côté des nouvelles fenêtres.
- **Traduction en un clic** : pour une page dans une autre langue, un bouton de la barre d'outils, « Traduire en français » au clic droit et dans le menu Fichier la traduisent sans panneau ; « Afficher l'original » est à un clic. « Toujours traduire l'anglais » et « Ne jamais traduire ce site » se retirent dans Réglages › Outils et extensions › Traduction locale.
- **Image dans l'image de Lucium** : l'onglet lui-même flotte dans une petite fenêtre au premier plan, sans rechargement, avec une barre complète (lecture, son et volume, −10/+10 s ou « EN DIRECT », retour à l'onglet). Un onglet dont la vidéo flotte ne s'endort jamais.
- **Notes** : éditeur visuel avec barre d'outils (titres, gras, italique, barré, listes, cases, citations, code, liens), le Markdown restant dessous (« M↓ ») ; partage par la feuille du Mac, téléchargement en .md, copie, import d'un .md.
- **Taille des fenêtres et des panneaux** : réglable par écran dans Réglages › Apparence (Automatique selon l'écran, Compacte à Très grande, ou un curseur avec aperçu) ; une notice la propose la première fois qu'un écran très large ou très petit sert.
- **Barre d'annotation où l'on veut** : glissez la poignée, les bords de la fenêtre montrent où elle s'accroche (colonne ou rangée), ou laissez-la flottante ; ou cliquez sur le nouveau bouton « Position », ou faites un clic droit, pour choisir. Une astuce le dit la première fois. Lucium retient la place.
- **Nouveau logo** : « les espaces en éventail », en huit versions de couleurs (Réglages › Général › Icône), avec la version Clair par défaut.

### Changements

- **Effacer les données du site** : la feuille prend la disposition de l'extension Clear Domain Data : domaines en étiquettes, « Inclure HTTP » et « Sous-domaines », tuiles des types, Fermeture auto, résultat par domaine. Dans Réglages › Vie privée et sécurité : confirmation, notification au raccourci et animation sur la page (sept au choix).
- **Pictogrammes en couleur** : le crayon, la note, le centre de contrôle et la vue scindée prennent de la couleur à l'intérieur, comme le bouton Mode lisible ; le contour reste à l'encre de la barre.
- **Traduction de page plus rapide** : ce qui est à l'écran se traduit d'abord, même au milieu d'une longue page ; un texte répété n'est traduit qu'une fois, et « Afficher l'original » puis « Traduire » revient aussitôt (mémoire de la session, jamais sur disque ni en navigation privée).

### Corrections

- **Barre latérale et extensions** : le bord de la barre latérale se saisit de nouveau (glisser pour la redimensionner) ; « Nouveau profil… » place le curseur dans le champ du nom ; une extension qui ouvre son volet latéral au clic sur son icône l'ouvre aussi depuis le menu des extensions quand son icône est masquée.
- **Code QR** : le panneau dessine de nouveau un code lisible (ses modules étaient brouillés par le trait des icônes).
- **Petites corrections** : le nom automatique d'une session suit la langue de l'interface ; la recherche des Réglages pour « exporter » ou « sauvegarde » mène aux boutons d'export ; les textes qui nommaient Chromium disent « le moteur ».
- **Apparence** : l'apparence de Lucium et celle demandée aux sites sont deux réglages ; demander Sombre aux sites ne rend plus Lucium sombre quand le Mac est clair. Si vous aviez forcé Clair ou Sombre pour toute l'application, choisissez-le de nouveau dans « Apparence de Lucium ».
- **Traduire cette page** : le panneau ne s'ouvre plus sur la même langue des deux côtés ; il propose une autre langue et dit pourquoi. La phrase sur l'usage compté par Apple n'accompagne plus chaque traduction : elle reste dans le panneau et paraît une fois au premier usage de macOS.
- **Pastille de non-lus** : elle ne clignote plus avec un titre qui change sans cesse ; les marques « ! » et « * » de Slack la montrent aussi.
- **Image dans l'image et veille** : un onglet dont la vidéo flotte, même depuis un lecteur intégré, n'est plus mis en veille.
- **Interface qui plante** : la barre latérale, le calque ou les Réglages se rechargent au lieu de rester blancs (trois fois par minute au plus).
- **Barre d'annotation dans une fenêtre basse** : le haut de la colonne n'est plus perdu hors d'atteinte.
- **Blocage des traqueurs** : « Bloquer les publicités et les traqueurs » pouvait s'afficher activé sans que rien ne soit filtré ; les requêtes, le masquage, la protection des pages et les compteurs suivent maintenant l'interrupteur.

### Sécurité

- **Extensions séparées** : une page d'une extension ne reçoit plus les événements d'une autre extension (adresses et titres des onglets, cookies, clics sur ses menus) en la nommant.
- **Débogueur des extensions** : un domaine du protocole de débogage que Lucium ne connaît pas est refusé.

## [0.2.14] - 2026-11-09

### Changements

- **Bouton Mode lisible** : chaque clic passe au mode suivant, Original, Sombre, Clair, puis de nouveau Original ; l'original a son icône, une palette ; les trois icônes ont leur couleur (points de peinture, lune bleutée, soleil ambré), le contour restant à l'encre de la barre. Le clic droit liste toujours tous les modes.

## [0.2.13] - 2026-11-08

### Ajouts

- **Mode lisible, site par site** : Original, Sombre (une page claire devient sombre) ou Clair (une page sombre devient claire), avec un réglage pour les autres sites, dont Automatique. Dans le centre de contrôle du site, Affichage › Apparence, la barre de commandes et Réglages › Apparence. Remplace le mode sombre forcé, dont les réglages sont repris.
- **Recolorer plutôt qu'inverser** : en Sombre ou en Clair, chaque couleur garde sa teinte, le texte atteint un contraste d'au moins 4,5 : 1 (3 : 1 pour un grand texte), images et vidéos gardent leurs couleurs. Une page que la recoloration ne sait pas traiter est inversée comme avant.
- **Bouton Mode lisible** : dans la barre d'outils, avant le centre de contrôle du site, il montre le mode de la page (Original, Sombre, Clair) ; un clic la rend sombre ou claire puis la remet à l'original, un clic droit liste tous les modes. Réglages › Apparence › Affichage permet de le masquer.

## [0.2.12] - 2026-11-08

### Ajouts

- **Ambiances des vidéos de Lucium** : chaque vidéo arrive avec un voile côté texte, un texte blanc et son ombre, l'intensité réglée selon la clarté de l'image. Le panneau Fond met le voile (« Aucun » pour l'enlever) avant le texte, et « Forme du voile » est toujours proposée.
- **Deux canaux de mises à jour** : stable par défaut ; Réglages › Général › « Recevoir les versions de test » suit le canal de test. Passer à un canal plus ancien n'installe rien.
- **Guide après un import** : après l'import depuis votre ancien navigateur à barre latérale, une feuille dit une fois où retrouver ce que vous connaissiez, avec un bouton vers chaque endroit ; le menu Aide la rouvre.
- **Signaler un problème…** (Aide) : un rapport en texte brut (version, macOS, extensions, fonctions activées, journal) à relire, copier ou enregistrer ; rien n'est envoyé.
- **Page qui ne répond plus** : Lucium le dit, avec « Recharger » et « Attendre » ; le message part dès que la page répond.
- **Coup d'œil et mini-fenêtre dans l'historique** : leurs pages y entrent comme celles d'un onglet, jamais pour un onglet privé ou un conteneur.
- **Barre de commandes** : Début et Fin vont au premier et au dernier résultat depuis le bord du texte.

### Corrections

- **Économie de batterie** : elle met la vidéo de fond en pause, même avec « Toujours lire », et le bouton le dit.
- **Mode sombre forcé** : un PDF n'est plus inversé, quelle que soit son adresse.
- **Coup d'œil et mini-fenêtre** : « un autre site » veut dire le même domaine pour les deux.
- **Barre de commandes** : plus de rangée de recherche de site que Tab ne sait pas ouvrir.
- **Gomme** : seuls les sélecteurs qu'elle écrit elle-même sont gardés.
- **Accessibilité** : les éléments d'un dossier en direct s'atteignent au clavier, comme les onglets.
- **Coup d'œil › Vue scindée** : avec quatre volets déjà ouverts, une notice le dit. La notice du balayage dit « gelé » pour un onglet gelé.
- **Guillemets** : les textes construits par le code suivent la langue : « » en français, “ ” en anglais.
- **Textes** : listes de blocage personnelles (un fichier ou des règles collées, jamais une adresse), ce que garde l'export en clair, et ce que contient la trace du navigateur.

### Sécurité

- **Touch ID du coffre** : la clé passe par un service XPC de Lucium qui vérifie la signature de l'appelant à chaque message ; un programme local qui se fait passer pour Lucium ne peut plus la recevoir.
- **Phrase maître** : les phrases fausses sont comptées sur le disque et par tous les contrôles ; relancer ne rend plus trois essais. L'attente va de 1 à 30 s et n'enferme jamais le propriétaire.
- **Messages internes** : l'acheminement refuse lui-même tout expéditeur qui n'est pas une surface de Lucium, avant tout traitement.
- **Effacer l'historique ou un site** : les pages précédentes gardées avec les onglets archivés partent aussi, copies automatiques comprises.
- **Autorisations par pièce** : les moteurs de rendu et le GPU vérifient de nouveau les bibliothèques qu'ils chargent ; seuls le processus principal et les auxiliaires dont la lecture protégée a besoin gardent l'exception.
- **Onglets privés** : ni Retouches ni scripts utilisateur, comme une fenêtre privée (sauf les scripts que vous y avez autorisés).
- **Mode lecture** : le HTML de l'article est assaini avant d'être affiché ; le journal « État de Lucium » ne garde que les noms de fichiers et les sites.

## [0.2.11] - 2026-11-07

### Ajouts

- **Forme du voile** : dans le panneau Fond, « Côté texte » assombrit le fond sous les onglets et l'efface vers le bord droit, où la vidéo ou l'image reste presque nue. « Uniforme » garde le voile d'avant.

### Corrections

- **Ombre du texte** : plus large autour des mots, elle s'étend aux dossiers, à « Aujourd'hui » et à « Nouvel onglet ». Avec une couleur de texte choisie, les onglets endormis pâlissent moins (85 %) : la liste se lit sur une vidéo claire.

## [0.2.10] - 2026-11-06

### Corrections

- **Vidéos de Lucium** : les vignettes du panneau Fond s'affichent ; elles apparaissaient cassées.
- **Fond d'espace en image** : une image ou un GIF en fond d'espace s'affiche de nouveau, dans la barre latérale comme dans l'aperçu du panneau Fond.

## [0.2.9] - 2026-11-06

### Ajouts

- **Vidéos de Lucium** : neuf vidéos de fond livrées avec Lucium, à choisir d'un clic dans le panneau Fond d'un espace : aurores boréales, temple dans la brume, serre aux lucioles, village enneigé, forêt, montagnes, ville néon, méduses et hublot spatial. Faites pour Lucium, elles pèsent 12 Mo en tout.
- **Vidéo de fond** : deux petits boutons au-dessus du pied de la barre latérale, quand l'espace a une vidéo en fond : Pause / Lire, et « Toujours lire » (∞), qui lance la vidéo et la laisse tourner même quand Lucium n'est pas au premier plan. Une fenêtre réduite l'arrête toujours.
- **Icône d'onglet en image** : « Choisir une image… » dans Modifier l'onglet. L'image remplace l'emoji et l'icône du site ; une copie réduite est gardée dans le profil, comme l'image d'un espace. « Reprendre l'icône du site » la retire.
- **Barre de commandes** : un bouton « Notifications », à côté de Copier et Coller, ouvre les notifications récentes.

### Corrections

- **Vidéo de fond** : elle ne s'arrête plus à chaque clic dans une page. Seule une autre fenêtre ou application au premier plan l'arrête, sauf avec « Toujours lire ».
- **Modifier l'onglet** : le bouton « Enregistrer » n'est plus coupé à droite de la bulle.
- **Vidéo de fond** : les boutons Pause et ∞ ont un fond sombre, lisibles sur une vidéo claire.

## [0.2.8] - 2026-11-06

### Ajouts

- **Dossier endormi** : un dossier marqué « Ne jamais réveiller automatiquement » porte une petite lune au bout de sa ligne, pour le reconnaître d'un coup d'œil.

### Corrections

- **Chargement au lancement** : avec « Charger tous les onglets au lancement », les pages s'ouvrent par petits lots, quelques secondes d'écart, au lieu de toutes en même temps. Des dizaines de pages créées d'un coup s'affichaient en rectangles noirs jusqu'à un rechargement.
- **Actualiser tous les onglets** : les pages ouvertes dans les autres fenêtres sont rechargées aussi. Jusqu'ici seule la fenêtre où l'on cliquait l'était, et la notice annonçait par exemple « 4 onglets actualisés » alors que des dizaines de pages restaient telles quelles.

## [0.2.7] - 2026-11-06

### Ajouts

- **Notifications récentes** : Affichage › Notifications récentes (ou « Notifications récentes » dans la barre de commandes) liste les 30 dernières notices de la fenêtre, avec leur heure, pour relire celle qui a disparu trop vite. Rien n'est enregistré : elles s'effacent à la fermeture.
- **Dossiers « à ne pas réveiller »** : la case « Ne jamais réveiller automatiquement » du menu d'un dossier garde ses onglets endormis : ni « Actualiser tous les onglets » ni le lancement ne les réveillent.

### Changements

- **Sites qui ne répondent plus** : chaque ligne a son bouton « Fermer » (« Retirer » pour un onglet épinglé) pour supprimer un seul site sans cocher ; l'onglet part à l'archive comme les autres, et la notice « Annuler » le ramène.
- **Fin d'une actualisation** : la notice qui dit combien d'onglets ont été actualisés, lesquels sont restés tels quels et pourquoi, reste 15 secondes au lieu de 5.

### Corrections

- **Extensions** : uBlock Origin Lite démarre de nouveau. Une extension qui lit `browser.commands` (ou tout autre `browser.…`) trouvait un objet vide, plantait au démarrage, et son worker ne se lançait jamais.

## [0.2.6] - 2026-11-06

### Corrections

- **Visioconférence** : la vidéo d'un appel repasse en image dans l'image quand vous changez d'onglet. Lucium mesurait la vidéo après l'avoir masquée, et la trouvait trop petite.

## [0.2.5] - 2026-11-06

### Changements

- **Icône de gel** : le flocon d'un onglet gelé est plus grand et plus net ; il garde son sens et son emplacement.
- **Nouveautés** : la feuille est plus large et sa liste garde plus de lignes à l'écran, pour lire le texte sans défiler.

## [0.2.4] - 2026-11-05

### Changements

- **Anneau de chargement des onglets** : un trait net, un rail pâle et un arc qui tourne, au lieu de pointillés flous ; un onglet que « Actualiser tous les onglets » rechargera montre le même rail, sans arc.

## [0.2.3] - 2026-11-05

Cette version corrige ce qu'un audit complet de Lucium a relevé avant la bêta : les fenêtres, la veille, les pages privées, les certificats, les fichiers locaux et les profils.

### Corrections

- **Fermer la dernière fenêtre (macOS)** : Lucium reste ouvert comme toute app Mac, et un clic sur le Dock, ⌘N, un lien venu d'une autre app ou « Rechercher les mises à jour… » rouvre la fenêtre avec vos espaces et vos onglets, au lieu d'une erreur à chaque clic.
- **Visioconférence** : la vidéo d'un appel passe de nouveau d'elle-même en image dans l'image quand vous changez d'onglet, même si la page en coupe le son.
- **Mise en veille sans perte** : un onglet dont le site demande une confirmation avant de partir reste éveillé au lieu de perdre ce qu'il garde, et le texte tapé dans un éditeur en cadre ou les cases cochées d'un formulaire non envoyé le gardent éveillé aussi.
- **Actualiser tous les onglets** : les onglets d'un espace verrouillé restent en veille, et une page gelée où vous avez tapé un texte non envoyé n'est plus rechargée.
- **Interface qui ne s'affiche pas** : un écran propose « Recharger l'interface » au lieu d'une fenêtre vide ; vos onglets et vos pages restent intacts.
- **Erreurs internes** : une erreur imprévue n'ouvre plus de boîte d'alerte à répétition ; elle est notée dans Réglages › Général › État de Lucium, et une notice le dit une fois.
- **Adresse mal formée** : une adresse illisible tapée dans la barre dit « Cette adresse n'est pas valide » au lieu de ne rien faire.
- **Archivage et plusieurs fenêtres** : l'archivage automatique et « Vider Aujourd'hui » n'archivent plus l'onglet affiché dans une autre fenêtre ; avec des fenêtres aux onglets indépendants, les onglets des autres fenêtres sont archivés eux aussi passé le délai.
- **Profil d'un espace** : le changer recharge ses onglets avec les données du nouveau profil dans toutes les fenêtres, pas seulement dans celle où vous l'avez changé.
- **Mini-fenêtre** : ouverte depuis un onglet, elle prend le profil de l'espace de cet onglet (ses connexions), et s'archive dans cet espace.
- **Suppression d'un profil** : « Supprimer le profil et ses données » retire aussi les extensions installées dans ce profil et leurs données, et un profil recréé sous le même nom part de zéro.
- **Import d'un fichier de signets** : un fichier HTML de signets mal formé ou piégé ne fige plus Lucium ; un mégaoctet prenait environ trois secondes, il prend maintenant quelques millisecondes.
- **Nouveautés après une mise à jour** : l'en-tête de la feuille dit que la mise à jour est installée, au lieu d'affirmer que rien n'a été téléchargé.

### Sécurité

- **Certificats non valides** : `localhost`, un nom en `.local` ou une adresse privée ne sont plus acceptés en silence. Seuls les sites mis en mode développeur (⌃D) passent sans question, et une page ouverte malgré un certificat non valide dit « Non sécurisé » au lieu du cadenas.
- **HTTPS d'abord** : un certificat non valide ne fait plus ouvrir la page en HTTP d'office ; la page du certificat s'affiche et propose « Ouvrir en HTTP (non sécurisé) », à votre clic seulement.
- **Fichiers locaux** : un fichier HTML ouvert depuis votre Mac ne peut plus lire d'autres fichiers du disque ; il affiche toujours les images, styles et scripts de son propre dossier, et les PDF locaux s'ouvrent comme avant.
- **Résumé de page** : une fenêtre privée ou invité n'envoie plus jamais sa page à un fournisseur cloud ni à un Ollama sur un autre ordinateur, comme un onglet privé ; l'entrée du menu n'y est plus proposée. Ollama sur ce Mac la résume toujours.
- **Authentification HTTP** : un cadre d'un autre site inséré dans une page ne peut plus ouvrir le panneau de connexion dans l'onglet ; seuls la page elle-même et son propre site le peuvent.
- **Icônes des onglets privés** : un onglet privé n'est plus jamais cherché par le résolveur d'icônes, dont la réponse passait ensuite par le cache disque de l'interface.
- **Surveiller cette page** : refusé pour un onglet privé, dont l'adresse aurait été enregistrée et relue avec les cookies du profil.
- **Traduction coupée** : plus aucune page ne lit sa langue, et le menu de la page ne propose plus « Traduire cette page… ». Activée, la langue est lue dans un monde isolé, que la page ne voit pas.
- **`chrome.debugger`** : une extension ne peut plus lire ni réécrire les scripts d'une autre extension sur la page, ni le tas de la page, ni le stockage d'un site encadré (domaines `Debugger`, `DOMDebugger`, `HeapProfiler`, `Memory`, `DOMStorage`, `IndexedDB`, `CacheStorage`, `Database` refusés).
- **Icônes de la barre latérale** : elles ne portent plus de cookie et n'en reçoivent plus, la session de l'interface n'étant effacée par rien ; elles portent `Sec-GPC` quand Global Privacy Control est activé.
- **Ollama sur un autre ordinateur** : le test de connexion et la lecture des modèles attendent aussi que vous ayez confirmé son adresse.
- **Fichier des versions** : Lucium n'en lit pas plus de 64 Ko ; un flux plus gros est refusé sans être lu jusqu'au bout.
- **Effacer les données d'un site** : le panneau dit que l'effacement des cookies oublie aussi les identifiants d'authentification HTTP de tout le profil, et le README dit quel User-Agent portent les requêtes propres de Lucium.

## [0.2.2] - 2026-11-05

Lucium vous prévient de lui-même qu'une nouvelle version existe ; il ne la télécharge que si vous le lui demandez.

### Ajouts

- **Notice de mise à jour** : au lancement, puis une fois par jour, Lucium regarde sans cookie si une version plus récente existe ; une notice au pied de la barre latérale propose « Installer » ou « Plus tard ». Rien n'est téléchargé avant votre clic, et Réglages › Général › « Chercher les mises à jour automatiquement » coupe la vérification.
- **Bouton Nouvelle note** : dans la barre d'outils, à côté d'« Annoter la page », pour écrire une note d'un clic.
- **Notes en Markdown** : le texte se met en forme pendant la frappe (titres, listes, cases à cocher, citations, gras, italique, code, liens) et reste enregistré en Markdown.
- **Vue scindée en grille** : quatre volets en 2 × 2, ou trois dont un sur tout un côté ; glisser un onglet sur une vue scindée montre la case exacte où il se posera, un bord ou un coin, et le menu de la vue passe de Côte à côte à En colonne ou à Grille.

### Changements

- **Actualiser tous les onglets** : les boutons de la barre latérale actualisent tout, onglets en veille compris. Le bouton tourne pendant la passe, chaque rangée montre son tour, et la notice dit « 12 sur 135 » avec une barre et le temps restant. Huit onglets en veille se chargent à la fois, moins quand la mémoire manque.

### Corrections

- **Fenêtre À propos** : la note sous « Vérifier les mises à jour » dit que le bouton cherche tout de suite, que la recherche automatique soit cochée ou non.
- **Les sites qui ne répondent plus** : les onglets épinglés sont proposés aussi, dans un groupe à part, et partent dans l'archive, d'où ils reviennent épinglés. La liste vient pendant une longue actualisation, se complète quand elle est ouverte, et Échap ne cache plus ses onglets pendant 30 jours.

## [0.2.1] - 2026-11-05

Lucium se met maintenant à jour lui-même, sur votre demande, et cette version corrige ce que l'usage a montré.

### Ajouts

- **Mise à jour depuis l'application** : Lucium › Rechercher les mises à jour… télécharge la nouvelle version, l'installe et relance Lucium, seulement quand vous le demandez.
- **Dégeler un onglet** : un bouton sur la rangée d'un onglet gelé, et une entrée dans son menu ; la page repart sans être rechargée.
- **Les sites qui ne répondent plus** : après « Actualiser tous les onglets », une fenêtre liste les onglets dont le site est introuvable, pour fermer ceux que vous cochez.
- **Nouvelle note (⌥⌘E)** : une note liée à la page en une touche, aussi depuis la barre de commandes.

### Corrections

- **Actualiser tous les onglets** montre sa progression dès le clic, peut s'arrêter, et ne reste plus bloqué.
- **Vue scindée** : déposer un onglet sur une vue de deux ou trois volets en ajoute un, jusqu'à quatre.
- **Image dans l'image automatique** : seulement pour une vidéo que vous regardez, avec le son.
- **Extensions** : elles reçoivent de nouveau les événements des onglets.
- **Textes** : l'interface anglaise n'affiche plus de mots français, le résumé de page suit la langue de l'interface, et les Réglages disent ce que chaque option fait vraiment.

## [0.2.0] - 2026-11-04

La première version publique de Lucium : une alpha pour macOS sur puce Apple.

### Ajouts

- **Un navigateur à barre latérale** : une barre latérale verticale avec des espaces (chacun avec son profil, sa session et son thème), des favoris, des onglets épinglés, des dossiers imbriqués, des onglets « Aujourd'hui » archivés tout seuls, le glisser-déposer et la sélection multiple.
- **Barre de commandes (⌘T, ⌘L)** : adresses, recherche, onglets ouverts et archivés, actions, raccourcis de recherche par site, complétion dans le champ et calculatrice.
- **Vue scindée, Coup d'œil, mini-fenêtres et Retouches** : deux à quatre volets côte à côte, l'aperçu d'un lien, de petites fenêtres pour les liens ouverts depuis d'autres applications, et des Retouches (CSS, JavaScript, éléments masqués à la Gomme, couleurs) à partager par fichier ou par lien.
- **Extensions (Manifest V3)** : chargées depuis un dossier ou installées depuis le Chrome Web Store, avec le panneau latéral, la messagerie native et les raccourcis d'extension ; chaque API n'existe que pour une extension qui déclare sa permission.
- **Bloqueur de publicités et de traqueurs** : activé d'emblée, avec des exceptions par site, un mode Standard et un mode Strict, et vos propres listes.
- **Mise en veille et gel des onglets** : par onglet ou par site, avec les raisons qui gardent un onglet éveillé (son, image dans l'image, téléchargement, saisie non envoyée…), un plafond d'onglets éveillés en arrière-plan et une jauge des ressources dans la barre latérale.
- **Vie privée sans compte** : ni compte, ni synchronisation, ni télémétrie ; fenêtre privée, onglets privés et conteneurs d'onglets, effacement des données d'un site (⇧⌘X), HTTPS d'abord, DNS chiffré, proxy, et la liste de chaque connexion que Lucium établit de lui-même dans le README.
- **Gestionnaire de mots de passe et verrou (désactivés d'usine)** : un coffre chiffré sur ce Mac, rempli à la demande, avec Touch ID, et un verrou de l'interface ou d'un espace.
- **Import** : depuis votre ancien navigateur, ses espaces, onglets, dossiers, thèmes, favoris et Retouches, ou ses signets et son historique (navigateurs basés sur Chromium ou sur Gecko, navigateur fourni avec macOS), ou un fichier de signets.
- **Lecture et pages** : mode lecture, lecteur PDF, zoom par site, export Markdown, à lire plus tard, notes rapides, et traduction des pages sur ce Mac (modèles Bergamot ou traduction de macOS 26).
- **Thèmes d'espace** : un éditeur de thèmes, vingt thèmes prêts à l'emploi, et des thèmes partagés par un code.
- **Résumé de page (désactivé d'usine)** : par un Ollama local, ou chez un fournisseur que vous autorisez nommément (OpenAI, Mistral, OpenRouter, Anthropic), avec votre propre clé.
- **Régler en quelques questions** : chaque catégorie des Réglages se règle par quelques questions écrites à l'avance, avec un récapitulatif avant tout changement et un bouton Annuler ; la configuration rapide les enchaîne toutes.
- **Un réglage pour chaque fonction** : les fonctions facultatives se coupent une à une, et la fenêtre Réglages cherche dans tous les réglages.

### Limites connues

Seul macOS sur puce Apple est testé (les paquets Windows, Linux et Intel sont configurés mais n'ont pas été construits). La variante DRM, celle que proposent les versions publiées, est signée Developer ID et notarisée par Apple ; la build standard (`pnpm package`) ne l'est pas. Pas de mise à jour automatique : seulement une vérification de version auprès d'un flux que vous configurez. Les API des extensions sont partielles : Electron n'en fournit qu'une partie. Les vidéos protégées se lisent par Widevine (la version d'Electron de castLabs) ; Netflix a été vérifié, pas les autres services. Impossible dans Electron : Cast, un vrai flou derrière la barre de commandes, l'indicateur de caméra et de micro, le retour haptique.
