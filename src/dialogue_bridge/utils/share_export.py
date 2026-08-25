from __future__ import annotations

import re
import textwrap
import zlib
from datetime import datetime, timezone
from io import BytesIO
from pathlib import Path
from typing import Iterable, Literal, Optional

from fontTools.ttLib import TTFont
from fontTools.subset import Options, Subsetter

from core.database import ConversationTable, MessageTable
from core.logging import get_logger
from utils.conversations import build_message_lineage

logger = get_logger(__name__)

PdfExportMode = Literal["full", "branch", "message"]


_INK = (24, 24, 28)
_INK_SOFT = (84, 84, 92)
_INK_FAINT = (140, 140, 148)
_RULE = (224, 224, 230)
_PAGE_BG = (255, 255, 255)
_CODE_BG = (245, 245, 247)
_CODE_INK = (38, 38, 44)
_DARK_MAGENTA = (122, 31, 92)
_LOGO_PATH = Path(__file__).resolve().parent / "assets" / "logo.png"


def _messages_from_branch_path(messages: Iterable[MessageTable], branch_path: list[str] | None) -> list[MessageTable]:
    if not branch_path:
        return []

    by_id = {message.id: message for message in messages}
    selected: list[MessageTable] = []
    expected_parent_id: str | None = None
    for message_id in branch_path:
        message = by_id.get(message_id)
        if message is None or message.parent_message_id != expected_parent_id:
            return []
        selected.append(message)
        expected_parent_id = message.id
    return selected


def select_scoped_messages(
    conversation: ConversationTable,
    message_id: str,
    mode: PdfExportMode,
    branch_path: list[str] | None = None,
) -> list[MessageTable]:
    branch = build_message_lineage(conversation.messages, message_id)
    if not branch:
        return []
    if mode == "full":
        visible_branch = _messages_from_branch_path(conversation.messages, branch_path)
        if visible_branch and message_id in {message.id for message in visible_branch}:
            return visible_branch
        return branch
    if mode == "message":
        target = branch[-1]
        return branch[-2:] if len(branch) >= 2 and branch[-2].sender == "user" else [target]
    return branch


def conversation_pdf_filename(conversation: ConversationTable, mode: PdfExportMode) -> str:
    title = conversation.title or conversation.agent_name or "conversation"
    safe_title = re.sub(r"[^A-Za-z0-9._-]+", "-", title).strip("-._")[:80]
    safe_mode = {"full": "conversation", "branch": "up-to-message", "message": "message"}[mode]
    return f"{safe_title or 'conversation'}-{safe_mode}.pdf"


def render_conversation_pdf(conversation: ConversationTable, messages: list[MessageTable], mode: PdfExportMode) -> bytes:
    title = conversation.title or conversation.agent_name or "Conversation"
    exported_at = datetime.now(timezone.utc).strftime("%b %d, %Y · %H:%M UTC")
    writer = _PdfDocument(title=title, exported_at=exported_at)
    writer.add_title(title)
    writer.add_meta_row("Agent", conversation.agent.name if conversation.agent else conversation.agent_name or "Unknown")
    writer.add_meta_row("Exported", exported_at)
    writer.add_rule()

    if not messages:
        writer.add_paragraph("No messages were available for this export.", size=11, color=_INK_SOFT)
    for index, message in enumerate(messages, start=1):
        writer.add_message(index, message)

    return writer.to_bytes()


