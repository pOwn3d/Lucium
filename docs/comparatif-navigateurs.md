# Comparatif de navigateurs : mémoire, processeur, énergie

Mesurer la mémoire, le processeur et l'énergie de Lucium face aux autres navigateurs installés, avec les mêmes pages ouvertes. La consommation est un risque propre à Electron.

**État : le banc est écrit et testé, aucune mesure n'est publiée.** Le banc a été vérifié contre une application factice qui imite un navigateur (voir § 6), jamais contre un vrai navigateur : personne n'a encore lancé avec lui un des navigateurs du § 2, Lucium compris. Tant qu'aucune mesure réelle n'est faite, rien de ce document ne doit être repris comme un résultat.

Ce banc est le **comparatif** entre navigateurs. `pnpm perf` (`docs/performance.md`) est autre chose : le budget de Lucium seule, contre ses propres seuils. Les deux lisent `ps`, chacun avec son propre code (`src/shared/perf-core.ts` et `src/shared/bench-core.ts`, sans import entre eux).

## 1. Ce que le banc mesure

| Grandeur | Outil | Ce que c'est | Ce qu'il faut savoir |
|---|---|---|---|
| Mémoire résidente | `ps` (`rss`) | somme sur tous les processus du navigateur, moyenne des échantillons de la fenêtre | une page de mémoire partagée (bibliothèques du système, du moteur) est comptée dans chaque processus qui la voit : la somme est plus haute que la mémoire réellement occupée, et plus haute pour les navigateurs qui ont beaucoup de processus |
| Empreinte mémoire | `top` (`MEM`) | ce que le Moniteur d'activité appelle « Mémoire », sommé sur l'arbre, lu à la fin de la fenêtre | vérifié : `top` donne le même chiffre que `footprint` pour un processus. C'est la mesure à citer pour « combien de mémoire » ; la mémoire résidente sert de contrôle |
| Processeur | `ps` (`time`) | différence des temps de processeur entre le premier et le dernier échantillon, divisée par la durée réelle de la fenêtre ; 100 % = un cœur occupé en permanence | la colonne `%cpu` de `ps` n'est pas une moyenne sur la fenêtre : elle n'est pas utilisée. Un processus qui naît ou meurt pendant la fenêtre est compté jusqu'au dernier échantillon où on le voit |
| Impact énergétique | `top` (`POWER`) | le score du Moniteur d'activité (« Impact énergétique »), sur la fenêtre, sommé sur l'arbre | **lisible sans droits administrateur** (vérifié). Score relatif du système, **sans unité** : ce ne sont pas des watts et il ne se convertit pas en autonomie |
| Charge de la machine | `ioreg -rn AppleSmartBattery` (`SystemLoad`) | ce que la machine entière consomme, en watts, moyenne des échantillons | lisible sans droits (vérifié sur une lecture : 21,4 W de charge, 21,3 W tirés de la batterie, qui est aussi tension × courant). **C'est toute la machine** (écran, disque, autres applications) et pas le navigateur seul : d'où la mesure de la machine au repos avant et après |
| Décharge de la batterie | `ioreg` (`BatteryPower`, sinon tension × courant) | watts tirés de la batterie ; 0 sur secteur | seulement sur batterie |
| Niveau de la batterie | `pmset -g batt` | pourcentage entier au début et à la fin | trop grossier pour une fenêtre de 60 s (ordre de grandeur pour une batterie de 100 Wh : 1 % = 1 Wh, une minute à 20 W = 0,33 Wh) : consigné, pas utilisé pour comparer |
| Charge de départ et activité | `pmset -g`, `ioreg -c IOHIDSystem` | mode économie d'énergie du système ; temps depuis la dernière touche ou le dernier mouvement de souris | sert à écarter une passe où quelqu'un a touché la machine |

**`powermetrics` n'est pas utilisable sans droits administrateur** : la commande répond « powermetrics must be invoked as the superuser ». Le banc ne l'appelle pas et ne demande jamais de mot de passe. L'énergie vient donc de `top` (par processus, en score) et d'`ioreg` (machine entière, en watts). Si vous voulez recouper à la main avec `sudo powermetrics`, c'est possible, mais non vérifié ici et hors du banc.

## 2. Les navigateurs

