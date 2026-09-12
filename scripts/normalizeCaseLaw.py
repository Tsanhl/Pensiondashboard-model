#!/usr/bin/env python3
import sys
import xml.etree.ElementTree as ET

if len(sys.argv) != 3:
    raise SystemExit("usage: normalizeCaseLaw.py INPUT.xml OUTPUT.txt")

tree = ET.parse(sys.argv[1])
root = tree.getroot()
ns = {
    "akn": "http://docs.oasis-open.org/legaldocml/ns/akn/3.0",
    "uk": "https://caselaw.nationalarchives.gov.uk/akn",
}

def clean(value):
    return " ".join(str(value or "").split())

work = root.find(".//akn:FRBRWork", ns)
name = clean((work.find("akn:FRBRname", ns) if work is not None else None).attrib.get("value", "") if work is not None and work.find("akn:FRBRname", ns) is not None else "")
date_node = work.find("akn:FRBRdate", ns) if work is not None else None
date = date_node.attrib.get("date", "") if date_node is not None else ""
cite = clean(root.findtext(".//uk:cite", default="", namespaces=ns))
court = clean(root.findtext(".//uk:court", default="", namespaces=ns))

lines = [f"CASE: {name}", f"NEUTRAL CITATION: {cite}", f"COURT: {court}", f"JUDGMENT DATE: {date}", ""]
body = root.find(".//akn:judgmentBody", ns)
if body is None:
    raise SystemExit("judgmentBody was not found")

for element in body.iter():
    tag = element.tag.rsplit("}", 1)[-1]
    if tag == "paragraph":
        number = clean("".join(element.find("akn:num", ns).itertext())) if element.find("akn:num", ns) is not None else ""
        content = element.find("akn:content", ns)
        text = clean(" ".join(content.itertext())) if content is not None else ""
        if text:
            lines.append(f"PARAGRAPH {number.rstrip('.')}\n{text}" if number else text)
    elif tag == "level":
        content = element.find("akn:content", ns)
        if content is not None:
            text = clean(" ".join(content.itertext()))
            if text:
                lines.append(f"HEADING: {text}")

with open(sys.argv[2], "w", encoding="utf-8") as stream:
    stream.write("\n\n".join(lines).strip() + "\n")
