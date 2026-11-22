# Security policy

Lucium is a web browser: a vulnerability can expose the people who use it. Reports are taken seriously, and you are asked to make them **privately**.

Français : pour signaler une faille, n'ouvrez pas d'issue publique. Écrivez à contact@lucium.app (commencez le sujet par `[security]`), ou utilisez le signalement privé de GitHub (onglet *Security* du dépôt public, *Report a vulnerability*). Vous pouvez écrire en français. Seule la dernière version publiée reçoit les correctifs : le tableau ci-dessous dit laquelle (les versions 0.2.x, 1.0.0, 1.0.1, 1.1.0, 1.1.1, 1.1.2, 1.1.3, 1.1.4 et 1.1.5 ne sont plus corrigées).

## Supported versions

Fixes are made on `main` and released in the next version; **older releases are not patched**: there is no maintenance branch ([release process](docs/community/release-process.md)). The published application is signed with a Developer ID and notarized by Apple, and updates itself from the feed of lucium.app after your click: the latest release is the one that feed offers.

| Version | Supported |
|---|---|
| 1.1.6, the latest release | yes |
| `main` | yes, fixes are written there before they are released |
| 1.1.5 | no, update to the latest release |
| 1.1.4 | no, update to the latest release |
| 1.1.3 | no, update to the latest release |
| 1.1.2 | no, update to the latest release |
| 1.1.1 | no, update to the latest release |
| 1.1.0 | no, update to the latest release |
| 1.0.1 | no, update to the latest release: it has a flaw in the temporary access given to an extension by `activeTab`, fixed in 1.1.0 only ([CHANGELOG](CHANGELOG.md), version 1.1.0) |
| 1.0.0 | no, update to the latest release |
| 0.2.x | no: published before the rename, never patched again. The latest release starts a new profile and does not read the data of a 0.2.x ([CHANGELOG](CHANGELOG.md), version 1.0.0) |

The maintainer updates this table with each release.

## How to report a vulnerability

Do **not** open a public issue, discussion or pull request for a security problem.

1. Write to **contact@lucium.app** and start the subject with `[security]`, so that it is read first. Do not put the details of an exploit in the subject line.
2. Or use GitHub's private reporting, on the public repository: open the **Security** tab, then **Report a vulnerability** ([direct link](https://github.com/pOwn3d/Lucium/security/advisories/new)).

Both reach the same person: Lucium has one maintainer ([GOVERNANCE.md](GOVERNANCE.md)), who reads the reports and writes the fixes.

Please include:

- the Lucium version (tag or commit), macOS version and chip;
- what the problem is and what an attacker gains (read a file, run code, reach another site's data, bypass a permission...);
- the steps to reproduce, ideally with a small proof of concept (a test page, an extension manifest, a crafted file);
- whether you have shared the problem with anyone else, and any deadline you work under.

If you need to send sensitive material and want it encrypted, say so in a first short message and a way will be arranged. The project publishes no PGP key at the moment.

## What to expect

Lucium is maintained by one person, in their free time. These are **targets, not guarantees**:

- acknowledgement of your report within **7 days**;
- a first assessment (confirmed, need more information, or not a vulnerability) within **14 days**;
- news at least every **30 days** until it is resolved;
- a fix as soon as practical, in order of severity; the aim is to publish within **90 days** of the report, on a date agreed with you. A fix may be delayed a little rather than shipped bad; you are told why.

When the problem is fixed, a **GitHub Security Advisory** is published and the fix is mentioned in the [CHANGELOG](CHANGELOG.md); you are credited by name or handle unless you prefer to stay anonymous. A CVE can be requested through GitHub when it makes sense.

There is **no bug bounty** program. What the project can offer is a credit and its thanks.

## Scope

In scope, the code of this repository and what it ships:

- the **interface surfaces** (sidebar, overlay panels, Settings window, mini windows, task manager) and the trust between them and the main process: IPC channels, sender checks, anything a web page or a renderer could use to reach the main process or other surfaces;
- the **extension compatibility layer**: permission checks of the `chrome.*` APIs Lucium provides (`debugger`, `cookies`, `tabs`, `downloads`, `identity`, `sidePanel`, native messaging...), isolation between extensions and between profiles;
- **navigation and URL handling**: what a page, an extension or an imported file may open (`file:`, `data:`, internal pages), link routing, the default-browser handler;
- **imports** from other browsers: parsing of files and databases that may be malformed or hostile;
- **shared Tweaks and themes** (files and links): the size limit, the field checks, the CSS check (nothing may load another file), the site a Tweak may target, and the rule that a script that comes in is stored switched off until its owner has read and enabled it;
- the **state file** and other files read at start-up: loading a modified or corrupted file;
- **web permissions**, certificate exceptions and error pages, HTTP authentication, site-data clearing (it must never reach another site's data), the private window (nothing written to disk);
- the **blocker and its list downloads**, the **reader mode** document, and the **update check**;
- the **page summary by a local model** (`src/shared/ollama.ts`, `src/shared/summary-prompt.ts`, `src/shared/summary-html.ts`): the rule that the page text only goes to Ollama at an address of the user's own computer (a loopback address, no redirect followed), what the model is given (the page text and the page address without its query and fragment), and the display of the model's answer (no HTML of the model is interpreted);
- the **packaging and the publication**: Electron fuses, what the build contains, the signature and the notarization of the published application, the update feed and what an installed copy accepts from it, the scripts that build and publish (`scripts/`) and the workflows (`.github/workflows/`).

Out of scope:

- vulnerabilities in **Chromium or Electron themselves**: report them to the Chromium or Electron projects. Do report a published fix that has not reached Lucium yet (the Electron version it ships is in `package.json`), because that one is the project's;
- a **third-party extension's** own bugs, or what an extension you chose to install does within the permissions you granted it;
- the Gatekeeper warning on the first launch of a **standard build you made yourself** from the sources: that build is unsigned, the [README](README.md) says so. The published application is signed and notarized: a Gatekeeper warning on it **is** worth a report;
- attacks that need a machine that is already compromised, physical access to an unlocked session, or modified builds;
- findings from automated scanners without a demonstrated impact, missing hardening headers on websites, social engineering, denial of service by a page that merely uses a lot of memory;
- the **filter lists** (EasyList, uBlock...): report their content problems to their maintainers.

Please act in good faith: test on your own installation and your own data, do not access other people's data, and leave time to fix the problem before you disclose it.
