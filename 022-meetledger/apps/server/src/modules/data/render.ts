// Tiny document model rendered to Markdown or print-optimized HTML (browser "PDFとして保存").
// All user/AI content is escaped; the HTML has no scripts and no external resources.

export type Block =
  | { t: 'h'; level: 1 | 2 | 3; text: string; badge?: string }
  | { t: 'p'; text: string; muted?: boolean }
  | { t: 'meta'; rows: [string, string][] }
  | { t: 'list'; items: { text: string; badge?: string; sub?: string }[] }
  | { t: 'table'; head: string[]; rows: string[][] }
  | { t: 'transcript'; rows: { time: string; speaker: string; text: string }[] }
  | { t: 'note'; text: string }
  | { t: 'hr' };

export const AI_LABEL = 'AI生成';
export const CANDIDATE_LABEL = '候補（未確認）';

export function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

const mdInline = (s: string) => s.replace(/\r?\n/g, '  \n');
const mdCell = (s: string) => s.replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
const mdHeading = (s: string) => s.replace(/\r?\n/g, ' ');

export function renderMarkdown(blocks: Block[]): string {
  const out: string[] = [];
  for (const b of blocks) {
    switch (b.t) {
      case 'h':
        out.push(`${'#'.repeat(b.level)} ${mdHeading(b.text)}${b.badge ? ` 〔${b.badge}〕` : ''}`, '');
        break;
      case 'p':
        out.push(b.muted ? `_${mdInline(b.text)}_` : mdInline(b.text), '');
        break;
      case 'note':
        out.push(...b.text.split(/\r?\n/).map((l) => `> ${l}`), '');
        break;
      case 'meta':
        out.push('| 項目 | 内容 |', '|---|---|', ...b.rows.map(([k, v]) => `| ${mdCell(k)} | ${mdCell(v)} |`), '');
        break;
      case 'list':
        if (!b.items.length) break;
        for (const it of b.items) {
          out.push(`- ${it.badge ? `〔${it.badge}〕 ` : ''}${it.text.replace(/\r?\n/g, ' ')}`);
          if (it.sub) out.push(`  - ${it.sub.replace(/\r?\n/g, ' ')}`);
        }
        out.push('');
        break;
      case 'table':
        if (!b.rows.length) break;
        out.push(`| ${b.head.map(mdCell).join(' | ')} |`, `|${b.head.map(() => '---').join('|')}|`, ...b.rows.map((r) => `| ${r.map(mdCell).join(' | ')} |`), '');
        break;
      case 'transcript':
        for (const r of b.rows) out.push(`**[${r.time}] ${mdHeading(r.speaker)}:** ${mdInline(r.text)}`, '');
        break;
      case 'hr':
        out.push('---', '');
        break;
    }
  }
  return out.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd() + '\n';
}

const PRINT_CSS = `
:root{color-scheme:light}
*{box-sizing:border-box}
body{font-family:"Hiragino Kaku Gothic ProN","Hiragino Sans","Noto Sans JP","Yu Gothic",Meiryo,system-ui,sans-serif;color:#1f2328;background:#fff;margin:0;line-height:1.65;font-size:14px}
main{max-width:820px;margin:0 auto;padding:32px 24px}
h1{font-size:24px;margin:0 0 12px;border-bottom:3px solid #1f6feb;padding-bottom:8px}
h2{font-size:18px;margin:28px 0 10px;border-left:4px solid #1f6feb;padding-left:8px;break-after:avoid}
h3{font-size:15px;margin:20px 0 8px;break-after:avoid}
.badge{display:inline-block;font-size:11px;font-weight:600;padding:1px 8px;margin-left:8px;border-radius:999px;background:#fff4d6;color:#7a4b00;border:1px solid #e6c36a;vertical-align:middle}
.badge.cand{background:#f2f2f2;color:#444;border-style:dashed;border-color:#999}
table{border-collapse:collapse;width:100%;margin:8px 0 16px;font-size:13px}
th,td{border:1px solid #d0d7de;padding:6px 8px;text-align:left;vertical-align:top}
th{background:#f6f8fa}
table.meta th{width:9em;white-space:nowrap}
ul{padding-left:1.4em}
li{margin:3px 0}
li .sub{display:block;color:#57606a;font-size:12px}
.muted{color:#57606a}
.note{border-left:4px solid #d0d7de;background:#f6f8fa;padding:8px 12px;color:#444;font-size:12.5px;white-space:pre-wrap}
.tr{margin:0 0 6px;break-inside:avoid}
.tr .time{font-family:ui-monospace,Menlo,Consolas,monospace;color:#57606a;font-size:12px;margin-right:6px}
.tr .spk{font-weight:600;margin-right:4px}
.pre{white-space:pre-wrap}
hr{border:0;border-top:1px solid #d0d7de;margin:24px 0}
.printhint{font-size:12px;color:#57606a;background:#eef6ff;border:1px solid #b6d4fe;padding:6px 10px;border-radius:6px;margin-bottom:16px}
footer{margin-top:32px;font-size:11px;color:#57606a;border-top:1px solid #d0d7de;padding-top:8px}
@page{size:A4;margin:16mm 14mm}
@media print{
  body{font-size:11.5pt}
  main{max-width:none;padding:0}
  .printhint{display:none}
  a{color:inherit;text-decoration:none}
  h1,h2,h3{break-after:avoid}
  tr,li,.tr{break-inside:avoid}
  thead{display:table-header-group}
}`;

