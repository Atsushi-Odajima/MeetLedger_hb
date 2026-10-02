#!/usr/bin/env node
// Generates buyer-docs/THIRD_PARTY_NOTICES.txt (purchaser-facing, Japanese).
//
// npm packages: for apps/server, apps/web (runtime deps only: react, react-dom, react-router-dom + their transitive deps)
// and apps/desktop (its own node_modules), runs `npm ls --omit=dev --all --json --long` in the project directory, walks the
// production dependency tree and reads each installed package's package.json "license" field and LICENSE/NOTICE files.
// Full license texts are included only for licenses other than MIT / ISC / BSD / Apache-2.0 (and the NOTICE files of any
// package that ships one). Models, fonts and external software are static sections below (sources: docs/TRANSCRIPTION.md,
// packages/local-asr/src/catalog.ts, brand/THIRD_PARTY_FONT_NOTICE.txt, Dockerfile, apps/desktop/node_modules/electron).
//
// Usage: node scripts/gen-third-party-notices.mjs [--out <file>] [--date YYYY-MM-DD]
// Requires: `npm install` at the repo root and `npm ci` in apps/desktop (the trees are read from the installed node_modules).
// The listed native packages are those of the host OS/CPU (e.g. sherpa-onnx-linux-x64); other targets install their own.
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const arg = (name) => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : undefined;
};
const OUT = resolve(arg('--out') ?? join(ROOT, 'buyer-docs', 'THIRD_PARTY_NOTICES.txt'));
const DATE = arg('--date') ?? new Date().toISOString().slice(0, 10);

const PROJECTS = [
  {
    key: 'server',
    dir: 'apps/server',
    workspace: '@meetledger/server',
    title: 'サーバー（apps/server）',
    note:
      'Docker イメージ、または Node.js で直接動かすサーバーにインストールされる実行時の依存パッケージです。\n' +
      'この一覧は Linux x64 の環境で作成しました。OS 別パッケージ（sherpa-onnx-linux-x64）は、ARM の Linux では\n' +
      'sherpa-onnx-linux-arm64、macOS / Windows では sherpa-onnx-darwin-* / sherpa-onnx-win-* になります（同じ Apache-2.0）。',
  },
  {
    key: 'web',
    dir: 'apps/web',
    workspace: '@meetledger/web',
    only: ['react', 'react-dom', 'react-router-dom'],
    title: 'Web アプリ・PWA（apps/web）',
    note: 'ブラウザに配信される JavaScript に組み込まれる実行時の依存パッケージ（react / react-dom / react-router-dom とその依存）です。',
  },
  {
    key: 'desktop',
    dir: 'apps/desktop',
    title: 'デスクトップアプリ（apps/desktop）',
    note:
      'デスクトップアプリの npm 実行時依存です。この一覧は開発環境（Linux x64）で作成したため、OS 別パッケージは sherpa-onnx-linux-x64 です。\n' +
      'Windows / macOS 版では、代わりに sherpa-onnx-win-x64 / sherpa-onnx-darwin-arm64 / sherpa-onnx-darwin-x64 が入ります（同じ Apache-2.0）。\n' +
      'Electron ランタイム（Chromium・Node.js を含む）は 4 章をご覧ください。',
  },
];

// ------------------------------------------------------------------ npm tree
function npmLs(cwd) {
  const opts = { cwd, encoding: 'utf8', maxBuffer: 512 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] };
  try {
    return JSON.parse(execFileSync('npm', ['ls', '--omit=dev', '--all', '--json', '--long'], opts));
  } catch (e) {
    // npm ls exits non-zero for unmet optional dependencies (other OS/CPU builds) but still prints the tree.
    if (e.stdout) return JSON.parse(e.stdout);
    throw e;
  }
}

const knownPaths = new Map(); // "name@version" -> absolute dir

