const express = require("express");
const cors = require("cors");
const path = require("path");
const fs = require("fs/promises");
const fssync = require("fs");
const { fileURLToPath } = require("url");
const http = require("http");
const SocketIOServer = require("socket.io").Server;
const multer = require("multer");
const AdmZip = require("adm-zip");
const simpleGit = require("simple-git");
const axios = require("axios");
const crypto = require("crypto");
const os = require("os");
const pty = require("node-pty");

const GEMINI_API_KEY = "AIzaSyDI2yQ_MuXDcJ_y7r2G4LH1iyommZUyFiQ";

const __filename = fileURLToPath(require.main.filename);
const __dirname = path.dirname(__filename);
const app = express();
const server = http.createServer(app);
const io = new SocketIOServer(server, { cors: { origin: "*" } });
app.use(cors());
app.use(express.json({ limit: "50mb" }));
app.use(express.urlencoded({ extended: true, limit: "50mb" }));

const ROOT_DIR = path.resolve(process.env.ROOT_DIR || path.join(__dirname, "projects"));
const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(__dirname, "data"));
const UPLOADS_DIR = path.join(DATA_DIR, "uploads");
const SESSIONS_FILE = path.join(DATA_DIR, "sessions.json");

// Async initialization wrapped in IIFE
(async function() {
  await fs.mkdir(ROOT_DIR, { recursive: true });
  await fs.mkdir(UPLOADS_DIR, { recursive: true });
})();

const storage = multer.diskStorage({
  destination: (_, __, cb) => cb(null, UPLOADS_DIR),
  filename: (_, file, cb) => cb(null, Date.now() + "-" + file.originalname)
});
const upload = multer({ storage });

const state = { workspaces: {}, terminals: {}, indexes: {} };

