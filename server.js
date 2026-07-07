'use strict';

const express = require('express');
const multer = require('multer');
const axios = require('axios');
const JSZip = require('jszip');
const crypto = require('crypto');
const JavaScriptObfuscator = require('javascript-obfuscator');
const terser = require('terser');

const app = express();
const PORT = process.env.PORT || 3000;
const MAX_BYTES = 15 * 1024 * 1024;
const downloads = new Map();

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_BYTES }
});

app.use(express.static('public', { maxAge: '1h' }));
app.use(express.json({ limit: '16mb' }));
app.use(express.urlencoded({ extended: true, limit: '16mb' }));

function now() {
  return new Date().toLocaleTimeString('id-ID', { hour12: false });
}

function logLine(logs, message) {
  logs.push(`[${now()}] ${message}`);
}

function sanitizeFileName(name, fallback = 'result.js') {
  const raw = String(name || fallback).trim() || fallback;
  const onlyName = raw.split(/[\\/]/).pop();
  const clean = onlyName
    .replace(/[^a-zA-Z0-9._-]/g, '_')
    .replace(/_+/g, '_')
    .slice(0, 140);
  return clean || fallback;
}

function ensureExt(name, ext) {
  return /\.[a-z0-9]+$/i.test(name) ? name : `${name}${ext}`;
}

function makeId() {
  return crypto.randomBytes(16).toString('hex');
}

function saveDownload(filename, output, meta = {}) {
  const id = makeId();
  downloads.set(id, { filename, output, meta, createdAt: Date.now() });
  setTimeout(() => downloads.delete(id), 1000 * 60 * 60);
  return id;
}

function getDownload(req, res) {
  const item = downloads.get(req.params.id);
  if (!item) {
    res.status(404).send('Download sudah expired atau tidak ditemukan. Proses ulang file kamu.');
    return null;
  }
  return item;
}

