function tokenEstimate(text = "") {
  return Math.max(1, Math.ceil(String(text).trim().split(/\s+/).filter(Boolean).length * 1.3));
}

function splitLongSection(text, targetTokens = 760, overlapTokens = 100) {
  const words = String(text).trim().split(/\s+/).filter(Boolean);
  const targetWords = Math.max(80, Math.floor(targetTokens / 1.3));
  const overlapWords = Math.max(10, Math.floor(overlapTokens / 1.3));
  if (tokenEstimate(text) <= 900) return [text.trim()];
  const chunks = [];
  let start = 0;
  while (start < words.length) {
    let end = Math.min(words.length, start + targetWords);
    const window = words.slice(start, end).join(" ");
    chunks.push(window);
    if (end === words.length) break;
    start = Math.max(start + 1, end - overlapWords);
  }
  return chunks;
}

function headingLevel(line = "") {
  const markdown = line.match(/^(#{1,6})\s+(.+)/);
  if (markdown) return { level: markdown[1].length, title: markdown[2].trim() };
  const legal = line.match(/^(part|chapter|section|schedule|article|regulation|clause)\s+([\w.-]+.*)$/i);
  if (legal) return { level: /part|chapter|schedule/i.test(legal[1]) ? 1 : 2, title: line.trim() };
  if (/^[A-Z][A-Z0-9 ,:&'()/-]{4,100}$/.test(line.trim())) return { level: 2, title: line.trim() };
  return null;
}

export function structuralChunk(text, { documentType = "policy" } = {}) {
  const normalized = String(text || "").replace(/\r/g, "").replace(/[ \t]+\n/g, "\n").trim();
  if (!normalized) return [];
  if (documentType === "faq") {
    return normalized.split(/\n(?=(?:Q(?:uestion)?[:.]|\d+[.)]\s))/i).map((content, ordinal) => ({
      ordinal,
      sectionPath: `FAQ ${ordinal + 1}`,
      content: content.trim(),
      tokenCount: tokenEstimate(content)
    })).filter((item) => item.content);
  }
  const sections = [];
  const path = [];
  let current = { path: "Document", lines: [] };
  const flush = () => {
    const content = current.lines.join("\n").trim();
    if (content) sections.push({ path: current.path, content });
  };
  for (const rawLine of normalized.split("\n")) {
    const line = rawLine.trim();
    const heading = headingLevel(line);
    if (heading) {
      flush();
      path.splice(heading.level - 1);
      path[heading.level - 1] = heading.title;
      current = { path: path.filter(Boolean).join(" > "), lines: [line] };
    } else {
      current.lines.push(rawLine);
    }
  }
  flush();
  return sections.flatMap((section) => splitLongSection(section.content).map((content) => ({
    sectionPath: section.path,
    content,
    tokenCount: tokenEstimate(content)
  }))).map((chunk, ordinal) => ({ ...chunk, ordinal }));
}
