import {createHash} from 'node:crypto';

export function recordProvenance(record = {}) {
  const verification = record.verification || {};
  // A display label such as "Provider-linked" is not a verification receipt.
  const status = record.recordStatus === 'VERIFIED_RECORD' ? 'verified_record'
    : record.recordStatus === 'EXTRACTED_UNCONFIRMED' ? 'extracted_unconfirmed'
    : verification.status === 'provider_verified' && verification.receiptId && verification.verifiedAt
    ? 'provider_verified' : record.confirmedAt ? 'user_confirmed'
      : /manual|user.entered/i.test(record.source || '') ? 'user_entered'
        : /extract|upload/i.test(record.source || '') ? 'extracted' : 'unknown';
  return {status,source:record.source || null,updatedAt:record.lastUpdated || record.date || null,
    confirmedAt:record.confirmedAt || null,verificationReceipt:status === 'provider_verified' ? verification.receiptId : null};
}

const same = (a,b) => String(a || '').replace(/\s/g,'').toLowerCase() === String(b || '').replace(/\s/g,'').toLowerCase();
export function resolvePortfolioAccounts(dashboard = {}, entities = {}, question = '') {
  let accounts = dashboard.pensionAccounts || [];
  if (entities.accountId) accounts = accounts.filter(a=>same(a.id,entities.accountId));
  else if (entities.policyNumber) accounts = accounts.filter(a=>same(a.policy,entities.policyNumber));
  else if (entities.provider) accounts = accounts.filter(a=>same(a.provider,entities.provider));
  else if (/\bworkplace\b|\bmy employer\b|\bcompany\b/i.test(question)) accounts = accounts.filter(a=>/workplace|occupational|master trust|group personal/i.test(`${a.type} ${a.schemeType}`));
  return {accounts,accountIds:accounts.map(a=>a.id),selectedAccountId:accounts.length === 1 ? accounts[0].id : null,
    ambiguous:accounts.length > 1,missing:accounts.length === 0};
}

export function snapshotIdentity(state) {
  return createHash('sha256').update(JSON.stringify(state)).digest('hex');
}

export function schemeFactGaps(query, selection) {
  const text = query.self_contained_query || '';
  const account = selection.accounts.length === 1 ? selection.accounts[0] : null;
  const missing = [];
  if (!/occupational|defined.contribution|defined.benefit|\bDB\b|\bDC\b|group personal|master trust/i.test(text) && !account?.schemeType) missing.push('scheme_type');
  if (selection.ambiguous) missing.push('account_selection');
  if (!/reduc|lower|future|accru|existing rights|past rights|provider|\d\s*%/i.test(text)) missing.push('proposed_change');
  if (!query.jurisdiction_scope || query.jurisdiction_scope === 'UNSPECIFIED') missing.push('applicable_jurisdiction');
  return missing;
}