Le banc cherche chaque application par son chemin, lit sa version dans `Contents/Info.plist` (`plutil`) et ne lance que ce qu'il trouve. Chaque navigateur qu'il lance lui-même reçoit un dossier personnel (`HOME`) vide, créé pour le passage et supprimé avec les profils : rien de ce qu'il lit ou écrit sous `~` n'est à vous (`src/shared/bench-core.ts`, `benchBrowserEnv`). Safari, lancé par `open -a`, n'en tient pas compte. Chaque navigateur y est désigné par son identifiant, celui qu'acceptent `--browsers` et `--app`. `--app <id>=<chemin du .app>` en désigne un autre ; `--chromium <id>=<Nom>=<chemin>` ajoute un navigateur à base de Chromium.

| Identifiant | Chemins cherchés | Profil | Comment il reçoit les pages | Comment ses processus sont comptés |
|---|---|---|---|---|
| `safari` (navigateur du système) | `/Applications/Safari.app` | **celui de l'utilisateur** (ce navigateur n'en a pas de jetable) : mesuré seulement quand `--browsers` le nomme | `open -a <chemin du .app> <adresses>` | le processus principal et ses descendants, plus les processus WebKit (`com.apple.WebKit.*`, enfants de `launchd`, pas du navigateur) apparus depuis le lancement |
| `chrome` (navigateur basé sur Chromium) | `/Applications/Google Chrome.app` | jetable (`--user-data-dir`) | adresses en arguments, puis une seconde commande qui les passe à l'instance ouverte | l'arbre du processus lancé |
| `brave` (navigateur basé sur Chromium) | `/Applications/Brave Browser.app` | jetable | comme `chrome` | l'arbre |
| `firefox` (navigateur basé sur Gecko) | `/Applications/Firefox.app`, sinon `Firefox Developer Edition.app` | jetable (`-profile`, `user.js` sans page d'accueil) | adresses en arguments, puis `-new-tab` | l'arbre |
| `lucium` | `/Applications/Lucium.app`, sinon `dist/mac-arm64/Lucium.app` du dépôt | jetable (`--user-data-dir`), état minimal semé | lancée seule, puis une seconde commande avec les adresses (la règle d'instance unique, `single-instance.ts`) | l'arbre |
| `arc` (navigateur passif) | `/Applications/Arc.app` | **jamais touché** | **c'est l'utilisateur qui ouvre les pages** | l'arbre du processus déjà ouvert, lu par `ps` |

**Un navigateur passif (`arc` par défaut, ou ceux de `--passive`) n'est jamais lancé, piloté, fermé ni interrogé par le banc.** Il n'est pris en compte que s'il est déjà ouvert, et seulement par une lecture de `ps` (qui ne donne que les chemins des exécutables, jamais les arguments, donc ni titre ni adresse d'onglet). Le banc n'y ouvre rien : à chaque palier il affiche une commande `open -a <chemin du .app> <adresses>` que **vous** lancez dans un autre terminal, puis attend la touche Entrée (dix minutes au plus ; sans terminal interactif, ce navigateur est ignoré). Les onglets que vous y aviez déjà restent comptés : c'est pourquoi on compare le **coût d'un onglet de plus** (§ 5), pas les totaux. Sa version est lue dans son application (`Info.plist`) ; pour `arc`, `--arc-version` la remplace. Le banc ne lit rien de son profil.

**Lucium** : l'état semé (`state.json` du profil jetable) contient un espace, aucun onglet et un seul réglage, `externalLinksInLittleArc: false`. Sans lui, les adresses reçues de l'extérieur s'ouvriraient dans une Mini-fenêtre (le comportement par défaut de Lucium), pas en onglets, et la comparaison n'aurait pas de sens. Tout le reste est la valeur par défaut du code (fonctions facultatives désactivées comprises). Un test (`src/main/bench-seed.test.ts`) vérifie que ce fichier est accepté par `parseSavedState` et que la version de l'état est celle de `model.ts`.

## 3. Préparer la machine

À faire avant chaque série, dans cet ordre :

1. **Batterie** : débranchée, à 50 % ou plus (à faible charge le système peut réduire les performances : non vérifié, mais inutile de le risquer). Sur secteur le banc mesure quand même la mémoire, le processeur, l'impact énergétique et la charge de la machine, mais pas la décharge de la batterie, et il le dit.
2. **Mode économie d'énergie** coupé (Réglages Système › Batterie). Le banc le lit et signale s'il est actif.
3. **Luminosité** fixée (par exemple à mi-course), True Tone et Night Shift coupés, même fond d'écran, pas d'écran externe branché ou débranché en cours de route.
4. **Fermer toutes les autres applications**, lecteurs de musique, messageries et synchronisations comprises. Le mieux est une session macOS fraîche ou un compte utilisateur vierge (cela aide aussi `safari`, mesuré dans votre profil). Le banc mesure la machine au repos avant et après : si elle n'est pas au repos (plus de 60 % d'un cœur utilisé sans navigateur) ou si elle a dérivé de plus de 10 % entre les deux, il l'écrit dans les réserves et le résultat n'est pas publiable.
5. **`safari` fermé** (⌘Q). Le banc refuse de continuer s'il est ouvert : il ne peut pas séparer ce qu'il ouvre de ce que vous aviez.
6. **Terminal en fenêtre normale, pas en plein écran** (un navigateur ouvert dans un autre Espace serait caché). Le banc vérifie qu'une page de chaque navigateur se dit « visible » ; sinon la passe est écartée.
7. **Ne plus toucher ni le clavier ni la souris** une fois lancé. Chaque fenêtre de mesure lit le temps écoulé depuis la dernière entrée : une touche pendant la fenêtre écarte la passe.
8. Pour fermer `safari` proprement, macOS peut demander d'autoriser Terminal à contrôler ce navigateur (`osascript`). Si vous refusez, le banc arrête le processus que lui-même a lancé, ce qui est moins propre.

