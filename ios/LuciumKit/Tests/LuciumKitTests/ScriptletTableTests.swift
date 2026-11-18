import Foundation
import Testing
@testable import LuciumKit

/// A scriptlet file in the shape `scripts/ios-filter-lists.mjs` writes (`<id>.scriptlets.json`).
private func file(_ domains: String, schema: Int = 1) -> Data { Data(#"{"schema":\#(schema),"domains":\#(domains)}"#.utf8) }

private func table(ads: String? = nil, cookies: String? = nil) throws -> ScriptletTable {
    var table = ScriptletTable()
    if let ads { try table.merge(file(ads), category: .ads) }
    if let cookies { try table.merge(file(cookies), category: .cookies) }
    return table
}

private let both: Set<FilterListEntry.Category> = [.ads, .cookies]

@Suite("Table of the scriptlets the lists name")
struct ScriptletTableTests {
    @Test func readsTheCompactShapeTheBuildStepWrites() throws {
        let table = try table(ads: #"{"a.example":[["set-constant",["x","true"]],["aopr",["y"],["sub.a.example"]]]}"#)
        #expect(table.siteCount == 1)
        #expect(table.callCount == 2)
        #expect(table.calls(forHost: "a.example", categories: both) == [ScriptletCall(id: "set-constant", args: ["x", "true"]), ScriptletCall(id: "aopr", args: ["y"])])
    }

    @Test func aSiteCoversItsSubdomainsAndNothingThatOnlyEndsLikeIt() throws {
        let table = try table(ads: #"{"example.com":[["aopr",["x"]]]}"#)
        #expect(table.calls(forHost: "example.com", categories: both).count == 1)
        #expect(table.calls(forHost: "www.example.com", categories: both).count == 1)
        #expect(table.calls(forHost: "a.b.example.com", categories: both).count == 1)
        #expect(table.calls(forHost: "notexample.com", categories: both).isEmpty)
        #expect(table.calls(forHost: "example.com.evil.net", categories: both).isEmpty)
        #expect(table.calls(forHost: "com", categories: both).isEmpty)
    }

    @Test func aSubdomainRuleDoesNotReachItsParent() throws {
        let table = try table(ads: #"{"sub.example.com":[["aopr",["x"]]]}"#)
        #expect(table.calls(forHost: "example.com", categories: both).isEmpty)
        #expect(table.calls(forHost: "sub.example.com", categories: both).count == 1)
    }

    @Test func readsTheHostAsTheListsWriteIt() throws {
        let table = try table(ads: #"{"example.com":[["aopr",["x"]]]}"#)
        #expect(table.calls(forHost: "WWW.Example.COM", categories: both).count == 1)
        #expect(table.calls(forHost: "example.com.", categories: both).count == 1, "the dot that ends a fully qualified name")
        #expect(table.calls(forHost: "", categories: both).isEmpty)
    }

    @Test func anExceptionForASubdomainKeepsTheCallAwayFromIt() throws {
        let table = try table(ads: #"{"example.com":[["aopr",["x"],["sub.example.com"]]]}"#)
        #expect(table.calls(forHost: "www.example.com", categories: both).count == 1)
        #expect(table.calls(forHost: "sub.example.com", categories: both).isEmpty)
        #expect(table.calls(forHost: "deep.sub.example.com", categories: both).isEmpty, "its subdomains too")
    }

    @Test func asksTheAdsListsAndTheCookieListsApart() throws {
        let table = try table(ads: #"{"a.example":[["aopr",["ads"]]]}"#, cookies: #"{"a.example":[["aopr",["cookies"]]]}"#)
        #expect(table.calls(forHost: "a.example", categories: [.ads]) == [ScriptletCall(id: "aopr", args: ["ads"])])
        #expect(table.calls(forHost: "a.example", categories: [.cookies]) == [ScriptletCall(id: "aopr", args: ["cookies"])])
        #expect(table.calls(forHost: "a.example", categories: both).count == 2)
        #expect(table.calls(forHost: "a.example", categories: []).isEmpty)
    }

    @Test func putsTheMostSpecificSiteFirstAndGivesACallOnce() throws {
        let table = try table(ads: #"{"example.com":[["aopr",["shared"]],["aopr",["parent"]]],"www.example.com":[["aopr",["shared"]],["aopr",["own"]]]}"#)
        #expect(table.calls(forHost: "www.example.com", categories: both).map { $0.args[0] } == ["shared", "own", "parent"])
    }

    @Test func givesAtMostTheNumberOfCallsAPageMayRun() throws {
        let many = (0..<(ScriptletTable.callsMax + 10)).map { #"["aopr",["p\#($0)"]]"# }.joined(separator: ",")
        let table = try table(ads: #"{"a.example":[\#(many)]}"#)
        let calls = table.calls(forHost: "a.example", categories: both)
        #expect(calls.count == ScriptletTable.callsMax)
        #expect(calls.first == ScriptletCall(id: "aopr", args: ["p0"]), "the list's order is kept")
    }

    @Test func refusesAFileOfAnotherSchemaAndOneThatIsNotATable() throws {
        var table = ScriptletTable()
        #expect(throws: ScriptletTable.TableError.unsupportedSchema(2)) { try table.merge(file("{}", schema: 2), category: .ads) }
        #expect(throws: DecodingError.self) { try table.merge(Data(#"{"schema":1,"domains":{"a.example":[["aopr"]]}}"#.utf8), category: .ads) }
        #expect(throws: DecodingError.self) { try table.merge(Data("not json".utf8), category: .ads) }
        #expect(table.callCount == 0, "nothing of a refused file is kept")
    }
}
