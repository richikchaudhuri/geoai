plugins {
    alias(libs.plugins.android.application)
    alias(libs.plugins.kotlin.android)
}

android {
    namespace = "com.example.msc"
    compileSdk {
        version = release(36)
    }

    defaultConfig {
        applicationId = "com.example.msc"
        // Android 8.0 (Oreo, API 26) — covers ~94% of active devices.
        // Was 34 (Android 14+) which excluded most users. CameraX,
        // FusedLocation, and OSMDroid all support API 26+.
        minSdk = 26
        targetSdk = 36
        versionCode = 1
        versionName = "1.0"

        testInstrumentationRunner = "androidx.test.runner.AndroidJUnitRunner"
    }

    buildTypes {
        release {
            // Strip debug info, obfuscate Kotlin/Java class & method names,
            // and shrink unused code from the APK. Makes reverse-engineering
            // the AI-pipeline endpoints, request shapes, and credentials
            // dramatically more painful.
            isMinifyEnabled = true
            isShrinkResources = true
            proguardFiles(
                getDefaultProguardFile("proguard-android-optimize.txt"),
                "proguard-rules.pro"
            )
            // Sign release builds with the debug keystore so the APK is
            // installable when sideloaded. Replace with a real release
            // keystore before publishing to the Play Store.
            signingConfig = signingConfigs.getByName("debug")
        }
        debug {
            // Debug builds are explicitly distinguishable so we can detect
            // tampered "release-ish" debug APKs in logs.
            applicationIdSuffix = ".debug"
            versionNameSuffix = "-DEBUG"
        }
    }
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_11
        targetCompatibility = JavaVersion.VERSION_11
    }
    kotlinOptions {
        jvmTarget = "11"
    }
    buildFeatures {
        viewBinding = true
    }
}

dependencies {
    implementation(libs.androidx.core.ktx)
    implementation(libs.androidx.appcompat)
    implementation(libs.material)
    implementation(libs.androidx.activity)
    implementation(libs.androidx.constraintlayout)
    implementation(libs.androidx.camera.core)
    implementation(libs.androidx.camera.camera2)
    implementation(libs.androidx.camera.lifecycle)
    implementation(libs.androidx.camera.view)
    implementation(libs.play.services.location)
    implementation(libs.osmdroid)
    implementation(libs.androidx.exifinterface)
    implementation(libs.okhttp)
    implementation(libs.kotlinx.coroutines.android)
    implementation(libs.androidx.lifecycle.runtime.ktx)
    testImplementation(libs.junit)
    androidTestImplementation(libs.androidx.junit)
    androidTestImplementation(libs.androidx.espresso.core)
}