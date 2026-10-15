package io.lumen.secure.core

import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

/**
 * ADR 0003 D6: certificate validation is never disabled. Mirrors the Gradle task
 * `checkNoTlsBypass` so the policy is also enforced by `test`.
 */
class TlsPolicyTest {
    @Test
    fun `no source file disables TLS verification`() {
        val androidRoot = generateSequence(File("").absoluteFile) { it.parentFile }
            .firstOrNull { File(it, "settings.gradle.kts").isFile && File(it, "app").isDirectory }
            ?: error("apps/android root not found")
        val forbidden = listOf("disable" + "SslVerification", "disableBuiltIn" + "RootCertificates", "ALLOW_ALL_HOSTNAME_" + "VERIFIER")
        val hits = listOf("app/src", "core/src").map { File(androidRoot, it) }.flatMap { root ->
            root.walkTopDown().filter { it.isFile && it.extension in setOf("kt", "java", "xml") && it.name != "TlsPolicyTest.kt" }
                .flatMap { f -> f.readLines().mapIndexedNotNull { i, line -> forbidden.firstOrNull { line.contains(it) }?.let { "${f.path}:${i + 1}: $it" } } }
                .toList()
        }
        assertTrue("TLS bypass referenced:\n" + hits.joinToString("\n"), hits.isEmpty())
    }
}
