<div align="center">

# 📶 WiFi Mapper

**Discover, map, and share the best WiFi spots around you!**

[![Kotlin](https://img.shields.io/badge/Kotlin-1.9+-blue.svg?logo=kotlin)](#)
[![Android](https://img.shields.io/badge/Android-Native-green.svg?logo=android)](#)
[![Firebase](https://img.shields.io/badge/Firebase-Firestore%20%7C%20Auth-orange.svg?logo=firebase)](#)
[![Material Design 3](https://img.shields.io/badge/Material%20Design-3-purple.svg)](#)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](#)

</div>

---

## 🌟 About The Project

Welcome to **WiFi Mapper**! Tired of losing your connection or struggling to find a reliable network while on the go? This community-driven application empowers users to discover, map, and share WiFi networks in their vicinity. 

Built natively for Android using modern development practices, WiFi Mapper combines a sleek user interface with powerful backend technologies to deliver a seamless experience. Whether you're a digital nomad, a student, or just someone who loves free WiFi, this app is your ultimate connectivity companion.

## ✨ Key Features

Based on the core architecture, the app currently supports:

* **🔒 Secure Authentication:** Seamless and secure onboarding using Google Sign-In integration.
* **📍 Location Services:** Pinpoint accuracy for mapping and finding nearby networks, powered by Google Play Location Services.
* **☁️ Real-time Data Sync:** Lightning-fast updates and offline support using Firebase Firestore and Firebase Storage.
* **🎨 Modern UI/UX:** A beautiful, responsive, and accessible interface built with Material Design 3 components (M3), including dynamic colors, bottom sheets, and sleek animations.
* **🌗 Dark/Light Mode:** Full support for system-wide dark and light themes.

## 🛠️ Tech Stack

This project leverages the latest Android development ecosystem:

* **Language:** Kotlin (with Coroutines for asynchronous programming)
* **UI Framework:** Android XML with Material Components
* **Backend:** Firebase (Authentication, Cloud Firestore, Analytics)
* **Architecture:** Clean Architecture with AndroidX Lifecycle components
* **Networking:** gRPC (for Firestore communication)

## 🚀 Getting Started

Want to run the project locally or contribute? Follow these steps!

### Prerequisites
* Android Studio (Latest version recommended)
* JDK 17+
* An Android device or Emulator running API 24+

### Installation

1. **Clone the repository:**
   ```bash
   git clone https://github.com/yourusername/WiFiMapper.git
   cd WiFiMapper
   ```

2. **Set up Firebase:**
   * Go to the [Firebase Console](https://console.firebase.google.com/).
   * Create a new project named `wifimapper-a20b8`.
   * Add an Android app to the project and download the `google-services.json` file.
   * Place the `google-services.json` file in the `app/` directory of this project.
   * Enable **Google Sign-In** in Firebase Authentication.
   * Enable **Firestore Database**.

3. **Build and Run:**
   * Open the project in Android Studio.
   * Sync the Gradle files.
   * Click the **Run** ▶️ button to build and install the app on your device/emulator.

## 🤝 Contributing

We believe in the power of open-source! Contributions are what make the community such an amazing place to learn, inspire, and create. Any contributions you make are **greatly appreciated**.

1. Fork the Project
2. Create your Feature Branch (`git checkout -b feature/AmazingFeature`)
3. Commit your Changes (`git commit -m 'Add some AmazingFeature'`)
4. Push to the Branch (`git push origin feature/AmazingFeature`)
5. Open a Pull Request

## 📜 License

Distributed under the MIT License. See `LICENSE` for more information.

---

<div align="center">
<b>Made with ❤️ by the open-source community.</b><br><br>
If you like this project, please give it a ⭐!
</div>
