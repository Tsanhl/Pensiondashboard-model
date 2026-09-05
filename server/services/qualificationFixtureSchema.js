// This is the audited projection for the 69 visible Cycle-v1 fixtures. The
// qualification server accepts the exact listed scenario fields for each case
// and rejects every unrecognised or omitted field. It deliberately contains no
// gold answers, expected routes, required checks, scores, or verdicts.
const CASE_VALUE_KEYS = Object.fromEntries([
  ["gold-001","displayed_value_gbp_per_year|displayed_value_type|pension_type|provider|value_date|withdrawable_pot"],
  ["gold-002","confirmation_status|dashboard_value_date|dashboard_value_gbp|dashboard_value_type|pension_type|provider|statement_date|statement_period|statement_value_gbp|statement_value_type"],
  ["gold-003","calculation_date|charges_assumption|contribution_assumption|growth_assumption|guaranteed|inflation_assumption|nominal_or_real_basis|projection_monthly_income_gbp|retirement_age"],
  ["gold-004","displayed_employer_name|user_disputes_name"],
  ["gold-005","charge_effective_date_for_each_pension|charge_field_name|charge_unit|charge_value_for_each_pension|comparison_basis|conversation_order"],
  ["gold-006","conversation_order|pension_type|policy_number|resolved_provider|safeguarded_benefits|scheme_status|transfer_availability|transfer_restrictions"],
  ["gold-007","current_cetv_status|dashboard_value_date|dashboard_value_type|provider|statement_of_entitlement_status"],
  ["gold-008",""],
  ["gold-009","age|assessment_date|earnings|work_location|worker_status"],
  ["gold-010","current_age_and_earnings|employer_re_enrolment_date|opt_out_date|work_location"],
  ["gold-011","age_and_earnings|jurisdiction|work_location"],
  ["gold-012","automatic_enrolment_status|change_notice|contract|proposed_change|scheme_rules|work_location"],
  ["gold-013","tax_year_2026_27"],
  ["gold-014","flexible_access_event_date|flexible_access_event_type|tax_year_2026_27"],
  ["gold-015","tax_year_2026_27"],
  ["gold-016a","individual_protection_status|tax_year_2026_27"],
  ["gold-016b","individual_protection_status|tax_year_2026_27"],
  ["gold-017","destination_country|destination_scheme|employment_location|proposed_transfer_date|uk_residence_history"],
  ["gold-018","excluded_service|qualifying_service|refund_taken|scheme_rules|transfer_taken|work_location"],
  ["gold-019","excluded_service|qualifying_service|refund_taken|scheme_rules|transfer_taken|work_location"],
  ["gold-020","benefit_type|pension_in_payment|scheme_increase_rule|service_periods"],
  ["gold-021","current_age|member_status|normal_pension_age|pension_type|scheme_rule_transfer_option|transfer_request_date"],
  ["gold-022","live_flag_decision"],
  ["gold-023","live_flag_decision"],
  ["gold-024","actuarial_reduction_calculation|pension_type|scheme_funding_evidence|transfer_quote"],
  ["gold-025","complaint_date|idrp_stage|scam_indicator|scheme_or_provider_formal_complaint_status"],
  ["gold-026","affected_service_periods|amendment_power|announcement_form|effective_date|executed_amendment|scheme_rules"],
  ["gold-027","amendment_power|current_index|current_index_wording|proposed_index|service_periods"],
  ["gold-028","consultation_notice|employer_size|proposed_change|proposed_effective_date|scheme_type"],
  ["gold-029","assurance_documents|assurances|decision_process|member_reliance_facts|proposed_change"],
  ["gold-030","decision|decision_letter|idrp_status|medical_evidence|scheme_rules"],
  ["gold-031","conflicts|proposed_trustee_decision|scheme_rules"],
  ["gold-032","investment_advice|member_preference_evidence|proposed_factor|scheme_sip"],
  ["gold-033","regulated_advice_available|requested_action|risk_profile"],
  ["gold-034","employer_event|member_status|ppf_assessment_date|ppf_entry_status|service_periods|transitional_treatment"],
  ["gold-035","member_status|payment_status|ppf_assessment_date|ppf_responsibility_status|transitional_treatment"],
  ["gold-036","first_eligible_payment_date|original_scheme_mandatory_pre_97_increase_rule|ppf_or_fas_status|service_periods|transitional_treatment"],
  ["gold-037","member_status|ppf_assessment_date|relevant_brexit_or_transition_date|service_periods"],
  ["gold-038","idrp_stage|scheme_or_provider_formal_complaint_status"],
  ["gold-039","court_deadline|final_determination_date|proposed_ground_of_appeal"],
  ["gold-040","complaint_record|loss_evidence|other_determination|other_determination_date|other_determination_outcome|user_chronology"],
  ["gold-041","benefit_category|decision_or_payment_status|marriage_or_civil_partnership_status|scheme_wording|service_dates"],
  ["gold-042","gmp_service_period|individual_adjustment|past_transfer_status|scheme_method"],
  ["gold-043","court_order_status|jurisdiction|requested_outcome|scheme_valuation"],
  ["gold-044","court_order_status|jurisdiction|requested_outcome|scheme_valuation"],
  ["gold-045a","accrued_benefit_status|new_terms|old_employer_contribution_terms|old_scheme_type|transfer_date|transfer_type|work_location"],
  ["gold-045b","accrued_benefit_status|new_terms|old_employer_contribution_terms|old_scheme_type|transfer_date|transfer_type|work_location"],
  ["gold-046","departure_event|employer_structure|proposed_arrangement|scheme_funding_position|scheme_type|valuation_date"],
  ["gold-047","funding_and_investment_strategy_status|funding_level|scheme_type|trustee_statement_status"],
  ["gold-048","document_trust_level_untrusted|known_provider_and_scheme_identifiers_if_any|quarantined_chunk|uploaded_transfer_offer_fixture"],
  ["gold-049","document_dates|document_execution_status|executed_rules|member_booklet|member_reliance_facts|subsequent_amendments"],
  ["gold-050a","dashboard_data_dates|pension_type_db|personal_circumstances|provider_x_identity|safeguarded_benefits_status|transfer_value_status"],
  ["gold-050b","provider_x_identity"],
  ["gold-051","identity_match_fields_supplied|scheme_connection_status_if_known|search_timestamp|user_jurisdiction"],
  ["gold-052","benefit_sections|data_provenance|duplicate_status|record_a_verified_identifiers|record_b_verified_identifiers|value_dates"],
  ["gold-053","possible_false_match_flag|redacted_record_metadata|user_jurisdiction"],
  ["gold-054","causation|historical_identity_fields_if_supplied|user_jurisdiction|verified_current_identity_fields"],
  ["gold-055","calculation_date|connection_status|data_type|source_update_date|statement_provided_date|value_date"],
  ["gold-056","benefit_type|contextual_information|current_value_type|expected_update_timing_if_any|projection_availability_code"],
  ["gold-057","calculation_date|charges_assumption|contribution_assumption|growth_assumption|inflation_assumption|nominal_or_real_basis|retirement_age"],
  ["gold-058","dashboard_update_date|deduction_date|normal_reporting_lag|payslip_period|scheme_receipt_status|user_jurisdiction"],
  ["gold-059","consent_status|data_controller_roles|user_jurisdiction|verified_access_control_policy"],
  ["gold-060","coverage_or_assumption_metadata|dashboard_calculation_date|dashboard_state_pension_status|govuk_forecast_date|snapshot_classification|source_provenance|statutory_dashboard_feed_persisted"],
  ["gold-061","dashboard_value_date|dashboard_value_type|formal_divorce_valuation_status|jurisdiction_England_and_Wales"],
  ["gold-062","dashboard_age_source_date|date_of_birth|planned_access_date|protected_pension_age_status|scheme_rules"],
  ["gold-063","fee_description|promised_access_age|promoter_authorisation_status_if_verified|transfer_deadline|user_jurisdiction"],
  ["gold-064","benefit_type|current_nominee_status|decision_maker|expression_of_wish_date|scheme_rules"],
  ["gold-065","claimed_amount_gbp|claimed_overpayment_period|complaint_status|dashboard_value_type|member_reliance_facts|notice_dates|payment_history|scheme_calculation"],
  ["gold-066","quotation_document|verified_expiry_date"],
].map(([caseId,keys]) => [caseId,Object.freeze(keys ? keys.split("|") : [])]));

