buildscript {
    repositories {
        google()
        mavenCentral()
    }
    dependencies {
        // AGP 9.4's built-in Kotlin support bundles Kotlin Gradle Plugin 2.2.10.
        // Without this the project would silently drop from the 2.2.21 it
        // compiled with under AGP 8. Version catalog accessors aren't available
        // inside buildscript blocks, so the version is spelled out here.
        classpath("org.jetbrains.kotlin:kotlin-gradle-plugin:2.2.21")
    }
}

// Top-level build file where you can add configuration options common to all sub-projects/modules.
plugins {
    alias(libs.plugins.android.application) apply false
    alias(libs.plugins.ksp) apply false
    alias(libs.plugins.google.services) apply false
}