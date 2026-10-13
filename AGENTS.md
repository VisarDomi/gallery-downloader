The coding agent owns this repository: any file may be changed, including this one, README.md and test.txt.

## Start here

1. [README.md](README.md): what the app and the PC pipeline are for (the owner's words), and
   the map of every doc.
2. [apps/ios/README.md](apps/ios/README.md): the iPhone app: behaviour the owner relies on,
   rules, code map, storage, build/deploy/test/inspect, renewal, gotchas.
3. [PIPELINE.md](PIPELINE.md): the PC side: downloader, favorites sync, services, commands,
   retries.
4. [NativeKit guide](../../ios-tools/native/README.md): the shared Swift package vendored as
   `apps/ios/Kit`, vendoring, and the rules every app keeps (main thread, relaunch restore,
   FrameMonitor, simulator limits).
5. [Mac and phone access](../../../environment/mac-access.md): `ssh mac`, UDIDs, signing.
6. [Renewal](../../ios-tools/renewal/README.md): the monthly re-signing. Files listed as
   renewal inputs in `apps/ios/scripts/renewal.py` must not be left changed without a deploy.
