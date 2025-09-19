import express from "express"
import multer from "multer"
import AdmZip from "adm-zip"
import simpleGit from "simple-git"
import fs from "fs"
import path from "path"
import os from "os"
import {execSync, spawnSync} from "child_process"

const GEMINI_API_KEY="GEMINI_API_KEY"
const app=express()
app.use(express.json({limit:"25mb"}))
const upload=multer({dest:os.tmpdir()})

const rmdir=p=>{if(fs.existsSync(p)){for(const f of fs.readdirSync(p)){const cur=path.join(p,f);if(fs.lstatSync(cur).isDirectory())rmdir(cur);else fs.unlinkSync(cur)}fs.rmdirSync(p)}}
const ensureDir=p=>{if(!fs.existsSync(p))fs.mkdirSync(p,{recursive:true})}
const walk=(dir,acc=[])=>{for(const f of fs.readdirSync(dir)){const p=path.join(dir,f);const st=fs.statSync(p);if(st.isDirectory())walk(p,acc);else acc.push(p)}return acc}
const readSafe=p=>{try{return fs.readFileSync(p,"utf8")}catch{return""}}
const tryRun=(cmd,args,opts={})=>{try{const r=spawnSync(cmd,args,{encoding:"utf8",timeout:120000,maxBuffer:10*1024*1024,...opts});return {stdout:r.stdout||"",stderr:r.stderr||"",status:r.status}}catch(e){return {stdout:"",stderr:String(e),status:1}}}
const listExt=(files,...exts)=>files.filter(f=>exts.some(e=>f.toLowerCase().endsWith(e)))

