plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

android {
    namespace = "com.computermcp.app"
    compileSdk = 36
    defaultConfig {
        applicationId = "com.computermcp.app"
        minSdk = 24
        targetSdk = 35
        versionCode = 10
        versionName = "0.6.7"
    }
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions { jvmTarget = "17" }
}

dependencies {
    implementation("com.journeyapps:zxing-android-embedded:4.3.0")
    // The scanner calls androidx.core at runtime but does not bring it along.
    implementation("androidx.core:core:1.13.1")
}
