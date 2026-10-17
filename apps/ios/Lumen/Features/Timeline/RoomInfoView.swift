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
                    VStack(spacing: LumenDimens.space3) {
                        AvatarView(name: model.roomName, size: 84, ring: true)
                            .padding(.top, LumenDimens.space2)
                        Text(model.roomName)
                            .font(.title2.weight(.semibold))
                            .foregroundStyle(c.text)
                            .multilineTextAlignment(.center)
                        if model.encryptionKnown {
                            CapsuleLabel(text: model.isEncrypted ? "End-to-end encrypted with Matrix" : "Not encrypted",
                                         systemImage: model.isEncrypted ? "lock.fill" : "lock.open",
                                         tint: model.isEncrypted ? c.success : c.warning,
                                         background: model.isEncrypted ? c.successSoft : c.warningSoft)
                        }
                        Text(model.isDirect ? "Direct chat" : "\(members.count) \(members.count == 1 ? "person" : "people")")
                            .font(.subheadline)
                            .foregroundStyle(c.textMuted)
                    }
                    .frame(maxWidth: .infinity)
                    .padding(.bottom, LumenDimens.space2)
                    .listRowBackground(Color.clear)
                    .accessibilityElement(children: .combine)
                } footer: {
                    Text(privacyFooter)
                        .frame(maxWidth: .infinity)
                        .multilineTextAlignment(.center)
                }

                Section("People") {
                    ForEach(members, id: \.userId) { m in
                        HStack(spacing: LumenDimens.space3) {
                            AvatarView(name: m.name, size: 40)
                            VStack(alignment: .leading, spacing: 2) {
                                HStack(spacing: 4) {
                                    Text(m.name)
                                        .foregroundStyle(c.text)
                                        .lineLimit(1)
                                    if m.userId == session.userId {
                                        Text("(you)").foregroundStyle(c.textMuted)
                                    }
                                }
                                Text(m.isInvited ? "Invited · \(m.userId)" : m.userId)
                                    .font(.caption)
                                    .foregroundStyle(c.textMuted)
                                    .lineLimit(1)
                                    .truncationMode(.middle)
                            }
                            Spacer(minLength: LumenDimens.space2)
                            if verified.contains(m.userId) {
                                Image(systemName: "checkmark.seal.fill")
                                    .foregroundStyle(c.success)
                                    .accessibilityLabel("Verified")
                            }
                        }
                        .accessibilityElement(children: .combine)
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
                        } label: { Label(verified.contains(other.userId) ? "Verify \(other.name) again" : "Verify \(other.name)", systemImage: "checkmark.shield") }
                    } footer: {
                        Text("Compare a few emoji with them, ideally in person or on a call you trust. Then you'll know their messages really come from them.")
                    }
                }

                Section("Calls") {
                    if model.callHistory.isEmpty {
                        Text("No calls in the loaded part of this conversation.").foregroundStyle(c.textMuted)
                    }
                    ForEach(model.callHistory) { entry in
                        HStack(spacing: LumenDimens.space3) {
                            Image(systemName: entry.video ? "video.fill" : "phone.fill")
                                .foregroundStyle(entry.outcome == .missed ? c.danger : c.accent)
                                .frame(width: 28)
                            VStack(alignment: .leading, spacing: 2) {
                                Text(entry.outcome.title).foregroundStyle(entry.outcome == .missed ? c.danger : c.text)
                                Text(entry.timestamp.formatted(date: .abbreviated, time: .shortened)).font(.caption).foregroundStyle(c.textMuted)
                            }
                        }
                        .accessibilityElement(children: .combine)
                    }
                }

                Section {
                    Button(role: .destructive) { confirmLeave = true } label: {
                        Label("Leave conversation", systemImage: "rectangle.portrait.and.arrow.right")
                            .foregroundStyle(c.danger)
                    }
                }
            }
            .navigationTitle("Details")
            .scrollContentBackground(.hidden)
            .background(c.bg)
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
                        } catch { self.error = "You couldn't leave the conversation just now. Check your connection and try again." }
                    }
                }
            }
            .confirmationDialog("Block \(blockTarget?.name ?? "")?", isPresented: Binding(get: { blockTarget != nil }, set: { if !$0 { blockTarget = nil } }), titleVisibility: .visible) {
                Button("Block", role: .destructive) {
                    guard let t = blockTarget else { return }
                    Task {
                        do { try await session.ignore(userId: t.userId) } catch { self.error = "Blocking didn't go through. Check your connection and try again." }
                    }
                }
            } message: {
                Text("You won't see their messages or invitations. They aren't told, but your account data on the server records the block.")
            }
            .alert("That didn't work", isPresented: Binding(get: { error != nil }, set: { if !$0 { error = nil } })) {
                Button("OK") {}
            } message: { Text(error ?? "") }
        }
    }

    private var privacyFooter: String {
        let metadata = "The room's name, topic, members and message timing are visible to the servers in the room."
        guard model.encryptionKnown else { return metadata }
        return model.isEncrypted
            ? "Message contents and files are end-to-end encrypted. \(metadata)"
            : "Messages here aren't end-to-end encrypted: the servers in the room can read them."
    }

    private func loadMembers() async {
        members = await model.loadMembers()
        verified = await model.verifiedUserIds(among: members)
    }
}
