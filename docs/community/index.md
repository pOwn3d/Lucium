# Community

Lucium is a free browser with one maintainer, open to whoever wants to help. This page is the map.

## Ways to contribute

You do not have to write code.

| You can... | How |
|---|---|
| Use it and report what breaks | Issue form *Bug report*. Only macOS on Apple silicon is tested: reports from other setups are valuable |
| Say where the interface falls short | The issue form *Missing from your previous browser*, with measurements when you can ([how to measure](../../CONTRIBUTING.md#measuring-a-browser-without-touching-your-data)) |
| Propose a feature | Issue form *Feature request*, or a Discussion for a rough idea. Read [what is out of scope](../../CONTRIBUTING.md#what-is-out-of-scope-by-decision) first |
| Fix a bug or build a feature | Fork, branch, pull request ([how](../../CONTRIBUTING.md#how-the-collaboration-works)). With a coding assistant: [AGENTS.md](../../AGENTS.md) |
| Improve the documentation | Pull request. Most of `docs/` is in French; English translations are welcome |
| Review pull requests | Comment on open pull requests; a second pair of eyes helps the maintainer, who is alone to review |
| Test extensions | Try your extensions and report what works or not, with the extension name and version |
| Translate | The interface is in French and in English, read from two catalogues: improve a text, or add a language ([translations.md](translations.md)) |

## Where to talk

- **[Discussions](https://github.com/pOwn3d/Lucium/discussions)**: questions, ideas, show and tell. English or French.
- **[Issues](https://github.com/pOwn3d/Lucium/issues)**: bugs, concrete feature requests, interface gaps. One topic per issue.
- **Pull requests**: the place to discuss a concrete change.
- Security: never in public. Write to contact@lucium.app, see [SECURITY.md](../../SECURITY.md).
- Conduct: contact@lucium.app, see [CODE_OF_CONDUCT.md](../../CODE_OF_CONDUCT.md).

There is no chat server or mailing list at the moment. If one is created it will be announced in the README.

## The rules of the game

- [CODE_OF_CONDUCT.md](../../CODE_OF_CONDUCT.md): be kind, be constructive.
- [CONTRIBUTING.md](../../CONTRIBUTING.md) ([en français](../../CONTRIBUTING.fr.md)): the conventions, the checks, the no-reuse rule.
- [GOVERNANCE.md](../../GOVERNANCE.md) ([en français](../../GOVERNANCE.fr.md)): who decides, the rules of `main` (every change by pull request, the maintainer's included) and the principles (free, no AI assistant, no account, no telemetry).
- [AGENTS.md](../../AGENTS.md): the rules for a coding assistant that contributes.
- [NOTICE](../../NOTICE) and [TRADEMARKS.md](../../TRADEMARKS.md) ([en français](../../TRADEMARKS.fr.md)): who holds the copyright, and what the license does not cover (the name and the logo).
- [SUPPORT.md](../../SUPPORT.md): where to ask what.

## For maintainers

- [maintainers.md](maintainers.md): reviewing, merging, response times, repository settings.
- [public-repository.md](public-repository.md): how the public repository was made from one commit, and what was checked before.
- [release-process.md](release-process.md): how a version is published, where it is downloaded from, and how it is signed and notarized. The maintainer alone builds and publishes.
- [homebrew.md](homebrew.md): the Homebrew cask, made from the published disk image, and the project's tap (not created yet).

## Reading the project

The documents of `docs/` (in French) explain how it works: the [index](../README.md), [architecture](../architecture.md), [features](../fonctions.md), [roadmap](../roadmap.md), [third-party licenses](../licences-tierces.md) and [extension compatibility](../compat-extension-claude.md).
