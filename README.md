# VolleyMotion Lab 1.0

30fpsのサーブ動画から、手とボールの接触条件・打ち出し方向・軌道変化を調べるブラウザアプリです。

## GitHub Pagesへの公開

1. このフォルダ内の `index.html` `styles.css` `app.js` `README.md` をリポジトリ直下へアップロードします。
2. GitHubの Settings → Pages を開きます。
3. Sourceを「Deploy from a branch」、Branchを `main`、Folderを `/(root)` にします。
4. 公開URLを開き、タイトルが `VolleyMotion Lab 1.0` であることを確認します。

## 操作

1. MP4をクリック選択または点線枠へドロップ。
2. コマ送りで接触場面へ移動し「現在を接触フレームに設定」。
3. 画面の案内に沿って6点をクリック。
4. 「ボールを自動追跡」。
5. 軌跡を確認して「結果を計算」。

動画はブラウザ内で処理し、外部サーバーへアップロードしません。