class _PdfDocument:
    page_width = 612
    page_height = 792
    margin_x = 56
    margin_bottom = 60
    header_band = 56
    content_top = page_height - 78
    leading = 14

    def __init__(self, title: str, exported_at: str) -> None:
        self.title = title
        self.exported_at = exported_at
        self.fonts = _FontRegistry.load()
        self.logo = _load_logo()
        self.pages: list[list[str]] = []
        self.current: list[str] = []
        self.y = 0
        self._page_count = 0
        self._new_page()

    def _new_page(self) -> None:
        if self.current:
            self.pages.append(self.current)
        self.current = []
        self._page_count += 1
        self.y = self.content_top

        self._draw_rect(0, 0, self.page_width, self.page_height, _PAGE_BG)

        if self.logo is not None:
            logo_h = 26.0
            logo_w = logo_h * (self.logo.width / self.logo.height)
            self._draw_image(self.logo, self.margin_x, self.page_height - 42, logo_w, logo_h)

        ts_w = self._measure_text(self.exported_at, 8.5)
        self._text(
            self.exported_at,
            self.page_width - self.margin_x - ts_w,
            self.page_height - 30,
            8.5,
            color=_INK_FAINT,
        )

        footer_rule_y = 42
        self._draw_rect(
            self.margin_x,
            footer_rule_y,
            self.page_width - (self.margin_x * 2),
            0.4,
            _RULE,
        )

        page_label = str(self._page_count)
        page_label_w = self._measure_text(page_label, 8.5)
        self._text(
            page_label,
            (self.page_width - page_label_w) / 2,
            26,
            8.5,
            color=_INK_FAINT,
        )

    def _ensure_space(self, needed: float) -> None:
        if self.y - needed < self.margin_bottom:
            self._new_page()

    def _draw_rect(self, x: float, y: float, width: float, height: float, color: tuple[int, int, int]) -> None:
        r, g, b = (value / 255 for value in color)
        self.current.append(f"{r:.3f} {g:.3f} {b:.3f} rg {x:.2f} {y:.2f} {width:.2f} {height:.2f} re f")

    def _draw_image(self, image: "_PngImage", x: float, y: float, width: float, height: float) -> None:
        self.current.append(
            f"q {width:.2f} 0 0 {height:.2f} {x:.2f} {y:.2f} cm /{image.resource_name} Do Q"
        )

    def _measure_text(self, value: str, size: float) -> float:
        width = 0.0
        for character in value:
            font, codepoint = self.fonts.font_for_codepoint(ord(character))
            width += font.width_for_cid(codepoint) * size / 1000
        return width

    def _text(
        self,
        value: str,
        x: float,
        y: float,
        size: float,
        *,
        color: tuple[int, int, int] = _INK,
        bold: bool = False,
    ) -> None:
        r, g, b = (component / 255 for component in color)
        cursor_x = x
        for font, encoded, width in self.fonts.encode_runs(value, size):
            self.current.append(
                f"BT /{font.resource_name} {size:.2f} Tf {r:.3f} {g:.3f} {b:.3f} rg {cursor_x:.2f} {y:.2f} Td <{encoded}> Tj ET"
            )
            cursor_x += width

    def add_title(self, title: str) -> None:
        lines = _wrap_text(_clean_text(title), 50)
        for line in lines[:3]:
            self._ensure_space(26)
            self._text(line, self.margin_x, self.y, 22, color=_INK, bold=True)
            self.y -= 26
        self.y -= 4

    def add_meta_row(self, label: str, value: str) -> None:
        self._ensure_space(18)
        self._text(label.upper(), self.margin_x, self.y, 8, color=_DARK_MAGENTA)
        self._text(_clean_text(value), self.margin_x + 80, self.y, 10, color=_INK_SOFT)
        self.y -= 17

    def add_rule(self) -> None:
        self._ensure_space(18)
        self._draw_rect(self.margin_x, self.y - 4, self.page_width - (self.margin_x * 2), 0.6, _RULE)
        self.y -= 24

    def add_paragraph(self, value: str, *, size: float = 10, color: tuple[int, int, int] = _INK) -> None:
        for line in _wrap_text(_clean_text(value), 86):
            self._ensure_space(self.leading)
            self._text(line, self.margin_x, self.y, size, color=color)
            self.y -= self.leading

    def add_message(self, index: int, message: MessageTable) -> None:
        is_ai = message.sender == "ai"
        sender = "Assistant" if is_ai else "You"
        role_color = _DARK_MAGENTA if is_ai else _INK
        created = message.created_at.strftime("%b %d, %Y · %H:%M") if message.created_at else ""

        blocks = _markdown_blocks(message.content or "")
        attachments = list(message.attachments or [])
        if attachments:
            attachment_names = ", ".join(_clean_text(item.file_name) for item in attachments)
            blocks.append(_MarkdownBlock("paragraph", f"Attachments: {attachment_names}"))

        estimated_height = 38 + sum(block.estimated_lines for block in blocks) * self.leading
        self._ensure_space(min(estimated_height, self.page_height - 200))

        role_label = sender.upper()
        self._text(role_label, self.margin_x, self.y, 9.5, color=role_color)
        cursor_x = self.margin_x + self._measure_text(role_label, 9.5)
        if created:
            separator = "   ·   "
            self._text(separator, cursor_x, self.y, 9.5, color=_INK_FAINT)
            cursor_x += self._measure_text(separator, 9.5)
            self._text(created, cursor_x, self.y, 9.5, color=_INK_FAINT)
        self.y -= 12

        self._draw_rect(
            self.margin_x,
            self.y + 4,
            self.page_width - (self.margin_x * 2),
            0.4,
            _RULE,
        )
        self.y -= 10

        if not blocks:
            blocks = [_MarkdownBlock("paragraph", "(No text content)")]
        for block in blocks:
            self._render_markdown_block(block)
        self.y -= 14

    def _render_markdown_block(self, block: "_MarkdownBlock") -> None:
        if block.kind == "blank":
            self.y -= 6
            return
        if block.kind == "heading":
            level = (block.data or {}).get("level", 1)
            size = {1: 14, 2: 13, 3: 12}.get(level, 11)
            line_step = size + 5
            for line in _wrap_text(block.text, 70):
                self._ensure_space(line_step + 4)
                self._text(line, self.margin_x, self.y, size, color=_INK, bold=True)
                self.y -= line_step
            self.y -= 4
            return
        if block.kind == "hr":
            self._ensure_space(16)
            self.y -= 4
            self._draw_rect(
                self.margin_x + 60,
                self.y,
                self.page_width - (self.margin_x + 60) * 2,
                0.5,
                _RULE,
            )
            self.y -= 12
            return
        if block.kind == "code":
            language = (block.data or {}).get("language", "")
            lines = _wrap_text(block.text, 78) or [""]
            line_h = 13
            padding_top = 9
            padding_bottom = 8
            tag_height = 12 if language else 0
            block_height = padding_top + (len(lines) * line_h) + padding_bottom
            self._ensure_space(block_height + tag_height + 6)

            if language:
                self._text(
                    language.upper(),
                    self.margin_x + 14,
                    self.y,
                    7.5,
                    color=_DARK_MAGENTA,
                )
                self.y -= tag_height

            block_top = self.y + 6
            block_left = self.margin_x
            block_width = self.page_width - (self.margin_x * 2)
            self._draw_rect(block_left, block_top - block_height, block_width, block_height, _CODE_BG)
            self._draw_rect(block_left, block_top - block_height, 2.0, block_height, _DARK_MAGENTA)

            text_y = block_top - padding_top - 9
            for line in lines:
                self._text(line, block_left + 14, text_y, 9, color=_CODE_INK)
                text_y -= line_h
            self.y = block_top - block_height - 8
            return
        if block.kind == "quote":
            wrapped = _wrap_text(block.text, 80)
            text_x = self.margin_x + 16
            for line in wrapped:
                self._ensure_space(self.leading)
                self._draw_rect(self.margin_x + 4, self.y - 2, 2, self.leading, _DARK_MAGENTA)
                self._text(line, text_x, self.y, 10, color=_INK_SOFT)
                self.y -= self.leading
            self.y -= 4
            return
        if block.kind == "table" and block.data:
            self._render_table(block.data.get("headers", []), block.data.get("rows", []))
            return
        if block.kind == "task":
            done = bool((block.data or {}).get("done"))
            marker = "✓" if done else "□"
            marker_color = _DARK_MAGENTA if done else _INK_FAINT
            text_color = _INK if done else _INK_SOFT
            wrapped = _wrap_text(block.text, 78)
            indent = self._measure_text("X  ", 10)
            for line_index, line in enumerate(wrapped):
                self._ensure_space(self.leading)
                if line_index == 0:
                    self._text(marker, self.margin_x + 4, self.y, 10, color=marker_color)
                self._text(line, self.margin_x + 4 + indent, self.y, 10, color=text_color)
                self.y -= self.leading
            return
        if block.kind == "footnote":
            fid = (block.data or {}).get("id", "")
            label = f"[{fid}] " if fid else ""
            wrapped = _wrap_text(label + block.text, 92)
            for line in wrapped:
                self._ensure_space(self.leading - 2)
                self._text(line, self.margin_x + 4, self.y, 9, color=_INK_SOFT)
                self.y -= self.leading - 2
            self.y -= 2
            return
        if block.kind == "bullet":
            wrapped = _wrap_text(block.text, 80)
            bullet_prefix = "•  "
            prefix_w = self._measure_text(bullet_prefix, 10)
            for line_index, line in enumerate(wrapped):
                self._ensure_space(self.leading)
                if line_index == 0:
                    self._text("•", self.margin_x + 4, self.y, 10, color=_DARK_MAGENTA)
                    self._text(line, self.margin_x + 4 + prefix_w, self.y, 10, color=_INK)
                else:
                    self._text(line, self.margin_x + 4 + prefix_w, self.y, 10, color=_INK)
                self.y -= self.leading
            return
        for line in _wrap_text(block.text, 86):
            self._ensure_space(self.leading)
            self._text(line, self.margin_x, self.y, 10, color=_INK)
            self.y -= self.leading

    def _render_table(self, headers: list[str], rows: list[list[str]]) -> None:
        if not headers and not rows:
            return
        col_count = max(len(headers), max((len(row) for row in rows), default=0))
        if col_count == 0:
            return
        table_width = self.page_width - (self.margin_x * 2)
        col_width = table_width / col_count
        chars_per_col = max(5, int(col_width / 5.5))
        line_h = 13
        pad_top = 11
        pad_bottom = 5

        def draw_row(cells: list[str], size: float, color: tuple[int, int, int], bg: Optional[tuple[int, int, int]] = None) -> None:
            wrapped_cells = []
            for col_index in range(col_count):
                cell = cells[col_index] if col_index < len(cells) else ""
                wrapped_cells.append(_wrap_text(cell, chars_per_col) or [""])
            n_lines = max((len(w) for w in wrapped_cells), default=1)
            row_h = pad_top + (n_lines - 1) * line_h + pad_bottom
            self._ensure_space(row_h + 2)
            top_y = self.y
            if bg is not None:
                self._draw_rect(self.margin_x, top_y - row_h, table_width, row_h, bg)
            for col_index, cell_lines in enumerate(wrapped_cells):
                cx = self.margin_x + col_index * col_width + 6
                cy = top_y - pad_top
                for cell_line in cell_lines:
                    self._text(cell_line, cx, cy, size, color=color)
                    cy -= line_h
            self.y = top_y - row_h

        if headers:
            draw_row(headers, 9.5, _DARK_MAGENTA, bg=(250, 240, 247))
            self._draw_rect(self.margin_x, self.y, table_width, 0.6, _DARK_MAGENTA)
            self.y -= 1

        for row_index, row in enumerate(rows):
            draw_row(row, 10, _INK)
            if row_index < len(rows) - 1:
                self._draw_rect(self.margin_x, self.y, table_width, 0.3, _RULE)
                self.y -= 1

        self._draw_rect(self.margin_x, self.y, table_width, 0.4, _RULE)
        self.y -= 14

    def to_bytes(self) -> bytes:
        if self.current:
            self.pages.append(self.current)
            self.current = []
        images = [self.logo] if self.logo is not None else []
        return _build_pdf(self.pages, self.fonts, images)


