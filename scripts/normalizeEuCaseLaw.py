#!/usr/bin/env python3
import sys
import xml.etree.ElementTree as ET
from html.parser import HTMLParser

if len(sys.argv) != 3:
    raise SystemExit("usage: normalizeEuCaseLaw.py INPUT.xhtml OUTPUT.txt")

lines = []
seen = set()

try:
    root = ET.parse(sys.argv[1]).getroot()
    for element in root.iter():
        tag = element.tag.rsplit("}", 1)[-1].lower()
        if tag not in {"h1", "h2", "h3", "h4", "h5", "h6", "p", "li", "caption"}:
            continue
        text = " ".join(" ".join(element.itertext()).split())
        if not text or text in seen:
            continue
        seen.add(text)
        prefix = "HEADING: " if tag.startswith("h") or tag == "caption" else ""
        lines.append(prefix + text)
except ET.ParseError:
    class Collector(HTMLParser):
        capture_tags = {"h1", "h2", "h3", "h4", "h5", "h6", "p", "li", "caption"}
        def __init__(self):
            super().__init__(convert_charrefs=True)
            self.stack = []
            self.buffer = []
        def handle_starttag(self, tag, attrs):
            if tag in self.capture_tags and not self.stack:
                self.stack.append(tag)
                self.buffer = []
            elif self.stack:
                self.stack.append(tag)
        def handle_endtag(self, tag):
            if not self.stack:
                return
            if tag == self.stack[-1]:
                self.stack.pop()
            elif tag in self.stack:
                while self.stack and self.stack[-1] != tag:
                    self.stack.pop()
                if self.stack:
                    self.stack.pop()
            if not self.stack and self.buffer:
                text = " ".join(" ".join(self.buffer).split())
                if text and text not in seen:
                    seen.add(text)
                    lines.append(text)
                self.buffer = []
        def handle_data(self, data):
            if self.stack:
                self.buffer.append(data)
    parser = Collector()
    with open(sys.argv[1], encoding="utf-8", errors="replace") as stream:
        parser.feed(stream.read())

if not lines:
    raise SystemExit("No readable judgment text was found")
with open(sys.argv[2], "w", encoding="utf-8") as stream:
    stream.write("\n\n".join(lines) + "\n")
