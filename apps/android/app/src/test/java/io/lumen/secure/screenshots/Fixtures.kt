package io.lumen.secure.screenshots

import io.lumen.secure.core.config.DiscoveredServer
import io.lumen.secure.core.config.IdentityProvider
import io.lumen.secure.core.config.LoginFlows
import io.lumen.secure.core.config.LumenAppInfo
import io.lumen.secure.core.messaging.DeliveryState
import io.lumen.secure.matrix.FileKind
import io.lumen.secure.matrix.ReactionUi
import io.lumen.secure.matrix.ReplyPreview
import io.lumen.secure.matrix.RoomHeader
import io.lumen.secure.matrix.RoomSummary
import io.lumen.secure.matrix.RowContent
import io.lumen.secure.matrix.ShieldUi
import io.lumen.secure.matrix.TimelineRow
import io.lumen.secure.net.DeviceInfo
import io.lumen.secure.ui.screens.MemberUi
import org.matrix.rustcomponents.sdk.EventOrTransactionId
import org.matrix.rustcomponents.sdk.MediaSource
import org.matrix.rustcomponents.sdk.Membership
import org.matrix.rustcomponents.sdk.NoHandle

/** Realistic fake data for the screenshot tests (no network, no SDK). */
object Fixtures {
    private val now = System.currentTimeMillis()
    private const val MIN = 60_000L

    const val ME = "@alex:lumen.example"

    val server = DiscoveredServer(
        serverName = "lumen.example",
        homeserverUrl = "https://matrix.lumen.example",
        lumen = LumenAppInfo(
            brandName = "Lumen Secure", brandShortName = "Lumen", portalUrl = "https://lumen.example",
            signupUrl = "https://lumen.example/accounts/signup/", accountUrl = "https://lumen.example/portal/",
            privacyUrl = "https://lumen.example/privacy/", helpUrl = "https://lumen.example/help/", ssoIdpId = "oidc-lumen",
            webAppUrl = "https://app.lumen.example", callWidgetUrl = null, pushGatewayUrl = null,
            accountDeleteUrl = "https://lumen.example/portal/delete/",
        ),
        loginFlows = LoginFlows(sso = true, identityProviders = listOf(IdentityProvider("oidc-lumen", "Lumen")), token = true, password = false),
    )

    val passwordOnlyServer = DiscoveredServer(
        serverName = "matrix.example.org", homeserverUrl = "https://matrix.example.org", lumen = null,
        loginFlows = LoginFlows(sso = false, identityProviders = emptyList(), token = false, password = true),
    )

    private fun room(
        id: String, name: String, last: String?, minutesAgo: Long?, unread: Long = 0, mentions: Long = 0, direct: Boolean = true,
        invite: Boolean = false, inviter: String? = null, encrypted: Boolean = true, call: Boolean = false,
    ) = RoomSummary(
        id = id, name = name, isDirect = direct, isInvite = invite, inviterName = inviter, encrypted = encrypted,
        unreadMessages = unread, unreadMentions = mentions, markedUnread = false, lastMessage = last,
        lastTimestamp = minutesAgo?.let { now - it * MIN }, hasCall = call,
    )

    val rooms = listOf(
        room("!invite:x", "Design review", null, 2, invite = true, inviter = "Priya Raman", direct = false),
        room("!maya:x", "Maya Lindqvist", "Sounds good, see you at six.", 3, unread = 2),
        room(
            "!launch:x", "Product launch: Q4 planning with the extended marketing, design and partner teams",
            "Jonas: The draft for the announcement is in the shared folder; could everyone have a look before Thursday's review?",
            18, unread = 14, mentions = 1, direct = false,
        ),
        room("!family:x", "Family", "Dad: Call me when you land", 45, direct = false, call = true),
        room("!jonas:x", "Jonas Okafor", "Waiting for the key to this message", 120),
        room("!lobby:x", "Community lobby", "Welcome to the lobby", 60 * 26, direct = false, encrypted = false),
        room("!sam:x", "Sam", "Photo", 60 * 50),
        room("!ops:x", "Ops on-call", "Rotation for next week is posted", 60 * 24 * 6, direct = false),
    )

    private var seq = 0
    private fun ev(
        sender: String, name: String, own: Boolean, minutesAgo: Long, content: RowContent,
        reactions: List<ReactionUi> = emptyList(), reply: ReplyPreview? = null, delivery: DeliveryState = if (own) DeliveryState.SENT else DeliveryState.NONE,
        edited: Boolean = false, shield: ShieldUi = ShieldUi.NONE,
    ): TimelineRow.Event {
        val id = "\$e${seq++}"
        return TimelineRow.Event(
            key = id, id = EventOrTransactionId.EventId(id), eventId = id, senderId = sender, senderName = name, isOwn = own,
            timestamp = now - minutesAgo * MIN, content = content, reactions = reactions, replyTo = reply, delivery = delivery,
            edited = edited, editable = own, canReply = true, shield = shield, shieldReason = null,
        )
    }

