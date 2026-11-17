# Getting help

Lucium is a free project with one maintainer. Help comes from other users and from the maintainer, in their free time, so there is no guaranteed response time and no commercial support.

English · Français : vous pouvez écrire dans les deux langues.

| You want to... | Go to |
|---|---|
| Ask how to do something, ask if a behavior is expected, discuss an idea | [Discussions](https://github.com/pOwn3d/Lucium/discussions) |
| Report a bug | [Issues](https://github.com/pOwn3d/Lucium/issues/new/choose), form *Bug report* |
| Report something missing from your previous browser | [Issues](https://github.com/pOwn3d/Lucium/issues/new/choose), form *Missing from your previous browser* |
| Ask for a feature | [Issues](https://github.com/pOwn3d/Lucium/issues/new/choose), form *Feature request* (read what is out of scope first) |
| Do one of the three above without a GitHub account, or support a request already made | The community page of the site: [lucium.app/en/community/](https://lucium.app/en/community/) (en français : [lucium.app/communaute/](https://lucium.app/communaute/)). A request sent there stays private until the maintainer has read it, then it is published on the site and, when that link is set up, as a GitHub issue. Supporting one asks for a code sent to your e-mail address, which is never published. |
| Report a security problem | **Not in public.** Write to contact@lucium.app, subject starting with `[security]`: see [SECURITY.md](SECURITY.md) |
| Report a conduct problem | Write to contact@lucium.app, subject starting with `[conduct]`: see [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md) |
| Help with the code or the docs | [CONTRIBUTING.md](CONTRIBUTING.md) |

## If Lucium quits unexpectedly

Lucium has no crash reporter and sends nothing when it crashes: this is part of "no telemetry". The only trace is the report macOS writes on your Mac, and "Report a Problem…" does not include it.

- Open the **Console** application, then **Crash Reports**, or the folder `~/Library/Logs/DiagnosticReports/` in the Finder. The reports are named `Lucium-<date>.ips`, or `Lucium Helper (Renderer)-<date>.ips` when a page crashed and not the whole application.
- Read the report before you attach it to a bug report: it holds the name of your account in the paths of the files, the version of macOS and the list of the libraries loaded. It is not meant to hold a tab, an address or the content of a page, but you are the one who decides what you share.
- Say what you were doing just before, and whether it happens again.

Before you ask:

- The [README](README.md) covers installing the download, which is signed and notarized, building from the sources (a build you make yourself is unsigned: the README says how to open it the first time), and the shortcuts.
- [docs/fonctions.md](docs/fonctions.md) lists what Lucium does today, each function with its setting; [docs/roadmap.md](docs/roadmap.md) says what is planned, what is excluded and what is impossible in Electron (both in French). What is left to do is tracked in the [issues](https://github.com/pOwn3d/Lucium/issues).
- Search the existing issues and discussions.

Only macOS on Apple silicon is tested. The download is a disk image at https://lucium.app/en/download/, signed with a Developer ID and notarized by Apple; lucium.app is the only place the project publishes the application. Please do not share personal data (tab titles, addresses, accounts, screenshots of your windows) in public messages, requests or attachments.
