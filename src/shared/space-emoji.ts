// The emoji a space can wear: the catalogue (by category, with French and English keywords), the search, and the check of the value that is stored.
//
// This is the data layer only: it serves whichever picker is built on it (a grid by category, a search box, a recent list), and nothing in the
// interface reads it yet. The value a space keeps does not change: `Space.emoji` stays one string holding one emoji (a flag, a keycap, a sequence
// joined by zero-width joiners, an emoji with a skin tone and its variation selector are all one string).
//
// No dependency and no network: the catalogue is a table of rows `emoji english words | mots français`, read once. The words are what a person
// types to find it, in either language whatever the language of the interface (a French speaker may look for "cat", an English one for "chat").

import { t } from './i18n'

// ---------- the catalogue ----------

export type EmojiCategoryId = 'faces' | 'people' | 'nature' | 'food' | 'activities' | 'travel' | 'objects' | 'symbols' | 'flags'

export interface EmojiEntry {
  readonly emoji: string
  /** The English words and the French words that find it, lower case, without accents, one word each. */
  readonly en: readonly string[]
  readonly fr: readonly string[]
  /** Both, without repeats: what the search compares to. */
  readonly keywords: readonly string[]
}

export interface EmojiCategory {
  readonly id: EmojiCategoryId
  /** The name of the category in the language of the interface. */
  readonly label: string
  readonly emojis: readonly EmojiEntry[]
}

