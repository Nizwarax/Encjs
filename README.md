# JS Encrypt Password Railway Pro

Tool Railway untuk JavaScript:

- Paste kode langsung
- Upload file
- Ambil URL raw
- Custom nama output
- Download JS / ZIP
- Obfuscate gaya `_0x` string-array seperti script obfuscate umum
- Mode Extreme memakai `stringArrayEncoding: rc4`, rotate/shuffle string array, wrapper, split string, control-flow flattening
- AES-256-GCM Vault dengan password
- Decrypt AES Vault lagi memakai password yang sama

## Jalankan lokal

```bash
npm install
npm start
```

Buka `http://localhost:3000`.

## Deploy Railway

Import folder ini ke GitHub, lalu deploy ke Railway. Railway otomatis memakai `npm start` dan `PORT` dari environment.

## Catatan

- Mode Obfuscate Extreme gayanya mirip script awal yang memakai array `_0x...`, string-array, RC4/base64, dan rotasi array. Tidak byte-for-byte sama, tapi metode kelasnya sama.
- Mode obfuscate tidak butuh password dan tidak reversible 100%.
- Mode AES Vault adalah yang reversible: encrypt pakai password, decrypt pakai password yang sama.