class _MarkdownBlock:
    def __init__(self, kind: str, text: str, data: Optional[dict] = None) -> None:
        self.kind = kind
        self.text = text
        self.data = data

    @property
    def estimated_lines(self) -> int:
        if self.kind == "table" and self.data:
            return len(self.data.get("rows", [])) + 2
        if self.kind == "hr":
            return 1
        width = 78 if self.kind == "code" else 84
        return max(1, len(_wrap_text(self.text, width)))


def _clean_text(value: str) -> str:
    return re.sub(r"\s+", " ", value.replace("\x00", " ")).strip()


def _is_table_separator(line: str) -> bool:
    s = line.strip()
    if "|" not in s:
        return False
    inner = s.strip("|")
    parts = [p.strip() for p in inner.split("|")]
    return bool(parts) and all(p and re.fullmatch(r":?-{2,}:?", p) for p in parts)


def _split_table_row(line: str) -> list[str]:
    s = line.strip()
    if s.startswith("|"):
        s = s[1:]
    if s.endswith("|"):
        s = s[:-1]
    return [_clean_inline_markdown(cell.strip()) for cell in s.split("|")]


def _markdown_blocks(value: str) -> list[_MarkdownBlock]:
    raw_lines = value.replace("\x00", " ").replace("\r\n", "\n").replace("\r", "\n").split("\n")
    lines = [line.rstrip() for line in raw_lines]
    blocks: list[_MarkdownBlock] = []
    n = len(lines)
    i = 0
    while i < n:
        line = lines[i]
        stripped = line.lstrip()

        if stripped.startswith("```"):
            language = stripped[3:].strip()
            i += 1
            code_lines: list[str] = []
            while i < n and not lines[i].lstrip().startswith("```"):
                code_lines.append(lines[i])
                i += 1
            if i < n:
                i += 1
            blocks.append(_MarkdownBlock("code", "\n".join(code_lines), data={"language": language}))
            continue

        if not line.strip():
            blocks.append(_MarkdownBlock("blank", ""))
            i += 1
            continue

        if re.match(r"^\s*([-*_])(?:\s*\1){2,}\s*$", line):
            blocks.append(_MarkdownBlock("hr", ""))
            i += 1
            continue

        if "|" in line and i + 1 < n and _is_table_separator(lines[i + 1]):
            headers = _split_table_row(line)
            i += 2
            rows: list[list[str]] = []
            while i < n and lines[i].strip() and "|" in lines[i]:
                rows.append(_split_table_row(lines[i]))
                i += 1
            blocks.append(_MarkdownBlock("table", "", data={"headers": headers, "rows": rows}))
            continue

        heading = re.match(r"^\s{0,3}(#{1,6})\s+(.+)$", line)
        if heading:
            level = len(heading.group(1))
            blocks.append(
                _MarkdownBlock("heading", _clean_inline_markdown(heading.group(2)), data={"level": level})
            )
            i += 1
            continue

        quote = re.match(r"^\s{0,3}>\s?(.*)$", line)
        if quote:
            quote_lines = [_clean_inline_markdown(quote.group(1))]
            i += 1
            while i < n:
                nxt = re.match(r"^\s{0,3}>\s?(.*)$", lines[i])
                if not nxt:
                    break
                quote_lines.append(_clean_inline_markdown(nxt.group(1)))
                i += 1
            joined = "\n".join(line for line in quote_lines if line.strip())
            blocks.append(_MarkdownBlock("quote", joined or ""))
            continue

        footnote_def = re.match(r"^\s*\[\^([^\]]+)\]:\s*(.+)$", line)
        if footnote_def:
            blocks.append(
                _MarkdownBlock(
                    "footnote",
                    _clean_inline_markdown(footnote_def.group(2)),
                    data={"id": footnote_def.group(1)},
                )
            )
            i += 1
            continue

        bullet = re.match(r"^\s*(?:[-*+]|\d+[.)])\s+(.+)$", line)
        if bullet:
            text = bullet.group(1)
            task_match = re.match(r"^\[([ xX])\]\s+(.+)$", text)
            if task_match:
                blocks.append(
                    _MarkdownBlock(
                        "task",
                        _clean_inline_markdown(task_match.group(2)),
                        data={"done": task_match.group(1).lower() == "x"},
                    )
                )
            else:
                blocks.append(_MarkdownBlock("bullet", _clean_inline_markdown(text)))
            i += 1
            continue

        cleaned = _clean_inline_markdown(line)
        if cleaned:
            blocks.append(_MarkdownBlock("paragraph", cleaned))
        else:
            blocks.append(_MarkdownBlock("blank", ""))
        i += 1

    while blocks and blocks[-1].kind == "blank":
        blocks.pop()
    return blocks


