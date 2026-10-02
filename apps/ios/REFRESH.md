# Renewal — Gallery Reader

Gallery Reader (`com.visar.GalleryReader.paid`) is renewed monthly by the shared
Mac scheduler in [ios-app-renewal](/home/visar/Documents/work/ios-app-renewal/PAID-REFRESH.md).
This repository only describes the app: `scripts/renewal.py` prints its entry
(bundle ID, build inputs, `scripts/build.sh` builder) for that repository's
`configure-refresh.py`, which reads it from the Mac mirror
`/Users/visar/Developer/gallery-downloader/apps/ios`. Paid setup:
[PAID-NATIVE.md](PAID-NATIVE.md).

The old free-team daily runner, its LaunchAgent template and its tests were
retired on September 12 and removed on October 3; they remain in git history.
