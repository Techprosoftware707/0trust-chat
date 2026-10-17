import java.io.File
import org.jetbrains.kotlin.gradle.dsl.JvmTarget

plugins {
    alias(libs.plugins.android.application)
    alias(libs.plugins.kotlin.android)
    alias(libs.plugins.kotlin.compose)
}

// ---- Build configuration from Gradle properties (see gradle.properties) ----------------------
// Empty values count as unset (CI passes ORG_GRADLE_PROJECT_lumen.* as empty strings when a
// secret or variable is not configured).
fun prop(name: String, default: String = ""): String =
    (project.findProperty(name) as String?)?.trim()?.takeIf { it.isNotEmpty() } ?: default

val lumenApplicationId = prop("lumen.applicationId", "io.lumen.secure")
require(Regex("^[a-z][a-z0-9_]*(\\.[a-z][a-z0-9_]*)+$").matches(lumenApplicationId)) {
    "lumen.applicationId must be a reverse-DNS identifier, got '$lumenApplicationId'"
}
val lumenDefaultServer = prop("lumen.defaultServer")
require(lumenDefaultServer.isEmpty() || Regex("^[A-Za-z0-9.-]+(:[0-9]{1,5})?$").matches(lumenDefaultServer)) {
    "lumen.defaultServer must be a server name such as example.com (not a URL), got '$lumenDefaultServer'"
}
val lumenAppLinkHosts = prop("lumen.appLinkHosts").split(',').map { it.trim().lowercase() }.filter { it.isNotEmpty() }
lumenAppLinkHosts.forEach { h ->
    require(Regex("^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$").matches(h)) { "Invalid App Link host '$h'" }
}
val fcmValues = listOf("projectId", "appId", "apiKey", "senderId").associateWith { prop("lumen.fcm.$it") }
val fcmConfigured = fcmValues.values.all { it.isNotEmpty() }
require(fcmConfigured || fcmValues.values.all { it.isEmpty() }) {
    "Set all four lumen.fcm.* properties (projectId, appId, apiKey, senderId) or none of them"
}
fun String.asBuildConfigString() = "\"" + replace("\\", "\\\\").replace("\"", "\\\"") + "\""

// ---- Release signing from the environment only (absent → unsigned release) -------------------
val keystorePath: String? = System.getenv("LUMEN_ANDROID_KEYSTORE_PATH")?.takeIf { it.isNotBlank() }
val keystorePassword: String? = System.getenv("LUMEN_ANDROID_KEYSTORE_PASSWORD")
val keyAlias: String? = System.getenv("LUMEN_ANDROID_KEY_ALIAS")
val keyPassword: String? = System.getenv("LUMEN_ANDROID_KEY_PASSWORD")
val releaseSigningAvailable = keystorePath != null && keystorePassword != null && keyAlias != null && keyPassword != null

