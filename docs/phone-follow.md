# Follow the personal S26

In the dashboard's **Fleet** view, use **Start following S26**. For up to one hour,
the cluster requests the same public HTTPS link that is visible in Chrome or
Samsung Internet on the registered personal S26. **Stop following** ends capture
and prevents subsequent link requests. Following starts off and does not activate
when the dashboard loads.

The S26 must stay on the home network with its existing authorized wireless
Android connection to the main PC. The main PC must stay running. A personal
phone can operate the dashboard while away, but this local browsing follower
requires the home connection.

Only the visible browser page address is read during an active session. Native
apps, taps, browsing history, cookies and page contents are not copied. Local
addresses, sign-in pages and links containing authentication parameters are
excluded. Opening the dashboard on the S26 is also excluded.

Each new stable link gets one request per available, idle fleet unit. Offline or
busy units are skipped, failed launches are not automatically retried, and the
S26 is never a worker target. The current link and its per-unit report are shown;
the follower does not retain a list of browsed links.

“Launch requested” means the worker requested a browser launch. It does not prove
the physical screen changed, that a video plays, or that playback is synchronized.
Android can still refuse a receiver's background browser launch. Requests already
accepted by workers may finish after Stop.

The separate main-PC helper uses the existing protected bridge configuration.
It polls the opt-in state while off without inspecting the S26. It does not start
Android debugging, reconnect or pair phones, change phone permissions, restart
workers, operate recovery, or enable mining. If the state cannot be read, the
session expires, or the source is unavailable, it fails closed.

Install from the repository's scripts directory in the normal Windows user
context, passing the existing Node 24+ and Android platform-tools executable paths:

```powershell
.\install-cluster-phone-follow-windows.ps1 -NodePath 'C:\path\node.exe' -AdbPath 'C:\path\adb.exe'
```

This creates `CurtClusterPhoneFollow` and starts the helper in a hidden window at
logon. A previously disabled follower task stays disabled when installed again.
It leaves the existing bridge and recovery tasks unchanged.
