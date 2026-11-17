import Foundation
import Testing
@testable import LuciumKit

/// A registry in the shape `scripts/ios-filter-lists.mjs` writes (the same fields as `ios/LuciumTests/Fixtures/filter-lists-registry.json`).
private func registryJSON(sourceUrl: String = "https://example.org/list.txt", licenseFr: String = "GPL-3.0", schema: Int = 1) -> Data {
    Data("""
    {
      "schema": \(schema),
      "generatedAt": "2026-11-17T20:05:00Z",
      "lists": [{
        "id": "sample",
        "title": { "en": "Sample", "fr": "Exemple" },
        "category": "ads",
        "author": { "en": "The authors", "fr": "Les auteurs" },
        "license": { "en": "GPL-3.0", "fr": "\(licenseFr)" },
        "licenseUrl": "https://example.org/licence",
        "homepage": "https://example.org/",
        "sourceUrl": "\(sourceUrl)",
        "fetchedAt": "2026-11-17T20:00:00Z",
        "sourceVersion": "202611171200",
        "sourceSha256": "\(String(repeating: "a", count: 64))",
        "filters": 3,
        "dropped": { "option:redirect": 2 },
        "files": [
          { "name": "sample.network.json", "kind": "network", "rules": 120, "sha256": "\(String(repeating: "b", count: 64))" },
          { "name": "sample.cosmetic.json", "kind": "cosmetic", "rules": 30, "sha256": "\(String(repeating: "c", count: 64))" }
        ]
      }]
    }
    """.utf8)
}

@Suite("Registry of the embedded filter lists")
struct FilterListRegistryTests {
    @Test func readsWhereEachListComesFromAndUnderWhatTerms() throws {
        let registry = try FilterListRegistry.decode(registryJSON())
        let list = try #require(registry.lists.first)
        #expect(list.title.text(forLanguageCode: "fr") == "Exemple")
        #expect(list.title.text(forLanguageCode: "en") == "Sample")
        #expect(list.author.text(forLanguageCode: "fr-CA") == "Les auteurs")
        #expect(list.license.text(forLanguageCode: "de") == "GPL-3.0", "English for any other language")
        #expect(list.license.text(forLanguageCode: nil) == "GPL-3.0")
        #expect(list.sourceUrl == "https://example.org/list.txt")
        #expect(list.rules == 150)
        #expect(list.dropped == ["option:redirect": 2])
        #expect(list.fetchedDate == Date(timeIntervalSince1970: 1_794_945_600))
    }

    @Test func namesACompiledListAfterTheStartOfItsContentHash() throws {
        let file = try #require(try FilterListRegistry.decode(registryJSON()).lists.first?.files.first)
        #expect(file.storeIdentifier == "app.lucium.list.sample.network.bbbbbbbbbbbb")
        let other = FilterListFile(name: file.name, kind: file.kind, rules: file.rules, sha256: String(repeating: "d", count: 64))
        #expect(other.storeIdentifier != file.storeIdentifier, "a new copy of a list is another list in the store")
    }

    @Test func refusesARegistryThatDoesNotSayWhereAListComesFrom() {
        #expect(throws: FilterListRegistry.RegistryError.incomplete(["sample: sourceUrl is not an https address"])) {
            try FilterListRegistry.decode(registryJSON(sourceUrl: "http://example.org/list.txt"))
        }
        #expect(throws: FilterListRegistry.RegistryError.incomplete(["sample: no license"])) {
            try FilterListRegistry.decode(registryJSON(licenseFr: " "))
        }
    }

    @Test func refusesASchemaItDoesNotKnow() {
        #expect(throws: FilterListRegistry.RegistryError.unsupportedSchema(2)) { try FilterListRegistry.decode(registryJSON(schema: 2)) }
    }

    @Test func refusesAListWithNoFileOrTooManyRules() throws {
        var registry = try FilterListRegistry.decode(registryJSON())
        let list = try #require(registry.lists.first)
        let empty = FilterListEntry(id: list.id, title: list.title, category: list.category, author: list.author, license: list.license, licenseUrl: list.licenseUrl,
                                    homepage: list.homepage, sourceUrl: list.sourceUrl, fetchedAt: list.fetchedAt, sourceVersion: nil, sourceSha256: list.sourceSha256,
                                    filters: 0, dropped: [:], files: [])
        registry = FilterListRegistry(schema: 1, generatedAt: registry.generatedAt, lists: [empty])
        #expect(registry.problems == ["sample: no file"])
        let big = FilterListFile(name: "sample.network.json", kind: .network, rules: FilterListRegistry.ruleLimit + 1, sha256: String(repeating: "e", count: 64))
        let over = FilterListEntry(id: list.id, title: list.title, category: list.category, author: list.author, license: list.license, licenseUrl: list.licenseUrl,
                                   homepage: list.homepage, sourceUrl: list.sourceUrl, fetchedAt: list.fetchedAt, sourceVersion: nil, sourceSha256: list.sourceSha256,
                                   filters: 0, dropped: [:], files: [big])
        registry = FilterListRegistry(schema: 1, generatedAt: registry.generatedAt, lists: [over])
        #expect(registry.problems == ["sample: sample.network.json has 150001 rules"])
    }
}