/** The rows of each category: `emoji english words | mots français`. A flag of a country is `CODE english words | mots français` (the pair of letters of the flag). */
const ROWS: Record<EmojiCategoryId, readonly string[]> = {
  faces: [
    '😀 grinning smile happy | sourire content heureux',
    '😃 smiley happy joy | sourire joyeux ravi',
    '😄 smile laugh happy | rire sourire gai',
    '😁 grin beaming teeth | sourire dents',
    '😆 laughing squint | rire hilare',
    '😅 sweat relief nervous | soulagement gene',
    '🤣 rofl rolling laugh lol | mort de rire mdr',
    '😂 joy tears laugh | larmes de joie rire',
    '🙂 slight smile | leger sourire',
    '🙃 upside down silly | tete en bas ironie',
    '😉 wink | clin oeil',
    '😊 blush smile pleased | rougir sourire content',
    '😇 angel halo innocent | ange innocent',
    '🥰 love hearts adore | amour coeurs adorer',
    '😍 heart eyes love | yeux en coeur amoureux',
    '🤩 star struck wow amazed | etoiles yeux emerveille',
    '😘 kiss blow | bisou baiser',
    '😋 yum tasty delicious | miam delicieux savoureux',
    '😛 tongue playful | langue taquin',
    '😜 wink tongue crazy | clin oeil langue fou',
    '🤪 zany crazy wild | dingue fou',
    '🤑 money rich greedy | argent riche',
    '🤗 hug hugging | calin accolade',
    '🤭 giggle oops secret | gloussement oups',
    '🤫 shush quiet secret | chut silence secret',
    '🤔 thinking hmm | reflexion penser hum',
    '🤐 zipper mouth silent | bouche fermee',
    '🤨 raised eyebrow suspicious | sourcil sceptique',
    '😐 neutral | neutre',
    '😑 expressionless blank | sans expression',
    '😶 no mouth speechless | sans bouche muet',
    '😏 smirk sly | sourire en coin narquois',
    '😒 unamused bored | blase mecontent',
    '🙄 eye roll | yeux au ciel',
    '😬 grimace awkward | grimace gene',
    '😌 relieved calm | soulage serein',
    '😔 pensive sad | pensif triste',
    '😴 sleeping zzz tired | dormir sommeil fatigue',
    '🤒 sick thermometer | malade fievre',
    '🤕 hurt bandage injured | blesse pansement',
    '🤢 nauseated sick | nausee degoute',
    '🤧 sneeze cold | eternuer rhume',
    '🥵 hot overheated | chaud surchauffe',
    '🥶 cold freezing | froid gele',
    '🥴 woozy dizzy | etourdi groggy',
    '😵 dizzy knocked out | etourdi assomme',
    '🤯 mind blown exploding head | tete qui explose stupefait',
    '🤠 cowboy hat | cowboy chapeau',
    '🥳 party celebrate birthday | fete celebrer anniversaire',
    '😎 cool sunglasses | lunettes de soleil cool',
    '🤓 nerd geek glasses | geek lunettes intello',
    '🧐 monocle curious | monocle curieux',
    '😕 confused | perplexe',
    '😟 worried | inquiet',
    '🙁 frown sad | triste moue',
    '😮 surprised open mouth | surpris bouche ouverte',
    '😲 astonished shocked | stupefait choque',
    '🥺 pleading puppy eyes | supplie yeux de chiot',
    '😢 cry sad tear | pleurer larme triste',
    '😭 sobbing crying | sangloter pleurer fort',
    '😱 scream fear shocked | cri peur effraye',
    '😖 confounded frustrated | frustre',
    '😞 disappointed | decu',
    '😤 triumph steam nose | triomphe fierte',
    '😡 angry rage red | colere rouge furieux',
    '🤬 swearing cursing | jurons insultes',
    '😈 devil smiling imp | diable demon sourire',
    '💀 skull dead | crane mort tete de mort',
    '💩 poop | caca',
    '🤡 clown | clown',
    '👻 ghost halloween | fantome',
    '👽 alien extraterrestrial | alien extraterrestre',
    '🤖 robot bot | robot',
    '🎃 pumpkin halloween jack o lantern | citrouille halloween'
  ],
  people: [
    '👋 wave hello bye hand | salut coucou main',
    '🤚 raised back hand | main levee',
    '🖐️ hand fingers splayed | main doigts ecartes',
    '✋ stop raised hand | stop main levee',
    '👌 ok perfect hand | parfait main',
    '✌️ victory peace | victoire paix',
    '🤞 fingers crossed luck | doigts croises chance',
    '🤟 love you hand | je t aime main',
    '🤘 rock horns metal | rock cornes',
    '👈 point left | gauche pointer',
    '👉 point right | droite pointer',
    '👆 point up | haut pointer',
    '👇 point down | bas pointer',
    '👍 thumbs up like yes good | pouce en l air oui bien',
    '👎 thumbs down dislike no | pouce vers le bas non',
    '✊ fist power | poing',
    '👊 punch fist bump | poing coup',
    '👏 clap applause bravo | applaudir bravo',
    '🙌 raised hands celebrate hooray | mains levees hourra',
    '🤝 handshake deal agreement | poignee de main accord',
    '🙏 pray thanks please folded hands | priere merci s il vous plait',
    '✍️ writing hand | ecrire main',
    '💪 muscle strong flex biceps | muscle fort biceps',
    '🧠 brain mind smart | cerveau esprit intelligent',
    '👀 eyes look watching | yeux regarder',
    '👁️ eye | oeil',
    '👂 ear listen | oreille ecouter',
    '👃 nose smell | nez odorat',
    '👄 mouth lips | bouche levres',
    '🦷 tooth dentist | dent dentiste',
    '👶 baby | bebe',
    '🧒 child kid | enfant',
    '👦 boy | garcon',
    '👧 girl | fille',
    '🧑 person adult | personne adulte',
    '👨 man | homme',
    '👩 woman | femme',
    '🧓 older person senior | personne agee',
    '🧑‍💻 technologist developer coder computer | developpeur informaticien ordinateur',
    '🧑‍🏫 teacher professor | enseignant professeur',
    '🧑‍🎓 student graduate | etudiant diplome',
    '🧑‍🍳 cook chef | cuisinier chef',
    '🧑‍🔬 scientist researcher | scientifique chercheur',
    '🧑‍🎨 artist painter | artiste peintre',
    '🧑‍🚀 astronaut space | astronaute espace',
    '🧑‍⚕️ health worker doctor nurse | sante medecin infirmier',
    '🧑‍🌾 farmer gardener | agriculteur jardinier',
    '🧑‍🔧 mechanic repair | mecanicien reparation',
    '🧑‍💼 office worker business | employe bureau affaires',
    '🦸 superhero hero | super heros',
    '🧙 mage wizard magic | mage magicien magie',
    '🧚 fairy | fee',
    '🧛 vampire | vampire',
    '🧜 merperson mermaid | sirene',
    '🧞 genie | genie',
    '🧘 yoga meditation lotus | yoga meditation',
    '🚶 walking walk | marcher marche',
    '🏃 running run | courir course',
    '💃 dancer dance salsa | danseuse danse',
    '🕺 dancing man disco | danseur disco',
    '👪 family | famille',
    '💑 couple love | couple amour',
    '🗣️ speaking head talk | tete qui parle discuter',
    '👤 silhouette user profile | silhouette utilisateur profil',
    '👥 silhouettes users group | silhouettes utilisateurs groupe'
  ],
  nature: [
    '🐶 dog puppy | chien chiot',
    '🐱 cat kitten | chat chaton',
    '🐭 mouse | souris',
    '🐹 hamster | hamster',
    '🐰 rabbit bunny | lapin',
    '🦊 fox | renard',
    '🐻 bear | ours',
    '🐼 panda | panda',
    '🐨 koala | koala',
    '🐯 tiger | tigre',
    '🦁 lion | lion',
    '🐮 cow | vache',
    '🐷 pig | cochon',
    '🐸 frog | grenouille',
    '🐵 monkey | singe',
    '🙈 see no evil monkey | singe qui ne voit rien',
    '🐔 chicken | poulet poule',
    '🐧 penguin | pingouin manchot',
    '🐦 bird | oiseau',
    '🐤 chick baby bird | poussin',
    '🦆 duck | canard',
    '🦉 owl wise | hibou chouette sage',
    '🦅 eagle | aigle',
    '🦇 bat | chauve souris',
    '🐺 wolf | loup',
    '🐴 horse | cheval',
    '🦄 unicorn magic | licorne magie',
    '🐝 bee honey | abeille miel',
    '🐛 bug caterpillar | chenille insecte',
    '🦋 butterfly | papillon',
    '🐌 snail slow | escargot lent',
    '🐞 ladybug beetle | coccinelle',
    '🐜 ant | fourmi',
    '🕷️ spider | araignee',
    '🐢 turtle slow | tortue lent',
    '🐍 snake | serpent',
    '🦎 lizard | lezard',
    '🐙 octopus | pieuvre poulpe',
    '🦑 squid | calmar',
    '🦀 crab | crabe',
    '🐠 tropical fish | poisson tropical',
    '🐟 fish | poisson',
    '🐬 dolphin | dauphin',
    '🐳 whale | baleine',
    '🦈 shark | requin',
    '🐊 crocodile | crocodile',
    '🐘 elephant | elephant',
    '🦒 giraffe | girafe',
    '🦓 zebra | zebre',
    '🐪 camel desert | chameau desert',
    '🐑 sheep | mouton',
    '🐐 goat | chevre',
    '🦌 deer | cerf',
    '🐿️ squirrel chipmunk | ecureuil',
    '🦔 hedgehog | herisson',
    '🐉 dragon | dragon',
    '🦖 t rex dinosaur | dinosaure tyrannosaure',
    '🐾 paw prints | pattes empreintes',
    '🌵 cactus desert | cactus desert',
    '🌲 evergreen tree pine forest | sapin foret',
    '🌳 tree deciduous | arbre',
    '🌴 palm tree beach island | palmier plage ile',
    '🌱 seedling sprout plant grow | pousse plante croissance',
    '🌿 herb leaf green | herbe feuille verte',
    '☘️ shamrock clover | trefle',
    '🍀 four leaf clover luck | trefle a quatre feuilles chance',
    '🍁 maple leaf autumn | feuille d erable automne',
    '🍂 fallen leaves autumn | feuilles mortes automne',
    '🍄 mushroom | champignon',
    '🌸 cherry blossom spring flower | cerisier fleur printemps',
    '🌹 rose flower love | rose fleur amour',
    '🌻 sunflower | tournesol',
    '🌷 tulip flower | tulipe fleur',
    '💐 bouquet flowers | bouquet fleurs',
    '🌞 sun face | soleil visage',
    '🌝 full moon face | pleine lune visage',
    '🌙 crescent moon night | croissant de lune nuit',
    '⭐ star | etoile',
    '🌟 glowing star sparkle | etoile brillante',
    '✨ sparkles magic new | etincelles magie nouveau',
    '⚡ lightning bolt energy fast | eclair energie rapide',
    '🔥 fire hot flame | feu chaud flamme',
    '💧 droplet water drop | goutte eau',
    '🌊 wave ocean sea surf | vague ocean mer',
    '☀️ sun sunny | soleil ensoleille',
    '⛅ partly cloudy | nuageux',
    '☁️ cloud | nuage',
    '🌧️ rain cloud | pluie nuage',
    '⛈️ thunderstorm | orage',
    '❄️ snowflake winter cold | flocon neige hiver froid',
    '⛄ snowman | bonhomme de neige',
    '🌈 rainbow | arc en ciel',
    '🌍 earth globe europe africa | terre globe europe afrique',
    '🌎 earth globe americas | terre globe ameriques',
    '🌏 earth globe asia | terre globe asie',
    '🪐 ringed planet saturn | planete saturne',
    '🌋 volcano | volcan',
    '⛰️ mountain | montagne',
    '🏔️ snow capped mountain | montagne enneigee',
    '🏝️ desert island | ile deserte',
    '🌅 sunrise | lever de soleil'
  ],
  food: [
    '🍎 red apple fruit | pomme rouge fruit',
    '🍏 green apple | pomme verte',
    '🍐 pear | poire',
    '🍊 orange tangerine | orange mandarine',
    '🍋 lemon | citron',
    '🍌 banana | banane',
    '🍉 watermelon | pasteque',
    '🍇 grapes wine | raisin',
    '🍓 strawberry | fraise',
    '🫐 blueberries | myrtilles',
    '🍒 cherries | cerises',
    '🍑 peach | peche',
    '🥭 mango | mangue',
    '🍍 pineapple | ananas',
    '🥥 coconut | noix de coco',
    '🥝 kiwi | kiwi',
    '🍅 tomato | tomate',
    '🥑 avocado | avocat',
    '🥕 carrot | carotte',
    '🌽 corn | mais',
    '🌶️ hot pepper chili spicy | piment epice',
    '🥦 broccoli | brocoli',
    '🥔 potato | pomme de terre',
    '🧄 garlic | ail',
    '🧅 onion | oignon',
    '🍞 bread | pain',
    '🥐 croissant | croissant',
    '🥖 baguette french bread | baguette pain',
    '🥨 pretzel | bretzel',
    '🧀 cheese | fromage',
    '🥚 egg | oeuf',
    '🍳 cooking frying pan egg | cuisiner poele oeuf',
    '🥞 pancakes | crepes pancakes',
    '🥓 bacon | bacon lard',
    '🍗 poultry leg chicken | cuisse de poulet',
    '🍖 meat bone | viande os',
    '🍔 hamburger burger | hamburger',
    '🍟 fries | frites',
    '🍕 pizza | pizza',
    '🌭 hot dog | hot dog',
    '🥪 sandwich | sandwich',
    '🌮 taco | taco',
    '🌯 burrito wrap | burrito wrap',
    '🥗 salad green | salade',
    '🍝 spaghetti pasta | spaghetti pates',
    '🍜 noodles ramen soup | nouilles ramen soupe',
    '🍲 stew pot food | ragout marmite',
    '🍣 sushi | sushi',
    '🍱 bento box | bento',
    '🍚 rice | riz',
    '🍦 ice cream soft | glace creme glacee',
    '🍰 cake slice | gateau part',
    '🎂 birthday cake | gateau d anniversaire',
    '🧁 cupcake | cupcake',
    '🍩 doughnut donut | beignet donut',
    '🍪 cookie biscuit | biscuit cookie',
    '🍫 chocolate | chocolat',
    '🍬 candy sweet | bonbon',
    '🍿 popcorn movie | popcorn pop corn cinema',
    '☕ coffee tea hot drink | cafe the boisson chaude',
    '🍵 tea green cup | the tasse',
    '🍺 beer | biere',
    '🍷 wine glass | vin verre',
    '🍸 cocktail | cocktail',
    '🥂 cheers clinking toast | sante trinquer champagne',
    '🧃 juice box | jus de fruit',
    '🥤 cup straw soda | gobelet soda',
    '🧊 ice cube | glacon'
  ],
  activities: [
    '⚽ soccer football | football foot',
    '🏀 basketball | basket',
    '🏈 american football | football americain',
    '⚾ baseball | baseball',
    '🎾 tennis | tennis',
    '🏐 volleyball | volley',
    '🏉 rugby | rugby',
    '🎱 pool billiards 8 ball | billard',
    '🏓 ping pong table tennis | ping pong tennis de table',
    '🏸 badminton | badminton',
    '🥊 boxing glove | boxe gant',
    '🥋 martial arts judo karate | arts martiaux judo karate',
    '⛳ golf flag | golf',
    '🏹 archery bow arrow | tir a l arc fleche',
    '🎣 fishing rod | peche canne',
    '🤿 diving scuba | plongee',
    '⛸️ ice skating | patinage sur glace',
    '🎿 ski | ski',
    '🏂 snowboard | snowboard',
    '🏋️ weight lifting gym fitness | haltere musculation sport',
    '🚴 cycling bike | velo cyclisme',
    '🏊 swimming | natation nager',
    '🧗 climbing | escalade',
    '🏆 trophy winner cup | trophee gagnant coupe',
    '🥇 gold medal first | medaille d or premier',
    '🥈 silver medal second | medaille d argent deuxieme',
    '🥉 bronze medal third | medaille de bronze troisieme',
    '🏅 sports medal | medaille sportive',
    '🎯 target bullseye dart goal | cible objectif fleche',
    '🎮 video game controller gaming | jeu video manette',
    '🕹️ joystick arcade | joystick arcade',
    '🎲 dice game | de jeu',
    '♟️ chess pawn strategy | echecs pion strategie',
    '🧩 puzzle piece | puzzle piece',
    '🎰 slot machine casino | machine a sous casino',
    '🎨 art palette paint | art palette peinture',
    '🖌️ paintbrush | pinceau',
    '🎭 theater drama masks | theatre masques',
    '🎬 clapper board movie film | clap cinema film',
    '🎤 microphone sing karaoke | micro chanter',
    '🎧 headphones music | casque ecouteurs musique',
    '🎵 music note | note de musique',
    '🎶 music notes | notes de musique',
    '🎹 piano keyboard | piano clavier',
    '🎸 guitar | guitare',
    '🎷 saxophone jazz | saxophone jazz',
    '🥁 drum | batterie tambour',
    '🎻 violin | violon',
    '🎺 trumpet | trompette',
    '📷 camera photo | appareil photo',
    '🎪 circus tent | cirque chapiteau',
    '🎉 party popper tada celebration | fete confettis celebration',
    '🎁 gift present | cadeau',
    '🎈 balloon | ballon',
    '🪁 kite | cerf volant'
  ],
  travel: [
    '🚗 car automobile | voiture auto',
    '🚕 taxi | taxi',
    '🚙 suv | suv',
    '🚌 bus | bus autobus',
    '🏎️ racing car | voiture de course',
    '🚓 police car | voiture de police',
    '🚑 ambulance | ambulance',
    '🚒 fire engine | pompiers camion',
    '🚚 delivery truck | camion livraison',
    '🚜 tractor | tracteur',
    '🏍️ motorcycle | moto',
    '🛵 scooter moped | scooter',
    '🚲 bicycle bike | velo bicyclette',
    '🛴 kick scooter | trottinette',
    '🚂 steam train locomotive | train locomotive',
    '🚄 high speed train | train a grande vitesse tgv',
    '🚇 metro subway | metro',
    '🚋 tram | tramway',
    '✈️ airplane plane flight | avion vol',
    '🛫 takeoff departure | decollage depart',
    '🛬 landing arrival | atterrissage arrivee',
    '🚁 helicopter | helicoptere',
    '🚀 rocket launch space startup | fusee lancement espace',
    '🛸 flying saucer ufo | soucoupe volante ovni',
    '🛰️ satellite | satellite',
    '⛵ sailboat | voilier',
    '🚤 speedboat | bateau rapide',
    '🛳️ passenger ship cruise | paquebot croisiere',
    '⚓ anchor | ancre',
    '🗺️ world map | carte du monde',
    '🧭 compass navigation | boussole navigation',
    '🏠 house home | maison domicile',
    '🏡 house garden | maison jardin',
    '🏢 office building | immeuble bureau',
    '🏫 school | ecole',
    '🏥 hospital | hopital',
    '🏦 bank | banque',
    '🏪 convenience store shop | magasin boutique',
    '🏬 department store | grand magasin',
    '🏭 factory industry | usine industrie',
    '🏛️ classical building museum | musee batiment antique',
    '🕌 mosque | mosquee',
    '⛪ church | eglise',
    '🏰 castle | chateau',
    '🏯 japanese castle | chateau japonais',
    '🗼 tokyo tower | tour de tokyo',
    '🗽 statue of liberty | statue de la liberte',
    '🗿 moai statue | statue moai',
    '⛺ tent camping | tente camping',
    '🏕️ camping | camping',
    '🌃 night city stars | nuit ville',
    '🌉 bridge night | pont nuit',
    '🎡 ferris wheel | grande roue',
    '🎢 roller coaster | montagnes russes',
    '🛖 hut | cabane',
    '🧳 luggage suitcase travel | valise bagage voyage',
    '⛲ fountain | fontaine',
    '🏖️ beach umbrella | plage parasol'
  ],
  objects: [
    '💼 briefcase work job | mallette travail emploi',
    '📁 folder file directory | dossier classeur',
    '📂 open folder | dossier ouvert',
    '🗂️ card index dividers | intercalaires',
    '📅 calendar date | calendrier date',
    '📆 tear off calendar | calendrier',
    '📋 clipboard list | presse papiers liste',
    '📌 pushpin pin | punaise epingle',
    '📍 round pushpin location | epingle lieu',
    '📎 paperclip attachment | trombone piece jointe',
    '📝 memo note writing | note ecrire memo',
    '✏️ pencil | crayon',
    '🖊️ pen | stylo',
    '📖 open book read | livre ouvert lire',
    '📚 books library study | livres bibliotheque etudes',
    '📓 notebook | carnet',
    '📰 newspaper news | journal actualites',
    '🔗 link chain url | lien chaine adresse',
    '🔖 bookmark | signet marque page',
    '🏷️ label tag | etiquette',
    '💻 laptop computer | ordinateur portable',
    '🖥️ desktop computer screen | ordinateur de bureau ecran',
    '⌨️ keyboard | clavier',
    '🖱️ computer mouse | souris d ordinateur',
    '🖨️ printer | imprimante',
    '📱 mobile phone smartphone | telephone portable smartphone',
    '☎️ telephone | telephone fixe',
    '📞 telephone receiver call | combine appel',
    '📧 email mail | e mail courriel',
    '📨 incoming envelope | enveloppe courrier',
    '📬 mailbox | boite aux lettres',
    '📦 package parcel box | colis paquet boite',
    '💡 light bulb idea | ampoule idee',
    '🔦 flashlight torch | lampe de poche',
    '🔋 battery | batterie pile',
    '🔌 electric plug power | prise electrique',
    '💰 money bag | sac d argent',
    '💵 dollar banknote cash | billet dollar',
    '💶 euro banknote | billet euro',
    '💳 credit card payment | carte bancaire paiement',
    '🧾 receipt invoice | recu facture',
    '📈 chart increasing growth | graphique hausse croissance',
    '📉 chart decreasing | graphique baisse',
    '📊 bar chart statistics | graphique en barres statistiques',
    '🔒 locked padlock security | verrouille cadenas securite',
    '🔓 unlocked | deverrouille',
    '🔑 key | cle',
    '🗝️ old key | vieille cle',
    '🔨 hammer tool | marteau outil',
    '🛠️ hammer and wrench tools build | outils marteau cle construire',
    '🔧 wrench | cle a molette',
    '🔩 nut and bolt | ecrou boulon',
    '⚙️ gear settings cog | engrenage reglages',
    '🧰 toolbox | boite a outils',
    '🧲 magnet | aimant',
    '🔬 microscope science | microscope science',
    '🔭 telescope | telescope',
    '🧪 test tube experiment chemistry | eprouvette experience chimie',
    '🧬 dna | adn',
    '💊 pill medicine | pilule medicament',
    '🩺 stethoscope doctor | stethoscope medecin',
    '🔍 magnifying glass search | loupe recherche',
    '🔔 bell notification | cloche notification',
    '🔕 bell muted silent | cloche muette silence',
    '📣 megaphone announcement | megaphone annonce',
    '🧹 broom cleaning | balai menage',
    '🧺 basket laundry | panier linge',
    '🛒 shopping cart | caddie courses panier',
    '🛍️ shopping bags | sacs de courses',
    '🕰️ mantelpiece clock | horloge',
    '⏰ alarm clock | reveil',
    '⏳ hourglass time | sablier temps',
    '📺 television tv | television tele',
    '📻 radio | radio',
    '🎥 movie camera | camera cinema',
    '📸 camera flash | appareil photo flash',
    '🪑 chair | chaise',
    '🛏️ bed sleep | lit dormir',
    '🛋️ couch lamp sofa | canape lampe',
    '🚿 shower | douche',
    '🪴 potted plant | plante en pot',
    '🧸 teddy bear toy | ours en peluche jouet'
  ],
  symbols: [
    '❤️ red heart love | coeur rouge amour',
    '🧡 orange heart | coeur orange',
    '💛 yellow heart | coeur jaune',
    '💚 green heart | coeur vert',
    '💙 blue heart | coeur bleu',
    '💜 purple heart | coeur violet',
    '🖤 black heart | coeur noir',
    '🤍 white heart | coeur blanc',
    '🤎 brown heart | coeur marron',
    '💔 broken heart | coeur brise',
    '💖 sparkling heart | coeur etincelant',
    '💝 heart ribbon gift | coeur cadeau ruban',
    '💯 hundred perfect score | cent points parfait',
    '💢 anger | colere',
    '💥 collision boom bang | collision explosion boum',
    '💫 dizzy stars | etourdissement etoiles',
    '💬 speech bubble chat message | bulle de discussion message',
    '💭 thought bubble | bulle de pensee',
    '✅ check mark done ok | coche fait valide',
    '❌ cross mark wrong no | croix faux non',
    '❓ question mark | point d interrogation',
    '❗ exclamation mark | point d exclamation',
    '⚠️ warning caution | avertissement attention',
    '🚫 prohibited forbidden | interdit',
    '⛔ no entry | sens interdit',
    '🔴 red circle | cercle rouge',
    '🟠 orange circle | cercle orange',
    '🟡 yellow circle | cercle jaune',
    '🟢 green circle | cercle vert',
    '🔵 blue circle | cercle bleu',
    '🟣 purple circle | cercle violet',
    '⚫ black circle | cercle noir',
    '⚪ white circle | cercle blanc',
    '🟥 red square | carre rouge',
    '🟧 orange square | carre orange',
    '🟨 yellow square | carre jaune',
    '🟩 green square | carre vert',
    '🟦 blue square | carre bleu',
    '🟪 purple square | carre violet',
    '⬛ black square | carre noir',
    '⬜ white square | carre blanc',
    '🔶 large orange diamond | grand losange orange',
    '🔷 large blue diamond | grand losange bleu',
    '♻️ recycling recycle | recyclage',
    '➕ plus add | plus ajouter',
    '➖ minus subtract | moins soustraire',
    '➗ divide | diviser',
    '✖️ multiply cross | multiplier',
    '🔁 repeat loop | repeter boucle',
    '🔄 counterclockwise arrows refresh sync | actualiser synchroniser fleches',
    '➡️ right arrow next | fleche droite suivant',
    '⬅️ left arrow back | fleche gauche retour',
    '⬆️ up arrow | fleche haut',
    '⬇️ down arrow | fleche bas',
    '🆕 new | nouveau',
    '🆒 cool | cool',
    '🆓 free | gratuit',
    '🔝 top arrow | haut',
    '💲 dollar sign money | signe dollar argent',
    '♾️ infinity | infini',
    '☮️ peace | paix',
    '☯️ yin yang | yin yang',
    '⚛️ atom symbol science | atome science',
    '🔱 trident emblem | trident embleme'
  ],
  flags: [
    '🏁 chequered flag race finish | drapeau a damier course arrivee',
    '🚩 triangular flag | drapeau triangulaire',
    '🎌 crossed flags | drapeaux croises',
    '🏳️ white flag | drapeau blanc',
    '🏳️‍🌈 rainbow flag pride | drapeau arc en ciel fierte',
    '🏴 black flag | drapeau noir',
    '🏴‍☠️ pirate flag | drapeau pirate',
    'FR france french | france francais',
    'BE belgium belgian | belgique belge',
    'CH switzerland swiss | suisse',
    'LU luxembourg | luxembourg',
    'CA canada canadian | canada canadien',
    'US united states usa american | etats unis usa americain',
    'MX mexico | mexique',
    'BR brazil | bresil',
    'AR argentina | argentine',
    'CL chile | chili',
    'CO colombia | colombie',
    'GB united kingdom uk british | royaume uni britannique',
    'IE ireland irish | irlande irlandais',
    'ES spain spanish | espagne espagnol',
    'PT portugal portuguese | portugal portugais',
    'IT italy italian | italie italien',
    'DE germany german | allemagne allemand',
    'NL netherlands dutch | pays bas hollande',
    'AT austria | autriche',
    'DK denmark | danemark',
    'NO norway | norvege',
    'SE sweden | suede',
    'FI finland | finlande',
    'IS iceland | islande',
    'PL poland | pologne',
    'CZ czechia czech | tchequie',
    'GR greece | grece',
    'TR turkey | turquie',
    'UA ukraine | ukraine',
    'RU russia | russie',
    'EU european union europe | union europeenne europe',
    'MA morocco | maroc',
    'DZ algeria | algerie',
    'TN tunisia | tunisie',
    'EG egypt | egypte',
    'SN senegal | senegal',
    'CI ivory coast | cote d ivoire',
    'ZA south africa | afrique du sud',
    'IL israel | israel',
    'IN india | inde',
    'CN china | chine',
    'JP japan japanese | japon japonais',
    'KR south korea | coree du sud',
    'VN vietnam | vietnam',
    'TH thailand | thailande',
    'AU australia | australie',
    'NZ new zealand | nouvelle zelande'
  ]
}

