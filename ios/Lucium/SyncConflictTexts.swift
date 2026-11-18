import Foundation
import LuciumKit

/// The words of « Conflit réglé » (docs/synchronisation.md §13.4). `SyncConflicts.view(of:)` (LuciumKit) tells a conflict as sentences: keys of the Mac's
/// catalogue (`sync-conflict.*`) and the words to put in them, the same on both devices (`ios/Contracts/sync-conflict-vectors.json`). The iPhone has a
/// catalogue of its own (`Localizable.xcstrings`, keys `conflict.*`): this is the table from one to the other, and what puts the words in. The table is
/// checked against both catalogues by `src/shared/ios-sync-conflict-contract.test.ts` (every key a sentence can ask for is here, the texts are the
/// Mac's, with `{p1}` written `%1$@`) and against the built application by `SyncConflictScreenTests`.
enum SyncConflictTexts {
    static let keys: [String: String] = [
        "sync-conflict.title": "conflict.title",
        "sync-conflict.subtitle": "conflict.subtitle",
        "sync-conflict.ok": "conflict.ok",
        "sync-conflict.compare": "conflict.compare",
        "sync-conflict.hide-compare": "conflict.hide.compare",
        "sync-conflict.delete-everywhere": "conflict.delete.everywhere",
        "sync-conflict.restore": "conflict.restore",
        "sync-conflict.kept-version": "conflict.kept.version",
        "sync-conflict.other-version": "conflict.other.version",
        "sync-conflict.value-yes": "conflict.value.yes",
        "sync-conflict.value-no": "conflict.value.no",
        "sync-conflict.value-none": "conflict.value.none",
        "sync-conflict.value-other": "conflict.value.other",
        "sync-conflict.explain-restore": "conflict.explain.restore",
        "sync-conflict.kind-space": "conflict.kind.space",
        "sync-conflict.kind-folder": "conflict.kind.folder",
        "sync-conflict.kind-tab": "conflict.kind.tab",
        "sync-conflict.kind-favorite": "conflict.kind.favorite",
        "sync-conflict.kind-archived": "conflict.kind.archived",
        "sync-conflict.kind-setting-named": "conflict.kind.setting-named",
        "sync-conflict.kind-order": "conflict.kind.order",
        "sync-conflict.kind-other": "conflict.kind.other",
        "sync-conflict.field-name": "conflict.field.name",
        "sync-conflict.field-emoji": "conflict.field.emoji",
        "sync-conflict.field-theme": "conflict.field.theme",
        "sync-conflict.field-profile-id": "conflict.field.profile-id",
        "sync-conflict.field-hide-header": "conflict.field.hide-header",
        "sync-conflict.field-icon-kind": "conflict.field.icon-kind",
        "sync-conflict.field-icon-letter": "conflict.field.icon-letter",
        "sync-conflict.field-icon-color": "conflict.field.icon-color",
        "sync-conflict.field-icon-round": "conflict.field.icon-round",
        "sync-conflict.field-space-id": "conflict.field.space-id",
        "sync-conflict.field-parent-id": "conflict.field.parent-id",
        "sync-conflict.field-at-bottom": "conflict.field.at-bottom",
        "sync-conflict.field-at-today-start": "conflict.field.at-today-start",
        "sync-conflict.field-no-wake": "conflict.field.no-wake",
        "sync-conflict.field-icon": "conflict.field.icon",
        "sync-conflict.field-pinned": "conflict.field.pinned",
        "sync-conflict.field-anchor-url": "conflict.field.anchor-url",
        "sync-conflict.field-custom-title": "conflict.field.custom-title",
        "sync-conflict.field-folder-id": "conflict.field.folder-id",
        "sync-conflict.field-keep-awake": "conflict.field.keep-awake",
        "sync-conflict.field-url": "conflict.field.url",
        "sync-conflict.field-title": "conflict.field.title",
        "sync-conflict.field-archived-at": "conflict.field.archived-at",
        "sync-conflict.field-source": "conflict.field.source",
        "sync-conflict.field-value": "conflict.field.value",
        "sync-conflict.setting-https-upgrade": "conflict.setting.https-upgrade",
        "sync-conflict.setting-send-gpc": "conflict.setting.send-gpc",
        "sync-conflict.setting-strip-tracking-params": "conflict.setting.strip-tracking-params",
        "sync-conflict.setting-strip-copied-links": "conflict.setting.strip-copied-links",
        "sync-conflict.setting-protection-baseline": "conflict.setting.protection-baseline",
        "sync-conflict.setting-auto-archive-hours": "conflict.setting.auto-archive-hours",
        "sync-conflict.setting-search-url-template": "conflict.setting.search-url-template",
        "sync-conflict.setting-profile-names": "conflict.setting.profile-names",
        "sync-conflict.row-set": "conflict.row.set",
        "sync-conflict.row-moved": "conflict.row.moved",
        "sync-conflict.row-on": "conflict.row.on",
        "sync-conflict.row-off": "conflict.row.off",
        "sync-conflict.row-unset": "conflict.row.unset",
        "sync-conflict.row-other": "conflict.row.other",
        "sync-conflict.row-modified": "conflict.row.modified",
        "sync-conflict.row-deleted": "conflict.row.deleted",
        "sync-conflict.row-reordered": "conflict.row.reordered",
        "sync-conflict.outcome-newer-mac": "conflict.outcome.newer-mac",
        "sync-conflict.outcome-newer-ios": "conflict.outcome.newer-ios",
        "sync-conflict.outcome-tie-mac": "conflict.outcome.tie-mac",
        "sync-conflict.outcome-tie-ios": "conflict.outcome.tie-ios",
        "sync-conflict.outcome-kept": "conflict.outcome.kept",
        "sync-conflict.outcome-order-mac": "conflict.outcome.order-mac",
        "sync-conflict.outcome-order-ios": "conflict.outcome.order-ios",
    ]

    /// The names of the two devices are proper nouns: the same in both languages, so they are not in the catalogue (which refuses a text that is the same in French
    /// and in English) and the screen writes them as they are.
    static func deviceName(_ platform: SyncPlatform) -> String { platform == .mac ? "Mac" : "iPhone" }

    /// The sentence in the language of `locale`: the text of the catalogue with the words put at `%1$@`, `%2$@`… (the words are what the person typed, or a
    /// word of the catalogue told first). A key the table does not know is shown as it is, which the contract test makes impossible.
    static func string(_ text: SyncText, locale: Locale) -> String {
        guard let key = keys[text.key] else { return text.key }
        let format = bundle(for: locale).localizedString(forKey: key, value: nil, table: nil)
        if text.params.isEmpty { return format }
        let words: [CVarArg] = text.params.map { param in
            switch param {
            case .literal(let word): return word as NSString
            case .text(let inner): return string(inner, locale: locale) as NSString
            }
        }
        return String(format: format, locale: locale, arguments: words)
    }

    /// A word of the catalogue that is not told as a sentence (a button, a title, the name of a device).
    static func string(_ key: String, locale: Locale) -> String { string(SyncText(key), locale: locale) }

    /// The folder of the language of `locale` in the application: the language the person reads, whatever the device's list of languages says (the tests
    /// draw the same screen in French and in English).
    private static func bundle(for locale: Locale) -> Bundle {
        let code = locale.language.languageCode?.identifier ?? "en"
        if let path = Bundle.main.path(forResource: code, ofType: "lproj"), let bundle = Bundle(path: path) { return bundle }
        return .main
    }
}
