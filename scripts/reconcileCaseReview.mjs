import "../server/loadEnv.js";
import { readFile,writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { listMaterialReviewItems,stageMaterialReviewItem } from "../server/repositories/materialReviewRepository.js";
import { listKnowledgeDocuments } from "../server/repositories/knowledgeRepository.js";
import { initialiseDataStore } from "../server/store/userDataStore.js";

const resolutions = {
  "36ea672f8711c9667c2e":"summary-mihlenstedt-v-barclays-1989-curated-summary",
  "e3f295169275e7e8186c":"summary-mihlenstedt-v-barclays-1989-curated-summary",
  "93a6e0daefab8310af18":"official-braganza-v-bp-shipping-2015-uksc-17",
  "c1a7f9b10bf9027666f0":"official-braganza-v-bp-shipping-2015-uksc-17",
  "c7aff17ac27f7e01184f":"official-granada-group-v-law-debenture-2016-ewca-1289",
  "db3eca6396e88979b18d":"official-granada-group-v-law-debenture-2016-ewca-1289",
  "3820e84f4ded3b966d61":"bailii-derby-v-scottish-equitable-2001-ewca-369",
  "8e4e0670c26b97e241af":"bailii-derby-v-scottish-equitable-2001-ewca-369",
  "c19102ecac7f129a20c8":"summary-re-courage-group-1987-curated-summary",
  "9728b94c2b58d58f8563":"summary-re-courage-group-1987-curated-summary",
  "af44093b2e9be9b1ae87":"official-barnardos-v-buckinghamshire-2018-uksc-55",
  "28290568c7429d0352a2":"official-barnardos-v-buckinghamshire-2018-uksc-55",
  "bc4297d4dab22c9bb0f8":"official-braganza-v-bp-shipping-2015-uksc-17",
  "050e24c86eb6afebe845":"official-lloyds-gmp-equalisation-2020-ewhc-3135-ch",
  "470d8e2c69d1badc1a09":"official-lloyds-gmp-equalisation-2020-ewhc-3135-ch",
  "9c06a24ef82e5d004818":"official-ibm-v-dalgleish-2014-ewhc-980-ch",
  "322e958ac53f6186072c":"official-ibm-v-dalgleish-2014-ewhc-980-ch",
  "dce4eb48c1484daae5a8":"summary-imperial-group-v-imperial-tobacco-1991-curated-summary",
  "b9a31ed3adf2cfa47858":"summary-imperial-group-v-imperial-tobacco-1991-curated-summary",
  "aaebdd0eaa3fa7c2315c":"summary-mettoy-v-evans-1990-curated-summary",
  "5455e540b07aab14ae75":"official-brass-trustees-v-goldstone-2023-ewhc-1978-ch",
  "9bf323f5286f5b26d59e":"bailii-edge-v-pensions-ombudsman-1999-ewca-2013",
  "07512a3b18bceda8ac68":"official-eu-hampshire-v-ppf-c-17-17",
  "90adb6c94b0219fedce0":"official-eu-psv-v-bauer-c-168-18",
  "64470a7abd58c21ec0ff":"official-eu-robins-v-secretary-of-state-c-278-05",
  "1b4f15d1c7ed61b4dde3":"official-eu-hogan-v-minister-c-398-11",
  "1ef5db777e6f2356153d":"official-hughes-v-ppf-2020-ewhc-1598-admin",
  "5d2b5418fc6c07490565":"official-sswp-ppf-v-hughes-2021-ewca-1093",
  "d91b6655aa1a4b143680":"official-eu-barber-v-guardian-c-262-88",
  "f4d54c35efecff1fa418":"official-eu-coloroll-v-russell-c-200-91",
  "c2ef9726b9e7cff346f5":"official-eu-safeway-v-newton-c-171-18",
  "31659bfd765ccc32ef2d":"official-eu-lindorfer-v-council-c-227-04-p",
  "78f1e0a11c783f08bfbc":"official-eu-ag-safeway-v-newton-c-171-18",
  "d953d2447a936525ef6d":"official-safeway-v-newton-2020-ewca-869",
  "6d245c645fe3e2178797":"official-safeway-v-newton-2017-ewca-1482",
  "aa24a1765e1780383de3":"official-eu-test-achats-c-236-09",
  "85a4a37cdfb573a9e90d":"official-brewster-2017-uksc-8",
  "ab898148647f24b93efd":"official-rr-v-secretary-of-state-2019-uksc-52",
  "f571585cbf29774f63ed":"summary-harries-v-church-commissioners-1992-curated-summary",
  "36b407e98eb45179c9e1":"official-butler-sloss-v-charity-commission-2022-ewhc-974-ch",
  "e39e1512c11577d3de68":null,
  "b351105e99db8e341161":"summary-cowan-v-scargill-1985-curated-summary",
  "6aaca0adaf8ade3a5b36":"bailii-gregson-v-hae-trustees-2008-ewhc-1006-ch",
  "5677bf42c4bb456ff25f":"official-gwembe-valley-v-koshy-2003-ewca-1048",
  "0c7b1460b0ed3690c222":"bailii-hr-v-japt-1997-ewhc-ch-371",
  "aab11f5afccabc154005":"official-mcgaughey-v-uss-2023-ewca-873",
  "9f5008548d7067dea7cc":"official-mcgaughey-v-uss-2022-ewhc-1233-ch",
  "686f0abd0957dc1ef8b9":"official-palestine-solidarity-campaign-2020-uksc-16",
  "385b6d04e756b5572f23":"bailii-royal-brunei-airlines-v-tan-1995-ukpc-4",
  "c9480c996104bc749910":"official-eu-beckmann-v-dynamco-c-164-00",
  "aecdaa5f509bfbee8278":"official-eu-martin-v-south-bank-university-c-4-01",
  "c0ad50534e853dda6425":"official-procter-and-gamble-v-sca-2012-ewhc-1257-ch"
};

const inventoryPath = resolve("approved-materials","index","source-inventory.jsonl");
const inventory = (await readFile(inventoryPath,"utf8")).split(/\r?\n/).filter(Boolean).map(JSON.parse)
  .filter((item)=>item.sourceType === "case_law");
if (inventory.length !== 52) throw new Error(`Expected 52 case-law inventory files, found ${inventory.length}`);
if (Object.keys(resolutions).length !== inventory.length) throw new Error("Resolution map does not contain exactly 52 records");

await initialiseDataStore();
const documents = new Map((await listKnowledgeDocuments("__public__")).map((document)=>[document.id,document]));
const rows = [];
for (const item of inventory) {
  if (!(item.id in resolutions)) throw new Error(`No resolution for inventory item ${item.id}`);
  const activeDocumentId = resolutions[item.id];
  const excludedCommentary = activeDocumentId === null;
  const activeDocument = activeDocumentId ? documents.get(activeDocumentId) : null;
  if (activeDocumentId && (!activeDocument || activeDocument.status !== "active")) {
    throw new Error(`Active replacement ${activeDocumentId} is missing for ${item.relativePath}`);
  }
  const summaryOnly = activeDocumentId?.startsWith("summary-") || false;
  const resolutionStatus = excludedCommentary ? "secondary_commentary_excluded" : summaryOnly ? "curated_summary_active" : "judgment_replacement_active";
  const sourceType = excludedCommentary ? "secondary_commentary" : item.sourceType;
  const content = excludedCommentary
    ? "Rejected from the case-law corpus: this file is commentary about Palestine Solidarity Campaign, not a judgment. The official UK Supreme Court judgment is active separately."
    : summaryOnly
      ? `Resolved without activating the local law-report reproduction. A source-bound, independently authored summary is active as ${activeDocumentId} at lower authority than a judgment.`
      : `Resolved without activating the seminar-folder copy. A reusable judgment text is active as ${activeDocumentId}.`;
  const row = {
    inventory_id:item.id,relative_path:item.relativePath,source_checksum:item.sha256,
    resolution_status:resolutionStatus,review_status:excludedCommentary ? "rejected" : "approved",
    active_original:false,active_document_id:activeDocumentId,
    active_document_title:activeDocument?.title || null,active_document_type:activeDocument?.metadata?.sourceType || null,
    rights_note:excludedCommentary
      ? "Secondary commentary was misclassified as case law and is excluded from answers."
      : summaryOnly
        ? "The commercial law-report reproduction remains review-only and is not redistributed; only a new factual/legal summary is active."
        : "The local seminar copy remains inactive; the active replacement records its own reusable source and licence."
  };
  rows.push(row);
  await stageMaterialReviewItem({
    id:`inventory-${item.id}`,sourceDocumentId:`inventory-${item.id}`,sourceChecksum:item.sha256,
    sourceType,title:item.relativePath,content,citations:activeDocumentId ? [{ documentId:activeDocumentId,title:activeDocument.title }] : [],
    status:row.review_status,
    metadata:{ bytes:item.bytes,extension:item.extension,inventoryStatus:item.status,activeEvidence:false,
      resolutionStatus,activeReplacementId:activeDocumentId,activeReplacementType:row.active_document_type,
      rightsNote:row.rights_note,reviewKind:"case_law_source_reconciliation" }
  });
}

const report = {
  generated_at:new Date().toISOString(),inventory_files:rows.length,
  judgment_replacement_active:rows.filter((row)=>row.resolution_status === "judgment_replacement_active").length,
  curated_summary_active:rows.filter((row)=>row.resolution_status === "curated_summary_active").length,
  secondary_commentary_excluded:rows.filter((row)=>row.resolution_status === "secondary_commentary_excluded").length,
  rows
};
await writeFile(resolve("approved-materials","index","case-law-review-resolution.json"),`${JSON.stringify(report,null,2)}\n`);
const reviewItems = await listMaterialReviewItems("all");
console.log(JSON.stringify({ ...Object.fromEntries(Object.entries(report).filter(([key])=>key !== "rows")),review_database:{ approved:reviewItems.filter((item)=>item.status === "approved").length,rejected:reviewItems.filter((item)=>item.status === "rejected").length,pending:reviewItems.filter((item)=>item.status === "pending_legal_review").length } },null,2));