const jsBestPractices=code=>{const out=[];if(/\bvar\b/.test(code))out.push({type:"best_practice",message:"Use let/const instead of var",suggestion:"Replace var with let/const"}) ;if(/==[^=]/.test(code))out.push({type:"best_practice",message:"Use === instead of ==",suggestion:"Replace == with ==="}) ;if(/function\s+\w*\s*\([^)]*\)\s*{([\s\S]{400,})}/.test(code))out.push({type:"best_practice",message:"Large function; refactor into smaller units",suggestion:"Split into smaller functions"}) ;return out}
const pyBestPractices=code=>{const out=[];if(/\bprint\(.*\)/.test(code)&&!code.includes("if __name__")==true)out.push({type:"best_practice",message:"Avoid raw print in production",suggestion:"Use logging module"}) ;if(/\t/.test(code))out.push({type:"best_practice",message:"Mixed indentation risk",suggestion:"Use 4-space indentation consistently"}) ;return out}
const javaBestPractices=code=>{const out=[];if(/ArrayList\s*<\s*>/.test(code))out.push({type:"best_practice",message:"Specify generics type",suggestion:"Use typed generics like ArrayList<String>"}) ;if(/System\.out\.print/.test(code))out.push({type:"best_practice",message:"Avoid System.out for logging",suggestion:"Use a logging framework"}) ;return out}
const phpBestPractices=code=>{const out=[];if(/<\?=/.test(code))out.push({type:"best_practice",message:"Short echo tags may be disabled",suggestion:"Use <?php echo ...; ?>"}) ;if(/\$GLOBALS|\$_REQUEST/.test(code))out.push({type:"best_practice",message:"Avoid superglobals directly",suggestion:"Use dependency injection or request objects"}) ;return out}
const cBestPractices=code=>{const out=[];if(/gets\(/.test(code))out.push({type:"best_practice",message:"Avoid gets()",suggestion:"Use fgets() with size limit"}) ;if(/strcpy\(/.test(code))out.push({type:"best_practice",message:"Unsafe strcpy()",suggestion:"Use strncpy() with bounds checking"}) ;return out}
const cppBestPractices=code=>{const out=[];if(/\bnew\b/.test(code)&&!/unique_ptr|shared_ptr/.test(code))out.push({type:"best_practice",message:"Prefer RAII smart pointers",suggestion:"Use std::unique_ptr or std::make_unique"}) ;if(/using\s+namespace\s+std;/.test(code))out.push({type:"best_practice",message:"Avoid global using namespace std",suggestion:"Use qualified names"}) ;return out}

const detectImportsJS=code=>{const a=[...code.matchAll(/\brequire\(['"]([^'"]+)['"]\)/g)].map(m=>m[1]).concat([...code.matchAll(/\bfrom\s+['"]([^'"]+)['"]/g)].map(m=>m[1])).filter(x=>!x.startsWith(".")&&!x.startsWith("/")).map(x=>x.split("/")[0]);return Array.from(new Set(a))}
const detectImportsPy=code=>{const a=[...code.matchAll(/\bimport\s+([a-zA-Z0-9_]+)/g)].map(m=>m[1]).concat([...code.matchAll(/\bfrom\s+([a-zA-Z0-9_]+)\s+import\b/g)].map(m=>m[1]));return Array.from(new Set(a))}
const shingleDup=(files,root)=>{const tokens=f=>readSafe(f).split(/\r?\n/).map(s=>s.trim()).filter(Boolean);const map=[];for(const f of files){const lines=tokens(f);for(let i=0;i<lines.length-8;i++){const key=lines.slice(i,i+8).join("|");map.push({key,file:f,start:i+1,end:i+8})}}const groups={};for(const r of map){if(!groups[r.key])groups[r.key]=[];groups[r.key].push(r)}const dups=[];for(const k of Object.keys(groups)){const g=groups[k];if(g.length>1){for(let i=0;i<g.length;i++)for(let j=i+1;j<g.length;j++){if(g[i].file!==g[j].file)dups.push({file1:path.relative(root,g[i].file),file2:path.relative(root,g[j].file),lines:`${g[i].start}-${g[i].end} vs ${g[j].start}-${g[j].end}`,suggestion:"Extract shared logic into a single function/module"})}}return dups.slice(0,100)}

const eslintRun=dir=>{const r=tryRun("npx",["-y","eslint",".","-f","json"],{cwd:dir});if(r.status!==0&&r.stdout.trim()==="")return [];try{return JSON.parse(r.stdout)}catch{return []}}
const pylintRun=files=>{const out=[];for(const f of files){const r=tryRun("pylint",[f,"-f","json"]);if(r.stdout){try{out.push(...JSON.parse(r.stdout))}catch{}}}return out}
const checkstyleRun=(dir)=>{const jar=process.env.CHECKSTYLE_JAR||"";let r;if(jar&&fs.existsSync(jar)){r=tryRun("java",["-jar",jar,"-c","/google_checks.xml","-f","xml",dir])}else{r=tryRun("checkstyle",["-c","/google_checks.xml","-f","xml",dir])}return r.stdout}
const cppcheckRun=files=>{if(files.length===0)return "";const r=tryRun("cppcheck",["--enable=all","--template=gcc",...files]);return r.stderr||r.stdout}
const phplintRun=files=>{const res=[];for(const f of files){const r=tryRun("php",["-l",f]);if(r.stdout||r.stderr)res.push({file:f,out:(r.stdout||r.stderr).trim()})}return res}

const parseNpmDeps=dir=>{const pkg=path.join(dir,"package.json");if(!fs.existsSync(pkg))return {declared:[],missing:[],unused:[],outdated:[]};const json=JSON.parse(fs.readFileSync(pkg,"utf8"));const declared=Object.keys(json.dependencies||{}).concat(Object.keys(json.devDependencies||{}));const files=walk(dir).filter(f=>/\.(js|jsx|ts|tsx|mjs|cjs)$/.test(f));const imports=new Set();for(const f of files)detectImportsJS(readSafe(f)).forEach(x=>imports.add(x));const missing=[...imports].filter(x=>!declared.includes(x));const unused=declared.filter(x=>!imports.has(x));let outdated=[];const r=tryRun("npm",["outdated","--json"],{cwd:dir});if(r.stdout){try{const obj=JSON.parse(r.stdout);outdated=Object.keys(obj).map(k=>({name:k,current:obj[k].current,latest:obj[k].latest}))}catch{}}return {declared,missing,unused,outdated}
}
const parsePyDeps=dir=>{const req=path.join(dir,"requirements.txt");const declared=fs.existsSync(req)?fs.readFileSync(req,"utf8").split(/\r?\n/).map(s=>s.split(/[<>=]/)[0].trim()).filter(Boolean):[];const files=walk(dir).filter(f=>f.endsWith(".py"));const imports=new Set();for(const f of files)detectImportsPy(readSafe(f)).forEach(x=>imports.add(x));const missing=[...imports].filter(x=>!declared.includes(x));const unused=declared.filter(x=>!imports.has(x));let outdated=[];const pip=tryRun("pip",["list","--outdated","--format","json"]);if(pip.stdout){try{outdated=JSON.parse(pip.stdout).map(p=>({name:p.name,current:p.version,latest:p.latest_version}))}catch{}}return {declared,missing,unused,outdated}}
const parseMavenDeps=dir=>{const pom=path.join(dir,"pom.xml");if(!fs.existsSync(pom))return {declared:[],missing:[],unused:[],outdated:[]};let outdated=[];const r=tryRun("mvn",["versions:display-dependency-updates","-DoutputFile=dep-updates.txt"],{cwd:dir});if(fs.existsSync(path.join(dir,"dep-updates.txt"))){const t=fs.readFileSync(path.join(dir,"dep-updates.txt"),"utf8");const lines=t.split(/\r?\n/).filter(l=>l.includes("->"));outdated=lines.slice(0,100).map(l=>{const m=l.match(/([^: ]+:[^: ]+)[^>]*->\s*([0-9A-Za-z\.\-\_]+)/);return {name:m?m[1]:"unknown",current:"",latest:m?m[2]:""}})}
return {declared:[],missing:[],unused:[],outdated}}
const parseComposerDeps=dir=>{const comp=path.join(dir,"composer.json");if(!fs.existsSync(comp))return {declared:[],missing:[],unused:[],outdated:[]};let outdated=[];const r=tryRun("composer",["outdated","--format=json"],{cwd:dir});if(r.stdout){try{const j=JSON.parse(r.stdout);outdated=(j.installed||[]).map(x=>({name:x.name,current:x.version,latest:x.latest}))}catch{}}return {declared:[],missing:[],unused:[],outdated}}

const toIssue=(file,line,type,message)=>({file,issues:[{line,type,message}]})
const mergeIssues=(acc,item)=>{const key=item.file;if(!acc[key])acc[key]={file:key,issues:[]};acc[key].issues.push(...item.issues);return acc}

const aiExplainBatch=async (issues)=>{if(issues.length===0)return []
const prompts=issues.slice(0,100).map(it=>({file:it.file,line:it.line,type:it.type,message:it.message,codeSnippet:it.codeSnippet||""}))
const body={contents:[{parts:[{text:"You are a concise code reviewer. For each item, return JSON with fields: file,line,type,message,suggestion,fixSnippet. Keep fixes minimal and correct."},{text:JSON.stringify(prompts)}]}]}
const res=await fetch("https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent",{method:"POST",headers:{"Content-Type":"application/json","X-goog-api-key":GEMINI_API_KEY},body:JSON.stringify(body)})
if(!res.ok)return []
const data=await res.json()
const txt=((data.candidates&&data.candidates[0]&&data.candidates[0].content&&data.candidates[0].content.parts&&data.candidates[0].content.parts[0]&&data.candidates[0].content.parts[0].text)||"").trim()
try{const parsed=JSON.parse(txt);return Array.isArray(parsed)?parsed:[]}catch{return []}}

const analyzeDir=async (root)=>{const files=walk(root)
const out={}
const jsFiles=listExt(files,".js",".jsx",".ts",".tsx",".mjs",".cjs")
const pyFiles=listExt(files,".py")
const javaFiles=listExt(files,".java")
const cFiles=listExt(files,".c")
const cppFiles=listExt(files,".cpp",".cc",".cxx",".hpp",".hh",".h")
const phpFiles=listExt(files,".php")
if(jsFiles.length){const res=eslintRun(root);for(const f of res){const rel=path.relative(root,f.filePath);for(const m of f.messages){const item={file:rel,issues:[{line:m.line||1,type:m.severity===2?"error":"warning",message:m.ruleId?`${m.ruleId}: ${m.message}`:m.message,codeSnippet:""}]};mergeIssues(out,item)}}for(const f of jsFiles){const bp=jsBestPractices(readSafe(f));if(bp.length)mergeIssues(out,{file:path.relative(root,f),issues:bp.map(x=>({line:1,...x}))})}}
if(pyFiles.length){const pyl=pylintRun(pyFiles);for(const m of pyl){const rel=path.relative(root,m.path||m.module||"");mergeIssues(out,{file:rel||"unknown.py",issues:[{line:m.line||1,type:m.type||"warning",message:m.message||"",codeSnippet:""}]})}for(const f of pyFiles){const bp=pyBestPractices(readSafe(f));if(bp.length)mergeIssues(out,{file:path.relative(root,f),issues:bp.map(x=>({line:1,...x}))})}}
if(javaFiles.length){const xml=checkstyleRun(root);if(xml){const matches=[...xml.matchAll(/<file name="([^"]+)">([\s\S]*?)<\/file>/g)];for(const m of matches){const rel=path.relative(root,m[1]);const errs=[...m[2].matchAll(/<error.*?line="(\d+)".*?severity="([^"]+)".*?message="([^"]+)"/g)];for(const e of errs)mergeIssues(out,{file:rel,issues:[{line:parseInt(e[1]||"1"),type:e[2]||"warning",message:e[3]||"",codeSnippet:""}]})}}for(const f of javaFiles){const bp=javaBestPractices(readSafe(f));if(bp.length)mergeIssues(out,{file:path.relative(root,f),issues:bp.map(x=>({line:1,...x}))})}}
if(cFiles.length||cppFiles.length){const r=cppcheckRun([...cFiles,...cppFiles]);const lines=r.split(/\r?\n/).filter(Boolean);for(const L of lines){const m=L.match(/(.+?):(\d+):\d+:\s*(warning|error|style):\s*(.*)/)||L.match(/(.+?):(\d+):\s*(\w+):\s*(.*)/);if(m)mergeIssues(out,{file:path.relative(root,m[1]),issues:[{line:parseInt(m[2]||"1"),type:(m[3]||"warning").toLowerCase(),message:m[4]||"",codeSnippet:""}]})}for(const f of cFiles){const bp=cBestPractices(readSafe(f));if(bp.length)mergeIssues(out,{file:path.relative(root,f),issues:bp.map(x=>({line:1,...x}))})}for(const f of cppFiles){const bp=cppBestPractices(readSafe(f));if(bp.length)mergeIssues(out,{file:path.relative(root,f),issues:bp.map(x=>({line:1,...x}))})}}
if(phpFiles.length){const r=phplintRun(phpFiles);for(const row of r){const m=row.out.match(/in\s+(.+)\s+on\s+line\s+(\d+)/);mergeIssues(out,{file:path.relative(root,row.file),issues:[{line:m?parseInt(m[2]):1,type:/No syntax errors/.test(row.out)?"info":"error",message:row.out,codeSnippet:""}]})}for(const f of phpFiles){const bp=phpBestPractices(readSafe(f));if(bp.length)mergeIssues(out,{file:path.relative(root,f),issues:bp.map(x=>({line:1,...x}))})}}
const deps={node:parseNpmDeps(root),python:parsePyDeps(root),java:parseMavenDeps(root),php:parseComposerDeps(root)}
const duplicates=shingleDup(files.filter(f=>/\.(js|jsx|ts|tsx|py|java|php|c|cpp|cc|cxx|hpp|hh|h)$/.test(f)),root)
const flatIssues=[]
for(const k of Object.keys(out)){for(const it of out[k].issues){flatIssues.push({file:k,line:it.line,type:it.type,message:it.message,codeSnippet:it.codeSnippet||""})}}
const ai=await aiExplainBatch(flatIssues)
const aiMap={}
for(const a of ai){const key=`${a.file}::${a.line}::${a.type}::${a.message}`;aiMap[key]=a}
const results=[]
for(const k of Object.keys(out)){const fileIssues=out[k].issues.map(it=>{const key=`${k}::${it.line}::${it.type}::${it.message}`;const extra=aiMap[key]||{};return {line:it.line,type:it.type,message:it.message,suggestion:extra.suggestion||"",fixSnippet:extra.fixSnippet||""}})
results.push({file:k,issues:fileIssues})}
return {results,dependencies:{node:deps.node,python:deps.python,java:deps.java,php:deps.php},duplicates}
}

const prepareUpload=async (req)=>{const work=fs.mkdtempSync(path.join(os.tmpdir(),"aidbg-"));ensureDir(work);if(req.body&&req.body.repoUrl){const git=simpleGit();await git.clone(req.body.repoUrl,work)}else if(req.file){const f=req.file.path;const name=req.file.originalname.toLowerCase();if(name.endsWith(".zip")){const zip=new AdmZip(f);zip.extractAllTo(work,true)}else{const dest=path.join(work,req.file.originalname);fs.renameSync(f,dest)}}return work}

app.post("/analyze",upload.single("file"),async (req,res)=>{try{const dir=await prepareUpload(req);const data=await analyzeDir(dir);rmdir(dir);res.json(data)}catch(e){res.status(500).json({error:String(e)})}})

app.get("/health",(req,res)=>res.json({ok:true}))

const PORT=process.env.PORT||3000
app.listen(PORT,()=>{})

module.exports = app;
