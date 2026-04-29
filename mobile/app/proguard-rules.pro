# ──────────────────────────────────────────────────────────────────────
# GeoAI mobile — ProGuard / R8 rules for release builds
# ──────────────────────────────────────────────────────────────────────
# Goals:
#   - Aggressively strip & obfuscate our own Kotlin/Java code
#   - Keep just enough of CameraX / OSMDroid / Play Services Location /
#     OkHttp / Coroutines for runtime reflection paths to work
#   - Preserve enough debugging info to read crash reports without
#     re-exposing class names

# Preserve line numbers for debuggable crashes; hide the source file name
-keepattributes SourceFile,LineNumberTable,Signature,*Annotation*,EnclosingMethod,InnerClasses
-renamesourcefileattribute SourceFile

# Don't strip log calls — keep crash diagnostics. Comment these out if
# you'd rather strip Log.d / Log.v from release for a tiny size win.
# -assumenosideeffects class android.util.Log {
#     public static *** d(...);
#     public static *** v(...);
# }

# ── Project code ──────────────────────────────────────────────────────
# Keep the activity classes referenced by AndroidManifest.xml; everything
# else under com.example.msc.** is fair game for renaming.
-keep class com.example.msc.MainActivity { *; }
-keep class com.example.msc.SplashActivity { *; }
-keep class com.example.msc.CropActivity { *; }
-keep class com.example.msc.CropImageView { <init>(...); }

# View-binding classes are referenced reflectively
-keep class **.databinding.** { *; }

# ── CameraX ───────────────────────────────────────────────────────────
-keep class androidx.camera.** { *; }
-dontwarn androidx.camera.**

# ── Google Play Services Location ─────────────────────────────────────
-keep class com.google.android.gms.location.** { *; }
-dontwarn com.google.android.gms.**

# ── OSMDroid (map view) ───────────────────────────────────────────────
-keep class org.osmdroid.** { *; }
-dontwarn org.osmdroid.**

# ── OkHttp (network) ──────────────────────────────────────────────────
-dontwarn okhttp3.**
-dontwarn okio.**
-dontwarn org.conscrypt.**

# ── Kotlin / Coroutines ───────────────────────────────────────────────
-dontwarn kotlinx.coroutines.**
-keep class kotlinx.coroutines.android.** { *; }
-keepclassmembernames class kotlinx.** {
    volatile <fields>;
}

# ── AndroidX core / lifecycle ─────────────────────────────────────────
-keep class androidx.lifecycle.** { *; }
-keep class * implements androidx.lifecycle.LifecycleObserver { *; }
-keepclassmembers class * extends androidx.lifecycle.ViewModel {
    <init>(...);
}

# ── ExifInterface ─────────────────────────────────────────────────────
-keep class androidx.exifinterface.** { *; }

# ── Generic Android best-practices ────────────────────────────────────
-keep class * extends android.app.Application { *; }
-keep class * extends android.app.Activity { *; }
-keep class * extends android.content.BroadcastReceiver { *; }
-keep class * extends android.app.Service { *; }
-keep class * extends android.content.ContentProvider { *; }
-keepclassmembers class * extends android.app.Activity {
    public void *(android.view.View);
}
-keepclassmembers enum * { *; }
-keepclasseswithmembers class * {
    native <methods>;
}
-keepclassmembers class * implements android.os.Parcelable {
    public static final android.os.Parcelable$Creator CREATOR;
}
