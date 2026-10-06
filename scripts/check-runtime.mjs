import { spawnSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
for(const file of readdirSync(new URL('../server/',import.meta.url)).filter(f=>f.endsWith('.mjs'))){
  const result=spawnSync(process.execPath,['--check',new URL(`../server/${file}`,import.meta.url).pathname],{stdio:'inherit'});
  if(result.status)process.exit(result.status);
}