android {
    namespace = "io.lumen.secure"
    compileSdk = 36
    buildToolsVersion = "36.1.0"

    defaultConfig {
        applicationId = lumenApplicationId
        minSdk = 26
        targetSdk = 36
        versionCode = prop("lumen.versionCode", "1").toInt()
        versionName = prop("lumen.versionName", "1.0.0")
        testInstrumentationRunner = "androidx.test.runner.AndroidJUnitRunner"

        buildConfigField("String", "DEFAULT_SERVER", lumenDefaultServer.asBuildConfigString())
        buildConfigField("String", "APP_LINK_HOSTS", lumenAppLinkHosts.joinToString(",").asBuildConfigString())
        buildConfigField("String", "FCM_PROJECT_ID", fcmValues.getValue("projectId").asBuildConfigString())
        buildConfigField("String", "FCM_APP_ID", fcmValues.getValue("appId").asBuildConfigString())
        buildConfigField("String", "FCM_API_KEY", fcmValues.getValue("apiKey").asBuildConfigString())
        buildConfigField("String", "FCM_SENDER_ID", fcmValues.getValue("senderId").asBuildConfigString())
        buildConfigField("boolean", "FCM_CONFIGURED", fcmConfigured.toString())
        // Pusher app_id (integration.md §1): must match the Sygnal configuration.
        buildConfigField("String", "PUSHER_APP_ID", "$lumenApplicationId.android".asBuildConfigString())

        // The URL scheme follows the application ID (integration.md §1).
        manifestPlaceholders["appScheme"] = lumenApplicationId
    }

    signingConfigs {
        if (releaseSigningAvailable) {
            create("release") {
                storeFile = file(keystorePath!!)
                storePassword = keystorePassword
                this.keyAlias = keyAlias
                this.keyPassword = keyPassword
                enableV2Signing = true
                enableV3Signing = true
            }
        }
    }

    buildTypes {
        debug {
            // Plain http is accepted only for loopback hosts, and only in debug builds.
            buildConfigField("boolean", "ALLOW_LOOPBACK_HTTP", "true")
        }
        release {
            buildConfigField("boolean", "ALLOW_LOOPBACK_HTTP", "false")
            isMinifyEnabled = true
            // Resource shrinking stays off: with ABI splits, AGP 8.13 cannot build the AAB in the
            // same invocation as the split APKs ("Multiple shrunk-resources files",
            // issuetracker.google.com/402800800). The APK size is dominated by the Rust SDK's
            // native library; R8 still shrinks and optimises the code.
            isShrinkResources = false
            proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"), "proguard-rules.pro")
            signingConfig = if (releaseSigningAvailable) signingConfigs.getByName("release") else null
        }
    }

    splits {
        // Per-ABI APKs for side-loading (the Rust SDK ships a native library per ABI) plus a
        // universal APK. The AAB is split per ABI by Google Play.
        abi {
            isEnable = true
            reset()
            include("arm64-v8a", "armeabi-v7a", "x86_64", "x86")
            isUniversalApk = true
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    buildFeatures {
        compose = true
        buildConfig = true
    }

    packaging {
        jniLibs {
            // Store native libraries uncompressed and page-aligned (16 KB page support).
            useLegacyPackaging = false
        }
        resources {
            excludes += setOf("/META-INF/{AL2.0,LGPL2.1}", "/META-INF/*.version", "DebugProbesKt.bin")
        }
    }

    lint {
        abortOnError = true
        warningsAsErrors = false
        checkReleaseBuilds = true
        checkDependencies = true
        lintConfig = file("lint.xml")
        xmlReport = true
        htmlReport = true
    }

    testOptions {
        unitTests {
            isReturnDefaultValues = true
        }
    }
}

kotlin {
    compilerOptions {
        jvmTarget.set(JvmTarget.JVM_17)
    }
}

// ---- App Links hosts → generated manifest overlay ---------------------------------------------
// One <data android:host> per configured host. With no hosts, no https intent filter exists at all
// (an empty host would match every https URL).
val generateAppLinksManifest by tasks.registering(GenerateAppLinksManifest::class) {
    hosts.set(lumenAppLinkHosts)
    outputFile.set(layout.buildDirectory.file("generated/applinks/AndroidManifest.xml"))
}

// ---- Bundled call widget (services/chat/dist-widget → assets/call-widget) ---------------------
// If the widget has not been built, the copy is empty and the app says "Calls unavailable in this
// build". The build never fails because of it and never ships a placeholder call UI.
val copyCallWidget by tasks.registering(CopyCallWidget::class) {
    widgetDir.set(rootProject.layout.projectDirectory.dir("../../services/chat/dist-widget"))
    outputDir.set(layout.buildDirectory.dir("generated/callWidgetAssets"))
}

androidComponents {
    onVariants { variant ->
        variant.sources.assets?.addGeneratedSourceDirectory(copyCallWidget, CopyCallWidget::outputDir)
        variant.sources.manifests.addGeneratedManifestFile(generateAppLinksManifest, GenerateAppLinksManifest::outputFile)
    }
}

tasks.named("preBuild") { dependsOn(rootProject.tasks.named("checkNoTlsBypass")) }
tasks.matching { it.name == "check" }.configureEach { dependsOn(rootProject.tasks.named("checkNoTlsBypass")) }
// `:app:testDebugUnitTest` also runs the pure-Kotlin core tests.
tasks.matching { it.name == "testDebugUnitTest" || it.name == "testReleaseUnitTest" }.configureEach {
    dependsOn(":core:test")
}

dependencies {
    implementation(project(":core"))
    implementation(libs.matrix.sdk.android)
    implementation(libs.kotlinx.coroutines.android)

    implementation(platform(libs.androidx.compose.bom))
    implementation(libs.androidx.compose.ui)
    implementation(libs.androidx.compose.ui.graphics)
    implementation(libs.androidx.compose.foundation)
    implementation(libs.androidx.compose.material3)
    implementation(libs.androidx.compose.ui.tooling.preview)
    debugImplementation(libs.androidx.compose.ui.tooling)
    implementation(libs.androidx.activity.compose)
    implementation(libs.androidx.core.ktx)
    implementation(libs.androidx.core.splashscreen)
    implementation(libs.androidx.core.telecom)
    implementation(libs.androidx.lifecycle.runtime.compose)
    implementation(libs.androidx.lifecycle.viewmodel.compose)
    implementation(libs.androidx.lifecycle.process)
    implementation(libs.androidx.lifecycle.service)
    implementation(libs.androidx.webkit)
    implementation(libs.androidx.browser)
    implementation(libs.androidx.biometric)
    implementation(libs.androidx.work.runtime)
    implementation(libs.firebase.messaging)

    testImplementation(libs.junit)
    testImplementation(libs.kotlinx.coroutines.test)

    androidTestImplementation(platform(libs.androidx.compose.bom))
    androidTestImplementation(libs.androidx.compose.ui.test.junit4)
    androidTestImplementation(libs.androidx.test.ext.junit)
    androidTestImplementation(libs.androidx.test.runner)
    androidTestImplementation(libs.androidx.test.rules)
    androidTestImplementation(libs.androidx.test.espresso.core)
    androidTestImplementation(libs.androidx.test.espresso.intents)
    androidTestImplementation(libs.androidx.test.uiautomator)
    debugImplementation(libs.androidx.compose.ui.test.manifest)
}

// ---- Task types --------------------------------------------------------------------------------
abstract class CopyCallWidget : DefaultTask() {
    @get:org.gradle.api.tasks.Internal
    abstract val widgetDir: DirectoryProperty

    @get:org.gradle.api.tasks.InputFiles
    @get:org.gradle.api.tasks.PathSensitive(org.gradle.api.tasks.PathSensitivity.RELATIVE)
    val widgetFiles: FileCollection
        get() = project.files(widgetDir).asFileTree

    @get:org.gradle.api.tasks.OutputDirectory
    abstract val outputDir: DirectoryProperty

    @org.gradle.api.tasks.TaskAction
    fun copy() {
        val out = outputDir.get().asFile
        out.deleteRecursively()
        val target = File(out, "call-widget")
        val src = widgetDir.get().asFile
        if (File(src, "index.html").isFile) {
            src.copyRecursively(target, overwrite = true)
            logger.lifecycle("Call widget bundled from ${src.path}")
        } else {
            out.mkdirs()
            logger.warn("Call widget not found at ${src.path}: this build has no calls (\"Calls unavailable in this build\").")
        }
    }
}

abstract class GenerateAppLinksManifest : DefaultTask() {
    @get:org.gradle.api.tasks.Input
    abstract val hosts: ListProperty<String>

    @get:org.gradle.api.tasks.OutputFile
    abstract val outputFile: RegularFileProperty

    @org.gradle.api.tasks.TaskAction
    fun write() {
        val hostList = hosts.get()
        val filter = if (hostList.isEmpty()) "" else buildString {
            appendLine("        <activity android:name=\".ui.MainActivity\" android:exported=\"true\">")
            appendLine("            <intent-filter android:autoVerify=\"true\">")
            appendLine("                <action android:name=\"android.intent.action.VIEW\" />")
            appendLine("                <category android:name=\"android.intent.category.DEFAULT\" />")
            appendLine("                <category android:name=\"android.intent.category.BROWSABLE\" />")
            appendLine("                <data android:scheme=\"https\" />")
            hostList.forEach { appendLine("                <data android:host=\"$it\" />") }
            appendLine("            </intent-filter>")
            appendLine("        </activity>")
        }
        outputFile.get().asFile.writeText(
            """
            |<?xml version="1.0" encoding="utf-8"?>
            |<!-- Generated from the Gradle property lumen.appLinkHosts. Do not edit. -->
            |<manifest xmlns:android="http://schemas.android.com/apk/res/android">
            |    <application>
            |$filter    </application>
            |</manifest>
            |""".trimMargin(),
        )
    }
}