def _clean_inline_markdown(value: str) -> str:
    text = re.sub(r"<!--.*?-->", "", value, flags=re.DOTALL)
    text = re.sub(r"<[^>]+>", "", text)
    text = re.sub(r"!\[([^\]]*)\]\([^)]+\)", lambda m: m.group(1) or "[image]", text)
    text = re.sub(r"\[([^\]]+)\]\([^)]+\)", r"\1", text)
    text = re.sub(r"\[\^[^\]]+\]", "", text)
    text = re.sub(r"\*\*([^*]+)\*\*", r"\1", text)
    text = re.sub(r"__([^_]+)__", r"\1", text)
    text = re.sub(r"\*([^*]+)\*", r"\1", text)
    text = re.sub(r"_([^_]+)_", r"\1", text)
    text = re.sub(r"`([^`]+)`", r"\1", text)
    return _clean_text(text)


def _wrap_text(value: str, width: int) -> list[str]:
    paragraphs = value.splitlines() or [value]
    lines: list[str] = []
    for paragraph in paragraphs:
        wrapped = textwrap.wrap(paragraph.strip(), width=width, replace_whitespace=True, drop_whitespace=True)
        lines.extend(wrapped or [""])
    return lines


class _PngImage:
    def __init__(
        self,
        width: int,
        height: int,
        rgb_stream: bytes,
        alpha_stream: Optional[bytes],
        resource_name: str = "Im1",
    ) -> None:
        self.width = width
        self.height = height
        self.rgb_stream = rgb_stream
        self.alpha_stream = alpha_stream
        self.resource_name = resource_name


