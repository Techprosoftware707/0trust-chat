pluginManagement {
    repositories {
        google {
            content {
                includeGroupByRegex("com\\.android.*")
                includeGroupByRegex("com\\.google.*")
                includeGroupByRegex("androidx.*")
            }
        }
        // Maven Central through repo1 (repo.maven.apache.org rate-limits shared CI hosts)
        maven("https://repo1.maven.org/maven2/") { name = "MavenCentral" }
        gradlePluginPortal()
    }
}

dependencyResolutionManagement {
    repositoriesMode.set(RepositoriesMode.FAIL_ON_PROJECT_REPOS)
    repositories {
        google {
            content {
                includeGroupByRegex("com\\.android.*")
                includeGroupByRegex("com\\.google.*")
                includeGroupByRegex("androidx.*")
            }
        }
        // Maven Central through repo1 (repo.maven.apache.org rate-limits shared CI hosts)
        maven("https://repo1.maven.org/maven2/") { name = "MavenCentral" }
    }
}

rootProject.name = "lumen-android"
include(":core")
include(":app")
