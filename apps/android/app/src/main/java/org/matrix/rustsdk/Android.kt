package org.matrix.rustsdk

import android.content.Context

/**
 * JNI entry point exported by the Matrix Rust SDK's native library
 * (`Java_org_matrix_rustsdk_Android_init` in libmatrix_sdk_ffi.so, from
 * bindings/matrix-sdk-ffi/src/platform/android_platform.rs). It hands the JVM and the application
 * context to the SDK; rustls-platform-verifier needs both to verify TLS certificates through
 * Android's trust manager ([org.rustls.platformverifier.CertificateVerifier]). Without it every
 * HTTPS request of the SDK fails ("Expect rustls-platform-verifier to be initialized").
 *
 * The SDK AAR does not ship this class, so the app declares it with exactly this name. Called once,
 * before `initPlatform`, by [io.lumen.secure.matrix.RustPlatform].
 */
object Android {
    init {
        // JNA loads the library for the uniffi calls, but JNI only binds native methods of
        // libraries loaded through System.loadLibrary.
        System.loadLibrary("matrix_sdk_ffi")
    }

    @JvmStatic
    external fun init(context: Context)
}