const readJson = async (p, fallback) => { try { const b = await fs.readFile(p, "utf8"); return JSON.parse(b); } catch { return fallback; } };
const writeJson = async (p, obj) => { await fs.mkdir(path.dirname(p), { recursive: true }); await fs.writeFile(p, JSON.stringify(obj, null, 2), "utf8"); };
const normalizeRel = (p) => p.replace(/\\/g, "/").replace(/^\/+/, "");
const safeJoin = (root, targetRel) => { const rel = normalizeRel(targetRel || ""); const abs = path.resolve(root, rel); if (!abs.startsWith(root)) throw new Error("Invalid path"); return abs; };
const ensureDir = async (abs) => { await fs.mkdir(path.dirname(abs), { recursive: true }); };
const extOk = (name) => {
  const bad = ["node_modules",".git",".next",".cache",".turbo","dist","build",".venv","__pycache__",".pytest_cache",".mypy_cache",".gradle",".idea",".vscode",".pnpm-store",".yarn"];
  for (const b of bad) if (name.includes("/"+b+"/")||name.endsWith("/"+b)||name===b) return false;
  return true;
};
const byteSample = (str, max=2000) => { if (str.length<=max) return str; const head=str.slice(0,Math.floor(max*0.6)); const tail=str.slice(-Math.floor(max*0.3)); return head+"\n...\n"+tail; };
const listDirTree = async (absPath, depth=20) => {
  const s = await fs.stat(absPath);
  const node = { name: path.basename(absPath), path: absPath, isDir: s.isDirectory(), size: s.size, mtime: s.mtimeMs };
  if (!node.isDir || depth<=0) return { ...node, children: [] };
  const names = await fs.readdir(absPath);
  const children = [];
  for (const n of names) {
    if (n === ".git") continue;
    const childAbs = path.join(absPath, n);
    if (!extOk(normalizeRel(childAbs))) continue;
    try { children.push(await listDirTree(childAbs, depth-1)); } catch {}
  }
  return { ...node, children: children.sort((a,b)=>a.isDir===b.isDir? a.name.localeCompare(b.name): a.isDir?-1:1) };
};
const walkFiles = async (root) => {
  const out = [];
  const rec = async (dir) => {
    const items = await fs.readdir(dir);
    for (const it of items) {
      const p = path.join(dir,it);
      const rel = normalizeRel(path.relative(root,p));
      if (!extOk(rel)) continue;
      const st = await fs.stat(p);
      if (st.isDirectory()) await rec(p);
      else out.push({ abs:p, rel, size:st.size, mtime:st.mtimeMs, ext:path.extname(p).slice(1).toLowerCase() });
    }
  };
  await rec(root);
  return out;
};
const getOrCreateWorkspace = async (id) => {
  if (!id) throw new Error("workspaceId required");
  if (!state.workspaces[id]) state.workspaces[id] = { id, root: path.join(ROOT_DIR, id) };
  await fs.mkdir(state.workspaces[id].root, { recursive: true });
  return state.workspaces[id];
};
const readFileSafe = async (p) => { try { return await fs.readFile(p,"utf8"); } catch { return ""; } };
const scoreRelevance = (text, query) => {
  const q = (query||"").toLowerCase().split(/[^a-z0-9_]+/).filter(Boolean);
  if (!q.length) return 0;
  let s = 0;
  const tl = text.toLowerCase();
  for (const w of q) { const c = tl.split(w).length-1; s += Math.min(5,c); }
  return s + Math.min(5, Math.floor(text.length/2000));
};
const capTokens = (parts, maxChars=120000) => {
  let used=0, out=[];
  for (const p of parts.sort((a,b)=>b.score-a.score)) {
    if (used>=maxChars) break;
    const left=maxChars-used;
    const take = p.content.length>left? p.content.slice(0,left) : p.content;
    out.push({ path:p.path, content: take });
    used += take.length;
  }
  return out;
};
const runAndCapture = ({ cwd, cmd }) => new Promise((resolve) => {
  const sh = process.platform==="win32" ? {file:"powershell.exe", args:["-NoLogo"]} : {file:process.env.SHELL||"/bin/bash", args:[]};
  const proc = pty.spawn(sh.file, sh.args, { name:"xterm-color", cols:120, rows:30, cwd, env:{...process.env}});
  let out=""; proc.onData(d=> out+=d);
  proc.write(cmd + os.EOL);
  proc.write("exit" + os.EOL);
  proc.onExit(()=> resolve(out));
});
const parseDiagnostics = (txt) => {
  const lines = txt.split(/\r?\n/);
  const errs = [];
  const push = (m) => errs.push(m);
  for (const line of lines) {
    let m = line.match(/^(.+?):(\d+):(\d+):\s*(error|warning)\s*(.+)$/i);
    if (m) { push({ file: normalizeRel(m[1]), line: +m[2], column: +m[3], severity: m[4].toLowerCase(), message: m[5].trim() }); continue; }
    m = line.match(/^(.+?):(\d+):\s*(.+)$/);
    if (m) { push({ file: normalizeRel(m[1]), line:+m[2], column:1, severity:"error", message:m[3].trim() }); continue; }
    m = line.match(/^(.*)\((\d+),(\d+)\):\s*(error|warning)\s*(.+)$/i);
    if (m) { push({ file: normalizeRel(m[1]), line:+m[2], column:+m[3], severity:m[4].toLowerCase(), message:m[5].trim() }); continue; }
    m = line.match(/^([\w./\\-]+):\s*line\s*(\d+),\s*col\s*(\d+),\s*(.*)$/i);
    if (m) { push({ file: normalizeRel(m[1]), line:+m[2], column:+m[3], severity:"error", message:m[4].trim() }); continue; }
  }
  const uniq = {};
  for (const e of errs) { const k = `${e.file}:${e.line}:${e.column}:${e.message}`; if (!uniq[k]) uniq[k]=e; }
  return Object.values(uniq);
};
const filePatchApply = async (absFile, patch) => {
  const orig = fssync.existsSync(absFile) ? fssync.readFileSync(absFile,"utf8") : "";
  const lines = patch.split("\n");
  let content = orig.split("\n");
  let i=0;
  while (i<lines.length && !lines[i].startsWith("@@")) i++;
  while (i<lines.length) {
    const h = lines[i];
    if (!h.startsWith("@@")) { i++; continue; }
    const m = /@@ -(\d+),?(\d+)? \+(\d+),?(\d+)? @@/.exec(h);
    if (!m) { i++; continue; }
    const startOld = parseInt(m[1]);
    let j=i+1, chunk=[];
    while (j<lines.length && !lines[j].startsWith("@@")) { chunk.push(lines[j]); j++; }
    const before = content.slice(0, startOld-1);
    let k = startOld-1;
    const afterStart = [];
    for (const cl of chunk) {
      if (cl.startsWith("-")) { k++; }
      else if (cl.startsWith("+")) afterStart.push(cl.slice(1));
      else if (cl.startsWith(" ")) { afterStart.push(content[k] ?? ""); k++; }
    }
    const rest = content.slice(k);
    content = [...before, ...afterStart, ...rest];
    i=j;
  }
  await ensureDir(absFile);
  await fs.writeFile(absFile, content.join("\n"), "utf8");
  return true;
};
const shellForPlatform = () => {
  if (process.platform === "win32") return { file: "powershell.exe", args: ["-NoLogo"] };
  const shell = process.env.SHELL || "/bin/bash";
  return { file: shell, args: [] };
};

