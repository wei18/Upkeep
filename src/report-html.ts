// src/report-html.ts
import type { ConsolidatedReport } from './types.js';

function esc(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function renderHtml(report: ConsolidatedReport): string {
  const s = report.stats;

  const themes = report.themes.map((t) => `
    <section class="theme prio-${esc(t.priority)}">
      <h3>${esc(t.title)} <span class="badge sev-${esc(t.priority)}">${esc(t.priority)}</span></h3>
      <p>${esc(t.narrative)}</p>
      ${t.related_files.length ? `<p class="files">${t.related_files.map((f) => `<code>${esc(f)}</code>`).join(' ')}</p>` : ''}
    </section>`).join('');

  const rows = report.findings.map((f) => `
    <tr class="sev-row-${esc(f.severity)}" data-sev="${esc(f.severity)}">
      <td><span class="badge sev-${esc(f.severity)}">${esc(f.severity)}</span></td>
      <td>${esc(f.confidence)}</td>
      <td><code>${esc(f.file)}</code></td>
      <td>${esc(f.category)}</td>
      <td>${esc(f.reviewers.join(', '))}</td>
      <td>${esc(f.problem)}</td>
      <td>${esc(f.suggestion)}</td>
    </tr>`).join('');

  const synNote = report.synthesisStatus !== 'ok'
    ? `<p class="warn">Synthesis ${esc(report.synthesisStatus)} — showing raw findings only.</p>` : '';
  const failedNote = s.failedReviewers.length
    ? `<p class="warn">⚠️ Failed reviewers (incomplete): ${esc(s.failedReviewers.join(', '))}</p>` : '';

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Repo Audit Report</title>
<style>
  body{font:14px/1.5 system-ui,-apple-system,sans-serif;margin:0;padding:2rem;color:#1a1a1a;background:#fafafa}
  h1,h2,h3{margin:.4em 0}
  .badge{display:inline-block;padding:.1em .5em;border-radius:6px;font-size:.8em;color:#fff}
  .sev-high{background:#d33}.sev-medium{background:#e8820c}.sev-low{background:#b39200}
  .stats{display:flex;gap:1rem;flex-wrap:wrap;margin:1rem 0}
  .stat{padding:.6rem 1rem;border-radius:8px;background:#fff;box-shadow:0 1px 3px #0002}
  table{border-collapse:collapse;width:100%;background:#fff;box-shadow:0 1px 3px #0002}
  th,td{border-bottom:1px solid #eee;padding:.5rem;text-align:left;vertical-align:top}
  th{background:#f0f0f0}
  code{background:#f4f4f4;padding:.1em .3em;border-radius:4px}
  .theme{background:#fff;border-left:4px solid #888;padding:.5rem 1rem;margin:.5rem 0;border-radius:0 8px 8px 0}
  .theme.prio-high{border-color:#d33}.theme.prio-medium{border-color:#e8820c}.theme.prio-low{border-color:#b39200}
  .warn{color:#b30000;font-weight:600}
  .filters{margin:1rem 0}
  .filters button{margin-right:.5rem;padding:.3rem .8rem;border:1px solid #ccc;border-radius:6px;background:#fff;cursor:pointer}
  .filters button.active{background:#1a1a1a;color:#fff}
</style></head>
<body>
<h1>🔍 Repo Audit Report</h1>
<p>Generated ${esc(report.generatedAtISO)}</p>
${synNote}${failedNote}
${report.executiveSummary ? `<section><h2>Executive Summary</h2><p>${esc(report.executiveSummary)}</p></section>` : ''}
<div class="stats">
  <div class="stat"><span class="badge sev-high">High</span> ${s.bySeverity.high}</div>
  <div class="stat"><span class="badge sev-medium">Medium</span> ${s.bySeverity.medium}</div>
  <div class="stat"><span class="badge sev-low">Low</span> ${s.bySeverity.low}</div>
  <div class="stat"><strong>Total</strong> ${s.total}</div>
</div>
${report.themes.length ? `<h2>Themes</h2>${themes}` : ''}
<h2>Findings</h2>
<div class="filters">
  <button data-f="all" class="active">All</button>
  <button data-f="high">High</button>
  <button data-f="medium">Medium</button>
  <button data-f="low">Low</button>
</div>
<table><thead><tr><th>Severity</th><th>Conf</th><th>File</th><th>Category</th><th>Reviewers</th><th>Problem</th><th>Suggestion</th></tr></thead>
<tbody>${rows}</tbody></table>
<script>
(function(){
  var btns=document.querySelectorAll('.filters button');
  btns.forEach(function(b){b.addEventListener('click',function(){
    btns.forEach(function(x){x.classList.remove('active')});
    b.classList.add('active');
    var f=b.getAttribute('data-f');
    document.querySelectorAll('tbody tr').forEach(function(tr){
      tr.style.display=(f==='all'||tr.getAttribute('data-sev')===f)?'':'none';
    });
  });});
})();
</script>
</body></html>`;
}
