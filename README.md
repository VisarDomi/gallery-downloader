# Gallery Downloader

iOS (offline) app that downloads and views galleries from your pc. it's also a full pipeline which listens to [gallery-reader](https://github.com/VisarDomi/gallery-reader) to get the list of favorites from that and downloads them locally. these local galleries are then used by the ios app to load them there and the pipeline completes.

## what?
this app needs a network connection to the local network where you pc is to download the galleries first. when downloads are finished, it works fully offline

## why?
offline apps are king.

## how?
the ios app is straightforward, it consumes the galleries that are on the local network pc. the pc setup is a small pipeline. it lists/syncs/backups favorites. uses that list to download the actual galleries locally. it communicates with the ios app if needed.

## setup

[notes.md](./notes.md)