// Types are pinned independently of the fixture files so changing a string to
// an object (or another structurally meaningful type) cannot silently expand
// the qualification prompt surface.
const CASE_VALUE_TYPES = Object.fromEntries([
  ["gold-001","number|string|string|string|string|boolean"],["gold-002","string|string|number|string|string|string|string|string|number|string"],
  ["gold-003","string|string|string|string|boolean|string|string|number|number"],["gold-004","string|boolean"],
  ["gold-005","object|string|string|object|string|array"],["gold-006","array|string|null|string|string|string|string|string"],
  ["gold-007","string|string|string|string|string"],["gold-008",""],["gold-009","string|string|string|string|string"],
  ["gold-010","string|string|string|string"],["gold-011","string|string|string"],["gold-012","string|string|string|string|string|string"],
  ["gold-013","string"],["gold-014","string|string|string"],["gold-015","string"],["gold-016a","string|string"],["gold-016b","string|string"],
  ["gold-017","string|string|string|string|string"],["gold-018","string|string|string|string|string|string"],["gold-019","string|string|string|string|string|string"],
  ["gold-020","string|boolean|string|string"],["gold-021","string|string|number|string|string|string"],["gold-022","string"],["gold-023","string"],
  ["gold-024","string|string|string|string"],["gold-025","null|string|boolean|string"],["gold-026","string|string|string|string|string|string"],
  ["gold-027","string|string|string|string|string"],["gold-028","string|string|string|string|string"],["gold-029","string|string|string|string|string"],
  ["gold-030","string|string|string|string|string"],["gold-031","string|string|string"],["gold-032","string|string|string|string"],
  ["gold-033","boolean|string|string"],["gold-034","string|string|null|string|string|string"],["gold-035","string|string|string|string|string"],
  ["gold-036","string|string|string|string|string"],["gold-037","string|string|string|string"],["gold-038","string|string"],
  ["gold-039","string|string|string"],["gold-040","string|string|string|string|string|string"],["gold-041","string|string|string|string|string"],
  ["gold-042","string|string|string|string"],["gold-043","string|string|string|string"],["gold-044","string|string|string|string"],
  ["gold-045a","string|string|string|string|string|string|string"],["gold-045b","string|string|string|string|string|string|string"],
  ["gold-046","string|string|string|string|string|string"],["gold-047","string|string|string|string"],["gold-048","boolean|string|boolean|string"],
  ["gold-049","array|string|object|object|string|string"],["gold-050a","array|boolean|string|string|string|string"],["gold-050b","string"],
  ["gold-051","string|string|string|string"],["gold-052","array|array|string|object|object|array"],["gold-053","boolean|object|string"],
  ["gold-054","string|object|string|object"],["gold-055","string|string|string|string|string|string"],["gold-056","string|string|string|string|string"],
  ["gold-057","string|string|string|string|string|string|number"],["gold-058","string|string|string|string|string|string"],
  ["gold-059","string|string|string|string"],["gold-060","string|string|string|string|string|object|boolean"],
  ["gold-061","string|string|string|boolean"],["gold-062","string|string|string|string|string"],["gold-063","string|number|string|string|string"],
  ["gold-064","string|string|string|string|string"],["gold-065","number|string|string|string|string|array|string|string"],["gold-066","string|string"],
].map(([caseId,types]) => [caseId,Object.freeze(types ? types.split("|") : [])]));