async function readInput(req, logs) {
  if (req.file && req.file.buffer) {
    const text = req.file.buffer.toString('utf8');
    logLine(logs, `Input dari upload file: ${req.file.originalname} (${text.length} chars).`);
    return text;
  }

  const url = String(req.body.url || '').trim();
  if (url) {
    if (!/^https?:\/\//i.test(url)) throw new Error('URL raw harus diawali http:// atau https://');
    logLine(logs, `Mengambil source dari URL raw: ${url}`);
    const response = await axios.get(url, {
      responseType: 'text',
      timeout: 25000,
      maxContentLength: MAX_BYTES,
      maxBodyLength: MAX_BYTES,
      headers: { 'User-Agent': 'JS-Encrypt-Password-Railway-Pro/2.0' },
      transformResponse: [data => data]
    });
    const text = String(response.data || '');
    logLine(logs, `Input dari URL berhasil: ${text.length} chars.`);
    return text;
  }

  const code = String(req.body.code || '');
  logLine(logs, `Input dari paste textarea: ${code.length} chars.`);
  return code;
}

async function minifyCode(source, logs) {
  try {
    const result = await terser.minify(source, {
      module: true,
      compress: { passes: 2, drop_debugger: true },
      mangle: true,
      format: { comments: false }
    });
    if (!result.code) throw new Error('Terser tidak menghasilkan output.');
    logLine(logs, `Minify module berhasil: ${source.length} → ${result.code.length} chars.`);
    return result.code;
  } catch (errModule) {
    logLine(logs, `Minify module gagal, coba mode script biasa: ${errModule.message}`);
    const result = await terser.minify(source, {
      module: false,
      compress: { passes: 2, drop_debugger: true },
      mangle: true,
      format: { comments: false }
    });
    if (!result.code) throw new Error('Terser tidak menghasilkan output.');
    logLine(logs, `Minify script berhasil: ${source.length} → ${result.code.length} chars.`);
    return result.code;
  }
}

function obfuscatorOptions(mode) {
  const base = {
    target: 'browser-no-eval',
    compact: true,
    simplify: true,
    sourceMap: false,
    identifierNamesGenerator: 'hexadecimal',
    identifiersPrefix: '',
    renameGlobals: false,
    stringArray: true,
    rotateStringArray: true,
    shuffleStringArray: true,
    stringArrayWrappersCount: 1,
    stringArrayWrappersType: 'variable',
    stringArrayWrappersChainedCalls: true,
    stringArrayEncoding: ['base64'],
    stringArrayThreshold: 0.75,
    numbersToExpressions: true,
    splitStrings: false,
    transformObjectKeys: false,
    unicodeEscapeSequence: false,
    selfDefending: false,
    debugProtection: false,
    debugProtectionInterval: 0,
    disableConsoleOutput: false,
    domainLock: [],
    controlFlowFlattening: false,
    deadCodeInjection: false
  };

  if (mode === 'stable') {
    return {
      ...base,
      stringArrayThreshold: 0.68,
      numbersToExpressions: false,
      stringArrayWrappersCount: 1,
      controlFlowFlattening: false,
      deadCodeInjection: false
    };
  }

  if (mode === 'strong') {
    return {
      ...base,
      stringArrayEncoding: ['base64'],
      stringArrayThreshold: 0.92,
      stringArrayWrappersCount: 2,
      splitStrings: true,
      splitStringsChunkLength: 8,
      transformObjectKeys: true,
      controlFlowFlattening: true,
      controlFlowFlatteningThreshold: 0.38,
      deadCodeInjection: true,
      deadCodeInjectionThreshold: 0.08
    };
  }

  if (mode === 'extreme') {
    return {
      ...base,
      // Ini yang paling mirip style script awal: _0x + string array + RC4 + rotate/shuffle.
      stringArrayEncoding: ['rc4'],
      stringArrayThreshold: 1,
      stringArrayWrappersCount: 3,
      splitStrings: true,
      splitStringsChunkLength: 5,
      transformObjectKeys: true,
      controlFlowFlattening: true,
      controlFlowFlatteningThreshold: 0.68,
      deadCodeInjection: true,
      deadCodeInjectionThreshold: 0.18,
      numbersToExpressions: true
    };
  }

  return base;
}

async function obfuscateCode(source, mode, logs) {
  const options = obfuscatorOptions(mode);
  logLine(logs, `Mode obfuscate: ${mode}.`);
  logLine(logs, `Metode: _0x style + stringArray=${options.stringArray} + encoding=${options.stringArrayEncoding.join(',')} + rotate=${options.rotateStringArray} + shuffle=${options.shuffleStringArray}.`);
  logLine(logs, 'Self-defending/debugProtection/eval dimatikan agar lebih aman untuk deploy Railway/Worker.');

  let input = source;
  if (mode === 'strong' || mode === 'extreme') {
    try {
      input = await minifyCode(source, logs);
    } catch (err) {
      logLine(logs, `Pre-minify dilewati karena gagal: ${err.message}`);
    }
  }

  const result = JavaScriptObfuscator.obfuscate(input, options).getObfuscatedCode();
  logLine(logs, `Obfuscate berhasil: ${source.length} → ${result.length} chars.`);
  return result;
}

function encryptVault(source, password, logs) {
  const pass = String(password || '');
  if (pass.length < 8) throw new Error('AES Vault butuh password minimal 8 karakter.');

  const salt = crypto.randomBytes(16);
  const iv = crypto.randomBytes(12);
  const key = crypto.pbkdf2Sync(pass, salt, 250000, 32, 'sha256');
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(Buffer.from(source, 'utf8')), cipher.final()]);
  const tag = cipher.getAuthTag();

  const payload = {
    type: 'JS_AES_256_GCM_VAULT',
    version: 2,
    kdf: 'PBKDF2-SHA256',
    iterations: 250000,
    createdAt: new Date().toISOString(),
    salt: salt.toString('base64'),
    iv: iv.toString('base64'),
    tag: tag.toString('base64'),
    data: ciphertext.toString('base64')
  };

  logLine(logs, `AES-256-GCM Vault berhasil. Source bisa dibuka lagi pakai password yang sama.`);

  return `/*
  JS AES-256-GCM PASSWORD VAULT
  Ini file terenkripsi password. Untuk decrypt, upload/paste file ini ke tool yang sama, pilih mode Decrypt AES Vault.
  Tanpa password yang benar, source asli tidak bisa dibuka.
*/
export default ${JSON.stringify(payload, null, 2)};
`;
}

function stripComments(text) {
  return String(text || '')
    .replace(/^\uFEFF/, '')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .trim();
}

function extractJsonObject(text) {
  let s = stripComments(text);
  s = s.replace(/^export\s+default\s+/i, '').trim();
  s = s.replace(/^module\.exports\s*=\s*/i, '').trim();
  s = s.replace(/^const\s+\w+\s*=\s*/i, '').trim();
  if (s.endsWith(';')) s = s.slice(0, -1).trim();

  try {
    return JSON.parse(s);
  } catch (_) {
    const start = s.indexOf('{');
    const end = s.lastIndexOf('}');
    if (start >= 0 && end > start) {
      const inner = s.slice(start, end + 1);
      return JSON.parse(inner);
    }
    throw new Error('Payload Vault tidak ditemukan. Paste/upload file .vault.js hasil AES Vault.');
  }
}

function decryptVault(vaultText, password, logs) {
  const pass = String(password || '');
  if (pass.length < 8) throw new Error('Decrypt AES Vault butuh password minimal 8 karakter.');

  const payload = extractJsonObject(vaultText);
  if (!payload || payload.type !== 'JS_AES_256_GCM_VAULT') {
    throw new Error('File ini bukan JS_AES_256_GCM_VAULT dari tools ini.');
  }

  const salt = Buffer.from(payload.salt, 'base64');
  const iv = Buffer.from(payload.iv, 'base64');
  const tag = Buffer.from(payload.tag, 'base64');
  const data = Buffer.from(payload.data, 'base64');
  const iterations = Number(payload.iterations || 250000);

  const key = crypto.pbkdf2Sync(pass, salt, iterations, 32, 'sha256');
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  const plaintext = Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8');
  logLine(logs, `Decrypt AES Vault berhasil: ${plaintext.length} chars.`);
  return plaintext;
}

