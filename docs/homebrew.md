# Homebrew

Comment Lucium sera proposé par Homebrew, et comment le mainteneur tient le cask à jour. In English: [community/homebrew.md](community/homebrew.md).

**Aujourd'hui, rien n'est publié.** Le tap n'existe pas encore. Il sera créé une fois la version 1.0.0 publiée sur le canal stable ; d'ici là, aucune page du projet ne propose d'installer Lucium avec Homebrew. Le dépôt contient ce qu'il faudra ce jour-là : le générateur du cask, ses tests et le modèle du tap.

## Un tap à nous, pas `homebrew/cask` (pour l'instant)

Lucium s'installera depuis un tap du projet, le dépôt `github.com/pOwn3d/homebrew-lucium`, dont le fichier `Casks/lucium.rb` est le cask :

```sh
brew install --cask pOwn3d/lucium/lucium
```

Pas depuis le dépôt de Homebrew, `homebrew/cask` : Lucium n'en remplit pas encore les conditions ([Acceptable Casks](https://docs.brew.sh/Acceptable-Casks), [Package Acceptance Policy](https://docs.brew.sh/Package-Acceptance-Policy) ; lues dans la documentation et le code de `brew audit --new` installés avec Homebrew 7.0.13) :

- **Notoriété.** Un projet proposé par son propre auteur doit avoir sur GitHub au moins 90 forks, 90 observateurs ou 225 étoiles (30, 30 ou 75 quand quelqu'un d'autre le propose). Le dépôt public n'existe pas encore.
- **Ancienneté.** Un dépôt de code de moins de 30 jours n'est normalement pas accepté, et `brew audit --new` refuse une page d'accueil dont le domaine a été enregistré il y a moins de 30 jours.
- **Ce qui est déjà en place** : un téléchargement publié par le projet sur son propre site, signé Developer ID et notarisé, accepté par Gatekeeper ; un `livecheck` qui fonctionne (exigé pour un nouveau cask) ; aucun cask de `homebrew/cask` ne s'appelle `lucium` (liste des casks de Homebrew sur ce Mac, 11 novembre 2026).

Quand le dépôt public aura l'audience et l'âge demandés, le cask pourra être proposé à `homebrew/cask`, dont les mainteneurs décident. Le tap reste jusque-là ; ensuite, son cask pourra être marqué obsolète au profit du cask officiel.

### La confiance dans un tap

