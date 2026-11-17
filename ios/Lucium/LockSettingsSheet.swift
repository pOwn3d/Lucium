import LuciumKit
import SwiftUI

/// Where the person chooses what is locked: the application, and each space. Every change asks the owner first (a thief of the open phone cannot
/// turn a lock off), and a toggle follows the controller, not the finger: a refused change leaves it where it was.
struct LockSettingsSheet: View {
    @Bindable var lock: LockController
    let spaces: [Space]
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    Toggle("lock.settings.app", isOn: appBinding)
                } footer: {
                    Text("lock.settings.app.footer")
                }
                Section {
                    ForEach(spaces) { space in
                        Toggle(isOn: spaceBinding(space)) { Text(verbatim: "\(space.emoji) \(space.name)") }
                    }
                } header: {
                    Text("lock.settings.spaces.header")
                } footer: {
                    Text("lock.settings.spaces.footer")
                }
                if let notice = lock.notice {
                    Section { Text(notice.text) }
                }
                Section { Text("lock.settings.limits").font(.footnote).foregroundStyle(.secondary) }
            }
            .navigationTitle("lock.settings.title")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .confirmationAction) { Button("tabs.done") { dismiss() } } }
            .disabled(lock.isAuthenticating)
        }
    }

    private var appBinding: Binding<Bool> {
        Binding(get: { lock.lockApp }, set: { on in Task { await lock.setLockApp(on) } })
    }

    private func spaceBinding(_ space: Space) -> Binding<Bool> {
        Binding(get: { lock.isGuarded(space.id) }, set: { on in Task { await lock.setSpace(space.id, guarded: on) } })
    }
}