def _defilter_png(data: bytes, width: int, height: int, bpp: int) -> bytes:
    stride = width * bpp
    out = bytearray(stride * height)
    prev = bytes(stride)
    pos = 0
    for row in range(height):
        if pos >= len(data):
            break
        ftype = data[pos]
        pos += 1
        line = bytearray(data[pos:pos + stride])
        pos += stride
        if ftype == 0:
            pass
        elif ftype == 1:
            for x in range(bpp, stride):
                line[x] = (line[x] + line[x - bpp]) & 0xFF
        elif ftype == 2:
            for x in range(stride):
                line[x] = (line[x] + prev[x]) & 0xFF
        elif ftype == 3:
            for x in range(stride):
                left = line[x - bpp] if x >= bpp else 0
                up = prev[x]
                line[x] = (line[x] + ((left + up) >> 1)) & 0xFF
        elif ftype == 4:
            for x in range(stride):
                a = line[x - bpp] if x >= bpp else 0
                b = prev[x]
                c = prev[x - bpp] if x >= bpp else 0
                p = a + b - c
                pa = abs(p - a)
                pb = abs(p - b)
                pc = abs(p - c)
                if pa <= pb and pa <= pc:
                    pred = a
                elif pb <= pc:
                    pred = b
                else:
                    pred = c
                line[x] = (line[x] + pred) & 0xFF
        else:
            raise ValueError(f"unsupported PNG filter {ftype}")
        out[row * stride:(row + 1) * stride] = line
        prev = bytes(line)
    return bytes(out)


