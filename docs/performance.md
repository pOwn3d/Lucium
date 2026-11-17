# Consommation : mémoire et processeur (`pnpm perf`)

`pnpm perf` vérifie que Lucium ne consomme pas trop de mémoire ni de processeur. Il lance Lucium dans un profil jetable, le met dans un état précis (fenêtre vide, 10 onglets, 50 onglets, toutes les fonctions optionnelles coupées ou allumées), le laisse tranquille, puis lit avec `ps` la mémoire résidente et le processeur de **tout l'arbre de processus** (principal, GPU, rendus, utilitaires). Les mesures sont comparées aux seuils de `perf-budget.json` ; le script sort en code non nul quand un seuil est dépassé.

Ce n'est pas un test qui tourne avec `pnpm test` (il lance de vrais processus pendant plusieurs minutes) : c'est un outil de développement, à lancer avant une version et après un changement qui peut coûter (une fonction, une minuterie, une vue de plus par onglet).

## Lancer

```sh
pnpm perf                      # tous les scénarios, environ 6 à 8 minutes
pnpm perf --only idle-empty    # un scénario (ou plusieurs : --only idle-empty,tabs-10)
pnpm perf --repeat 3           # trois passages par scénario, médiane des mesures
pnpm perf --compare .perf/ref.json   # compare à un rapport précédent
pnpm perf --write-budget       # écrit les mesures comme seuils de référence (voir plus bas)
```

Avant de lancer : branchez la machine sur le secteur (le mode économie de batterie du système change la cadence), fermez les applications lourdes, laissez la fenêtre de Lucium visible et **ne touchez à rien pendant la mesure** : une fenêtre cachée ou une machine occupée fausse le processeur. Les mesures ne changent ni votre profil ni vos données : chaque passage a son dossier de données jetable (dans le dossier temporaire du système), supprimé à la fin, et le script n'arrête que les processus de l'arbre qu'il a lancé (jamais une autre copie de Lucium, jamais un autre navigateur).

| Option | Rôle |
|---|---|
| `--only a,b` | seulement ces scénarios |
| `--repeat N` | passages par scénario (1 à 10), médiane des mesures ; à utiliser pour fixer un seuil |
| `--cpu-seconds N` | durée de la mesure du processeur (30 s par défaut, 5 au moins) |
| `--settle-seconds N` | attente entre « scénario prêt » et le début de la mesure (10 s par défaut) |
| `--startup-runs N` | démarrages mesurés pour `startup-cold` (3 par défaut), médiane |
| `--compare FICHIER` | compare à un rapport JSON précédent |
| `--max-regression P` | régression tolérée en % (15 par défaut) |
| `--budget FICHIER` | autre fichier de seuils |
| `--write-budget` | réécrit le fichier de seuils avec les mesures de ce passage |
| `--out DOSSIER` | dossier des rapports (`.perf/` par défaut, ignoré par Git) |
| `--no-build` | ne reconstruit pas avant (`out/` doit être à jour) |

Sans `--no-build`, le script commence par `electron-vite build` (le build de développement, comme `pnpm start`).

