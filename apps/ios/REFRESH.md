# Daily wireless renewal — Gallery Reader

Current deployment uses the paid account and the shared **monthly** scheduler.
The free app and its daily job/configuration were retired on September 12. See
[paid setup](PAID-NATIVE.md) and [current renewal](/home/visar/Documents/work/reader-extensions/PAID-REFRESH.md);
the daily instructions below are historical.

This is a **macOS user LaunchAgent**, not a Linux systemd service. It runs entirely
on the signing Mac, without the Linux PC, a phone debugger, AltStore or SideStore.
The independent app repos carry the same small stdlib runner and behavior tests;
neither app has a runtime or checkout dependency on the other.

## Policy

- Check every **600 seconds** and at GUI login. Renew when 24 hours have elapsed
  since this app's last successful install, even with many signing days remaining.
- An unreachable/locked phone leaves renewal due. Keep retrying without a retry
  limit. After days away, the next eligible check tries again; availability checks
  cannot guarantee catching an unlock shorter than the check interval.
- Both apps share a Mac advisory signing lock. If one is busy, the other retries.
  A detected existing Xcode build also defers renewal. Do not deliberately start
  a manual build during renewal; stop the job first.
- No Git pull, JavaScript rebuild, app uninstall, data reset, certificate
  revocation, or unrelated profile removal. Same team and bundle IDs are required.
- Only these apps' exact cached provisioning profiles are temporarily moved aside
  to make Xcode request fresh managed profiles. Then perform a full build, verify
  signatures and **every** embedded deadline, and install the complete app.
- Success requires all deadlines to advance and be more than six days away,
  followed by a successful device install. Failure never advances the daily clock.
  Interrupted/failed attempts restore the cached profiles on the next run.
- Inputs are fingerprinted. A changed source/bundle is not silently deployed by
  renewal. Installation uses the same app identity and preserves its data container.

This is not a bypass of Apple's signing restrictions. Account/session errors may
require opening Xcode and signing in again. A phone absent longer than the signing
period can have expired apps until a refresh succeeds.

## Fresh Mac setup

First build and install the app normally using this repo's README. Xcode must
already have the signing account and working Keychain access. Keep the same IDs
when updating an existing installation.

Pair/trust the phone over USB once and enable network connection in Xcode's
Devices and Simulators window. Disconnect USB, leave the phone unlocked on the
same reachable Wi-Fi, and confirm `xcrun devicectl device info details --device
YOUR_IPHONE_UDID` reports a local-network connection. VPN/firewall/client isolation
can prevent discovery. No extra Python package is required by the scheduled job.

Copy `apps/ios/refresh.example.json` to ignored `apps/ios/refresh.local.json`
and set the absolute Mac checkout root, device UDID, team (including the build
environment field), and profile cache path. Keep bundleIds aligned with the Xcode
project. The example cache is current Xcode's user-data directory; inspect your
Xcode installation if using a different version. Never supply signing credentials
in this file. Generated bundles, profiles, local config and state stay private.

From the **repository root**, in the logged-in Mac GUI Terminal:

```sh
/usr/bin/python3 apps/ios/scripts/refresh.py approve --config apps/ios/refresh.local.json
/usr/bin/caffeinate -i /usr/bin/python3 apps/ios/scripts/refresh.py refresh --force --wireless --config apps/ios/refresh.local.json
```

`approve` records the current built-and-delivered baseline, not a renewal.
Only run it after deliberately installing/reviewing that exact build.
The second command must report later deadlines and successful installation.
If invoking remotely, run it in the GUI user session via a one-shot LaunchAgent,
not an SSH session with an inaccessible signing Keychain.

Only after that wireless test succeeds:

```sh
/usr/bin/python3 apps/ios/scripts/install-refresh.py --config apps/ios/refresh.local.json --template apps/ios/launchd/com.visar.gallery-reader-refresh.plist.in
```

The installer requires a recorded wireless success and unchanged inputs, renders
the checked-in template into `~/Library/LaunchAgents/com.visar.gallery-reader-refresh.plist`, and
loads it. It refuses to replace a loaded job. No `sudo` or Linux timer is needed.

The Mac must be awake, logged in, network-connected and able to access its signing
Keychain. `caffeinate -i` prevents idle sleep **during an attempt only**; it does
not wake a sleeping/closed laptop or change permanent power settings. launchd
coalesces missed timer firings on wake; the persisted success timestamp determines
whether renewal is overdue. Phone lock/network state is checked before building;
a disconnect during signing/install remains a failed attempt to retry.

## Status and troubleshooting

From the Mac repository root:

```sh
/usr/bin/python3 apps/ios/scripts/refresh.py status --config apps/ios/refresh.local.json
launchctl print gui/$(id -u)/com.visar.gallery-reader-refresh
tail -40 build/refresh/last-check.log
tail -60 build/refresh/build.log
```

`state.json` stores the last successful install time, exact embedded profile UUIDs
and expiry timestamps, transport, and latest exception. It is not a live query of
phone contents. The check log is overwritten per scheduled attempt, and the Xcode
log per build; there is no growing diagnostic archive. Status output is local
device/signing metadata—do not publish it. A later harmless skip can replace the
check log; lastSuccess/profile dates remain in state.

To pause, first confirm `launchctl print` shows no running PID, then:

```sh
launchctl bootout gui/$(id -u)/com.visar.gallery-reader-refresh
```

This pauses until the next login (the plist is still installed). For a persistent
disable, use `launchctl disable gui/$(id -u)/com.visar.gallery-reader-refresh` too.
Re-enable with `launchctl enable` before bootstrapping again.

For an intentional app update: pause, stage/build/install normally, then run
`approve` against the delivered inputs. Perform the wireless test again and run
the installer. Do not edit the state file to manufacture a successful renewal.
Do not discard `build/refresh/profile-cache-backup` during an interrupted job;
the next attempt uses it for recovery. If recovery reports a filename collision,
inspect the retained files instead of overwriting them blindly.

## Validation and design references

Run behavior checks with:

```sh
python3 -B apps/ios/scripts/test_refresh.py
```

Tests cover daily scheduling, locked/offline phones, an install failure remaining
due, cache recovery, unrelated profiles, stale extension deadlines, and source
changes blocking deployment. They replace Xcode/device boundaries, not iOS itself.

On September 8, 2026, both app jobs completed full Xcode build/sign/install with
USB disconnected and `localNetwork` transport. All six renewed profile UUIDs and
September 15 expiry dates were additionally read back directly from the phone.
Reader Extensions' earliest expiry was 06:17:29 UTC; Gallery Reader's was
06:21:24 UTC. This validates the current setup, not future Apple availability.

The profile-renewal design was checked against
[AltStore's provisioning operation](https://github.com/altstoreio/AltStore/blob/56854e66fef2eac32dad88dcbad1dc131d430e60/AltStore/Operations/FetchProvisioningProfilesOperation.swift)
and
[SideStore's refresh operation](https://github.com/SideStore/SideStore/blob/7195d19a20df4bcb82b6e4ee020f237222a4686b/SideStore/Core/Operations/PipelineOperations/RefreshAppOperation.swift).
Their phone-managed background scheduling is not a fixed macOS polling contract;
600 seconds is our availability/retry choice, while successful renewal is daily.
We delegate signing to Xcode, not their private Apple authentication clients, and
use full app installs rather than SideStore's profile-only refresh optimization.
