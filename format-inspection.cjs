const fs = require('node:fs');
const path = require('node:path');
const prettier = require('prettier');
if (!process.argv[2]) throw Error('Usage: node format-inspection.cjs EXTENSION_DIRECTORY');
const base = path.resolve(process.argv[2]);
(async () => {
  fs.mkdirSync('inspection', {recursive:true});
  const web = fs.readdirSync(path.join(base,'webview/assets')).find(f=>/^app-initial-.*\.js$/.test(f));
  for(const [label,file] of [['host',path.join(base,'out/extension.js')],['web',path.join(base,'webview/assets',web)]]) {
    const source=fs.readFileSync(file,'utf8');
    fs.writeFileSync(`inspection/${label}.js`,await prettier.format(source,{parser:'babel'}));
    console.log(label,file,source.length);
  }
})();
