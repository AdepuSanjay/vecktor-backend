
import express from "express";
import multer from "multer";
import AdmZip from "adm-zip";
import cors from "cors";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { dirname } from "path";
import fetch from "node-fetch";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3000;

// Allowed origins
const ALLOWED_ORIGINS = [
  "http://localhost:5173",
  "https://vektor-insight.vercel.app",
  "https://studymate-swart.vercel.app",
];
app.use(
  cors({
    origin: (origin, cb) => {
      if (!origin) return cb(null, true);
      if (ALLOWED_ORIGINS.includes(origin)) return cb(null, true);
      return cb(new Error("Not allowed by CORS"));
    },
    credentials: true,
  })
);

// Gemini API key
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || "AIzaSyCk3VyHVj3_UMqtHlN5NhbS5pv9yMHDSTs";

// Middleware
app.use(express.json());
app.use(express.static("public"));

// ------------------- PATHS -------------------
const BASE_TMP = "/tmp";
const UPLOADS_PATH = path.join(BASE_TMP, "uploads");
const EXTRACTED_PATH = path.join(BASE_TMP, "extracted");
const REPOS_PATH = path.join(BASE_TMP, "repos");
[UPLOADS_PATH, EXTRACTED_PATH, REPOS_PATH].forEach((p) =>
  fs.mkdirSync(p, { recursive: true })
);

// ------------------- MULTER -------------------
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, UPLOADS_PATH);
  },
  filename: (req, file, cb) => {
    cb(null, Date.now() + "-" + file.originalname);
  },
});
const upload = multer({ storage });

// ------------------- HELPERS -------------------
function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const LANGUAGE_EXTENSIONS = {
  python: [".py"],
  javascript: [".js", ".jsx"],
  typescript: [".ts", ".tsx"],
  java: [".java"],
  c: [".c"],
  cpp: [".cpp", ".cc", ".cxx", ".c++"],
  php: [".php"],
};

const DEPENDENCY_FILES = [
  "package.json",
  "requirements.txt",
  "Pipfile",
  "pyproject.toml",
  "pom.xml",
  "build.gradle",
  "Cargo.toml",
  "composer.json",
  "Gemfile",
  "go.mod",
  "go.sum",
];

// Files to ignore completely
const IGNORE_EXTENSIONS = [".css", ".scss", ".sass", ".less", ".styl"];

function detectLanguage(filename) {
  const ext = path.extname(filename).toLowerCase();
  for (const [lang, extensions] of Object.entries(LANGUAGE_EXTENSIONS)) {
    if (extensions.includes(ext)) return lang;
  }
  return "unknown";
}

function isCodeFile(filename) {
  const ext = path.extname(filename).toLowerCase();

  // Skip CSS and related files
  if (IGNORE_EXTENSIONS.includes(ext)) {
    return false;
  }

  return Object.values(LANGUAGE_EXTENSIONS).flat().includes(ext);
}

function isDependencyFile(filename) {
  return DEPENDENCY_FILES.includes(path.basename(filename));
}

function shouldIgnoreFile(filename) {
  const ext = path.extname(filename).toLowerCase();
  return IGNORE_EXTENSIONS.includes(ext);
}

function readCodeFiles(dirPath) {
  const files = [];
  const ignoreDirs = [".git", "node_modules", "vendor", "dist", "build", "pycache", "__pycache__"];
  const ignoreFiles = [".DS_Store", "Thumbs.db"];

  function readRecursive(currentPath) {
    const items = fs.readdirSync(currentPath);
    for (const item of items) {
      if (ignoreDirs.includes(item)) continue;

      const fullPath = path.join(currentPath, item);
      const stat = fs.statSync(fullPath);

      if (stat.isDirectory()) {
        readRecursive(fullPath);
      } else if (stat.isFile() && !ignoreFiles.includes(item)) {
        // Skip CSS and related files
        if (shouldIgnoreFile(fullPath)) {
          continue;
        }

        if (isCodeFile(fullPath) || isDependencyFile(fullPath)) {
          try {
            const content = fs.readFileSync(fullPath, "utf8");
            files.push({
              path: fullPath,
              content,
              language: isDependencyFile(fullPath)
                ? "dependency"
                : detectLanguage(fullPath),
            });
          } catch {
            console.log(`Skipping file: ${fullPath}`);
          }
        }
      }
    }
  }

  readRecursive(dirPath);
  return files;
}

