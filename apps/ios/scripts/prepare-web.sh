#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")/.."
source_dir=../../gallery-server/downloader/public/offline
mkdir -p Resources/Web
cp "$source_dir/app.js" "$source_dir/style.css" Resources/Web/
cp Resources/native.js Resources/Web/
sed -e '/rel="manifest"/d' -e 's|<script type="module" src="/app.js"></script>|<script src="/native.js"></script><script defer src="/app.js"></script>|' \
  "$source_dir/index.html" > Resources/Web/index.html
