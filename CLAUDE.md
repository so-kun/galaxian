# Galaxian faithful recreation — session notes

Namco Galaxian (1979) をブラウザで忠実再現する。ROM不要・TypeScript+Vite。
作業ブランチ: `claude/galaxian-faithful-recreation-270v4g` (常にここへ push)。

## Commands

- `npm run dev` → http://127.0.0.1:5173 / `npm test` (51 tests) / `npm run build`
- スクリーンショット検証: `node <scratchpad>/play2.mjs out.png` (Playwright,
  chromium at `/opt/pw-browsers/chromium-1194/chrome-linux/chrome`)

## Where knowledge lives (context を汚さないための分担)

- `docs/hardware-spec.md` — ハードウェア仕様 (クロック/LFSR/パレット/座標系)
- `docs/fidelity-checklist.md` — 何が正確/近似/未実装かの台帳。**変更したら更新**
- `.claude/skills/verify-fidelity/SKILL.md` — 実機映像との照合手順 (YouTube
  フレーム取得・スペクトログラム比較)
- `.claude/rules/sources.md` — 一次資料リポジトリと参照方法

## Current state (2026-08-11)

- 実ROM由来のグラフィックス/パレット/音声 + 逐語移植の挙動で全面リワーク済み (push済)
- アトラクト完全演出も移植済み: SCRIPT_ONE のタイミング定数そのまま
  (ヘッダ→エイリアン4機がカラムスクロールでテキストを牽引→点滅値→NAMCOロゴ)、
  ROMテキストテーブル (romtext.ts)、DIP設定 (?bonus= ?lives= ?freeplay=、dip.ts)
- 残作業: 参照動画 https://www.youtube.com/watch?v=1bnxQsxvu2U とのフレーム照合。
  ネットワーク許可は設定済み (youtube.com, *.googlevideo.com が通る)。
  yt-dlp はボット検出で失敗 → Playwright 実ブラウザでフレーム取得を試行中。
  **未解決**: Chromium が proxy 経由で ERR_CONNECTION_RESET (curl は 200)。
  `curl -sS "$HTTPS_PROXY/__agentproxy/status"` で診断すること。
- 操作: 矢印/AD=移動, Space/Z=撃つ, 5/C=コイン, 1=1P開始, 2=2P開始
- 既知の近似: デモのAI操作、GAME OVERページ尺、DIPサービスメニュー無し
  (fidelity-checklist の Approximated 節参照)
