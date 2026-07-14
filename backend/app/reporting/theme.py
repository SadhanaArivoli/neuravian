"""The single CSS theme used by all first-party NeuroForge HTML reports."""

REPORT_SYSTEM_MARKER = "neuroforge-report-system-v1"

REPORT_CSS = r"""
:root{color-scheme:dark;--nf-bg:#090d18;--nf-surface:#111827;--nf-surface-2:#172033;
--nf-border:#29344a;--nf-text:#e6edf7;--nf-muted:#9eabc0;--nf-accent:#a78bfa;
--nf-accent-2:#67e8f9;--nf-warn:#fbbf24;--nf-danger:#fb7185;--nf-success:#6ee7b7}
*,*::before,*::after{box-sizing:border-box}
html,body{background:#090d18;color:#e6edf7;color-scheme:dark;margin:0;min-height:100%}
html{font-size:16px}
body{font-family:Inter,ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;
line-height:1.6;overflow-wrap:anywhere}
a{color:#67e8f9;text-underline-offset:3px}a:hover{color:#a5f3fc}
.nf-page{width:min(100%,1040px);margin:0 auto;padding:clamp(20px,4vw,48px)}
.nf-header{border-bottom:1px solid var(--nf-border);padding-bottom:24px;margin-bottom:28px}
.nf-kicker{color:var(--nf-accent-2);font-size:.72rem;font-weight:750;letter-spacing:.13em;text-transform:uppercase}
h1{color:#f8fafc;font-size:clamp(1.55rem,4vw,2.25rem);line-height:1.18;margin:.4rem 0}
.nf-subtitle,.nf-muted{color:var(--nf-muted)}
h2{color:#ddd6fe;font-size:1.15rem;margin:32px 0 12px;padding-bottom:8px;border-bottom:1px solid var(--nf-border)}
h3{color:#f1f5f9;font-size:1rem;margin:22px 0 8px}p{margin:.6rem 0 1rem}
code{background:#0b1220;border:1px solid #243047;border-radius:5px;color:#c4b5fd;padding:.12rem .34rem;font-size:.88em}
.nf-metadata,.nf-stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(170px,1fr));gap:10px;margin:16px 0}
.nf-meta-item,.nf-stat{background:var(--nf-surface);border:1px solid var(--nf-border);border-radius:10px;padding:12px 14px;min-width:0}
.nf-label{color:var(--nf-muted);font-size:.72rem;font-weight:700;letter-spacing:.055em;text-transform:uppercase}
.nf-value{color:var(--nf-text);font-size:.95rem;margin-top:3px}.nf-stat .nf-value{color:#f8fafc;font-size:1.3rem;font-weight:700}
.nf-table-wrap{width:100%;overflow-x:auto;border:1px solid var(--nf-border);border-radius:10px;margin:12px 0 20px}
table{border-collapse:collapse;width:100%;font-size:.84rem;background:var(--nf-surface)}
th,td{padding:9px 11px;text-align:left;vertical-align:top;border-bottom:1px solid var(--nf-border)}
th{background:#1a2437;color:#cbd5e1;font-weight:700}td{color:#e2e8f0}tbody tr:nth-child(even) td{background:#131c2c}
tbody tr:last-child td{border-bottom:0}tbody tr:hover td{background:#1b263a}
.nf-box{border:1px solid var(--nf-border);border-left-width:4px;border-radius:9px;background:var(--nf-surface);padding:12px 15px;margin:14px 0}
.nf-box-info{border-left-color:var(--nf-accent-2)}.nf-box-warning{border-left-color:var(--nf-warn)}
.nf-box-title{font-weight:750;margin-bottom:3px}.nf-box-warning .nf-box-title{color:#fde68a}.nf-box-info .nf-box-title{color:#a5f3fc}
.nf-figure{background:var(--nf-surface);border:1px solid var(--nf-border);border-radius:10px;padding:12px;margin:16px 0}
.nf-figure img{display:block;width:auto;max-width:100%;height:auto;margin:auto;border-radius:6px}.nf-figure figcaption{color:var(--nf-muted);font-size:.8rem;margin-top:9px}
.nf-downloads{display:grid;grid-template-columns:repeat(auto-fit,minmax(210px,1fr));gap:9px;padding:0;list-style:none}
.nf-downloads a{display:block;background:var(--nf-surface);border:1px solid var(--nf-border);border-radius:8px;padding:10px 12px;text-decoration:none}
.nf-citations{padding-left:1.35rem}.nf-citations li{margin:.5rem 0}.nf-methods{color:#d7deea}
.nf-badge{display:inline-block;background:#1e3a5f;color:#bae6fd;border:1px solid #285277;border-radius:999px;padding:2px 8px;font-size:.76rem;margin:2px}
.nf-footer{color:var(--nf-muted);border-top:1px solid var(--nf-border);font-size:.78rem;margin-top:40px;padding-top:16px}
.stats-row,.figures-grid{display:flex;flex-wrap:wrap;gap:12px;margin:14px 0}.stat-card{flex:1;min-width:130px;background:var(--nf-surface);border:1px solid var(--nf-border);border-radius:10px;padding:14px}
.stat-num{display:block;color:#f8fafc;font-size:1.45rem;font-weight:750}.stat-lbl,.empty,figcaption,.cit-text{color:var(--nf-muted);font-size:.8rem}.figures-grid figure{flex:1;min-width:260px;margin:0}
img{max-width:100%;height:auto;border-radius:6px}.badge{display:inline-block;background:#1e3a5f;color:#bae6fd;border-radius:999px;padding:2px 8px}.warnings{list-style:none;padding:0}.warnings li{background:var(--nf-surface);border:1px solid var(--nf-warn);border-radius:8px;color:#fde68a;padding:10px 12px;margin:8px 0}.no-warnings{color:var(--nf-success)}
.repro-list{list-style:none;padding:0}.repro-list li{border-bottom:1px solid var(--nf-border);padding:6px 0}.methods-section p{color:#d7deea}.citation-list{padding-left:1.35rem}
@media(max-width:620px){.nf-page{padding:18px 14px}.nf-metadata,.nf-stats{grid-template-columns:1fr 1fr}th,td{padding:7px 8px}}
@media(max-width:390px){.nf-metadata,.nf-stats{grid-template-columns:1fr}}
@media print{:root{color-scheme:light}html,body{background:#fff!important;color:#111!important}.nf-page{max-width:none;padding:0}
.nf-header{border-color:#aaa}h1,h2,h3,.nf-value,td,.nf-methods{color:#111!important}.nf-subtitle,.nf-muted,.nf-label,.nf-footer{color:#444!important}
.nf-meta-item,.nf-stat,.nf-figure,.nf-box,.nf-table-wrap,table,th,td{background:#fff!important;border-color:#bbb!important}th{color:#111!important}
a{color:#111!important;text-decoration:underline}.nf-downloads a{background:#fff!important;border-color:#bbb!important}h2{break-after:avoid}.nf-figure,table{break-inside:avoid}}
"""
