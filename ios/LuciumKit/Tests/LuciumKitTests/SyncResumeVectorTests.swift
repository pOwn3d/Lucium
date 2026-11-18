import Foundation
import Testing
@testable import LuciumKit

/// `ios/Contracts/sync-resume-vectors.json` is played here against `SyncResume` and by the Mac against `src/shared/sync-resume.ts`
/// (`sync-resume.test.ts`): the same list gives the same rows, the same reason, the same space and the same age on both devices.
private enum ResumeVectors {
    static func load() throws -> [String: Any] {
        let file = URL(fileURLWithPath: #filePath)
        let url = file.deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
            .deletingLastPathComponent().appending(path: "Contracts/sync-resume-vectors.json")
        guard let root = try JSONSerialization.jsonObject(with: Data(contentsOf: url)) as? [String: Any] else { throw CocoaError(.fileReadCorruptFile) }
        return root
    }

    static func items(_ root: [String: Any], _ key: String) -> [[String: Any]] { root[key] as? [[String: Any]] ?? [] }
}

@Suite struct SyncResumeVectorTests {
    @Test func rowsFollowTheVectors() throws {
        let cases = ResumeVectors.items(try ResumeVectors.load(), "rows")
        #expect(cases.count > 1)
        for one in cases {
            let tabs = ResumeVectors.items(one, "tabs").map {
                SyncOpenTab(id: $0["id"] as? String ?? "", spaceId: $0["spaceId"] as? String ?? "", url: $0["url"] as? String ?? "", title: $0["title"] as? String ?? "", lastActiveAt: $0["lastActiveAt"] as? Int ?? 0)
            }
            let got = SyncResume.rows(from: tabs).map { [$0.id, $0.title, $0.host, $0.spaceId] }
            let want = ResumeVectors.items(one, "expect").map { [$0["id"] as? String ?? "", $0["title"] as? String ?? "", $0["host"] as? String ?? "", $0["spaceId"] as? String ?? ""] }
            #expect(got == want, "\(one["name"] as? String ?? "?")")
        }
    }

    @Test func availabilityFollowsTheVectors() throws {
        let cases = ResumeVectors.items(try ResumeVectors.load(), "availability")
        #expect(cases.count > 5)
        let names: [String: SyncResume.Availability] = ["not-paired": .notPaired, "disabled-here": .disabledHere, "waiting": .waiting, "disabled-on-iphone": .disabledOnMac, "empty": .empty, "list": .list]
        for one in cases {
            let got = SyncResume.availability(paired: one["paired"] as? Bool ?? false, categoryOnHere: one["categoryOnHere"] as? Bool ?? false, announcedAt: one["announcedAt"] as? Int,
                                              listAnnounced: one["listAnnounced"] as? Bool ?? false, rowCount: one["rowCount"] as? Int ?? 0, sessionHappened: one["sessionHappened"] as? Bool ?? false)
            #expect(got == names[one["expect"] as? String ?? ""], "\(one)")
        }
    }

    @Test func targetSpaceFollowsTheVectors() throws {
        let cases = ResumeVectors.items(try ResumeVectors.load(), "targetSpace")
        #expect(cases.count > 3)
        for one in cases {
            let row = SyncResume.Row(id: "r", url: "https://e.example/", title: "t", host: "e.example", spaceId: one["rowSpace"] as? String ?? "", lastActiveAt: 0)
            let locked = Set(one["locked"] as? [String] ?? [])
            let got = SyncResume.targetSpace(of: row, spaceIds: Set(one["spaces"] as? [String] ?? []), activeSpaceId: one["active"] as? String ?? "", isLocked: { locked.contains($0) })
            #expect(got == one["expect"] as? String, "\(one["name"] as? String ?? "?")")
        }
    }

    @Test func ageFollowsTheVectors() throws {
        let cases = ResumeVectors.items(try ResumeVectors.load(), "age")
        #expect(cases.count > 5)
        for one in cases {
            let want = one["expect"] as? [String: Any] ?? [:]
            let count = want["count"] as? Int ?? 0
            let expected: SyncResume.Age = switch want["unit"] as? String {
            case "minutes": .minutes(count)
            case "hours": .hours(count)
            case "days": .days(count)
            default: .justNow
            }
            #expect(SyncResume.age(at: one["at"] as? Int ?? 0, now: one["now"] as? Int ?? 0) == expected, "\(one)")
        }
    }
}
