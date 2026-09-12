#!/usr/bin/env python3
import re
import sys
from html.parser import HTMLParser

if len(sys.argv) != 3:
    raise SystemExit("usage: normalizeBailii.py INPUT.html OUTPUT.txt")

class TextCollector(HTMLParser):
    block_tags = {
        "address", "article", "blockquote", "br", "caption", "dd", "div", "dl", "dt",
        "h1", "h2", "h3", "h4", "h5", "h6", "hr", "li", "p", "pre", "section",
        "table", "td", "th", "tr"
    }
    ignored_tags = {"script", "style", "noscript", "svg"}

    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.parts = []
        self.ignored_depth = 0

    def handle_starttag(self, tag, attrs):
        if tag in self.ignored_tags:
            self.ignored_depth += 1
        elif not self.ignored_depth and tag in self.block_tags:
            self.parts.append("\n")

    def handle_endtag(self, tag):
        if tag in self.ignored_tags and self.ignored_depth:
            self.ignored_depth -= 1
        elif not self.ignored_depth and tag in self.block_tags:
            self.parts.append("\n")

    def handle_data(self, data):
        if not self.ignored_depth:
            self.parts.append(data)

collector = TextCollector()
with open(sys.argv[1], encoding="utf-8", errors="replace") as stream:
    collector.feed(stream.read())

lines = []
for raw_line in "".join(collector.parts).splitlines():
    line = re.sub(r"\s+", " ", raw_line).strip()
    if not line or (lines and lines[-1] == line):
        continue
    lines.append(line)

# BAILII's legacy pages wrap the judgment in a small navigation shell. Keep the
# title, citation and judgment, while dropping navigation before the citation
# and the repeated site footer after the final URL marker.
cite_index = next((index for index, line in enumerate(lines) if line == "Cite as:"), None)
if cite_index is not None and cite_index > 1:
    lines = [lines[0]] + lines[cite_index:]
url_indices = [index for index, line in enumerate(lines) if line.startswith("URL: https://www.bailii.org/")]
if len(url_indices) > 1:
    lines = lines[:url_indices[-1]]

text = "\n\n".join(lines)
if len(text) < 1000:
    raise SystemExit("No readable judgment text was found")
with open(sys.argv[2], "w", encoding="utf-8") as stream:
    stream.write(text + "\n")