function collect(project) {
  const cwd = join(ROOT, project.dir);
  if (!existsSync(join(cwd, 'package.json'))) throw new Error(`missing ${project.dir}/package.json`);
  const tree = npmLs(cwd);
  let start = tree.dependencies ?? {};
  if (project.workspace) {
    const ws = start[project.workspace];
    if (!ws) throw new Error(`workspace ${project.workspace} not found in npm ls output (run npm install at the repo root)`);
    start = ws.dependencies ?? {};
  }
  if (project.only) start = Object.fromEntries(Object.entries(start).filter(([n]) => project.only.includes(n) || n.startsWith('@meetledger/')));
  const found = new Map();
  const seen = new Set();
  const visit = (deps) => {
    for (const [name, node] of Object.entries(deps ?? {})) {
      if (!node || node.missing || !node.version) continue; // unmet optional dependency (other platforms)
      const id = `${name}@${node.version}`;
      if (node.path) knownPaths.set(id, node.path);
      if (!name.startsWith('@meetledger/')) {
        if (!found.has(id)) found.set(id, { name, version: node.version });
      }
      if (seen.has(id) && !node.dependencies) continue;
      seen.add(id);
      visit(node.dependencies);
    }
  };
  visit(start);
  return [...found.values()].sort((a, b) => a.name.localeCompare(b.name) || a.version.localeCompare(b.version));
}

function locate(project, pkg) {
  const id = `${pkg.name}@${pkg.version}`;
  const candidates = [knownPaths.get(id), join(ROOT, project.dir, 'node_modules', pkg.name), join(ROOT, 'node_modules', pkg.name)].filter(Boolean);
  for (const dir of candidates) {
    try {
      const pj = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
      if (pj.version === pkg.version) return dir;
    } catch {
      /* try next */
    }
  }
  return null;
}

// ------------------------------------------------------------------ package metadata
const LICENSE_FILE = /^(licen[cs]e|copying|unlicense)([.\-_].*)?$/i;
const NOTICE_FILE = /^notice([.\-_].*)?$/i;

function readText(file) {
  try {
    return readFileSync(file, 'utf8').replace(/\r\n/g, '\n').trimEnd();
  } catch {
    return '';
  }
}

function copyrightLines(text) {
  const out = [];
  for (const raw of text.split('\n')) {
    const line = raw.trim().replace(/\s+/g, ' ');
    // "Copyright (c) 2020 Name", "Copyright 2020 Name", "(c) 2020 Name", "© Name" — not license prose such as
    // "copyright license to reproduce…" or "(c) You must retain…" (Apache-2.0 §2 / §4).
    const isNotice = /^(Copyright|COPYRIGHT)\s+(\(c\)|\(C\)|©|\d{4}|[A-Z])/.test(line) || /^(\(c\)|\(C\)|©)\s*(\d{4}|[A-Z][a-z])/.test(line);
    if (!isNotice || /^\(c\)\s*You\b/i.test(line)) continue;
    if (/\[yyyy\]|\[name of copyright owner\]|<year>|<copyright holders?>|copyright notice|copyright owner|copyright holders and contributors "as is"/i.test(line)) continue;
    if (line.length > 200) continue;
    if (!out.includes(line)) out.push(line);
    if (out.length >= 6) break;
  }
  if (!out.length) {
    // e.g. "Original code Copyright Julian Gruber <…>" — notice in the middle of a line
    for (const raw of text.split('\n')) {
      const line = raw.trim().replace(/\s+/g, ' ');
      if (!/\bCopyright\s+(\(c\)|\(C\)|©|\d{4}|[A-Z])/.test(line)) continue;
      if (/notice|license to|owner|holders|\[yyyy\]|<year>/i.test(line) || line.length > 200) continue;
      if (!out.includes(line)) out.push(line);
      if (out.length >= 6) break;
    }
  }
  return out;
}

function licenseOf(pj) {
  if (typeof pj.license === 'string') return pj.license;
  if (pj.license && typeof pj.license === 'object' && pj.license.type) return pj.license.type;
  if (Array.isArray(pj.licenses)) return pj.licenses.map((l) => (typeof l === 'string' ? l : l.type)).filter(Boolean).join(' OR ');
  return null;
}

function authorOf(pj) {
  const a = pj.author;
  if (!a) return null;
  if (typeof a === 'string') return a.replace(/\s*<[^>]*>/g, '').replace(/\s*\([^)]*\)/g, '').trim() || null;
  return a.name ?? null;
}

