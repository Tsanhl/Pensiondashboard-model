// Confidence in extraction is distinct from a human confirmation or a locator.
export function describeDocumentEvidence(item) {
  const extracted = item.extracted || {};
  const metadataKeys = new Set(['fieldConfidence','reviewFields','confidence','documentCategory','fieldEvidence']);
  const pending = extracted.reviewFields || item.reviewFields || [];
  const pendingNames = new Set(pending.map(x=>typeof x==='string'?x:x.field));
  const evidence = item.fieldEvidence || extracted.fieldEvidence || {};
  const fields = Object.entries(extracted).filter(([key,value])=>!metadataKeys.has(key) && value != null && value !== '');
  const details = fields.map(([key,value])=>{
    const record = evidence[key] || {};
    const status = record.status === 'conflict' ? 'conflict' : record.confirmedAt || item.confirmedAt ? 'confirmed' : 'unconfirmed';
    const locator = record.locator ? `; source locator ${record.locator}` : '; source locator not recorded';
    return `${key}: ${typeof value==='object'?JSON.stringify(value):value} (${status}${pendingNames.has(key)?'; pending review':''}${locator})`;
  });
  const missing = [...pendingNames].filter(key=>extracted[key] == null || extracted[key] === '');
  const labels = [];
  if (details.length) labels.push(`Stored extracted values: ${details.join('; ')}`);
  else labels.push('No extracted field values are recorded');
  if (missing.length) labels.push(`Missing fields requiring review: ${missing.join(', ')}`);
  if (!pending.length && !Object.keys(evidence).length) labels.push('Field-level pending items and page/section locators are not recorded in this dashboard status record');
  if (item.confirmedAt) labels.push(`Document confirmation recorded at ${item.confirmedAt}`);
  return labels.join('. ');
}