## 4. Lancer

```
node scripts/compare-browsers.mjs                    # ce qui est trouvé et le plan, rien n'est lancé
node scripts/compare-browsers.mjs --list             # les navigateurs installés et leurs versions
node scripts/compare-browsers.mjs --run              # la mesure
node scripts/compare-browsers.mjs --run --browsers chrome --tabs 3,5 --passes 1 --settle 5 --window 10   # premier essai, un navigateur
```

Sans `--run`, rien n'est lancé. Node 22.18 ou plus récent (le script charge `src/shared/bench-core.ts` et `bench-pages.ts` par le retrait de types de Node, comme `scripts/perf.mjs`).

| Option | Défaut | Rôle |
|---|---|---|
| `--browsers a,b` | tous ceux qui sont trouvés, sauf `safari`, qui s'ouvre dans votre profil et doit être nommé (un navigateur passif seulement s'il est ouvert) | `safari`, `chrome`, `brave`, `firefox`, `lucium`, `arc` |
| `--tabs 10,30` | `10,30` | paliers d'onglets, croissants, ouverts dans la même session |
| `--passes N` | 3 | passes ; l'ordre des navigateurs tourne d'un cran à chaque passe |
| `--settle S` | 60 | repos entre « pages chargées » et la fenêtre |
| `--window S` | 60 | durée de la fenêtre de mesure (4 au minimum) |
| `--sample S` | 5 | pas des échantillons de `ps`, de la batterie et du clavier |
| `--cooldown S` | 15 | pause entre deux navigateurs |
| `--load-timeout S` | 90 | temps donné aux pages pour se charger (un tiers, deux fois, par palier) |
| `--fresh` | non | une session neuve par palier au lieu d'ajouter des onglets (repli si l'ajout échoue pour un navigateur) |
| `--out DOSSIER` | dossier temporaire du système | où écrire `comparatif.json` et `comparatif.md` |
| `--app id=chemin` | | désigne le `.app` d'un navigateur (`lucium`, `firefox`…) |
| `--chromium id=Nom=chemin` | | ajoute un autre navigateur à base de Chromium |
| `--passive id=Nom=chemin` | | un navigateur déjà ouvert que vous pilotez vous-même (`arc` est déclaré ainsi par défaut) |
| `--arc-version V` | lue dans l'application | version de `arc` à inscrire |
| `--no-caffeinate` | non | par défaut `caffeinate -d -i` garde l'écran et la machine éveillés pendant la mesure |

