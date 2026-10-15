package io.lumen.secure

import android.Manifest
import android.app.NotificationManager
import android.content.pm.ApplicationInfo
import android.content.pm.PackageManager
import android.content.pm.ServiceInfo
import android.os.Build
import androidx.core.content.ContextCompat
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import io.lumen.secure.calls.CallService
import io.lumen.secure.push.Notifier
import io.lumen.secure.sync.KeepConnectedService
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith

/** Manifest policy and runtime-permission flows that do not need a server. */
@RunWith(AndroidJUnit4::class)
class ManifestAndPermissionsTest {
    private val instrumentation = InstrumentationRegistry.getInstrumentation()
    private val context = instrumentation.targetContext
    private val pm = context.packageManager

    @Test
    fun backupIsDisabled() {
        val info = pm.getApplicationInfo(context.packageName, 0)
        assertEquals(0, info.flags and ApplicationInfo.FLAG_ALLOW_BACKUP)
    }

    @Test
    fun foregroundServiceTypesAreDeclared() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.Q) return
        val call = pm.getServiceInfo(android.content.ComponentName(context, CallService::class.java), 0)
        val expected = ServiceInfo.FOREGROUND_SERVICE_TYPE_PHONE_CALL or ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE or ServiceInfo.FOREGROUND_SERVICE_TYPE_CAMERA
        assertEquals(expected, call.foregroundServiceType and expected)
        if (Build.VERSION.SDK_INT >= 34) {
            val sync = pm.getServiceInfo(android.content.ComponentName(context, KeepConnectedService::class.java), 0)
            assertEquals(ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE, sync.foregroundServiceType)
        }
        assertFalse(call.exported)
    }

    @Test
    fun notificationChannelsExist() {
        val nm = context.getSystemService(NotificationManager::class.java)
        listOf(Notifier.CH_MESSAGES, Notifier.CH_CALLS, Notifier.CH_ONGOING_CALL, Notifier.CH_SYNC).forEach {
            assertNotNull("channel $it", nm.getNotificationChannel(it))
        }
        assertEquals(NotificationManager.IMPORTANCE_HIGH, nm.getNotificationChannel(Notifier.CH_CALLS).importance)
    }

    /** Microphone/camera are runtime permissions requested only when a call starts. */
    @Test
    fun callPermissionsCanBeGranted() {
        val ui = instrumentation.uiAutomation
        for (p in listOf(Manifest.permission.RECORD_AUDIO, Manifest.permission.CAMERA)) {
            ui.grantRuntimePermission(context.packageName, p)
            assertEquals(PackageManager.PERMISSION_GRANTED, ContextCompat.checkSelfPermission(context, p))
        }
    }

    @Test
    fun notificationPermissionIsRuntimeOnAndroid13() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU) return
        val requested = pm.getPackageInfo(context.packageName, PackageManager.GET_PERMISSIONS).requestedPermissions.orEmpty()
        assertTrue(Manifest.permission.POST_NOTIFICATIONS in requested)
        instrumentation.uiAutomation.grantRuntimePermission(context.packageName, Manifest.permission.POST_NOTIFICATIONS)
        assertTrue(LumenApplication.graph(context).notifier.canPost())
    }
}
