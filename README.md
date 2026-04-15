# what

A gallery management repo, to download and view galleries.

# why

I usually had to use multiple tools to download and view galleries, making the experience feel clunky. This monorepo makes it so you use the pc+phone combo to make gallery management usable only from the phone.

# how

This monorepo uses gallery-dl as the base to manage downloads and builds on top of that. I forked that repo to make it download thumbnails as well. And have a indexing system to keep lookup times from the frontend feel near instant. And a sync system which keeps tracked queries uptodate with the target website which has the galleries you download from. The .txt files that track the queries are managed by the frontend as well, so that you can use this app purely from the frontend after setup.

# manifest setup

The live manifest files are private and should stay local:

- `gallery-server/artists.txt`
- `gallery-server/filters.txt`
- `gallery-server/queries.txt`

To set them up:

1. Copy each example file and remove the `.example` suffix.
2. Put whatever private content you want in the live files.

Example:

- `gallery-server/artists.txt.example` -> `gallery-server/artists.txt`
- `gallery-server/filters.txt.example` -> `gallery-server/filters.txt`
- `gallery-server/queries.txt.example` -> `gallery-server/queries.txt`
