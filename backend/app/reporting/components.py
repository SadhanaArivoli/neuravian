"""Composable, escaped HTML fragments for scientific reports."""

from __future__ import annotations

import html
from typing import Any, Iterable, Mapping, Sequence

from app.reporting.html import safe_display_value


def metadata_grid(items: Mapping[str, Any] | Iterable[tuple[str, Any]]) -> str:
    pairs = items.items() if isinstance(items, Mapping) else items
    cells = "".join(f'<div class="nf-meta-item"><div class="nf-label">{safe_display_value(k)}</div><div class="nf-value">{safe_display_value(v)}</div></div>' for k, v in pairs)
    return f'<div class="nf-metadata">{cells}</div>'


def statistics_cards(items: Mapping[str, Any] | Iterable[tuple[str, Any]]) -> str:
    pairs = items.items() if isinstance(items, Mapping) else items
    cells = "".join(f'<div class="nf-stat"><div class="nf-label">{safe_display_value(k)}</div><div class="nf-value">{safe_display_value(v)}</div></div>' for k, v in pairs)
    return f'<div class="nf-stats">{cells}</div>'


def key_value_table(items: Mapping[str, Any] | Iterable[tuple[str, Any]]) -> str:
    pairs = items.items() if isinstance(items, Mapping) else items
    rows = "".join(f'<tr><th scope="row">{safe_display_value(k)}</th><td>{safe_display_value(v)}</td></tr>' for k, v in pairs)
    return f'<div class="nf-table-wrap"><table><tbody>{rows}</tbody></table></div>'


def data_table(headers: Sequence[Any], rows: Iterable[Sequence[Any]]) -> str:
    head = "".join(f'<th scope="col">{safe_display_value(v)}</th>' for v in headers)
    body = "".join('<tr>' + ''.join(f'<td>{safe_display_value(v)}</td>' for v in row) + '</tr>' for row in rows)
    return f'<div class="nf-table-wrap"><table><thead><tr>{head}</tr></thead><tbody>{body}</tbody></table></div>'


def _box(kind: str, title: str, text: str) -> str:
    return f'<aside class="nf-box nf-box-{kind}"><div class="nf-box-title">{safe_display_value(title)}</div><div>{safe_display_value(text)}</div></aside>'


def warning_box(title: str, text: str) -> str:
    return _box("warning", title, text)


def info_box(title: str, text: str) -> str:
    return _box("info", title, text)


def figure_block(src: str, alt: str, caption: str = "") -> str:
    return f'<figure class="nf-figure"><img src="{html.escape(src, quote=True)}" alt="{safe_display_value(alt)}"/>' + (f'<figcaption>{safe_display_value(caption)}</figcaption>' if caption else '') + '</figure>'


def download_link(label: str, href: str) -> str:
    safe_href = html.escape(href.rsplit("/", 1)[-1], quote=True)
    return f'<a href="{safe_href}">{safe_display_value(label)}</a>'


def methods_block(text: str) -> str:
    return f'<section class="nf-methods"><h2>Methods</h2><p>{safe_display_value(text)}</p></section>'


def citation_block(citations: Iterable[str]) -> str:
    items = "".join(f'<li>{safe_display_value(c)}</li>' for c in citations)
    return f'<section><h2>References</h2><ol class="nf-citations">{items}</ol></section>'


def footer(text: str = "Generated locally by Neuravian. Research use only.") -> str:
    return f'<footer class="nf-footer">{safe_display_value(text)}</footer>'
