# User guide

For people who use a Lumen server to chat. The same material is published on
every Lumen website under **Docs** (`https://<your server>/docs/`).

## Your account

1. **Sign up** on the website (`https://example.com/accounts/signup/`). Your
   username becomes your chat address: `@username:example.com`. It cannot be
   changed later, and it is never reused after an account is deleted.
2. **Turn on two-factor authentication** in **Security center**: an authenticator
   app (TOTP), a security key / passkey (WebAuthn), or both. Save the recovery
   codes it gives you. Workspaces can require two-factor authentication before
   members may sign in to chat.
3. The **Security center** shows your sign-ins (with IP address and device),
   failed attempts and open sessions. Sign out sessions you don't recognise.
4. **Privacy & data** lets you download your account data (JSON) and delete your
   account. Deletion takes effect after a 7-day grace period, during which you
   can cancel it.

Without email on the server (the operator decides), there is no email
verification or password reset by email; if you forget your password, contact
support — they can issue a one-time recovery link after checking your identity.

## Chatting

Open the chat app (`https://app.example.com`, or **Open chat** in the portal) and
choose **Continue with your account**. The first time on each device:

1. **Set up secure backup.** The app creates a *recovery key* — 48 characters in
   groups of four. Store it somewhere safe and offline (password manager, paper).
   It is the only way to read your encrypted history on a new device if your other
   devices are gone. Nobody, including the server operator, can recover it for you.
2. **Start a conversation:** **Start a conversation → New direct message** (type
   a name or a full address such as `@alex:example.org` on any Matrix server) or
   **New group**. Every new room is end-to-end encrypted.
3. Messages support replies, reactions, edits, deletion, files and images
   (encrypted before upload), read receipts and typing indicators. Search finds
   messages on the current device (the server cannot search encrypted content).
4. With voice/video enabled on the server, the call buttons in a direct
   conversation start an encrypted 1:1 call.

## Verifying people and devices

Encryption protects you from the server; **verification** protects you from
someone pretending to be your contact (including a server adding a device).

* **Verify a person once:** in a direct conversation click the **Not verified**
  badge next to their name (in a group: room info → member → **Verify**), then
  compare the emoji on both screens (in person or on a call). If they match,
  confirm. The badge turns into **Verified** and their messages carry a green
  shield.
* **Verify your own new devices:** a new device asks to be verified by another
  of your devices (emoji) or with your recovery key. Until then it cannot read
  old messages and others see it as unverified.
* **Warnings matter.** "Unverified device" or "identity changed" means the
  person's keys changed: they reinstalled, reset their identity — or someone is
  intercepting. Check with them through another channel before continuing.

## Devices and sessions

**Settings → Sessions** lists every device signed in to your chat account. Rename
them, and sign out any you don't recognise (you confirm with your account).
Signing out on a device wipes its local data, including its keys.

## Workspaces (teams)

In the portal, **Workspaces → New workspace**. Owners and admins invite people by
email; each invitation is a one-time link bound to that email address (shown once;
if the server has no email, share it yourself). Roles: owner, admin, member. The
owner manages the plan under **Plan & billing**. Workspace limits (members, file
size, monthly upload volume, required two-factor) come from the plan and are
enforced by the server.

## What the server can and cannot see

The server stores your encrypted messages and files but cannot read them. It
does see metadata: who is in which room, when messages are sent, display names,
room names and topics, and IP addresses. Details:
[docs/security/threat-model.md](security/threat-model.md) and the website's
privacy page.

## Other Matrix apps

Lumen accounts work with any Matrix app that supports single sign-on (for example
Element on desktop and mobile). Enter `example.com` as the homeserver and choose
the sign-in option shown. Verify the new device as described above.
