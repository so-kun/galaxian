---
name: verify-fidelity
description: 実機映像 (YouTube) と本実装を突き合わせて差異を特定する手順。フレーム抽出、スクリーンショット比較、音声スペクトログラム照合。ユーザーが「動画と比較して」「実機と違う」と言ったときに使う。
---

# 実機映像との照合手順

参照動画: https://www.youtube.com/watch?v=1bnxQsxvu2U (実基板のプレイ映像)

## 前提

- 環境の Network access は Custom で youtube.com / www.youtube.com /
  *.googlevideo.com / i.ytimg.com を許可済み (curl で 200 を確認済み)
- `yt-dlp` は pip 導入済みだが**ボット検出で失敗する** (cookie なしのため)。
  `player_client=tv` は DRM 表示、`web_embedded` は storyboard のみ
- ffmpeg: `/opt/pw-browsers/ffmpeg-1011/ffmpeg-linux`

## フレーム取得 (未解決の問題あり)

Playwright 実ブラウザで embed を再生し video 要素を screenshot する方式。
スクリプト: scratchpad の `ytframes.mjs` (`node ytframes.mjs <prefix> <t秒>...`)

**未解決**: Chromium が proxy (`http://127.0.0.1:32937`) 経由で全 HTTPS に
`ERR_CONNECTION_RESET`。curl は同じ URL で 200。試したこと: launch の proxy
オプション指定、`--ignore-certificate-errors`, `--disable-quic`,
`ignoreHTTPSErrors`。次に試すこと:
`curl -sS "$HTTPS_PROXY/__agentproxy/status"` の per-tool fixes、
`--proxy-server` を args で直接渡す、`headless: false` 相当の
`channel`/新ヘッドレス (`--headless=new`)、HTTP/1.1 強制。

## 取得できたら

1. 動画 10s 以降からゲームプレイのフレームを 5〜10 枚抽出
2. `play2.mjs` で本実装の同等場面を撮影
3. 並べて比較: 隊形の形/色、スイープ速度、急降下の軌道 (S字の振幅)、
   爆発の見た目、HUD配置、弾の見た目
4. 音声: ffmpeg で動画音声を wav 化 → スペクトログラム PNG 化 →
   `public/sounds/*.wav` の同処理と目視比較
5. 差異は `docs/fidelity-checklist.md` に記録してから修正
