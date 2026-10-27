import java.util.Properties

plugins {
    id("com.android.application")
    id("com.google.gms.google-services")
    id("com.google.devtools.ksp")
}

// Release signing credentials live in keystore.properties, which is not checked
// in. See keystore.properties.example. Without it the release build is simply
// left unsigned, so a fresh clone still builds.
val keystoreProperties = Properties().apply {
    val file = rootProject.file("keystore.properties")
    if (file.exists()) file.inputStream().use { load(it) }
}

// CI has no keystore.properties, so each value can also come from the environment
// (.github/workflows/android.yml). Environment variables rather than CI writing the
// file: a password containing a backslash or a colon means something else to
// Properties, and would sign with the wrong value or not at all. The file wins
// when both are set, so a local build is never steered by a stray export.
fun signing(key: String, env: String): String? =
    (keystoreProperties.getProperty(key) ?: System.getenv(env))?.takeUnless { it.isBlank() }

val releaseStoreFile = signing("storeFile", "PUSHTHAT_KEYSTORE_PATH")
val releaseStorePassword = signing("storePassword", "PUSHTHAT_KEYSTORE_PASSWORD")
val releaseKeyAlias = signing("keyAlias", "PUSHTHAT_KEY_ALIAS")
val releaseKeyPassword = signing("keyPassword", "PUSHTHAT_KEY_PASSWORD")
val hasReleaseSigning = listOf(releaseStoreFile, releaseStorePassword, releaseKeyAlias, releaseKeyPassword)
    .all { it != null }

android {
    namespace = "com.makerocketgonow.pushthat"
    compileSdk = 36

    defaultConfig {
        applicationId = "com.makerocketgonow.pushthat"
        minSdk = 24
        targetSdk = 36
        /*
         * Every bundle Play accepts needs a version code it has not seen, so CI passes one
         * that only rises (the workflow says how it is derived). A local build keeps 8,
         * the code this file carried before CI took over, which Play will not take
         * again: bundles for Play come from CI now.
         */
        versionCode = System.getenv("PUSHTHAT_VERSION_CODE")?.toIntOrNull() ?: 8
        versionName = "1.2.0"

        testInstrumentationRunner = "androidx.test.runner.AndroidJUnitRunner"
    }

    signingConfigs {
        if (hasReleaseSigning) {
            create("release") {
                // Relative paths resolve against the repo root, absolute ones are
                // used as given.
                storeFile = rootProject.file(releaseStoreFile!!)
                storePassword = releaseStorePassword
                keyAlias = releaseKeyAlias
                keyPassword = releaseKeyPassword
            }
        }
    }

    buildTypes {
        release {
            signingConfig = signingConfigs.findByName("release")
            isMinifyEnabled = false
            proguardFiles(
                getDefaultProguardFile("proguard-android-optimize.txt"),
                "proguard-rules.pro"
            )
        }
    }
    testOptions {
        unitTests.all { test ->
            // E2eeVectorsTest checks the crypto against the reference's vectors where the
            // reference writes them, so they cannot go stale in a copy. Declared as an
            // input so that a change to the vectors reruns the tests.
            val vectors = rootProject.file("../../packages/push-test/vectors.json")
            test.inputs.file(vectors).withPropertyName("e2eeVectors")
            test.systemProperty("pushthat.e2eeVectors", vectors.absolutePath)
        }
    }
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
}

kotlin {
    compilerOptions {
        // Must stay in step with compileOptions above; AGP does not derive one
        // from the other, and a mismatch fails the build.
        jvmTarget = org.jetbrains.kotlin.gradle.dsl.JvmTarget.JVM_17
    }
}

dependencies {

    implementation(libs.androidx.core.ktx)
    implementation(libs.androidx.appcompat)
    implementation(libs.material)
    implementation("com.google.android.gms:play-services-base:18.10.1")
    implementation(platform("com.google.firebase:firebase-bom:34.18.0"))
    implementation("com.google.firebase:firebase-analytics")
    implementation("com.google.firebase:firebase-auth")
    implementation("com.google.firebase:firebase-firestore")
    implementation("com.google.firebase:firebase-storage")
    implementation("com.google.firebase:firebase-messaging")
    implementation("com.github.bumptech.glide:glide:5.0.7")
    implementation("androidx.swiperefreshlayout:swiperefreshlayout:1.2.0")

    // Used directly by our own code and layouts. These arrive transitively via
    // appcompat/material/firebase anyway, but relying on that means a dependency
    // update elsewhere can silently take them away.
    implementation("androidx.recyclerview:recyclerview:1.4.0")
    implementation("androidx.constraintlayout:constraintlayout:2.2.2")
    implementation("androidx.localbroadcastmanager:localbroadcastmanager:1.1.0")
    implementation("androidx.lifecycle:lifecycle-runtime-ktx:2.11.0")
    implementation("androidx.lifecycle:lifecycle-viewmodel-ktx:2.11.0")
    implementation("org.jetbrains.kotlinx:kotlinx-coroutines-android:1.11.0")

    testImplementation(libs.junit)
    testImplementation(libs.org.json)
    androidTestImplementation(libs.androidx.junit)
    androidTestImplementation(libs.androidx.espresso.core)

    val roomVersion = "2.8.4"
    val workVersion = "2.11.2"

    // Room dependencies
    implementation("androidx.room:room-runtime:$roomVersion")
    ksp("androidx.room:room-compiler:$roomVersion")
    implementation("androidx.room:room-ktx:$roomVersion")

    // WorkManager dependency
    implementation("androidx.work:work-runtime-ktx:$workVersion")

    // Coroutines for Firebase Tasks
    implementation("org.jetbrains.kotlinx:kotlinx-coroutines-play-services:1.11.0")

    // HTTP and HTML parsing dependencies
    implementation("com.squareup.okhttp3:okhttp:5.4.0")
    implementation("org.jsoup:jsoup:1.23.2")

    // URL validation
    implementation("commons-validator:commons-validator:1.11.0")
}