function badgeHtml(badge?: string) {
  if (!badge) return '';
  const cand = badge.includes('候補') ? ' cand' : '';
  return `<span class="badge${cand}">${escapeHtml(badge)}</span>`;
}

const htmlText = (s: string) => escapeHtml(s).replace(/\r?\n/g, '<br>');

export function renderHtml(title: string, blocks: Block[], footer: string): string {
  const body: string[] = [];
  for (const b of blocks) {
    switch (b.t) {
      case 'h':
        body.push(`<h${b.level}>${escapeHtml(b.text)}${badgeHtml(b.badge)}</h${b.level}>`);
        break;
      case 'p':
        body.push(`<p class="pre${b.muted ? ' muted' : ''}">${escapeHtml(b.text)}</p>`);
        break;
      case 'note':
        body.push(`<div class="note">${escapeHtml(b.text)}</div>`);
        break;
      case 'meta':
        body.push(`<table class="meta"><tbody>${b.rows.map(([k, v]) => `<tr><th>${escapeHtml(k)}</th><td>${htmlText(v)}</td></tr>`).join('')}</tbody></table>`);
        break;
      case 'list':
        if (!b.items.length) break;
        body.push(
          `<ul>${b.items.map((it) => `<li>${badgeHtml(it.badge)}${it.badge ? ' ' : ''}${htmlText(it.text)}${it.sub ? `<span class="sub">${htmlText(it.sub)}</span>` : ''}</li>`).join('')}</ul>`,
        );
        break;
      case 'table':
        if (!b.rows.length) break;
        body.push(
          `<table><thead><tr>${b.head.map((h) => `<th>${escapeHtml(h)}</th>`).join('')}</tr></thead><tbody>${b.rows
            .map((r) => `<tr>${r.map((c) => `<td>${htmlText(c)}</td>`).join('')}</tr>`)
            .join('')}</tbody></table>`,
        );
        break;
      case 'transcript':
        body.push(
          b.rows
            .map((r) => `<p class="tr"><span class="time">[${escapeHtml(r.time)}]</span><span class="spk">${escapeHtml(r.speaker)}:</span>${htmlText(r.text)}</p>`)
            .join(''),
        );
        break;
      case 'hr':
        body.push('<hr>');
        break;
    }
  }
  return `<!doctype html>
<html lang="ja">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="generator" content="MeetLedger">
<title>${escapeHtml(title)}</title>
<style>${PRINT_CSS}</style>
</head>
<body>
<main>
<div class="printhint">PDFにするには、ブラウザの印刷（Ctrl+P / ⌘P）で送信先を「PDFとして保存」にしてください。</div>
${body.join('\n')}
<footer>${escapeHtml(footer)}</footer>
</main>
</body>
</html>
`;
}

/** YYYY-MM-DD HH:mm in the given IANA timezone (falls back to Asia/Tokyo). */
export function fmtDateTime(d: Date | string | null | undefined, tz: string): string {
  if (!d) return '';
  const date = new Date(d);
  if (Number.isNaN(date.getTime())) return '';
  let parts: Intl.DateTimeFormatPart[];
  try {
    parts = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(date);
  } catch {
    return fmtDateTime(date, 'Asia/Tokyo');
  }
  const g = (t: string) => parts.find((p) => p.type === t)?.value ?? '';
  return `${g('year')}-${g('month')}-${g('day')} ${g('hour')}:${g('minute')}`;
}

export function fmtDate(d: Date | string | null | undefined, tz: string): string {
  return fmtDateTime(d, tz).slice(0, 10);
}

/** Content-Disposition with an ASCII fallback and an RFC 5987 UTF-8 filename (Japanese titles). */
export function contentDisposition(kind: 'attachment' | 'inline', title: string, fallback: string, ext: string): string {
  const safe = title
    .replace(/[\u0000-\u001f\u007f/\\?%*:|"<>]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80);
  const ascii = fallback.replace(/[^A-Za-z0-9._-]/g, '_');
  return `${kind}; filename="${ascii}.${ext}"; filename*=UTF-8''${encodeURIComponent((safe || fallback) + '.' + ext)}`;
}