    private val maya = "@maya:lumen.example"
    private val media get() = MediaSource(NoHandle)

    val timeline: List<TimelineRow> by lazy {
        listOf(
            TimelineRow.Start("start"),
            TimelineRow.DateDivider("d1", now - 60 * 24 * MIN),
            ev(maya, "Maya", false, 60 * 24, RowContent.StateText("Chat created")),
            ev(maya, "Maya", false, 60 * 24, RowContent.StateText("End-to-end encryption turned on")),
            ev(maya, "Maya", false, 60 * 24 - 1, RowContent.Text("Hi Alex! Are we still on for the planning session tomorrow?")),
            ev(ME, "Alex", true, 60 * 24 - 2, RowContent.Text("Yes, 10:00 in the small room. I'll bring the draft."), delivery = DeliveryState.READ),
            ev(maya, "Maya", false, 60 * 24 - 3, RowContent.UnableToDecrypt),
            TimelineRow.DateDivider("d2", now - 40 * MIN),
            ev(maya, "Maya", false, 40, RowContent.Image(media, null, "whiteboard.jpg", "The whiteboard from today", "image/jpeg", 1600, 1200)),
            ev(
                maya, "Maya", false, 38,
                RowContent.Text(
                    "Here is the long version of the notes, with the link to the document: https://docs.lumen.example/q4-planning — " +
                        "please add your comments by Thursday so we can finalise the timeline and the budget together.",
                ),
                reactions = listOf(ReactionUi("👍", 2, mine = true), ReactionUi("🎉", 1, mine = false)),
            ),
            ev(ME, "Alex", true, 30, RowContent.File(media, "Q4-plan-v3.pdf", null, "application/pdf", 2_457_600, FileKind.FILE), delivery = DeliveryState.READ),
            ev(ME, "Alex", true, 25, RowContent.Text("Looks great. I fixed the typo in section 2."), edited = true, delivery = DeliveryState.READ,
                reply = ReplyPreview("\$x", "Maya", "Here is the long version of the notes, with the link to the document")),
            ev(maya, "Maya", false, 20, RowContent.Redacted),
            ev(maya, "Maya", false, 12, RowContent.Call(active = false)),
            TimelineRow.ReadMarker("rm"),
            ev(maya, "Maya", false, 4, RowContent.Text("Sounds good, see you at six."), shield = ShieldUi.WARNING),
            ev(ME, "Alex", true, 1, RowContent.Text("On my way!"), delivery = DeliveryState.SENDING),
            ev(ME, "Alex", true, 0, RowContent.Text("This one did not go through."), delivery = DeliveryState.FAILED),
        )
    }

    val header = RoomHeader(name = "Maya Lindqvist", isDirect = true, encrypted = true, membership = Membership.JOINED, inviterName = null, hasCall = false, memberCount = 2)
    val groupHeader = header.copy(name = "Product launch: Q4 planning with the extended marketing, design and partner teams", isDirect = false, memberCount = 14)
    val inviteHeader = header.copy(name = "Design review", isDirect = false, membership = Membership.INVITED, inviterName = "Priya Raman")
    val unencryptedHeader = header.copy(name = "Community lobby", isDirect = false, encrypted = false, memberCount = 230)

    val members = listOf(
        MemberUi(ME, "Alex Example", invited = false, ignored = false, verified = true),
        MemberUi("@maya:lumen.example", "Maya Lindqvist", invited = false, ignored = false, verified = true),
        MemberUi("@jonas:lumen.example", "Jonas Okafor", invited = false, ignored = false, verified = false),
        MemberUi("@priya:partner.example", "Priya Raman", invited = true, ignored = false, verified = null),
        MemberUi("@spam:example.net", "A very long display name that does not fit on one line at all", invited = false, ignored = true, verified = false),
    )

    val devices = listOf(
        DeviceInfo("ABCDEFGHIJ", "Lumen on Pixel 9", now - 2 * MIN, null),
        DeviceInfo("KLMNOPQRST", "Lumen web (Firefox on Linux)", now - 60 * 5 * MIN, null),
        DeviceInfo("UVWXYZ0123", "Lumen desktop on Windows", now - 60 * 24 * 12 * MIN, null),
    )

    const val RECOVERY_KEY = "EsTj 3yST y93F SLpB jJsz eAXc 2XzA ygD3 w69H fGaN TKBj jXEd"
}
