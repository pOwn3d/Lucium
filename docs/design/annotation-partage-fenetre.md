# Annotation pendant le partage d'une fenêtre

Lucium propose deux façons d'annoter ce que l'on montre pendant une visioconférence :

1. **la fenêtre annotée** (Fichier › Partager une fenêtre annotée…) : Lucium capture une fenêtre, l'affiche dans une fenêtre de vue et dessine par-dessus ; on partage la fenêtre de vue ;
2. **l'annotation directe dans la page** (Fichier › Annoter cette page, ⌥⌘M, ou le bouton « Annoter » de la barre d'outils) : on partage la fenêtre du navigateur et l'on dessine sur la page affichée.

Les deux sont actives par défaut (`annotateShareEnabled`, `src/shared/window-share.ts`). La variable `LUCIUM_ANNOTATE=0` les éteint, depuis les sources (test moteur `--smoke` compris, qui ne tourne que depuis les sources) : l'application empaquetée retire cette variable au démarrage (`dropDevelopmentEnv`, `src/main/runtime.ts`). Éteintes, il n'y a ni module construit, ni gestionnaire IPC, ni menu ; les fichiers (pages, préloads) restent dans le paquet, mais aucune fenêtre ne les charge.

## Besoin

Pendant une visioconférence, on partage **une seule fenêtre** (par exemple celle du navigateur) et l'on veut :

1. dessiner et annoter par-dessus (crayon, surligneur, formes, effacer) ;
2. changer d'onglet ou cliquer dans la page, sans que les participants voient autre chose ;
3. ne partager que cette fenêtre : ni les outils d'annotation, ni les autres fenêtres.

## Contrainte de capture

Le logiciel de visioconférence ne capture que le contenu de la fenêtre choisie. Un calque placé au-dessus de la fenêtre n'est pas capturé. Les annotations doivent donc être **dans le flux** de la fenêtre partagée : dans la fenêtre de vue (fenêtre annotée), ou dans le contenu de la page (annotation directe). Les outils, eux, sont dans une fenêtre de commande séparée, qui n'est pas partagée.

## Consignes de partage

- Dans la fenêtre de partage de Meet, Zoom ou Teams, choisir **« Partager cette fenêtre »** et désigner la fenêtre de vue (fenêtre annotée) ou la fenêtre du navigateur (annotation directe).
- Ne jamais choisir **« Partager toutes les fenêtres de l'application »** ni l'écran entier : cela expose aussi la fenêtre de commande. Meet propose ces deux choix côte à côte.
- Garder l'appel dans une autre fenêtre ou sur un autre bureau : si l'onglet de la visioconférence est dans la fenêtre partagée, Meet affiche un avertissement de boucle.

## Autorisations macOS

- **Enregistrement d'écran** : pour capturer la fenêtre source de la fenêtre annotée. Sans elle, la liste des fenêtres ne demande rien au système et la commande affiche un message ; macOS peut demander de relancer l'application après l'avoir accordée.
- **Accessibilité** : seulement pour le mode passage de la fenêtre annotée (transmettre un clic à une autre application). Elle est demandée à l'activation de ce mode, jamais avant.

L'annotation directe dans la page ne demande aucune de ces autorisations.

## Confidentialité

Tout reste sur le Mac. Rien n'est envoyé à un service ; la capture n'est ni enregistrée ni transmise hors de l'application. Une fenêtre privée de Lucium n'est jamais listée ni capturable.

## Fenêtre annotée

### Capture de la fenêtre source

- Liste des fenêtres capturables : `desktopCapturer.getSources({ types: ['window'] })`, sans vignettes (identifiant et titre seulement). Les écrans sont exclus, ainsi que les fenêtres du partage elles-mêmes (pas de boucle).
- Fenêtre de vue (« Fenêtre annotée », 960 × 600) : elle affiche le flux de la fenêtre choisie, par `getDisplayMedia` dans une session en mémoire dédiée (`window-share-view`). Ni bouton ni texte de l'interface dans le flux : seulement l'image et les traits.
- Fenêtre de commande (« Partage de fenêtre ») : liste des fenêtres, actualiser, démarrer ou arrêter. Elle a son propre préload (`window.luciumShare`). Fermer la commande arrête le partage ; le verrouillage de l'application aussi.
- Une fenêtre privée de Lucium n'est jamais listée, et elle est refusée si son identifiant est demandé.
- Aucune donnée n'est écrite : le flux reste en mémoire, la session de la vue n'est pas persistée.

### Dessin

- **Outils** (dans la fenêtre de commande, jamais dans le flux) : sélection, crayon, surligneur, rectangle, ellipse, ligne, flèche, texte, effacer.
- **Couleurs** : cinq (rouge, jaune, vert, bleu, blanc). **Épaisseurs** : trois (fine, moyenne, épaisse). Un changement de couleur ou d'épaisseur s'applique à l'élément sélectionné.
- **Texte** : saisie directe sur le calque ; Entrée ou un clic ailleurs valide, Échap annule. Un texte vide, ou de plus de 200 caractères, est refusé.
- **Sélection et déplacement** : cliquer un élément le sélectionne, faire glisser le déplace. Suppr (ou Retour arrière seul) le supprime.
- **Annuler / rétablir** : ⌘Z et ⇧⌘Z, depuis la vue ou depuis la commande. **Tout effacer** : ⇧⌘⌫, annulable.
- **Limites** (`src/shared/window-share-draw.ts`) : 300 éléments au plus, 2000 points par trait, 100 étapes d'annulation ; un élément qui dépasse la limite n'est pas créé.

**Règle d'usage : partager la fenêtre annotée une seule fois, changer de source depuis la fenêtre de commande.** « Changer de fenêtre » bascule la vue sur une autre fenêtre sans la fermer ni la recréer (même fenêtre, même page, même calque ; le flux est remplacé dans le même élément vidéo) : l'outil de visioconférence continue de partager la même fenêtre, et les traits restent.