// ------------------- SSE -------------------
let clients = [];
app.get("/progress", (req, res) => {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders();
  clients.push(res);
  req.on("close", () => {
    clients = clients.filter((c) => c !== res);
  });
});

function broadcast(event, data) {
  clients.forEach((res) => {
    res.write(`event: ${event}\n`);
    res.write(`data: ${JSON.stringify(data)}\n\n`);
  });
}

// ------------------- GEMINI CALL -------------------
async function callGeminiAPI(codeContent, language, retries = 3) {
  const prompt = `
You are an expert code analyzer for ${language}.
Check for: syntax errors, dependency issues, duplicate code, security risks, performance problems, and best practice violations.
Return ONLY valid JSON like this:

{
  "issues": [
    { "line": 10, "type": "syntax_error", "message": "Issue description", "suggestion": "Suggested fix" }
  ]
}

Types: syntax_error, dependency, duplicate, security, performance, best_practice
Code:\n${codeContent}
`;

  for (let i = 0; i < retries; i++) {
    try {
      const response = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${GEMINI_API_KEY}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] }),
        }
      );

      if (response.status === 429) {
        await delay(2000 * (i + 1));
        continue;
      }

      if (!response.ok) throw new Error(`Gemini API error: ${response.statusText}`);

      const data = await response.json();
      let text = data.candidates[0].content.parts[0].text.trim();

      // Clean up JSON response
      if (text.startsWith("```json")) {
        text = text.slice(7);
      }
      if (text.endsWith("```")) {
        text = text.slice(0, -3);
      }
      text = text.replace(/```/g, "").trim();

      return JSON.parse(text);
    } catch (err) {
      console.error(`Gemini API attempt ${i + 1} failed:`, err.message);
      if (i === retries - 1) {
        return {
          issues: [{ line: 0, type: "error", message: err.message, suggestion: "Check API call" }],
        };
      }
    }
  }
}

// ------------------- ANALYSIS -------------------
async function analyzeFiles(files) {
  const results = [];
  const total = files.length;

  if (total === 0) {
    return results;
  }

  broadcast("progress", { message: `📑 Starting analysis of ${total} files`, progress: 0 });

  for (let i = 0; i < total; i++) {
    const file = files[i];
    const progress = (((i + 1) / total) * 100).toFixed(1);

    broadcast("progress", { 
      message: `🔍 [${i + 1}/${total}] (${progress}%) Analyzing ${path.basename(file.path)}`, 
      progress 
    });

    let issues = [];

    try {
      const aiResult = await callGeminiAPI(file.content, file.language);
      if (aiResult && aiResult.issues) {
        broadcast("progress", {
          message: `✅ Analyzed ${path.basename(file.path)}, found ${aiResult.issues.length} issues`,
          progress,
        });
        issues = aiResult.issues;
      }
    } catch (error) {
      console.error(`Error analyzing ${file.path}:`, error);
      issues = [{ line: 0, type: "error", message: "Analysis failed", suggestion: "Try again" }];
    }

    results.push({ 
      file: file.path, 
      language: file.language, 
      issues 
    });

    await delay(1000);
  }

  broadcast("end", { message: "🚀 Analysis complete." });
  return results;
}

// ------------------- ROUTES -------------------

// Direct code analysis
app.post("/api/analyze/code", async (req, res) => {
  try {
    const { code, filename = "code.txt" } = req.body;
    if (!code) return res.status(400).json({ error: "No code provided" });

    const language = detectLanguage(filename);
    const aiResponse = await callGeminiAPI(code, language !== "unknown" ? language : "javascript");
    res.json(aiResponse);
  } catch (error) {
    console.error("Code analysis error:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

// Upload only
app.post("/api/upload", upload.array("files"), async (req, res) => {
  try {
    if (!req.files || req.files.length === 0) {
      return res.status(400).json({ error: "No files uploaded" });
    }

    const uploadId = Date.now().toString();
    const extractPath = path.join(EXTRACTED_PATH, uploadId);
    fs.mkdirSync(extractPath, { recursive: true });

    for (const file of req.files) {
      const dest = path.join(extractPath, file.originalname);
      fs.renameSync(file.path, dest);
    }

    res.json({ success: true, uploadId });
  } catch (error) {
    console.error("Upload error:", error);
    res.status(500).json({ error: "Upload failed" });
  }
});

// Analyze uploaded folder
app.post("/api/analyze/:uploadId", async (req, res) => {
  try {
    const { uploadId } = req.params;
    const extractPath = path.join(EXTRACTED_PATH, uploadId);

    if (!fs.existsSync(extractPath)) {
      return res.status(400).json({ error: "Upload not found" });
    }

    const files = readCodeFiles(extractPath);
    if (files.length === 0) return res.status(400).json({ error: "No relevant files found" });

    const aiResponse = await analyzeFiles(files);
    res.json(aiResponse);
  } catch (error) {
    console.error("Analysis error:", error);
    res.status(500).json({ error: "Analysis failed" });
  }
});

// Upload & analyze directly
app.post("/api/analyze/upload", upload.array("files"), async (req, res) => {
  try {
    if (!req.files || req.files.length === 0) {
      return res.status(400).json({ error: "No files uploaded" });
    }

    const extractPath = path.join(EXTRACTED_PATH, Date.now().toString());
    fs.mkdirSync(extractPath, { recursive: true });

    for (const file of req.files) {
      const dest = path.join(extractPath, file.originalname);
      fs.renameSync(file.path, dest);
    }

    const files = readCodeFiles(extractPath);
    if (files.length === 0) return res.status(400).json({ error: "No relevant files found" });

    const aiResponse = await analyzeFiles(files);
    res.json(aiResponse);
  } catch (error) {
    console.error("Upload analysis error:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

// Download & extract GitHub repo ZIP
async function downloadRepoZip(repoUrl, extractPath, token = null) {
  try {
    const match = repoUrl.match(/github.com\/([^\/]+)\/([^\/]+)(?:\.git)?/);
    if (!match) throw new Error("Invalid GitHub URL");

    const owner = match[1];
    const repo = match[2];

    const zipUrl = `https://api.github.com/repos/${owner}/${repo}/zipball/main`;    

    const headers = {    
      "User-Agent": "Vektor-Insight",    
      Accept: "application/vnd.github.v3+json",    
    };    
    if (token) headers["Authorization"] = `token ${token}`;    

    const response = await fetch(zipUrl, { headers });    
    if (!response.ok) {    
      throw new Error(`GitHub API error: ${response.status} ${response.statusText}`);    
    }    

    const buffer = Buffer.from(await response.arrayBuffer());    
    const zipPath = path.join(extractPath, "repo.zip");    
    fs.writeFileSync(zipPath, buffer);    

    const zip = new AdmZip(zipPath);    
    zip.extractAllTo(extractPath, true);    

    return true;
  } catch (err) {
    console.error("Error downloading repo ZIP:", err.message);
    return false;
  }
}