Durée : environ 80 minutes pour cinq navigateurs, trois passes et deux paliers (le plan l'affiche), plus le temps que vous mettez à ouvrir les pages dans un navigateur passif. Un `Ctrl-C` arrête ce que le banc a lancé, supprime ses dossiers jetables et écrit le résultat partiel (`comparatif.partial.json`).

## 5. Le déroulé

1. **Machine au repos, sans navigateur** : une fenêtre (charge de la machine, processeur de fond).
2. Pour chaque passe, pour chaque navigateur (dans un ordre qui tourne) :
   1. profil neuf (dossier temporaire du système), navigateur lancé avec **10 pages**, servies par le banc sur `127.0.0.1` ;
   2. attente que les 10 pages disent bonjour au serveur (chaque page signale son chargement et sa visibilité) ; les pages manquantes sont redemandées une fois ;
   3. repos de 60 s, puis **fenêtre de 60 s** : échantillons de `ps` toutes les 5 s, `top` sur toute la fenêtre, batterie et clavier à chaque échantillon ;
   4. **20 pages de plus** dans la même session (30 au total), même attente, même repos, même fenêtre ;
   5. le navigateur est arrêté (lui seul et ce qu'il a lancé), le profil jetable supprimé.
3. **Machine au repos** de nouveau.
4. Agrégation : **médiane des passes valides** (le minimum et le maximum sont dans le JSON), tableau Markdown, JSON.

**Une passe est valide** si elle a une fenêtre, si personne n'a touché la machine, si toutes les pages demandées se sont chargées et si au moins une page se dit visible. Sinon elle est comptée à part et sortie des médianes ; si aucune passe n'est valide, le tableau le dit (« aucune valide »).

**Le coût d'un onglet de plus** est la différence des médianes entre 10 et 30 onglets, divisée par 20 : il ne dépend ni de ce que le navigateur occupe au départ ni, pour un navigateur passif, des onglets que vous aviez déjà.

**Les pages** sont locales (aucun réseau : les en-têtes interdisent toute requête hors de l'origine) et identiques pour tous : cinq types qui se répètent (article de 60 paragraphes, horloge qui change chaque seconde, liste de 1 500 lignes mise à jour toutes les 5 s, dessin tracé une fois, indicateur de chargement animé). Dix pages en comptent deux de chaque type ; les dix premières des trente sont les mêmes.

**Les fichiers** : `comparatif.json` (tout : chaque passe, chaque fenêtre, les réserves) et `comparatif.md` (le tableau). Le dossier personnel est remplacé par `~` dans les deux.

## 6. Ce qui est vérifié, et ce qui ne l'est pas

Vérifié (tests dans `src/shared/bench-core.test.ts`, `bench-pages.test.ts`, `src/main/bench-seed.test.ts` et `bench-script.test.ts`) :

- la lecture de `ps`, de `top`, d'`ioreg` et de `pmset` sur des sorties figées (séparateur décimal du système compris), l'arbre de processus (racine absente, boucle de parents, pid 1 jamais racine), le calcul du processeur (processus né ou mort pendant la fenêtre, pid réutilisé, temps qui repart de zéro), la médiane, les passes écartées, le coût par onglet, la dérive de la machine au repos, le tableau ;
- les pages et le serveur : pages identiques d'un appel à l'autre, aucune adresse externe, run inconnu, méthode, numéro, adresse d'hôte ;
- le script lui-même, lancé pour de vrai (`src/main/bench-script.test.ts`) contre une **application factice** qui prend la ligne de commande d'un navigateur basé sur Chromium, lance trois processus qui occupent de la mémoire et dit bonjour au serveur comme une page : arbre mesuré, pages comptées, rapport écrit, code de sortie, **aucun processus ni dossier laissé derrière**, y compris quand l'application factice s'arrête seule pendant le repos ou pendant la fenêtre, ou que des pages ne se chargent pas ;
- quarante-neuf mutations du code pur et huit du script (arrêt de ce qui a été lancé, suppression du dossier jetable, vérification du serveur, détection d'un navigateur arrêté…) ont toutes été vues échouer sur le test correspondant.

- le chemin « navigateur ouvert par l'utilisateur » (mode passif), **à la main seulement** (il demande un exécutable Mach-O pour que `ps` en donne le chemin, ce qu'un test portable ne peut pas fournir) : le banc a été lancé sous un terminal simulé contre une copie de `node` renommée `Zed.app`, déjà ouverte ; les invites sont apparues, les pages ouvertes « par l'utilisateur » ont été comptées, la copie est restée ouverte. Jamais contre un vrai navigateur.

**Non vérifié, à contrôler au premier essai avec un vrai navigateur** (une commande par navigateur, § 4, et lire la colonne « Pages chargées ») :

- que chaque navigateur ouvre bien **10 puis 30 onglets** avec ces arguments : `chrome` et `brave` (seconde commande vers l'instance ouverte) sont le cas courant ; `firefox` (`-new-tab` sur un profil déjà ouvert), `safari` (`open -a` en onglets d'une seule fenêtre) et Lucium (seconde instance) ne l'ont pas été ici. Le banc détecte un échec (pages manquantes, passe écartée) ; `--fresh` est le repli ;
- le comportement de `safari` à la fermeture et la rouverture de fenêtres (§ 7) ;
- `top` et `ioreg` sur un autre modèle que celui des essais (un MacBook Pro Apple M4 Max sous macOS 27) : sur un Mac de bureau, la batterie est absente et le banc le dit (« pas de batterie lisible ») ;
- toute valeur chiffrée : aucune mesure réelle n'a été faite.

## 7. Limites

- **Une machine, un système, une date, des versions précises.** Les chiffres ne valent que pour cette combinaison ; la version de chaque navigateur est dans le tableau. Chromium 156 est le moteur de Lucium (Electron 45) comme des versions récentes des navigateurs basés sur Chromium : les écarts entre eux viennent de ce qui entoure le moteur (processus supplémentaires, services, fonctions), pas du rendu.
- **Des pages synthétiques ne sont pas des sites réels.** Pas de réseau, pas de vidéo, pas de publicités, pas de pisteurs, pas de connexion. Cela donne le coût de base d'un onglet, pas ce que vous voyez avec Gmail ou YouTube.
- **Chacun avec ses réglages d'usine.** Certains navigateurs arrivent avec un bloqueur actif, d'autres sans ; Lucium avec le sien activé par défaut. La mise en veille des onglets ne se déclenche pour personne en quelques minutes (celle de Lucium est de 30 minutes par défaut, `sleepAfterMinutes`) : la mémoire des onglets inactifs n'est libérée par aucun. Un usage de plusieurs heures est autre chose. Pour mesurer après un long repos, `--settle` accepte des valeurs en secondes (par exemple `--settle 2400`) : à faire comme **série à part**, jamais mélangée à la série courte.
- **Les navigateurs ralentissent les onglets cachés après un moment.** Chromium limite les minuteries des pages cachées depuis plus de 5 minutes (documentation publique, non revérifiée ici). Avec 60 s de repos le banc mesure l'état « juste après l'ouverture » ; une seconde série avec `--settle 330` donne l'état stabilisé. Publier les deux, en les nommant.
- **Un profil neuf n'est pas un profil d'utilisateur.** Aucune extension, aucun cookie, aucun historique, aucune session à restaurer (donc aucun navigateur ne rouvre ses onglets : c'est voulu). Le premier démarrage fait ses tâches (composants, indexation) pendant la première minute : d'où le repos de 60 s, les passes multiples et l'ordre qui tourne.
- **`safari` est mesuré dans le profil de l'utilisateur.** Il garde ses extensions et ses réglages, rouvre peut-être les fenêtres de sa dernière session (le banc ne le voit pas : il ne compte que les pages du jeu, les autres se chargent sans qu'il le sache et alourdissent la mesure ; fermez toutes ses fenêtres avant, et vérifiez à l'œil pendant l'essai qu'il n'affiche que les pages du banc), et les pages du banc restent dans son historique. Ses processus WebKit sont rattachés par leur chemin : un processus WebKit déjà lancé avant (par Mail, par exemple) est exclu, ce qui peut sous-estimer ce navigateur.
- **Un navigateur passif** (`arc`) : avec ses onglets préexistants, ouvert à la main. Seul le coût par onglet de plus est comparable ; ses totaux ne le sont pas.
- **`firefox`** : quand seule l'édition développeur est installée, c'est elle qui est mesurée ; ses réglages d'usine ne sont pas ceux de la version publique. Le tableau l'indique.
- **Lucium** : l'application empaquetée, pas `pnpm start` ni `pnpm dev`. Un état minimal est semé (§ 2).
- **Le processeur et l'énergie par processus ne voient pas ce qui vit moins de 5 s** entre deux échantillons, ni l'énergie d'un processus parti avant la fin de la fenêtre.
- **La charge de la machine est instantanée** toutes les 5 s sur un capteur dont la cadence de rafraîchissement n'a pas été vérifiée, et elle compte tout : écran, réseau, disque, autres applications. Seule la comparaison avec la machine au repos a un sens, et elle dépend de la luminosité.
- **Pas d'autonomie en heures.** Le banc mesure des watts sur quelques minutes. Une durée d'autonomie demande une décharge complète par navigateur, non faite.
- **Pas Windows ni Linux.** `ps`, `top`, `ioreg` et `pmset` sont ceux de macOS.

## 8. Publier sans fausser les chiffres

Avant de publier :

1. **Rien qui ne vienne d'un `--run` complet** sur le matériel indiqué. Pas de chiffre de ce document, pas d'extrapolation, pas de mesure d'un autre jour recollée.
2. **Lire les réserves** du fichier `comparatif.md`. Ne rien publier si une passe est « aucune valide », si la machine n'était pas au repos, si la dérive dépasse 10 %, si une page n'a pas chargé ou si la batterie était sur secteur et que le texte parle de batterie.
3. **Au moins trois passes**, et le JSON joint tel quel (aucune retouche à la main du tableau ni du JSON). Donner la médiane **et l'écart** (minimum et maximum du JSON), pas la médiane seule. Si l'écart entre passes dépasse l'écart entre navigateurs, on ne conclut pas.
4. **Tout dire des conditions** : machine, système, date, version exacte de chaque navigateur (et Electron pour Lucium), commande exacte, nombre de passes, protocole (pages locales, 10 puis 30 onglets, 60 s de repos, 60 s de fenêtre), niveau de batterie, luminosité, ce qui a tourné à côté.
5. **Nommer la grandeur**. « Empreinte mémoire » n'est pas « mémoire résidente » ; « impact énergétique » est un score, pas des watts ; « charge de la machine » est celle de toute la machine. Ne pas écrire « autonomie » : elle n'est pas mesurée.
6. **Ne pas classer ni arrondir en faveur de Lucium.** Ne pas écrire « X % de moins » sans le contexte (nombre d'onglets, série courte ou longue) et l'écart. **Publier aussi les cas défavorables** : si Lucium consomme plus qu'un autre navigateur sur un palier, c'est écrit tel quel (risque connu d'Electron).
7. **Dire ce qui manque** : sites réels, vidéo, longue durée, autres machines, autres systèmes, profils d'utilisateurs, `safari` dans un profil qui n'est pas neuf, navigateur passif.
8. **Recommencer** à chaque montée de version d'Electron ou de Chromium, et avant de reprendre un chiffre dans le README : ils datent de la version mesurée.
9. Les chiffres vont d'abord dans ce document (une section « Résultats » datée, avec le JSON dans `docs/`), puis seulement le README s'il y a lieu.

Gabarit de phrase, à compléter avec les vrais chiffres :

> Mesuré le `<date>` sur `<machine>` (`<système>`), `<N>` passes, médiane (minimum–maximum), 30 onglets de pages locales après 60 s de repos : Lucium `<version>` (Electron `<version>`) occupe `<x>` Mio (`<min>`–`<max>`) d'empreinte mémoire, `<navigateur de référence>` `<version>` `<y>` Mio (`<min>`–`<max>`). Pages synthétiques, profils neufs, une seule machine ; sites réels, vidéo et longue durée non mesurés. Données brutes : `<fichier JSON>`.

## 9. Les fichiers

| Fichier | Rôle |
|---|---|
| `scripts/compare-browsers.mjs` | lance les navigateurs, sert les pages, lit `ps`, `top`, `ioreg`, `pmset`, écrit le rapport. Ne contient pas de règle de calcul |
| `src/shared/bench-core.ts` | lecture des sorties, arbre de processus, fenêtre, médianes, tableau. Sans import : Node le charge tel quel |
| `src/shared/bench-pages.ts` | les cinq types de pages, le serveur (routes, en-têtes), le décompte des pages chargées |
| `src/shared/bench-core.test.ts`, `bench-pages.test.ts`, `src/main/bench-seed.test.ts`, `src/main/bench-script.test.ts` | règles sur des sorties figées ; script lancé contre une application factice |