app.get("/health", (_, res) => res.json({ ok: true, root: ROOT_DIR }));

app.post("/workspace/open", async (req, res) => {
  try { const { workspaceId } = req.body; const ws = await getOrCreateWorkspace(workspaceId); res.json({ workspaceId: ws.id, root: ws.root }); }
  catch(e){ res.status(400).json({ error: String(e.message||e) }); }
});

app.get("/workspace/list", async (_, res) => {
  try {
    const names = await fs.readdir(ROOT_DIR);
    const list = [];
    for (const n of names) {
      const p = path.join(ROOT_DIR, n);
      try { const s = await fs.stat(p); if (s.isDirectory()) list.push({ id:n, mtime:s.mtimeMs }); } catch {}
    }
    res.json({ workspaces: list.sort((a,b)=>b.mtime-a.mtime) });
  } catch(e){ res.status(500).json({ error: String(e.message||e) }); }
});

app.post("/tree", async (req,res)=>{
  try { const { workspaceId, relPath="" } = req.body; const ws = await getOrCreateWorkspace(workspaceId); const abs = safeJoin(ws.root, relPath); const tree = await listDirTree(abs); const relRoot = path.relative(ws.root, abs) || ""; res.json({ root: normalizeRel(relRoot), tree }); }
  catch(e){ res.status(400).json({ error: String(e.message||e) }); }
});

app.post("/workspace/index", async (req,res)=>{
  try {
    const { workspaceId } = req.body;
    const ws = await getOrCreateWorkspace(workspaceId);
    const files = await walkFiles(ws.root);
    const index = [];
    for (const f of files) {
      const abs = f.abs;
      const content = await readFileSafe(abs);
      const hash = crypto.createHash("sha1").update(content).digest("hex");
      index.push({ rel:f.rel, size:f.size, mtime:f.mtime, ext:f.ext, hash, sample: byteSample(content, 1200) });
    }
    state.indexes[workspaceId] = { at: Date.now(), index };
    res.json({ ok:true, count:index.length, index });
  } catch(e){ res.status(500).json({ error:String(e.message||e) }); }
});

app.post("/read-file", async (req,res)=>{
  try { const { workspaceId, path: rel } = req.body; const ws = await getOrCreateWorkspace(workspaceId); const abs = safeJoin(ws.root, rel); const data = await fs.readFile(abs,"utf8"); res.json({ content:data }); }
  catch(e){ res.status(400).json({ error:String(e.message||e) }); }
});

app.post("/write-file", async (req,res)=>{
  try { const { workspaceId, path: rel, content } = req.body; const ws = await getOrCreateWorkspace(workspaceId); const abs = safeJoin(ws.root, rel); await ensureDir(abs); await fs.writeFile(abs, content ?? "", "utf8"); res.json({ ok:true }); }
  catch(e){ res.status(400).json({ error:String(e.message||e) }); }
});

