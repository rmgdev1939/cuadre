plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

android {
    namespace = "app.cuadre.escucha"
    compileSdk = 34

    defaultConfig {
        applicationId = "app.cuadre.escucha"
        minSdk = 26
        targetSdk = 34
        versionCode = 1
        versionName = "0.1-prueba"
    }

    buildTypes {
        release {
            isMinifyEnabled = false
        }
    }
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions {
        jvmTarget = "17"
    }
}