/** The category labels, in the language of the interface (the order of the keys is the order of the picker). */
const LABELS: Record<EmojiCategoryId, () => string> = {
  faces: () => t('space-emoji.visages-et-emotions'),
  people: () => t('space-emoji.gestes-et-personnes'),
  nature: () => t('space-emoji.animaux-et-nature'),
  food: () => t('space-emoji.nourriture-et-boissons'),
  activities: () => t('space-emoji.activites-et-loisirs'),
  travel: () => t('space-emoji.voyages-et-lieux'),
  objects: () => t('space-emoji.objets-et-outils'),
  symbols: () => t('space-emoji.symboles'),
  flags: () => t('space-emoji.drapeaux')
}

const REGIONAL_INDICATOR_A = 0x1f1e6

/** Lower case, without accents, with the ligatures of French spelt out: the form a word is compared in. */
export function normalizeWord(text: string): string {
  return text
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/œ/g, 'oe')
    .replace(/æ/g, 'ae')
}

function readRow(category: EmojiCategoryId, row: string): EmojiEntry {
  const [head = '', fr = ''] = row.split('|')
  const [first = '', ...english] = head.trim().split(/\s+/)
  // A flag of a country is written by its two letters; everything else is the emoji itself.
  const emoji = category === 'flags' && /^[A-Z]{2}$/.test(first) ? String.fromCodePoint(...[...first].map((letter) => REGIONAL_INDICATOR_A + letter.charCodeAt(0) - 65)) : first
  const words = (list: readonly string[]): string[] => [...new Set(list.map(normalizeWord).filter((word) => word !== ''))]
  const en = words(english)
  const french = words(fr.trim().split(/\s+/))
  return { emoji, en, fr: french, keywords: [...new Set([...en, ...french])] }
}