Code de sortie : **0** dans le budget ; **1** un seuil dépassé ou une régression ; **2** une mesure impossible (l'application s'est arrêtée, une page ne s'est pas chargée, un fichier est invalide) ou une ligne de commande fausse. Le code 2 ne dit rien du budget.

## Les scénarios

Chaque scénario est un lancement neuf de l'application, dans un profil neuf. Les onglets montrent des pages locales servies par le script (`http://127.0.0.1:<port>/p/<n>`, environ 20 Ko de texte chacune, sans script ni image : elles mesurent le coût d'un onglet, pas celui d'un site).

| Scénario | État | Ce qui est mesuré |
|---|---|---|
| `startup-cold` | démarrage à froid : profil neuf, rien en cache | `readyMs`, du lancement du programme à la première image de la fenêtre (`ready-to-show`), médiane de 3 démarrages |
| `idle-empty` | au repos, une fenêtre sans onglet, réglages d'un profil neuf | mémoire et processeur |
| `tabs-10` | 10 onglets de pages locales, réglages d'un profil neuf | mémoire et processeur |
| `tabs-50` | 50 onglets, réglages d'un profil neuf | mémoire et processeur |
| `features-off` | 10 onglets, **toutes** les fonctions du registre coupées | mémoire et processeur |
| `features-on` | 10 onglets, **toutes** les fonctions du registre allumées (sauf trois, voir plus bas) | mémoire et processeur |

Pour les scénarios au repos : l'application annonce que le scénario est prêt (les réglages sont posés, les onglets chargés et vivants), le script attend `--settle-seconds`, puis prend un instantané de l'arbre toutes les 5 secondes pendant `--cpu-seconds` (30 s). La mémoire est la **médiane** des instantanés. Le processeur est la **moyenne** sur toute la durée, calculée avec le temps de processeur que chaque processus a consommé entre le premier et le dernier instantané (pas avec la colonne `%cpu` de `ps`, qui est une moyenne depuis la naissance du processus).

L'écart entre `features-on` et `features-off` est affiché dans le rapport (« Coûts déduits ») : c'est le coût de l'ensemble des fonctions optionnelles, avec les mêmes 10 onglets. Le coût d'un onglet se lit de la même façon, entre `idle-empty`, `tabs-10` et `tabs-50`.

## Les mesures

| Mesure | Contenu | Bruit toléré |
|---|---|---|
| `readyMs` | temps jusqu'à la fenêtre prête, en millisecondes | 500 ms |
| `rssTotalMb` | mémoire résidente de tout l'arbre, en Mo (somme du `rss` de `ps`) | 32 Mo |
| `rssMainMb` | le processus principal | 16 Mo |
| `rssRendererMb` | les processus de rendu : l'interface (fenêtre, panneaux, barre flottante) et les pages | 32 Mo |
| `rssGpuMb` | le processus GPU | 16 Mo |
| `rssUtilityMb` | les utilitaires de Chromium (réseau, stockage) | 16 Mo |
| `processCount` | nombre de processus de l'arbre | 2 |
| `cpuMeanPct` | processeur moyen de l'arbre, en % d'un cœur (deux cœurs occupés font 200) | 3 points |

Le « bruit toléré » est l'écart minimal qui compte : une limite n'est jamais plus proche de sa référence que cela, et une variation plus petite n'est jamais signalée comme une régression (un processeur qui passe de 0,2 à 0,4 % a doublé et ne veut rien dire).

## Lire le rapport

Le rapport est écrit dans le terminal et dans `.perf/` (`perf-<date>.md`, `perf-<date>.json`, et `latest.json` pour la dernière mesure). Le tableau « Mesures et seuils » donne, pour chaque scénario et chaque mesure : la valeur mesurée, le seuil (la limite), la marge et l'état :

- `ok` : la valeur est au plus égale au seuil ;
- `DÉPASSÉ` : au-dessus du seuil ; le code de sortie est 1 ;
- `MANQUANT` : le fichier de seuils a une limite pour cette mesure et le passage n'a rien produit ; c'est un échec de mesure (code 2) ;
- `sans seuil` : une valeur que le fichier de seuils ne limite pas.

Un scénario qui n'a pas pu être mesuré est listé en « Scénarios en échec » avec la raison et les dernières lignes de l'application. Un bandeau « seuils provisoires » signale un fichier de seuils qui n'a pas encore été calibré.

## Fixer un seuil

Les seuils sont dans `perf-budget.json`, versionné. Pour chaque scénario et chaque mesure :

```json
"tabs-10": {
  "rssTotalMb": { "baseline": 1300, "marginPercent": 25 },
  "cpuMeanPct": { "baseline": 4 }
}
```

- `baseline` : ce que la machine de référence a mesuré ;
- `marginPercent` (facultatif, sinon `defaultMarginPercent` du fichier, 25 par défaut) : ce qu'on accepte au-dessus ;
- **limite** = `baseline` + le plus grand de (`baseline` × marge) et du bruit tolérable de la mesure (tableau plus haut). Une valeur égale à la limite passe.

Le fichier porte aussi `reference` : la machine de référence (modèle, système, processeur, mémoire, version d'Electron). Les seuils ne valent que pour elle ; sur une autre machine, le rapport le dit.

**Calibrer** : sur la machine de référence, machine au repos et sur le secteur, `pnpm perf --repeat 3 --write-budget`. Le script réécrit le fichier de seuils avec les mesures (il garde les marges déjà choisies, remplace `reference` par la machine courante, ne touche pas aux scénarios qu'il n'a pas lancés et refuse d'écrire si un scénario a échoué), puis il faut **relire le diff** avant de le versionner. Le fichier reste `"provisional": true` tant qu'aucun passage n'a mesuré les six scénarios ; les seuils d'origine sont des estimations, pas des mesures.

**Relever un seuil** est une décision, pas un réflexe : on le fait quand un coût est voulu (une fonction utile qui occupe de la mémoire), jamais pour faire passer un dépassement non compris. Le message du commit dit pourquoi.

**Ajouter un scénario** : une ligne dans `SCENARIOS` de `src/shared/perf-core.ts`, une entrée dans `perf-budget.json`, une ligne dans ce document (le test `perf-files.test.ts` échoue sinon). **Ajouter une mesure** : `MEASURES` dans le même fichier.

## Comparer à une mesure précédente

`pnpm perf --compare .perf/ref.json` compare chaque mesure commune au rapport donné : l'écart en valeur et en %, et un état `RÉGRESSION` quand l'écart dépasse `--max-regression` % **et** le bruit tolérable de la mesure (`mieux` pour le mouvement inverse). Une régression fait sortir le script en code 1, même si le seuil tient. Usage : `cp .perf/latest.json .perf/ref.json` avant de travailler, puis `pnpm perf --compare .perf/ref.json` après. Si le rapport précédent vient d'une autre machine, le rapport l'écrit : les écarts ne valent alors pas pour celle-ci.

## Ce qui est mesuré et ce qui ne l'est pas

Les classes de coût sont celles du registre des fonctions (`src/shared/features.ts`, `docs/fonctions.md`). Ce qu'une mesure en voit :

| Classe | Vue par les mesures | Pourquoi |
|---|---|---|
| `none` | oui | rien ne tourne : l'écart entre `features-on` et `features-off` doit rester dans le bruit pour ces fonctions |
| `timer` | en partie | le processeur moyen voit une minuterie dont la période est courte ; un balayage de 10 minutes ou un contrôle quotidien n'y apparaît pas |
| `listeners` | en partie | le coût d'un écouteur arrive avec l'événement qu'il suit : seule l'inactivité de 10 pages locales est mesurée, pas une navigation ni un défilement |
| `network` | non | les mesures se font sans Internet (le bloqueur ne télécharge aucune liste dans ce mode) : ni les requêtes ni la mémoire des données téléchargées ne sont mesurées |
| `memory` | en partie | la mémoire résidente du processus principal et des pages est mesurée ; celle de données chargées à l'usage (listes du bloqueur, vignettes, historique) ne l'est que si le scénario les charge |
| `process` | en partie | les processus de l'arbre sont comptés ; un programme lancé à la demande (hôte de messagerie native, lecture à voix haute, fil de recherche) n'est pas lancé par les scénarios |
| `disk` | non | aucune mesure d'écriture sur le disque |

Limites à connaître avant de lire un chiffre :

- **La mémoire est le `rss` de `ps`**, additionné sur l'arbre. Une page de mémoire partagée (les bibliothèques d'Electron) est comptée dans chaque processus qui la voit : la somme est **plus haute** que « Mémoire » du Moniteur d'activité ou que l'empreinte réelle. C'est une mesure stable pour repérer une dérive ; ce n'est pas la mémoire que l'application occupe vraiment.
- **Pas de Internet, pas de liste du bloqueur.** L'application tourne comme dans le test moteur (`--smoke`) : le bloqueur n'a pas le droit de télécharger ses listes. `features-on` allume le bloqueur, mais sans liste chargée, donc sans la mémoire qu'elle prend en vrai. La mémoire et le temps de chargement du bloqueur avec ses listes ont été mesurés à part, hors de l'application (« Le bloqueur avec ses listes », plus bas).
- **Les pages sont légères** (texte seul, aucun script). Une page réelle avec du JavaScript et des images coûte plusieurs fois plus ; le chiffre par onglet est un plancher.
- **Le « froid » est celui du profil**, pas celui de la machine : chaque démarrage a un profil neuf (aucun cache de l'application), mais le cache de fichiers du système n'est pas vidé (cela demande des droits d'administrateur). Le premier démarrage après un build est le plus lent ; la médiane de trois l'amortit.
- **Le processeur est une moyenne sur `--cpu-seconds`** : un pic bref n'y apparaît pas. Les moyennes de chaque intervalle de 5 s sont gardées dans le JSON (`details.cpuIntervals`).
- **Le réglage est posé juste après le démarrage** (pas écrit dans le profil avant) : `features-off` démarre avec les réglages d'un profil neuf puis coupe tout. Le temps d'attente avant la mesure laisse aux portails le moment de tout arrêter.
- **Le mode est celui du test moteur** (`--smoke`, `LUCIUM_SMOKE_ONLY=perf`) avec les portails que ce test laisse de côté démarrés : copies automatiques, recherche de mises à jour (sans flux configuré, elle ne demande rien) et mémoire des fenêtres. Le raccourci global de la mini-fenêtre n'est pas enregistré. Pour `features-on`, l'application vérifie que les sept portails de cette liste tournent avant d'annoncer « prêt » (sinon le scénario échoue, avec leur nom) : un chiffre qui ne les compterait pas ne sort pas.
- **Fonctions laissées éteintes dans `features-on`**, avec la raison (`PERF_SKIPPED`, `src/shared/perf-features.ts`) : `lock` (sans phrase enregistrée, l'application remet le verrouillage à « désactivé » dès le lancement), `proxy` et `doh` (leur effet dépend du réseau de la machine de mesure, pas de Lucium).

## Le bloqueur avec ses listes : mesuré hors de l'application

`pnpm perf` tourne sans Internet, donc sans liste : ni le temps que le moteur du bloqueur prend au lancement ni sa mémoire n'y sont. Ces chiffres ont été pris à part le 10 novembre 2026, en lecture seule sur les fichiers d'un profil réel (10 listes, 8,47 millions de caractères ; moteurs compilés de 8,2 Mo pour les publicités et 1,9 Mo pour les bannières de cookies), avec `@ghostery/adblocker` 2.20.3 sous Node 26.13 (pas Electron), Apple M4 Max, fichiers déjà dans le cache du système. Médianes de 15 passages (5 pour la compilation).

| Ce qui est fait | Quand | Durée sur le fil principal |
|---|---|---|
| Relire un moteur compilé : lecture du fichier, somme de contrôle, copie, `FiltersEngine.deserialize` | à chaque lancement, une fois par catégorie | 7,2 ms (publicités : 0,65 + 0,20 + 0,13 + 6,24) et 1,8 ms (cookies) |
| Compiler les listes : `FiltersEngine.parse`, puis sérialiser | après une mise à jour des listes, et au premier lancement | 225 ms pour les 10 listes (de 222 à 333), plus 8 ms |

| Mémoire tenue par les deux moteurs | |
|---|---|
| Tampons des moteurs (`arrayBuffers`) | 9,6 Mo |
| Tas JavaScript, après 1 000 requêtes comparées | 1,7 Mo |
| Mémoire résidente du processus, après chargement, puis après 1 000 requêtes | +19 Mo, puis +27 Mo |

Ce que ces chiffres tranchent : le lancement paie environ **9 ms** pour le bloqueur, pas plusieurs centaines ; le sortir du fil principal (un worker, un processus utilitaire) ne se justifie pas, d'autant que le moteur doit rester dans le processus principal pour répondre à chaque requête sans attendre. La seule attente visible est la **compilation après une mise à jour des listes**, environ un quart de seconde sur cette machine, davantage sur une machine plus lente. La mémoire du bloqueur avec ses listes est de l'ordre de **10 à 30 Mo** dans le processus principal : à peine au-dessus du bruit toléré de `rssMainMb` (16 Mo), donc un scénario de `pnpm perf` avec listes ne verrait une régression que si elle doublait cette mémoire.

**Reste à mesurer dans l'application** : le même chargement sous Electron sur une machine plus lente et à froid (fichiers hors du cache du système) ; la mémoire des règles cosmétiques injectées dans chaque page ; l'effet du bloqueur sur le temps de chargement d'une page réelle.

## Taille de l'instantané envoyé aux fenêtres

À chaque publication, l'interface d'une fenêtre reçoit **l'instantané complet** (`UiSnapshot`, `Browser.snapshot()`), pas la différence avec le précédent : `PublishQueue` (`src/main/shell/publish-queue.ts`) fusionne les demandes d'un même tour de boucle en un seul envoi, et ce qu'une page en arrière-plan change (titre, icône, chargement) attend 200 ms (`PUBLISH_SOON_MS`) pour qu'une rafale ne parte qu'une fois ; puis `publishHere` (`src/main/shell/browser-publish.ts`) fait un `webContents.send` par destinataire : l'interface de la fenêtre, et seulement tant qu'ils sont ouverts la fenêtre Réglages, celle des extensions, la couche des panneaux et la barre latérale flottante. Seules deux parties de l'instantané grandissent avec le nombre d'onglets, `state` et `runtime` ; le reste tient en quelques centaines d'octets.

**Mesure** : `pnpm test:snapshot-bench` (`src/main/snapshot-bench.test.ts`, hors de `pnpm test` parce qu'il affiche des durées). Il fabrique des états de 500, 2 000 et 5 000 onglets (quatre espaces, vingt dossiers, un onglet sur dix épinglé, des titres d'environ 50 caractères, des adresses d'environ 85 caractères et une adresse d'icône d'environ 55 caractères par onglet, un onglet sur dix éveillé) et sérialise l'instantané avec `v8.serialize`, le sérialiseur de la copie structurée que `webContents.send` utilise. Médiane de 30 passages après 5 de chauffe, Apple M4 Max, macOS 27.2, Node 26.13 (pas Electron) ; trois lancements de suite donnent les mêmes tailles et des durées à 5 % près.

| Onglets | `state` | `runtime` | Instantané | Par onglet | Sérialisation (médiane · p95) | Lecture par l'interface | Un changement, trois fenêtres |
|---|---|---|---|---|---|---|---|
| 500 | 193 Kio | 38 Kio | 230 Kio | 472 o | 0,23 ms · 0,23 ms | 0,3 ms | 0,7 Mio |
| 2 000 | 738 Kio | 150 Kio | 888 Kio | 455 o | 0,81 ms · 0,86 ms | 1,2 ms | 2,6 Mio |
| 5 000 | 1 828 Kio | 376 Kio | 2 204 Kio | 451 o | 2,0 ms · 2,2 ms | 3,0 ms | 6,5 Mio |

- **La croissance est linéaire** : environ 450 octets, 0,4 µs de sérialisation et 0,6 µs de lecture par onglet. Le test le vérifie (la taille par onglet ne bouge pas de plus de 15 % entre 500 et 5 000).
- **La taille dépend du contenu des onglets**, pas seulement de leur nombre : une mesure du 5 novembre donnait 941 Kio pour la partie `state` de 5 000 onglets plus courts (environ 190 octets chacun) ; avec des adresses, des titres et des icônes ordinaires on trouve 1,8 Mio. Un seul `faviconUrl` en `data:` de 10 Ko fait autant que vingt onglets (aucun producteur de `data:` côté processus principal n'a été trouvé ; `FAVICON_MAX` de `state-clean.ts` borne chacun à 64 Ko quand un état est lu).
- **Le coût par changement** est le nombre de destinataires fois l'instantané : à 5 000 onglets, 2 ms de sérialisation par fenêtre sur le fil du processus principal, et 3 ms de lecture dans chaque interface. Avec le plafond de la fusion (5 publications par seconde par fenêtre pour les pages en arrière-plan), cela fait au plus 10 ms par seconde et par fenêtre, soit environ 1 % du fil principal.
- **Non mesuré** : le transfert entre les processus, le rendu des autres parties de l'interface une fois le message lu (le rendu de la barre latérale, lui, est mesuré plus bas), et ce qui s'ajoute à `state` en dehors des onglets : l'archive, les signets, « Lire plus tard », les sessions enregistrées, qui pèsent à peu près autant par entrée qu'un onglet. Ces chiffres sont donc un plancher ; seul un `pnpm perf` avec des milliers d'onglets dirait ce que coûte la réception de bout en bout.

**Recommandation : garder l'envoi complet, ne pas envoyer de différences pour l'instant.** À 5 000 onglets, le haut de la mesure, une publication coûte 2 ms à émettre et 3 ms à lire, sous la durée d'une image (16,7 ms), et la fusion borne déjà le rythme. Un protocole de différences ajoute un second chemin à garder identique au premier (reprise après une fenêtre qui a manqué un message, ordre avec les messages qui suivent un instantané, panneaux ouverts plus tard), pour un gain qu'on ne verrait pas à cette taille. **À revoir** si l'une de ces deux choses arrive : (1) un état de l'ordre de 10 000 éléments (onglets, entrées d'archive et signets ensemble), soit environ 4,4 Mio par message, 4 ms de sérialisation et 6 ms de lecture par fenêtre ; (2) un `pnpm perf` avec des milliers d'onglets qui montre le fil principal d'une interface occupé plus d'un tiers d'image (5 ms) à la réception d'un instantané. Si cela arrive, ne renvoyer d'abord que les onglets modifiés (`state.tabs` par identifiant) et l'entrée de `runtime` qui a changé, et garder l'instantané complet pour une fenêtre qui ouvre ou qui reprend.

## Le travail sur l'état : réducteur, barre de commandes, barre latérale, lancement

Ce qui se refait à chaque changement de l'état ne dépend pas d'Electron et se mesure sans fenêtre : le réducteur (chaque titre qu'une page change, chaque clic sur un onglet, ⇧⌘T), la clé du menu de l'application, les onglets que Retour fermerait (marqués dans chaque instantané), ce que la barre latérale calcule avant de dessiner ses rangées, le classement de la barre de commandes à chaque touche, et, une fois au lancement, la liste des onglets à réveiller.

**Mesure** : `pnpm test:state-bench` (`src/main/state-bench.test.ts`, hors de `pnpm test` parce qu'il affiche des durées). Il fabrique des états de 500 à 5 000 onglets (cinq dossiers par espace, un onglet sur dix épinglé, un tiers des onglets d'Aujourd'hui sous un autre avec l'arbre, une vue scindée par espace, vingt favoris sur deux profils, une archive pleine, l'onglet affiché vers la fin de son espace) et donne la médiane de 40 passages après 8 de chauffe, en millisecondes. Mesure du 12 novembre 2026, Apple M4 Max, macOS 27.2, Node 26.13 (pas Electron). Avant : le code du 12 novembre au matin ; après : avec les changements qui suivent.

| État | Titre (réducteur) | ⇧⌘T (réducteur) | Retour qui ferme | Barre vide | Barre « e » | Lancement | Barre latérale | Rangées comparées | Instantané copié |
|---|---|---|---|---|---|---|---|---|---|
| 500 onglets, 10 espaces | 0,17 → 0,16 | 0,92 → 0,35 | 0,61 → 0,04 | 0,58 → 0,15 | 1,1 → 0,78 | 0,97 → 0,24 | 0,17 → 0,13 | 0,07 | 0,8 |
| 2 000 onglets, 50 espaces | 1,5 → 0,60 | 5,8 → 1,4 | 2,6 → 0,11 | 2,0 → 0,51 | 4,8 → 2,0 | 12,6 → 1,3 | 0,44 → 0,31 | 0,12 | 2,6 |
| 2 000 onglets, 50 espaces, sans arbre | 0,12 | 3,5 → 0,35 | 3,3 → 0,10 | 1,7 → 0,39 | 4,0 → 2,0 | 4,4 → 1,4 | 0,11 | 0,13 | 2,7 |
| 2 000 onglets, 1 espace | 0,55 → 0,52 | 8,0 → 1,5 | 6,2 → 0,10 | 15,0 → 0,50 | 17,5 → 2,1 | 0,60 → 0,56 | 1,1 → 0,88 | 0,57 | 2,5 |
| 5 000 onglets, 50 espaces | 3,6 → 1,6 | 38,5 → 3,9 | 33 → 0,31 | 17,5 → 1,0 | 22,3 → 4,5 | 9,2 → 2,9 | 0,83 → 0,73 | 0,27 | 6,4 |
| 5 000 onglets, 1 espace | 1,9 → 1,6 | 58 → 4,2 | 49 → 0,36 | 101 → 1,3 | 105 → 5,1 | 1,5 → 1,3 | 2,9 → 2,6 | 1,5 | 6,0 |

- **Retour qui ferme l'onglet** : à chaque instantané, la fenêtre marque les onglets que Retour fermerait (réglage allumé par défaut, dès qu'un onglet ouvert depuis un lien est encore sur sa première page). Elle cherchait chaque onglet, puis son origine, parmi tous les onglets ; elle les lit maintenant dans une table faite une fois (`backClosesLookup`). C'était, avec des milliers d'onglets, le plus gros travail du processus principal à chaque publication.
- **« Rouvrir le dernier onglet fermé » (⇧⌘T) et la restauration depuis l'archive** : l'onglet revenu était cherché en parcourant tous les onglets d'avant pour chaque onglet d'après ; il l'est avec un ensemble (`tabOpenedSince`).
- **Le réducteur, avec l'arbre d'onglets** : `settleTree` passait une fois sur tous les onglets pour chaque espace qui a une branche ; il n'y passe plus qu'une fois. Sans l'arbre, le réducteur coûte 0,1 ms à 2 000 onglets.
- **La barre de commandes** : avant toute frappe, elle liste tous les onglets, et cherchait pour chacun l'onglet affiché parmi tous les autres (100 ms à 5 000 onglets dans un espace, à l'ouverture et à chaque touche) ; elle replie maintenant le texte tapé une fois, et lit une fois le classement des choix du profil.
- **Le lancement** : les pages des favoris étaient cherchées une fois par favori et par espace parmi tous les onglets, sur le processus principal pendant que les fenêtres s'ouvrent.
- **La barre latérale** : l'arbre (`treeRows`) est calculé niveau par niveau au lieu d'un tri ; le reste de ce qu'elle calcule est linéaire.
- La clé du menu de l'application (`menuKey`) coûte moins de 0,1 ms à 5 000 onglets : ce qui coûte dans le menu, c'est sa reconstruction native, que seule l'application mesure.

**Non mesuré ici** : le dessin des rangées par React (mesuré pour la barre latérale, plus bas). « Rangées comparées » est la comparaison par valeur qui décide quelles rangées redessiner (`sameTabRow`), et « Instantané copié » la copie de l'instantané d'un processus à l'autre (sérialisation dans le processus principal et lecture dans l'interface, comme `webContents.send`). Avec un espace de 5 000 onglets, chaque instantané coûte donc au moins 6 ms de copie, partagés entre les deux processus, puis 2,6 ms de calcul et 1,5 ms de comparaison dans l'interface, avant que React ne dessine quoi que ce soit. Une liste virtualisée ne réduirait que le dessin et la comparaison des rangées, pas la copie ni le calcul.

## Le rendu de la barre latérale

La barre latérale n'est pas virtualisée : chaque onglet est une rangée dans le DOM. Son rendu a été mesuré une fois, sur la build des sources de la 1.1.2, le 17 novembre 2026.

**Méthode** : l'application est lancée par Playwright sur un profil de test jetable, jamais sur le profil réel, avec N onglets d'un seul espace ; seul l'onglet affiché est chargé. Les chiffres viennent du protocole DevTools (les données de `chrome://inspect` > Performance), en médiane de 5 répétitions, sur un Mac Retina à 120 Hz non au repos.

| Rangées | Montage | Mise à jour d'une rangée (médiane · p95) | Défilement (image moyenne · p95 ; images > 34 ms) | Nœuds DOM |
|---|---|---|---|---|
| 30 | 31,7 ms | 6,5 · 10,4 ms | 8,4 · 10,3 ms ; 0 | 417 |
| 300 | 46,0 ms | 8,2 · 13,0 ms | 8,4 · 10,3 ms ; 0 | 2 847 |
| 1 000 | 102,8 ms | 11,4 · 16,8 ms | 8,4 · 10,1 ms ; 0 | 9 147 |

**Décision : ne rien changer à ~300 rangées.**

- Le montage n'a lieu qu'au chargement de l'interface. À 300 rangées, la mise à jour médiane (8,2 ms) et le défilement (image moyenne 8,4 ms) restent proches du budget d'une image à 120 Hz (8,3 ms), et aucune image ne dépasse 34 ms.
- **content-visibility est écarté** : il ne gagne rien au montage (47,3 ms contre 46,0 ms) et, pendant le défilement, il multiplie par 2,4 le temps de tâche du fil principal (1 755 ms contre 652 ms à 300 rangées).
- **La virtualisation** gagnerait environ 14 ms au montage et 1,7 ms par mise à jour à 300 rangées (plancher mesuré avec 30 et 60 rangées, sans le virtualiseur). Elle n'est pas engagée. Si le budget est dépassé, il faudra d'abord mesurer vers 1 000 rangées avec de vraies rangées (dossiers, arbre d'onglets, pastilles d'état).

**Limites** :

- Mesuré sous charge : la charge moyenne du Mac allait de 11 à 78 pendant la série. Elle ne peut que gonfler les chiffres, donc la conclusion « rien » est prudente.
- Rangées simples d'un seul espace : ni dossiers, ni arbre d'onglets, ni pastilles d'état. Les icônes ont été testées à part.
- Pages non chargées, sauf celle qui est affichée.
- Non mesurés : glisser-déposer à 300 rangées, cartes au survol, ouverture d'un gros dossier, navigation au clavier, recherche dans la page.
- Le script de mesure est un outil local, non suivi par Git : ces chiffres ne se relancent pas avec une commande `pnpm`.

## Pièces

| Pièce | Fichier | Rôle |
|---|---|---|
| Script | `scripts/perf.mjs` | construit, lance l'application, lit `ps`, écrit le rapport. Ne contient pas de règle : il appelle `src/shared/perf-core.ts` |
| Règles | `src/shared/perf-core.ts` | lecture de `ps`, arbre de processus, mesures, seuils, comparaison, tableau. Sans import à l'exécution : Node le charge tel quel |
| Lien avec le registre | `src/shared/perf-features.ts` | classes de coût vues par les mesures, fonctions laissées éteintes, réglages de « toutes allumées » et de « toutes coupées » |
| Côté application | `src/main/smoke-perf.ts` | prépare le scénario (réglages, onglets) et l'annonce sur la sortie standard ; son contrôle court est dans la chaîne du test moteur |
| Seuils | `perf-budget.json` | un seuil par scénario et par mesure, la machine de référence |
| Tests | `perf-core.test.ts`, `perf-features.test.ts` (`src/shared/`), `perf-files.test.ts`, `smoke-perf.test.ts`, `perf-script.test.ts` (`src/main/`) |
| Bancs sans fenêtre | `src/main/snapshot-bench.test.ts`, `src/main/state-bench.test.ts` | `pnpm test:snapshot-bench` et `pnpm test:state-bench` : la taille de l'instantané, et le travail sur l'état (plus haut). Hors de `pnpm test` : ils affichent des durées | règles sur des sorties de `ps` figées ; cohérence du registre, du fichier de seuils et de ce document ; préparation côté application contre un navigateur factice ; script lancé pour de bon contre une fausse application |

Les tests ne lancent pas Electron : `perf-script.test.ts` lance le script (option `--electron-path`, réservée à ces tests) contre un programme qui imite l'application (mêmes lignes sur la sortie standard, quelques processus avec les drapeaux `--type=` de Chromium, un processus qui consomme un demi-cœur), avec le vrai `ps` ; `smoke-perf.test.ts` fait tourner la préparation des scénarios contre un navigateur factice. Ce que ce programme ne dit pas, c'est ce que fait l'application réelle : la préparation côté application a son contrôle dans le test moteur (`runPerfSmoke`, juste avant « À propos »), et les chiffres réels ne viennent que d'un `pnpm perf`.

Tout ce qui est écrit sur le disque l'est dans `.perf/` (rapports), dans `out/` (build) et dans les dossiers jetables du dossier temporaire du système ; `perf-budget.json` n'est réécrit qu'avec `--write-budget`. Aucune donnée ne quitte la machine : les pages viennent de `127.0.0.1`, et le mode de mesure interdit au bloqueur de télécharger.
