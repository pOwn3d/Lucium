# Recherche : barre de commandes et recherche dans la page

Tout se règle dans *Réglages › Navigation* (groupes Moteur de recherche, Propositions de la barre de commandes, Recherche rapide… ; un interrupteur par ligne, certains dans « Plus de réglages », en bas de la page) ; les réglages propres à un profil y sont aussi repris dans *Réglages › Profils*.

## Sources des propositions

Historique, onglets ouverts, onglets archivés, pages à lire plus tard : activés par défaut (clés `suggestHistory`, `suggestTabs`, `suggestArchive`, `suggestReadLater`). Une source désactivée n'est pas proposée, y compris dans la liste affichée avant toute saisie, et l'historique n'est même plus interrogé. Les suggestions du moteur de recherche gardent leur réglage par profil (`searchSuggestions`, « Inclure les suggestions de recherche »), repris dans la même fenêtre.

## Mots-clés « ! »

`!w comète` ou `comète !w` cherche dans Wikipédia ; `!w` seul ouvre le site ; `!` seul liste les mots-clés, Tab en fait une pastille. Les recherches dans un site de l'utilisateur passent avant la liste intégrée (un mot-clé personnel `w` remplace `!w`). Un mot-clé inconnu est du texte pour le moteur de recherche. Clé `searchBangs`, activée par défaut. Rien n'est envoyé pour résoudre un mot-clé.

Liste intégrée, 46 mots-clés : `g` Google, `img` Google Images, `gm` Google Maps, `tr` Google Traduction, `gmeet` Google Meet, `gdocs` Google Docs, `gsheets` Google Sheets, `gslides` Google Slides, `gdrive` Google Drive, `gmail` Gmail, `gcal` Google Calendar, `ddg` DuckDuckGo, `b` Bing, `brave` Brave Search, `qw` Qwant, `eco` Ecosia, `yt` YouTube, `tw` Twitter/X, `fb` Facebook, `ig` Instagram, `li` LinkedIn, `tiktok` TikTok, `gh` GitHub, `so` Stack Overflow, `mdn` MDN, `npm` npm, `pypi` PyPI, `caniuse` Can I use, `hn` Hacker News, `w` Wikipédia, `wen` Wikipedia (anglais), `wikt` Wiktionnaire, `osm` OpenStreetMap, `imdb` IMDb, `rd` Reddit, `az` Amazon.fr, `amz` Amazon.com, `ebay` eBay, `aliexpress` AliExpress, `discord` Discord, `zoom` Zoom, `trello` Trello, `notion` Notion, `figma` Figma, `jira` Jira Cloud, `twitch` Twitch (source : `src/shared/bangs.ts`).

### Moteurs qu'un site déclare

Quand une page déclare un moteur OpenSearch dans son propre document (`<link rel="search" type="application/opensearchdescription+xml">`), une notice propose de l'ajouter, une fois par site (clé `searchDiscovery`, **désactivée** par défaut). La page n'est lue qu'une fois chargée, dans un monde isolé de l'onglet ; aucune requête n'est faite pour savoir si un site a un moteur. Rien n'est ajouté sans le clic sur « Ajouter » ; ce clic lit une fois le fichier de description (64 Ko au plus, sans cookie, sans redirection, 4 s), sur le site où l'on se trouve : le modèle d'adresse qu'il donne doit être en https (ou en http sur cette machine), sur le même site que la page, avec `{searchTerms}` une seule fois. Jamais depuis une fenêtre privée. La liste des recherches garde la même règle (`isSearchAddress`, `src/shared/site-search.ts`) : https, ou http sur cette machine (`localhost`, `127.x.x.x`, `[::1]`, sans identifiant dans l'adresse), jamais http ailleurs ; le formulaire de Réglages › Navigation › Recherches par mot-clé, lui, n'accepte que https.

## Moteur des fenêtres privées

Réglages › Navigation › « Moteur des fenêtres privées » (clé `privateSearchUrlTemplate`, vide par défaut = comme les autres fenêtres). Choisi, il ne sert que dans les fenêtres privées (`profileSearch` pour `PRIVATE_PROFILE_ID`) : les autres fenêtres gardent le leur. La fenêtre privée le reçoit de la fenêtre principale, aussi quand il change pendant qu'elle est ouverte, et ne peut pas le modifier. Le réglage « suggestions » reste celui de la fenêtre principale, et **ce qui est tapé dans une fenêtre privée n'est jamais envoyé** à un moteur pour des suggestions (décidé par le processus principal, `typedStaysPrivate`). Aucune requête de plus : le moteur n'est contacté que quand on valide une recherche.

## Filtre par étiquette et mot-clé de signet