export const EXCLUDED_NON_SCENARIO_VALUE_KEYS = Object.freeze({
  assistant_transaction_capability:"assistant execution control",
  authorisation_status:"assistant execution control",
  configured_official_scam_handoff:"expected product response",
  consultation_material_separately_labelled_non_binding:"legal-evidence treatment",
  current_2021_regulations_snapshot:"corpus identity",
  current_ni_2021_regulations_snapshot:"corpus identity",
  domestic_case_treatment:"legal conclusion",
  embedded_text:"quarantined prompt-injection content",
  hmrc_source_snapshot_id:"corpus identity",
  law_as_at_2026_08_26:"legal-evidence date supplied independently by pinned corpus",
  law_commencement_status:"legal conclusion",
  payment_release_capability:"assistant execution control",
  pension_schemes_act_2026_commencement_status:"legal conclusion",
  privacy_support_path:"expected product response",
  projection_basis:"product implementation identity",
  provider_contact_capability:"assistant execution control",
  provider_contact_route:"expected product response",
  record_mutation_capability:"assistant execution control",
  refresh_capability:"assistant execution control",
  regulation_26_compliance_assessment:"legal conclusion",
  secure_privacy_review_path:"expected product response",
  secure_update_path:"expected product response",
  service_provision_change_status:"legal conclusion",
  session_contains_no_execution_authority:"assistant execution control",
  support_route:"expected product response",
  tpo_intake_procedure_snapshot_as_at_2026_08_26:"corpus identity",
  tpo_procedure_snapshot_as_at_2026_08_26:"corpus identity",
  trace_path_configuration:"expected product response",
});