const CATEGORY_ORDER: readonly EmojiCategoryId[] = ['faces', 'people', 'nature', 'food', 'activities', 'travel', 'objects', 'symbols', 'flags']
const entriesOf = (id: EmojiCategoryId): readonly EmojiEntry[] => ROWS[id].map((row) => readRow(id, row))
const ENTRIES: Record<EmojiCategoryId, readonly EmojiEntry[]> = {
  faces: entriesOf('faces'),
  people: entriesOf('people'),
  nature: entriesOf('nature'),
  food: entriesOf('food'),
  activities: entriesOf('activities'),
  travel: entriesOf('travel'),
  objects: entriesOf('objects'),
  symbols: entriesOf('symbols'),
  flags: entriesOf('flags')
}

/** The categories, in the order a picker shows them, with their names in the language of the interface (read when asked: the language can change). */
export function emojiCategories(): EmojiCategory[] {
  return CATEGORY_ORDER.map((id) => ({ id, label: LABELS[id](), emojis: ENTRIES[id] }))
}

/** Every emoji of the catalogue, category after category. */
export const ALL_EMOJIS: readonly EmojiEntry[] = CATEGORY_ORDER.flatMap((id) => ENTRIES[id])

// ---------- the search ----------

export const EMOJI_SEARCH_LIMIT = 80
const QUERY_MAX_CHARS = 64
const QUERY_MAX_TOKENS = 5
/** A word is looked for inside another one only from this length on: "ball" finds "football", "e" does not find everything. */
const INSIDE_MIN_CHARS = 3

