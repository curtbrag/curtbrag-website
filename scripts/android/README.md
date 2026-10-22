# Bounded display wake

`CurtPhoneDisplay.java` runs under the existing ordinary Termux UID and its
already-granted `WAKE_LOCK` permission. It does not install an APK, grant
permissions, pair a controller, unlock a screen, change apps, or alter workers.
Its wake lock lasts at most three seconds and is explicitly released.

The dashboard initially enables **phone253 only**. Its private installed DEX is
checked for ownership, restrictive access, size and SHA-256 before each use by
`scripts/cluster-phone253-wake.py`. A missing or different helper fails instead
of installing anything or falling back to pairing.

Build with JDK 17 and Google's R8/D8 8.3.37:

```
javac --release 8 -d classes CurtPhoneDisplay.java
java -cp r8.jar com.android.tools.r8.D8 --min-api 23 --output dex classes/CurtPhoneDisplay.class
```

Reviewed DEX: 8192 bytes, SHA-256
`487d30c5747eec90f506b12e081f48a51815dcd83020321b39b95dfd675bccf4`.
Installed privately on phone253 at
`/data/data/com.termux/files/home/cluster/control/display-wake-20261022/curt-display-487d30c5747e.dex`.
The helper uses the invoking UID's own app context to provide correct package
attribution; it refuses to proceed if the package UID or operation package differs.

Android's compatibility behavior for older target SDKs permits this wake flag
on the tested OS. Other Android/Termux versions may reject it; their permissions
are never modified. Android display state ON is distinct from a verified page,
foreground app, unlocked keyguard or a human observation of physical pixels.
The October 22 live test found phone253 already ON; the request succeeded but
an OFF-to-ON transition has not yet been observed. Two bounded natural-timeout
observations did not see the display sleep; neither forced it off.

References:
- https://developer.android.com/reference/android/os/PowerManager#ACQUIRE_CAUSES_WAKEUP
- https://github.com/LineageOS/android_frameworks_base/blob/lineage-22.2/services/core/java/com/android/server/power/PowerManagerService.java
- https://github.com/LineageOS/android_frameworks_base/blob/lineage-22.2/core/java/android/app/ContextImpl.java