Depuis Homebrew 6, les casks d'un tap qui n'est pas celui de Homebrew ne se chargent que si on leur fait confiance ([Tap Trust](https://docs.brew.sh/Tap-Trust)). Installer avec le nom complet, `pOwn3d/lucium/lucium`, fait confiance à ce seul cask. Pour utiliser le nom court (`brew install --cask lucium`), il faut d'abord `brew tap pOwn3d/lucium`, puis `brew trust --cask pOwn3d/lucium/lucium`.

## Ce que dit le cask

Le cask est produit par un script, jamais écrit à la main (plus bas). Pour la version 1.0.0 :

| Rubrique | Valeur | Pourquoi |
|---|---|---|
| `version`, `sha256` | la version et le SHA-256 de l'image disque | lus dans `Lucium-<version>-arm64.dmg.sha256`, la somme écrite par `scripts/make-dmg.mjs` |
| `url` | `https://lucium.app/updates/darwin-arm64/Lucium-#{version}-arm64.dmg` | là où `scripts/publish-update.mjs --channel stable` publie l'image, à côté de l'archive ; le nom ne change qu'avec la version |
| `name`, `desc`, `homepage` | `Lucium`, `Web browser with a vertical sidebar`, `https://lucium.app/` | la description suit les règles de Homebrew : ce qu'est le logiciel, sans éloge |
| `livecheck` | `strategy :json` sur `https://lucium.app/updates/darwin-arm64/feed.json`, clé `currentRelease` | le fichier de versions que lisent les copies installées : la version qu'il propose est la dernière version stable |
| `auto_updates true` | | Lucium se met à jour seul (Squirrel.Mac) : `brew upgrade` ne le touche pas, `brew upgrade --greedy` installe la version du cask si elle est plus récente |
| `depends_on arch: :arm64`, `depends_on macos: :ventura` | puce Apple, macOS 13 ou plus récent | le `LSMinimumSystemVersion` de l'Electron embarqué (13.0 dans l'application 0.3.0), à relire à chaque montée d'Electron. Homebrew 7 déprécie la forme en chaîne `">= :ventura"` : le symbole seul veut dire « cette version ou plus récente » |
| `app` | `Lucium.app` | |
| `zap trash:` | les sept chemins ci-dessous | |

Aucun script `preflight`, `postflight` ou `uninstall` : le cask copie l'application, rien d'autre, et ne touche jamais à la marque de quarantaine. Gatekeeper vérifie l'image notarisée comme un téléchargement depuis le site.

`brew uninstall --zap --cask lucium` met à la corbeille ces chemins, et seulement eux :

| Chemin | Ce que c'est |
|---|---|
| `~/Library/Application Support/Lucium` | le dossier de données : profil, état, historique, coffre de mots de passe, extensions (`userData` d'Electron, `productName` de `package.json`) |
| `~/Library/Caches/app.lucium.browser` | le cache de téléchargement du programme de mise à jour |
| `~/Library/Caches/app.lucium.browser.ShipIt` | la mise à jour qu'il prépare ([drm.md](drm.md), section 12) |
| `~/Library/HTTPStorages/app.lucium.browser` | son stockage réseau |
| `~/Library/Preferences/app.lucium.browser.plist` | les préférences que macOS garde pour l'application |
| `~/Library/Preferences/ByHost/app.lucium.browser.ShipIt.*.plist` | les préférences que le programme de mise à jour garde pour ce Mac |
| `~/Library/Saved Application State/app.lucium.browser.savedState` | l'état des fenêtres qu'AppKit enregistre (macOS 13 à 15) |

Les six premiers ont été vus sur le Mac du mainteneur pour l'application (sous l'identifiant qu'elle avait avant son renommage : les mêmes fichiers) ; le premier est le `userData` d'Electron pour le `productName` Lucium, et `src/main/shell/squirrel-staging.ts` travaille dans le troisième. Le septième est l'endroit où AppKit garde les fenêtres d'une application sous macOS 13 à 15 ; le Mac du mainteneur, sous un macOS plus récent, n'a pas ce dossier. Chaque chemin est une seule entrée, au nom de Lucium, directement dans un dossier de `~/Library` que d'autres applications partagent : jamais le dossier partagé lui-même, jamais le dossier d'une autre application (un test le refuse). Ne sont pas mis à la corbeille : les éléments que Lucium garde dans le trousseau (« Lucium Safe Storage » d'Electron, la clé du coffre ; Homebrew ne peut pas les retirer), les téléchargements, et les rapports de plantage que macOS garde dans ses propres dossiers.

## Produire le cask

```sh
node scripts/make-cask.mjs --tap ../homebrew-lucium                                  # l'image de la version de package.json, dans dist-drm/
node scripts/make-cask.mjs --tap ../homebrew-lucium dist-drm/Lucium-1.0.0-arm64.dmg   # cette image-là
```

Le script ne lit que des fichiers locaux (il ne télécharge rien, ne publie rien, ne committe rien) et écrit `Casks/lucium.rb` dans la copie du tap. À côté de l'image, il lit :

- `Lucium-<version>-arm64.dmg.sha256` : le cask prend son SHA-256 dans cette somme. L'image est aussi hachée, et une somme qui n'est pas la sienne est refusée ;
- `Lucium-<version>-arm64.build.json`, la fiche de construction : `scripts/build-drm-release.sh` ne l'écrit qu'avec `--notarize`, une fois l'application acceptée par Apple. Elle doit être celle de cette version et de son archive, construite depuis un commit propre ;
- `Lucium-<version>-arm64.dmg.json`, la fiche de l'image : `make-dmg.mjs` ne l'écrit qu'une fois l'image notarisée, agrafée et acceptée par Gatekeeper. Elle doit décrire cette image-là.

Aucune des deux fiches ne porte de mention « notarisée » : leur présence en est la preuve. Le script ne relance ni `stapler` ni `spctl` (`publish-update.mjs` l'a fait avant de publier l'image, et l'étape 17 de la publication vérifie le fichier que sert le site), et il ne vérifie pas que l'image est en ligne : le lancer après la publication sur le canal stable. Quand un fichier manque ou ne va pas, il donne tous les problèmes d'un coup, n'écrit rien et sort avec le code 1.

Le code est dans `src/main/homebrew-cask.ts`, avec ses tests à côté (`homebrew-cask.test.ts` : le fichier produit ligne à ligne, les refus, la somme, le nom de l'application, `zap` sans dossier partagé, https seulement).

## À chaque version stable

Après l'étape 17 de [community/release-process.md](community/release-process.md#steps-for-a-release) (l'image disque est sur lucium.app et vérifiée) :

1. `node scripts/make-cask.mjs --tap <copie de pOwn3d/homebrew-lucium>` ;
2. dans le tap : `brew style --cask Casks/lucium.rb`, puis un commit (`chore(cask): lucium X.Y.Z`), puis l'envoi sur GitHub ;
3. sur un Mac : `brew update`, puis `brew upgrade --cask --greedy pOwn3d/lucium/lucium` (ou `brew install --cask pOwn3d/lucium/lucium` la première fois), et lancer Lucium une fois.

`brew audit --cask --strict --online pOwn3d/lucium/lucium` ajoute ce que seul le réseau peut vérifier : l'image répond à son adresse, le macOS minimal lu dans l'application correspond à `depends_on`, livecheck trouve la version du cask. Il faut pour cela le tap, et la confiance dans le cask, sur ce Mac. Le premier `brew style` ou `brew audit` installe les gems Ruby dont Homebrew se sert pour eux (RuboCop et d'autres, depuis rubygems.org, dans le dossier de Homebrew).

**Après un retrait** (`publish-update.mjs --withdraw`), l'image de la version retirée répond 404, et le cask qui la nomme aussi. Remettre le cask de la version à laquelle le fichier de versions est revenu : dans le tap, `git revert` du commit de la version retirée, puis l'envoi sur GitHub. Un cask ne nomme jamais une version que le canal stable ne propose pas.

## La première fois : créer le tap

1. Créer sur GitHub le dépôt public `pOwn3d/homebrew-lucium`, vide. Son nom doit commencer par `homebrew-` : c'est là que `brew` trouve `pOwn3d/lucium`.
2. Y copier le modèle de ce dépôt, [`packaging/homebrew-tap/`](../packaging/homebrew-tap/) (son `README.md` et le dossier `Casks/`), et le `LICENSE` de Lucium.
3. `node scripts/make-cask.mjs --tap <cette copie>`, `brew style --cask Casks/lucium.rb`, commit, envoi sur GitHub.
4. Sur un Mac : `brew install --cask pOwn3d/lucium/lucium`, lancer Lucium, puis `brew uninstall --cask lucium`.
5. Seulement alors, ajouter la ligne `brew install --cask pOwn3d/lucium/lucium` aux README et aux pages de téléchargement du site.

## Mettre le tap à jour par un workflow : déconseillé

Un workflow du tap pourrait lancer `livecheck` et mettre le cask à jour tout seul. `brew bump-cask-pr` sert à cela dans `homebrew/cask` (la mise à jour automatique de Homebrew ne tourne que sur ses propres taps), et un workflow pourrait faire de même dans le nôtre. C'est déconseillé :

- le SHA-256 serait calculé sur ce que le serveur sert à ce moment-là, et non lu dans la somme de la version, qui est aussi signée dans l'annotation du tag. Un serveur qui servirait un autre fichier le ferait accepter ;
- le workflow devrait écrire dans le tap (`contents: write`, ou un jeton pour `bump-cask-pr`), alors que le projet ne laisse aucun droit de publication à un workflow ([community/release-process.md](community/release-process.md)) ;
- le cask changerait avant l'installation d'essai du mainteneur. Une commande à l'étape 18 de chaque version coûte moins qu'un tel workflow et ses droits.

Ce qui servirait : un workflow planifié **en lecture seule** dans le tap, qui lance `brew livecheck --cask` et `brew audit --cask --online` et échoue quand le cask a du retard sur le fichier de versions ou que son image répond 404 (après un retrait). Il n'écrit rien et n'a besoin d'aucun secret : GitHub prévient le mainteneur quand il échoue. Pas encore fait.
