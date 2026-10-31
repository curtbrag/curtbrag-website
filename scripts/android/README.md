# Bounded display wake

## Ten-minute screen hold (October 30 repair)

The dashboard now uses `scripts/cluster-phone-wake-hold.py` and the `wake-hold`
mode. The earlier three-second helper released immediately after observing ON;
a lock screen could briefly flash and then sleep. The new mode retains the
existing Termux screen wake lock for at most 600,000 ms in a detached process.
It releases automatically, exits on manual screen-off, and never unlocks a
phone. Repeated requests reuse an active hold without extending its deadline.

The runner serializes starts with a private file lock, checks the holder's UID,
process command and deadline, and independently checks display state after four
seconds. The dashboard shows the scheduled expiry rather than claiming a
permanently awake or unlocked screen. A longer independent fleet check is still
needed when validating a deployment; the receipt is a point-in-time observation.

Current hold DEX: `curt-display-0b124dfbcc5c.dex`, 11,012 bytes, SHA-256
`0b124dfbcc5c308dfd36c48248aa09b16863bbefe714d7befab500a0351f6b0c`.
Build all generated `CurtPhoneDisplay*.class` files with D8, including the
display-reader interfaces and anonymous implementation. Preserve the older DEX
and runner for already-queued legacy jobs.

## Earlier one-shot helper

`CurtPhoneDisplay.java` runs under the existing ordinary Termux UID and its
already-granted `WAKE_LOCK` permission. It does not install an APK, grant
permissions, pair a controller, unlock a screen, change apps, or alter workers.
Its wake lock lasts at most three seconds and is explicitly released.

The dashboard supports all eight approved worker phones, individually or in one
batch: phone173, phone174, phone176, phone177, phone191, phone195, phone253 and
phone254. Each phone's private installed DEX is
checked for ownership, restrictive access, size and SHA-256 before each use by
`scripts/cluster-phone-wake.py`. A missing or different helper fails instead
of installing anything or falling back to pairing.

Build with JDK 17 and Google's R8/D8 8.3.37:

```
javac --release 8 -d classes CurtPhoneDisplay.java
java -cp r8.jar com.android.tools.r8.D8 --min-api 23 --output dex classes/CurtPhoneDisplay.class
```

Reviewed DEX: 8192 bytes, SHA-256
`487d30c5747eec90f506b12e081f48a51815dcd83020321b39b95dfd675bccf4`.
Installed privately on each approved phone at
`/data/data/com.termux/files/home/cluster/control/display-wake-20261022/curt-display-487d30c5747e.dex`.
The helper uses the invoking UID's own app context to provide correct package
attribution; it refuses to proceed if the package UID or operation package differs.

Android's compatibility behavior for older target SDKs permits this wake flag
on the tested OS. Other Android/Termux versions may reject it; their permissions
are never modified. Android display state ON is distinct from a verified page,
foreground app, unlocked keyguard or a human observation of physical pixels.
The October 22 remote test succeeded on all eight phones, with each phone
reporting display ON and its bounded wake lock released. Every display was
already ON; an OFF-to-ON transition has not yet been observed. Two earlier
bounded natural-timeout observations on phone253 did not see its display sleep;
neither forced it off. The dashboard reports these outcomes separately.

Busy, offline, ambiguous and missing phone connections are skipped. A submitted
batch is persisted and never replayed automatically. Existing in-flight requests
from the original phone253 control migrate without resubmission. The original
runner remains in the repository for older queued jobs.

References:
- https://developer.android.com/reference/android/os/PowerManager#ACQUIRE_CAUSES_WAKEUP
- https://github.com/LineageOS/android_frameworks_base/blob/lineage-22.2/services/core/java/com/android/server/power/PowerManagerService.java
- https://github.com/LineageOS/android_frameworks_base/blob/lineage-22.2/core/java/android/app/ContextImpl.java
