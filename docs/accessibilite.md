# Accessibilité de l'interface de Lucium

L'interface doit être utilisable au clavier et au lecteur d'écran : étiquettes, commandes accessibles au clavier, pas de conflit de raccourcis. Ce document dit comment c'est contrôlé, ce qui est en place et ce qui reste à corriger.

## Résumé

- **Le contrôle automatique est statique** : il lit l'arbre d'accessibilité de Chromium sur une instance de test, sans VoiceOver (son activation demande une autorisation de macOS). Ce que seul VoiceOver peut dire (ordre de lecture réel, annonces effectives, prononciation) est dans la section « Non vérifiable sans VoiceOver », avec un protocole d'essai à la main.
- **30 surfaces contrôlées** : la barre latérale et la barre d'outils, 22 panneaux du calque, les 6 volets que la fenêtre des Réglages avait alors (elle a 11 pages depuis, avec une barre latérale : voir « Fenêtre des Réglages au clavier », dont le relevé moteur n'a pas été refait), le gestionnaire de tâches. Au dernier relevé, un seul contrôle sans nom (la demande d'autorisation, corrigée depuis), aucun interrupteur ou onglet sans état.
- **Onglets de la barre latérale** : ce sont des boutons, joignables à la touche Tab et par VoiceOver, avec les flèches pour passer de l'un à l'autre (voir « Corrections », n° 1).
- **Ce qui reste** : les gris par défaut (mesurés) sont sous 4,5 : 1 de contraste, de 3,0 à 3,7 : 1 pour le texte secondaire de la barre latérale. Les valeurs par défaut ne changent pas ; une variante « Augmenter le contraste » suit le réglage du système et passe 4,5 : 1 sur tous les thèmes.
- **Vérifications** : les tests unitaires (`pnpm test`) et le lanceur moteur `LUCIUM_SMOKE_ONLY=a11y` (204 vérifications au dernier relevé, qui donne les chiffres ci-dessous). **Quelques corrections sont postérieures à ce relevé** (liste en fin de document).

## Méthode

| Moyen | Ce qu'il lit | Fichier |
|---|---|---|
| Arbre d'accessibilité de Chromium (`webContents.debugger`, `Accessibility.getFullAXTree`, détaché aussitôt) | rôle, nom, état, propriété « focusable » de chaque nœud de la surface | `src/main/smoke-a11y.ts`, règles dans `src/shared/a11y-audit.ts` |
| Touche Tab pressée pour de vrai (`sendInputEvent`) | ordre de tabulation, sortie du focus, contrôle qui ne paraît pas pris par le focus (comparaison des styles calculés de l'élément et de ses deux parents) | idem |
| Capture de la fenêtre avec le texte rendu transparent | contraste de chaque texte visible sur le fond réel (dégradés et translucidité compris), seuils WCAG 2.2 AA : 4,5 : 1, ou 3 : 1 pour un grand texte | idem |
| Couleurs des thèmes, calculées | contraste du texte de la barre latérale pour 72 teintes et les thèmes prêts, en clair et en sombre | `src/main/shell/contrast.test.ts` |
| Lecture du code source des composants | bouton sans nom, image sans `alt`, champ sans étiquette, rôle manquant d'une ligne d'onglet | `src/main/shell/a11y-source.test.ts` |

Limites de la méthode : la touche Tab est lue dans le document de chaque surface ; elle ne dit rien de la navigation entre fenêtres. Le contraste est mesuré sur du texte visible : une image de texte ou une icône n'est pas jugée. « Ne paraît pas pris par le focus » est une heuristique (un champ dont seul le curseur de saisie marque le focus y figure).

## Surfaces contrôlées (dernier relevé moteur)

Nœuds = nœuds non ignorés de l'arbre ; arrêts = nombre de pressions de Tab avant retour au premier élément (90 = limite du parcours).

| Surface | Nœuds | Arrêts de Tab | Textes sous le seuil de contraste / mesurés |
|---|---:|---:|---|
| Barre latérale et barre d'outils | 74 | 13 | 2 / 20 |
| Barre de commandes | 134 | 90 (Tab complète la saisie) | 11 / 19 |
| Recherche dans la page / Chercher et remplacer | 7 / 20 | 2 / 4 | 0 / 0 et 0 / 1 |
| Importer | 50 | 2 | 0 / 9 |
| Téléchargements | 11 | 0 (liste vide) | 1 / 2 |
| Archive | 42 | 7 | 0 / 6 |
| Historique | 79 | 12 | 0 / 27 |
| Gérer les espaces | 42 | 4 | 0 / 11 |
| Centre de contrôle du site | 44 | 10 | 4 / 11 |
| Éditeur d'espace / Renommer le favori / Nouvel espace | 114 / 19 / 127 | 29 / 2 / 46 | 0 |
| Menu « + » | 25 | 5 | 1 / 7 |
| Effacer les données du site | 123 | 90 | 4 / 23 |
| Sessions / Lire plus tard / Éditeur d'onglet / Rechargement automatique | 37 / 20 / 120 / 33 | 5 / 1 / 34 / 4 | 0 |
| Éditeur de thème | 67 | 30 | non mesuré (fond translucide) |
| Éditeur de Retouche | 122 | 40 | 0 / 36 |
| Demande d'autorisation / Connexion | 21 / 30 | 3 / 4 | 0 |
| Réglages, volets d'alors : Général, Profils, Liens, Raccourcis, Icône, Avancé | 230, 126, 79, 771, 55, 444 | 23, 18, 12, 90, 13, 33 | 12, 4, 6, 10, 2, 4 |
| Gestionnaire de tâches | 297 | 5 | 4 / 100 |

Le détail brut (chaque nœud signalé, chaque arrêt, chaque texte) est écrit par `LUCIUM_A11Y_DUMP=<fichier> LUCIUM_SMOKE_ONLY=a11y`.

## Corrections

Chaque correction a son contrôle ; ceux du moteur sont marqués « moteur » (voir la fin pour ce qui n'a pas été rejoué).

| # | Constat | Correction | Contrôle |
|---|---|---|---|
| 1 | **Onglets de la barre latérale inaccessibles au clavier et à VoiceOver** (`<div onClick>` sans rôle, sans `tabindex`) | `role="button"`, nom = titre de l'onglet, `aria-current` sur l'onglet affiché ; un seul arrêt de Tab (l'onglet affiché ; la première ligne si celui-ci n'est pas à l'écran, les flèches menant aux autres : avec 300 onglets, faire de chaque ligne un arrêt coûtait 300 appuis pour passer la liste) ; flèches haut/bas entre les onglets ; Entrée ou Espace ouvre l'onglet ; Suppr l'archive (le focus passe au voisin). Aucun changement visuel sauf un anneau de focus au clavier. | source ; moteur (`a11y sidebar:`) |
| 2 | **Notice (toast) annoncée peu fiablement** : la zone `role="status"` naissait avec son texte, or un lecteur d'écran annonce un changement dans une zone vivante déjà présente | zone permanente `role="status" aria-live="polite" aria-atomic="true"` (`display: contents`, aucun effet de mise en page) | source ; moteur |
| 3 | **Boîtes de dialogue des Réglages sans piège de focus** : Tab sortait de la boîte modale vers la page derrière, et le focus n'était pas rendu à la fermeture | Tab et Maj+Tab restent dans la boîte ; le focus revient au bouton qui l'a ouverte | moteur (`a11y dialog:`) |
| 4 | **Panneaux sans champ** (archive, historique, espaces, effacer les données…) : le focus restait sur rien, Échap ne fermait pas tant qu'on n'avait pas appuyé sur Tab | le panneau (dialogue ou menu) prend le focus à l'ouverture si rien ne l'a | moteur (Échap, 20 panneaux) |
| 5 | **« Renommer le favori »** : Échap ne fermait pas | Échap ferme sans enregistrer la saisie | moteur |
| 6 | **Onglets de Réglages** : l'anneau de focus était supprimé (`outline: none`) | anneau bleu intérieur au clavier uniquement | moteur (focus visible) |
| 7 | **Demande d'autorisation** : `role="alertdialog"` sans nom | `aria-label` et `aria-describedby` | moteur |
| 8 | **Poignées 2D de l'éditeur de Retouche** : `div` focalisables sans rôle | `role="slider"`, `aria-valuetext` (« Teinte 0°, saturation 100 % »), flèches déjà gérées | moteur |
| 9 | **Champs de renommage sur place** (onglet, dossier) sans nom | `aria-label` | source |
| 10 | **Favoris et espaces** nommés par la lettre ou l'émoji qu'ils montrent (« 1 », « 🏠 ») | `aria-label` = titre du favori, nom de l'espace ; `aria-current` sur l'espace affiché | source |
| 11 | **Dossiers** sans état ouvert/fermé | `aria-expanded` | source |
| 12 | **Texte secondaire sous 4,5 : 1** (voir « À corriger ») | variante `@media (prefers-contrast: more)` : gris plus denses dans la barre latérale et les Réglages, à partir de 5,2 : 1 sur tous les thèmes ; sans ce réglage du système, rien ne change | `contrast.test.ts` ; moteur (émulation du média) |
| 13 | **Barre de commandes** sans sémantique de liste : un lecteur d'écran n'annonçait pas le résultat choisi avec les flèches | `role="combobox"` (`aria-expanded`, `aria-controls`, `aria-activedescendant`), liste `role="listbox"`, résultats `role="option"` `aria-selected` | source ; moteur (`a11y command bar:`) |
| 14 | Rangée « Contraste de la page » du centre de contrôle (un clic passe au choix suivant) | un bouton dont le texte dit le choix du site (« Par défaut · Original », « Sombre », « Clair », « Original ») ; l'infobulle dit ce que fait ce choix | moteur |
| 15 | **Réordonner au clavier** : onglets et favoris ne se déplaçaient qu'au glisser-déposer | « Déplacer vers le haut » et « Déplacer vers le bas » dans le menu contextuel de l'onglet et du favori (le même `tab/move` et `favorite/move` que le glisser) ; un onglet ne sort pas de son groupe (épinglés, dossier, arbre) | `src/shared/tab-step.test.ts` |
| 16 | **Boutons imbriqués** dans une ligne `role="button"` (plier, infos du site, son, retour à l'adresse épinglée) | la ligne n'a plus de rôle : son bouton (icône et titre) porte le rôle, les autres boutons sont ses voisins | `src/main/smoke-a11y.ts` (ligne des onglets) |
| 17 | **Renommer au clavier** : un dossier et un onglet ne se renommaient qu'au double-clic ou au menu | F2 sur la ligne du dossier ou de l'onglet | source |
| 18 | **Mouvement réduit** : la barre flottante glissait, le dépôt en volet animait sa case, `--dur` restait à 0,15 s | `prefers-reduced-motion` dans `window.css`, `split-drop.css` et `tokens.css` | source |
| 19 | **Titre d'un onglet en veille sous 4,5 : 1** en apparence claire (texte à 55 % d'opacité : 3,1 à 3,7 : 1) | le titre prend le texte secondaire de l'espace (`--sb-dim`) ; seule l'icône garde l'opacité ; idem dans une vue scindée. Ce texte est mesuré sur les couleurs réelles de l'espace, quelle que soit la couleur choisie (les dix couleurs nommées, le sélecteur, un code) : son opacité monte juste assez pour 4,5 : 1 sur le fond nu, et sur une tuile pour le nom d'un favori (`spaceInks`, `src/shared/theme.ts`). Limite connue : sous le pointeur, la ligne s'éclaircit et le titre peut passer sous 4,5 : 1 sur quelques couleurs | `src/renderer/sleep-contrast.test.ts`, `src/shared/theme.test.ts`, `src/renderer/seen-surfaces-contrast.test.ts` |
| 20 | **Champs du résumé de page sans nom** (adresse d'Ollama, longueur, température) | `aria-label` du libellé de leur rangée | `src/renderer/ai-settings-data.test.ts` |
| 21 | **Noms accessibles en français dans l'interface anglaise**, pluriels faits à la main, pastilles de couleur du premier lancement nommées par leur identifiant | clés du catalogue avec `{name}`, `tp()` pour les pluriels, `aria-label` traduit et `type="button"` sur les pastilles | `src/renderer/first-launch.test.ts`, `src/main/panel-text-source.test.ts` |
| 22 | **Capsule d'info-bulle et carte de survol au pointeur seulement** | elles viennent aussi au focus donné par le clavier (`:focus-visible`), sous le milieu du contrôle ou de la rangée, et partent au `blur` | `src/renderer/tooltip-focus.test.ts` |
| 23 | **Transitions hors du mouvement réduit** (pastilles du premier lancement, « + » de la barre latérale, étiquettes des favoris et du pied de la barre) | leur durée est `var(--dur)`, nulle quand le système réduit les animations | source |
| 24 | **Bouton « Contraste de la page » de la barre d'outils** : un clic passe au mode suivant, et le menu des modes ne devait pas dépendre de la souris | son nom est le mode (« Contraste de la page : Sombre »), sa description (`aria-description`) dit ce que fait un clic et comment avoir tous les modes ; le menu natif s'ouvre au clic droit, à la touche Menu et à Maj+F10 ; l'infobulle suit le focus clavier (ligne 22) | `src/renderer/toolbar-readable.test.ts` |
| 25 | **Tuiles des extensions d'Infos et réglages du site** : désactiver ou retirer une extension demandait la page des extensions ; une extension désactivée ne se distinguait pas | chaque tuile a un menu (`role="menu"`, nommé « Actions de « nom » ») ouvert par le clic droit, par son bouton ⋯ (nommé de même, `aria-haspopup`, `aria-expanded`, visible quand il a le focus) ou par la touche Menu et Maj+F10 ; premier choix focalisé, flèches, Origine et Fin pour se déplacer, Échap ferme le menu sans fermer le panneau et rend le focus à la tuile ; la question « Retirer… » donne le focus à « Annuler » ; une tuile désactivée est nommée « nom, désactivée » et son clic ouvre le menu | `src/renderer/site-panel-extensions.test.ts` ; `tests/e2e/site-panel.spec.ts` |
| 26 | **Onglets de l'éditeur de Retouches et barre d'annotation** : annoncés comme onglets et barre d'outils, sans flèches | ← et → vont d'un onglet à l'autre (Style et Code ; CSS, JS et Gomme) et l'affichent, l'onglet affiché est le seul arrêt de Tab ; dans la barre d'annotation, ← et → vont de bouton en bouton. Les commandes de la vidéo flottante sont un groupe nommé, pas une barre d'outils : ← et → y déplacent la lecture | `src/renderer/radio-keys.test.ts`, `floating-video-bar.test.ts` |
| 27 | **Champ du code d'une Retouche** : Tab y ajoute deux espaces, rien ne disait comment en sortir | une ligne sous le champ, reliée par `aria-describedby` : ⇧Tab sort du champ, Échap revient à Style | `src/renderer/boost-editor-panel.test.ts` |
| 28 | **Capture d'une zone au pointeur seulement** ; touches 2 et 3 écrites nulle part | la première flèche montre une zone au milieu de la fenêtre, les flèches la déplacent, ⇧ et les flèches la redimensionnent, Entrée la capture ; la surface est un dialogue nommé « Zone à capturer », décrit par l'aide ; les boutons nomment leur touche (`aria-keyshortcuts`) | `src/shared/capture-zone.test.ts`, `src/renderer/region-capture-keys.test.ts` |
| 29 | **Annotation d'une capture au pointeur seulement** (texte et flou compris) | l'image est un arrêt de Tab (`role="application"`, nommée, décrite par une ligne visible) ; les flèches y déplacent un point, Entrée commence puis termine la forme ou ouvre le champ du texte, Échap annule la forme en cours | `src/shared/annotate.test.ts`, `src/renderer/annotate-keys.test.ts` |
| 30 | **Carte de survol** : `role="tooltip"` contenant quatre boutons ; légende nommée sans rôle | un groupe nommé par le titre de l'onglet ; la légende est un groupe nommé | `src/renderer/sidebar-badges.test.ts` |
| 31 | **Liste du gestionnaire de tâches** : chaque ligne était un arrêt de Tab | la grille est un seul arrêt (la ligne choisie, ou la première) ; les flèches, Début et Fin vont de ligne en ligne | `src/renderer/taskmanager-keys.test.ts` |
| 32 | **Notices avec une action (« Annuler », « Rouvrir »…)** : 5, 6 ou 8 s selon l'endroit, et une pause seulement dans la barre latérale et au focus des Réglages (WCAG 2.2.1 : le temps d'agir) | une seule durée, 8 s (`ACTION_NOTICE_MS`, `src/shared/toast.ts`), et une seule règle : le temps s'arrête tant que le pointeur ou le focus est sur la notice, puis reprend avec ce qu'il lui restait. Elle vaut pour la barre latérale, les Réglages (« Rétablir », préréglages, « Réinitialiser » d'un raccourci), les suppressions des listes (signets, sessions, historique, notes, Lire plus tard, espaces), la recherche d'onglets, le gestionnaire de tâches et « Annuler » après ⇧⌫ dans la barre de commandes. Une offre qui demande plus (mise à jour, mot de passe à enregistrer) garde sa durée, jamais moins de 8 s. Une notice sans action garde 5 s | `src/shared/toast.test.ts`, `src/shared/undo-queue.test.ts`, `src/renderer/notice-hold.test.ts`, `tab-search-undo.test.ts`, `taskmanager-undo.test.ts`, `space-panels-undo.test.ts` |
| 33 | **Listes sans barre de défilement** (onglets de la barre latérale, espaces, tuiles de la barre docked, résultats de la barre de commandes de la mini-fenêtre, cartes du sélecteur d'onglets, pastilles du sélecteur d'icônes, polices des Retouches, récents des données de site) : elles cachent leur barre, y compris pour qui a demandé au Mac « Toujours afficher les barres de défilement » (Réglages Système › Apparence), sans autre indice qu'une liste qui dépasse | le processus principal lit `AppleShowScrollBars` (`systemPreferences.getUserDefault`), suit la notification `AppleShowScrollBarsSettingChanged` (relayée par `subscribeNotification`) et relit le réglage à chaque activation de l'application ; l'instantané porte `scrollBarsAlways`, `useSnapshot` pose `data-scrollbars="always"` sur le document, et chaque liste qui cache sa barre a sa règle `:root[data-scrollbars='always']` (`scrollbar-width: thin`, couleur des jetons). Seule la valeur « Always » est suivie : pour « Automatic » (barres avec une souris) et « WhenScrolling », le système décide | `src/shared/scroll-bars.test.ts`, `src/main/shell/system-scroll-bars.test.ts`, `scroll-bars-snapshot.test.ts`, `src/renderer/scroll-bars-css.test.ts`, `api-scroll-bars.test.ts` ; le rendu réel : `smoke-a11y.ts` (écrit, pas lancé) |
| 34 | Lecture et taille du texte : rien pour régler l'interligne, les espaces, le fond à fort contraste, le focus de ligne ni la taille minimale du texte d'une page | Le mode lecture offre les fonds Contraste et Gris, une police lisible (pile du système), l'interligne, l'espacement des lettres et des mots en trois pas, un bouton de lecture assistée et un focus de 1, 3 ou 5 lignes ; Réglages › Apparence › Accessibilité › « Taille minimale du texte des pages » (0 ou 10 à 24 px, `minimumFontSize`) pour les onglets ouverts ensuite. | Tests purs (`reader-pill.test.ts`, `min-font-size.test.ts`, `min-font-wiring.test.ts`) ; non rejoués sur le moteur |

## Fenêtre des Réglages au clavier

Ce que font la fenêtre et ses tests unitaires (`src/renderer/settings-sidebar.test.ts`, `settings-window.test.ts`, `settings-more.test.ts`, `settings-subpages.test.ts`, `settings-changed.test.ts`, `settings-search-window.test.ts`, `preset-settings.test.ts`). Le relevé moteur de l'arbre d'accessibilité (`LUCIUM_SMOKE_ONLY=a11y`) n'a pas été rejoué sur cette fenêtre ; la lecture par VoiceOver est à vérifier à la main (« Protocole d'essai », étape 7).

- **Barre latérale** (`nav` nommée « Catégories de réglages ») : un seul arrêt de Tab, la page affichée (`aria-current="page"`). ↑ et ↓ (ou ← et →) passent à la page suivante ou précédente, en revenant au début après la dernière, et l'ouvrent ; Début et Fin vont à la première et à la dernière ; Tab passe à la page. Le point d'une page qui a un réglage modifié est dit au lecteur d'écran (« 2 réglages modifiés »).
- **Recherche** : ⌘F, ou / hors d'un champ, met le focus dans le champ (nommé « Rechercher un réglage (⌘F ou /) »). Le titre des résultats (« 3 réglages pour « … » ») est une zone vivante. Entrée ouvre le meilleur résultat là où il vit (sa page, sa sous-page, « Plus de réglages » ouvert s'il le faut), éclairé, le focus sur son contrôle. Échap vide la recherche et rend la page affichée.
- **« Plus de réglages »** : un bouton dans un titre, qui dit s'il est ouvert (`aria-expanded`) et la zone qu'il ouvre (`aria-controls`) ; Entrée et Espace l'ouvrent et le ferment. Sa ligne dit ce qu'il contient avant d'être ouvert, et son point « modifié » est dit au lecteur d'écran. Il s'ouvre de lui-même quand un lien ou un résultat mène à une rangée qu'il tient. Chaque page garde son état ouvert ou fermé tant que la fenêtre reste ouverte.
- **Sous-pages** : la rangée qui en ouvre une est un bouton qui dit son nom et son état. À l'ouverture, le focus va au nom de la sous-page (un titre que Tab ne joint pas). Le lien de retour s'appelle « Revenir à <page> » ; lui ou Échap ramènent à la page, le focus sur la rangée qui avait ouvert la sous-page. Échap ne fait rien tant qu'on tape dans un champ de la sous-page.
- **« Réglages modifiés »** : au pied de la barre latérale, grisé tant que rien n'a changé ; le nombre est dit au lecteur d'écran. Chaque rangée y garde son contrôle et son « Rétablir ». Échap revient à la page d'où on l'a ouverte, le focus sur cette page dans la barre latérale.
- **« Rétablir »** (une rangée, une page, « Tout rétablir ») : le bouton part ou se grise avec ce qu'il a remis, et la rangée quitte « Réglages modifiés » ; le focus va donc à « Annuler » de la notice, qui attend tant que le focus ou le pointeur y est (règle de la ligne 32 des corrections). « Annuler » rend le focus à la rangée, ou au contenu de la fenêtre quand elle n'est plus affichée (`src/renderer/settings-reset-focus.test.ts`).
- **Préréglages** : une rangée de boutons radio (`role="radiogroup"`, un seul arrêt de Tab : l'option choisie, ou la première quand les réglages ne correspondent à aucune) ; les flèches passent d'une option à l'autre et la choisissent, Début et Fin vont aux extrémités ; la ligne de l'option est liée au groupe (`aria-describedby`). « Quand vous ouvrez Lucium » est un menu. La notice qui suit un choix est une zone `role="status"` ; elle attend tant que le focus est sur son « Annuler » ou que le pointeur est dessus (même règle), et après « Annuler » le focus revient au choix.
- **Texte agrandi** : la fenêtre suit « Taille des fenêtres et des panneaux » (Apparence) ; le nom d'une page qui ne tient plus dans la barre latérale passe à la ligne, jamais coupé, et la liste des pages défile verticalement, jamais de côté. « Plus de réglages » fait au moins 48 px de haut.
- **Mouvement réduit** : ni l'éclairage d'une rangée, ni le glissement d'une sous-page, ni la flèche de « Plus de réglages » ne s'animent.

## « Découvrir Lucium » (panneau du calque)

Le panneau (`src/renderer/Discover.tsx`, `discover.css`) est contrôlé par des tests unitaires qui le montent dans un document (`src/renderer/discover.test.ts`, `discover-styles.test.ts`) ; le contrôle moteur (`LUCIUM_SMOKE_ONLY=discover`, `smoke-discover.ts`) et la 31e surface du lanceur (`LUCIUM_SMOKE_ONLY=a11y`, ligne `discover`) **sont écrits et non joués** (`AGENTS.md` § 1 : ils ouvrent des fenêtres) ; les chiffres de « Surfaces contrôlées » ci-dessus ne les comptent donc pas.

- **Rôles et noms** : une boîte de dialogue modale nommée par son titre (`aria-labelledby`) ; la recherche est un `role="search"` dont le champ est nommé (« Chercher une fonction ») ; les filtres sont deux groupes nommés (« Que voulez-vous faire ? », « Niveau ») de boutons à `aria-pressed` (le nombre de fonctions n'est pas lu : l'état dit le total) ; la zone qui défile est une région nommée « Fonctions », et un seul arrêt de Tab ; chaque carte est un `article` nommé par son titre (il y en a une par fonction de Lucium), chaque bouton de la carte est nommé par son action et sa fonction (`aria-label` « Essayer, Barre de commandes », « Régler, Barre de commandes » : le nom commence par le texte visible, et la liste des boutons d'un lecteur d'écran distingue les 112 « Régler ») et relié à ce titre par `aria-describedby`. Rien n'est un `div` cliquable.
- **Annonces** : une zone `role="status"` (`aria-live="polite"`) dit le nombre de fonctions affichées après chaque frappe ou chaque filtre, et « Aucune fonction ne correspond. ». Le raccourci d'une carte est un groupe nommé une fois (« Raccourci : ⇧ ⌘ 2 »), ses capsules sont cachées au lecteur d'écran.
- **Clavier** : le focus entre dans la recherche ; Tab reste dans le panneau (piège de focus des gabarits, rendu à la fermeture) ; Échap vide la recherche, puis ferme le panneau ; « Fermer » est un bouton nommé. Chaque bouton est un `button` natif : Entrée et Espace.
- **Rien ne passe par la couleur seule** : le niveau (« Pour débuter », « Avancé »), la nouveauté (« Nouveau ») et l'état coupé (« Désactivée pour l’instant », avec la phrase « Activez-la avec « Régler » ») sont des mots, jamais une teinte.
- **Anneau du champ de recherche** : au focus, le contour passe à l'accent et un anneau de la largeur du focus (`outline` en `--focus`, `.dv .tk-field:focus-visible`) s'ajoute : sans eux, `.tk-field:focus` du gabarit n'aurait laissé que son halo léger (1,3 : 1 sur l'en-tête). Le compteur d'une puce active est dessiné sans opacité : `on-accent` sur `accent` garde 4,62 : 1 au pire. La région qui défile a un anneau de focus replié à l'intérieur (rogné sinon).
- **Fenêtre basse, texte agrandi, couleurs forcées** : sous 640 px de haut, le panneau défile d'un bloc (l'en-tête avec les cartes) au lieu de laisser un corps sans hauteur ; en `forced-colors: active`, la puce pressée prend `Highlight` / `HighlightText` pour rester distincte des autres.
- **« Essayer » et la fermeture** : une carte qui fait un appel (onglet privé, capture de la page entière, Markdown) ferme d'abord le panneau, pour que l'effet (un onglet, une capture, une boîte d'enregistrement) ne se fasse pas derrière une boîte de dialogue modale.
- **Contours** : le contour d'un champ, d'une puce et d'un bouton est `--text-3`, jamais `--line-strong` (1,5 : 1 en clair, refusé par `discover-styles.test.ts`). Le bord d'une carte, qui ne fait que décorer, garde `--line-strong` et passe à 2 px en `--text-3` avec « Augmenter le contraste » (les deux règles, du système et du réglage « Toujours augmenter le contraste », sont lues avec leur déclaration `border-width: 2px` par `discover-styles.test.ts`, et `stylesheets.test.ts` refuse toute feuille dont les accolades ne se ferment pas).
- **Mouvement réduit** : le panneau n'anime rien de lui-même (ni démo, ni défilement automatique) ; sa seule transition, le fond d'une puce, est coupée par `prefers-reduced-motion`. Les démos animées viendront dans une autre carte, avec leur pause.
- **Contrastes mesurés** (jetons de `tokens.css`, teinte 250 ; le pire des 720 teintes à demi-degré près entre parenthèses ; `src/shared/design-tokens.ts` les garde au seuil) :

| Paire | Clair | Sombre | Seuil |
|---|---|---|---|
| Texte / surface (carte, boutons) | 17,7 | 14,5 | 4,5 |
| Texte 2 / surface (« Où », phrase d'aide) | 8,0 | 8,6 | 4,5 |
| Texte 3 / surface (contour du champ, des puces, des boutons) | 5,6 | 5,7 | 3 |
| Texte / dégradé d'en-tête (deux extrémités) | 9,7 et 12,4 (9,5 et 11,6) | 14,2 et 14,6 | 4,5 |
| Contour du champ et des puces (texte 3) / dégradé d'en-tête | 3,08 et 3,93 (3,02 et 3,68) | 5,5 et 5,7 | 3 |
| Texte sur « Essayer » (on-accent / accent) | 9,9 | 5,4 (4,62) | 4,5 |
| Badge « Désactivée » (warn-ink / surface) | 7,7 | 11,0 | 4,5 |

  Relevé à faire : le texte 2 est sous 4,5 : 1 sur le dégradé d'en-tête vers la teinte 238 en clair (4,38 : 1) ; l'en-tête n'écrit donc son compteur et son libellé de niveau qu'en texte (le plein contraste), pas en texte 2.
- **Non vérifié sans VoiceOver ni écran réel** : l'ordre de lecture des cartes et la prononciation de « Essayer, <nom> » ; un écran de 320 px (le panneau passe en une colonne sous 680 px de large, mesuré sur la feuille et non dessiné) ; le texte agrandi à 200 %. À ajouter à l'étape 6 du protocole ci-dessous.

## À corriger (non fait, avec la raison)

| Constat | Mesure | Pourquoi pas fait |
|---|---|---|
| **Gris par défaut sous le seuil (dernier relevé, avant la migration sur les jetons)** | Ces mesures datent du dernier relevé moteur : elles décrivent les gris que les feuilles avaient avant d'être migrées. Les surfaces migrées lisent les jetons de `tokens.css`, dont les rôles de texte sont à 4,5 : 1 ou plus sur les deux schémas et à toutes les teintes (`design-tokens.test.ts`) ; `--text-on-space-2` est à 5,4 : 1 et `--text-3` à 5,2 : 1 en clair, 5,0 : 1 en sombre. Le relevé moteur n'a pas été rejoué depuis : les chiffres ci-dessous ne valent plus pour les surfaces migrées, seulement pour celles qui ne le sont pas. Texte secondaire de la barre latérale (avant migration) (nom de l'espace, « Nouvel onglet ») : 3,0 à 3,7 : 1 ; Réglages : `#707171` sur `#232425` = 3,3 : 1, indications et notes de bas de groupe ; centre de contrôle, gestionnaire de tâches (3,0 : 1), barre de commandes (2,3 : 1 pour les adresses grises) | couleurs d'origine, gardées par défaut. La variante « Augmenter le contraste » les corrige pour ceux qui l'ont activée. Pistes : l'étendre à la barre de commandes, au centre de contrôle et au gestionnaire de tâches, ou rehausser les gris par défaut. |
| **Cibles sous 24 × 24 px** (WCAG 2.5.8 AA) | liens-boutons de 16 px de haut dans les panneaux (« Réglages… », « Effacer »), champs de recherche de 18 px de haut dans leur capsule, poignée de contraste de l'éditeur de Retouche (19 px) | beaucoup sont dans une capsule plus grande, ou en ligne dans une phrase (exception de la norme) : à juger un par un |
| **Bouton de fermeture d'un onglet** (`hover-only`, `display: none`) inaccessible au clavier | — | remplacé pour le clavier par la touche Suppr de la ligne ; le bouton de son (visible quand la page joue du son) est un enfant d'un `role="button"` : VoiceOver peut ne pas l'annoncer séparément |
| **Réordonner par glisser-déposer** (dossiers) | pas d'équivalent clavier pour les dossiers | onglets et favoris : « Déplacer vers le haut » et « Déplacer vers le bas » dans leur menu contextuel (son accès clavier au menu contextuel n'est pas vérifié, voir « Protocole d'essai »), et ⌥↑ / ⌥↓ sur la rangée d'un onglet qui a le focus, voir « Corrections » n° 15 ; reste à faire : les dossiers |
| **Contraste du texte avec la fenêtre translucide ou un voile très léger** | « Effet de verre de la fenêtre » avec une « Opacité de la barre latérale » sous 100 % : le texte de la barre latérale est dessiné sur ce qui se trouve derrière la fenêtre, que Lucium ne mesure pas. « Intensité du voile » faible, réglée à la main, sur un fond d'image ou de vidéo : le texte garde le contraste que le fond lui laisse | voulu : ce sont des choix de l'utilisateur, dits dans l'aide des deux réglages (Réglages › Apparence et Personnaliser l'espace). Le contraste minimal (4,5 : 1) n'y est plus garanti. Le voile automatique d'un fond ajouté, sans réglage à la main, le garde : il monte jusqu'à ce que le titre d'un onglet en veille tienne 4,5 : 1 (`src/shared/auto-veil.ts`) |
| **Champs sans contour** (barre de commandes, recherche dans la page) : seul le curseur de saisie marque le focus | — | voulu |
| **Mini-fenêtre** (barre, sélecteur d'espace, plateau) et **Coup d'œil** | non contrôlés par le lanceur | à ajouter au lanceur |

## Non vérifiable sans VoiceOver

- L'ordre de lecture réel (VO+flèches) et le rotor (titres, liens, boutons) ; la lecture d'un `role="button"` qui contient d'autres boutons (ligne d'onglet avec bouton de son).
- Les annonces effectives des zones vivantes : la notice, le compteur de la recherche dans la page (`aria-live="polite"`), les messages `role="alert"` des formulaires.
- La prononciation des étiquettes françaises, des raccourcis (« ⌘⇧J ») et des émojis ; si l'ordre des mots dans « Modifier l'adresse, 127.0.0.1:56817 » est naturel.
- Les menus natifs (barre de menus, menus contextuels, menu de partage) : ce sont des `NSMenu`, accessibles par construction ; leur contenu en français est vérifié par `smoke-iso-menus.ts`, pas leur lecture.
- Les pages web : leur accessibilité est celle des sites (Chromium expose l'arbre à VoiceOver quand il est actif).

## Protocole d'essai VoiceOver

À faire à la main, VoiceOver activé.

1. Activer VoiceOver (⌘F5) ; Lucium lancé avec un profil de test (`--user-data-dir=$(mktemp -d)`), trois onglets ouverts, un dossier, un favori, un second espace.
2. **Barre latérale** : VO+→ depuis le haut de la fenêtre. Attendu : « Masquer la barre latérale », le favori par son titre, le dossier « développé/réduit », puis un seul arrêt « <titre>, bouton, actuel ». Flèche bas : onglet suivant ; Entrée : ouvre ; Suppr : « archivé », le focus passe au voisin.
3. **Barre d'outils** : Précédent, Suivant, Actualiser, Copier l'URL, l'adresse (« Modifier l'adresse, … »), Infos du site.
4. **Notice** : archiver un onglet (⌘W). Attendu : « Onglet archivé » annoncé sans déplacer le focus ; le bouton « Annuler » joignable.
5. **Barre de commandes** (⌘T) : taper, flèches haut/bas. Attendu : « Adresse ou recherche, zone de texte combinée », puis le résultat choisi est lu à chaque flèche ; Début et Fin vont au premier et au dernier résultat quand le curseur est déjà au début ou à la fin du texte (sinon ils déplacent le curseur) ; Tab complète la saisie.
6. **Panneaux** : ouvrir chacun (Découvrir Lucium par Aide, Historique ⌘Y, Téléchargements ⇧⌘J, Archive, Centre de contrôle ⇧⌘I, Éditeur de thème, Éditeur de Retouche). Attendu : « <nom>, boîte de dialogue », focus dedans, Échap ferme, le focus revient à la page.
7. **Réglages** (⌘,) : les pages lues dans la liste « Catégories de réglages » (11 boutons, celle affichée annoncée comme page actuelle, « 2 réglages modifiés » après le nom d'une page qui en a), puis « Réglages modifiés » ; « Plus de réglages » lu comme un bouton réduit ou développé, avec sa ligne ; une sous-page : son nom lu à l'ouverture, « Revenir à … » ; les boutons d'un préréglage lus comme des boutons radio (« 2 sur 3 ») avec la ligne de l'option ; la notice d'un préréglage annoncée ; interrupteurs lus avec leur état ; la boîte « Aperçus » garde le focus et le rend.
8. **Contraste de la page et Fenêtre** (Réglages › Apparence) : les libellés, le menu du mode pour tous les sites, la liste des sites réglés à part (leur menu « Contraste de la page sur exemple.org » et « Retirer exemple.org »).
9. Noter, pour chaque étape, ce que VoiceOver dit réellement ; signaler les écarts dans une issue.
10. Avec « Augmenter le contraste » (Réglages Système › Accessibilité › Affichage) : relancer Lucium et vérifier visuellement les gris de la barre latérale et des Réglages.

## « Contraste de la page » et les contrastes des sites

La fonction « Contraste de la page » (Réglages › Apparence, « Infos et réglages du site ») ne touche pas l'interface : elle recolore les **pages** d'un site, en Sombre ou en Clair (fonctionnement : `docs/architecture.md`, « Apparence de la fenêtre et contraste de la page »). Ce qu'elle garantit, sur ce que la page expose :

- **Texte** : 4,5 : 1 contre ce qui est derrière lui, 3 : 1 pour un grand texte (24 px, ou 18,66 px en gras) : critère RGAA 3.2 (WCAG 1.4.3). La luminosité du texte est poussée, même teinte, jusqu'au seuil ; l'opacité du texte et de ses ancêtres compte, comme les dégradés (le pire de leurs arrêts).
- **Composants d'interface** : 3 : 1 pour la bordure d'un champ de formulaire qui ne se détache pas de ce qui l'entoure et pour une petite icône SVG d'une seule couleur : critère RGAA 3.3 (WCAG 1.4.11).
- **Pas garanti** : un texte posé sur une image (image de fond, texte dans une image), les cadres (`iframe`), les racines fantômes fermées, les états (survol, focus) d'une feuille d'une autre origine servie sans CORS, que le moteur ne lit pas (il ne refait aucune requête).

**Mesure** : `scripts/readable-bench.mjs` charge des pages publiques dans Chrome sans fenêtre (Playwright, aucun compte, rien n'est cliqué ni accepté : une bannière de consentement qui couvre la page est mesurée telle quelle), lance la sonde et le moteur dans un monde isolé (comme `executeJavaScriptInIsolatedWorld` dans l'application), compte les textes visibles sous le seuil de leur taille (son propre calcul : styles calculés, fond effectif à travers les ancêtres, une image de fond rend le fond inconnu ; axe-core n'est pas une dépendance du projet et n'a pas été ajouté pour un script de développement), avant, avec l'inversion de la phase 1 et avec le moteur, et prend une capture de chaque état.

```sh
node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON scripts/readable-bench.mjs --out /tmp/banc-lisible [--only nom,nom] [--scroll]
```

Relevé du 8 novembre 2026 (Chrome 157 sans fenêtre, Apple M4 Max, fenêtre de 1 280 × 860). « Échecs » : textes visibles sous leur seuil, sur les textes comptés ; les textes posés sur une image (fond inconnu) ne sont comptés nulle part (98 sur l'article d'encyclopédie, 342 sur l'article long, 10 sur la boutique). « Page » : la page telle quelle, dans son propre thème. « Démarrage » : copie des feuilles et première tranche d'éléments, d'un bloc ; « 1re image » : du début du démarrage à la deuxième image peinte ensuite ; « Travail » : tout le temps du moteur sur le fil principal de la page, démarrage compris, jusqu'à ce qu'il n'ait plus rien à lire.

| Page (type) | Mode | Textes | Échecs : page | inversion | moteur | Démarrage | 1re image | Travail |
|---|---|---:|---:|---:|---:|---:|---:|---:|
| Article d'encyclopédie | Sombre | 1 616 | 18 | 12 | **0** | 41 ms | 48 ms | 60 ms |
| Article d'encyclopédie long (16 900 éléments) | Sombre | 6 396 | 22 | 12 | **0** | 61 ms | 74 ms | 133 ms |
| Page d'actualités (couverte par une bannière de consentement d'un autre site) | Sombre | 200 | 0 | 3 | **0** | 20 ms | 31 ms | 23 ms |
| Dépôt de code | Sombre | 439 | 0 | 0 | **0** | 183 ms | 206 ms | 236 ms |
| Documentation pour développeurs | Sombre | 2 975 | 0 | 0 | **0** | 62 ms | 73 ms | 191 ms |
| Fil de questions-réponses | Sombre | 2 776 | 8 | 0 | **0** | 110 ms | 115 ms | 149 ms |
| Forum (tableau HTML, couleurs en attributs) | Sombre | 321 | 272 | 282 | **0** | 17 ms | 18 ms | 17 ms |
| Page HTML simple | Sombre | 38 | 0 | 0 | **0** | 4 ms | 13 ms | 4 ms |
| Application web (carte) | Sombre | 30 | 16 | 16 | **0** | 35 ms | 37 ms | 36 ms |
| Spécification longue (14 700 éléments) | Sombre | 10 579 | 529 | 349 | **0** | 55 ms | 59 ms | 106 ms |
| Dépôt de code, thème sombre du site | Clair | 439 | 0 | 284 | **0** | 153 ms | 175 ms | 189 ms |
| Documentation, thème sombre du site | Clair | 2 977 | 3 | 508 | **0** | 69 ms | 80 ms | 205 ms |
| Boutique, sombre par défaut | Clair | 287 | 43 | 98 | **2** | 69 ms | 74 ms | 76 ms |
| Page locale qui change après le démarrage (200 éléments ajoutés, règles insérées par script, classe basculée, racine fantôme) | Sombre | 205 | 1 | 1 | **0** | 5 ms | 21 ms | 13 ms, puis 9 ms pour relire les changements (en 56 ms) |

Ce que montrent les captures : l'inversion garde des contrastes acceptables sur les pages claires (elle les renverse), mais elle donne au thème sombre d'un site, éclairci, des centaines de textes trop pâles (284 et 508 ci-dessus), et elle met en négatif les images de fond CSS et change la luminosité des couleurs de marque ; le moteur donne un thème sombre (ou clair) cohérent, teintes gardées, images intactes, et atteint 0 échec sur 13 pages sur 14. Les deux textes restants de la boutique (le texte d'un bouton sur un dégradé, une date à 50 % d'opacité) n'ont pas été élucidés ; cette page a 15 feuilles d'une autre origine que le moteur ne lit pas. Le démarrage le plus long (dépôt de code, 183 ms) vient de la copie de ses feuilles : 7 600 règles et 1 250 propriétés de couleur, environ 2 Mo de texte de copies.

## Rejouer le contrôle

```sh
pnpm build
LUCIUM_SMOKE_ONLY=a11y LUCIUM_A11Y_DUMP=/chemin/vers/releve.json node_modules/.bin/electron . --smoke --user-data-dir="$(mktemp -d)"
```

Le lanceur échoue si une surface a un contrôle sans nom, un interrupteur, une case ou un onglet sans état, un élément focalisable sans rôle, une langue de page autre que le français, un `tabindex` positif, un panneau que Échap ne ferme pas ; il vérifie aussi « Contraste de la page » (Sombre et Clair : la page recolorée, son texte à 4,5 : 1, une image qui garde ses couleurs, une page qui casse les fonctions de son propre monde et que la sonde lit quand même), la bordure et la translucidité de la fenêtre (voir `docs/architecture.md`, « Apparence de la fenêtre »). Les textes sous le seuil de contraste sont **consignés, pas bloquants** (voir « À corriger »).

## Ce qui n'a pas été rejoué sur le moteur

Corrections postérieures au dernier relevé : la barre de commandes en combobox, le panneau qui prend le focus (au lieu de l'arrière-plan, qui était un `div` focalisable sans rôle), Échap de « Renommer le favori », les `aria-label` des champs de renommage, des favoris et des espaces, `aria-expanded` des dossiers, l'exemption d'Échap pour les demandes d'autorisation et de connexion fictives du lanceur. Les tests unitaires de ces points passent ; le lanceur doit être rejoué une fois.
