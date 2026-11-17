# Polices embarquées dans Lucium (Retouches)

Dix polices variables, sous licence **SIL Open Font License 1.1** (texte en bas de ce fichier), embarquées pour que les Retouches puissent les appliquer aux pages sans rien télécharger ni passer par un service tiers. Les fichiers `.woff2` sont les sous-ensembles « latin » (axe de graisse) distribués par [Fontsource](https://fontsource.org) (`cdn.jsdelivr.net/fontsource/fonts/<police>:vf@latest/latin-wght-normal.woff2`), entrés dans le dépôt le 1er novembre 2026 ; les contours des glyphes ne sont pas modifiés. Aucune de ces polices ne déclare de « Reserved Font Name » (relu le 10 novembre 2026 dans le fichier de licence de chaque dépôt amont, voir `docs/licences-tierces.md`).

## Droits d'auteur

La mention est celle que porte chaque fichier (table `name`, identifiant 0).

| Fichier | Police | Droits d'auteur |
|---|---|---|
| `inter.woff2` | Inter | Copyright 2016 The Inter Project Authors (https://github.com/rsms/inter) |
| `hanken-grotesk.woff2` | Hanken Grotesk | Copyright 2021 The Hanken Grotesk Project Authors (https://github.com/marcologous/hanken-grotesk) |
| `manrope.woff2` | Manrope | Copyright 2019 The Manrope Project Authors (https://github.com/sharanda/manrope) |
| `figtree.woff2` | Figtree | Copyright 2022 The Figtree Project Authors (https://github.com/erikdkennedy/figtree) |
| `space-grotesk.woff2` | Space Grotesk | Copyright 2020 The Space Grotesk Project Authors (https://github.com/floriankarsten/space-grotesk) |
| `fraunces.woff2` | Fraunces | Copyright 2020 The Fraunces Project Authors (github.com/undercasetype/Fraunces) |
| `literata.woff2` | Literata | Copyright 2017 The Literata Project Authors (https://github.com/googlefonts/literata) |
| `bodoni-moda.woff2` | Bodoni Moda | Copyright 2020 The Bodoni Moda Project Authors (https://github.com/indestructible-type/Bodoni) |
| `jetbrains-mono.woff2` | JetBrains Mono | Copyright 2020 The JetBrains Mono Project Authors (https://github.com/JetBrains/JetBrainsMono) |
| `atkinson-hyperlegible-next.woff2` | Atkinson Hyperlegible Next | Copyright 2020-2024 The Atkinson Hyperlegible Next Project Authors (https://github.com/googlefonts/atkinson-hyperlegible-next) |

## Version et empreinte de chaque fichier

L'adresse d'origine disait `@latest` : la version du paquet Fontsource n'a pas été notée. Ce tableau épingle ce que le dépôt contient. La version est celle que la police déclare dans le fichier (table `name`, identifiant 5). Le test `src/main/font-files.test.ts` compare chaque fichier à sa ligne : pour remplacer ou mettre à jour une police, refaire sa ligne (`shasum -a 256 resources/fonts/<fichier>`).

| Fichier | Version déclarée | Taille (octets) | SHA-256 |
|---|---|---|---|
| `inter.woff2` | Version 4.001;git-66647c0bb | 48256 | `3100e775e8616cd2611beecfa23a4263d7037586789b43f035236a2e6fbd4c62` |
| `hanken-grotesk.woff2` | Version 3.013 | 34704 | `e9201eddf1d41d0b62253295d869ce3cf65768f7102b797f02c7f8c876b4a9d5` |
| `manrope.woff2` | Version 4.504 | 24836 | `a30ddcd349703aff7464c34bef3fffdff405ee50c113440d7c8693c02d210972` |
| `figtree.woff2` | Version 2.002 | 20156 | `4ba7d3d096695818fe0686be4f1e82c6b05134e18a22260336130335027462dd` |
| `space-grotesk.woff2` | Version 2.000 | 22288 | `0640890476fc1198ab4de571fb658de443c4d85b66466ec09534a8737ab1ce9d` |
| `fraunces.woff2` | Version 1.000;[b76b70a41] | 36620 | `7f9d191d999336d3b9790afa72e1358e50a13b06d4f289341e92a311967a80f9` |
| `literata.woff2` | Version 3.103;gftools[0.9.29] | 52496 | `9adbeac5b167fe5ad6c49d9e29aa0c76e2f1bb3b46bf4ebf12a9eca7d3525384` |
| `bodoni-moda.woff2` | Version 2.005 | 25884 | `192ae876c21d9258d096a526dad5bddf37f0daa69cfe943cae5f6be5a52adda2` |
| `jetbrains-mono.woff2` | Version 2.211 | 40404 | `18be452724bfdc236c074ca94a249a7f41a86752c7d04ab258ce9ed5651f6a7e` |
| `atkinson-hyperlegible-next.woff2` | Version 2.001 | 33996 | `18b2a1a39a2fa298b0ba5390aca68462669826c90925656f1c1f6796e0e1bbaf` |

## SIL Open Font License, Version 1.1

```text
-----------------------------------------------------------
SIL OPEN FONT LICENSE Version 1.1 - 26 February 2007
-----------------------------------------------------------

PREAMBLE
The goals of the Open Font License (OFL) are to stimulate worldwide
development of collaborative font projects, to support the font creation
efforts of academic and linguistic communities, and to provide a free and
open framework in which fonts may be shared and improved in partnership
with others.

The OFL allows the licensed fonts to be used, studied, modified and
redistributed freely as long as they are not sold by themselves. The
fonts, including any derivative works, can be bundled, embedded,
redistributed and/or sold with any software provided that any reserved
names are not used by derivative works. The fonts and derivatives,
however, cannot be released under any other type of license. The
requirement for fonts to remain under this license does not apply
to any document created using the fonts or their derivatives.

DEFINITIONS
"Font Software" refers to the set of files released by the Copyright
Holder(s) under this license and clearly marked as such. This may
include source files, build scripts and documentation.

"Reserved Font Name" refers to any names specified as such after the
copyright statement(s).

"Original Version" refers to the collection of Font Software components as
distributed by the Copyright Holder(s).

"Modified Version" refers to any derivative made by adding to, deleting,
or substituting -- in part or in whole -- any of the components of the
Original Version, by changing formats or by porting the Font Software to a
new environment.

"Author" refers to any designer, engineer, programmer, technical
writer or other person who contributed to the Font Software.

PERMISSION & CONDITIONS
Permission is hereby granted, free of charge, to any person obtaining
a copy of the Font Software, to use, study, copy, merge, embed, modify,
redistribute, and sell modified and unmodified copies of the Font
Software, subject to the following conditions:

1) Neither the Font Software nor any of its individual components,
in Original or Modified Versions, may be sold by itself.

2) Original or Modified Versions of the Font Software may be bundled,
redistributed and/or sold with any software, provided that each copy
contains the above copyright notice and this license. These can be
included either as stand-alone text files, human-readable headers or
in the appropriate machine-readable metadata fields within text or
binary files as long as those fields can be easily viewed by the user.

3) No Modified Version of the Font Software may use the Reserved Font
Name(s) unless explicit written permission is granted by the corresponding
Copyright Holder. This restriction only applies to the primary font name as
presented to the users.

4) The name(s) of the Copyright Holder(s) or the Author(s) of the Font
Software shall not be used to promote, endorse or advertise any
Modified Version, except to acknowledge the contribution(s) of the
Copyright Holder(s) and the Author(s) or with their explicit written
permission.

5) The Font Software, modified or unmodified, in part or in whole,
must be distributed entirely under this license, and must not be
distributed under any other license. The requirement for fonts to
remain under this license does not apply to any document created
using the Font Software.

TERMINATION
This license becomes null and void if any of the above conditions are
not met.

DISCLAIMER
THE FONT SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND,
EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO ANY WARRANTIES OF
MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT
OF COPYRIGHT, PATENT, TRADEMARK, OR OTHER RIGHT. IN NO EVENT SHALL THE
COPYRIGHT HOLDER BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY,
INCLUDING ANY GENERAL, SPECIAL, INDIRECT, INCIDENTAL, OR CONSEQUENTIAL
DAMAGES, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING
FROM, OUT OF THE USE OR INABILITY TO USE THE FONT SOFTWARE OR FROM
OTHER DEALINGS IN THE FONT SOFTWARE.
```
