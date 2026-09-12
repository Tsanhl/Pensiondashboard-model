import re
import sys
import xml.etree.ElementTree as ET
from pathlib import Path

if len(sys.argv) != 3:
    raise SystemExit("usage: normalizeLegislation.py INPUT.xml OUTPUT.txt")

source = Path(sys.argv[1])
target = Path(sys.argv[2])
root = ET.parse(source).getroot()
parents = {child: parent for parent in root.iter() for child in parent}
lines = []

def local(element):
    return element.tag.rsplit("}", 1)[-1]

def clean(value):
    return re.sub(r"\s+", " ", value or "").strip()

def direct_text(element, tag_name):
    for child in element:
        if local(child) == tag_name:
            return clean("".join(child.itertext()))
    return ""

def append_line(value, blank_before=False):
    value = clean(value)
    if not value or (lines and lines[-1] == value):
        return
    if blank_before and lines and lines[-1] != "":
        lines.append("")
    lines.append(value)

def provision_kind(uri):
    if "/regulation/" in uri:
        return "Regulation"
    if "/article/" in uri:
        return "Article"
    if "/rule/" in uri:
        return "Rule"
    if "/schedule/" in uri and "/paragraph/" in uri:
        return "Paragraph"
    return "Section"

def ancestor_number_prefix(element):
    numbers = []
    current = parents.get(element)
    while current is not None and local(current) != "P1":
        if local(current) in {"P2", "P3", "P4", "P5", "P6", "P7"}:
            number = direct_text(current, "Pnumber")
            if number:
                numbers.append(number)
        current = parents.get(current)
    return "".join(f"({number})" for number in reversed(numbers))

def enclosing_p1(element):
    current = parents.get(element)
    while current is not None:
        if local(current) == "P1":
            return current
        current = parents.get(current)
    return None

for element in root.iter():
    tag = local(element)
    if tag in {"Part", "Chapter"}:
        number = direct_text(element, "Number")
        title = direct_text(element, "Title")
        if number or title:
            append_line(f"# {' — '.join(value for value in (number, title) if value)}", blank_before=True)
        continue
    if tag == "Schedule":
        number = direct_text(element, "Number")
        title = direct_text(element, "Title")
        if number or title:
            append_line(f"# {' — '.join(value for value in (number or 'Schedule', title) if value)}", blank_before=True)
        continue
    if tag == "P1":
        number = direct_text(element, "Pnumber")
        if not number:
            continue
        uri = element.attrib.get("DocumentURI", "") or element.attrib.get("IdURI", "")
        parent = parents.get(element)
        title = direct_text(parent, "Title") if parent is not None and local(parent) == "P1group" else ""
        label = f"{provision_kind(uri)} {number}"
        outer = enclosing_p1(element)
        if outer is not None:
            outer_number = direct_text(outer, "Pnumber")
            # Consolidated amending Acts often embed the text inserted into a
            # different Act as a nested P1. Do not index that quotation as if
            # it were a second free-standing provision of the amending Act.
            append_line(f"### Inserted {label}{f' — {title}' if title else ''} (text inserted by {provision_kind(outer.attrib.get('DocumentURI', '') or outer.attrib.get('IdURI', ''))} {outer_number})", blank_before=True)
        else:
            append_line(f"## {label}{f' — {title}' if title else ''}", blank_before=True)
        continue
    if tag not in {"Text", "BlockText"}:
        continue
    value = clean("".join(element.itertext()))
    if not value:
        continue
    prefix = ancestor_number_prefix(element)
    append_line(f"{prefix} {value}" if prefix else value)

target.parent.mkdir(parents=True, exist_ok=True)
target.write_text("\n".join(lines).strip() + "\n", encoding="utf-8")
