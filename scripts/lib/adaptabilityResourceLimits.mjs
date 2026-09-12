export function validateResourceLimits(limits) {
  const keys=['prestart_swap_max_mib','system_swap_absolute_max_mib','swap_growth_max_mib','system_free_min_percent','process_physical_footprint_max_gib','mlx_peak_max_decimal_gb','total_seconds'];
  for(const key of keys)if(!Number.isFinite(limits?.[key])||limits[key]<=0)throw Error('Missing finite resource limit: '+key);
  if(limits.prestart_swap_max_mib+limits.swap_growth_max_mib>limits.system_swap_absolute_max_mib)throw Error('Inconsistent absolute swap bound');
  return limits;
}
export function resourceLimitViolation(limits, sample, {prestart=false}={}) {
  validateResourceLimits(limits);
  const required=prestart?['swap_used_mb','system_free_percent']:['swap_used_mb','swap_delta_mb','system_free_percent','physical_footprint_gib'];
  if(required.some(key=>!Number.isFinite(sample[key])))return 'RESOURCE_METRICS_UNAVAILABLE';
  if(prestart&&sample.swap_used_mb>limits.prestart_swap_max_mib)return 'PRESTART_SWAP_LIMIT';
  if(sample.swap_used_mb>limits.system_swap_absolute_max_mib)return 'ABSOLUTE_SWAP_LIMIT';
  if(sample.swap_delta_mb>limits.swap_growth_max_mib)return 'SWAP_GROWTH_LIMIT';
  if(sample.system_free_percent<limits.system_free_min_percent)return 'HOST_FREE_MEMORY_LIMIT';
  if(sample.physical_footprint_gib>limits.process_physical_footprint_max_gib)return 'PROCESS_FOOTPRINT_LIMIT';
  return null;
}
export function footprintGiB(text) {
  const match=String(text).match(/Physical footprint:\s*([\d.]+)([KMG])/);
  return match?Number(match[1])*({K:1/1024/1024,M:1/1024,G:1}[match[2]]):NaN;
}
