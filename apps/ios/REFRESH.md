# Renewal — Gallery Reader

Gallery Reader (`com.visar.GalleryReader.paid`) renews monthly through this
repository's own Mac scheduler, `com.visar.renewal.gallery-downloader`, which runs
the shared [ios-tools renewal](../../../../ios-tools/renewal/PAID-REFRESH.md) runner.
`scripts/renewal.py` lists the app (bundle ID, build inputs, `scripts/build.sh`
builder); register it from the Mac mirror
`/Users/visar/Developer/gallery-downloader/apps/ios`. Paid setup:
[PAID-NATIVE.md](PAID-NATIVE.md).