/** How well a word of the query matches the keywords of an entry: 3 the word itself, 2 the start of a keyword, 1 inside one, 0 not at all. */
function tokenScore(token: string, keywords: readonly string[]): number {
  let best = 0
  for (const keyword of keywords) {
    if (keyword === token) return 3
    if (keyword.startsWith(token)) best = Math.max(best, 2)
    else if (token.length >= INSIDE_MIN_CHARS && keyword.includes(token)) best = Math.max(best, 1)
  }
  return best
}

/**
 * The emoji that answer a search, best first. Each word of the query must match a keyword (in French or in English, accents and case ignored);
 * a keyword that is the word itself comes before one that starts with it, which comes before one that only contains it, and between equals the
 * catalogue's order stands. Typing an emoji of the catalogue finds it. A blank query finds nothing: the caller shows its categories then.
 */
export function searchEmojis(query: string, limit = EMOJI_SEARCH_LIMIT): EmojiEntry[] {
  if (typeof query !== 'string') return []
  const wanted = Math.max(1, Math.min(1000, Math.floor(Number.isFinite(limit) ? limit : EMOJI_SEARCH_LIMIT)))
  const text = query.trim().slice(0, QUERY_MAX_CHARS)
  if (text === '') return []
  const typed = ALL_EMOJIS.find((entry) => entry.emoji === text)
  if (typed) return [typed]
  const tokens = normalizeWord(text).split(/[\s,;.:/+-]+/).filter((token) => token !== '').slice(0, QUERY_MAX_TOKENS)
  if (tokens.length === 0) return []
  const scored: Array<{ entry: EmojiEntry; score: number; order: number }> = []
  ALL_EMOJIS.forEach((entry, order) => {
    let score = 0
    for (const token of tokens) {
      const one = tokenScore(token, entry.keywords)
      if (one === 0) return
      score += one
    }
    scored.push({ entry, score, order })
  })
  return scored.sort((a, b) => b.score - a.score || a.order - b.order).slice(0, wanted).map((hit) => hit.entry)
}

