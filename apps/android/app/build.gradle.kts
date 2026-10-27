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
val hasReleaseSigning = listOf("storeFile", "storePassword", "keyAlias", "keyPassword")
    .all { !keystoreProperties.getProperty(it).isNullOrBlank() }

android {
    namespace = "com.makerocketgonow.pushthat"
    compileSdk = 36

    defaultConfig {
        applicationId = "com.makerocketgonow.pushthat"
        minSdk = 24
        targetSdk = 36
        versionCode = 8
        versionName = "1.1.0"

        testInstrumentationRunner = "androidx.test.runner.AndroidJUnitRunner"
    }

    signingConfigs {
        if (hasReleaseSigning) {
            create("release") {
                // Relative paths resolve against the repo root, absolute ones are
                // used as given.
                storeFile = rootProject.file(keystoreProperties.getProperty("storeFile"))
                storePassword = keystoreProperties.getProperty("storePassword")
                keyAlias = keystoreProperties.getProperty("keyAlias")
                keyPassword = keystoreProperties.getProperty("keyPassword")
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