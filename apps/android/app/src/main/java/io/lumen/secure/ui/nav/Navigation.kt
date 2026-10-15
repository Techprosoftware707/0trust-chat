package io.lumen.secure.ui.nav

import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateListOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.lifecycle.ViewModel
import io.lumen.secure.core.deeplink.DeepLinkRoute

sealed interface Screen {
    data object Rooms : Screen
    data class Room(val roomId: String) : Screen
    data class RoomInfo(val roomId: String) : Screen
    data object NewChat : Screen
    data object Settings : Screen
    data object Security : Screen
    data object Encryption : Screen
    data object Devices : Screen
    data object Blocked : Screen
    data object About : Screen
    data object Licenses : Screen
}

/** In-app navigation (back stack survives configuration changes; predictive back pops it). */
class NavViewModel : ViewModel() {
    val stack = mutableStateListOf<Screen>(Screen.Rooms)
    val top: Screen get() = stack.last()

    /** A link (matrix.to, matrix:, App Link) waiting for the user's confirmation. */
    var pendingLink by mutableStateOf<DeepLinkRoute?>(null)

    fun push(s: Screen) {
        if (stack.last() != s) stack.add(s)
    }

    /** Opens a room as the only detail screen (list → room). */
    fun openRoom(roomId: String) {
        while (stack.size > 1) stack.removeAt(stack.lastIndex)
        stack.add(Screen.Room(roomId))
    }

    fun pop(): Boolean {
        if (stack.size <= 1) return false
        stack.removeAt(stack.lastIndex)
        return true
    }

    fun reset() {
        stack.clear()
        stack.add(Screen.Rooms)
        pendingLink = null
    }
}
