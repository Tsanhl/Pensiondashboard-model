import test from 'node:test';
import assert from 'node:assert/strict';
import {resourceLimitViolation,footprintGiB} from '../scripts/lib/adaptabilityResourceLimits.mjs';
const limits={prestart_swap_max_mib:6144,system_swap_absolute_max_mib:8192,swap_growth_max_mib:2048,system_free_min_percent:15,process_physical_footprint_max_gib:12,mlx_peak_max_decimal_gb:14,total_seconds:660};
test('resource proposal enforces absolute and incremental memory limits independently',()=>{
 const sample={swap_used_mb:6500,swap_delta_mb:1500,system_free_percent:30,physical_footprint_gib:8};
 assert.equal(resourceLimitViolation(limits,sample),null);
 assert.equal(resourceLimitViolation(limits,sample,{prestart:true}),'PRESTART_SWAP_LIMIT');
 assert.equal(resourceLimitViolation(limits,{...sample,swap_used_mb:8200}),'ABSOLUTE_SWAP_LIMIT');
 assert.equal(resourceLimitViolation(limits,{...sample,swap_delta_mb:2049}),'SWAP_GROWTH_LIMIT');
 assert.equal(resourceLimitViolation(limits,{...sample,physical_footprint_gib:12.1}),'PROCESS_FOOTPRINT_LIMIT');
 assert.equal(resourceLimitViolation(limits,{...sample,physical_footprint_gib:NaN}),'RESOURCE_METRICS_UNAVAILABLE');
 assert.equal(footprintGiB('Physical footprint:         1024.0M'),1);
});