function repoOf(pj) {
  const r = pj.repository;
  let url = typeof r === 'string' ? r : r?.url;
  if (!url) return pj.homepage ?? null;
  url = url
    .replace(/^git\+/, '')
    .replace(/\.git$/, '')
    .replace(/^git:\/\//, 'https://')
    .replace(/^ssh:\/\/git@/, 'https://')
    .replace(/^git@([^:]+):/, 'https://$1/')
    .replace(/^https:\/\/git@/, 'https://');
  if (/^[\w.-]+\/[\w.-]+$/.test(url)) url = `https://github.com/${url}`;
  if (/^github:/.test(url)) url = `https://github.com/${url.slice(7)}`;
  return url;
}

function inspect(dir) {
  const pj = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
  const entries = readdirSync(dir).filter((f) => {
    try {
      return statSync(join(dir, f)).isFile();
    } catch {
      return false;
    }
  });
  const licenseFiles = entries.filter((f) => LICENSE_FILE.test(f)).sort();
  const noticeFiles = entries.filter((f) => NOTICE_FILE.test(f)).sort();
  const licenseText = licenseFiles.map((f) => readText(join(dir, f))).join('\n\n');
  const license = licenseOf(pj);
  // package.json says e.g. "MIT" but the LICENSE file also carries the Apache-2.0 text (e.g. the MCP SDK's MIT → Apache-2.0
  // relicensing notice). Such packages get their full LICENSE text in section 7 and a note in the list.
  const fileHasApache = /Apache License\s+Version 2\.0, January 2004/.test(licenseText);
  const mixed = fileHasApache && !/Apache-2\.0/.test(license ?? '');
  return {
    license,
    mixed,
    author: authorOf(pj),
    repo: repoOf(pj),
    licenseFiles,
    licenseText,
    notices: noticeFiles.map((f) => ({ file: f, text: readText(join(dir, f)) })).filter((n) => n.text),
    copyright: copyrightLines(licenseText),
  };
}

// ------------------------------------------------------------------ license classification
const PERMISSIVE = new Set(['MIT', 'MIT-0', 'ISC', '0BSD', 'BSD-2-Clause', 'BSD-3-Clause', 'Apache-2.0']);
function isPermissive(expr) {
  if (!expr) return false;
  const e = expr.trim().replace(/^\((.*)\)$/, '$1').trim();
  if (/\sOR\s/i.test(e)) return e.split(/\s+OR\s+/i).some(isPermissive);
  if (/\sAND\s/i.test(e)) return e.split(/\s+AND\s+/i).every(isPermissive);
  return PERMISSIVE.has(e.replace(/[()]/g, '').trim());
}

// ------------------------------------------------------------------ build
const sections = [];
const all = new Map(); // id -> { pkg, info, projects:Set }
for (const project of PROJECTS) {
  const pkgs = collect(project);
  const rows = [];
  for (const pkg of pkgs) {
    const dir = locate(project, pkg);
    if (!dir) throw new Error(`cannot locate ${pkg.name}@${pkg.version} for ${project.dir}`);
    const id = `${pkg.name}@${pkg.version}`;
    const info = all.get(id)?.info ?? inspect(dir);
    if (!all.has(id)) all.set(id, { pkg, info, dir, projects: new Set() });
    all.get(id).projects.add(project.key);
    rows.push({ pkg, info });
  }
  sections.push({ project, rows });
}

const electronDir = join(ROOT, 'apps/desktop/node_modules/electron');
const electron = existsSync(join(electronDir, 'package.json'))
  ? {
      version: JSON.parse(readFileSync(join(electronDir, 'package.json'), 'utf8')).version,
      license: JSON.parse(readFileSync(join(electronDir, 'package.json'), 'utf8')).license,
      copyright: copyrightLines(readText(join(electronDir, 'dist', 'LICENSE'))),
      chromiumHtml: existsSync(join(electronDir, 'dist', 'LICENSES.chromium.html')),
    }
  : null;

const pad = (s, n) => s + ' '.repeat(Math.max(1, n - [...s].length));
const HR = '-'.repeat(78);
const L = [];
const h1 = (t) => L.push('', '', t, HR, '');

L.push('MeetLedger 第三者ソフトウェア・AIモデル・フォントに関する表示（THIRD_PARTY_NOTICES）');
L.push('='.repeat(78));
L.push('対象: MeetLedger 1.0.0（サーバー / Web アプリ・PWA / デスクトップアプリ）');
L.push(`作成日: ${DATE}`);
L.push('作成方法: node scripts/gen-third-party-notices.mjs で自動生成しています。');
L.push('          各プロジェクトで「npm ls --omit=dev --all」を実行して実行時の依存パッケージを洗い出し、');
L.push('          インストール済みの各パッケージの package.json（license 欄）と LICENSE / NOTICE ファイルを読み取っています。');
L.push('');
L.push('この文書は、MeetLedger が利用している第三者（MeetLedger の販売元以外）のソフトウェア・AIモデル・フォントと、');
L.push('その著作権表示・ライセンスをまとめたものです。MeetLedger 本体（apps/*、packages/* の @meetledger/* パッケージ）は');
L.push('販売元の著作物のため、この一覧には含めていません。');
L.push('');
L.push('ご注意');
L.push('  - ライセンス名は各パッケージの package.json の記載を転記したものです。正式な条件は、各パッケージに含まれる');
L.push('    LICENSE ファイルや配布元の表示をご確認ください。');
L.push('  - 著作権表示は LICENSE ファイルから「Copyright」で始まる行を抜き出したものです。LICENSE ファイルが無い、または');
L.push('    著作権表示の行が無いパッケージは、package.json の作者（author）欄を記載しています。');
L.push('  - この文書は法的助言ではありません。製品の再配布・販売の前に、法務担当者による確認をおすすめします。');
L.push('');
L.push('目次');
L.push('  1. AI・音声認識モデル（製品には同梱しません）');
L.push('  2. フォント（製品には同梱しません）');
L.push('  3. 製品に同梱しない外部ソフトウェア（ffmpeg、PostgreSQL ほか）');
L.push('  4. デスクトップアプリ・ローカル文字起こしに含まれるランタイム（Electron、ONNX Runtime）');
L.push('  5. npm パッケージ一覧（サーバー / Web・PWA / デスクトップアプリ）');
L.push('  6. ライセンス別の件数');
L.push('  7. MIT / ISC / BSD / Apache-2.0 以外のライセンスの本文');
L.push('  8. パッケージに含まれる NOTICE ファイル');
L.push('  9. 主なライセンスの本文（MIT / ISC / BSD-2-Clause / BSD-3-Clause / Apache-2.0）');

// ---------------------------------------------------------------- 1. models
h1('1. AI・音声認識モデル（製品には同梱しません）');
L.push(
  ...`ローカル文字起こし（端末内・サーバー内での文字起こし）に使うモデルは、製品のファイルには含まれていません。
管理者（サーバー）または利用者（デスクトップアプリ）が明示的に操作したときだけ、配布元
（k2-fsa/sherpa-onnx の GitHub Releases）からダウンロードされます。ダウンロード後にサイズと SHA-256 を検証します。
  - サーバー: bash scripts/download-models.sh
  - デスクトップアプリ: 設定画面の「文字起こしモデル（端末内）」から（サイズとライセンスの確認ダイアログが出ます）

(1) SenseVoiceSmall（文字起こしモデル。sherpa-onnx 用 int8 版 2024-07-17）
    権利者:     Alibaba Group（Tongyi Lab / FunAudioLLM）
    ライセンス: FunASR Model Open Source License Agreement v1.1
                https://github.com/modelscope/FunASR/blob/main/MODEL_LICENSE
    表示が必要な文言（同ライセンス §2.2「出典・作者情報の明示、モデル名の保持」に基づく）:
      SenseVoiceSmall © Alibaba Group (Tongyi Lab / FunAudioLLM). Licensed under the FunASR Model Open Source License v1.1.
      Converted to ONNX by k2-fsa/sherpa-onnx.
    補足: 2026-10-02 時点の調査（docs/SOURCE_NOTES.md）では、ライセンス条件を守ることを前提に商用利用は可能とされて
          います。ライセンスの改訂は自動的に効力を持つと定められているため、定期的に原文を確認してください。

(2) Silero VAD（音声区間検出モデル silero_vad.onnx）
    配布元:     snakers4/silero-vad（Silero）
    ライセンス: MIT（配布元リポジトリの表示による。ライセンス原文・著作権表示の再確認は未実施＝要確認）
                https://github.com/snakers4/silero-vad

(3) pyannote segmentation-3.0（話者分離用のセグメンテーションモデル。sherpa-onnx 用 ONNX 版）
    Copyright (c) 2022 CNRS
    ライセンス: MIT License（モデルの配布物に LICENSE が同梱されています。本文は 9 章の MIT と同じです）
    表示文言: pyannote/segmentation-3.0 © 2022 CNRS (MIT License)

(4) 3D-Speaker CAM++（話者の声の特徴を数値にするモデル speech_campplus_sv_zh_en_16k-common_advanced）
    権利者:     Alibaba（modelscope/3D-Speaker）
    ライセンス: 要確認。3D-Speaker のリポジトリは Apache-2.0 ですが、このモデル個別のライセンス
                （ModelScope のモデルカード）は確認できていません。販売・商用利用の前に法務確認が必要です。
                デスクトップアプリの設定画面でも「商用利用 未確認」と表示されます。
    表示文言: 3D-Speaker CAM++ © Alibaba (modelscope/3D-Speaker)
    補足: 話者分離（誰が話したかの区別）を使わない場合、このモデルはダウンロード不要です
          （bash scripts/download-models.sh sense-voice で文字起こしモデルだけを取得できます）。

MeetLedger は声の特徴量を保存せず、声から本人を特定することもしません（話者は「Speaker 1」などの匿名ラベル）。`.split('\n'),
);

// ---------------------------------------------------------------- 2. fonts
h1('2. フォント（製品には同梱しません）');
L.push(
  ...`製品にフォントファイルは含まれていません。画面の文字は、利用者の端末に入っているシステムフォントで表示します。

(1) Inter（Inter Display SemiBold、v4.1）
    Copyright (c) 2016 The Inter Project Authors (https://github.com/rsms/inter)
    ライセンス: SIL Open Font License, Version 1.1
    用途: ロゴ（ワードマーク「MeetLedger」）の文字の形を、SVG の図形（パス）に変換して使っています。
          フォントファイル自体は含みません。

(2) Noto Sans JP（2.004）
    (c) 2014-2021 Adobe (http://www.adobe.com/), with Reserved Font Name 'Source'.
    ライセンス: SIL Open Font License, Version 1.1
    用途: og.png（共有用画像）とブランドボード画像の日本語文字を、画像として描画するためだけに使用しました。

詳細（入手元・SHA-256 など）: brand/THIRD_PARTY_FONT_NOTICE.txt
SIL OFL 1.1 の本文: https://openfontlicense.org/`.split('\n'),
);

// ---------------------------------------------------------------- 3. external software
h1('3. 製品に同梱しない外部ソフトウェア');
L.push(
  ...`(1) ffmpeg / ffprobe（音声・動画の変換と情報取得）
    サーバーが外部コマンドとして呼び出します（環境変数 FFMPEG_PATH / FFPROBE_PATH）。MeetLedger のファイルには含まれません。
    - 付属の Dockerfile では、イメージを作るときに Debian（bookworm）の ffmpeg パッケージを apt でインストールします。
      ライセンスは Debian のビルド構成により LGPL-2.1 以降または GPL-2.0 以降の部分を含みます。正式な条件は、
      イメージ内の /usr/share/doc/ffmpeg/copyright（および依存ライブラリの copyright ファイル）をご確認ください。
      ビルドしたイメージを第三者に配布する場合は、GPL などの条件（ソースコードの入手方法の提示など）に従う必要があります。
    - Node.js で直接インストールする場合は、OS の ffmpeg を管理者が用意します。
    - デスクトップアプリは ffmpeg のコマンドを同梱しません（Electron 内部のライブラリについては 4 章）。

(2) PostgreSQL 16（データベース）
    別途インストールして使います（付属の docker compose 例では公式イメージ postgres:16 を取得します）。
    ライセンス: PostgreSQL License（https://www.postgresql.org/about/licence/）

(3) Docker イメージの土台（付属の Dockerfile を使う場合）
    node:22-bookworm-slim（Node.js と Debian のパッケージ）、tini、ca-certificates などを、イメージを作るときに取得します。
    これらは MeetLedger のファイルには含まれません。各ライセンスは、イメージ内の /usr/share/doc/*/copyright と
    Node.js の LICENSE（https://github.com/nodejs/node/blob/main/LICENSE）をご確認ください。`.split('\n'),
);

// ---------------------------------------------------------------- 4. runtimes
h1('4. デスクトップアプリ・ローカル文字起こしに含まれるランタイム');
L.push(
  ...`(1) Electron${electron ? ` ${electron.version}` : ''}（デスクトップアプリの実行環境）
    ライセンス: ${electron?.license ?? 'MIT'}
${(electron?.copyright.length ? electron.copyright : ['Copyright (c) Electron contributors']).map((c) => `    ${c}`).join('\n')}
    Electron には Chromium と Node.js が含まれます。それらと、それらが使うライブラリ（Chromium のメディア再生用
    FFmpeg ライブラリ（libffmpeg / ffmpeg.dll。主に LGPL-2.1 以降）など）のライセンスは、Electron に同梱されている
    LICENSES.chromium.html に記載されています${electron?.chromiumHtml ? '' : '（開発環境で未確認）'}。
    パッケージ版のアプリ（インストーラー）にこのファイルと Electron の LICENSE が含まれていることを、配布前に
    確認してください（要確認: パッケージ版での同梱は未検証）。
    Electron は開発用の依存（devDependencies）として管理されているため、5 章の npm 一覧には出てきません。

(2) ONNX Runtime 1.28.2（AIモデルの実行ライブラリ。Microsoft）
    Copyright (c) Microsoft Corporation
    ライセンス: MIT License
    sherpa-onnx の OS 別パッケージ（sherpa-onnx-<OS>-<CPU>）の中に共有ライブラリ（libonnxruntime など）として
    含まれ、サーバーのローカル文字起こしとデスクトップアプリの両方で使われます。バージョンは開発環境
    （Linux x64）のパッケージで確認したものです。ONNX Runtime 自身の第三者ライセンス表示（ThirdPartyNotices）の
    同梱が必要かどうかは要確認です（https://github.com/microsoft/onnxruntime）。

(3) sherpa-onnx（文字起こし・話者分離の実行エンジン。The next-gen Kaldi team）
    ライセンス: Apache-2.0（5 章の一覧の sherpa-onnx-node / sherpa-onnx-<OS>-<CPU>）
    https://github.com/k2-fsa/sherpa-onnx
    npm パッケージには LICENSE ファイルが含まれていないため、Apache-2.0 の本文を 9 章に掲載しています。`.split('\n'),
);

// ---------------------------------------------------------------- 5. npm lists
h1('5. npm パッケージ一覧');
L.push('各項目は「パッケージ名 バージョン — ライセンス」の順です。その下に著作権表示（または作者）を記載しています。');
const letters = ['5-1', '5-2', '5-3'];
sections.forEach(({ project, rows }, i) => {
  L.push('', `${letters[i]}. ${project.title}（${rows.length} 件）`, '');
  L.push(...project.note.split('\n').map((x) => `    ${x}`), '');
  for (const { pkg, info } of rows) {
    L.push(`  - ${pkg.name} ${pkg.version} — ${info.license ?? '（package.json にライセンスの記載なし・要確認）'}`);
    const who = info.copyright.length ? info.copyright : info.author ? [`作者: ${info.author}`] : [];
    for (const c of who) L.push(`      ${c}`);
    if (info.mixed) L.push('      ※ LICENSE ファイルには Apache License 2.0 の本文も含まれています（全文は 7 章）');
    if (!info.licenseFiles.length) L.push('      （パッケージに LICENSE ファイルが含まれていません）');
    if (info.repo) L.push(`      ${info.repo}`);
  }
});

// ---------------------------------------------------------------- 6. counts
h1('6. ライセンス別の件数（5 章の重複を除いた件数）');
const counts = new Map();
for (const { info } of all.values()) counts.set(info.license ?? '(記載なし)', (counts.get(info.license ?? '(記載なし)') ?? 0) + 1);
const countRows = [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
for (const [lic, n] of countRows) L.push(`  ${pad(lic, 40)}${n} 件`);
L.push('', `  合計 ${all.size} 件（サーバー ${sections[0].rows.length} / Web・PWA ${sections[1].rows.length} / デスクトップ ${sections[2].rows.length}、重複あり）`);

// ---------------------------------------------------------------- 7. non-permissive full texts
h1('7. MIT / ISC / BSD / Apache-2.0 以外のライセンスの本文');
const nonPermissive = [...all.values()].filter(({ info }) => !isPermissive(info.license) || info.mixed).sort((a, b) => a.pkg.name.localeCompare(b.pkg.name));
if (!nonPermissive.length) {
  L.push('該当するパッケージはありません。');
} else {
  L.push('次のパッケージは、MIT / ISC / BSD / Apache-2.0 以外のライセンス（またはライセンス表記の無いもの）か、');
  L.push('package.json の記載とは別のライセンスの本文を LICENSE ファイルに含むものです。');
  L.push('パッケージに含まれる LICENSE ファイルの全文を掲載します（同じ本文のものはまとめて 1 回だけ掲載）。');
  const groups = new Map(); // license text -> [{pkg, info}]
  for (const e of nonPermissive) {
    // group by the text with whitespace normalised (the same license is often re-wrapped slightly differently)
    const key = e.info.licenseText ? e.info.licenseText.replace(/\s+/g, ' ').trim() : `__none__${e.pkg.name}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(e);
  }
  for (const [key, members] of groups) {
    L.push('');
    for (const { pkg, info } of members) L.push(`■ ${pkg.name} ${pkg.version} — package.json の記載: ${info.license ?? '（記載なし）'}`);
    L.push('');
    L.push(key.startsWith('__none__') ? `（パッケージに LICENSE ファイルが含まれていません。配布元で条件を確認してください: ${members[0].info.repo ?? '不明'}）` : members[0].info.licenseText);
  }
}

// ---------------------------------------------------------------- 8. NOTICE files
h1('8. パッケージに含まれる NOTICE ファイル');
const withNotice = [...all.values()].filter(({ info }) => info.notices.length).sort((a, b) => a.pkg.name.localeCompare(b.pkg.name));
if (!withNotice.length) {
  L.push('NOTICE ファイルを含むパッケージはありません。');
} else {
  for (const { pkg, info } of withNotice) {
    for (const n of info.notices) L.push('', `■ ${pkg.name} ${pkg.version}（${n.file}）`, '', n.text);
  }
}

// ---------------------------------------------------------------- 9. standard texts
h1('9. 主なライセンスの本文');
L.push('5 章で各パッケージに記載したライセンスの標準的な本文です。<year> <copyright holders> の部分には、');
L.push('5 章に記載した各パッケージの著作権表示が入ります。');

const MIT = `MIT License

Copyright (c) <year> <copyright holders>

Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated
documentation files (the "Software"), to deal in the Software without restriction, including without limitation the
rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to permit
persons to whom the Software is furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all copies or substantial portions of the
Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE
WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR
COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR
OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.`;

const ISC = `ISC License

Copyright (c) <year> <copyright holders>

Permission to use, copy, modify, and/or distribute this software for any purpose with or without fee is hereby
granted, provided that the above copyright notice and this permission notice appear in all copies.

THE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL WARRANTIES WITH REGARD TO THIS SOFTWARE INCLUDING ALL
IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS. IN NO EVENT SHALL THE AUTHOR BE LIABLE FOR ANY SPECIAL, DIRECT,
INDIRECT, OR CONSEQUENTIAL DAMAGES OR ANY DAMAGES WHATSOEVER RESULTING FROM LOSS OF USE, DATA OR PROFITS, WHETHER IN AN
ACTION OF CONTRACT, NEGLIGENCE OR OTHER TORTIOUS ACTION, ARISING OUT OF OR IN CONNECTION WITH THE USE OR PERFORMANCE OF
THIS SOFTWARE.`;

const BSD_COMMON = `Redistribution and use in source and binary forms, with or without modification, are permitted provided that the
following conditions are met:

1. Redistributions of source code must retain the above copyright notice, this list of conditions and the following
   disclaimer.

2. Redistributions in binary form must reproduce the above copyright notice, this list of conditions and the following
   disclaimer in the documentation and/or other materials provided with the distribution.`;
const BSD_DISCLAIMER = `THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS" AND ANY EXPRESS OR IMPLIED WARRANTIES,
INCLUDING, BUT NOT LIMITED TO, THE IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE
DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT HOLDER OR CONTRIBUTORS BE LIABLE FOR ANY DIRECT, INDIRECT, INCIDENTAL,
SPECIAL, EXEMPLARY, OR CONSEQUENTIAL DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR
SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER CAUSED AND ON ANY THEORY OF LIABILITY,
WHETHER IN CONTRACT, STRICT LIABILITY, OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE OF
THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.`;
const BSD2 = `BSD 2-Clause License\n\nCopyright (c) <year> <copyright holders>\n\n${BSD_COMMON}\n\n${BSD_DISCLAIMER}`;
const BSD3 = `BSD 3-Clause License\n\nCopyright (c) <year> <copyright holders>\n\n${BSD_COMMON}\n\n3. Neither the name of the copyright holder nor the names of its contributors may be used to endorse or promote
   products derived from this software without specific prior written permission.\n\n${BSD_DISCLAIMER}`;

const used = new Set([...all.values()].map(({ info }) => info.license ?? ''));
const usesAny = (re) => [...used].some((l) => re.test(l));
L.push('', '■ MIT License', '', MIT);
if (usesAny(/\bISC\b/)) L.push('', '■ ISC License', '', ISC);
if (usesAny(/BSD-2-Clause/)) L.push('', '■ BSD 2-Clause License', '', BSD2);
if (usesAny(/BSD-3-Clause/)) L.push('', '■ BSD 3-Clause License', '', BSD3);

// Apache-2.0 full text: taken from an installed package's LICENSE file (sherpa-onnx packages ship none).
function findApacheText() {
  const isFull = (t) => /Apache License\s+Version 2\.0, January 2004/.test(t) && /END OF TERMS AND CONDITIONS/.test(t);
  for (const { info } of all.values()) if (info.license === 'Apache-2.0' && isFull(info.licenseText)) return info.licenseText;
  const fallbacks = ['node_modules/typescript/LICENSE.txt', 'apps/desktop/node_modules/typescript/LICENSE.txt'];
  for (const f of fallbacks) {
    const t = readText(join(ROOT, f));
    if (isFull(t)) return t;
  }
  return null;
}
if (usesAny(/Apache-2\.0/)) {
  const apache = findApacheText();
  L.push('', '■ Apache License 2.0', '');
  L.push(apache ? apache.replace(/^\s*Copyright \(c\) Microsoft Corporation[^\n]*\n/i, '') : '本文: https://www.apache.org/licenses/LICENSE-2.0（開発環境で本文ファイルを取得できませんでした）');
}

L.push('', '', '（以上）', '');
const text = L.join('\n').replace(/[ \t]+$/gm, '');
writeFileSync(OUT, text, 'utf8');
console.log(
  `wrote ${relative(ROOT, OUT)}: server ${sections[0].rows.length}, web ${sections[1].rows.length}, desktop ${sections[2].rows.length} packages (${all.size} unique); ` +
    `non-permissive ${nonPermissive.length}; licenses: ${countRows.map(([l, n]) => `${l}=${n}`).join(', ')}`,
);