def _decode_png(path: Path) -> _PngImage:
    raw = path.read_bytes()
    if raw[:8] != b"\x89PNG\r\n\x1a\n":
        raise ValueError("not a PNG file")
    pos = 8
    width = height = bit_depth = color_type = 0
    idat: list[bytes] = []
    while pos < len(raw):
        length = int.from_bytes(raw[pos:pos + 4], "big")
        pos += 4
        ctype = raw[pos:pos + 4].decode("ascii", errors="replace")
        pos += 4
        chunk = raw[pos:pos + length]
        pos += length + 4  # skip CRC
        if ctype == "IHDR":
            width = int.from_bytes(chunk[0:4], "big")
            height = int.from_bytes(chunk[4:8], "big")
            bit_depth = chunk[8]
            color_type = chunk[9]
        elif ctype == "IDAT":
            idat.append(chunk)
        elif ctype == "IEND":
            break

    if bit_depth != 8 or color_type not in (2, 6):
        raise ValueError(f"unsupported PNG (bit_depth={bit_depth}, color_type={color_type})")

    decompressed = zlib.decompress(b"".join(idat))
    bpp = 3 if color_type == 2 else 4
    pixels = _defilter_png(decompressed, width, height, bpp)

    if color_type == 2:
        rgb_stream = zlib.compress(pixels, 6)
        alpha_stream = None
    else:
        pixel_count = width * height
        rgb = bytearray(pixel_count * 3)
        alpha = bytearray(pixel_count)
        for i in range(pixel_count):
            src = i * 4
            dst = i * 3
            rgb[dst] = pixels[src]
            rgb[dst + 1] = pixels[src + 1]
            rgb[dst + 2] = pixels[src + 2]
            alpha[i] = pixels[src + 3]
        rgb_stream = zlib.compress(bytes(rgb), 6)
        alpha_stream = zlib.compress(bytes(alpha), 6)
    return _PngImage(width, height, rgb_stream, alpha_stream)


def _load_logo() -> Optional[_PngImage]:
    if not _LOGO_PATH.exists():
        return None
    try:
        return _decode_png(_LOGO_PATH)
    except (OSError, ValueError) as exc:
        logger.warning("logo_load_failed", "Failed to load logo for PDF export", path=str(_LOGO_PATH), error=str(exc))
        return None


