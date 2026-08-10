# Primary sources (どこを見て移植するか)

1. **jotd666/galaxian500** — clone at `/workspace/jotd666/galaxian500` (再cloneは
   `GIT_LFS_SKIP_SMUDGE=1 git clone --depth 1 https://github.com/jotd666/galaxian500 /workspace/jotd666/galaxian500`)
   - `src/galaxian.68k` — **Z80全ロジックの逐語68k移植 (7,683行)。挙動の疑問はまずここを grep**
   - `assets/galaxian_gfx.c` — 実ROMタイル/スプライト/CLUT → `src/video/gfx-data.ts` の出典
   - `assets/sounds/*.wav` — 実基板録音 → `public/sounds/` の出典
2. **ScottTunstall/Galaxian** — 注釈付きZ80逆アセンブル。scratchpad に `galaxian.asm` として取得済
   (`curl -sSL https://raw.githubusercontent.com/ScottTunstall/Galaxian/main/galaxian.asm`)
3. **mamedev/mame** `src/mame/galaxian/galaxian_v.cpp` ほか — ハードウェア仕様
   (raw.githubusercontent.com から取得可)

## 移植時の約束

- ルーチンは $アドレス でコメントに出典を残す (例: `$116B`, `$0C3D`)
- バイト演算は `& 0xff` で厳密に。符号付きは `((v&0xff)^0x80)-0x80`
- 近似で済ませた箇所は必ず `docs/fidelity-checklist.md` の Approximated 節に追記
