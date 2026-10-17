package io.lumen.secure.screenshots

import android.os.Looper
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.runtime.Composable
import androidx.compose.ui.test.junit4.ComposeTestRule
import androidx.compose.ui.Modifier
import androidx.test.core.app.ActivityScenario
import com.github.takahirom.roborazzi.captureScreenRoboImage
import io.lumen.secure.ui.theme.LumenTheme
import io.lumen.secure.ui.theme.lumenColors
import org.robolectric.RuntimeEnvironment
import org.robolectric.Shadows.shadowOf
import java.time.Duration

/** Window sizes the screens are rendered at (dp), at a modest density to keep the files small. */
enum class Device(val id: String, val sizeQualifiers: String, val density: String) {
    PHONE_SMALL("phone360", "w360dp-h640dp-normal-port", "hdpi"),
    PHONE("phone411", "w411dp-h891dp-normal-port", "hdpi"),
    TABLET("tablet840", "w840dp-h1280dp-xlarge-port", "mdpi"),
}

data class Variant(val device: Device, val dark: Boolean, val fontScale: Float = 1f) {
    val id: String
        get() = device.id + (if (dark) "_dark" else "_light") + if (fontScale != 1f) "_fs${(fontScale * 100).toInt()}" else ""

    override fun toString() = id

    companion object {
        /** Every screen: three window sizes in light and dark, plus large text on the small phone. */
        val standard = listOf(
            Variant(Device.PHONE_SMALL, dark = false),
            Variant(Device.PHONE_SMALL, dark = true),
            Variant(Device.PHONE, dark = false),
            Variant(Device.PHONE, dark = true),
            Variant(Device.TABLET, dark = false),
            Variant(Device.TABLET, dark = true),
            Variant(Device.PHONE_SMALL, dark = false, fontScale = 1.5f),
            Variant(Device.PHONE, dark = true, fontScale = 1.5f),
        )
    }
}

/**
 * Renders [content] in a fresh activity with the variant's window size, night mode and font scale,
 * then captures every window on screen (dialogs included) to app/build/outputs/roborazzi/.
 *
 * The Compose clock is paused and stepped by hand so that entry animations settle and endless ones
 * (progress spinners, skeleton shimmer) freeze in a stable frame instead of spinning forever.
 */
fun shoot(rule: ComposeTestRule, name: String, v: Variant, settleMillis: Long = 1_200, content: @Composable () -> Unit) {
    val night = if (v.dark) "night" else "notnight"
    RuntimeEnvironment.setQualifiers("${v.device.sizeQualifiers}-$night-${v.device.density}")
    RuntimeEnvironment.setFontScale(v.fontScale)
    rule.mainClock.autoAdvance = false
    ActivityScenario.launch(ComponentActivity::class.java).use { scenario ->
        scenario.onActivity { activity ->
            activity.setContent {
                LumenTheme(darkOverride = v.dark) {
                    Surface(Modifier.fillMaxSize(), color = MaterialTheme.lumenColors.bg) { content() }
                }
            }
        }
        // Step the Compose clock and the main looper together, so windows that attach later
        // (dialogs, bottom sheets) also get to run their entry animations before the capture.
        val looper = shadowOf(Looper.getMainLooper())
        looper.idle()
        var left = settleMillis
        while (left > 0) {
            rule.mainClock.advanceTimeBy(100)
            looper.idleFor(Duration.ofMillis(100))
            left -= 100
        }
        looper.idle()
        captureScreenRoboImage("build/outputs/roborazzi/${name}__${v.id}.png")
    }
}