Dans la barre de commandes, un mot qui commence par `#` filtre les signets par étiquette (`#cui` pour `cuisine` : le début suffit, la casse et les accents ne comptent pas ; `#cuisine #dev` demande les deux). Un autre mot cherche dans le titre, l'adresse, la note et les étiquettes. Il faut la bibliothèque de signets active, et rien n'est proposé en fenêtre privée.

**Mot-clé de signet : décision du 22 novembre 2026 (option B).** Un signet n'a pas de champ « mot-clé » : l'état, le nettoyage `state-clean.ts`, la synchronisation iOS et `docs/ios.md` restent inchangés. Pour ouvrir un site en tapant un mot, on utilise « Recherche dans un site » (Réglages › Navigation, groupe « Recherche dans un site » : le mot-clé seul ouvre le site) ; pour retrouver un signet, `#étiquette` ou quelques mots de son titre.

## Calculatrice

`12*(3+4)` donne `= 84` en tête de la liste ; Entrée copie `84`. Clé `commandBarCalc`, activée par défaut. Opérateurs `+ - * × / ÷ ^ **` et `%` (pourcentage après un nombre : `50%` = 0,5 ; reste entre deux opérandes : `10 % 3`), parenthèses, point ou virgule décimale (dans les parenthèses d'un appel de fonction la virgule sépare les arguments, sauf si l'appel sépare par `;` : `max(1,5; 2)`), constantes `pi π tau e`, fonctions `sqrt racine cbrt abs sin cos tan asin acos atan atan2 sinh cosh tanh ln log log2 exp floor ceil round trunc sign deg rad fact pow min max hypot` (trigonométrie en radians). Pas de multiplication implicite. Un nombre seul, une date (`2026-10-24`), un résultat infini ou une division par zéro ne donnent pas de ligne. Le texte n'est jamais évalué comme du code (`src/shared/calc.ts`).

## Recherche avancée dans la page : casse, mots entiers, accents, expression régulière

Quatre boutons apparaissent dans le panneau ⌘F quand la clé `findRegex` est activée (**désactivée** par défaut : le panneau reste sans ces boutons, à sa largeur de 300 px ; avec eux il est plus large). Aucun n'est enfoncé au départ ; en appuyer un relance la recherche aussitôt.

- `Aa` **Respecter la casse** : option de la recherche de Chromium, qui reste la recherche utilisée tant qu'aucun des deux boutons suivants ni `.*` n'est enfoncé.
- `ab` (souligné) **Mots entiers** : seules les occurrences qui ne touchent aucune lettre, chiffre ou `_` de chaque côté sont gardées (`chat` ne trouve ni `chatte`, ni `achat`, ni `chat_`, mais `chat.` et `(chat)`). Les lettres accentuées sont des lettres (`cole` n'est pas un mot de `école`). Le texte tapé est cherché tel quel (les signes d'une expression y valent pour eux-mêmes), sauf si `.*` est aussi enfoncé : alors c'est l'expression qui est cherchée, et ses résultats sont filtrés de la même façon.
- `é` **Distinguer les accents** : la recherche passe par le moteur de Lucium décrit ci-dessous, qui compare les lettres telles qu'elles sont (`ete` ne trouve pas `été`) ; la casse suit le bouton `Aa`. Les mots entiers passent par ce même moteur, donc distinguent toujours les accents.
- `.*` **Expression régulière** : voir ci-dessous.

Le texte de la page est lu et comparé par le moteur de Lucium pour les trois derniers boutons ; l'expression ou le texte cherché n'est jamais envoyé à la page. Avec la clé désactivée, une demande de mots entiers, d'accents ou d'expression est ignorée par le processus principal, quoi que l'interface envoie.

### Expression régulière

L'expression est exécutée par Lucium dans un fil du processus principal (jamais par la page), abandonnée après 0,8 s (« Trop lent »), limitée à 500 caractères ; sans distinction de majuscules, `^` et `$` valent par ligne ; `\p{L}` marche, et une expression invalide dans ce mode est essayée sans le drapeau Unicode. Le texte visible de la page est lu par blocs (un résultat peut traverser des éléments en ligne ; le texte caché, les scripts et les styles sont ignorés) jusqu'à 4 millions de caractères ; 2 000 résultats au plus sont comptés (« 1/2000+ »). Les résultats sont peints avec l'API CSS Custom Highlight, sans modifier la page.

Limites connues : les cadres (`iframe`), les ombres DOM et le contenu des champs de saisie ne sont pas parcourus ; la page peut lire `CSS.highlights` et y voir les endroits surlignés (du texte qu'elle contient déjà, jamais l'expression) ; une page qui change son texte après la recherche n'est pas relue avant la prochaine frappe.
