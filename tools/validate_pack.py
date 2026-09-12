#!/usr/bin/env python3
"""Offline pack validation only. Does NOT run the model, DBs, browsers or training."""
from __future__ import annotations
import argparse
import hashlib
import json
import math
import re
import sys
from pathlib import Path
from typing import Any

def main() -> int:
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--root',type=Path,default=Path(__file__).resolve().parents[1])
    parser.add_argument('--report',type=Path,default=None)
    args=parser.parse_args();root=args.root.resolve()
    checks:list[dict[str,Any]]=[]
    def check(name:str,ok:bool,detail:Any=None)->None:
        checks.append({'check':name,'status':'PASS' if ok else 'FAIL','detail':detail})
    def read(rel:str)->Any:
        return json.loads((root/rel).read_text(encoding='utf-8'))
    def lines(rel:str)->list[dict[str,Any]]:
        return [json.loads(line) for line in (root/rel).read_text(encoding='utf-8').splitlines() if line.strip()]
    try:
        msgs=lines('evaluation/pdu50/product_messages.jsonl')
        setups=lines('evaluation/pdu50/harness_setup.jsonl')
        labels=lines('evaluation/pdu50/evaluator_manifest.jsonl')
        spec=read('fixtures/synthetic_portfolios.json');fixtures=spec['fixtures']
        catalogue=read('evaluation/pdu50/official_source_catalog.json');sources={x['source_id'] for x in catalogue['sources']}
        suite=read('evaluation/pdu50/suite_manifest.json')
        expected=[f'PDU50-{n:03d}' for n in range(1,51)]
        for name,rows in [('messages',msgs),('setup',setups),('labels',labels)]:
            check(name+'_ids_exactly_50',[x['case_id'] for x in rows]==expected)
        check('unique_primary_wording',len({re.sub(r'\W+',' ',m['user_turns'][0]['message']).strip().lower() for m in msgs})==50)
        check('exactly_60_user_turns',sum(len(m['user_turns']) for m in msgs)==60)
        check('exactly_10_followup_scenarios',sum(len(m['user_turns'])==2 for m in msgs)==10)
        check('product_envelopes_no_fixture_or_gold_fields',all(set(m)=={'case_id','user_turns'} and all(set(t)=={'turn','message'} and isinstance(t['message'],str) and t['message'] for t in m['user_turns']) for m in msgs))
        check('user_turn_order',all([t['turn'] for t in m['user_turns']]==list(range(1,len(m['user_turns'])+1)) for m in msgs))
        check('setup_case_fixture_exists',all(c['fixture_id'] in fixtures for c in setups))
        check('all_synthetic_fixture_labels',all(f['data_kind']=='SYNTHETIC_DEVELOPMENT_ONLY_NOT_OWNER_DATA' for f in fixtures.values()))
        check('no_legal_label_claims_approved',all(c['label_status'].startswith('DRAFT_') for c in labels))
        check('public_source_ids_resolve',all(set(c['public_source_requirements'])<=sources for c in labels))
        check('38_mixed_legal_scenarios',sum(c['requires_public_legal_evidence'] for c in labels)==38)
        check('5_balanced_groups',all(sum(c['group']==g for c in labels)==10 for g in {c['group'] for c in labels}))
        check('private_document_ids_resolve',all(set(c['private_document_requirements'])<={d['document_id'] for d in fixtures[c['fixture_id']]['documents']} for c in labels))
        check('documents_owned_by_fixture_user',all(d['owner_id']==f['user_id'] for f in fixtures.values() for d in f['documents']))
        check('synthetic_docs_not_public_law',all(d['public_legal_authority'] is False for f in fixtures.values() for d in f['documents']))
        check('unique_document_ids_per_fixture',all(len({d['document_id'] for d in f['documents']})==len(f['documents']) for f in fixtures.values()))
        check('source_catalog_not_admitted',all(x['corpus_admitted'] is False and not x['review_receipts'] for x in catalogue['sources']))
        check('all_cases_have_acceptance_requirements',all(len(c['acceptance_points'])>=1 for c in labels))
        check('followups_have_assertions',all(bool(c['followup_acceptance_points'])==(len(msgs[i]['user_turns'])==2) for i,c in enumerate(labels)))
        check('mutation_refs_exist',all(c['before_turn_2_mutation_ref'] is None or c['before_turn_2_mutation_ref'] in spec['authorised_harness_mutations'] for c in setups))
        check('user_switch_is_harness_not_text_authority',bool(setups[45]['harness_only_setup']) and fixtures['F_OTHER_USER']['user_id']!=fixtures['F_MAIN']['user_id'])
        def dangling(obj:Any,valid:set[str])->list[str]:
            bad=[]
            if isinstance(obj,dict):
                if 'source_ref' in obj and obj['source_ref'] not in valid:bad.append(str(obj['source_ref']))
                for v in obj.values():bad.extend(dangling(v,valid))
            elif isinstance(obj,list):
                for v in obj:bad.extend(dangling(v,valid))
            return bad
        missing={fid:sorted(set(dangling(f,{d['document_id'] for d in f['documents']}))) for fid,f in fixtures.items()}
        missing={k:v for k,v in missing.items() if v}
        check('all_declared_private_source_refs_resolve',not missing,missing)
        base=fixtures['F_MAIN'];dc=[a for a in base['accounts'] if a['scheme_type']!='DEFINED_BENEFIT']
        check('dc_total_100000_not_db_income',sum(a['balance']['value'] for a in dc)==100000)
        check('gross_monthly_credits_580',base['accounts'][0]['employee_gross_monthly']['value']+base['accounts'][0]['employer_gross_monthly']['value']+base['accounts'][2]['total_gross_monthly']['value']==580)
        charge=sum(a['balance']['value']*a['annual_charge_percent']['value']/100 for a in dc)
        check('charge_illustration_580',abs(charge-580)<1e-9)
        check('zero_distinct_from_null',base['accounts'][1]['employer_gross_monthly']['value']==0 and base['accounts'][2]['employer_gross_monthly']['value'] is None)
        check('unconfirmed_locator_not_fabricated',next(d for d in base['documents'] if d['document_id']=='cedar-unconfirmed')['spans'][0]['locator'] is None)
        docs={d['document_id']:d for d in base['documents']}
        check('duplicate_is_actual_copy',docs['cedar-statement']['spans'][0]['text']==docs['cedar-duplicate']['spans'][0]['text'])
        numeric=read('evaluation/pdu50/numeric_reference.json');p=base['projection']
        def forecast(age:int,extra:float)->tuple[float,float,float]:
            n=(age-p['current_age'])*12
            factor=(1+p['annual_nominal_growth'])*(1-p['annual_fee_rate'])/(1+p['annual_inflation'])
            r=factor**(1/12)-1;c=p['total_gross_monthly_credit_gbp']+extra
            pot=p['current_dc_pot_gbp']*(1+r)**n+c*(1+r)*math.expm1(n*math.log1p(r))/r
            db=p['db_annual_income_today_money_gbp']/12 if age>=p['db_income_start_age'] else 0
            state=p['state_monthly_income_today_money_gbp'] if age>=p['state_income_start_age'] else 0
            income=pot*p['annual_drawdown_rate']/12+db+state
            return pot,income,p['target_monthly_income_today_money_gbp']-income
        for row in numeric['main_scenarios']+[numeric['retire60']]:
            val=forecast(row['retirement_age'],row['extra_gross_monthly'])
            check(f"independent_annuity_reference_age{row['retirement_age']}_extra{row['extra_gross_monthly']}",all(abs(a-b)<1e-5 for a,b in zip(val,[row['dc_pot_unrounded'],row['monthly_income_unrounded'],row['gap_unrounded']])))
        check('later_benefits_not_included_at_60',numeric['retire60']['db_monthly_included']==0 and numeric['retire60']['state_monthly_included']==0)
        check('state_not_included_at67_when_start68',all(x['state_monthly_included']==0 for x in numeric['main_scenarios']))
        check('extra_credit_increases_declared_forecast',all(numeric['main_scenarios'][i]['monthly_income_unrounded']<numeric['main_scenarios'][i+1]['monthly_income_unrounded'] for i in range(3)))
        check('suite_not_sealed_or_gradient_training',suite['default_gradient_training_allowed'] is False and suite['default_checkpoint_selection_allowed'] is False and suite['legacy_live50_replacement'] is False)
        contract=(root/'Pension_Dashboard_Full_Execution_Contract_v3.txt').read_text()
        check('original_00_25_and_new_26_29_sections_present',all(re.search(r'^'+f'{n:02d}'+r'\. ',contract,re.M) for n in range(30)))
        check('appendices_A_F_present',all('APPENDIX '+c+' —' in contract for c in 'ABCDEF'))
        check('fixed48_execution_instruction_removed','execute the reviewed 48 actual optimiser updates' not in contract)
        check('all_50_questions_in_full_prompt',all(c['user_turns'][0]['message'] in contract for c in msgs))
        integrity=root/'MANIFEST_SHA256.json'
        if integrity.exists():
            manifest=json.loads(integrity.read_text())
            mismatches=[]
            for rel,expected_hash in manifest['files'].items():
                path=root/rel
                if not path.is_file() or hashlib.sha256(path.read_bytes()).hexdigest()!=expected_hash:mismatches.append(rel)
            check('pack_file_hashes',not mismatches,mismatches)
        else:check('pack_file_hashes',False,'MANIFEST_SHA256.json missing')
    except (OSError,ValueError,KeyError,TypeError,IndexError) as exc:
        check('pack_read_or_schema_exception',False,f'{type(exc).__name__}: {exc}')
    report={'scope':'OFFLINE_PACK_STRUCTURE_AND_SYNTHETIC_ARITHMETIC_ONLY','status':'PASS' if all(x['status']=='PASS' for x in checks) else 'FAIL',
            'passed_checks':sum(x['status']=='PASS' for x in checks),'failed_checks':sum(x['status']=='FAIL' for x in checks),
            'live_database_test':'NOT_RUN','model_generation':'NOT_RUN','training':'NOT_RUN','legal_source_or_label_review':'PENDING',
            'browser_evaluation':'NOT_RUN','runtime_reviewers':'NOT_RUN','unseen_access':'NOT_ACCESSED','checks':checks}
    if args.report:
        args.report.parent.mkdir(parents=True,exist_ok=True)
        args.report.write_text(json.dumps(report,ensure_ascii=False,indent=2)+'\n')
    print(json.dumps({k:v for k,v in report.items() if k!='checks'},ensure_ascii=False,indent=2))
    for x in checks:
        if x['status']=='FAIL':print('FAIL:',x['check'],x['detail'])
    return 0 if report['status']=='PASS' else 1
if __name__=='__main__':raise SystemExit(main())
