import { spawnSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
for(const directory of ['server', 'shared']) for(const file of readdirSync(new URL(`../${directory}/`,import.meta.url), {recursive:true}).filter(f=>f.endsWith('.mjs'))){
  const result=spawnSync(process.execPath,['--check',new URL(`../${directory}/${file}`,import.meta.url).pathname],{stdio:'inherit'});
  if(result.status)process.exit(result.status);
}
