#!/usr/bin/env node
// Exact residual-text gate for the separately authorized gateway checkout.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

const gateway=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const han=/\p{Script=Han}/u;
const sha=s=>createHash('sha256').update(s).digest('hex');
const match=(p,line,exceptions)=>exceptions.find(e=>e.path===p&&(e.kind==='file'||e.hash===sha(line)));
if(process.argv.includes('--self-test')){
  const locale=String.fromCodePoint(0x4e2d,0x6587);
  const e={path:'example.js',kind:'line',hash:sha(locale)};
  assert.equal(match('example.js',locale,[e]),e);
  assert.equal(match('example.js','// new '+locale,[e]),undefined);
  assert.equal(match('other.js',locale,[e]),undefined);
  console.log('PASS: exact gateway locale fixture accepted; new technical comment and changed path rejected');
}else{
  if(!existsSync(gateway))throw Error('Authorized gateway checkout is missing');
  const manifest=JSON.parse(readFileSync(path.join(gateway,'english-exceptions.json'),'utf8'));
  const exceptions=Array.isArray(manifest)?manifest:manifest.exceptions;
  const files=execFileSync('git',['ls-files','--cached','--others','--exclude-standard','-z'],{cwd:gateway,encoding:'utf8'}).split('\0').filter(Boolean);
  const used=new Set(),errors=[],unreviewed=[];
  for(const e of exceptions){
    if(!e.path||!e.category||!e.reason||!['line','file'].includes(e.kind)||/[?*]/.test(e.path)||path.isAbsolute(e.path)||e.path.split('/').includes('..'))throw Error('Invalid gateway exception');
    if(e.kind==='file'){
      if(e.path.endsWith('.js'))throw Error('Maintained gateway JavaScript cannot have a whole-file exception');
      if(!e.sha256||!existsSync(path.join(gateway,e.path))||sha(readFileSync(path.join(gateway,e.path)))!==e.sha256)errors.push({path:e.path,error:'Stale file exception'});
    }
    if(e.companion&&!existsSync(path.join(gateway,e.companion)))errors.push({path:e.path,error:'Missing English companion'});
  }
  for(const p of files){
    const file=path.join(gateway,p);if(!existsSync(file))continue;
    const data=readFileSync(file);if(data.includes(0))continue;
    data.toString('utf8').split(/\r?\n/).forEach((line,i)=>{
      if(!han.test(line))return;
      const e=match(p,line,exceptions);
      if(e)used.add(e);else unreviewed.push({path:p,line:i+1,hash:sha(line)});
    });
    if(han.test(p))errors.push({path:p,error:'Unreviewed Chinese path'});
  }
  for(const e of exceptions)if(!used.has(e))errors.push({path:e.path,error:'Unused exception'});
  console.log(JSON.stringify({scope:'gateway',files:files.length,unreviewedLines:unreviewed.length,exceptionErrors:errors.length,errors,firstUnreviewed:unreviewed.slice(0,20)},null,2));
  if(errors.length||unreviewed.length)process.exitCode=1;
}
