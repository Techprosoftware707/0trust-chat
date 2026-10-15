// Root build: plugin versions come from gradle/libs.versions.toml.
plugins {
    alias(libs.plugins.android.application) apply false
    alias(libs.plugins.kotlin.android) apply false
    alias(libs.plugins.kotlin.jvm) apply false
    alias(libs.plugins.kotlin.compose) apply false
}

/**
 * Policy check (ADR 0003 D6, integration.md §2): certificate validation is never disabled.
 * Fails the build if any source file references the Rust SDK's `disableSslVerification`
 * or common TLS-bypass patterns. Wired into `check` and into every app build (preBuild).
 */
val checkNoTlsBypass by tasks.registering {
    group = "verification"
    description = "Fails if TLS verification is disabled anywhere in the app sources."
    val roots = listOf("app/src", "core/src").map { layout.projectDirectory.dir(it) }
    inputs.files(roots.map { fileTree(it) { include("**/*.kt", "**/*.java", "**/*.xml") } })
    val forbidden = listOf(
        "disableSslVerification",
        "disableBuiltInRootCertificates",
        "ALLOW_ALL_HOSTNAME_VERIFIER",
        "TrustAllCerts",
        "cleartextTrafficPermitted=\"true\"",
        "usesCleartextTraffic=\"true\"",
    )
    // The checks below are about our own sources; the test that asserts this policy names the
    // strings it looks for, so it is excluded by file name.
    val allowList = setOf("TlsPolicyTest.kt")
    doLast {
        val hits = mutableListOf<String>()
        roots.forEach { root ->
            root.asFileTree.matching { include("**/*.kt", "**/*.java", "**/*.xml") }.forEach scan@{ f ->
                if (f.name in allowList) return@scan
                f.readLines().forEachIndexed { i, line ->
                    forbidden.filter { line.contains(it) }.forEach { hits += "${f.relativeTo(rootDir)}:${i + 1}: $it" }
                }
            }
        }
        if (hits.isNotEmpty()) throw GradleException("TLS policy violation:\n" + hits.joinToString("\n"))
    }
}