Architecture :

- Le calque de dessin est un canvas posé sur la vidéo, dans la fenêtre de vue : il fait partie de ce qui est partagé.
- Le modèle (éléments, sélection, historique, limites, palette, raccourcis) est pur : `src/shared/window-share-draw.ts`. Le canvas est dans `src/renderer/window-share-view.ts`.
- La fenêtre de vue a un préload minimal (`src/preload/window-share-view.ts`) : une écoute des actions de dessin (`window.luciumShareView.onDraw`), plus l'envoi d'un clic en mode passage et de l'état de l'image.
- La fenêtre de commande ne parle jamais à la vue : elle envoie au processus principal (`window-share:brush`, `window-share:edit`, `window-share:start`), qui valide (couleur, épaisseur et outil dans la palette ; commande dans la liste ; expéditeur = fenêtre de commande) puis envoie à la seule fenêtre de vue (`window-share:draw`). La brosse est gardée par le principal, qui la renvoie à la vue quand sa page est chargée.

### Fenêtre source fermée ou absente

- **Fenêtre fermée** : pendant un partage, le processus principal vérifie toutes les 2 s que la fenêtre source figure encore dans `desktopCapturer.getSources` (sans vignettes). Si elle n'y figure plus, la commande et la vue affichent « Fenêtre source fermée — choisir une autre », et la liste est rafraîchie. Une lecture en échec n'est pas une disparition. La vérification s'arrête avec le partage, à la fermeture de la vue et à celle de la commande (le minuteur est retiré).
- **Fenêtre réduite, cachée (⌘H) ou sur un autre bureau** : Electron ne donne pas cet état. Le processus principal demande à macOS la liste des fenêtres **à l'écran** (`CGWindowListCopyWindowInfo`, fonction `onScreen` de `window-share-native.ts`), au démarrage du partage puis toutes les 2 s. Une fenêtre listée pour la capture mais absente de cette liste est signalée (`ShareState.hidden`).
- **Image noire** : la vue regarde 32 × 18 pixels de son image chaque seconde (canevas hors écran ; les échantillons restent dans la mémoire de la page). Si toute l'image reste au plus au niveau 8 sur 255 pendant 4 s, ou s'il n'y a pas encore de trame, la vue le dit au processus principal (`window-share:picture`, seulement quand le constat change). Logique pure : `src/shared/window-share-picture.ts`.
- **Ce qui est dit** (`shareNoticeOf`, `src/shared/window-share.ts`) : `closed` si la fenêtre n'est plus listée, `away` si elle est listée mais sans image, sinon rien. La commande affiche un bandeau (« Ramenez la fenêtre à l’écran pour la partager… ») et la vue affiche le même texte **dans le flux partagé**, pour que les participants sachent pourquoi l'image est noire.

Limites : la détection peut prendre jusqu'à 2 s (4 s pour l'image noire). Une fenêtre à l'écran dont le contenu est réellement noir (terminal vide, vidéo noire) est signalée à tort. Une fenêtre réduite peut figer sa dernière image au lieu de devenir noire : le contrôle d'écran la signale quand même. `onScreen` n'existe que sur macOS.

### Mode passage

