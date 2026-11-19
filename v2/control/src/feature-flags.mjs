/** Resolve a production feature flag from a secret override first.
 * Secret overrides are authoritative so an explicit "false" can fail closed
 * even when a plain-text Wrangler variable is accidentally left enabled.
 */
export function enabled(env,name) {
  if(!env||typeof env!=='object'||typeof name!=='string'||
     !/^[A-Z][A-Z0-9_]{1,79}$/.test(name))return false;
  const secret=env[name+'_SECRET'];
  if(typeof secret==='string')return secret==='true';
  return env[name]==='true';
}