// ---------- the value that is stored ----------

/** The most a stored emoji may hold: the limit the state already puts on this field (32 UTF-16 units; the longest emoji sequences have 15). */
export const SPACE_EMOJI_MAX_UNITS = 32

/** The two-letter regions that have a flag: ISO 3166-1, and the few extras that have one (Ascension, EU, UN, Kosovo…). A pair of other letters is not a flag. */
const FLAG_REGIONS = new Set(
  'AC AD AE AF AG AI AL AM AO AQ AR AS AT AU AW AX AZ BA BB BD BE BF BG BH BI BJ BL BM BN BO BQ BR BS BT BV BW BY BZ CA CC CD CF CG CH CI CK CL CM CN CO CP CR CU CV CW CX CY CZ DE DG DJ DK DM DO DZ EA EC EE EG EH ER ES ET EU FI FJ FK FM FO FR GA GB GD GE GF GG GH GI GL GM GN GP GQ GR GS GT GU GW GY HK HM HN HR HT HU IC ID IE IL IM IN IO IQ IR IS IT JE JM JO JP KE KG KH KI KM KN KP KR KW KY KZ LA LB LC LI LK LR LS LT LU LV LY MA MC MD ME MF MG MH MK ML MM MN MO MP MQ MR MS MT MU MV MW MX MY MZ NA NC NE NF NG NI NL NO NP NR NU NZ OM PA PE PF PG PH PK PL PM PN PR PS PT PW PY QA RE RO RS RU RW SA SB SC SD SE SG SH SI SJ SK SL SM SN SO SR SS ST SV SX SY SZ TA TC TD TF TG TH TJ TK TL TM TN TO TR TT TV TW TZ UA UG UM UN US UY UZ VA VC VE VG VI VN VU WF WS XK YE YT ZA ZM ZW'.split(' ')
)

