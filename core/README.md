# core/ — ffmpeg-core を置く場所

このアプリは `core/ffmpeg-core.js` と `core/ffmpeg-core.wasm` を読み込みます。
**同一オリジンから読むのが最も確実**（CORS の心配がなく、2 回目以降はブラウザキャッシュが効きます）なので、
リポジトリに同梱して GitHub Pages から配信する構成を推奨します。

## 入手方法（どちらか）

### 1) curl で取る

```bash
mkdir -p core
curl -L -o core/ffmpeg-core.js   https://cdn.jsdelivr.net/npm/@ffmpeg/core@0.12.10/dist/umd/ffmpeg-core.js
curl -L -o core/ffmpeg-core.wasm https://cdn.jsdelivr.net/npm/@ffmpeg/core@0.12.10/dist/umd/ffmpeg-core.wasm
ls -lh core
```

### 2) npm で取る

```bash
npm i @ffmpeg/core@0.12.10
cp node_modules/@ffmpeg/core/dist/umd/ffmpeg-core.js   core/
cp node_modules/@ffmpeg/core/dist/umd/ffmpeg-core.wasm core/
```

`ffmpeg-core.wasm` は 30MB 前後あります。GitHub の 1 ファイル 100MB 制限には収まりますが、
リポジトリが重くなる点は許容してください。

## CDN から直接読む場合

`app.js` の先頭を書き換えると、コアを CDN から読むこともできます（リポジトリが軽くなる代わりに、
初回読み込みがネットワーク依存になります）。

```js
coreSource: "cdn",
```

## 注意

- `core/` の中身を消すとアプリは動きません。エラーが出たらこのファイルの手順をやり直してください。
- `ffmpeg-core.worker.js` はマルチスレッド版（`@ffmpeg/core-mt`）用です。このアプリはシングルスレッド版を使うため不要です。
