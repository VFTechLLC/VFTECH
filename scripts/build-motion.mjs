import {build} from 'esbuild';
import {readFileSync,writeFileSync,mkdirSync} from 'node:fs';
const check=process.argv.includes('--check');
const result=await build({entryPoints:['site/src/motion-suite.js'],bundle:true,minify:true,format:'esm',target:'es2020',outfile:'site/assets/motion-suite.js',legalComments:'linked',write:false,
  banner:{js:'/*! VFTech motion: React Bits (c) 2026 David Haz, MIT + Commons Clause; Magic UI MIT. See ./licenses/react-bits.txt and ./licenses/magic-ui.txt. Adaptations are part of this website. */'}});
function save(path,content){if(check){if(!readFileSync(path).equals(Buffer.from(content)))throw Error('Motion build is stale: '+path);}else writeFileSync(path,content);}
for(const out of result.outputFiles)save(out.path,out.contents);
mkdirSync('site/assets/licenses',{recursive:true});
for(const [name,source] of [['react-bits','licenses/react-bits.txt'],['magic-ui','licenses/magic-ui.txt'],['lenis','node_modules/lenis/LICENSE']])save('site/assets/licenses/'+name+'.txt',readFileSync(source));
console.log('Motion bundle '+(check?'verified':'built')+' · '+result.outputFiles.find(out=>out.path.endsWith('.js')).contents.length+' bytes');