app.post("/create-file", async (req,res)=>{
  try { const { workspaceId, path: rel, content="" } = req.body; const ws = await getOrCreateWorkspace(workspaceId); const abs = safeJoin(ws.root, rel); await ensureDir(abs); await fs.writeFile(abs, content, "utf8"); res.json({ ok:true }); }
  catch(e){ res.status(400).json({ error:String(e.message||e) }); }
});

app.post("/mkdirs", async (req,res)=>{
  try { const { workspaceId, path: rel } = req.body; const ws = await getOrCreateWorkspace(workspaceId); const abs = safeJoin(ws.root, rel); await fs.mkdir(abs,{recursive:true}); res.json({ ok:true }); }
  catch(e){ res.status(400).json({ error:String(e.message||e) }); }
});

app.post("/delete-path", async (req,res)=>{
  try { const { workspaceId, path: rel } = req.body; const ws = await getOrCreateWorkspace(workspaceId); const abs = safeJoin(ws.root, rel); await fs.rm(abs,{recursive:true,force:true); res.json({ ok:true }); }
  catch(e){ res.status(400).json({ error:String(e.message||e) }); }
});

app.post("/rename-path", async (req,res)=>{
  try { const { workspaceId, from, to } = req.body; const ws = await getOrCreateWorkspace(workspaceId); const absFrom = safeJoin(ws.root, from); const absTo = safeJoin(ws.root, to); await ensureDir(absTo); await fs.rename(absFrom, absTo); res.json({ ok:true }); }
  catch(e){ res.status(400).json({ error:String(e.message||e) }); }
});

app.post("/upload-zip", upload.single("file"), async (req,res)=>{
  try { const { workspaceId, target="" } = req.body; const ws = await getOrCreateWorkspace(workspaceId); const absTarget = safeJoin(ws.root, target); await fs.mkdir(absTarget,{recursive:true}); const zip = new AdmZip(req.file.path); zip.extractAllTo(absTarget,true); res.json({ ok:true, savedAt: normalizeRel(path.relative(ws.root, absTarget)) }); }
  catch(e){ res.status(400).json({ error:String(e.message||e) }); }
});

app.post("/clone", async (req,res)=>{
  try { const { workspaceId, repoUrl, folderName } = req.body; const ws = await getOrCreateWorkspace(workspaceId); const dest = safeJoin(ws.root, folderName || path.basename(repoUrl, ".git")); await fs.mkdir(dest,{recursive:true}); const git = simpleGit(); await git.clone(repoUrl, dest); res.json({ ok:true, path: normalizeRel(path.relative(ws.root, dest)) }); }
  catch(e){ res.status(500).json({ error:String(e.message||e) }); }
});

app.post("/clone-multi", async (req,res)=>{
  try {
    const { workspaceId, mainFolder="main", frontendRepo, backendRepo, frontendFolder="frontend", backendFolder="backend" } = req.body;
    const ws = await getOrCreateWorkspace(workspaceId);
    const mainAbs = safeJoin(ws.root, mainFolder);
    await fs.mkdir(mainAbs,{recursive:true});
    const feAbs = safeJoin(mainAbs, frontendFolder);
    const beAbs = safeJoin(mainAbs, backendFolder);
    const git = simpleGit();
    if (frontendRepo) { await fs.mkdir(feAbs,{recursive:true}); await git.clone(frontendRepo, feAbs); }
    if (backendRepo) { await fs.mkdir(beAbs,{recursive:true}); await git.clone(backendRepo, beAbs); }
    res.json({ ok:true, paths:{ main: normalizeRel(path.relative(ws.root, mainAbs)), frontend: normalizeRel(path.relative(ws.root, feAbs)), backend: normalizeRel(path.relative(ws.root, beAbs)) } });
  } catch(e){ res.status(500).json({ error:String(e.message||e) }); }
});

app.post("/search", async (req,res)=>{
  try {
    const { workspaceId, query="", relPath="" } = req.body;
    const ws = await getOrCreateWorkspace(workspaceId);
    const base = safeJoin(ws.root, relPath);
    const results = [];
    const walk = async (dir) => {
      const names = await fs.readdir(dir);
      for (const n of names) {
        if (n===".git"||n==="node_modules") continue;
        const p = path.join(dir,n);
        const s = await fs.stat(p);
        if (s.isDirectory()) await walk(p);
        else {
          const txt = await fs.readFile(p,"utf8").catch(()=>null);
          if (!txt) continue;
          if (txt.toLowerCase().includes(query.toLowerCase())) results.push({ file: normalizeRel(path.relative(ws.root,p)) });
        }
      }
    };
    await walk(base);
    res.json({ results });
  } catch(e){ res.status(500).json({ error:String(e.message||e) }); }
});

app.post("/diagnose/run", async (req,res)=>{
  try {
    const { workspaceId, cwd="", command } = req.body;
    const ws = await getOrCreateWorkspace(workspaceId);
    const base = safeJoin(ws.root, cwd || "");
    const out = await runAndCapture({ cwd: base, cmd: command || "npm run build || npm test || pytest || true" });
    const diagnostics = parseDiagnostics(out);
    res.json({ ok:true, output: out, diagnostics });
  } catch(e){ res.status(500).json({ error:String(e.message||e) }); }
});

app.post("/ai/context", async (req,res)=>{
  try {
    const { workspaceId, instruction="", maxChars=120000, subpaths=[] } = req.body;
    const ws = await getOrCreateWorkspace(workspaceId);
    let files = [];
    if (subpaths.length) {
      for (const sp of subpaths) {
        const base = safeJoin(ws.root, sp);
        const list = await walkFiles(base);
        files.push(...list);
      }
    } else {
      files = await walkFiles(ws.root);
    }
    const scored = [];
    for (const f of files) {
      const c = await readFileSafe(f.abs);
      const s = scoreRelevance(c, instruction);
      if (s>0) scored.push({ path:f.rel, content: byteSample(c, 3000), score:s });
    }
    const pack = capTokens(scored, maxChars);
    res.json({ ok:true, files: pack });
  } catch(e){ res.status(500).json({ error:String(e.message||e) }); }
});

app.post("/ai/chat", async (req,res)=>{
  try {
    const { prompt, context="", system="", json=false } = req.body;
    if (!GEMINI_API_KEY) throw new Error("GEMINI_API_KEY missing");
    const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${GEMINI_API_KEY}`;
    const body = {
      contents: [{ role:"user", parts:[{ text: (system?`System:\n${system}\n\n`:"") + (context?`Context:\n${context}\n\n`:"") + `Prompt:\n${prompt}` }]}],
      generationConfig: json ? { responseMimeType: "application/json" } : undefined
    };
    const r = await axios.post(url, body);
    const parts = r.data?.candidates?.[0]?.content?.parts || [];
    const text = parts.map(p=>p.text||"").join("\n");
    res.json({ output: text });
  } catch(e){ const m = e.response?.data || e.message || String(e); res.status(500).json({ error: typeof m==="string"? m : JSON.stringify(m) }); }
});

app.post("/ai/plan-edit", async (req,res)=>{
  try {
    const { workspaceId, instruction, includeContext=true, maxContextChars=100000, subpaths=[] } = req.body;
    const ws = await getOrCreateWorkspace(workspaceId);
    let context = "";
    if (includeContext) {
      let files = [];
      if (subpaths.length) {
        for (const sp of subpaths) {
          const base = safeJoin(ws.root, sp);
          const list = await walkFiles(base);
          files.push(...list);
        }
      } else {
        files = await walkFiles(ws.root);
      }
      const scored = [];
      for (const f of files) {
        const c = await readFileSafe(f.abs);
        const s = scoreRelevance(c, instruction);
        if (s>0) scored.push({ path:f.rel, content: byteSample(c, 3000), score:s });
      }
      const pack = capTokens(scored, maxContextChars);
      context = pack.map(p=>`<file path="${p.path}">\n${p.content}\n</file>`).join("\n\n");
    }
    const schema = JSON.stringify({ actions:[{type:"upsert",path:"",content:""},{type:"patch",path:"",patch:""},{type:"delete",path:""}] },null,2);
    const prompt = `You are an autonomous code editor for a multi-folder project (e.g., main/frontend and main/backend). Perform the user's instruction by returning a JSON object with an "actions" array. Each action is one of: {type:"upsert", path, content}, {type:"patch", path, patch}, {type:"delete", path}. Use minimal changes needed. Do not include explanations. Only valid JSON.\n\nInstruction:\n${instruction}\n\nProject context (may be partial):\n${context}\n\nReturn JSON exactly matching this schema:\n${schema}`;
    if (!GEMINI_API_KEY) throw new Error("GEMINI_API_KEY missing");
    const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${GEMINI_API_KEY}`;
    const r = await axios.post(url, { contents:[{role:"user",parts:[{text:prompt}]}], generationConfig:{ responseMimeType:"application/json" }});
    const text = r.data?.candidates?.[0]?.content?.parts?.map(p=>p.text||"").join("\n") || "{}";
    let plan;
    try { plan = JSON.parse(text); } catch { plan = { actions: [] }; }
    res.json({ ok:true, plan });
  } catch(e){ res.status(500).json({ error:String(e.message||e) }); }
});

app.post("/ai/apply-plan", async (req,res)=>{
  try {
    const { workspaceId, plan } = req.body;
    const ws = await getOrCreateWorkspace(workspaceId);
    const results = [];
    for (const act of plan.actions || []) {
      const rel = normalizeRel(act.path||"");
      if (!rel) { results.push({ path:null, ok:false, error:"missing path" }); continue; }
      const abs = safeJoin(ws.root, rel);
      if (act.type==="delete") {
        await fs.rm(abs,{recursive:true,force:true});
        results.push({ path: rel, ok:true, type:"delete" });
      } else if (act.type==="upsert") {
        await ensureDir(abs);
        await fs.writeFile(abs, act.content ?? "", "utf8");
        results.push({ path: rel, ok:true, type:"upsert" });
      } else if (act.type==="patch") {
        await ensureDir(abs);
        if (!fssync.existsSync(abs)) await fs.writeFile(abs,"","utf8");
        await filePatchApply(abs, act.patch || "");
        results.push({ path: rel, ok:true, type:"patch" });
      } else {
        results.push({ path: rel, ok:false, error:"unknown type" });
      }
    }
    res.json({ ok:true, results });
  } catch(e){ res.status(500).json({ error:String(e.message||e) }); }
});

app.post("/ai/fix-errors", async (req,res)=>{
  try {
    const { workspaceId, diagnostics=[], instructionHint="" } = req.body;
    const ws = await getOrCreateWorkspace(workspaceId);
    const groups = {};
    for (const d of diagnostics) {
      const key = d.file;
      if (!groups[key]) groups[key]=[];
      groups[key].push(d);
    }
    const actions = [];
    if (!GEMINI_API_KEY) throw new Error("GEMINI_API_KEY missing");
    const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${GEMINI_API_KEY}`;
    for (const file in groups) {
      const rel = normalizeRel(file);
      const abs = safeJoin(ws.root, rel);
      const code = await readFileSafe(abs);
      const diagsText = groups[file].map(d=>`${d.file}:${d.line}:${d.column} ${d.severity} ${d.message}`).join("\n");
      const prompt = `You are fixing compile/test errors in a single file. Output a unified diff patch only, with minimal context.\nFile path: ${rel}\nCurrent content:\n${code}\nErrors:\n${diagsText}\n${instructionHint?`Additional guidance:\n${instructionHint}\n`:""}Patch:`;
      const r = await axios.post(url, { contents:[{role:"user",parts:[{text:prompt}]}] });
      const patch = r.data?.candidates?.[0]?.content?.parts?.map(p=>p.text||"").join("\n") || "";
      actions.push({ type:"patch", path: rel, patch });
    }
    res.json({ ok:true, plan:{ actions } });
  } catch(e){ res.status(500).json({ error:String(e.message||e) }); }
});

io.of("/terminal").on("connection", (socket) => {
  let p = null;
  socket.on("start", async ({ workspaceId, cwd = "", cols = 80, rows = 24 }) => {
    try {
      const ws = await getOrCreateWorkspace(workspaceId);
      const base = safeJoin(ws.root, cwd || "");
      const sh = shellForPlatform();
      p = pty.spawn(sh.file, sh.args, { name: "xterm-color", cols, rows, cwd: base, env: { ...process.env } });
      state.terminals[socket.id] = { pid: p.pid, workspaceId, cwd: base };
      p.onData((d) => socket.emit("data", d));
      p.onExit(()=> socket.emit("exit"));
      socket.emit("ready", { pid: p.pid });
    } catch (e) { socket.emit("error", String(e.message||e)); }
  });
  socket.on("input", (data) => { if (p) p.write(data); });
  socket.on("resize", ({ cols, rows }) => { if (p) p.resize(cols, rows); });
  socket.on("disconnect", () => { if (p) { try { p.kill(); } catch {} } delete state.terminals[socket.id]; });
});

app.post("/terminal/exec", async (req,res)=>{
  try {
    const { workspaceId, cwd="", command } = req.body;
    const ws = await getOrCreateWorkspace(workspaceId);
    const base = safeJoin(ws.root, cwd || "");
    const sh = process.platform==="win32" ? {file:"powershell.exe", args:["-NoLogo"]} : {file:process.env.SHELL||"/bin/bash", args:[]};
    const proc = pty.spawn(sh.file, sh.args, { name:"xterm-color", cols:80, rows:24, cwd: base, env:{...process.env}});
    let out=""; proc.onData(d=> out+=d);
    proc.write(command + os.EOL);
    proc.write("exit" + os.EOL);
    await new Promise((resolve)=> proc.onExit(()=> resolve(true)));
    res.json({ ok:true, output: out });
  } catch(e){ res.status(500).json({ error:String(e.message||e) }); }
});

app.post("/persist/session/save", async (req,res)=>{
  try { const data = await readJson(SESSIONS_FILE, {}); const id = crypto.randomUUID(); data[id] = { id, at: Date.now(), payload: req.body }; await writeJson(SESSIONS_FILE, data); res.json({ id }); }
  catch(e){ res.status(500).json({ error:String(e.message||e) }); }
});

app.get("/persist/session/:id", async (req,res)=>{
  try { const data = await readJson(SESSIONS_FILE, {}); const item = data[req.params.id]; if (!item) return res.status(404).json({ error:"not found" }); res.json(item); }
  catch(e){ res.status(500).json({ error:String(e.message||e) }); }
});

app.delete("/persist/session/:id", async (req,res)=>{
  try { const data = await readJson(SESSIONS_FILE, {}); delete data[req.params.id]; await writeJson(SESSIONS_FILE, data); res.json({ ok:true }); }
  catch(e){ res.status(500).json({ error:String(e.message||e) }); }
});

app.delete("/workspace", async (req,res)=>{
  try { const { workspaceId } = req.body; if (!workspaceId) throw new Error("workspaceId required"); const wsPath = path.join(ROOT_DIR, workspaceId); if (!wsPath.startsWith(ROOT_DIR)) throw new Error("invalid"); await fs.rm(wsPath,{recursive:true,force:true}); delete state.workspaces[workspaceId]; delete state.indexes[workspaceId]; res.json({ ok:true }); }
  catch(e){ res.status(400).json({ error:String(e.message||e) }); }
});

const PORT = process.env.PORT || 4000;
server.listen(PORT, ()=>{});

module.exports = app;