function buildBanner(mode) {
  const stamp = new Date().toISOString();
  return `/* Generated by JS Encrypt Password Railway Pro | mode=${mode} | ${stamp} */\n`;
}

async function buildOutput(req, logs) {
  const action = String(req.body.action || 'encrypt');
  const mode = String(req.body.mode || 'strong');
  const source = await readInput(req, logs);
  if (!source.trim()) throw new Error('Input kosong. Paste kode, upload file, atau isi URL raw dulu.');
  if (source.length > MAX_BYTES) throw new Error('Input terlalu besar. Maksimal sekitar 15MB.');

  let filename = sanitizeFileName(req.body.outputName || 'result.js');
  let output;
  let realMode = mode;

  if (action === 'decrypt-vault' || mode === 'aes-decrypt') {
    output = decryptVault(source, req.body.password, logs);
    filename = ensureExt(filename.replace(/\.vault$/i, '').replace(/\.vault\.js$/i, ''), '.js');
    realMode = 'aes-decrypt';
  } else if (mode === 'minify') {
    output = buildBanner(mode) + await minifyCode(source, logs);
    filename = ensureExt(filename, '.js');
  } else if (mode === 'aes') {
    output = encryptVault(source, req.body.password, logs);
    filename = filename.replace(/\.js$/i, '') + '.vault.js';
  } else if (['stable', 'strong', 'extreme'].includes(mode)) {
    output = buildBanner(mode) + await obfuscateCode(source, mode, logs);
    filename = ensureExt(filename, '.js');
  } else {
    throw new Error(`Mode tidak dikenal: ${mode}`);
  }

  return { filename, source, output, mode: realMode };
}

app.get('/api/health', (req, res) => {
  res.json({ ok: true, app: 'js-encrypt-password-railway-pro', time: new Date().toISOString() });
});

app.post('/api/process', upload.single('file'), async (req, res) => {
  const logs = [];
  try {
    const result = await buildOutput(req, logs);
    const id = saveDownload(result.filename, result.output, {
      mode: result.mode,
      inputChars: result.source.length,
      outputChars: result.output.length,
      logs
    });
    logLine(logs, `Siap download: ${result.filename}.`);
    res.json({
      ok: true,
      filename: result.filename,
      mode: result.mode,
      inputChars: result.source.length,
      outputChars: result.output.length,
      output: result.output,
      logs,
      downloadJs: `/download/${id}/js`,
      downloadZip: `/download/${id}/zip`
    });
  } catch (err) {
    logLine(logs, `ERROR: ${err.message}`);
    res.status(400).json({ ok: false, error: err.message, logs });
  }
});

// Backward compatible endpoint.
app.post('/api/encrypt', upload.single('file'), async (req, res) => {
  req.body.action = 'encrypt';
  const logs = [];
  try {
    const result = await buildOutput(req, logs);
    const id = saveDownload(result.filename, result.output, {
      mode: result.mode,
      inputChars: result.source.length,
      outputChars: result.output.length,
      logs
    });
    logLine(logs, `Siap download: ${result.filename}.`);
    res.json({ ok: true, ...result, inputChars: result.source.length, outputChars: result.output.length, logs, downloadJs: `/download/${id}/js`, downloadZip: `/download/${id}/zip` });
  } catch (err) {
    logLine(logs, `ERROR: ${err.message}`);
    res.status(400).json({ ok: false, error: err.message, logs });
  }
});

app.get('/download/:id/js', (req, res) => {
  const item = getDownload(req, res);
  if (!item) return;
  const contentType = item.filename.endsWith('.json') ? 'application/json; charset=utf-8' : 'application/javascript; charset=utf-8';
  res.setHeader('Content-Type', contentType);
  res.setHeader('Content-Disposition', `attachment; filename="${item.filename}"`);
  res.send(item.output);
});

app.get('/download/:id/zip', async (req, res) => {
  const item = getDownload(req, res);
  if (!item) return;
  const zip = new JSZip();
  zip.file(item.filename, item.output);
  zip.file('process-log.txt', (item.meta.logs || []).join('\n'));
  zip.file('README.txt', `Generated by JS Encrypt Password Railway Pro\nFile: ${item.filename}\nMode: ${item.meta.mode || '-'}\nInput chars: ${item.meta.inputChars || 0}\nOutput chars: ${item.meta.outputChars || 0}\n`);
  const buffer = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
  const zipName = item.filename.replace(/\.[^.]+$/, '') + '.zip';
  res.setHeader('Content-Type', 'application/zip');
  res.setHeader('Content-Disposition', `attachment; filename="${zipName}"`);
  res.send(buffer);
});

app.use((err, req, res, next) => {
  if (err && err.code === 'LIMIT_FILE_SIZE') {
    res.status(400).json({ ok: false, error: 'File terlalu besar. Maksimal 15MB.' });
    return;
  }
  res.status(500).json({ ok: false, error: err.message || 'Server error' });
});

app.listen(PORT, () => {
  console.log(`JS Encrypt Password Railway Pro running on port ${PORT}`);
});