class _UnicodeFont:
    def __init__(self, path: Path, font_number: int = 0, resource_name: str = "F1") -> None:
        self.path = path
        self.font_number = font_number
        self.resource_name = resource_name
        self.ttf = TTFont(str(path), lazy=True, fontNumber=font_number)
        self.units_per_em = int(self.ttf["head"].unitsPerEm)
        self.cmap = self.ttf.getBestCmap() or {}
        self.hmtx = self.ttf["hmtx"].metrics
        self.used_cids: set[int] = set()

    def supports(self, codepoint: int) -> bool:
        return codepoint in self.cmap

    def encode_codepoints(self, codepoints: list[int]) -> str:
        self.used_cids.update(codepoints)
        return b"".join(codepoint.to_bytes(2, "big") for codepoint in codepoints).hex().upper()

    def width_for_cid(self, cid: int) -> int:
        glyph_name = self.cmap.get(cid)
        if not glyph_name:
            return 500
        width, _ = self.hmtx.get(glyph_name, (self.units_per_em // 2, 0))
        return max(0, round((width / self.units_per_em) * 1000))

    def subset_data_and_glyph_ids(self, cids: list[int]) -> tuple[bytes, dict[str, int]]:
        options = Options()
        options.name_IDs = ["*"]
        options.name_legacy = True
        options.name_languages = ["*"]
        subsetter = Subsetter(options=options)
        subsetter.populate(unicodes=cids)
        ttf = TTFont(str(self.path), fontNumber=self.font_number)
        subsetter.subset(ttf)
        output = BytesIO()
        ttf.save(output)
        glyph_ids = {name: index for index, name in enumerate(ttf.getGlyphOrder())}
        return output.getvalue(), glyph_ids

    @property
    def font_name(self) -> str:
        suffix = str(self.font_number) if self.font_number else ""
        return (re.sub(r"[^A-Za-z0-9]", "", self.path.stem) or "MagenticUnicode") + suffix


class _FontRegistry:
    def __init__(self, fonts: list[_UnicodeFont]) -> None:
        if not fonts:
            raise RuntimeError("No Unicode-capable TrueType font found for PDF export.")
        self.fonts = fonts
        self.fallback_codepoint = 0x25A1

    @classmethod
    def load(cls) -> "_FontRegistry":
        candidate_specs: list[tuple[str, int]] = [
            ("/mnt/c/Windows/Fonts/ARIALUNI.TTF", 0),
            ("/mnt/c/Windows/Fonts/Nirmala.ttc", 0),
            ("/mnt/c/Windows/Fonts/segoeui.ttf", 0),
            ("/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf", 0),
            ("/usr/share/fonts/truetype/liberation/LiberationSans-Regular.ttf", 0),
        ]
        for directory in [
            "/usr/share/fonts/truetype/noto",
            "/usr/share/fonts/opentype/noto",
            "/usr/share/fonts/truetype/dejavu",
            "/usr/share/fonts/truetype/liberation",
        ]:
            candidate_specs.extend((str(path), 0) for path in sorted(Path(directory).glob("*.ttf")))
            candidate_specs.extend((str(path), 0) for path in sorted(Path(directory).glob("*.otf")))

        fonts: list[_UnicodeFont] = []
        seen: set[tuple[str, int]] = set()
        for path_value, font_number in candidate_specs:
            path = Path(path_value)
            key = (str(path), font_number)
            if key in seen or not path.exists():
                continue
            seen.add(key)
            try:
                fonts.append(_UnicodeFont(path, font_number=font_number, resource_name=f"F{len(fonts) + 1}"))
            except Exception as exc:
                logger.debug("font_load_skipped", "Font skipped during PDF export registry load", path=str(path), error=str(exc))
                continue
        return cls(fonts)

    def font_for_codepoint(self, codepoint: int) -> tuple[_UnicodeFont, int]:
        if codepoint <= 0xFFFF:
            for font in self.fonts:
                if font.supports(codepoint):
                    return font, codepoint
        for font in self.fonts:
            if font.supports(self.fallback_codepoint):
                return font, self.fallback_codepoint
        return self.fonts[0], ord("?")

    def encode_runs(self, value: str, size: float) -> list[tuple[_UnicodeFont, str, float]]:
        runs: list[tuple[_UnicodeFont, list[int]]] = []
        for character in value:
            font, codepoint = self.font_for_codepoint(ord(character))
            if runs and runs[-1][0] is font:
                runs[-1][1].append(codepoint)
            else:
                runs.append((font, [codepoint]))
        encoded_runs: list[tuple[_UnicodeFont, str, float]] = []
        for font, codepoints in runs:
            encoded = font.encode_codepoints(codepoints)
            width = sum(font.width_for_cid(codepoint) for codepoint in codepoints) * size / 1000
            encoded_runs.append((font, encoded, width))
        return encoded_runs

    @property
    def used_fonts(self) -> list[_UnicodeFont]:
        return [font for font in self.fonts if font.used_cids]


def _to_unicode_cmap(cids: list[int]) -> bytes:
    lines = [
        "/CIDInit /ProcSet findresource begin",
        "12 dict begin",
        "begincmap",
        "/CIDSystemInfo << /Registry (Adobe) /Ordering (UCS) /Supplement 0 >> def",
        "/CMapName /MagenticXToUnicode def",
        "/CMapType 2 def",
        "1 begincodespacerange",
        "<0000> <FFFF>",
        "endcodespacerange",
    ]
    for index in range(0, len(cids), 100):
        chunk = cids[index:index + 100]
        lines.append(f"{len(chunk)} beginbfchar")
        lines.extend(f"<{cid:04X}> <{cid:04X}>" for cid in chunk)
        lines.append("endbfchar")
    lines.extend(["endcmap", "CMapName currentdict /CMap defineresource pop", "end", "end"])
    return "\n".join(lines).encode("ascii")


def _cid_to_gid_map(font: _UnicodeFont, cids: list[int], glyph_ids: dict[str, int]) -> bytes:
    max_cid = max(cids, default=0)
    mapping = bytearray((max_cid + 1) * 2)
    for cid in cids:
        glyph_name = font.cmap.get(cid)
        gid = glyph_ids.get(glyph_name or "", 0)
        mapping[cid * 2:cid * 2 + 2] = gid.to_bytes(2, "big")
    return bytes(mapping)


def _width_array(font: _UnicodeFont, cids: list[int]) -> str:
    return " ".join(f"{cid} [{font.width_for_cid(cid)}]" for cid in cids)


def _stream_object(data: bytes, extra: bytes = b"") -> bytes:
    return b"<< /Length " + str(len(data)).encode("ascii") + extra + b" >>\nstream\n" + data + b"\nendstream"


def _build_pdf(
    page_streams: Iterable[list[str]],
    registry: _FontRegistry,
    images: list[_PngImage],
) -> bytes:
    pages = list(page_streams)
    used_fonts = registry.used_fonts
    font_resource_parts: list[bytes] = []
    objects: list[bytes] = [
        b"<< /Type /Catalog /Pages 2 0 R >>",
    ]

    pages_object_index = len(objects)
    objects.append(b"")

    for font in used_fonts:
        base_object_id = len(objects) + 1
        type0_id = base_object_id
        cid_id = base_object_id + 1
        descriptor_id = base_object_id + 2
        file_id = base_object_id + 3
        to_unicode_id = base_object_id + 4
        cid_gid_id = base_object_id + 5
        used_cids = sorted(font.used_cids | {0x20, 0x25A1})
        font_data, glyph_ids = font.subset_data_and_glyph_ids(used_cids)
        to_unicode = _to_unicode_cmap(used_cids)
        cid_gid_map = _cid_to_gid_map(font, used_cids, glyph_ids)
        font_name = font.font_name
        font_resource_parts.append(f"/{font.resource_name} {type0_id} 0 R".encode("ascii"))
        objects.extend([
            b"<< /Type /Font /Subtype /Type0 /BaseFont /"
            + font_name.encode("ascii")
            + f" /Encoding /Identity-H /DescendantFonts [{cid_id} 0 R] /ToUnicode {to_unicode_id} 0 R >>".encode("ascii"),
            b"<< /Type /Font /Subtype /CIDFontType2 /BaseFont /"
            + font_name.encode("ascii")
            + b" /CIDSystemInfo << /Registry (Adobe) /Ordering (Identity) /Supplement 0 >> /FontDescriptor "
            + f"{descriptor_id} 0 R".encode("ascii")
            + b" /DW 500 /W ["
            + _width_array(font, used_cids).encode("ascii")
            + b"] /CIDToGIDMap "
            + f"{cid_gid_id} 0 R".encode("ascii")
            + b" >>",
            b"<< /Type /FontDescriptor /FontName /"
            + font_name.encode("ascii")
            + b" /Flags 32 /FontBBox [-1000 -300 2000 1200] /ItalicAngle 0 /Ascent 950 /Descent -250 /CapHeight 700 /StemV 80 /FontFile2 "
            + f"{file_id} 0 R".encode("ascii")
            + b" >>",
            _stream_object(font_data),
            _stream_object(to_unicode),
            _stream_object(cid_gid_map),
        ])

    image_resource_parts: list[bytes] = []
    for image in images:
        image_id = len(objects) + 1
        smask_id: Optional[int] = None
        if image.alpha_stream is not None:
            smask_id = image_id + 1

        smask_ref = f" /SMask {smask_id} 0 R".encode("ascii") if smask_id is not None else b""
        image_dict = (
            b"<< /Type /XObject /Subtype /Image /Width "
            + str(image.width).encode("ascii")
            + b" /Height "
            + str(image.height).encode("ascii")
            + b" /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /FlateDecode"
            + smask_ref
            + b" /Length "
            + str(len(image.rgb_stream)).encode("ascii")
            + b" >>\nstream\n"
            + image.rgb_stream
            + b"\nendstream"
        )
        objects.append(image_dict)
        image_resource_parts.append(f"/{image.resource_name} {image_id} 0 R".encode("ascii"))

        if image.alpha_stream is not None:
            smask_dict = (
                b"<< /Type /XObject /Subtype /Image /Width "
                + str(image.width).encode("ascii")
                + b" /Height "
                + str(image.height).encode("ascii")
                + b" /ColorSpace /DeviceGray /BitsPerComponent 8 /Filter /FlateDecode /Length "
                + str(len(image.alpha_stream)).encode("ascii")
                + b" >>\nstream\n"
                + image.alpha_stream
                + b"\nendstream"
            )
            objects.append(smask_dict)

    page_start_id = len(objects) + 1
    objects[pages_object_index] = (
        b"<< /Type /Pages /Kids ["
        + b" ".join(f"{page_start_id + (index * 2)} 0 R".encode("ascii") for index in range(len(pages)))
        + f"] /Count {len(pages)} >>".encode("ascii")
    )
    font_resources = b"<< " + b" ".join(font_resource_parts) + b" >>"
    xobject_resources = (
        b" /XObject << " + b" ".join(image_resource_parts) + b" >>"
        if image_resource_parts
        else b""
    )

    for index, commands in enumerate(pages):
        page_obj = page_start_id + (index * 2)
        content_obj = page_obj + 1
        objects.append(
            b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font "
            + font_resources
            + xobject_resources
            + f" >> /Contents {content_obj} 0 R >>".encode("ascii")
        )
        stream = "\n".join(commands).encode("ascii")
        objects.append(_stream_object(stream))

    output = BytesIO()
    output.write(b"%PDF-1.4\n%\xe2\xe3\xcf\xd3\n")
    offsets = [0]
    for number, obj in enumerate(objects, start=1):
        offsets.append(output.tell())
        output.write(f"{number} 0 obj\n".encode("ascii"))
        output.write(obj)
        output.write(b"\nendobj\n")
    xref = output.tell()
    output.write(f"xref\n0 {len(objects) + 1}\n".encode("ascii"))
    output.write(b"0000000000 65535 f \n")
    for offset in offsets[1:]:
        output.write(f"{offset:010d} 00000 n \n".encode("ascii"))
    output.write(
        f"trailer\n<< /Size {len(objects) + 1} /Root 1 0 R >>\nstartxref\n{xref}\n%%EOF\n".encode("ascii")
    )
    return output.getvalue()
