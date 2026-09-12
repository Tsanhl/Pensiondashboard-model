import test from 'node:test';
import assert from 'node:assert/strict';
import {parseVmStat,vmDelta} from '../scripts/lib/adaptabilityTelemetry.mjs';
import {resourceLimitViolation} from '../scripts/lib/adaptabilityResourceLimits.mjs';
import {readFileSync} from 'node:fs';
const sample='Mach Virtual Memory Statistics: (page size of 16384 bytes)\nSwapins: 10.\nSwapouts: 20.\nPages occupied by compressor: 100.\n';
test('vm telemetry preserves page size and system attribution',()=>{
  const a={...parseVmStat(sample),monotonic_ms:1000};
  const b={...a,swapins:74,swapouts:148,monotonic_ms:3000};
  const delta=vmDelta(a,b);
  assert.equal(delta.swapin_mib_per_second,.5);
  assert.equal(delta.swapout_mib_per_second,1);
  assert.equal(delta.attribution,'SYSTEM_WIDE_NOT_PROCESS_SPECIFIC');
});
test('missing, reset and stale counters never appear as zero activity',()=>{
  assert.throws(()=>parseVmStat('timeout'),/Invalid/);
  const a={...parseVmStat(sample),monotonic_ms:1000};
  assert.equal(vmDelta(null,a).available,false);
  assert.equal(vmDelta(a,a).available,false);
  assert.equal(vmDelta(a,{...a,swapouts:0,monotonic_ms:2000}).available,false);
  assert.equal(vmDelta(a,{...a,page_bytes:4096,monotonic_ms:2000}).available,false);
});
test('prestart growth uses the observed baseline, not zero system swap',()=>{
  const limits={prestart_swap_max_mib:6144,system_swap_absolute_max_mib:8192,swap_growth_max_mib:2048,
    system_free_min_percent:10,process_physical_footprint_max_gib:12,mlx_peak_max_decimal_gb:14,total_seconds:1800};
  assert.equal(resourceLimitViolation(limits,{swap_used_mb:3700,swap_delta_mb:0,system_free_percent:79},{prestart:true}),null);
  for(const name of ['runAdaptabilityResumeProof.mjs','runEvidenceBoundaryComparison.mjs']){
    const source=readFileSync(new URL('../scripts/'+name,import.meta.url),'utf8');
    assert.match(source,/initial\.swap_delta_mb=0/);
    assert.doesNotMatch(source,/collectTelemetry\(\{initialSwap:0\}\)/);
  }
});
