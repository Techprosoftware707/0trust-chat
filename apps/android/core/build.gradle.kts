// Pure Kotlin/JVM module: protocol, policy and parsing logic that is unit-tested on the JVM
// without Android or the Rust SDK.
import org.jetbrains.kotlin.gradle.dsl.JvmTarget

plugins {
    alias(libs.plugins.kotlin.jvm)
    // Lets the app's lint (checkDependencies) analyse this module too.
    alias(libs.plugins.android.lint)
}

lint {
    abortOnError = true
    warningsAsErrors = false
}

java {
    sourceCompatibility = JavaVersion.VERSION_17
    targetCompatibility = JavaVersion.VERSION_17
}

kotlin {
    compilerOptions {
        jvmTarget.set(JvmTarget.JVM_17)
        allWarningsAsErrors.set(false)
    }
}

// Shared cross-platform test vectors (apps/shared/test-vectors): every app asserts every case.
sourceSets {
    test {
        resources.srcDir(layout.projectDirectory.dir("../../shared/test-vectors"))
    }
}

dependencies {
    api(libs.kotlinx.serialization.json)
    testImplementation(libs.junit)
}

tasks.test {
    useJUnit()
    testLogging {
        events("failed")
        exceptionFormat = org.gradle.api.tasks.testing.logging.TestExceptionFormat.FULL
    }
}
