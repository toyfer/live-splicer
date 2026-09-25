# core/

`ffmpeg-core.js` と `ffmpeg-core.wasm` はリポジトリにコミットしません。
GitHub Pages のデプロイ（`.github/workflows/pages.yml`）が、公開物を組み立てるときに
`@ffmpeg/core@0.12.10` の UMD 版を jsDelivr から取得して `core/` に置きます。

取得元:

```text
https://cdn.jsdelivr.net/npm/@ffmpeg/core@0.12.10/dist/umd/ffmpeg-core.js
https://cdn.jsdelivr.net/npm/@ffmpeg/core@0.12.10/dist/umd/ffmpeg-core.wasm
```

wasm が 1MB 未満なら、壊れた取得とみなしてデプロイを止めます。

ローカルで `index.html` を開いて試すときだけ、同じ 2 ファイルをこのディレクトリに置いてください。
