import LumenCore
import MatrixRustSDK
import SwiftUI

struct RoomInfoView: View {
    let session: SessionModel
    let model: TimelineModel
    @Environment(\.dismiss) private var dismiss
    @Environment(AppModel.self) private var app
    @Environment(\.lumen) private var c
    @State private var members: [MemberSummary] = []
    @State private var confirmLeave = false
    @State private var blockTarget: MemberSummary?
    @State private var error: String?
    @State private var verified: Set<String> = []

    var body: some View {
        NavigationStack {
            List {
                Section {
                    HStack {
                        AvatarView(name: model.roomName, size: 56)
                        VStack(alignment: .leading) {
                            Text(model.roomName).font(.title3.weight(.semibold))
                            Label(model.isEncrypted ? "End-to-end encrypted" : "Not encrypted",
                                  systemImage: model.isEncrypted ? "lock.fill" : "lock.open")
                                .font(.footnote)
                                .foregroundStyle(model.isEncrypted ? c.success : c.warning)
                        }
                    }
                    .accessibilityElement(children: .combine)
                } footer: {
                    Text("Message contents are end-to-end encrypted. The room's name, topic, members and message timing are visible to the servers in the room.")
                }

                Section("People") {
                    ForEach(members, id: \.userId) { m in
                        HStack {
                            AvatarView(name: m.name, size: 32)
                            VStack(alignment: .leading) {
                                Text(m.name)
                                Text(m.userId).font(.caption).foregroundStyle(c.textMuted)
                            }
                            Spacer()
                            if verified.contains(m.userId) {
                                Image(systemName: "checkmark.seal.fill").foregroundStyle(c.success).accessibilityLabel("Verified")
                            }
                        }
                        .swipeActions {
                            if m.userId != session.userId {
                                Button("Block") { blockTarget = m }.tint(c.danger)
                            }
                        }
                        .contextMenu {
                            if m.userId != session.userId {
                                Button {
                                    Task { await session.verification.requestUserVerification(m.userId) }
                                } label: { Label("Verify \(m.name)", systemImage: "checkmark.shield") }
                                Button(role: .destructive) { blockTarget = m } label: { Label("Block", systemImage: "hand.raised") }
                            }
                        }
                    }
                }

                if model.isDirect, let other = members.first(where: { $0.userId != session.userId }) {
                    Section {
                        Button {
                            dismiss()
                            Task { await session.verification.requestUserVerification(other.userId) }
                        } label: { Label("Verify \(other.name)", systemImage: "checkmark.shield") }
                    } footer: {
                        Text("Compare emoji with them, ideally in person or on a call you trust, to be sure their messages really come from them.")
                    }
                }

                Section("Calls") {
                    if model.callHistory.isEmpty {
                        Text("No calls in the loaded part of this conversation.").foregroundStyle(c.textMuted)
                    }
                    ForEach(model.callHistory) { entry in
                        HStack {
                            Image(systemName: entry.video ? "video" : "phone")
                            VStack(alignment: .leading) {
                                Text(entry.outcome.title)
                                Text(entry.timestamp.formatted(date: .abbreviated, time: .shortened)).font(.caption).foregroundStyle(c.textMuted)
                            }
                        }
                        .accessibilityElement(children: .combine)
                    }
                }

                Section {
                    Button("Leave conversation", role: .destructive) { confirmLeave = true }
                }
            }
            .navigationTitle("Details")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() } } }
            .task { await loadMembers() }
            .confirmationDialog("Leave this conversation?", isPresented: $confirmLeave, titleVisibility: .visible) {
                Button("Leave", role: .destructive) {
                    Task {
                        do {
                            try await model.leave()
                            app.selectedRoomId = nil
                            dismiss()
                        } catch { self.error = "You couldn't leave the conversation." }
                    }
                }
            }
            .confirmationDialog("Block \(blockTarget?.name ?? "")?", isPresented: Binding(get: { blockTarget != nil }, set: { if !$0 { blockTarget = nil } }), titleVisibility: .visible) {
                Button("Block", role: .destructive) {
                    guard let t = blockTarget else { return }
                    Task {
                        do { try await session.ignore(userId: t.userId) } catch { self.error = "Blocking didn't work." }
                    }
                }
            } message: {
                Text("You won't see their messages or invitations. They aren't told, but your account data on the server records the block.")
            }
            .alert("Something went wrong", isPresented: Binding(get: { error != nil }, set: { if !$0 { error = nil } })) {
                Button("OK") {}
            } message: { Text(error ?? "") }
        }
    }

    private func loadMembers() async {
        members = await model.loadMembers()
        verified = await model.verifiedUserIds(among: members)
    }
}