// GitHub repo analysis
app.post("/analyze/github", async (req, res) => {
  try {
    const { repoUrl, token } = req.body;
    if (!repoUrl) return res.status(400).json({ error: "Repository URL is required" });

    const repoPath = path.join(REPOS_PATH, Date.now().toString());    
    fs.mkdirSync(repoPath, { recursive: true });    

    if (!(await downloadRepoZip(repoUrl, repoPath, token))) {    
      return res.status(500).json({ error: "Failed to download repo" });    
    }    

    // GitHub ZIPs extract into a single subfolder    
    const subDirs = fs.readdirSync(repoPath).filter(item => 
      !item.endsWith('.zip') && fs.statSync(path.join(repoPath, item)).isDirectory()
    );

    if (subDirs.length === 0) {
      return res.status(500).json({ error: "No extracted content found" });
    }

    const extractedRoot = path.join(repoPath, subDirs[0]);    
    const files = readCodeFiles(extractedRoot);    
    if (files.length === 0) return res.status(400).json({ error: "No relevant files found" });    

    const aiResponse = await analyzeFiles(files);    
    res.json(aiResponse);
  } catch (error) {
    console.error("GitHub analysis error:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

// Health check
app.get("/health", (req, res) =>
  res.json({ status: "OK", message: "Server running" })
);

// Start server
app.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));

