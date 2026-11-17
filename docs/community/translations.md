# Translations

## Where we are

**The interface can be shown in English; the mechanism is in place.** Texts are looked up by key in a catalogue (`src/shared/i18n.ts`): French (`i18n-fr.ts`) is the language of origin and holds the original texts, typed with ordinary spaces (the non-breaking spaces of French typography are put in when a text is read: `src/shared/french-typography.ts`), English (`i18n-en.ts`) has exactly the same keys. The language follows macOS by default: French when the system is in French, English otherwise (Settings › Start here › Language, "Automatic (system language)"; choosing Français or English fixes it). A text with no translation is shown in French. A test fails when a catalogue has a key more or less than the French one, or different `{variables}`.

**Covered so far**: the two catalogues have the same keys, and the whole interface reads them: menus, sidebar, toolbar, command bar, panels and every pane of the Settings window (`src/main/settings-text-scan.ts` lists the panes still pending: none today). **Not translated**: what the user or a page wrote (names of Spaces, tabs and folders, the pages themselves), the technical documentation that Help › Lucium Documentation opens (it stays in French; Help › Getting Started opens the README in the language of the interface), and the error messages of the system or of the engine, quoted as they are inside a translated sentence.

## Adding a language

1. Copy `src/shared/i18n-en.ts` to `src/shared/i18n-<code>.ts` and translate the values (keep the keys and the `{variables}`; a count is a pair `key.one` / `key.other`).
2. Register it in `src/shared/i18n.ts` (`LANGUAGES`, `CATALOGUES`, `LANGUAGE_NAMES`, the setting and its menu) and in `i18n.test.ts`: the test then checks your catalogue against the French one.
3. A second speaker of the language reviews it. Translate our texts; do not copy another browser's strings (see the [no-reuse rule](../../CONTRIBUTING.md#the-no-reuse-rule)).

Texts that are not in a catalogue yet are still French in the code: please open a discussion before converting a whole file, so that two people do not do the same one.

## Writing new text

New user-visible text goes in the catalogues from the start (`t('area.key')`, French first, then English), as whole sentences, with no sentence built from pieces whose order depends on grammar and no text in images.

## What you can already translate

- **Documentation**: English versions of the French documents in `docs/` are welcome (a pull request adding `docs/en/<name>.md`, or a discussion to agree on the layout first). Keep the technical terms and file names as they are.
- **The README** in other languages: `README.<language code>.md`, kept in step with `README.md`. Tell us in a discussion first, so that the translation has someone to keep it up to date.

## Still to write

A glossary of terms (the names of features, such as "Glance" or "Tweaks", and the word each language gives them), and how translations are credited.
