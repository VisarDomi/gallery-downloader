# Gallery Reader: paid native installation

September 12, 2026: the user deleted the free Gallery Reader app and LiveContainer.
Gallery is being installed fresh with team `65U58U86DD` (Erdal) and bundle ID
`com.visar.GalleryReader.paid`. Display name stays **Gallery Reader**, with no
custom icons. No data copy/migration is requested; normal PC favorites loading
will repopulate the new app.

Start with [shared Mac access](/home/visar/Documents/environment/mac-access.md).
Ethernet address: `192.168.1.198`, user `visar`. The Mac mirror remains
`/Users/visar/Developer/gallery-downloader`; no separate paid repo is required.

## Baseline and build

APNs/background work is still paused. The Mac's existing polling runtime matches
the committed baseline `a417a54513a9340fec75d3cc22a21c347d58be26`. All 11 required
Swift/project/native-resource/UI source files were compared with that commit.
The five browser-only offline files missing from the Mac mirror are not app
build inputs. Do not sync the local uncommitted APNs/background draft over this
approved baseline. Keep its source files untouched until that work is resumed.

The existing builder now accepts `GALLERY_BUNDLE_ID` and optional
`SIGNING_DEVICE`. Run in the Mac GUI session for Keychain access:

```sh
DEVELOPMENT_TEAM=65U58U86DD \
GALLERY_BUNDLE_ID=com.visar.GalleryReader.paid \
SIGNING_DEVICE=00008101-000639912881401E \
bash apps/ios/scripts/build.sh
```

The physical `GalleryReader` scheme is used when SIGNING_DEVICE is supplied.
A generic build initially selected the old paid probe profile, which did not
include this phone. Do not install an app solely because Xcode says build
succeeded; verify the team, bundle ID, phone inclusion and expiry first.

Output: `apps/ios/build/Debug-iphoneos/GalleryReader.app`. Verify its full code
signature, profile and bundled Web file hashes, then use `devicectl device
install app --device <UDID> <app>`. Native launch uses
`com.visar.GalleryReader.paid`. No APNs entitlements or background modes are
added by this migration.

## Renewal and recovery

Gallery joins the existing installed-app scheduler with `interval: monthly` and
its paid identity. All eight remaining native apps use the paid account. Free
Gallery and LC configurations are retired, and their old daily LaunchAgents
remain disabled. See the [renewal runbook](/home/visar/Documents/work/reader-extensions/PAID-REFRESH.md)
and [environment recovery copy](/home/visar/Documents/environment/mac-renewal/RECOVERY.md).
The recovery snapshot must register paid Gallery and must not reinstall LC or
reactivate its daily renewal.

Verified: paid installation and launch succeeded, including the phone/profile
preflight and bundled UI checks. The wireless monthly-renewal test then passed,
advancing profile expiry from 2027-09-12 17:25:34 UTC to 17:27:50 UTC. The
shared scheduler now includes this app on the monthly interval. Fresh library
downloads use the existing foreground PC pipeline.

## September 13: approved scroll/retry update, build 8

The user approved only Gallery Reader userscript scroll settlement and image
retry parity; all other comparison items stay as-is. Build 8 changes the shared
`gallery-server/downloader/public/offline/app.js`, advances its PWA shell cache
to v9, and increments the existing Xcode project version. Native Swift, Info.plist,
PC acquisition, offline retention and automatic polling remain on the shipping
baseline above. Never copy the whole dirty local `apps/ios` directory to deploy
this update: its paused background/APNs files remain unrelated drafts.

Verified shipping inputs against baseline `a417a54513a9340fec75d3cc22a21c347d58be26`
before copying only the shared app.js, sw.js and versioned project. Build/sign
through a GUI LaunchAgent with the existing paid identity, updating the app in
place. The normal build has no icon, push entitlement or background modes.

For this update's physical inspection, an archived normal build was followed by
a temporary build with `webView.isInspectable = true` in the Mac's WebController.
That line is diagnostic-only: restore the baseline Swift file, install the
archived normal build, and renew from the restored sources. Do not leave or
approve that temporary inspection change as a shipping input. The verification
record is `approved-reader-sync-verification.json`.

Build 8 normal installation and monthly renewal passed. Approved inputs and all
four bundled Web assets match; the scheduler is active/idle with last exit 0.
The verification record includes profile expiry and next due time. Existing
reading data remained available; no uninstall or data migration was performed.


## September 13: disable image selection and long-press menus

All `img` elements and image-containing links use `-webkit-touch-callout: none`,
`user-select: none` (including WebKit's prefix), and `-webkit-user-drag: none`.
This includes covers, thumbnails, previews and reader pages. Taps and native
scroll gestures remain enabled; no touch listener or gesture interception was
added. Apple's [Safari CSS reference](https://developer.apple.com/library/archive/documentation/AppleApplications/Reference/SafariCSSRef/Articles/StandardCSSProperties.html)
documents the callout property.

The shared offline `style.css` contains the same all-image rule. The PWA shell
cache advances to v10 so existing clients receive it, and the native app uses
build 9. Only CSS, the cache version and project build number were copied to the
Mac after comparing its shipping baseline. Paused APNs/background drafts remain
untouched. Browser checks verified image selection/drag, taps, text editing and
scrolling.
