# Gallery Downloader

iOS (offline) app that downloads and views galleries from your pc. it's also a full pipeline which listens to [gallery-reader](https://github.com/VisarDomi/gallery-reader) to get the list of favorites from that and downloads them locally. these local galleries are then used by the ios app to load them there and the pipeline completes.

## what?
this app needs a network connection to the local network where your pc is to download the galleries first. downloads keep going while the phone is locked or the app is in the background. when downloads are finished, it works fully offline

## why?
offline apps are king.

## how?
the ios app is straightforward, it consumes the galleries that are on the local network pc. the pc setup is a small pipeline. it lists/syncs/backups favorites. uses that list to download the actual galleries locally. it communicates with the ios app if needed.

## setup

[PIPELINE.md](./PIPELINE.md)

## Docs

- [AGENTS.md](AGENTS.md): ownership and where to start.
- [PIPELINE.md](PIPELINE.md): the PC pipeline: layout, services, commands, boundaries,
  retries, thumbnails.
- [apps/ios/README.md](apps/ios/README.md): the iPhone app: behaviour, rules, code map,
  storage and downloads, build/deploy/test/inspect, renewal, gotchas.
- Shared, outside this repository: [NativeKit guide](../../ios-tools/native/README.md),
  [renewal](../../ios-tools/renewal/README.md),
  [Mac and phone access](../../../environment/mac-access.md).
- Earlier docs (`notes.md`, `decisions.md`, `apps/ios/{PAID-NATIVE,REFRESH,ROBUSTNESS}.md`,
  and the WebKit version's before them) are in git history: `git show d41efe9:<path>`.
