import LumenCore
import MatrixRustSDK
import SwiftUI

/// Search the user directory or enter a Matrix ID.
struct UserSearchField: View {
    let session: SessionModel
    @Binding var picked: [String]
    var single = false
    @State private var query = ""
    @State private var results: [UserProfile] = []
    @State private var searching = false
    @Environment(\.lumen) private var c

    var body: some View {
        Section {
            TextField("Name or Matrix ID (@name:server)", text: $query)
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled()
                .accessibilityLabel("Search people")
                .onSubmit { addTyped() }
                .task(id: query) {
                    let q = query.trimmingCharacters(in: .whitespaces)
                    guard q.count >= 2 else { results = []; return }
                    try? await Task.sleep(nanoseconds: 300_000_000)
                    guard !Task.isCancelled else { return }
                    searching = true
                    results = (try? await RoomActions(client: session.client).searchUsers(q)) ?? []
                    searching = false
                }
            if let typed = MatrixID.normaliseUserIdInput(query, defaultServer: session.serverName), !results.contains(where: { $0.userId == typed }) {
                Button { addTyped() } label: {
                    HStack(spacing: LumenDimens.space3) {
                        AvatarView(name: typed, size: 36)
                        Text(typed).foregroundStyle(c.text).lineLimit(1).truncationMode(.middle)
                        Spacer(minLength: 0)
                        if picked.contains(typed) { Image(systemName: "checkmark.circle.fill").foregroundStyle(c.accent).accessibilityLabel("Selected") }
                    }
                }
            }
            if searching { ProgressView().frame(maxWidth: .infinity) }
            ForEach(results, id: \.userId) { user in
                Button {
                    add(user.userId)
                } label: {
                    HStack(spacing: LumenDimens.space3) {
                        AvatarView(name: user.displayName ?? user.userId, size: 36)
                        VStack(alignment: .leading, spacing: 2) {
                            Text(user.displayName ?? user.userId).foregroundStyle(c.text).lineLimit(1)
                            Text(user.userId).font(.caption).foregroundStyle(c.textMuted).lineLimit(1).truncationMode(.middle)
                        }
                        Spacer(minLength: 0)
                        if picked.contains(user.userId) { Image(systemName: "checkmark.circle.fill").foregroundStyle(c.accent).accessibilityLabel("Selected") }
                    }
                }
            }
        } footer: {
            if results.isEmpty && !searching {
                Text("Search your server's directory by name, or type a full Matrix ID such as @name:example.org. People on any Matrix server can be reached.")
            }
        }
    }

    private func addTyped() {
        if let id = MatrixID.normaliseUserIdInput(query, defaultServer: session.serverName) { add(id) }
    }

    private func add(_ id: String) {
        if single { picked = [id]; return }
        if let i = picked.firstIndex(of: id) { picked.remove(at: i) } else { picked.append(id) }
    }
}

struct NewChatView: View {
    let session: SessionModel
    let onCreated: (String) -> Void
    @Environment(\.dismiss) private var dismiss
    @Environment(\.lumen) private var c
    @State private var picked: [String] = []
    @State private var error: String?

    var body: some View {
        NavigationStack {
            Form {
                UserSearchField(session: session, picked: $picked, single: true)
                if let user = picked.first {
                    Section {
                        AsyncButton {
                            do {
                                let id = try await RoomActions(client: session.client).startDirectMessage(with: user)
                                onCreated(id)
                                dismiss()
                            } catch { self.error = "The chat couldn't be created. Check your connection and try again." }
                        } label: { Label("Start encrypted chat", systemImage: "lock.fill").font(.body.weight(.semibold)) }
                    } header: {
                        Text("With \(user)")
                    } footer: {
                        Text("Direct chats are end-to-end encrypted. Verify the other person to be sure it's really them.")
                    }
                }
                if let error { Text(error).foregroundStyle(c.danger) }
            }
            .scrollContentBackground(.hidden)
            .background(c.bg)
            .navigationTitle("New chat")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } } }
        }
    }
}

struct NewGroupView: View {
    let session: SessionModel
    let onCreated: (String) -> Void
    @Environment(\.dismiss) private var dismiss
    @Environment(\.lumen) private var c
    @State private var name = ""
    @State private var topic = ""
    @State private var picked: [String] = []
    @State private var error: String?

    var body: some View {
        NavigationStack {
            Form {
                Section("Group") {
                    TextField("Name", text: $name)
                    TextField("Topic (optional)", text: $topic)
                }
                Section {
                    if picked.isEmpty {
                        Text("Add people below. You can also invite them later.").foregroundStyle(c.textMuted)
                    }
                    ForEach(picked, id: \.self) { id in
                        HStack(spacing: LumenDimens.space3) {
                            AvatarView(name: id, size: 32)
                            Text(id).lineLimit(1).truncationMode(.middle)
                        }
                    }
                    .onDelete { picked.remove(atOffsets: $0) }
                } header: {
                    Text("Members")
                } footer: {
                    Text("Invite-only and end-to-end encrypted. The group's name and topic aren't encrypted: the server can see them.")
                }
                UserSearchField(session: session, picked: $picked)
                if let error { Text(error).foregroundStyle(c.danger) }
            }
            .scrollContentBackground(.hidden)
            .background(c.bg)
            .navigationTitle("New group")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    AsyncButton {
                        do {
                            let t = topic.trimmingCharacters(in: .whitespaces)
                            let id = try await RoomActions(client: session.client).createGroup(name: name.trimmingCharacters(in: .whitespaces), topic: t.isEmpty ? nil : t, invite: picked)
                            onCreated(id)
                            dismiss()
                        } catch { self.error = "The group couldn't be created. Check your connection and try again." }
                    } label: { Text("Create") }
                    .disabled(name.trimmingCharacters(in: .whitespaces).isEmpty)
                }
            }
        }
    }
}