En mode passage, un clic gauche sur la fenêtre annotée est envoyé à la fenêtre source, au point correspondant (changer d'onglet, suivre un lien) :

1. **La vue** reçoit le clic et, au lieu de dessiner, envoie au processus principal le point, la place de l'image dans la page et la taille du flux (`window.luciumShareView.sendClick`, canal `window-share:click`, vérifié par `isPassClick`).
2. **Le processus principal** (`clickSource`, `src/main/shell/window-share.ts`) :
   - retrouve la fenêtre source : son identifiant `window:N:0` donne le CGWindowID, et `CGWindowListCopyWindowInfo` ses bornes et son PID ;
   - convertit le point (`sourcePoint`, `src/shared/window-share-pass.ts`) : position dans l'image, puis fraction de la fenêtre ; un flux en haute densité (Retina) donne le même point. Un point dans la marge de l'image, ou une fenêtre dont les proportions ne correspondent plus au flux (écart de plus de 2 %), n'est pas envoyé ;
   - vérifie l'autorisation Accessibilité **avant tout événement** ;
   - met l'application source au premier plan (`NSRunningApplication activateWithOptions:`), attend 80 ms, envoie un clic gauche (`CGEventPost`), puis ramène Lucium et la fenêtre de vue au premier plan.
3. **Le module natif** (`src/main/shell/window-share-native.ts`) porte les appels natifs, par koffi : `AXIsProcessTrustedWithOptions`, `CGWindowListCopyWindowInfo`, `NSRunningApplication`, `CGEventCreateMouseEvent` et `CGEventPost`. Il n'est chargé qu'au premier besoin, et seulement sur macOS (premier partage, pour le contrôle d'écran, ou première activation du mode passage).

**Compromis du focus.** La vue peut recouvrir la source ; pour que le clic l'atteigne, la source est activée juste avant le clic, puis Lucium revient devant. La source est donc visible sur l'écran du présentateur pendant une fraction de seconde (le partage ne montre que la vue), le curseur réel se déplace au point cliqué et le clavier passe brièvement à la source. Depuis macOS 14, l'activation d'une application par une autre est coopérative : si macOS la refuse, le clic peut tomber sur la vue. Placer la vue à côté de la source évite ce cas.

**Raccourci ⌥⌘P** (`PASS_SHORTCUT`, `Alt+CmdOrCtrl+P`) : bascule dessin et passage, même quand Lucium n'est pas au premier plan. Il est tenu par `globalShortcut` **uniquement pendant un partage**, et seulement si la case « Raccourci ⌥⌘P… » de la commande est cochée (cochée par défaut, non enregistrée). Si une autre application le tient, la commande affiche « Raccourci ⌥⌘P déjà pris ».

**Arrêt.** Le mode passage s'arrête (retour au dessin, raccourci libéré) quand le partage s'arrête, à la fermeture de la vue et au verrouillage de l'application. Un changement de fenêtre source le garde actif.

Limites du mode passage :

- seul le clic gauche est transmis : ni glisser, ni molette, ni clic droit, ni clavier ;
- deux clics à moins de 300 ms ne sont envoyés qu'une fois (un clic envoyé peut revenir sur la vue) ;
- une fenêtre réduite ou dans un autre bureau peut être listée, mais le clic ne l'atteint pas ;
- si la fenêtre source est recouverte par une autre fenêtre de sa propre application (une fenêtre flottante), le clic tombe sur celle-ci ;
- seul le CGWindowID compte, pas le nom de la fenêtre.

### Fenêtre de commande

Fenêtre de 400 × 560, non redimensionnable : en-tête avec une pastille d'état (Arrêté, En cours, Passage) ; **Source** (liste, actualiser, bandeau, Démarrer / Arrêter le partage, Changer de fenêtre) ; **Mode** (Dessin, Passage) ; **Outils** ; **Couleur** ; **Épaisseur** ; **Modifier** (Annuler, Rétablir, Tout effacer) ; raccourcis et interrupteur ⌥⌘P au bas. Elle n'utilise que les jetons de `src/renderer/tokens.css` (clair, sombre, « Augmenter le contraste »), des icônes SVG dans le script, des libellés visibles ou `aria-label`, `aria-pressed` pour les choix et un anneau de focus visible. Les textes sont dans `src/shared/i18n-fr.ts` et `i18n-en.ts`.

### Dépendance native : koffi

- **koffi** (`package.json`) sert aux appels CoreGraphics, Accessibilité et Objective-C. Son binaire darwin-arm64 est dans le paquet optionnel `@koromix/koffi-darwin-arm64` (`koffi.node`), trouvé sans compilation.
- Son script d'installation n'est pas exécuté (`koffi: false` dans `allowBuilds` de `pnpm-workspace.yaml`) : il ne fait que compiler depuis les sources, inutile avec le binaire fourni.
- electron-vite externalise les dépendances de `main` (koffi n'est pas dans le bundle) et `electron-builder` ne met pas les fichiers `.node` dans l'asar. koffi utilise N-API : le même binaire sert à la variante DRM.

### Tests

- `src/shared/window-share.test.ts` : règles pures (drapeau, filtrage, refus d'une fenêtre privée, exclusion des fenêtres du partage, règle de la notice).
- `src/shared/window-share-draw.test.ts` : palette, commandes d'édition, raccourcis, outils, limites, texte, historique, sélection et gomme.
- `src/shared/window-share-picture.test.ts` : image noire, seuil, alpha, série d'échantillons.
- `src/main/shell/window-share.test.ts` (Electron et module natif simulés) : refus d'une fenêtre privée et de la commande, permissions, brosse, bascule de source sans recréer la vue, disparition et absence de la source, mode passage (autorisation avant tout clic, expéditeur, forme du clic, délai anti-retour, arrêt, raccourci).
- `src/renderer/window-share-command.test.ts` : identifiants de la page, bandeau, clés de traduction.
- Le minuteur de la vérification de présence est inscrit dans `src/main/zero-cost-inventory.test.ts` (il n'existe que pendant un partage).
- Non couverts par un test : les appels natifs réels, le rendu de la vue et de la commande, l'échantillonnage du canevas.

## Annotation directe dans la page

On partage **la fenêtre du navigateur** et l'on dessine **sur la page**, sans fenêtre de vue séparée. Les participants voient les traits parce qu'ils sont dans le contenu de la page, donc dans la capture de la fenêtre.

### Architecture

- **Zone couverte** : le calque couvre la **zone de la page** de l'onglet affiché, et rien d'autre. Il est monté dans le document de la page, en `position: fixed` à 100 % de la fenêtre de cette page ; la vue de la page n'occupe que la carte de la page (`stageRect`, `Browser.frame()`) : ni la barre latérale, ni la barre d'outils, ni les autres onglets ne sont sous le calque. Exception : une page en plein écran HTML (vidéo) occupe toute la fenêtre, et le calque la couvre alors.
- **Calque par page** (`src/shared/page-annotate-layer.ts`) : un élément (`position: fixed`, `z-index` maximal, fond transparent) dont les traits sont dans un *shadow root* fermé, qui les met à l'abri des styles de la page. Le code est envoyé à la page comme **texte** (`pageLayerCall`, la source de `annotateLayer`) et exécuté dans un **monde isolé** qui n'est qu'au calque (`PAGE_ANNOTATE_WORLD`, par `Page.runAnnotateLayer` du port moteur), jamais dans le monde de la page. Pas de préload pour les pages, pas de canal de la page vers le processus principal : le calque reçoit l'état (mode, pinceau) à chaque appel, et n'envoie rien.
- **Ce que la page voit du calque.** Le calque voit le document de la page ; les scripts de la page ne voient pas ceux du calque.
  - *Hors de sa portée* : l'état du calque (traits, textes, historique), gardé sur l'objet `window` du monde isolé ; le *shadow root*, fermé et créé avec le `attachShadow` de ce monde, que la page ne peut pas remplacer ; la réponse à « un champ a-t-il le clavier ? » (`editing`), que la page ne peut plus donner à la place du calque. Elle ne peut ni lire ni modifier ce qui est dessiné ou écrit.
  - *Événements* : ceux du pointeur sur le calque (appui, déplacement, clic, molette) et ceux de la zone de texte (touches, texte saisi, collage, composition) sont pris sur `window` en phase de capture et arrêtés là (`stopImmediatePropagation`) : les écouteurs que la page a posés sur son document, sur ses éléments, ou sur `window` après la pose du calque ne les reçoivent pas. La touche qui ferme la zone de texte (Entrée, Échap) la ferme dès son appui ; son `keypress`, ses répétitions et son relâchement arrivent ensuite, visant la page puisque la zone n'est plus là : ils restent au calque jusqu'au relâchement (ou jusqu'à ce que la fenêtre perde le focus). En mode « Traverser », pendant que Contrôle ou Commande est tenu, et hors de la zone de texte, le pointeur et les touches sont à la page : rien ne lui est retiré.
  - *Ce qui reste, et pourquoi* : la page sait qu'un élément la recouvre (l'hôte du calque est dans son document, vide à ses yeux) et peut le retirer : le dessin n'est alors plus affiché jusqu'au prochain document (navigation, rechargement), la page se prive de l'annotation sans rien en apprendre. Et un écouteur que la page a posé **sur `window` en phase de capture avant la pose du calque** passe avant celui du calque : cette page reçoit encore la position du pointeur et les touches, comme pour tout ce qui se passe sur elle. Aucun script ne peut être placé devant un tel écouteur ; seul un champ de saisie hors de la page (dans la barre) lèverait cette limite pour le texte. **Cette limite est acceptée pour la 1.0** : le texte d'une annotation tapé sur une telle page peut donc être lu par elle, frappe après frappe. Déplacer la saisie dans la barre est un chantier à part, prévu après la 1.0 ; il n'est pas commencé.
  - *Contrôle* : `src/shared/page-annotate-layer.test.ts` (les événements), `src/main/engine/page-annotate-world.test.ts` et `src/main/shell/page-annotate.test.ts` (tout appel va au monde isolé), et la suite moteur `LUCIUM_SMOKE_ONLY=annotate` (`src/main/smoke-annotate.ts` : une vraie page qui s'épie ne lit ni les traits ni le texte ; tracé, gomme, texte, capture, effacement automatique). Lancée pour la première fois le 11 novembre 2026, elle a trouvé deux défauts, corrigés depuis : la gomme passée vite sur un trait ne l'effaçait pas (le moteur regroupe les déplacements rapides en un seul événement, et la gomme ne regardait que les points signalés, pas le chemin entre eux : elle efface maintenant le long de ce chemin), et le relâchement d'Entrée, après la pose d'un texte, arrivait à la page.
- **Contrôleur** (`src/main/shell/page-annotate.ts`) : une session, l'onglet affiché de la fenêtre où l'on travaille (`Browser.annotationTarget()`), un calque par page touchée. Il tient l'état (mode, pinceau, note) et le pousse à la fenêtre de commande.
- **Navigation** : le calque est refait vide quand le document change (`domReady`) ou quand l'adresse change (`update({ url })`, navigation sans rechargement comprise). Le signal vient de `Browser` (`notifyPageDocument`).
- **Changement d'onglet** : le calque de l'onglet quitté est **masqué**, pas retiré : ses traits survivent au changement d'onglet. Masquer, c'est `display: none` et `pointer-events: none`, et terminer le geste en cours et la zone de texte ouverte (son texte est gardé). Affiché de nouveau, il reprend le pointeur de son mode. Seul l'onglet affiché reçoit les commandes d'édition.
- **Vue scindée** : la page qui a le focus est la page annotée (`annotationTarget` prend l'onglet actif ; cliquer dans un volet le rend actif). Le bouton « Annoter » est dans la barre du volet qui a le focus ; l'autre volet ne reçoit aucun calque. Quand le focus passe à l'autre volet, le calque du premier est masqué et celui du second est posé. La barre d'outils se place par rapport au volet annoté (`annotationPlacement`, `splitPanes`) : son bord gauche par défaut, et la position choisie (voir « Position de la barre ») se compte depuis ce volet ; elle peut recouvrir l'autre volet.
- **Fenêtre de commande** : une fenêtre à part (`src/renderer/page-annotate-command.*`, `src/preload/page-annotate-command.ts`), qui ne fait pas partie de la fenêtre du navigateur.

### Barre d'outils

- **Fenêtre de commande séparée, pas la barre latérale** : la barre latérale fait partie de la fenêtre du navigateur et serait dans la capture. La fenêtre de commande reste hors de la capture quand on partage la fenêtre du navigateur (elle y est si l'on partage l'écran entier : ne jamais le faire).
- **Barre** flottante (`alwaysOnTop`, niveau *floating*), **placée où l'utilisateur l'a mise** (voir « Position de la barre ») : par défaut une **colonne** de 84 × 1000 points (`BAR_METRICS.column`) sur le bord gauche de la **fenêtre partagée**, à 12 points du bord, centrée sur sa hauteur (`barBounds`, `PageAnnotate.place`). Elle reste dans la zone utile de l'écran de cette fenêtre (`screen.getDisplayMatching`, `annotationPlacement`) et suit ses déplacements et redimensionnements (événements `move` et `resize`). Si la fenêtre est plus basse que la colonne, la colonne défile, son haut toujours en vue (`justify-content: safe center`) : avec un `center` simple, la moitié du dépassement partait au-dessus du haut, où aucun défilement n'arrive (la poignée et les premiers outils étaient perdus).
- Contenu : la **poignée** (⠿, en tête), le **Curseur** (⌥⌘P), les outils (icône en traits fins, lettre du raccourci dessous ; l'outil actif sur le fond pâle de l'accent), les couleurs, la minuterie de l'effacement automatique (voir « Effacement automatique »), Annuler, Rétablir, Page, Tout et Quitter. Toutes les touches de la colonne font 72 × 42 points, sauf la minuterie (72 × 30). Les couleurs de la barre sont les rôles de `tokens.css` : elle est claire en clair et sombre en sombre, comme le reste de l'interface (l'apparence du système, ou celle que force Affichage › Apparence › Apparence de Lucium) ; seules les pastilles d'aperçu du laser gardent des couleurs fixes (`palette.css`). **L'accent de la barre est celui de l'espace affiché dans la fenêtre annotée** : le processus principal donne à la barre la teinte de cet espace avec son état (`PageAnnotateState.hue`, nettoyée par `barHue`), la page la pose sur sa racine (`--hue`) et `tokens.css` en tire l'accent. **L'aperçu des zones de dépôt** (`annotate-bar-ghost.ts`) est dessiné avec le même accent, à la même teinte : sa page ne charge aucune feuille, les deux déclarations de l'accent y sont donc recopiées depuis `tokens.css` à la construction, et aucune couleur n'y est écrite en dur. Rien de cela n'a encore été vu à l'écran (contrôle écrit dans `src/main/smoke-annotate.ts`, jamais lancé). Les contrastes sont mesurés dans les deux apparences par `src/renderer/seen-surfaces-contrast.test.ts`. Le sélecteur de style du laser n'apparaît que quand le laser est l'outil.

### Position de la barre

La barre se place où l'on veut. **Poignée** (six points sur une bande teintée, en tête de la barre ; main ouverte au survol, fermée pendant le glissement ; info-bulle « Glisser pour déplacer la barre · clic droit : position » ; à côté, le bouton « Position ») : on la glisse ; **près d'un bord** (le pointeur à 24 points ou moins du bord de la fenêtre, `BAR_SNAP_DISTANCE`), la barre s'y accroche, **centrée le long du bord** : colonne sur le bord gauche ou droit, **rangée** sur le bord haut ou bas, à 12 points du bord ; pendant le glissement, **les quatre zones de dépôt** (les bandes de 24 points le long des quatre bords de la fenêtre) se montrent, faibles, celle où se trouve le pointeur s'allume et un **contour en pointillés** montre où la barre se posera ; **ailleurs**, elle reste **flottante** là où on la lâche, gardée dans la fenêtre (puis dans l'écran). Un clic sur la poignée, ou un glissement de moins de 4 points, ne déplace rien. C'est le pointeur qui décide, pas la barre : une colonne haute est toujours proche du haut et du bas d'une fenêtre. Les égalités vont à gauche, droite, haut, bas.

- **Bouton « Position »** (icône de disposition, à droite de la poignée, nommé « Position de la barre », atteint au clavier comme tout bouton) : un clic ouvre le même menu, sous le bouton ; on n'a pas besoin de connaître le clic droit.
- **Astuce du premier usage** : la première fois que la barre s'ouvre, une bulle au-dessus de la poignée dit « Astuce : glissez la poignée pour placer la barre où vous voulez » (EN : « Tip: drag the grip to put the bar wherever you like »), avec « OK ». « OK » et Échap la ferment (Échap ferme l'astuce avant de terminer l'annotation, que la touche vienne de la barre ou de la page annotée) ; un glissement qui a déplacé la barre (au lâcher), un choix du menu et une flèche sur la poignée la ferment aussi. Elle est retenue comme vue à ce moment-là (réglage `annotateBarHintSeen`, une mémoire), pas à l'ouverture : une barre fermée sans l'avoir lue la remontre. Animation d'apparition coupée quand le système demande moins de mouvement.
- **Clic droit sur la poignée** : le menu « Position de la barre » (À droite, À gauche, En haut, En bas, Flottante ; la position actuelle cochée). « Flottante » depuis un bord laisse la barre où elle est, dans sa disposition. **Clavier** : la poignée prend le focus ; la touche menu, ⇧F10, Retour ou Espace ouvrent le menu ; les flèches déplacent une barre flottante de 10 points (50 avec ⇧), sans effet sur une barre accrochée à un bord.
- **Retenue** : la position est un réglage (`annotateBar`, `Settings`, nettoyé au chargement par `cleanBarPosition`) : un bord, ou `floating` avec `x` et `y` **comptés depuis le coin de la fenêtre** (ou du volet) et la disposition. Elle survit aux utilisations et aux redémarrages ; elle est **ramenée dans la fenêtre** quand celle-ci est plus petite. La barre n'en garde aucune copie : elle lit le réglage à chaque placement (`PageAnnotate.refreshPosition` suit un changement venu d'ailleurs, une restauration par exemple).
- **Dispositions** : colonne (bords gauche et droit) ou rangée (bords haut et bas) ; une barre flottante garde celle qu'elle avait au moment du lâcher. Mêmes outils, couleurs et actions dans les deux. La rangée met chaque groupe d'une pièce (tête : poignée, bouton « Position » et Curseur ; outils ; styles du laser ; couleurs ; minuterie, Annuler, Rétablir, Page, Tout ; Quitter) et passe à la ligne **par groupe** quand la fenêtre est trop étroite : au plus petit (720 points de large, deux lignes) rien n'est coupé, avec ou sans les styles du laser, la note et l'astuce. **La rangée n'a jamais de barre de défilement** (`overflow: hidden`) : le groupe de fin, « Quitter », n'a aucune marge à la largeur calculée, et une barre de 8 points (apparue pendant que la page, encore en colonne, était dans une fenêtre qui venait d'avoir la taille d'une rangée) le faisait passer à une ligne que la fenêtre ne montre pas, puis restait, la rangée ainsi réduite ne la faisant plus disparaître ; reproduit dans un Chrome sans fenêtre, barres de défilement visibles, puis corrigé. La taille de la fenêtre de la barre vient d'un modèle pur (`barSize`, `src/shared/annotate-bar.ts`) dont la page reprend les largeurs (propriétés `--pa-*`, `barMetricVars`) : la fenêtre n'est jamais plus petite que ce qu'elle contient ; mesuré dans un Chrome sans fenêtre, de 720 à 1800 points, en français et en anglais, avec et sans laser ni note.
- **Mécanique** : la barre est une fenêtre à part, que seul le processus principal peut déplacer. La page de la barre n'envoie que le **pointeur sur l'écran** (canal `drag`, phases `start`, `move`, `end`, `cancel`, validées) ; `PageAnnotate` déplace la fenêtre, tient ce que le glissement montre (`BarGhost`, `src/main/shell/annotate-bar-ghost.ts` : **une** fenêtre transparente de la taille de la fenêtre où l'on glisse, sans focus, que le pointeur traverse, avec les quatre zones de dépôt et le contour, **créée quand le glissement commence et détruite au lâcher** : rien au repos ; la barre est remontée au-dessus d'elle) et garde la position. Le menu est un menu natif (`Menu.popup`) construit par `barMenuEntries`. Seule la fenêtre de la barre peut parler à ces canaux.
- La barre reste visible pendant toute la session, quel que soit le focus (une autre fenêtre de Lucium, une autre application). Elle n'est cachée que si la fenêtre partagée n'affiche plus de page à annoter, et elle disparaît à la fin de la session.

### Outils et raccourcis

- **Outils** (`PAGE_TOOLS`) : crayon (P), surligneur (H), rectangle (R), losange (D), ellipse (O), flèche (A), ligne (L), gomme (bouton « Gomme », sans touche : retire un trait), laser (K), pointeur (Q). Cinq couleurs, celles de la fenêtre annotée ; l'épaisseur est la moyenne. Pas d'outil de texte ni de sélection dans la barre.
- **Raccourcis** (`pageKeyAction`, `src/shared/page-annotate.ts`) : les lettres des outils, E (efface la page affichée, comme « Page ») et X (efface toutes les pages, comme « Tout ») en mode dessin seulement ; ⌘Z annuler, ⇧⌘Z rétablir, ⌥⌘⌫ effacer cette page, ⇧⌥⌘⌫ effacer toutes les pages, Échap quitter, dans les deux modes. Les touches sont lues par le processus principal (`Page.watchInput`, `before-input-event`). Une lettre n'est pas prise si la page a un champ éditable en focus ou si une zone de texte du calque est ouverte. Un réglage (`annotateLetterKeys`, activé par défaut) coupe les touches d’une seule lettre (outils, E, X) : `pageKeyAction` prend alors `letters = false`, la page les garde, et la barre ne les nomme plus ; ⌘Z, ⇧⌘Z, ⌥⌘⌫, ⇧⌥⌘⌫ et Échap restent.
- **⌥⌘P** bascule le Curseur (`globalShortcut`, tenu seulement pendant une session). **⌥⌘M** lance et arrête la session : c'est l'accélérateur de Fichier › Annoter cette page, entendu quand Lucium est au premier plan (`PAGE_TOGGLE_SHORTCUT`, `src/shared/page-annotate.ts`). Avec le réglage `annotateGlobalShortcut` (désactivé par défaut), il est tenu dans tout le système (`globalShortcut`), et le menu l'affiche alors sans le lier, pour qu'un appui ne lance pas l'annotation deux fois. Si une autre application tient l'un de ces raccourcis, le message le dit, et le menu et le bouton restent utilisables.
- **Limite** : une touche ne peut pas être arrêtée avant la page (la réponse de la page arrive après) ; en mode dessin, la page reçoit donc aussi la lettre ou ⌘Z, et ses propres raccourcis peuvent réagir.

### Curseur, molette, clics et touches de maintien

- **Curseur** : un outil à part, pressé pendant que la page reçoit le pointeur. Le calque passe en `pointer-events: none` : les clics et le défilement vont à la page, le dessin reste affiché. Choisir un outil de dessin, ou cliquer de nouveau sur Curseur, revient au dessin.
- **Molette et pavé tactile en mode dessin** : le calque ne bloque pas le défilement. Sa molette (`wheel`, écouteur non passif) annule l'action par défaut puis fait défiler la page (`window.scrollBy`), horizontalement et verticalement (lignes × 16 px, pages × taille de la fenêtre). Le calque ne couvre pas les barres de défilement de la page. Les zones défilantes internes à la page ne défilent pas.
- **Clics et focus** : en dessin, les clics vont au calque ; le focus du clavier reste dans la page. Une zone de texte ouverte prend le clavier. La fenêtre de commande accepte le premier clic (`acceptFirstMouse`).
- **Touches de maintien** (`HOLD_KEYS`) : en dessin, tant que ⌘ ou ⌃ est maintenu, le calque passe en `pointer-events: none` ; ⌘ sert à cliquer dans la page (changer de diapositive, suivre un lien), ⌃ à faire défiler (sur Mac, ⌃ + clic fait un clic droit). Relâcher toutes les touches de maintien revient au dessin ; la perte du focus de la fenêtre (`blur`) remet tout à zéro. Le geste en cours est terminé et gardé.

### Laser et pointeur

Deux outils de désignation, visibles des participants (ils sont dans le calque), qui ne gardent rien : hors de l'historique, et ni « Page » ni « Tout » ne les effacent ; un autre outil les retire.

Le laser (K) a **trois styles** (`LASER_STYLES`, `src/shared/page-annotate.ts`), choisis dans la barre et gardés pour la session :

- **Net** : point plein de 6 px avec un liseré blanc, traînée de 2 à 3 px, fondu de 0,9 s ; le point reste affiché là où la souris s'est arrêtée ;
- **Discret** : point de 3,5 px, halo léger, traînée de 1,2 à 1,5 px, fondu de 0,55 s ;
- **Lumière** (par défaut, `DEFAULT_LASER_STYLE`) : point blanc dans un halo coloré de 16 px et une lueur de 30 px, traînée de 2 à 2,5 px, fondu de 1 s.

Les valeurs sont dans la table `LASER_LOOK` du calque, à tenir à jour avec la liste. Le **pointeur** (Q) est un disque semi-transparent de 14 px de rayon qui suit la souris, sans traînée.

### Effacement

« Page » (⌥⌘⌫, E) efface les traits de la page affichée ; « Tout » (⇧⌥⌘⌫, X) efface ceux de toutes les pages de la session, masquées comprises. Chaque page garde son historique : ⌘Z annule l'effacement sur la page affichée. Pour annuler un « Tout », il faut revenir sur chaque page et faire ⌘Z (sauf une page qui a changé de document entre-temps).

### Effacement automatique

Réglage **« Effacer les annotations automatiquement »** (`annotateAutoClear`, désactivé par défaut) et sa durée **« Délai sans activité »** (`annotateAutoClearSeconds` : 3, 5, 10, 20 ou 30 s ; 5 s par défaut, gardée quand le réglage est coupé ; une valeur hors de la liste est ramenée à la plus proche, `cleanAutoClearSeconds`, `src/shared/annotate-auto-clear.ts`). Quand il est actif, les traits et les formes d'une page annotée s'effacent seuls une fois la durée passée **sans activité sur cette page** : en fondu de 400 ms, sans question, comme « Page ». La barre, l'outil et la couleur restent.

- **Ce qui compte comme activité** (la durée repart de zéro) : un nouveau trait ou une forme ; un appui dans le calque, quel que soit le bouton ; le pointeur qui se déplace pendant qu'on dessine ou qu'on gomme, ou qui déplace le laser (K) ou le pointeur (Q) ; un outil, une couleur, le Curseur ou un style du laser choisis (dans la barre, ou par la lettre d'un outil) ; Annuler et Rétablir. Un pointeur qui se promène sans dessiner n'en est pas une. Une zone de texte ouverte n'est jamais effacée et compte comme une activité tant qu'elle est ouverte. Revenir sur un onglet n'est pas une activité : la durée court depuis la dernière activité sur sa page.
- **Annuler** : l'effacement est un pas de l'historique de la page, comme « Page ». ⌘Z (ou Annuler) rétablit les traits tant que la barre est ouverte, et ce qui est rétabli attend de nouveau toute la durée.
- **Une minuterie par page annotée**, affichée ou non. Une page masquée s'efface sans fondu ; une page masquée pendant son fondu s'efface aussitôt.
- **Sans fondu** quand le système demande moins d'animations (`prefers-reduced-motion`) ou quand Lucium le demande (« Réduire les animations », `forceReduceMotion`).
- **Bouton minuterie** de la barre, juste avant Annuler (icône de chronomètre) : la durée à côté (« 5 s ») et la couleur d'accent quand le réglage est actif, l'icône seule quand il est coupé. Un clic fait défiler désactivé → 3 → 5 → 10 → 20 → 30 s → désactivé et écrit le réglage (canal `page-annotate:auto-clear`, valeur revérifiée par le processus principal, `isAutoClear`). Son nom accessible dit l'état en une phrase (« Effacement automatique après 5 secondes sans activité », « Effacement automatique : désactivé ») ; l'info-bulle ajoute ce que fait un clic. Le bouton reste affiché quand le réglage est coupé, pour qu'on puisse l'activer depuis la barre. Dans la rangée, il a la largeur d'un outil (40 points) et les boutons de texte sont passés de 58 à 50 points : la rangée garde sa largeur (1024 points, 1112 avec les styles du laser) et aucun libellé n'est coupé (vérifié dans l'application par `tests/e2e/tools.spec.ts`, `annotate-timer`, en français). Dans la colonne, il fait 72 × 30 points, et la colonne garde ses 1000 points.
- **Réglages** › Outils et extensions › Outils web : la case et le menu de la durée. La barre et les Réglages lisent et écrivent les mêmes champs de l'état, par le réducteur ; un changement fait dans les Réglages pendant une session arrive à la barre et aux calques.
- **Où vit la minuterie.** Seul le calque voit l'activité (le pointeur sur le calque, sa zone de texte) : il garde l'heure de la dernière dans son monde isolé, sans minuteur. Le minuteur est celui du processus principal (`PageAnnotate`, une horloge par page qui a un calque, seulement pendant une session et quand le réglage est actif) : à l'échéance, il demande au calque si la durée est écoulée (action `expire`) ; le calque efface, ou lance le fondu, et répond combien de temps attendre avant la prochaine demande (le processus principal borne la réponse entre 50 ms et une heure). Un minuteur du calque aurait été un minuteur de la fenêtre de la page, que les mondes se partagent : la page aurait vu chaque minuteur créé aux numéros que reçoivent les siens, et aurait pu l'annuler par son numéro. Le fondu est une transition CSS de l'opacité du dessin sous le *shadow root* fermé : ses événements restent dans ce root, et la page ne la trouve pas par `getAnimations()`, ni sur son document ni sur l'hôte. La page ne peut donc ni lire, ni modifier, ni chronométrer la minuterie. Contrôlé par la suite moteur `annotate` : la page qui épie ne reçoit aucun événement et ne voit aucune modification de son document pendant le fondu et l'effacement, et l'effacement a lieu même quand elle annule tous les minuteurs qu'elle peut nommer.
- **Pas d'indicateur du temps restant** (anneau, barre de progression) : le temps restant dépend de l'activité, que seul le calque voit, et le calque n'a aucun canal vers le processus principal ; l'afficher demanderait d'interroger la page en continu.
- **Fenêtre annotée** (partage d'une autre fenêtre) : non concernée. Son dessin est un canevas dans une fenêtre de vue à part (`window-share-view`), avec sa propre barre de commande : l'effacement automatique ne s'y applique pas.

### Démarrage au partage et portée

- **Démarrage au partage** : quand une page (Meet, Zoom web, une visio dans une webview) demande l'écran et que la source choisie dans le menu de Lucium (`chooseShare`) est une fenêtre de Lucium du même groupe, la session démarre sans menu sur la page affichée de cette fenêtre. Le choix est transmis au navigateur de la page demandeuse (`ownWindowShared`, puis `Browser.annotateSharedWindow`), qui cherche la fenêtre dont le **numéro** (`windowNumber`, le N de `window:N:0`) correspond. Si la source est une autre application, rien ne démarre. Le journal trace chaque choix et son verdict (préfixe `[annotate-share]`).
- **Portée : une seule fenêtre** (`canAnnotateHere`). Tant qu'aucune fenêtre n'est partagée, n'importe quelle fenêtre de Lucium peut lancer la session (⌥⌘M, bouton « Annoter », menu Fichier). Dès qu'une fenêtre est partagée, elle devient **la** fenêtre annotable : une autre fenêtre refuse de démarrer (« Partagez cette fenêtre pour annoter. »). Une session lancée ailleurs passe à la fenêtre partagée.
- **Bouton « Annoter »** de la barre d'outils (icône de crayon, « Annoter la page (⌥⌘M) ») : visible tant que la fonction est active (`annotateToolbarFlag`, champ `annotateEnabled` de l'état de la fenêtre), sans dépendre d'un partage. Il lance ou arrête l'annotation de la page affichée de sa fenêtre, comme ⌥⌘M ; il sert à reprendre l'annotation après un nouveau partage.
- Une fenêtre hors du groupe du navigateur demandeur (un autre profil) n'est pas reconnue ; une fenêtre privée n'est pas capturable.

### Arrêt

Par le bouton Quitter de la barre, par Fichier › Annoter cette page (⌥⌘M), par le bouton « Annoter », par la fermeture de la fenêtre de commande, par le verrouillage, et par la navigation de la page qui a démarré la session. **Electron ne signale pas la fin du partage** : rien n'arrête la session quand Meet ou Zoom cesse de partager, et la fenêtre partagée reste la seule annotable jusqu'à la fin de l'application ou jusqu'à un autre partage.

### Limites (à connaître avant une réunion)

- **Traits fixes à l'écran** : le calque est lié à la fenêtre, pas au contenu. Si la page défile, les traits ne suivent pas le texte.
- **Pages qui ne reçoivent pas le calque** : les pages de l'application (erreurs, réglages), les fichiers, les pages d'extensions, `about:`, et toute adresse qui n'est pas `http` ou `https`. La fenêtre de commande l'indique (« Cette page ne peut pas être annotée »), de même qu'une page dont le DOM refuse le calque. Un échec d'appel est journalisé avec sa cause.
- **CSP stricte** : Electron ne documente pas si `executeJavaScript` est soumis à la politique de sécurité de la page ; le comportement sur une page à CSP stricte n'est pas vérifié.
- **Une seule page annotée** : la page affichée de la fenêtre partagée ; dans une vue à plusieurs volets, seul le volet actif.
- **Limites du dessin** : 300 éléments au plus, 2000 points par trait. L'historique est perdu à chaque navigation de la page.
- **Coût** : aucun processus en plus ; un calque par onglet touché pendant la session, en mémoire de la page. Aucun minuteur, sauf pour l'effacement automatique quand il est activé : une horloge du processus principal par page qui a un calque, pendant la session, qui interroge le calque au plus une fois par durée (et une fois de plus par fondu).
- **Pas d'Accessibilité** : aucun clic n'est envoyé à une autre application ; le module natif de la fenêtre annotée n'est pas utilisé.

### Tests

- `src/shared/page-annotate-layer.test.ts` : le calque exécuté comme la page le fait, sur un DOM factice (`src/shared/page-annotate-test-support.ts`) ; l'effacement automatique avec une horloge simulée (chaque sorte d'activité, le pointeur qui se promène, l'échéance et le fondu, Annuler, la zone de texte, la désactivation en cours de route, la page masquée, moins d'animations).
- `src/shared/annotate-auto-clear.test.ts` : le réglage de l'effacement automatique (durées, bornes, cycle du bouton, réducteur).
- `src/main/shell/page-annotate.test.ts` : contrôleur, Electron simulé, pages reliées au même DOM factice (portée, démarrage au partage, placement de la barre, raccourcis, effacement, laser).
- `src/shared/page-annotate.test.ts` : règles pures (validation, adresses injectables, raccourcis).
- `src/renderer/page-annotate-command.test.ts` et `src/renderer/annotate-split-pane.test.ts` : la fenêtre de commande (dont la poignée : glissement, touches) et le bouton dans la barre du volet qui a le focus.
- `src/shared/annotate-bar.test.ts` : la position et son nettoyage, le bord où l'on atterrit (seuil, centrage, égalités), les zones de dépôt (comparées à `snapEdge` en tout point), la taille de la barre dans chaque disposition jusqu'à la plus petite fenêtre (tous les groupes dans la fenêtre, sans coupe, à toutes les largeurs), où elle se place, le menu.
- Non couverts : le rendu réel (le DOM factice ne dessine pas), Meet, Zoom et Teams, les pages à CSP stricte, la fréquence d'images et le coût processeur.

## Non pris en charge

- Sélection, déplacement et modification d'un élément tracé sur la page ; outil de texte sur la page.
- Traits qui suivent le contenu au défilement.
- Annotation de plusieurs volets à la fois.
- Historique conservé d'une navigation à l'autre (volontairement absent).
- Détection de la fin du partage (Electron ne la signale pas).
- Fenêtre annotée : pas de redimensionnement de la vue à la proportion de la source ; pas de rotation ni de redimensionnement d'une forme sélectionnée.
