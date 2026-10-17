# ---- Matrix Rust SDK (uniffi bindings over JNA) ------------------------------------------
# JNA looks up native callbacks and Structure fields by reflection; uniffi generates
# Structure/Callback subclasses and calls them from native code.
-keep class com.sun.jna.** { *; }
-keep class * implements com.sun.jna.** { *; }
-keepclassmembers class * extends com.sun.jna.** { public *; }
-dontwarn java.awt.**
-dontwarn com.sun.jna.**
-keep class org.matrix.rustcomponents.sdk.** { *; }
-keep class uniffi.** { *; }
# JNI from libmatrix_sdk_ffi.so: the SDK's Android init entry point, and rustls-platform-verifier's
# JVM half (looked up by class, method and field name from native code).
-keep class org.matrix.rustsdk.Android { *; }
-keep, includedescriptorclasses class org.rustls.platformverifier.** { *; }

# ---- Kotlin coroutines / serialization -----------------------------------------------------
-dontwarn kotlinx.coroutines.debug.**

# ---- Firebase (only initialised when the build carries FCM identifiers) --------------------
-keep class com.google.firebase.messaging.FirebaseMessagingService { *; }

# ---- Lumen -----------------------------------------------------------------------------------
# Services, receivers and activities are kept by AAPT through the manifest. Nothing else is
# reflective in app code.

# Strip verbose/debug logging calls from release builds (the redacting logger still
# guards these at runtime; this removes the call sites entirely).
-assumenosideeffects class android.util.Log {
    public static int v(...);
    public static int d(...);
}
