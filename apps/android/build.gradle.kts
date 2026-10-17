// Root build: plugin versions come from gradle/libs.versions.toml.
plugins {
    alias(libs.plugins.android.application) apply false
    alias(libs.plugins.android.lint) apply false
    alias(libs.plugins.kotlin.android) apply false
    alias(libs.plugins.kotlin.jvm) apply false
    alias(libs.plugins.kotlin.compose) apply false
}

/**
 * Policy check (ADR 0003 D6, integration.md §2): certificate validation is never disabled.
 * Fails the build if any source file references the Rust SDK's `disableSslVerification`
 * or common TLS-bypass patterns. Wired into `check` and into every app build (preBuild).
 *
 * Plain http: allowed only (a) to loopback hosts in the debug network security config, and (b) to
 * the CAs' CRL distribution hosts listed in app/crl-hosts.txt, in one <domain-config> per network
 * security config that lists exactly those hosts and nothing else (the Rust SDK's certificate
 * verifier fetches CRLs, which their CA signs, over http).
 */
val checkNoTlsBypass by tasks.registering {
    group = "verification"
    description = "Fails if TLS verification is disabled anywhere in the app sources."
    val roots = listOf("app/src", "core/src").map { layout.projectDirectory.dir(it) }
    val crlHostsFile = layout.projectDirectory.file("app/crl-hosts.txt")
    inputs.files(roots.map { fileTree(it) { include("**/*.kt", "**/*.java", "**/*.xml") } })
    inputs.file(crlHostsFile)
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
        val crlHosts = crlHostsFile.asFile.readLines().map { it.trim() }.filter { it.isNotEmpty() && !it.startsWith("#") }
        require(crlHosts.isNotEmpty() && crlHosts.all { Regex("^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$").matches(it) }) {
            "app/crl-hosts.txt must list host names only"
        }
        val cleartextBlock = Regex("<domain-config cleartextTrafficPermitted=\"true\">(.*?)</domain-config>", RegexOption.DOT_MATCHES_ALL)
        val domain = Regex("<domain includeSubdomains=\"(true|false)\">([^<]+)</domain>")
        val comment = Regex("<!--.*?-->", RegexOption.DOT_MATCHES_ALL)
        val loopback = setOf("localhost", "127.0.0.1")
        val hits = mutableListOf<String>()
        roots.forEach { root ->
            root.asFileTree.matching { include("**/*.kt", "**/*.java", "**/*.xml") }.forEach scan@{ f ->
                if (f.name in allowList) return@scan
                // Debug builds may talk plain http to loopback hosts only (network_security_config
                // in src/debug), matching UrlPolicy's debug rule.
                val debugNetworkConfig = f.invariantSeparatorsPath.endsWith("app/src/debug/res/xml/network_security_config.xml")
                var text = f.readText()
                if (f.name == "network_security_config.xml") {
                    // Approved plain-http blocks are blanked (line breaks kept) before the scan;
                    // any other cleartextTrafficPermitted="true" is a violation.
                    cleartextBlock.findAll(text).toList().forEach { m ->
                        val inner = comment.replace(m.groupValues[1], "")
                        val entries = domain.findAll(inner).map { it.groupValues[1] to it.groupValues[2].trim() }.toList()
                        val onlyDomains = domain.replace(inner, "").isBlank() && entries.isNotEmpty()
                        val crlBlock = onlyDomains && entries.all { it.first == "true" } && entries.map { it.second } == crlHosts
                        val loopbackBlock = onlyDomains && debugNetworkConfig && entries.all { it.first == "false" && it.second in loopback }
                        if (crlBlock || loopbackBlock) {
                            text = text.replace(m.value, m.value.replace(Regex("[^\n]"), ""))
                        } else if (entries.any { it.second in crlHosts }) {
                            hits += "${f.relativeTo(rootDir)}: the CRL hosts block must list exactly app/crl-hosts.txt (includeSubdomains=\"true\"), nothing else"
                        }
                    }
                }
                text.lines().forEachIndexed { i, line ->
                    forbidden.filter { line.contains(it) }.forEach { hits += "${f.relativeTo(rootDir)}:${i + 1}: $it" }
                }
            }
        }
        if (hits.isNotEmpty()) throw GradleException("TLS policy violation:\n" + hits.joinToString("\n"))
    }
}