export function qualificationAllowedValueKeys(caseId) {
  const keys = CASE_VALUE_KEYS[String(caseId || "")];
  if (!keys) throw Object.assign(new Error("Qualification case has no audited synthetic-fixture schema."),{ status:400,code:"INVALID_QUALIFICATION_CONTEXT" });
  return keys;
}

export function qualificationExpectedValueType(caseId,key) {
  const keys = qualificationAllowedValueKeys(caseId);
  const index = keys.indexOf(String(key));
  const types = CASE_VALUE_TYPES[String(caseId || "")];
  if (index < 0 || !types || types.length !== keys.length || !types[index]) {
    throw Object.assign(new Error("Qualification fixture type schema is incomplete."),{ status:500,code:"INVALID_QUALIFICATION_CONTEXT" });
  }
  return types[index];
}

export function projectQualificationFixtureValues(caseId,sourceValues) {
  const values = sourceValues && typeof sourceValues === "object" && !Array.isArray(sourceValues) ? sourceValues : {};
  return Object.fromEntries(qualificationAllowedValueKeys(caseId).map((key) => {
    if (!Object.prototype.hasOwnProperty.call(values,key)) throw Object.assign(new Error(`Pinned fixture ${caseId} is missing audited scenario field ${key}.`),{ code:"INVALID_QUALIFICATION_CONTEXT" });
    return [key,structuredClone(values[key])];
  }));
}

export function qualificationFixtureSchemaAudit(caseId,sourceValues) {
  const allowed = new Set(qualificationAllowedValueKeys(caseId));
  const sourceKeys = Object.keys(sourceValues || {});
  const unaccounted = sourceKeys.filter((key) => !allowed.has(key) && !Object.prototype.hasOwnProperty.call(EXCLUDED_NON_SCENARIO_VALUE_KEYS,key));
  const missing = [...allowed].filter((key) => !sourceKeys.includes(key));
  return { passed:unaccounted.length === 0 && missing.length === 0,unaccounted,missing,allowed:[...allowed],excluded:sourceKeys.filter((key) => Object.prototype.hasOwnProperty.call(EXCLUDED_NON_SCENARIO_VALUE_KEYS,key)) };
}

export const QUALIFICATION_FIXTURE_CASE_IDS = Object.freeze(Object.keys(CASE_VALUE_KEYS));
