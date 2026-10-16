# XZY IDE

Editor kode agentik untuk Windows. Agen AI-nya memakai API key dari [TokenomixAI](https://tokenomixai.com/): bisa membaca proyek, menulis dan mengedit berkas, menjalankan perintah terminal, lalu memverifikasi hasilnya.

## Unduh

Installer terbaru ada di halaman [Releases](https://github.com/Igustisultanh12/xzy-ide/releases/latest):

- `XZY-IDE-Setup-<versi>.exe` - installer biasa (disarankan)
- `XZY-IDE-<versi>.msi` - paket MSI (untuk deploy lewat kebijakan/IT)

Installer belum ditandatangani sertifikat code signing, jadi Windows SmartScreen bisa menampilkan peringatan. Pilih **More info** lalu **Run anyway**.

## Mulai

1. Buka XZY IDE, klik **Atur API Key**, tempel API key TokenomixAI (`sk-tkx-...`), lalu **Tes koneksi & muat model**.
2. **Buka Folder** proyekmu.
3. Tulis permintaan di panel agen di kanan, pilih model dan mode izin, lalu Enter.

## Fitur

**Agen**
- Tool: daftar folder, baca berkas, cari berkas (glob), cari teks (grep), tulis berkas, edit berkas (ganti teks persis), hapus berkas, jalankan perintah PowerShell (termasuk dev server di latar belakang), daftar tugas, ambil halaman web, pratinjau browser.
- Mode izin:
  - **Tanya dulu**: setiap perubahan berkas tampil sebagai diff, dan setiap perintah harus disetujui.
  - **Terima edit**: perubahan berkas langsung diterapkan; perintah tetap minta izin.
  - **Otomatis**: semua aksi langsung dijalankan.
  - **Rencana**: agen hanya membaca, lalu menulis rencana yang bisa kamu setujui untuk dijalankan.
- Persetujuan per aksi menampilkan diff ringkas atau diff penuh. Ada pilihan "izinkan untuk sesi ini" dan kolom masukan saat menolak.
- **Undo** mengembalikan semua berkas yang diubah agen pada giliran terakhir.
- **Agent Manager**: beberapa sesi agen berjalan paralel, masing-masing dengan status, mode, model, dan progres tugas. Sesi tersimpan per folder.
- Konteks:
  - `@berkas` untuk melampirkan isi berkas.
  - Seret berkas ke kolom chat untuk melampirkannya.
  - Berkas yang sedang dibuka dan teks yang dipilih ikut dikirim sebagai konteks.
  - `XZY.md`, `AGENTS.md` atau `CLAUDE.md` di root proyek dibaca otomatis sebagai instruksi proyek.
- Perintah slash: `/ship`, `/init`, `/plan`, `/ask`, `/accept`, `/auto`, `/undo`, `/clear`, `/new`, `/help`.
- Model Claude memakai endpoint `/v1/messages` TokenomixAI. Model lain memakai `/v1/chat/completions`. Ada percobaan ulang otomatis untuk 429/502.

**Jalankan semua bahasa**
- Tombol **Jalankan** (F5) menjalankan berkas aktif: PHP, Java (berkas tunggal), Python, JavaScript/TypeScript, Go, Rust, C/C++, C#, Kotlin, Ruby, Dart, PowerShell, Bash. Berkas HTML dibuka di pratinjau.
- Konfigurasi proyek terdeteksi otomatis:
  - PHP/Laravel: `php artisan serve`, `php -S`, Composer
  - Node: script `npm`/`pnpm`/`yarn`
  - Java/Android: Gradle (termasuk `assembleDebug`/`assembleRelease`), Maven/Spring Boot
  - Python: Django, pytest
  - Lainnya: Go, Cargo, .NET, Flutter, Docker Compose
- **Runtime terpasang** diperiksa otomatis (Pengaturan). Runtime yang belum ada bisa dipasang agen lewat `winget`, dan PATH baru langsung terbaca tanpa restart.

**GitHub sampai rilis**
- Isi token GitHub di Pengaturan. Agen bisa:
  - membuat repo
  - commit dan push dengan token (tanpa force push)
  - pull/rebase jika remote lebih baru
  - memantau GitHub Actions sampai selesai
  - membaca penyebab gagal (step, anotasi file:baris, potongan log), memperbaiki, push lagi, dan menunggu lagi sampai hijau
  - membuat release beserta unggahan berkas
- `/ship` (atau tombol **Sampai rilis** di panel Source Control): agen menyelesaikan proyek, membuat workflow bila belum ada, push, memantau Actions, memperbaiki error, lalu merilis.
- Panel Source Control menampilkan status GitHub Actions terbaru.

**Editor**
- Monaco (mesin editor VS Code): tab, syntax highlight, minimap, sticky scroll, format dokumen, pergi ke baris.
- **Ctrl+K**: edit kode dengan AI langsung di editor (hasilnya ditinjau lewat diff).
- **Ctrl+Shift+L**: kirim kode yang dipilih ke chat.
- Explorer: buat, ganti nama, dan hapus berkas (dihapus ke Recycle Bin). Pencarian di seluruh workspace. Source control (status, diff vs HEAD, commit, pull, push).
- Terminal terintegrasi (PowerShell 7 jika ada, jika tidak Windows PowerShell), bisa beberapa terminal sekaligus.
- Pratinjau browser bawaan untuk web app yang sedang dibuat.
- Palet perintah dan buka berkas cepat. Tema gelap dan terang.

## Pintasan

| Pintasan | Aksi |
| --- | --- |
| Ctrl+P | Buka berkas cepat |
| Ctrl+Shift+P | Palet perintah |
| Ctrl+L | Fokus ke chat agen |
| Ctrl+K | Edit inline dengan AI |
| Ctrl+` | Terminal |
| Ctrl+B / Ctrl+Alt+B | Sidebar / panel agen |
| Ctrl+Shift+F | Cari di workspace |
| Ctrl+Shift+A | Agent Manager |
| Ctrl+S | Simpan |
| F5 / Shift+F5 | Jalankan / hentikan |

## Pengembangan

```
npm install
npm start          # jalankan dari source
npm test           # unit test (agen, tool, klien TokenomixAI)
npm run test:e2e   # uji end-to-end Electron dengan gateway tiruan
npm run dist       # build installer .exe + .msi (di Windows)
```

Setiap push ke `main` menjalankan GitHub Actions di Windows: unit test, uji end-to-end (dari source dan dari aplikasi terpaket), build `.exe` + `.msi`, lalu menerbitkannya di Releases.
