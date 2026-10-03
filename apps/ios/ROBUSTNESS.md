# September 22 recovery pass — Gallery Reader build 11

The shipping downloader already retries catalog/download work on network return
and every 30 seconds while foregrounded. Reopening reloads committed images and
pending work from disk. Exact file-size validation and atomic replacement reject
partial images without damaging completed files. Offline galleries remain usable.
This pass makes TransferGate remove canceled queued requests immediately rather
than leaving them behind stalled active transfers.



To test the shipping version while that WIP exists, stage apps/ios from git HEAD
in a temporary directory and run its committed scripts/test.sh on the Mac. Tests
cover queue cancellation/priority, partial-file rejection, atomic replacement,
offline libraries and persistent reader/library positions. The existing optional
`--integration` suite transfers real LAN fixture galleries; it is not required
for the offline deterministic suite.

## Physical validation

All provider builds were installed in place using their existing paid identities.
See `robustness-verification.json` for sanitized results. Home reopened on the same page/offset with all 3,464 thumbnails loaded; reader reopened with all 151 images loaded and Back returned Home. Inspection used a temporary diagnostic toggle, then restored the normal shipping build.

The existing monthly runner successfully renewed every delivered provider build,
retaining the same app identities/data. The scheduler is resumed and its installed-app
scan exits successfully. No new background item or power-setting change was made.
