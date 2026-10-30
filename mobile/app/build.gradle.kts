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
        versionCode = 5
        versionName = "1.0.4"

        testInstrumentationRunner = "androidx.test.runner.AndroidJUnitRunner"
        val surveyOrigin = providers.gradleProperty("geoaiSurveyOrigin").orElse("").get()
        buildConfigField("String", "SURVEY_ORIGIN", "\"${surveyOrigin.replace("\\", "\\\\").replace("\"", "\\\"")}\"")
    }

    buildTypes {
        debug {
            // Local fixture only: final APKs leave this empty and use the
            // same public Supabase project as capture. Release ignores it.
            val citizenTestOrigin = providers.gradleProperty("geoaiCitizenTestOrigin").orElse("").get()
            buildConfigField("String", "CITIZEN_TEST_ORIGIN", "\"${citizenTestOrigin.replace("\\", "\\\\").replace("\"", "\\\"")}\"")
        }
        release {
            buildConfigField("String", "CITIZEN_TEST_ORIGIN", "\"\"")
            isMinifyEnabled = false
            proguardFiles(
                getDefaultProguardFile("proguard-android-optimize.txt"),
                "proguard-rules.pro"
            )
            // Sign release builds with the debug keystore so the APK is
            // installable when sideloaded. Replace with a real release
            // keystore before publishing to the Play Store.
            signingConfig = signingConfigs.getByName("debug")
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
        buildConfig = true
    }
    sourceSets.getByName("main").assets.srcDir(layout.buildDirectory.dir("generated/surveyAssets"))
}

// One implementation ships on the web and in Android. Copy at build time so
// the app cannot silently lag behind changes to the survey data contract/UI.
val syncSurveyAssets by tasks.registering(Sync::class) {
    from(rootProject.projectDir.parentFile) {
        include("*.html", "*.js", "*.css", "favicon.svg", "fonts/**")
    }
    into(layout.buildDirectory.dir("generated/surveyAssets/survey"))
}
tasks.named("preBuild").configure { dependsOn(syncSurveyAssets) }

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
    implementation("androidx.webkit:webkit:1.14.0")
    testImplementation(libs.junit)
    androidTestImplementation(libs.androidx.junit)
    androidTestImplementation(libs.androidx.espresso.core)
}