/** The three flags of a region of a country that are emoji: England, Scotland, Wales (a black flag, the tag letters of the region, a cancel tag). */
const tagged = (code: string): string => `\u{1F3F4}${[...code].map((c) => String.fromCodePoint(0xe0000 + c.charCodeAt(0))).join('')}\u{E007F}`
const SUBDIVISION_FLAGS = new Set([tagged('gbeng'), tagged('gbsct'), tagged('gbwls')])

const SKIN_TONE = String.raw`[\u{1F3FB}-\u{1F3FF}]`
const NOT_REGIONAL_NOR_TONE = String.raw`(?![\u{1F1E6}-\u{1F1FF}\u{1F3FB}-\u{1F3FF}])`
/** A pictograph that shows as an emoji by itself (U+FE0F after it changes nothing, and is often typed), or a text-default one asked to by U+FE0F. Not a letter, a digit, a regional letter or a bare skin tone. */
const SHOWN = String.raw`(?:${NOT_REGIONAL_NOR_TONE}\p{Emoji_Presentation}\u{FE0F}?|\p{Extended_Pictographic}\u{FE0F})`
/** One emoji, with a skin tone when it takes one. */
const SINGLE = String.raw`(?:\p{Emoji_Modifier_Base}${SKIN_TONE}|${SHOWN})`
/** A part of a sequence joined by zero-width joiners: the variation selector may be left out there (🏳‍🌈 is written both ways). */
const PART = String.raw`\p{Extended_Pictographic}\u{FE0F}?(?:${SKIN_TONE})?`
const JOINED = new RegExp(String.raw`^(?=[^]*(?:\p{Emoji_Presentation}|\u{FE0F}))${PART}(?:\u{200D}${PART}){1,4}$`, 'u')
const SINGLE_ONLY = new RegExp(`^${SINGLE}$`, 'u')
const KEYCAP = /^[0-9#*]\u{FE0F}?\u{20E3}$/u
const REGIONAL_PAIR = /^([\u{1F1E6}-\u{1F1FF}])([\u{1F1E6}-\u{1F1FF}])$/u

/**
 * Whether a value can be the emoji of a space: one string that is exactly one emoji. That is a pictograph (with its U+FE0F when it needs one to
 * show as an emoji, and a skin tone when it takes one), a flag (two regional letters of a region that has a flag, or one of the three tagged
 * flags), a keycap, or a few of these joined by zero-width joiners (👩‍💻, 👨‍👩‍👧‍👦, 🏳️‍🌈). Not: text, a letter, a digit or a symbol on its own that shows as text,
 * the text-style selector U+FE0E, several emoji side by side, a joiner at either end or doubled, a mark that combines, spaces around, an empty string.
 */
export function isSpaceEmoji(value: unknown): value is string {
  if (typeof value !== 'string' || value === '' || value.length > SPACE_EMOJI_MAX_UNITS) return false
  const pair = REGIONAL_PAIR.exec(value)
  if (pair) return FLAG_REGIONS.has(String.fromCharCode(...[...pair[0]!].map((letter) => 65 + letter.codePointAt(0)! - REGIONAL_INDICATOR_A)))
  return SUBDIVISION_FLAGS.has(value) || KEYCAP.test(value) || SINGLE_ONLY.test(value) || JOINED.test(value)
}

/** One letter of any alphabet or one digit, as one code point. A character that draws nothing (a Hangul filler is a letter) is none. */
const ONE_LETTER_OR_DIGIT = /^(?!\p{Default_Ignorable_Code_Point})[\p{L}\p{Nd}]$/u

/**
 * Whether a value is one letter or one digit: what a person types to mark a space with an initial or a number instead of a picture. An accented
 * letter written as a letter and its accent counts as the one letter it draws. Not: two characters, a symbol, a punctuation mark, a space.
 */
export function isSpaceLetter(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 4 && ONE_LETTER_OR_DIGIT.test(value.normalize('NFC'))
}

/** Whether a value can be the mark of a space: exactly one emoji, or one letter, or one digit. */
export function isSpaceMark(value: unknown): value is string {
  return isSpaceEmoji(value) || isSpaceLetter(value)
}

/** The mark a space keeps of what a file, an import or the interface hands over: the value when it is one emoji, one letter or one digit (a letter in its composed form), `fallback` otherwise. */
export const spaceEmojiOr = (value: unknown, fallback: string): string => (isSpaceEmoji(value) ? value : isSpaceLetter(value) ? value.normalize('NFC') : fallback)
